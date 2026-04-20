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
  "unit_commission",
  "gross_amount",
  "gross_commission",
  "seller_code",
  "Category (Company)",
  "hand_in_amount",
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
  private ticketRulesSheetName: string = "Ticket_rules";
  private squarePaymentsSheetName: string = "Square_payments";
  /** Prevent same payment_id from being inserted concurrently in this process. */
  private readonly pendingSquarePaymentIds = new Set<string>();
  private sellersSheetName: string = "Sellers";
  private usersSheetName: string = "users";

  constructor(private readonly config: ConfigService) {
    this.spreadsheetId = this.config.get<string>("spreadsheetId") ?? "";
    this.salesLogSheetName =
      this.config.get<string>("salesLogSheetName") ?? "Sales_Log";
    this.ticketRulesSheetName =
      this.config.get<string>("ticketRulesSheetName") ?? "Ticket_rules";
    this.squarePaymentsSheetName =
      this.config.get<string>("squarePaymentsSheetName") ?? "Square_payments";
    this.sellersSheetName = "Sellers";
    this.usersSheetName = this.config.get<string>("usersSheetName") ?? "users";
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
   * Load Ticket_type_Slug → Commission from the Ticket_rules tab (header row skipped).
   * First data row wins for duplicate slugs.
   */
  async getTicketCommissionBySlug(): Promise<ReadonlyMap<string, number>> {
    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.ticketRulesSheetName}!A:B`,
    });
    const rows = response.data.values ?? [];
    const map = new Map<string, number>();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      const slug = String(row[0] ?? "").trim();
      if (slug === "") continue;
      if (map.has(slug)) continue;
      const raw = row[1];
      const n = parseFloat(String(raw ?? "").replace(/,/g, ""));
      const commission = Number.isFinite(n) ? n : 0;
      map.set(slug, commission);
    }
    return map;
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

    // payment_id is the logical primary key; skip blank IDs and duplicates in input.
    const seenInInput = new Set<string>();
    const normalizedRows: SquarePaymentRow[] = [];
    for (const row of rows) {
      const paymentId = String(row.payment_id ?? "").trim();
      if (paymentId === "") continue;
      if (seenInInput.has(paymentId)) continue;
      seenInInput.add(paymentId);
      normalizedRows.push({
        ...row,
        payment_id: paymentId,
      });
    }
    if (normalizedRows.length === 0) return;

    // Simple process-local lock to avoid duplicate appends from concurrent webhooks.
    const lockedIds: string[] = [];
    const unlockedRows = normalizedRows.filter((row) => {
      const paymentId = row.payment_id;
      if (this.pendingSquarePaymentIds.has(paymentId)) return false;
      this.pendingSquarePaymentIds.add(paymentId);
      lockedIds.push(paymentId);
      return true;
    });
    if (unlockedRows.length === 0) return;

    try {
      const client = await this.getSheetsClient();
      const existingIdsResponse = await client.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.squarePaymentsSheetName}!A:A`,
      });
      const existingIds = new Set(
        (existingIdsResponse.data.values ?? [])
          .map((row) => (Array.isArray(row) ? String(row[0] ?? "").trim() : ""))
          .filter((id) => id !== "")
      );

      const uniqueRows = unlockedRows.filter((row) => {
        const id = row.payment_id;
        if (existingIds.has(id)) return false;
        existingIds.add(id);
        return true;
      });

      if (uniqueRows.length === 0) return;

      const values = uniqueRows.map((row) =>
        SQUARE_PAYMENT_COLUMNS.map((key) => row[key] ?? "")
      );

      await client.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${this.squarePaymentsSheetName}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
    } finally {
      for (const id of lockedIds) {
        this.pendingSquarePaymentIds.delete(id);
      }
    }
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
      return String(cell ?? "").trim() === normalized;
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

  /**
   * Replace the Users tab with header row + data. Headers:
   * user_id, first_name, last_name, email, Square_team_ID
   */
  async replaceUsersSheetRows(
    rows: Array<{
      user_id: string;
      first_name: string;
      last_name: string;
      email: string;
      square_team_id: string;
    }>
  ): Promise<void> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }

    const meta = await client.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });
    const sheets = meta.data.sheets ?? [];
    const wanted = this.usersSheetName.trim();
    const wantedLower = wanted.toLowerCase();
    /** Google treats tab names as case-insensitive for uniqueness; use the doc's actual title in A1 ranges. */
    let sheetTitleForRange =
      sheets
        .map((s) => s.properties?.title)
        .find((t) => t != null && t.trim().toLowerCase() === wantedLower) ?? null;

    if (sheetTitleForRange == null) {
      try {
        await client.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: wanted },
                },
              },
            ],
          },
        });
        sheetTitleForRange = wanted;
      } catch (err: unknown) {
        const msg =
          err &&
          typeof err === "object" &&
          "message" in err &&
          typeof (err as { message: unknown }).message === "string"
            ? (err as { message: string }).message
            : String(err);
        if (
          msg.includes("already exists") ||
          msg.includes("Duplicate") ||
          msg.includes("duplicate")
        ) {
          const meta2 = await client.spreadsheets.get({
            spreadsheetId,
            fields: "sheets.properties",
          });
          sheetTitleForRange =
            (meta2.data.sheets ?? [])
              .map((s) => s.properties?.title)
              .find((t) => t != null && t.trim().toLowerCase() === wantedLower) ??
            wanted;
        } else {
          throw err;
        }
      }
    }

    const rangePrefix = a1SheetRangePrefix(sheetTitleForRange);
    const sheetDebug = {
      spreadsheet_id_prefix: `${spreadsheetId.slice(0, 8)}…`,
      configured_tab_name: wanted,
      resolved_tab_title: sheetTitleForRange,
      range_prefix_for_api: `${rangePrefix.slice(0, 40)}${rangePrefix.length > 40 ? "…" : ""}`,
      data_row_count: rows.length,
      total_value_rows_including_header: 1 + rows.length,
    };
    console.log("[UsersSheetSync][Sheets] Resolved tab and ranges", JSON.stringify(sheetDebug));

    const headers = [
      "user_id",
      "first_name",
      "last_name",
      "email",
      "Square_team_ID",
    ];
    const dataRows = rows.map((r) => [
      r.user_id,
      r.first_name,
      r.last_name,
      r.email,
      r.square_team_id,
    ]);
    const values = [headers, ...dataRows];

    const clearRange = `${rangePrefix}A:E`;
    await client.spreadsheets.values.clear({
      spreadsheetId,
      range: clearRange,
    });
    console.log(
      "[UsersSheetSync][Sheets] values.clear OK",
      JSON.stringify({ range: clearRange })
    );

    const updateRange = `${rangePrefix}A1:E${values.length}`;
    const updateRes = await client.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    console.log(
      "[UsersSheetSync][Sheets] values.update OK",
      JSON.stringify({
        range: updateRange,
        updated_range: updateRes.data.updatedRange ?? "",
        updated_rows: updateRes.data.updatedRows ?? null,
        updated_columns: updateRes.data.updatedColumns ?? null,
      })
    );
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

/** Sheet name prefix for A1 ranges (quote if needed per Google Sheets rules). */
function a1SheetRangePrefix(sheetTitle: string): string {
  const t = sheetTitle.trim();
  if (t === "") return "";
  if (/^[A-Za-z0-9_]+$/.test(t)) {
    return `${t}!`;
  }
  return `'${t.replace(/'/g, "''")}'!`;
}
