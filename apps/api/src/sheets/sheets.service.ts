import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, sheets_v4 } from "googleapis";
import type { SalesLogRow } from "../webhook/sales-log.types";
import type { SquarePaymentRow } from "../webhook/square-payment.types";

/** Orders created before this instant (UTC) are not appended to Sales_Log. */
const SALES_LOG_ORDER_CREATED_CUTOFF_MS = Date.UTC(2026, 3, 1, 0, 0, 0, 0);

function isOrderCreatedAtEligibleForSalesLog(orderCreatedAt: string): boolean {
  const ms = Date.parse(orderCreatedAt);
  if (!Number.isFinite(ms)) return false;
  return ms >= SALES_LOG_ORDER_CREATED_CUTOFF_MS;
}

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
  "cashed?",
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

/** One tab’s aggregates for a seller (L or M cash-in sheet). */
export type CashInTabAggregate = {
  sumCollected: number;
  sumC: number;
  sumD: number;
  sumE: number;
  /** Hand in total − card amount (= sumC − sumD). */
  cashIn: number;
};

/** Per-seller cash in from L + M tabs (final total = L.cashIn + M.cashIn). */
export type SellerCashInRow = {
  sellerId: string;
  l: CashInTabAggregate;
  m: CashInTabAggregate;
  finalTotal: number;
};

/** Read-only preview for Telegram /cash before user confirms. */
export type SellerCashInPreview = {
  sellerCode: string;
  lCashE: number;
  mCashE: number;
  amountWasAuto: boolean;
  amountUsed: number;
  currentOutstandingL: number;
  currentOutstandingM: number;
  currentOutstanding: number;
  newOutstandingL: number;
  newOutstandingM: number;
  newOutstanding: number;
  salesLogRowsToUpdate: number;
  squareRowsPrimary: number;
  squareRowsM: number;
};

/** Result after applying /cash mutations. */
export type SellerCashInApplyResult = {
  sellerCode: string;
  amountUsed: number;
  newOutstandingL: number;
  newOutstandingM: number;
  newOutstanding: number;
  outstandingRowDeleted: boolean;
  salesLogRowsUpdated: number;
  squareRowsDeletedPrimary: number;
  squareRowsDeletedM: number;
};

/** Outstanding balance row keyed by seller code digits from Outstanding tab. */
export type SellerOutstandingRow = {
  sellerCode: string;
  outstandingL: number;
  outstandingM: number;
  outstanding: number;
};

/** Seller code -> email map from Square IDs tab headers user_id/email. */
export type SellerEmailRow = {
  sellerCode: string;
  email: string;
};

export type SellerUncashedSaleBreakdownRow = {
  orderId: string;
  orderStatus: string;
  orderCreatedAt: string;
  ticketTypeSlug: string;
  ticketDisplayName: string;
  qty: number;
  unitPricePaid: number;
  grossAmount: number;
  grossCommission: number;
  handInAmount: number;
  categoryCompany: string;
  isCancelled: boolean;
};

export type SellerBreakdownResult = {
  sellerCode: string;
  sales: SellerUncashedSaleBreakdownRow[];
  saleCount: number;
  totalGross: number;
  totalCommission: number;
  totalHandIn: number;
  cardTotalPrimary: number;
  cardTotalM: number;
  cardTotalCombined: number;
};

@Injectable()
export class SheetsService {
  private sheets: sheets_v4.Sheets | null = null;
  private spreadsheetId: string = "";
  private salesLogSheetName: string = "Sales_Log";
  private ticketRulesSheetName: string = "Ticket_rules";
  private squarePaymentsSheetName: string = "Square_payments";
  private mSquarePaymentsSheetName: string = "M Square_payments";
  /** Prevent same payment_id from being inserted concurrently in this process. */
  private readonly pendingSquarePaymentKeys = new Set<string>();
  private sellersSheetName: string = "Sellers";
  private squareIdsSheetName: string = "Square IDs";
  private usersSheetName: string = "users";
  private lCashInSheetName: string = "L CASH IN 🍻";
  private mCashInSheetName: string = "M CASH IN 👑";
  private outstandingSheetName: string = "Outstanding";
  private salesLogCashedColumnName: string = "cashed?";

  constructor(private readonly config: ConfigService) {
    this.spreadsheetId = this.config.get<string>("spreadsheetId") ?? "";
    this.salesLogSheetName =
      this.config.get<string>("salesLogSheetName") ?? "Sales_Log";
    this.ticketRulesSheetName =
      this.config.get<string>("ticketRulesSheetName") ?? "Ticket_rules";
    this.squarePaymentsSheetName =
      this.config.get<string>("squarePaymentsSheetName") ?? "Square_payments";
    this.mSquarePaymentsSheetName =
      this.config.get<string>("mSquarePaymentsSheetName") ?? "M Square_payments";
    this.sellersSheetName = "Sellers";
    this.squareIdsSheetName =
      this.config.get<string>("squareIdsSheetName") ?? "Square IDs";
    this.usersSheetName = this.config.get<string>("usersSheetName") ?? "users";
    this.lCashInSheetName =
      this.config.get<string>("lCashInSheetName") ?? "L CASH IN 🍻";
    this.mCashInSheetName =
      this.config.get<string>("mCashInSheetName") ?? "M CASH IN 👑";
    this.outstandingSheetName =
      this.config.get<string>("outstandingSheetName") ?? "Outstanding";
    this.salesLogCashedColumnName =
      this.config.get<string>("salesLogCashedColumnName") ?? "cashed?";
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

  async getSellerBreakdownFromSheets(
    sellerCode: string
  ): Promise<SellerBreakdownResult> {
    const normalizedSellerCode = normalizeCashInSellerDigits(sellerCode);
    if (normalizedSellerCode === "") {
      throw new Error("Seller code must be digits only.");
    }

    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }

    const [salesRes, ticketRulesRes, primaryCardTotal, mCardTotal] =
      await Promise.all([
        client.spreadsheets.values.get({
          spreadsheetId,
          range: `${this.salesLogSheetName}!A:Z`,
        }),
        client.spreadsheets.values.get({
          spreadsheetId,
          range: `${this.ticketRulesSheetName}!A:C`,
        }),
        this.getSquareCardTotalForSeller(
          client,
          spreadsheetId,
          this.squarePaymentsSheetName,
          normalizedSellerCode
        ),
        this.getSquareCardTotalForSeller(
          client,
          spreadsheetId,
          this.mSquarePaymentsSheetName,
          normalizedSellerCode
        ),
      ]);

    const ticketDisplayBySlug = parseTicketDisplayNameBySlug(
      ticketRulesRes.data.values ?? []
    );
    const sales = parseUncashedSalesRowsForSeller(
      salesRes.data.values ?? [],
      normalizedSellerCode,
      ticketDisplayBySlug
    );

    let totalGross = 0;
    let totalCommission = 0;
    let totalHandIn = 0;
    for (const sale of sales) {
      if (sale.isCancelled) continue;
      totalGross += sale.grossAmount;
      totalCommission += sale.grossCommission;
      totalHandIn += sale.handInAmount;
    }

    return {
      sellerCode: normalizedSellerCode,
      sales,
      saleCount: sales.length,
      totalGross,
      totalCommission,
      totalHandIn,
      cardTotalPrimary: primaryCardTotal,
      cardTotalM: mCardTotal,
      cardTotalCombined: primaryCardTotal + mCardTotal,
    };
  }

