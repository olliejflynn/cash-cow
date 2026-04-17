import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, sheets_v4 } from "googleapis";
import type { SalesLogRow } from "../webhook/sales-log.types";
import type { SquarePaymentRow } from "../webhook/square-payment.types";

const SALES_LOG_COLUMNS: (keyof SalesLogRow)[] = [
  "logged_at",
  "order_created_at",
  "order_id",
  "order_status",
  "webhook_event_id",
  "line_item_id",
  "ticket_type",
  "qty",
  "unit_price_paid",
  "gross_amount",
  "seller_code",
  "Category (Company)",
  "hand_in_amount",
  "notes",
];
/** Matches sheet headers: Payment ID, Payment Time, Team Member, Seller ID, Amount (cents), Status */
const SQUARE_PAYMENT_COLUMNS: (keyof SquarePaymentRow)[] = [
  "payment_id",
  "payment_time",
  "team_member",
  "seller_id",
  "amount_cents",
  "status",
];

@Injectable()
export class SheetsService {
  private sheets: sheets_v4.Sheets | null = null;
  private spreadsheetId: string = "";
  private salesLogSheetName: string = "Sales_Log";
  private squarePaymentsSheetName: string = "Square_payments";
  private sellersSheetName: string = "Sellers";

  constructor(private readonly config: ConfigService) {
    this.spreadsheetId = this.config.get<string>("spreadsheetId") ?? "";
    this.salesLogSheetName =
      this.config.get<string>("salesLogSheetName") ?? "Sales_Log";
    this.squarePaymentsSheetName =
      this.config.get<string>("squarePaymentsSheetName") ?? "Square_payments";
    this.sellersSheetName = "Sellers";
  }

  private async getSheetsClient(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    const jsonPath = this.config.get<string>("googleServiceAccountPath")?.trim();
    const jsonStr = this.config.get<string>("googleServiceAccountJson")?.trim();

    let credentials: object;
    // Prefer file path: multiline JSON in .env often breaks dotenv; PATH is reliable locally.
    if (jsonPath) {
      const fs = await import("fs/promises");
      const raw = await fs.readFile(jsonPath, "utf-8");
      credentials = JSON.parse(raw) as object;
    } else if (jsonStr) {
      credentials = JSON.parse(jsonStr) as object;
    } else {
      throw new Error(
        "Set GOOGLE_SERVICE_ACCOUNT_PATH or GOOGLE_SERVICE_ACCOUNT_JSON"
      );
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
    return this.sheets;
  }

  /**
   * Append Sales_Log rows to the configured spreadsheet.
   * Each row is written in the order of Sales_Log columns.
   */
  async appendSalesLogRows(rows: SalesLogRow[]): Promise<void> {
    if (rows.length === 0) return;

    const client = await this.getSheetsClient();
    const values = rows.map((row) =>
      SALES_LOG_COLUMNS.map((key) => row[key] ?? "")
    );

    await client.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.salesLogSheetName}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }

