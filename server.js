const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 10000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

async function bootstrap() {
  const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(schema);
}
bootstrap().catch(err => {
  console.error("Database bootstrap failed:", err);
  process.exit(1);
});

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in." });
  next();
}

function normalizePhone(phone) {
  const p = String(phone || "").replace(/\s+/g, "");
  if (/^07\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^2547\d{8}$/.test(p)) return p;
  return null;
}

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

async function flutterwaveCheckout({ amount, email, name, txRef, redirectUrl, meta }) {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw Object.assign(new Error("Flutterwave is not configured yet."), { code: "FLW_NOT_CONFIGURED" });

  const response = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: Number(amount),
      currency: "KES",
      redirect_url: redirectUrl,
      payment_options: "card,mpesa",
      customer: { email, name },
      meta,
      customizations: {
        title: "Jaro Academic Marketplace",
        description: "Secure marketplace payment"
      }
    })
  });
  const data = await response.json();
  if (!response.ok || data.status !== "success" || !data.data?.link) {
    console.error("Flutterwave checkout error:", data);
    throw new Error(data.message || "Unable to create payment checkout.");
  }
  return data.data;
}

async function verifyFlutterwaveTransaction(transactionId, expectedRef, expectedAmount) {
  const key = process.env.FLW_SECRET_KEY;
  if (!key || !transactionId) return false;
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const data = await response.json();
  if (!response.ok || data.status !== "success") return false;
  const d = data.data;
  return d?.status === "successful" &&
    String(d.tx_ref) === String(expectedRef) &&
    Number(d.amount) >= Number(expectedAmount) &&
    String(d.currency) === "KES";
}

/* ---------- health ---------- */
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "jaro-academic-marketplace" });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* ---------- auth ---------- */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role = "both" } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (!["client","provider","both"].includes(role)) return res.status(400).json({ error: "Invalid role." });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,LOWER($2),$3,$4)
       RETURNING id,name,email,role,verified,verification_fee_paid,created_at`,
      [name.trim(), email.trim(), hash, role]
    );
    req.session.user = rows[0];
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
    console.error(err);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query("SELECT * FROM users WHERE email=LOWER($1)", [email || ""]);
  if (!rows[0] || !(await bcrypt.compare(password || "", rows[0].password_hash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const { password_hash, ...safe } = rows[0];
  req.session.user = safe;
  res.json({ user: safe });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

/* ---------- tasks ---------- */
app.get("/api/tasks", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*, u.name AS client_name,
           COUNT(b.id)::int AS bid_count
    FROM tasks t
    JOIN users u ON u.id=t.client_user_id
    LEFT JOIN bids b ON b.task_id=t.id
    WHERE t.status='open'
    GROUP BY t.id,u.name
    ORDER BY t.created_at DESC
    LIMIT 100
  `);
  res.json({ tasks: rows });
});

app.get("/api/tasks/:id", async (req, res) => {
  const { rows: tasks } = await pool.query(`
    SELECT t.*, u.name AS client_name
    FROM tasks t JOIN users u ON u.id=t.client_user_id
    WHERE t.id=$1
  `, [req.params.id]);
  if (!tasks[0]) return res.status(404).json({ error: "Task not found." });

  const { rows: bids } = await pool.query(`
    SELECT b.id,b.task_id,b.provider_user_id,b.amount,b.delivery_days,b.proposal,b.status,b.created_at,
           u.name AS provider_name,u.verified
    FROM bids b JOIN users u ON u.id=b.provider_user_id
    WHERE b.task_id=$1 ORDER BY b.created_at DESC
  `, [req.params.id]);

  res.json({
    task: tasks[0],
    bids,
    isOwner: !!req.session.user && String(tasks[0].client_user_id) === String(req.session.user.id),
    signedIn: !!req.session.user
  });
});