  /**
   * Append Sales_Log rows to the configured spreadsheet.
   * Each row is written in the order of Sales_Log columns.
   * Rows whose `order_created_at` is before April 2026 (UTC) are dropped so
   * stale WooCommerce webhook replays do not pollute the sheet.
   */
  async appendSalesLogRows(rows: SalesLogRow[]): Promise<void> {
    const eligible = rows.filter((row) =>
      isOrderCreatedAtEligibleForSalesLog(row.order_created_at)
    );
    if (eligible.length === 0) {
      if (rows.length > 0) {
        const first = rows[0];
        console.log(
          "[SheetsService] Skipping Sales_Log append (order_created_at before April 2026 UTC)",
          JSON.stringify({
            order_id: first?.order_id,
            order_created_at: first?.order_created_at,
            dropped_rows: rows.length,
          })
        );
      }
      return;
    }
    if (eligible.length < rows.length) {
      console.log(
        "[SheetsService] Sales_Log append: dropped some rows before April 2026 UTC",
        JSON.stringify({
          order_id: rows[0]?.order_id,
          kept: eligible.length,
          dropped: rows.length - eligible.length,
        })
      );
    }

    const client = await this.getSheetsClient();
    const values = eligible.map((row) =>
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
    await this.appendSquarePaymentRowsToSheet(rows, this.squarePaymentsSheetName, "primary");
  }

  /**
   * Append M Square payment rows to the configured M spreadsheet tab.
   * Column order: Payment ID, Payment Time, Team Member, Seller ID, Amount (cents), Status.
   */
  async appendMSquarePaymentRows(rows: SquarePaymentRow[]): Promise<void> {
    await this.appendSquarePaymentRowsToSheet(rows, this.mSquarePaymentsSheetName, "m");
  }

  private async appendSquarePaymentRowsToSheet(
    rows: SquarePaymentRow[],
    sheetName: string,
    paymentNamespace: "primary" | "m"
  ): Promise<void> {
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
    const lockedKeys: string[] = [];
    const unlockedRows = normalizedRows.filter((row) => {
      const paymentId = row.payment_id;
      const pendingKey = `${paymentNamespace}:${paymentId}`;
      if (this.pendingSquarePaymentKeys.has(pendingKey)) return false;
      this.pendingSquarePaymentKeys.add(pendingKey);
      lockedKeys.push(pendingKey);
      return true;
    });
    if (unlockedRows.length === 0) return;

    try {
      const client = await this.getSheetsClient();
      const existingIdsResponse = await client.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:A`,
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

      const rowsForAppend: Array<{
        row: SquarePaymentRow;
        sellerNum: number;
        amountCents: number;
      }> = [];
      for (const row of uniqueRows) {
        const sellerNum = parseSellerIdInteger(row.seller_id);
        if (sellerNum == null) {
          console.warn(
            "[SheetsService] Skipping Square payment row: seller_id must be a non-negative integer",
            JSON.stringify({
              payment_id: row.payment_id,
              seller_id: row.seller_id,
            })
          );
          continue;
        }
        const amountCents = parseAmountCentsInteger(row.amount_cents);
        if (amountCents == null) {
          console.warn(
            "[SheetsService] Skipping Square payment row: amount_cents must be a safe integer",
            JSON.stringify({
              payment_id: row.payment_id,
              amount_cents: row.amount_cents,
            })
          );
          continue;
        }
        rowsForAppend.push({ row, sellerNum, amountCents });
      }
      if (rowsForAppend.length === 0) return;

      // Use JSON numbers for seller_id and amount_cents so Sheets stores numeric cells (not text with a leading ').
      const values: (string | number)[][] = rowsForAppend.map(
        ({ row, sellerNum, amountCents }) =>
          SQUARE_PAYMENT_COLUMNS.map((key) => {
            if (key === "seller_id") return sellerNum;
            if (key === "amount_cents") return amountCents;
            return row[key] ?? "";
          })
      );

      await client.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
    } finally {
      for (const key of lockedKeys) {
        this.pendingSquarePaymentKeys.delete(key);
      }
    }
  }

  async squarePaymentIdExists(paymentId: string): Promise<boolean> {
    return this.squarePaymentIdExistsInSheet(paymentId, this.squarePaymentsSheetName);
  }

  async mSquarePaymentIdExists(paymentId: string): Promise<boolean> {
    return this.squarePaymentIdExistsInSheet(paymentId, this.mSquarePaymentsSheetName);
  }

  private async squarePaymentIdExistsInSheet(
    paymentId: string,
    sheetName: string
  ): Promise<boolean> {
    const normalized = paymentId.trim();
    if (normalized === "") return false;

    const client = await this.getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A:A`,
    });

    const values = response.data.values ?? [];
    return values.some((row) => {
      const cell = Array.isArray(row) ? row[0] : undefined;
      return String(cell ?? "").trim() === normalized;
    });
  }

