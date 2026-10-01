# Jaro Academic Marketplace

A GitHub + Render ready marketplace for legitimate academic and professional support.

## Features

- Client/provider accounts
- Task posting
- Provider proposals/bids
- Provider selection
- Orders and 15% platform commission calculation
- Flutterwave hosted checkout for card + M-Pesa in Kenya
- Webhook verification and payment status updates
- PostgreSQL database
- Responsive mobile-friendly UI

> The platform is designed for legitimate tutoring, research guidance, editing, referencing, data analysis, CVs and professional services. It should not be used to facilitate academic cheating or submission of work as another person's own.

## Local development

Requirements: Node.js 20+ and PostgreSQL.

```bash
npm install
cp .env.example .env
# edit .env
npm start
```

Open `http://localhost:10000`.

## GitHub

Create a new repository, then:

```bash
git init
git add .
git commit -m "Initial Jaro Academic Marketplace"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/jaro-academic-marketplace.git
git push -u origin main
```

## Render

Render can deploy directly from a linked GitHub repository. The included `render.yaml` creates a Node web service and PostgreSQL database.

1. Render → New → Blueprint.
2. Select the GitHub repository.
3. Review the services.
4. Deploy.
5. In the web service Environment settings, add:
   - `APP_URL` = your Render service URL
   - `FLW_SECRET_KEY` = your Flutterwave secret key
   - `FLW_WEBHOOK_SECRET` = your Flutterwave webhook secret
6. Keep `FLW_TEST_MODE=true` until sandbox testing is complete.

Render keeps secrets in environment variables rather than in Git. Do not commit `.env` or gateway secrets.

## Flutterwave webhook

Set your Flutterwave webhook URL to:

`https://YOUR-RENDER-SERVICE.onrender.com/api/payments/flutterwave-webhook`

The application verifies the webhook and then verifies the transaction with Flutterwave before marking an order as funded.

## Important

The included checkout supports the gateway's hosted payment page. Card numbers and CVV are not stored by this application.

Before accepting real money, complete the gateway's merchant/KYC requirements and test the complete payment → webhook → order-funded flow in test mode.


## Render deployment
The app uses an Express 5-compatible fallback route and is ready for Render deployment. Keep payment and database secrets in Render Environment Variables, not GitHub.