  /**
   * Update Sales_Log order status for all rows matching a WooCommerce order id.
   * Returns counts so callers can decide whether an order already exists in the sheet.
   */
  async updateSalesLogOrderStatusByOrderId(
    orderId: string,
    orderStatus: string
  ): Promise<{ matchedRows: number; updatedRows: number }> {
    const normalizedOrderId = orderId.trim();
    if (normalizedOrderId === "") {
      return { matchedRows: 0, updatedRows: 0 };
    }

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.salesLogSheetName}!A:Z`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) {
      return { matchedRows: 0, updatedRows: 0 };
    }

    const orderIdColumn = SALES_LOG_COLUMNS.indexOf("order_id");
    const orderStatusColumn = SALES_LOG_COLUMNS.indexOf("order_status");
    if (orderIdColumn < 0 || orderStatusColumn < 0) {
      return { matchedRows: 0, updatedRows: 0 };
    }

    let matchedRows = 0;
    const updates: sheets_v4.Schema$ValueRange[] = [];

    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const rowOrderId = String(row[orderIdColumn] ?? "").trim();
      if (rowOrderId !== normalizedOrderId) continue;

      matchedRows += 1;
      const currentStatus = String(row[orderStatusColumn] ?? "").trim();
      if (currentStatus === orderStatus) continue;

      const rowNumber = i + 1;
      const col = toA1Column(orderStatusColumn + 1);
      updates.push({
        range: `${this.salesLogSheetName}!${col}${rowNumber}`,
        values: [[orderStatus]],
      });
    }

    if (updates.length > 0) {
      await client.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates,
        },
      });
    }

    return { matchedRows, updatedRows: updates.length };
  }

  /**
   * Append Square payment rows to the configured spreadsheet tab.
   * Column order: Payment ID, Payment Time, Team Member, Seller ID, Amount (cents), Status.
   */
  async appendSquarePaymentRows(rows: SquarePaymentRow[]): Promise<void> {
    if (rows.length === 0) return;

    const client = await this.getSheetsClient();
    const values = rows.map((row) =>
      SQUARE_PAYMENT_COLUMNS.map((key) => row[key] ?? "")
    );

    await client.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }

  async squarePaymentIdExists(paymentId: string): Promise<boolean> {
    const normalized = paymentId.trim();
    if (normalized === "") return false;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!A:A`,
    });

    const values = response.data.values ?? [];
    return values.some((row) => {
      const cell = Array.isArray(row) ? row[0] : undefined;
      return typeof cell === "string" && cell.trim() === normalized;
    });
  }

  /**
   * Sellers tab: match `Square_team_ID` to Square payment `team_member_id`,
   * return the business `seller_id` column value for the payment row (not Square catalog IDs).
   */
  async getSellerIdBySquareTeamMemberId(
    teamMemberId: string
  ): Promise<string | null> {
    const normalizedTeam = teamMemberId.trim();
    if (normalizedTeam === "") return null;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sellersSheetName}!A:Z`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) return null;

    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const normHeader = (h: string) => h.toLowerCase().replace(/\s+/g, "_");
    const teamIdx = header.findIndex((h) => normHeader(h) === "square_team_id");
    const sellerIdx = header.findIndex((h) => normHeader(h) === "seller_id");
    if (teamIdx < 0 || sellerIdx < 0) {
      throw new Error(
        `Sellers tab must include 'Square_team_ID' and 'seller_id' headers`
      );
    }

    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const teamCell = String(row[teamIdx] ?? "").trim();
      if (teamCell !== normalizedTeam) continue;
      const sellerId = String(row[sellerIdx] ?? "").trim();
      return sellerId === "" ? null : sellerId;
    }
    return null;
  }

  /**
   * For Sellers tab, set Square_team_ID using matching email values.
   * Rows with blank email are ignored.
   */
  async setSellerSquareTeamIdsByEmail(
    teamIdByEmail: Map<string, string>
  ): Promise<number> {
    if (teamIdByEmail.size === 0) return 0;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sellersSheetName}!A:Z`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) return 0;

    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const emailIdx = header.findIndex((v) => v.toLowerCase() === "email");
    const teamIdIdx = header.findIndex(
      (v) => v.toLowerCase() === "square_team_id"
    );
    if (emailIdx < 0 || teamIdIdx < 0) {
      throw new Error(
        `Sellers tab is missing required headers 'email' or 'Square_team_ID'`
      );
    }

    const updates: sheets_v4.Schema$ValueRange[] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const email = String(row[emailIdx] ?? "").trim().toLowerCase();
      if (email === "") continue;

      const teamId = teamIdByEmail.get(email);
      if (!teamId) continue;

      const current = String(row[teamIdIdx] ?? "").trim();
      if (current === teamId) continue;

      const rowNumber = i + 1;
      const col = toA1Column(teamIdIdx + 1);
      updates.push({
        range: `${this.sellersSheetName}!${col}${rowNumber}`,
        values: [[teamId]],
      });
    }

    if (updates.length === 0) return 0;

    await client.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });

    return updates.length;
  }
}

function toA1Column(index1Based: number): string {
  let index = index1Based;
  let label = "";
  while (index > 0) {
    const r = (index - 1) % 26;
    label = String.fromCharCode(65 + r) + label;
    index = Math.floor((index - 1) / 26);
  }
  return label;
}