  /**
   * Square IDs tab (`user_id`, `email`, `Square_team_ID`, `M Square_team_ID`):
   * Match payment `team_member_id` to the given team column only; return `user_id`
   * (seller code written as Seller ID on Square payment rows). Email is not used for matching.
   */
  async getSellerIdFromSquareIdsByTeamMember(
    teamMemberId: string,
    teamColumnHeader: "Square_team_ID" | "M Square_team_ID"
  ): Promise<number | null> {
    const normalizedTeam = normalizeSquareTeamMemberId(teamMemberId);
    if (normalizedTeam === "") return null;

    const client = await this.getSheetsClient();
    const rangePrefix = a1SheetRangePrefix(this.squareIdsSheetName);
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${rangePrefix}A:Z`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) return null;

    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const normHeader = (h: string) => h.toLowerCase().replace(/\s+/g, "_");
    const userIdIdx = header.findIndex((h) => normHeader(h) === "user_id");
    const teamIdx = header.findIndex(
      (h) => normHeader(h) === normHeader(teamColumnHeader)
    );
    if (userIdIdx < 0 || teamIdx < 0) {
      throw new Error(
        `Square IDs tab must include 'user_id' and '${teamColumnHeader}' headers (sheet: "${this.squareIdsSheetName}")`
      );
    }

    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const teamCell = normalizeSquareTeamMemberId(row[teamIdx]);
      if (teamCell !== normalizedTeam) continue;
      return parseSellerIdInteger(row[userIdIdx]);
    }
    return null;
  }

  /**
   * Square IDs tab: match `Square_team_ID` to payment `team_member_id`, return `user_id`.
   */
  async getSellerIdBySquareTeamMemberId(
    teamMemberId: string
  ): Promise<number | null> {
    return this.getSellerIdFromSquareIdsByTeamMember(
      teamMemberId,
      "Square_team_ID"
    );
  }

  /**
   * For Sellers tab, set Square_team_ID using matching email values.
   * Rows with blank email are ignored.
   */
  async setSellerSquareTeamIdsByEmail(
    teamIdByEmail: Map<string, string>
  ): Promise<number> {
    return this.setSellerTeamIdsByEmailForColumn(teamIdByEmail, "Square_team_ID");
  }

  /**
   * For Sellers tab, set M Square_team_ID using matching email values.
   * Rows with blank email are ignored.
   */
  async setSellerMSquareTeamIdsByEmail(
    teamIdByEmail: Map<string, string>
  ): Promise<number> {
    return this.setSellerTeamIdsByEmailForColumn(teamIdByEmail, "M Square_team_ID");
  }

  private async setSellerTeamIdsByEmailForColumn(
    teamIdByEmail: Map<string, string>,
    teamColumnName: string
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
    const normHeader = (h: string) => h.toLowerCase().replace(/\s+/g, "_");
    const emailIdx = header.findIndex((v) => normHeader(v) === "email");
    const teamIdIdx = header.findIndex(
      (v) => normHeader(v) === normHeader(teamColumnName)
    );
    if (emailIdx < 0 || teamIdIdx < 0) {
      throw new Error(
        `Sellers tab is missing required headers 'email' or '${teamColumnName}'`
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
   * Read L + M cash-in tabs (A:E), aggregate per seller id (column A).
   * Per tab: cashIn = sum(hand in, C) − sum(card, D). Final total = L.cashIn + M.cashIn.
   */
  async getAllSellersCashInFromSheets(): Promise<SellerCashInRow[]> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }

    const titleL = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.lCashInSheetName,
      "Check L_CASH_IN_SHEET_NAME."
    );
    const titleM = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.mCashInSheetName,
      "Check M_CASH_IN_SHEET_NAME."
    );

    const rangeL = `${a1SheetRangePrefix(titleL)}A:E`;
    const rangeM = `${a1SheetRangePrefix(titleM)}A:E`;

    const batch = await client.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [rangeL, rangeM],
    });

    const valueRanges = batch.data.valueRanges ?? [];
    const rowsL = valueRanges[0]?.values ?? [];
    const rowsM = valueRanges[1]?.values ?? [];

    const mapL = aggregateCashInRowsBySeller(rowsL as unknown[][]);
    const mapM = aggregateCashInRowsBySeller(rowsM as unknown[][]);

    const sellerIds = new Set<string>([...mapL.keys(), ...mapM.keys()]);
    const out: SellerCashInRow[] = [];
    for (const sellerId of sellerIds) {
      const lAgg = mapL.get(sellerId) ?? { sumCollected: 0, sumC: 0, sumD: 0, sumE: 0 };
      const mAgg = mapM.get(sellerId) ?? { sumCollected: 0, sumC: 0, sumD: 0, sumE: 0 };
      const lCashIn = lAgg.sumC - lAgg.sumD;
      const mCashIn = mAgg.sumC - mAgg.sumD;
      out.push({
        sellerId,
        l: {
          sumCollected: lAgg.sumCollected,
          sumC: lAgg.sumC,
          sumD: lAgg.sumD,
          sumE: lAgg.sumE,
          cashIn: lCashIn,
        },
        m: {
          sumCollected: mAgg.sumCollected,
          sumC: mAgg.sumC,
          sumD: mAgg.sumD,
          sumE: mAgg.sumE,
          cashIn: mCashIn,
        },
        finalTotal: lCashIn + mCashIn,
      });
    }
    return out;
  }

  /** Read all outstanding balances from Outstanding tab headers Seller_Code / Outstanding L / Outstanding M. */
  async getAllOutstandingBalances(): Promise<SellerOutstandingRow[]> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }
    const title = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.outstandingSheetName,
      "Check OUTSTANDING_SHEET_NAME."
    );
    const range = `${a1SheetRangePrefix(title)}A:C`;
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const values = response.data.values ?? [];
    return parseAllOutstandingRows(values);
  }

  /** Read seller code/email rows from Square IDs tab (`user_id`, `email`). */
  async getSellerEmailRows(): Promise<SellerEmailRow[]> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }
    const title = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.squareIdsSheetName,
      "Check SQUARE_IDS_SHEET_NAME."
    );
    const range = `${a1SheetRangePrefix(title)}A:Z`;
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const values = response.data.values ?? [];
    return parseSellerEmailRows(values);
  }

  private async resolveSheetTitleForConfiguredTab(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    configuredName: string,
    notFoundHint?: string
  ): Promise<string> {
    const wanted = configuredName.trim();
    if (wanted === "") {
      throw new Error("Sheet tab name is empty");
    }
    const meta = await client.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });
    const sheetsList = meta.data.sheets ?? [];
    const wantedLower = wanted.toLowerCase();
    const found =
      sheetsList
        .map((s) => s.properties?.title)
        .find((t) => t != null && t.trim().toLowerCase() === wantedLower) ?? null;
    if (found == null) {
      const hint =
        notFoundHint ??
        "Check the configured sheet name in environment variables.";
      throw new Error(`Sheet tab not found: "${wanted}". ${hint}`);
    }
    return found;
  }

  /**
   * Telegram /cash — preview only (no writes).
   * @param explicitAmount `undefined` = use L column E + M column E; otherwise use this hand-in amount.
   */
  async previewSellerCashInFromSheets(
    sellerCode: string,
    explicitAmount?: number
  ): Promise<SellerCashInPreview> {
    const ctx = await this.loadCashInContextForSeller(sellerCode);
    const amountWasAuto = explicitAmount === undefined;
    const amountUsed = amountWasAuto ? ctx.lCashE + ctx.mCashE : explicitAmount;
    if (!Number.isFinite(amountUsed)) {
      throw new Error("Amount is not a valid number.");
    }
    const newOutstanding =
      ctx.lCashE + ctx.mCashE + ctx.currentOutstanding - amountUsed;
    const splitOutstanding = splitOutstandingByPriority(newOutstanding, ctx.mCashE);
    return {
      sellerCode,
      lCashE: ctx.lCashE,
      mCashE: ctx.mCashE,
      amountWasAuto,
      amountUsed,
      currentOutstandingL: ctx.currentOutstandingL,
      currentOutstandingM: ctx.currentOutstandingM,
      currentOutstanding: ctx.currentOutstanding,
      newOutstandingL: splitOutstanding.outstandingL,
      newOutstandingM: splitOutstanding.outstandingM,
      newOutstanding,
      salesLogRowsToUpdate: ctx.salesLogMatchCount,
      squareRowsPrimary: ctx.squarePrimaryDeleteCount,
      squareRowsM: ctx.squareMDeleteCount,
    };
  }

  /**
   * Telegram /cash — apply after user confirms. Re-reads sheet values at execution time.
   * @param explicitAmount `undefined` = auto (L E + M E); else use this amount.
   */
  async applySellerCashInFromSheets(
    sellerCode: string,
    explicitAmount?: number
  ): Promise<SellerCashInApplyResult> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }

    const ctx = await this.loadCashInContextForSeller(sellerCode);
    const amountUsed =
      explicitAmount === undefined ? ctx.lCashE + ctx.mCashE : explicitAmount;
    if (!Number.isFinite(amountUsed)) {
      throw new Error("Amount is not a valid number.");
    }
    const newOutstanding =
      ctx.lCashE + ctx.mCashE + ctx.currentOutstanding - amountUsed;
    const splitOutstanding = splitOutstandingByPriority(newOutstanding, ctx.mCashE);

    const outstandingTitle = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.outstandingSheetName,
      "Check OUTSTANDING_SHEET_NAME."
    );
    const outstandingSheetId = await this.getSheetIdForTitle(
      client,
      spreadsheetId,
      outstandingTitle
    );
    const outPrefix = a1SheetRangePrefix(outstandingTitle);

    const outstandingRowDeleted =
      Math.abs(splitOutstanding.totalOutstanding) < OUTSTANDING_ZERO_EPS &&
      ctx.outstandingSheetRow1Based != null;
    await this.writeOutstandingValue(
      client,
      spreadsheetId,
      outPrefix,
      outstandingSheetId,
      sellerCode,
      splitOutstanding,
      ctx.outstandingSheetRow1Based
    );

    const salesUpdated = await this.markSalesLogCashedForSeller(
      client,
      spreadsheetId,
      sellerCode
    );

    const delP = await this.deleteSquarePaymentRowsForSeller(
      client,
      spreadsheetId,
      this.squarePaymentsSheetName,
      sellerCode
    );
    const delM = await this.deleteSquarePaymentRowsForSeller(
      client,
      spreadsheetId,
      this.mSquarePaymentsSheetName,
      sellerCode
    );

    return {
      sellerCode,
      amountUsed,
      newOutstandingL: splitOutstanding.outstandingL,
      newOutstandingM: splitOutstanding.outstandingM,
      newOutstanding:
        Math.abs(splitOutstanding.totalOutstanding) < OUTSTANDING_ZERO_EPS
          ? 0
          : splitOutstanding.totalOutstanding,
      outstandingRowDeleted,
      salesLogRowsUpdated: salesUpdated,
      squareRowsDeletedPrimary: delP,
      squareRowsDeletedM: delM,
    };
  }

  private async loadCashInContextForSeller(sellerCode: string): Promise<{
    lCashE: number;
    mCashE: number;
    currentOutstandingL: number;
    currentOutstandingM: number;
    currentOutstanding: number;
    outstandingSheetRow1Based: number | null;
    salesLogMatchCount: number;
    squarePrimaryDeleteCount: number;
    squareMDeleteCount: number;
  }> {
    const client = await this.getSheetsClient();
    const spreadsheetId = this.spreadsheetId.trim();
    if (spreadsheetId === "") {
      throw new Error("SPREADSHEET_ID is not set");
    }

    const cashRows = await this.getAllSellersCashInFromSheets();
    const cash = cashRows.find(
      (r) => normalizeCashInSellerDigits(r.sellerId) === sellerCode
    );
    if (cash == null) {
      throw new Error(
        `Seller ${sellerCode} not found on L/M cash-in tabs.`
      );
    }
    const lCashE = cash.l.sumE;
    const mCashE = cash.m.sumE;

    const outstandingTitle = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      this.outstandingSheetName,
      "Check OUTSTANDING_SHEET_NAME."
    );
    const outRange = `${a1SheetRangePrefix(outstandingTitle)}A:C`;
    const outRes = await client.spreadsheets.values.get({
      spreadsheetId,
      range: outRange,
    });
    const outValues = outRes.data.values ?? [];
    const { currentOutstandingL, currentOutstandingM, currentOutstanding, row1Based } =
      parseOutstandingForSeller(
      outValues,
      sellerCode
    );

    const salesLogRes = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${this.salesLogSheetName}!A:Z`,
    });
    const salesValues = salesLogRes.data.values ?? [];
    const salesLogMatchCount = countSalesLogRowsForSeller(
      salesValues,
      sellerCode,
      this.salesLogCashedColumnName
    );

    const sqP = await this.countSquareRowsForSeller(
      client,
      spreadsheetId,
      this.squarePaymentsSheetName,
      sellerCode
    );
    const sqM = await this.countSquareRowsForSeller(
      client,
      spreadsheetId,
      this.mSquarePaymentsSheetName,
      sellerCode
    );

    return {
      lCashE,
      mCashE,
      currentOutstandingL,
      currentOutstandingM,
      currentOutstanding,
      outstandingSheetRow1Based: row1Based,
      salesLogMatchCount,
      squarePrimaryDeleteCount: sqP,
      squareMDeleteCount: sqM,
    };
  }

  private async getSheetIdForTitle(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetTitle: string
  ): Promise<number> {
    const meta = await client.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });
    const want = sheetTitle.trim().toLowerCase();
    const sheet = (meta.data.sheets ?? []).find(
      (s) => (s.properties?.title ?? "").trim().toLowerCase() === want
    );
    const id = sheet?.properties?.sheetId;
    if (id == null) {
      throw new Error(`No sheetId for tab "${sheetTitle}"`);
    }
    return id;
  }

  private async writeOutstandingValue(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    rangePrefix: string,
    sheetId: number,
    sellerCode: string,
    splitOutstanding: {
      outstandingL: number;
      outstandingM: number;
      totalOutstanding: number;
    },
    existingRow1Based: number | null
  ): Promise<void> {
    const abs = Math.abs(splitOutstanding.totalOutstanding);
    if (abs < OUTSTANDING_ZERO_EPS) {
      if (existingRow1Based != null) {
        await this.deleteSheetRowsBy1BasedIndices(
          client,
          spreadsheetId,
          sheetId,
          [existingRow1Based]
        );
      }
      return;
    }

    const cellL = String(splitOutstanding.outstandingL);
    const cellM = String(splitOutstanding.outstandingM);
    if (existingRow1Based != null) {
      const colB = `${rangePrefix}B${existingRow1Based}`;
      const colC = `${rangePrefix}C${existingRow1Based}`;
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `${colB}:${colC}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[cellL, cellM]] },
      });
      return;
    }

    const appendRange = `${rangePrefix}A:C`;
    await client.spreadsheets.values.append({
      spreadsheetId,
      range: appendRange,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[sellerCode, cellL, cellM]] },
    });
  }

  private async markSalesLogCashedForSeller(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sellerCode: string
  ): Promise<number> {
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${this.salesLogSheetName}!A:Z`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) {
      throw new Error("Sales_Log tab is empty.");
    }
    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const sellerIdx = header.findIndex(
      (h) => normSheetHeader(h) === "seller_code"
    );
    const cashedIdx = header.findIndex(
      (h) => normSheetHeader(h) === normSheetHeader(this.salesLogCashedColumnName)
    );
    if (sellerIdx < 0) {
      throw new Error("Sales_Log must include a seller_code column.");
    }
    if (cashedIdx < 0) {
      throw new Error(
        `Sales_Log must include column "${this.salesLogCashedColumnName}".`
      );
    }

    const updates: sheets_v4.Schema$ValueRange[] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const rowSeller = normalizeCashInSellerDigits(String(row[sellerIdx] ?? ""));
      if (rowSeller !== sellerCode) continue;
      const rowNumber = i + 1;
      const col = toA1Column(cashedIdx + 1);
      updates.push({
        range: `${this.salesLogSheetName}!${col}${rowNumber}`,
        values: [["TRUE"]],
      });
    }

    if (updates.length > 0) {
      await client.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      });
    }
    return updates.length;
  }

  private async countSquareRowsForSeller(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    sellerCode: string
  ): Promise<number> {
    const title = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      sheetName,
      `Check sheet name for "${sheetName}".`
    );
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A:F`,
    });
    const values = response.data.values ?? [];
    if (values.length === 0) return 0;
    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const sellerIdx = header.findIndex(
      (h) => normSheetHeader(h) === "seller_id"
    );
    if (sellerIdx < 0) return 0;
    let n = 0;
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      if (squareRowSellerMatches(row[sellerIdx], sellerCode)) n += 1;
    }
    return n;
  }

  private async deleteSquarePaymentRowsForSeller(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    sellerCode: string
  ): Promise<number> {
    const title = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      sheetName,
      `Check sheet name for "${sheetName}".`
    );
    const sheetId = await this.getSheetIdForTitle(
      client,
      spreadsheetId,
      title
    );
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A:F`,
    });
    const values = response.data.values ?? [];
    if (values.length < 2) return 0;
    const header = values[0]?.map((v) => String(v).trim()) ?? [];
    const sellerIdx = header.findIndex(
      (h) => normSheetHeader(h) === "seller_id"
    );
    if (sellerIdx < 0) return 0;

    const rowNumbers1Based: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      if (squareRowSellerMatches(row[sellerIdx], sellerCode)) {
        rowNumbers1Based.push(i + 1);
      }
    }
    if (rowNumbers1Based.length === 0) return 0;
    await this.deleteSheetRowsBy1BasedIndices(
      client,
      spreadsheetId,
      sheetId,
      rowNumbers1Based
    );
    return rowNumbers1Based.length;
  }

  private async getSquareCardTotalForSeller(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    sellerCode: string
  ): Promise<number> {
    const title = await this.resolveSheetTitleForConfiguredTab(
      client,
      spreadsheetId,
      sheetName,
      `Check sheet name for "${sheetName}".`
    );
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A:F`,
    });
    const values = response.data.values ?? [];
    if (values.length < 2) return 0;

    const header = values[0]?.map((v) => String(v ?? "").trim()) ?? [];
    const sellerIdx = header.findIndex(
      (h) => normSheetHeader(h) === "seller_id"
    );
    const amountCentsIdx = header.findIndex(
      (h) => normSheetHeader(h) === "amount_(cents)" || normSheetHeader(h) === "amount_cents"
    );
    if (sellerIdx < 0 || amountCentsIdx < 0) return 0;

    let sumCents = 0;
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      if (!squareRowSellerMatches(row[sellerIdx], sellerCode)) continue;
      const cents = parseAmountCentsInteger(row[amountCentsIdx]) ?? 0;
      sumCents += cents;
    }
    return sumCents / 100;
  }

  private async deleteSheetRowsBy1BasedIndices(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetId: number,
    rowNumbers1Based: number[]
  ): Promise<void> {
    const unique = [...new Set(rowNumbers1Based)].sort((a, b) => b - a);
    const requests = unique.map((row1) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS" as const,
          startIndex: row1 - 1,
          endIndex: row1,
        },
      },
    }));
    if (requests.length === 0) return;
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  /**
   * Replace the Users tab with header row + data. Headers:
   * user_id, first_name, last_name, email, Square_team_ID, M Square_team_ID
   */
  async replaceUsersSheetRows(
    rows: Array<{
      user_id: string;
      first_name: string;
      last_name: string;
      email: string;
      square_team_id: string;
      m_square_team_id: string;
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
      "M Square_team_ID",
    ];
    const dataRows = rows.map((r) => [
      r.user_id,
      r.first_name,
      r.last_name,
      r.email,
      r.square_team_id,
      r.m_square_team_id,
    ]);
    const values = [headers, ...dataRows];

    const clearRange = `${rangePrefix}A:F`;
    await client.spreadsheets.values.clear({
      spreadsheetId,
      range: clearRange,
    });
    console.log(
      "[UsersSheetSync][Sheets] values.clear OK",
      JSON.stringify({ range: clearRange })
    );

    const updateRange = `${rangePrefix}A1:F${values.length}`;
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

const OUTSTANDING_ZERO_EPS = 1e-9;

function normSheetHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Digits-only seller key for matching across tabs (Telegram /cash, /balance). */
function normalizeCashInSellerDigits(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function aggregateCashInRowsBySeller(
  rows: unknown[][]
): Map<string, { sumCollected: number; sumC: number; sumD: number; sumE: number }> {
  const map = new Map<
    string,
    { sumCollected: number; sumC: number; sumD: number; sumE: number }
  >();
  const header = (rows[0] ?? []).map((cell) => normSheetHeader(String(cell ?? "")));
  const idxSeller = header.findIndex((h) => h === "seller_id");
  const idxCollected = header.findIndex((h) => h === "total_collected");
  const idxHandIn = header.findIndex((h) => h === "total_hand_in");
  const idxCard = header.findIndex((h) => h === "card_amount");
  const idxCashIn = header.findIndex((h) => h === "cash_in");
  const hasHeader = idxSeller >= 0;
  const start = hasHeader ? 1 : 0;

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const sellerId = String(row[idxSeller >= 0 ? idxSeller : 0] ?? "").trim();
    if (sellerId === "") continue;
    const collected = parseSheetMoneyNumber(row[idxCollected >= 0 ? idxCollected : 1]);
    const c = parseSheetMoneyNumber(row[idxHandIn >= 0 ? idxHandIn : 2]);
    const d = parseSheetMoneyNumber(row[idxCard >= 0 ? idxCard : 3]);
    const e = parseSheetMoneyNumber(row[idxCashIn >= 0 ? idxCashIn : 4]);
    const cur = map.get(sellerId) ?? { sumCollected: 0, sumC: 0, sumD: 0, sumE: 0 };
    cur.sumCollected += collected;
    cur.sumC += c;
    cur.sumD += d;
    cur.sumE += e;
    map.set(sellerId, cur);
  }
  return map;
}

/** Hand in / card / cash-in cells: commas, optional £, Sheets leading apostrophe. */
function parseSheetMoneyNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  let s = String(value ?? "").trim();
  if (s.startsWith("'")) {
    s = s.slice(1).trim();
  }
  s = s.replace(/,/g, "").replace(/£/g, "").replace(/\s/g, "");
  if (s === "") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function parseOutstandingForSeller(
  values: unknown[][],
  sellerCode: string
): {
  currentOutstandingL: number;
  currentOutstandingM: number;
  currentOutstanding: number;
  row1Based: number | null;
} {
  if (values.length === 0) {
    return {
      currentOutstandingL: 0,
      currentOutstandingM: 0,
      currentOutstanding: 0,
      row1Based: null,
    };
  }
  const headerRow = values[0] ?? [];
  const idxSeller = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "seller_code"
  );
  const idxOutL = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding_l"
  );
  const idxOutM = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding_m"
  );
  const idxLegacyOut = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding"
  );
  const hasSplit = idxOutL >= 0 && idxOutM >= 0;
  if (idxSeller < 0 || (!hasSplit && idxLegacyOut < 0)) {
    throw new Error(
      'Outstanding tab row 1 must include headers "Seller_Code", "Outstanding L", and "Outstanding M".'
    );
  }
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowSeller = normalizeCashInSellerDigits(String(row[idxSeller] ?? ""));
    if (rowSeller !== sellerCode) continue;
    const outstandingL = hasSplit ? parseSheetMoneyNumber(row[idxOutL]) : 0;
    const outstandingM = hasSplit
      ? parseSheetMoneyNumber(row[idxOutM])
      : parseSheetMoneyNumber(row[idxLegacyOut]);
    return {
      currentOutstandingL: outstandingL,
      currentOutstandingM: outstandingM,
      currentOutstanding: outstandingL + outstandingM,
      row1Based: i + 1,
    };
  }
  return {
    currentOutstandingL: 0,
    currentOutstandingM: 0,
    currentOutstanding: 0,
    row1Based: null,
  };
}

function parseAllOutstandingRows(values: unknown[][]): SellerOutstandingRow[] {
  if (values.length === 0) return [];
  const headerRow = values[0] ?? [];
  const idxSeller = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "seller_code"
  );
  const idxOutL = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding_l"
  );
  const idxOutM = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding_m"
  );
  const idxLegacyOut = headerRow.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "outstanding"
  );
  const hasSplit = idxOutL >= 0 && idxOutM >= 0;
  if (idxSeller < 0 || (!hasSplit && idxLegacyOut < 0)) {
    throw new Error(
      'Outstanding tab row 1 must include headers "Seller_Code", "Outstanding L", and "Outstanding M".'
    );
  }
  const out: SellerOutstandingRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const sellerCode = normalizeCashInSellerDigits(String(row[idxSeller] ?? ""));
    if (sellerCode === "") continue;
    const outstandingL = hasSplit ? parseSheetMoneyNumber(row[idxOutL]) : 0;
    const outstandingM = hasSplit
      ? parseSheetMoneyNumber(row[idxOutM])
      : parseSheetMoneyNumber(row[idxLegacyOut]);
    out.push({
      sellerCode,
      outstandingL,
      outstandingM,
      outstanding: outstandingL + outstandingM,
    });
  }
  return out;
}

function splitOutstandingByPriority(
  totalOutstanding: number,
  mCashIn: number
): { outstandingL: number; outstandingM: number; totalOutstanding: number } {
  if (!Number.isFinite(totalOutstanding)) {
    return { outstandingL: 0, outstandingM: 0, totalOutstanding: 0 };
  }
  if (Math.abs(totalOutstanding) < OUTSTANDING_ZERO_EPS) {
    return { outstandingL: 0, outstandingM: 0, totalOutstanding: 0 };
  }

  // Keep as much outstanding as possible on M first, capped by M cash-in for positive totals.
  if (totalOutstanding > 0) {
    const cappedM = Math.min(totalOutstanding, Math.max(0, mCashIn));
    const outstandingL = totalOutstanding - cappedM;
    return { outstandingL, outstandingM: cappedM, totalOutstanding };
  }

  // Negative outstanding means seller is owed; keep it on M first.
  return { outstandingL: 0, outstandingM: totalOutstanding, totalOutstanding };
}

function parseSellerEmailRows(values: unknown[][]): SellerEmailRow[] {
  if (values.length === 0) return [];
  const header = values[0] ?? [];
  const userIdIdx = header.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "user_id"
  );
  const emailIdx = header.findIndex(
    (c) => normSheetHeader(String(c ?? "")) === "email"
  );
  if (userIdIdx < 0 || emailIdx < 0) {
    return [];
  }
  const out: SellerEmailRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const sellerCode = normalizeCashInSellerDigits(String(row[userIdIdx] ?? ""));
    if (sellerCode === "") continue;
    const email = String(row[emailIdx] ?? "").trim();
    out.push({ sellerCode, email });
  }
  return out;
}

function parseTicketDisplayNameBySlug(values: unknown[][]): Map<string, string> {
  const out = new Map<string, string>();
  if (values.length === 0) return out;

  const header = values[0]?.map((v) => String(v ?? "").trim()) ?? [];
  const slugIdx = header.findIndex(
    (h) => normSheetHeader(h) === "ticket_type_slug"
  );
  const displayIdx = header.findIndex(
    (h) => normSheetHeader(h) === "display_name"
  );
  const idxSlug = slugIdx >= 0 ? slugIdx : 0;
  const idxDisplay = displayIdx >= 0 ? displayIdx : 2;

  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const slug = String(row[idxSlug] ?? "").trim();
    if (slug === "" || out.has(slug)) continue;
    const displayName = String(row[idxDisplay] ?? "").trim();
    out.set(slug, displayName === "" ? slug : displayName);
  }
  return out;
}

function parseUncashedSalesRowsForSeller(
  values: unknown[][],
  sellerCode: string,
  ticketDisplayBySlug: ReadonlyMap<string, string>
): SellerUncashedSaleBreakdownRow[] {
  if (values.length < 2) return [];
  const header = values[0]?.map((v) => String(v ?? "").trim()) ?? [];

  const sellerIdx = header.findIndex(
    (h) => normSheetHeader(h) === "seller_code"
  );
  const cashedIdx = header.findIndex((h) => normSheetHeader(h) === "cashed?");
  const orderIdIdx = header.findIndex((h) => normSheetHeader(h) === "order_id");
  const orderStatusIdx = header.findIndex(
    (h) => normSheetHeader(h) === "order_status"
  );
  const createdIdx = header.findIndex(
    (h) => normSheetHeader(h) === "order_created_at"
  );
  const ticketTypeIdx = header.findIndex(
    (h) => normSheetHeader(h) === "ticket_type"
  );
  const qtyIdx = header.findIndex((h) => normSheetHeader(h) === "qty");
  const unitPricePaidIdx = header.findIndex(
    (h) => normSheetHeader(h) === "unit_price_paid"
  );
  const grossAmountIdx = header.findIndex(
    (h) => normSheetHeader(h) === "gross_amount"
  );
  const grossCommissionIdx = header.findIndex(
    (h) => normSheetHeader(h) === "gross_commission"
  );
  const handInIdx = header.findIndex(
    (h) => normSheetHeader(h) === "hand_in_amount"
  );
  const categoryIdx = header.findIndex(
    (h) => normSheetHeader(h) === "category_(company)"
  );

  if (sellerIdx < 0 || cashedIdx < 0) {
    throw new Error(
      'Sales_Log must include headers "seller_code" and "cashed?".'
    );
  }

  const out: SellerUncashedSaleBreakdownRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowSeller = normalizeCashInSellerDigits(String(row[sellerIdx] ?? ""));
    if (rowSeller !== sellerCode) continue;
    if (isTruthySheetCell(row[cashedIdx])) continue;

    const ticketTypeSlug = String(
      ticketTypeIdx >= 0 ? row[ticketTypeIdx] ?? "" : ""
    ).trim();
    const ticketDisplayName =
      ticketDisplayBySlug.get(ticketTypeSlug) ?? ticketTypeSlug;
    const qty = parseSheetMoneyNumber(qtyIdx >= 0 ? row[qtyIdx] : 0);
    const orderStatus = String(
      orderStatusIdx >= 0 ? row[orderStatusIdx] ?? "" : ""
    ).trim();

    out.push({
      orderId: String(orderIdIdx >= 0 ? row[orderIdIdx] ?? "" : "").trim(),
      orderStatus,
      orderCreatedAt: String(createdIdx >= 0 ? row[createdIdx] ?? "" : "").trim(),
      ticketTypeSlug,
      ticketDisplayName,
      qty,
      unitPricePaid: parseSheetMoneyNumber(
        unitPricePaidIdx >= 0 ? row[unitPricePaidIdx] : 0
      ),
      grossAmount: parseSheetMoneyNumber(
        grossAmountIdx >= 0 ? row[grossAmountIdx] : 0
      ),
      grossCommission: parseSheetMoneyNumber(
        grossCommissionIdx >= 0 ? row[grossCommissionIdx] : 0
      ),
      handInAmount: parseSheetMoneyNumber(handInIdx >= 0 ? row[handInIdx] : 0),
      categoryCompany: String(categoryIdx >= 0 ? row[categoryIdx] ?? "" : "").trim(),
      isCancelled: isCancelledOrderStatus(orderStatus),
    });
  }
  return out;
}

function isTruthySheetCell(value: unknown): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "checked" ||
    normalized === "x"
  );
}

function isCancelledOrderStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "cancelled" || normalized === "canceled";
}

function countSalesLogRowsForSeller(
  values: unknown[][],
  sellerCode: string,
  cashedColumnHeader: string
): number {
  if (values.length < 2) return 0;
  const header = values[0]?.map((v) => String(v).trim()) ?? [];
  const sellerIdx = header.findIndex(
    (h) => normSheetHeader(h) === "seller_code"
  );
  const cashedIdx = header.findIndex(
    (h) => normSheetHeader(h) === normSheetHeader(cashedColumnHeader)
  );
  if (sellerIdx < 0 || cashedIdx < 0) return 0;
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowSeller = normalizeCashInSellerDigits(String(row[sellerIdx] ?? ""));
    if (rowSeller !== sellerCode) continue;
    n += 1;
  }
  return n;
}

function squareRowSellerMatches(cell: unknown, sellerCodeNorm: string): boolean {
  const parsed = parseSellerIdInteger(cell);
  if (parsed != null) {
    return String(parsed) === sellerCodeNorm;
  }
  return normalizeCashInSellerDigits(String(cell ?? "")) === sellerCodeNorm;
}

/** Square team member id from API or Sheets cell (strip spaces and leading apostrophe). */
function normalizeSquareTeamMemberId(value: unknown): string {
  let s = String(value ?? "").trim();
  if (s.startsWith("'")) {
    s = s.slice(1).trim();
  }
  return s;
}

/**
 * Sellers sheet / webhook may contain a plain integer, a string of digits, or text
 * entered in Sheets with a leading apostrophe (stored/read as a string). Only
 * non-negative safe integers are accepted for Square_payments.seller_id.
 */
function parseSellerIdInteger(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
    return value;
  }
  let s = String(value ?? "").trim();
  if (s.startsWith("'")) {
    s = s.slice(1).trim();
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Amount in cents from the webhook (or a string). Strips Sheets-style leading `'`
 * and optional thousands commas; must be a safe integer (negative allowed for refunds).
 */
function parseAmountCentsInteger(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (!Number.isSafeInteger(value)) return null;
    return value;
  }
  let s = String(value ?? "").trim();
  if (s.startsWith("'")) {
    s = s.slice(1).trim();
  }
  s = s.replace(/,/g, "");
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
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
