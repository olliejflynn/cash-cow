import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type {
  SellerCashInApplyResult,
  SellerCashInPreview,
  SellerCashInRow,
  SellerEmailRow,
  SellerOutstandingRow,
} from "../sheets/sheets.service";
import { SheetsService } from "../sheets/sheets.service";

const HELP_REPLY =
  "This will display a list of commands.";

/** Telegram sends this when setWebhook included secret_token (name is case-insensitive). */
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Confirm cash-in: `cfy|<sellerDigits>|<amountToken>` — amountToken `A` = auto (L+M from sheet). */
const CASH_CONFIRM_PREFIX = "cfy|";
/** Cancel pending cash-in (no payload). */
const CASH_CANCEL_DATA = "cfn";
/** Telegram Bot API: callback_data max length (UTF-8 bytes). */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const seenCashCallbackIds = new Set<string>();

@Controller("telegram")
export class TelegramWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly sheetsService: SheetsService
  ) {}

  @Post("webhook")
  @HttpCode(200)
  async handleWebhook(
    @Req() req: Request,
    @Body() body: unknown
  ): Promise<{ ok: boolean }> {
    const expectedSecret =
      this.config.get<string>("telegramWebhookSecret")?.trim() ?? "";
    if (expectedSecret !== "") {
      const got = (req.get(TELEGRAM_SECRET_HEADER) ?? "").trim();
      if (got !== expectedSecret) {
        console.warn(
          "[TelegramWebhook] 401: webhook secret mismatch or missing header. " +
            "If TELEGRAM_WEBHOOK_SECRET is set, call setWebhook with the same secret_token, " +
            "or unset TELEGRAM_WEBHOOK_SECRET to disable verification.",
          JSON.stringify({ header_present: got !== "" })
        );
        throw new UnauthorizedException();
      }
    }

    const token = this.config.get<string>("telegramBotToken")?.trim() ?? "";
    if (token === "") {
      console.error(
        "[TelegramWebhook] TELEGRAM_BOT_TOKEN is not set; ignoring update"
      );
      return { ok: false };
    }

    const callback = extractCallbackQuery(body);
    if (callback != null) {
      await this.handleTelegramCallback(token, callback);
      return { ok: true };
    }

    const msg = extractMessageChatAndText(body);
    if (msg == null) {
      return { ok: true };
    }
    const { chatId, text } = msg;

    if (isHelpCommand(text)) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: HELP_REPLY,
      });
      return { ok: true };
    }

    const balanceCommand = parseBalanceCommand(text);
    if (balanceCommand != null) {
      await this.handleBalanceCommand(token, chatId, balanceCommand.sellerCode);
      return { ok: true };
    }

    const cashParsed = parseCashCommand(text);
    if (cashParsed != null) {
      if (!cashParsed.ok) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: cashParsed.error,
        });
        return { ok: true };
      }
      await this.handleCashPreviewCommand(
        token,
        chatId,
        cashParsed.sellerCode,
        cashParsed.explicitAmount
      );
      return { ok: true };
    }

    return { ok: true };
  }

  private async handleTelegramCallback(
    token: string,
    callback: CallbackQueryExtract
  ): Promise<void> {
    const data = callback.data.trim();
    if (data === CASH_CANCEL_DATA) {
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
        text: "Cancelled.",
      });
      return;
    }

    if (!data.startsWith(CASH_CONFIRM_PREFIX)) {
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
      });
      return;
    }

    if (seenCashCallbackIds.has(callback.callbackQueryId)) {
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
        text: "Already processed.",
      });
      return;
    }
    seenCashCallbackIds.add(callback.callbackQueryId);
    if (seenCashCallbackIds.size > 5000) {
      seenCashCallbackIds.clear();
    }

    const parsed = parseCashConfirmCallbackData(data);
    if (parsed == null) {
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
        text: "Invalid confirm payload.",
      });
      return;
    }

    await telegramAnswerCallbackQuery(token, {
      callback_query_id: callback.callbackQueryId,
    });

    let result: SellerCashInApplyResult;
    try {
      result = await this.sheetsService.applySellerCashInFromSheets(
        parsed.sellerCode,
        parsed.explicitAmount
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error applying cash-in.";
      console.error("[TelegramWebhook] /cash apply error", msg);
      await telegramSendMessage(token, {
        chat_id: callback.chatId,
        text: `Cash-in failed.\n${msg}`,
      });
      return;
    }

    await telegramSendMessage(token, {
      chat_id: callback.chatId,
      text: formatCashApplySuccess(result),
    });
  }

  private async handleCashPreviewCommand(
    token: string,
    chatId: number,
    sellerCode: string,
    explicitAmount?: number
  ): Promise<void> {
    let preview: SellerCashInPreview;
    try {
      preview = await this.sheetsService.previewSellerCashInFromSheets(
        sellerCode,
        explicitAmount
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading sheets.";
      console.error("[TelegramWebhook] /cash preview error", msg);
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: `Could not prepare cash-in preview.\n${msg}`,
      });
      return;
    }

    const confirmData = buildCashConfirmCallbackData(
      sellerCode,
      explicitAmount
    );
    if (confirmData == null) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text:
          "Cannot build confirm button (payload too long for Telegram). " +
          "Try a shorter seller code or amount.",
      });
      return;
    }

    await telegramSendMessage(token, {
      chat_id: chatId,
      text: formatCashPreview(preview),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm cash-in", callback_data: confirmData },
            { text: "Cancel", callback_data: CASH_CANCEL_DATA },
          ],
        ],
      },
    });
  }

  private async handleBalanceCommand(
    token: string,
    chatId: number,
    sellerCode: string | null
  ): Promise<void> {
    let rows: SellerCashInRow[];
    let outstandingRows: SellerOutstandingRow[];
    let emailRows: SellerEmailRow[];
    try {
      [rows, outstandingRows, emailRows] = await Promise.all([
        this.sheetsService.getAllSellersCashInFromSheets(),
        this.sheetsService.getAllOutstandingBalances(),
        this.sheetsService.getSellerEmailRows(),
      ]);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading sheets.";
      console.error("[TelegramWebhook] /balance sheets error", msg);
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: `Could not load cash-in data.\n${msg}`,
      });
      return;
    }

    const outstandingBySeller = new Map<string, number>(
      outstandingRows.map((r) => [r.sellerCode, r.outstanding])
    );
    const emailBySeller = new Map<string, string>(
      emailRows.map((r) => [r.sellerCode, r.email])
    );

    if (rows.length === 0 && outstandingBySeller.size === 0) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: "No sellers found on cash-in or outstanding tabs.",
      });
      return;
    }

    if (sellerCode != null) {
      const row = rows.find((r) => normalizeSellerCode(r.sellerId) === sellerCode);
      const outstanding = outstandingBySeller.get(sellerCode) ?? 0;
      if (row == null && outstanding === 0) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: `Seller ${sellerCode} was not found.`,
        });
        return;
      }
      const l = row?.l.sumE ?? 0;
      const m = row?.m.sumE ?? 0;
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatSingleSellerBalanceHtml({
          sellerCode,
          email: emailBySeller.get(sellerCode) ?? "",
          l,
          m,
          outstanding,
        }),
        parse_mode: "HTML",
      });
      return;
    }

    const table = formatAllBalancesHtml(rows, outstandingBySeller, emailBySeller);
    await telegramSendMessage(token, {
      chat_id: chatId,
      text: table,
      parse_mode: "HTML",
    });
  }
}

