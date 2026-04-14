#!/usr/bin/env node
/**
 * Sends request_body_example.json to the webhook endpoint for local testing.
 * Uses the exact file contents so the API receives the same structure as WooCommerce.
 *
 * When run via npm run test:webhook, the root .env is loaded (same as the API),
 * so WEBHOOK_SECRET from .env is used to sign the request.
 *
 * Usage:
 *   npm run test:webhook
 *   npm run test:webhook -- [webhook-url]
 *   WEBHOOK_URL=https://... npm run test:webhook
 */

import { readFileSync } from "fs";
import { createHmac } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const defaultUrl = "http://localhost:3000/webhooks/woocommerce/order";
const defaultBodyPath = join(rootDir, "request_body_example.json");

const webhookUrl = process.argv[2] || process.env.WEBHOOK_URL || defaultUrl;
const bodyPath = process.env.WEBHOOK_BODY_PATH || defaultBodyPath;

let rawBody;
try {
  rawBody = readFileSync(bodyPath, "utf8");
} catch (err) {
  console.error(`Failed to read ${bodyPath}:`, err.message);
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
};

const secret = process.env.WEBHOOK_SECRET;
if (secret) {
  const signature = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  headers["X-WC-Webhook-Signature"] = signature;
  console.log("Sending with X-WC-Webhook-Signature (WEBHOOK_SECRET set)");
} else {
  console.log(
    "Sending without signature (set WEBHOOK_SECRET to test signed requests)"
  );
}

console.log(`POST ${webhookUrl}`);
console.log(`Body: ${bodyPath} (${rawBody.length} bytes)`);

const res = await fetch(webhookUrl, {
  method: "POST",
  headers,
  body: rawBody,
});

console.log(`Response: ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(text);
process.exit(res.ok ? 0 : 1);
