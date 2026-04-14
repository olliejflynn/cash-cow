export const config = () => ({
  port: parseInt(process.env.PORT ?? "3000", 10),
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  googleServiceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? "",
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  spreadsheetId: process.env.SPREADSHEET_ID ?? "",
  salesLogSheetName: process.env.SALES_LOG_SHEET_NAME ?? "Sales_Log",
  defaultHandInPercent: parseFloat(
    process.env.DEFAULT_HAND_IN_PERCENT ?? "100"
  ),
  defaultSellerCode: process.env.DEFAULT_SELLER_CODE ?? "UNKNOWN",
});