type CallbackQueryExtract = {
  callbackQueryId: string;
  chatId: number;
  data: string;
};

function extractCallbackQuery(body: unknown): CallbackQueryExtract | null {
  if (!isRecord(body)) return null;
  const cq = body["callback_query"];
  if (!isRecord(cq)) return null;
  const id = cq["id"];
  const data = cq["data"];
  if (typeof id !== "string" || typeof data !== "string") return null;
  const message = cq["message"];
  if (!isRecord(message)) return null;
  const chat = message["chat"];
  if (!isRecord(chat)) return null;
  const chatId = chat["id"];
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) return null;
  return { callbackQueryId: id, chatId, data };
}

type CashParseResult =
  | { ok: true; sellerCode: string; explicitAmount?: number }
  | { ok: false; error: string };

function parseCashCommand(text: string): CashParseResult | null {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? "";
  if (!/^\/cash(@\w+)?$/i.test(command)) {
    return null;
  }
  if (parts.length < 2) {
    return {
      ok: false,
      error:
        "Usage: /cash <seller_code> [<amount>]\n" +
        "Omit amount to use L+M cash-in (column E) from the sheet.",
    };
  }
  const sellerRaw = (parts[1] ?? "").trim();
  if (!/^\d+$/.test(sellerRaw)) {
    return { ok: false, error: "Seller code must be digits only." };
  }
  const sellerCode = normalizeSellerCode(sellerRaw);
  if (parts.length === 2) {
    return { ok: true, sellerCode };
  }
  if (parts.length > 3) {
    return { ok: false, error: "Too many arguments. Use: /cash <seller_code> [<amount>]" };
  }
  const amtRaw = (parts[2] ?? "").trim().replace(/,/g, "");
  const n = parseFloat(amtRaw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Amount is not a valid number." };
  }
  return { ok: true, sellerCode, explicitAmount: n };
}