app.post("/api/tasks", auth, async (req, res) => {
  const { title, category, description, budget_min, budget_max, deadline } = req.body;
  if (!title || !category || !description) return res.status(400).json({ error: "Title, category and description are required." });
  const { rows } = await pool.query(`
    INSERT INTO tasks(client_user_id,title,category,description,budget_min,budget_max,deadline)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.session.user.id, title.trim(), category, description.trim(), budget_min || null, budget_max || null, deadline || null]);
  res.status(201).json({ task: rows[0] });
});

app.get("/api/my/tasks", auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*, COUNT(b.id)::int AS bid_count
    FROM tasks t LEFT JOIN bids b ON b.task_id=t.id
    WHERE t.client_user_id=$1 GROUP BY t.id ORDER BY t.created_at DESC
  `, [req.session.user.id]);
  res.json({ tasks: rows });
});

/* ---------- bids ---------- */
app.post("/api/bids", auth, async (req, res) => {
  const { task_id, amount, delivery_days, proposal } = req.body;
  const { rows: task } = await pool.query("SELECT * FROM tasks WHERE id=$1", [task_id]);
  if (!task[0] || task[0].status !== "open") return res.status(404).json({ error: "Task is not open." });
  if (String(task[0].client_user_id) === String(req.session.user.id)) return res.status(400).json({ error: "You cannot bid on your own task." });

  const { rows: existing } = await pool.query("SELECT id FROM bids WHERE task_id=$1 AND provider_user_id=$2", [task_id, req.session.user.id]);
  if (existing[0]) return res.status(409).json({ error: "You have already submitted a proposal." });

  const { rows } = await pool.query(`
    INSERT INTO bids(task_id,provider_user_id,amount,delivery_days,proposal)
    VALUES($1,$2,$3,$4,$5) RETURNING *
  `, [task_id, req.session.user.id, amount, delivery_days, proposal]);
  res.status(201).json({ bid: rows[0] });
});

/* ---------- orders ---------- */
app.post("/api/orders", auth, async (req, res) => {
  const { task_id, provider_user_id, amount } = req.body;
  const { rows: task } = await pool.query("SELECT * FROM tasks WHERE id=$1 AND client_user_id=$2 AND status='open'", [task_id, req.session.user.id]);
  if (!task[0]) return res.status(403).json({ error: "Task unavailable or not owned by you." });

  const { rows: bid } = await pool.query(`
    SELECT * FROM bids WHERE task_id=$1 AND provider_user_id=$2 AND status='pending'
  `, [task_id, provider_user_id]);
  if (!bid[0]) return res.status(400).json({ error: "A pending proposal from this provider is required." });

  const agreed = Number(amount);
  if (!Number.isFinite(agreed) || agreed <= 0) return res.status(400).json({ error: "Invalid amount." });
  const fee = Math.round(agreed * 0.15 * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      INSERT INTO orders(task_id,client_user_id,provider_user_id,agreed_amount,platform_fee)
      VALUES($1,$2,$3,$4,$5) RETURNING *
    `, [task_id, req.session.user.id, provider_user_id, agreed, fee]);
    await client.query("UPDATE bids SET status='accepted' WHERE id=$1", [bid[0].id]);
    await client.query("UPDATE bids SET status='rejected' WHERE task_id=$1 AND id<>$2", [task_id, bid[0].id]);
    await client.query("UPDATE tasks SET status='awarded' WHERE id=$1", [task_id]);
    await client.query("COMMIT");
    res.status(201).json({ order: rows[0], platform_fee: fee });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not create order." });
  } finally {
    client.release();
  }
});

app.post("/api/orders/:id/checkout", auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, u.email, u.name
    FROM orders o JOIN users u ON u.id=o.client_user_id
    WHERE o.id=$1 AND o.client_user_id=$2
  `, [req.params.id, req.session.user.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status !== "awaiting_payment") return res.status(409).json({ error: "This order is not awaiting payment." });

  const txRef = `JARO-${order.id}-${Date.now()}`;
  try {
    const checkout = await flutterwaveCheckout({
      amount: order.agreed_amount,
      email: order.email,
      name: order.name,
      txRef,
      redirectUrl: `${appUrl(req)}/payment-result.html?order_id=${encodeURIComponent(order.id)}`,
      meta: { order_id: order.id, platform: "jaro-academic" }
    });
    const { rows: payment } = await pool.query(`
      INSERT INTO payments(order_id,user_id,amount,external_reference,checkout_session_id,checkout_url,status)
      VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *
    `, [order.id, req.session.user.id, order.agreed_amount, txRef, String(checkout.id || ""), checkout.link]);
    res.status(201).json({ payment, checkout_url: checkout.link });
  } catch (err) {
    if (err.code === "FLW_NOT_CONFIGURED") return res.status(503).json({ error: "Card/M-Pesa checkout is not configured yet. Add FLW_SECRET_KEY in Render." });
    console.error(err);
    res.status(502).json({ error: err.message || "Could not create payment checkout." });
  }
});

app.get("/api/orders/:id/status", auth, async (req, res) => {
  const { rows: orders } = await pool.query(
    "SELECT id,status,agreed_amount,platform_fee FROM orders WHERE id=$1 AND client_user_id=$2",
    [req.params.id, req.session.user.id]
  );
  if (!orders[0]) return res.status(404).json({ error: "Order not found." });
  const { rows: payments } = await pool.query(`
    SELECT id,amount,currency,status,external_reference,paid_at,created_at
    FROM payments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1
  `, [req.params.id]);
  res.json({ order: orders[0], payment: payments[0] || null });
});

app.get("/api/my/orders", auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, t.title, u.name AS other_party
    FROM orders o
    JOIN tasks t ON t.id=o.task_id
    JOIN users u ON u.id = CASE WHEN o.client_user_id=$1 THEN o.provider_user_id ELSE o.client_user_id END
    WHERE o.client_user_id=$1 OR o.provider_user_id=$1
    ORDER BY o.created_at DESC
  `, [req.session.user.id]);
  res.json({ orders: rows });
});

/* ---------- earnings ---------- */
app.get("/api/earnings", auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN agreed_amount-platform_fee ELSE 0 END),0) AS completed_earnings,
      COALESCE(SUM(CASE WHEN status IN ('funded','in_progress','delivered') THEN agreed_amount-platform_fee ELSE 0 END),0) AS pending_earnings
    FROM orders WHERE provider_user_id=$1
  `, [req.session.user.id]);
  res.json({ ...rows[0], commission_rate: 15 });
});

