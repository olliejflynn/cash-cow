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

  constructor(private readonly config: ConfigService) {
    this.spreadsheetId = this.config.get<string>("spreadsheetId") ?? "";
    this.salesLogSheetName =
      this.config.get<string>("salesLogSheetName") ?? "Sales_Log";
    this.squarePaymentsSheetName =
      this.config.get<string>("squarePaymentsSheetName") ?? "Square_payments";
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
    console.log(
      JSON.stringify(
        {
          event: "square_sheet_append_attempt",
          received_at: new Date().toISOString(),
          spreadsheet_id: this.spreadsheetId,
          sheet_name: this.squarePaymentsSheetName,
          row_count: rows.length,
          first_row: rows[0],
        },
        null,
        2
      )
    );

    const response = await client.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!A:E`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    console.log(
      JSON.stringify(
        {
          event: "square_sheet_append_success",
          received_at: new Date().toISOString(),
          updated_range: response.data.updates?.updatedRange ?? "",
          updated_rows: response.data.updates?.updatedRows ?? 0,
          updated_cells: response.data.updates?.updatedCells ?? 0,
        },
        null,
        2
      )
    );
  }

  async squarePaymentIdExists(paymentId: string): Promise<boolean> {
    const normalizedPaymentId = paymentId.trim();
    if (normalizedPaymentId === "") return false;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.squarePaymentsSheetName}!A:A`,
    });

    const values = response.data.values ?? [];
    const exists = values.some((row) => {
      const cell = Array.isArray(row) ? row[0] : undefined;
      return typeof cell === "string" && cell.trim() === normalizedPaymentId;
    });
    console.log(
      JSON.stringify(
        {
          event: "square_sheet_duplicate_lookup",
          received_at: new Date().toISOString(),
          spreadsheet_id: this.spreadsheetId,
          sheet_name: this.squarePaymentsSheetName,
          payment_id: normalizedPaymentId,
          sheet_row_count_in_column_a: values.length,
          exists,
        },
        null,
        2
      )
    );
    return exists;
  }
}