function buildCashConfirmCallbackData(
  sellerCode: string,
  explicitAmount?: number
): string | null {
  const amountToken =
    explicitAmount === undefined ? "A" : encodeAmountForCallbackToken(explicitAmount);
  const payload = `${CASH_CONFIRM_PREFIX}${sellerCode}|${amountToken}`;
  if (utf8ByteLength(payload) <= TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return payload;
  }
  return null;
}

function parseCashConfirmCallbackData(
  data: string
): { sellerCode: string; explicitAmount?: number } | null {
  const rest = data.slice(CASH_CONFIRM_PREFIX.length);
  const parts = rest.split("|");
  if (parts.length < 2) return null;
  const sellerCode = (parts[0] ?? "").trim();
  if (sellerCode === "" || !/^\d+$/.test(sellerCode)) return null;
  const token = (parts[1] ?? "").trim();
  if (token === "A" || token === "") {
    return { sellerCode };
  }
  const n = parseFloat(token.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return { sellerCode, explicitAmount: n };
}

function encodeAmountForCallbackToken(amount: number): string {
  if (Number.isInteger(amount)) {
    return String(amount);
  }
  return String(amount);
}

function formatCashPreview(p: SellerCashInPreview): string {
  const amtNote = p.amountWasAuto
    ? "Hand-in amount (auto, L column E + M column E)"
    : "Hand-in amount (you entered)";
  return (
    `Cash-in preview — seller ${p.sellerCode}\n\n` +
    `L (column E): ${formatMoney(p.lCashE)}\n` +
    `M (column E): ${formatMoney(p.mCashE)}\n` +
    `${amtNote}: ${formatMoney(p.amountUsed)}\n` +
    `Current outstanding: ${formatMoney(p.currentOutstanding)}\n` +
    `New outstanding after cash-in: ${formatMoney(p.newOutstanding)}\n\n` +
    `Sales_Log rows to mark cashed: ${p.salesLogRowsToUpdate}\n` +
    `Square_payments rows to delete: ${p.squareRowsPrimary}\n` +
    `M Square_payments rows to delete: ${p.squareRowsM}\n\n` +
    `Tap Confirm to apply these changes to the sheet, or Cancel.`
  );
}

function formatCashApplySuccess(r: SellerCashInApplyResult): string {
  const outMsg = r.outstandingRowDeleted
    ? "Outstanding row removed (balance cleared)."
    : `New outstanding: ${formatMoney(r.newOutstanding)}.`;
  return (
    `Cash-in complete — seller ${r.sellerCode}\n\n` +
    `Amount applied: ${formatMoney(r.amountUsed)}\n` +
    `${outMsg}\n` +
    `Sales_Log rows marked cashed: ${r.salesLogRowsUpdated}\n` +
    `Square_payments deleted: ${r.squareRowsDeletedPrimary}\n` +
    `M Square_payments deleted: ${r.squareRowsDeletedM}`
  );
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function extractMessageChatAndText(
  body: unknown
): { chatId: number; text: string } | null {
  if (!isRecord(body)) return null;
  const message = body["message"];
  if (!isRecord(message)) return null;
  const chat = message["chat"];
  if (!isRecord(chat)) return null;
  const id = chat["id"];
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  const text = message["text"];
  if (typeof text !== "string") return null;
  return { chatId: id, text };
}

function isHelpCommand(text: string): boolean {
  const trimmed = text.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  return /^\/help(@\w+)?$/i.test(firstToken);
}

function parseBalanceCommand(text: string): { sellerCode: string | null } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? "";
  if (!/^\/balance(@\w+)?$/i.test(command)) {
    return null;
  }
  const sellerRaw = (parts[1] ?? "").trim();
  if (sellerRaw === "") {
    return { sellerCode: null };
  }
  if (!/^\d+$/.test(sellerRaw)) {
    return { sellerCode: null };
  }
  return { sellerCode: normalizeSellerCode(sellerRaw) };
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatSingleSellerBalanceHtml(input: {
  sellerCode: string;
  email: string;
  l: number;
  m: number;
  outstanding: number;
}): string {
  const { sellerCode, email, l, m, outstanding } = input;
  const total = l + m + outstanding;
  const title = `${sellerCode} | ${email || "-"}`;
  const widths = computeBalanceGridWidths([{ l, m, outstanding, total }]);
  return `CASH IN 💰\n\n${formatSellerCashSectionHtml({
    title,
    l,
    m,
    outstanding,
    total,
    widths,
  })}`;
}

function formatAllBalancesHtml(
  rows: SellerCashInRow[],
  outstandingBySeller: Map<string, number>,
  emailBySeller: Map<string, string>
): string {
  const bySeller = new Map<
    string,
    { l: number; m: number; outstanding: number; total: number }
  >();
  for (const row of rows) {
    const code = normalizeSellerCode(row.sellerId);
    if (code === "") continue;
    const l = row.l.sumE;
    const m = row.m.sumE;
    const outstanding = outstandingBySeller.get(code) ?? 0;
    const total = l + m + outstanding;
    bySeller.set(code, {
      l,
      m,
      total,
      outstanding,
    });
  }
  for (const [code, outstanding] of outstandingBySeller.entries()) {
    if (code === "" || bySeller.has(code)) continue;
    bySeller.set(code, { l: 0, m: 0, total: outstanding, outstanding });
  }

  const items = [...bySeller.entries()]
    .map(([code, v]) => ({
      code,
      shortCode: truncateSellerCode(code),
      email: emailBySeller.get(code) ?? "",
      l: v.l,
      m: v.m,
      total: v.total,
      outstanding: v.outstanding,
    }))
    .sort((a, b) => b.total - a.total);

  if (items.length === 0) {
    return "No sellers with valid seller codes were found.";
  }

  const widths = computeBalanceGridWidths(
    items.map((item) => ({
      l: item.l,
      m: item.m,
      outstanding: item.outstanding,
      total: item.total,
    })),
  );

  const sections = items.map((item) => {
    const title = `${item.shortCode} | ${item.email || "-"}`;
    return formatSellerCashSectionHtml({
      title,
      l: item.l,
      m: item.m,
      outstanding: item.outstanding,
      total: item.total,
      widths,
    });
  });

  return `CASH IN 💰\n\n${sections.join("\n\n")}`;
}

function truncateSellerCode(normalizedSellerCode: string): string {
  return normalizedSellerCode.slice(0, 4).padEnd(4, " ");
}

function normalizeSellerCode(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function formatSellerCashSectionHtml(input: {
  title: string;
  l: number;
  m: number;
  outstanding: number;
  total: number;
  widths: {
    l: number;
    m: number;
    outstanding: number;
    total: number;
  };
}): string {
  const header =
    `${"L 🎤".padStart(input.widths.l, " ")} | ` +
    `${"M 👑".padStart(input.widths.m, " ")} | ` +
    `${"Out ⚠️".padStart(input.widths.outstanding, " ")} | ` +
    `${"TOTAL ✅".padStart(input.widths.total, " ")}`;
  const values =
    `${formatMoney(input.l).padStart(input.widths.l, " ")} | ` +
    `${formatMoney(input.m).padStart(input.widths.m, " ")} | ` +
    `${formatMoney(input.outstanding).padStart(input.widths.outstanding, " ")} | ` +
    `${formatMoney(input.total).padStart(input.widths.total, " ")}`;

  return (
    `<u>${escapeHtml(input.title)}</u>\n` +
    `<pre>${escapeHtml(header)}\n${escapeHtml(values)}</pre>`
  );
}

function computeBalanceGridWidths(
  rows: Array<{ l: number; m: number; outstanding: number; total: number }>,
): { l: number; m: number; outstanding: number; total: number } {
  return {
    l: Math.max("L 🎤".length, ...rows.map((row) => formatMoney(row.l).length)),
    m: Math.max("M 👑".length, ...rows.map((row) => formatMoney(row.m).length)),
    outstanding: Math.max(
      "Out ⚠️".length,
      ...rows.map((row) => formatMoney(row.outstanding).length),
    ),
    total: Math.max(
      "TOTAL ✅".length,
      ...rows.map((row) => formatMoney(row.total).length),
    ),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function telegramAnswerCallbackQuery(
  token: string,
  payload: { callback_query_id: string; text?: string }
): Promise<void> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    token
  )}/answerCallbackQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(
      "[TelegramWebhook] answerCallbackQuery failed",
      JSON.stringify({ status: res.status, body: errText.slice(0, 500) })
    );
  }
}

async function telegramSendMessage(
  token: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const maxAttempts = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt < maxAttempts) {
    attempt += 1;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      return;
    }

    let retryAfterSec = 0;
    try {
      const j = (await res.json()) as {
        parameters?: { retry_after?: number };
        description?: string;
      };
      lastErr = j.description ?? res.statusText;
      retryAfterSec = j.parameters?.retry_after ?? 0;
    } catch {
      lastErr = await res.text();
    }

    if (res.status === 429 && retryAfterSec > 0 && attempt < maxAttempts) {
      await sleep(Math.min(10_000, retryAfterSec * 1000 + 200));
      continue;
    }

    console.error(
      "[TelegramWebhook] sendMessage failed",
      JSON.stringify({
        status: res.status,
        body: String(lastErr).slice(0, 500),
        attempt,
      })
    );
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
