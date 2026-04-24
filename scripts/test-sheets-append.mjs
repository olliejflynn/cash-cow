#!/usr/bin/env node
/**
 * Appends one test row to Sales_Log using the same Sheets API call as the API.
 * Column order must stay aligned with apps/api/src/sheets/sheets.service.ts (SALES_LOG_COLUMNS).
 *
 * Usage (from repo root):
 *   npm run test:sheets
 *
 * Requires in .env: SPREADSHEET_ID, SALES_LOG_SHEET_NAME (optional), and either
 * GOOGLE_SERVICE_ACCOUNT_PATH or GOOGLE_SERVICE_ACCOUNT_JSON.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { google } from "googleapis";

/** @type {const} Keep in sync with SheetsService SALES_LOG_COLUMNS */
const SALES_LOG_COLUMNS = [
  "logged_at",
  "order_created_at",
  "order_id",
  "order_status",
  "webhook_event_id",
  "line_item_id",
  "ticket_type",
  "qty",
  "unit_price_paid",
  "unit_commission",
  "gross_amount",
  "gross_commission",
  "seller_code",
  "Category (Company)",
  "hand_in_amount",
  "cashed?",
];

function stripQuotes(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function loadCredentials() {
  const jsonPathRaw = process.env.GOOGLE_SERVICE_ACCOUNT_PATH?.trim();
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  // Prefer file path: multiline JSON in .env often breaks dotenv and produces invalid JSON here.
  if (jsonPathRaw) {
    const jsonPath = stripQuotes(jsonPathRaw);
    const absolute = resolve(process.cwd(), jsonPath);
    return JSON.parse(readFileSync(absolute, "utf8"));
  }
  if (jsonStr) {
    return JSON.parse(jsonStr);
  }
  throw new Error(
    "Set GOOGLE_SERVICE_ACCOUNT_PATH or GOOGLE_SERVICE_ACCOUNT_JSON in .env"
  );
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID?.trim();
  const sheetName = (process.env.SALES_LOG_SHEET_NAME || "Sales_Log").trim();
  if (!spreadsheetId) {
    throw new Error("Set SPREADSHEET_ID in .env");
  }

  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const now = new Date().toISOString();
  const testRow = {
    logged_at: now,
    order_created_at: now,
    order_id: "test-append",
    order_status: "test",
    webhook_event_id: "test:manual-append",
    line_item_id: "0",
    ticket_type: "Sheets connectivity test",
    qty: "1",
    unit_price_paid: "0",
    unit_commission: "0",
    gross_amount: "0",
    gross_commission: "0",
    seller_code: "TEST",
    "Category (Company)": "",
    hand_in_amount: "0",
    "cashed?": "FALSE",
  };

  const values = [SALES_LOG_COLUMNS.map((key) => testRow[key] ?? "")];

  console.log(
    `Appending 1 row to ${spreadsheetId} tab "${sheetName}" (USER_ENTERED, INSERT_ROWS)...`
  );

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  const u = res.data.updates;
  console.log("OK:", u?.updatedRange ?? "(no range in response)");
  if (u?.updatedRows != null) console.log("Updated rows:", u.updatedRows);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
