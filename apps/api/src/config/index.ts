function parsePort(): number {
  const raw = process.env.PORT;
  const n = parseInt(raw ?? "3000", 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    return 3000;
  }
  return n;
}

export const config = () => ({
  port: parsePort(),
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  googleServiceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? "",
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  spreadsheetId: process.env.SPREADSHEET_ID ?? "",
  salesLogSheetName: process.env.SALES_LOG_SHEET_NAME ?? "Sales_Log",
  squarePaymentsSheetName:
    process.env.SQUARE_PAYMENTS_SHEET_NAME ?? "Square_payments",
  defaultHandInPercent: parseFloat(
    process.env.DEFAULT_HAND_IN_PERCENT ?? "100"
  ),
  defaultSellerCode: process.env.DEFAULT_SELLER_CODE ?? "UNKNOWN",
});
