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
  squareApplicationId: process.env.SQUARE_APPLICATION_ID ?? "",
  squareApplicationSecret: process.env.SQUARE_APPLICATION_SECRET ?? "",
  squareRedirectUri: process.env.SQUARE_REDIRECT_URI ?? "",
  squareEnvironment: (process.env.SQUARE_ENVIRONMENT ?? "sandbox").toLowerCase(),
  squareOAuthScopes: process.env.SQUARE_OAUTH_SCOPES ?? "",
  squareTokenEncryptionKey: process.env.SQUARE_TOKEN_ENCRYPTION_KEY ?? "",
  squareOAuthSetupSecret: process.env.SQUARE_OAUTH_SETUP_SECRET ?? "",
  woocommerceSiteUrl: (process.env.WOOCOMMERCE_SITE_URL ?? "").trim(),
  woocommerceConsumerKey: (process.env.WOOCOMMERCE_CONSUMER_KEY ?? "").trim(),
  woocommerceConsumerSecret: (process.env.WOOCOMMERCE_CONSUMER_SECRET ?? "").trim(),
  usersSheetName: (process.env.USERS_SHEET_NAME ?? "users").trim(),
  usersSheetSyncSecret: (process.env.USERS_SHEET_SYNC_SECRET ?? "").trim(),
});