/* ---------- Flutterwave webhook ---------- */
app.post("/api/payments/flutterwave-webhook", async (req, res) => {
  const configured = process.env.FLW_WEBHOOK_SECRET;
  const incoming = req.headers["verif-hash"];
  if (configured && incoming !== configured) return res.status(401).json({ error: "Invalid webhook signature." });

  const body = req.body || {};
  const ref = body.data?.tx_ref || body.tx_ref;
  const transactionId = body.data?.id || body.id;
  if (!ref) return res.json({ received: true });

  const { rows: payments } = await pool.query(
    "SELECT * FROM payments WHERE external_reference=$1 ORDER BY created_at DESC LIMIT 1",
    [ref]
  );
  const payment = payments[0];
  if (!payment) return res.json({ received: true });

  const status = String(body.data?.status || body.status || "").toLowerCase();
  if (status === "successful" || status === "completed") {
    const valid = await verifyFlutterwaveTransaction(transactionId, ref, payment.amount);
    if (!valid) return res.json({ received: true, verified: false });

    await pool.query(`
      UPDATE payments
      SET status='confirmed',gateway_status='successful',paid_at=NOW(),gateway_response=$2
      WHERE id=$1
    `, [payment.id, JSON.stringify(body)]);
    await pool.query(`
      UPDATE orders SET status='funded',funded_at=NOW()
      WHERE id=$1 AND status='awaiting_payment'
    `, [payment.order_id]);
  } else if (status === "failed" || status === "cancelled") {
    await pool.query(`
      UPDATE payments SET status='failed',gateway_status=$2,gateway_response=$3
      WHERE id=$1
    `, [payment.id, status, JSON.stringify(body)]);
  }

  res.json({ received: true });
});

/* ---------- static ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});


// Express 5-safe SPA fallback: serve the landing page for unmatched browser routes.
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Jaro Academic Marketplace listening on ${port}`);
});
