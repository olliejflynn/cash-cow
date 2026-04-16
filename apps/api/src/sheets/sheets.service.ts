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
const SQUARE_PAYMENT_COLUMNS: (keyof SquarePaymentRow)[] = [
  "payment_id",
  "payment_time",
  "team_member",
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
   * Append Square payment rows to the configured spreadsheet tab.
   * Column order: Payment ID, Payment Time, Team Member, Amount (cents), Status.
   */
  async appendSquarePaymentRows(rows: SquarePaymentRow[]): Promise<void> {
    if (rows.length === 0) return;

    const client = await this.getSheetsClient();
    const values = rows.map((row) =>
      SQUARE_PAYMENT_COLUMNS.map((key) => row[key] ?? "")
    );

    await client.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!A:E`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }

  async squarePaymentTeamMemberExists(teamMemberId: string): Promise<boolean> {
    const normalizedTeamMemberId = teamMemberId.trim();
    if (normalizedTeamMemberId === "") return false;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!C:C`,
    });

    const values = response.data.values ?? [];
    return values.some((row) => {
      const cell = Array.isArray(row) ? row[0] : undefined;
      return typeof cell === "string" && cell.trim() === normalizedTeamMemberId;
    });
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
