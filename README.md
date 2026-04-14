# Cash Cow

WooCommerce-to-Google-Sheets webhook API. When a sale is made on WooCommerce, the API logs each line item to a **Sales_Log** sheet with idempotency via PostgreSQL.

## Monorepo layout

- **packages/database** – Shared DB (Prisma), `webhook_events` table and `claimEvent` for idempotency.
- **apps/api** – NestJS app: webhook endpoint, Sheets append, config.

## Prerequisites

- Node 18+
- PostgreSQL
- Google Cloud service account with Sheets API, JSON key
- WooCommerce site (for webhook URL and secret)

## Setup

1. **Clone and install**

   ```bash
   npm install
   ```

2. **Environment**

   Copy `.env.example` to `.env` and set:

   - `DATABASE_URL` – PostgreSQL connection string.
   - `WEBHOOK_SECRET` – Shared secret for `X-Webhook-Secret` (optional; if unset, all requests pass).
   - `GOOGLE_SERVICE_ACCOUNT_PATH` or `GOOGLE_SERVICE_ACCOUNT_JSON` – Service account credentials.
   - `SPREADSHEET_ID` – ID of the target Google Sheet (from the URL).
   - `SALES_LOG_SHEET_NAME` – Sheet tab name (default `Sales_Log`).

3. **Database**

   For local testing, start PostgreSQL in Docker (creates a persistent volume):

   ```bash
   docker compose up -d
   ```

   Then in `.env` set:

   ```env
   DATABASE_URL=postgresql://cashcow:cashcow@localhost:5432/cash_cow
   ```

   Generate Prisma client and run migrations:

   ```bash
   npm run db:generate
   npm run db:migrate
   ```

   Ensure the PostgreSQL database exists and `DATABASE_URL` is correct. To stop the container: `docker compose down`. Data persists in the `cash_cow_data` volume.

4. **Google Sheet**

   - Create a spreadsheet (or use an existing one).
   - Share it with the **service account email** (from the JSON key) as Editor.
   - Add a sheet tab named `Sales_Log` (or set `SALES_LOG_SHEET_NAME`). The first row can be headers; the API appends data rows.

5. **WooCommerce webhook**

   - In WooCommerce: **Settings → Advanced → Webhooks**.
   - Add webhook: **Order updated** (or **Order created**) → Delivery URL: `https://your-api-host/webhooks/woocommerce/order`.
   - Set **Secret** to the same value as `WEBHOOK_SECRET`.
   - The API expects `X-Webhook-Secret` header with that secret (or `?secret=...`). If your WC version sends a different header, you can align it or leave `WEBHOOK_SECRET` empty for testing (not for production).

## Run

- **API (dev):**

  ```bash
  npm run api:start:dev
  ```

- **API (prod build):**

  ```bash
  npm run db:generate
  npm run api:build
  npm run api:start
  ```

The webhook endpoint is:

- `POST /webhooks/woocommerce/order`  
  Body: WooCommerce order JSON (same shape as WC REST API order). Each line item is appended as one row in the Sales_Log sheet. Duplicate events (same `order_id` + `order_key`) are skipped via PostgreSQL idempotency.

## Local testing (without WooCommerce)

To hit the API with the same body structure as a real order, use the example payload in the repo:

```bash
npm run test:webhook
```

This sends `request_body_example.json` to `http://localhost:3000/webhooks/woocommerce/order`. Start the API first (`npm run api:start:dev`). Optional:

- **Custom URL:** `WEBHOOK_URL=https://your-tunnel/webhooks/woocommerce/order npm run test:webhook` or `npm run test:webhook -- https://...`
- **Custom body file:** `WEBHOOK_BODY_PATH=./my-order.json npm run test:webhook`
- **Signed request:** set `WEBHOOK_SECRET` in the environment (same value as in `.env`) to send `X-WC-Webhook-Signature` so you can test signature verification.

## MVP behaviour

- One endpoint; no Ticket_Rules, Seller_Overrides, Seller_Map, or WC_Catalogue in the DB.
- Idempotency: `webhook_events` table stores `event_id` (e.g. `order_id:order_key`); duplicate events return 200 without writing to the sheet.
- Seller code: taken from the first coupon code, or `DEFAULT_SELLER_CODE`.
- Hand-in amount: `net_amount * (DEFAULT_HAND_IN_PERCENT / 100)`.

The repo is structured as a monorepo with a shared database package so you can add worker services later.
