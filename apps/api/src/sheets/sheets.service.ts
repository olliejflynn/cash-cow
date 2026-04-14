import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, sheets_v4 } from "googleapis";
import type { SalesLogRow } from "../webhook/sales-log.types";

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

@Injectable()
export class SheetsService {
  private sheets: sheets_v4.Sheets | null = null;
  private spreadsheetId: string = "";
  private sheetName: string = "Sales_Log";

  constructor(private readonly config: ConfigService) {
    this.spreadsheetId = this.config.get<string>("spreadsheetId") ?? "";
    this.sheetName =
      this.config.get<string>("salesLogSheetName") ?? "Sales_Log";
  }

  private async getSheetsClient(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    const jsonPath = this.config.get<string>("googleServiceAccountPath");
    const jsonStr = this.config.get<string>("googleServiceAccountJson");

    let credentials: object;
    if (jsonStr) {
      credentials = JSON.parse(jsonStr) as object;
    } else if (jsonPath) {
      const fs = await import("fs/promises");
      const raw = await fs.readFile(jsonPath, "utf-8");
      credentials = JSON.parse(raw) as object;
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
      range: `${this.sheetName}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }
}
