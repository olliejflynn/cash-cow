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
  CashInTabAggregate,
  SellerBreakdownResult,
  SellerCashInApplyResult,
  SellerCashInPreview,
  SellerCashInRow,
  SellerEmailRow,
  SellerOutstandingRow,
  SellerUncashedSaleBreakdownRow,
} from "../sheets/sheets.service";
import { SheetsService } from "../sheets/sheets.service";
import { SquareOAuthService } from "../square-oauth/square-oauth.service";

/** HTML body for /help (parse_mode HTML). */
function formatHelpMessageHtml(): string {
  return (
    `<b>📒 Cash Cow — commands</b>\n\n` +
    `<b>💰 /balance</b> <code>[seller_code]</code>\n` +
    `<i>Overview of cash-in (L · M · B) and outstanding per seller. Omit the code to list everyone.</i>\n\n` +
    `<b>💷 /cash</b> <code>&lt;seller_code&gt;</code> <code>[amount]</code>\n` +
    `<i>Record a cash-in: marks every Sales_Log row for that seller as cashed, updates Outstanding, and clears matching Square rows when applicable. Without an amount, settlement = L+M+B cash-in plus full outstanding.</i>\n\n` +
    `<b>📊 /breakdown</b> <code>&lt;seller_code&gt;</code>\n` +
    `<i>Uncashed sales detail, commissions, hand-in vs cards, and location.</i>\n\n` +
    `<b>🔄 /updatesquareids</b>\n` +
    `<i>Refresh the Square Team sheet (Email, TH, M) from both Square accounts.</i>\n\n` +
    `<b>❔ /help</b>\n` +
    `<i>Show this message.</i>`
  );
}

/** Telegram sends this when setWebhook included secret_token (name is case-insensitive). */
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Confirm cash-in: `cfy|<sellerDigits>|<amountToken>` — amountToken `A` = auto (L+M from sheet). */
const CASH_CONFIRM_PREFIX = "cfy|";
/** Cancel pending cash-in (no payload). */
const CASH_CANCEL_DATA = "cfn";
/** Telegram Bot API: callback_data max length (UTF-8 bytes). */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const seenCashCallbackIds = new Set<string>();

/** `${chatId}:${messageId}` — preview cancelled; Confirm must not apply (backup if UI race). */
const cancelledCashPreviewMessageKeys = new Set<string>();

@Controller("telegram")
export class TelegramWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly sheetsService: SheetsService,
    private readonly squareOAuthService: SquareOAuthService
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
        text: formatHelpMessageHtml(),
        parse_mode: "HTML",
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
          text: formatCashCommandUsageHtml(cashParsed.error),
          parse_mode: "HTML",
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

    const breakdownParsed = parseBreakdownCommand(text);
    if (breakdownParsed != null) {
      if (!breakdownParsed.ok) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: formatBreakdownUsageHtml(breakdownParsed.error),
          parse_mode: "HTML",
        });
        return { ok: true };
      }
      await this.handleBreakdownCommand(
        token,
        chatId,
        breakdownParsed.sellerCode
      );
      return { ok: true };
    }

    const updateSquareIdsParsed = parseUpdateSquareIdsCommand(text);
    if (updateSquareIdsParsed != null) {
      if (!updateSquareIdsParsed.ok) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: formatUpdateSquareIdsUsageHtml(updateSquareIdsParsed.error),
          parse_mode: "HTML",
        });
        return { ok: true };
      }
      await this.handleUpdateSquareIdsCommand(token, chatId);
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
      const previewKey = `${callback.chatId}:${callback.messageId}`;
      cancelledCashPreviewMessageKeys.add(previewKey);
      await telegramCancelCashPreviewMessage(token, callback);
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
        text: "✓ Preview cancelled — buttons removed",
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
        text: "✓ Already processed",
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
        text: "⚠ Invalid confirmation",
      });
      return;
    }

    const previewKey = `${callback.chatId}:${callback.messageId}`;
    if (cancelledCashPreviewMessageKeys.has(previewKey)) {
      cancelledCashPreviewMessageKeys.delete(previewKey);
      await telegramAnswerCallbackQuery(token, {
        callback_query_id: callback.callbackQueryId,
        text: "This preview was cancelled — run /cash again.",
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
        text: formatCashApplyErrorHtml(msg),
        parse_mode: "HTML",
      });
      return;
    }

    await telegramSendMessage(token, {
      chat_id: callback.chatId,
      text: formatCashApplySuccessHtml(result),
      parse_mode: "HTML",
    });

    await telegramRemoveInlineKeyboardFromMessage(
      token,
      callback.chatId,
      callback.messageId
    );
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
        text: formatCashPreviewErrorHtml(msg),
        parse_mode: "HTML",
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
        text: formatCashConfirmPayloadTooLongHtml(),
        parse_mode: "HTML",
      });
      return;
    }

    await telegramSendMessage(token, {
      chat_id: chatId,
      text: formatCashPreviewHtml(preview),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm cash-in", callback_data: confirmData },
            { text: "❌ Cancel", callback_data: CASH_CANCEL_DATA },
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
        text: formatBalanceLoadErrorHtml(msg),
        parse_mode: "HTML",
      });
      return;
    }

    const outstandingBySeller = new Map<
      string,
      {
        outstandingL: number;
        outstandingM: number;
        outstandingB: number;
        outstanding: number;
      }
    >(
      outstandingRows.map((r) => [
        r.sellerCode,
        {
          outstandingL: r.outstandingL,
          outstandingM: r.outstandingM,
          outstandingB: r.outstandingB,
          outstanding: r.outstanding,
        },
      ])
    );
    const emailBySeller = new Map<string, string>(
      emailRows.map((r) => [r.sellerCode, r.email])
    );

    if (rows.length === 0 && outstandingBySeller.size === 0) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatBalanceEmptyHtml(),
        parse_mode: "HTML",
      });
      return;
    }

    if (sellerCode != null) {
      const row = rows.find(
        (r) => normalizeSellerCode(r.sellerId) === sellerCode
      );
      const outstanding = outstandingBySeller.get(sellerCode) ?? {
        outstandingL: 0,
        outstandingM: 0,
        outstandingB: 0,
        outstanding: 0,
      };
      if (row == null && outstanding.outstanding === 0) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: formatSellerNotFoundHtml(sellerCode),
          parse_mode: "HTML",
        });
        return;
      }
      const lBreakdown: CashInTabAggregate = row?.l ?? {
        sumCollected: 0,
        sumC: 0,
        sumCommission: 0,
        sumD: 0,
        sumE: 0,
        cashIn: 0,
      };
      const mBreakdown: CashInTabAggregate = row?.m ?? {
        sumCollected: 0,
        sumC: 0,
        sumCommission: 0,
        sumD: 0,
        sumE: 0,
        cashIn: 0,
      };
      const bBreakdown: CashInTabAggregate = row?.b ?? {
        sumCollected: 0,
        sumC: 0,
        sumCommission: 0,
        sumD: 0,
        sumE: 0,
        cashIn: 0,
      };
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatSingleSellerBalanceHtml({
          sellerCode,
          email: emailBySeller.get(sellerCode) ?? "",
          l: lBreakdown,
          m: mBreakdown,
          b: bBreakdown,
          outstandingL: outstanding.outstandingL,
          outstandingM: outstanding.outstandingM,
          outstandingB: outstanding.outstandingB,
        }),
        parse_mode: "HTML",
      });
      return;
    }

    const table = formatAllBalancesHtml(
      rows,
      outstandingBySeller,
      emailBySeller
    );
    await telegramSendMessage(token, {
      chat_id: chatId,
      text: table,
      parse_mode: "HTML",
    });
  }

  private async handleBreakdownCommand(
    token: string,
    chatId: number,
    sellerCode: string
  ): Promise<void> {
    let breakdown: SellerBreakdownResult;
    try {
      breakdown = await this.sheetsService.getSellerBreakdownFromSheets(
        sellerCode
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading breakdown.";
      console.error("[TelegramWebhook] /breakdown sheets error", msg);
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatBreakdownLoadErrorHtml(msg),
        parse_mode: "HTML",
      });
      return;
    }

    const messages = formatBreakdownMessages(breakdown);
    for (const text of messages) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      });
    }
  }

  private async handleUpdateSquareIdsCommand(
    token: string,
    chatId: number
  ): Promise<void> {
    let result: Awaited<
      ReturnType<SquareOAuthService["syncSquareTeamSheetToSpreadsheet"]>
    >;
    try {
      result = await this.squareOAuthService.syncSquareTeamSheetToSpreadsheet();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error syncing Square team ids.";
      console.error("[TelegramWebhook] /updatesquareids error", msg);
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatUpdateSquareIdsErrorHtml(msg),
        parse_mode: "HTML",
      });
      return;
    }

    const messages = formatUpdateSquareIdsSuccessMessages(result);
    for (const text of messages) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      });
    }
  }
}

type CallbackQueryExtract = {
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  /** Present when the callback is from a text message (cash previews). */
  messageText?: string;
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
  const messageIdRaw = message["message_id"];
  if (
    typeof messageIdRaw !== "number" ||
    !Number.isFinite(messageIdRaw)
  ) {
    return null;
  }
  const messageTextRaw = message["text"];
  const messageText =
    typeof messageTextRaw === "string" ? messageTextRaw : undefined;
  return {
    callbackQueryId: id,
    chatId,
    messageId: messageIdRaw,
    messageText,
    data,
  };
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
        "Provide a seller code (digits only).\n" +
        "• Omit the amount → full settlement: L+M+B cash-in plus outstanding; every Sales_Log row for that seller is marked cashed.\n" +
        "• Or add an amount for a custom hand-in.",
    };
  }
  const sellerRaw = (parts[1] ?? "").trim();
  if (!/^\d+$/.test(sellerRaw)) {
    return {
      ok: false,
      error: "Seller code must contain digits only (no letters or spaces).",
    };
  }
  const sellerCode = normalizeSellerCode(sellerRaw);
  if (parts.length === 2) {
    return { ok: true, sellerCode };
  }
  if (parts.length > 3) {
    return {
      ok: false,
      error: "Too many arguments. Use /cash <seller_code> or /cash <seller_code> <amount>.",
    };
  }
  const amtRaw = (parts[2] ?? "").trim().replace(/,/g, "");
  const n = parseFloat(amtRaw);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: "Amount must be a valid number (commas allowed).",
    };
  }
  return { ok: true, sellerCode, explicitAmount: n };
}

type BreakdownParseResult =
  | { ok: true; sellerCode: string }
  | { ok: false; error: string };

function parseBreakdownCommand(text: string): BreakdownParseResult | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? "";
  if (!/^\/breakdown(@\w+)?$/i.test(command)) {
    return null;
  }
  if (parts.length !== 2) {
    return {
      ok: false,
      error: "Use /breakdown <seller_code> (seller code = digits only).",
    };
  }
  const sellerRaw = (parts[1] ?? "").trim();
  if (!/^\d+$/.test(sellerRaw)) {
    return {
      ok: false,
      error: "Seller code must contain digits only.",
    };
  }
  return { ok: true, sellerCode: normalizeSellerCode(sellerRaw) };
}

type UpdateSquareIdsParseResult = { ok: true } | { ok: false; error: string };

function parseUpdateSquareIdsCommand(
  text: string
): UpdateSquareIdsParseResult | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? "";
  if (!/^\/updatesquareids(@\w+)?$/i.test(command)) {
    return null;
  }
  if (parts.length > 1) {
    return {
      ok: false,
      error: "This command takes no arguments. Send /updatesquareids only.",
    };
  }
  return { ok: true };
}

function buildCashConfirmCallbackData(
  sellerCode: string,
  explicitAmount?: number
): string | null {
  const amountToken =
    explicitAmount === undefined
      ? "A"
      : encodeAmountForCallbackToken(explicitAmount);
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

function formatCashPreviewHtml(p: SellerCashInPreview): string {
  const settlementNote = p.amountWasAuto
    ? "<i>Full settlement — L+M+B cash-in (column E) plus current outstanding total.</i>"
    : "<i>Custom amount — you entered this hand-in.</i>";
  const outstandingBefore =
    p.currentOutstanding === 0
      ? "<i>No outstanding balance on file.</i>"
      : `L ${formatMoney(p.currentOutstandingL)} · M ${formatMoney(
          p.currentOutstandingM
        )} · B ${formatMoney(p.currentOutstandingB)} → <b>${formatMoney(
          p.currentOutstanding
        )}</b> total`;
  const outstandingAfter =
    p.newOutstanding === 0
      ? "<b>✓ Fully settled</b> — Outstanding row will be removed."
      : `After update: L ${formatMoney(p.newOutstandingL)} · M ${formatMoney(
          p.newOutstandingM
        )} · B ${formatMoney(p.newOutstandingB)} → <b>${formatMoney(
          p.newOutstanding
        )}</b>`;

  return (
    `<b>💷 Cash-in preview</b>\n` +
    `<code>${escapeHtml(p.sellerCode)}</code>\n\n` +
    `<b>📍 Cash-in tabs</b> <i>(column E)</i>\n` +
    `• L — ${formatMoney(p.lCashE)}\n` +
    `• M — ${formatMoney(p.mCashE)}\n` +
    `• B — ${formatMoney(p.bCashE)}\n\n` +
    `<b>💵 Settlement amount</b>\n` +
    `${formatMoney(p.amountUsed)}\n` +
    `${settlementNote}\n\n` +
    `<b>📋 Outstanding — before</b>\n` +
    `${outstandingBefore}\n\n` +
    `<b>📌 Outstanding — after confirm</b>\n` +
    `${outstandingAfter}\n\n` +
    `<b>📊 Sheet updates</b>\n` +
    `• Sales_Log rows marked cashed: <b>${String(p.salesLogRowsToUpdate)}</b> <i>(all rows for this seller)</i>\n` +
    `• Square (primary) rows removed: <b>${String(p.squareRowsPrimary)}</b>\n` +
    `• Square (M) rows removed: <b>${String(p.squareRowsM)}</b>\n\n` +
    `<i>Tap ✅ Confirm to write to Google Sheets, or ❌ Cancel.</i>`
  );
}

function formatCashApplySuccessHtml(r: SellerCashInApplyResult): string {
  const outstandingBlock = r.outstandingRowDeleted
    ? `<b>✓ Outstanding</b>\n<i>Row removed — balance cleared.</i>`
    : `<b>📌 Outstanding remaining</b>\n` +
      `L ${formatMoney(r.newOutstandingL)} · M ${formatMoney(
        r.newOutstandingM
      )} · B ${formatMoney(r.newOutstandingB)} → <b>${formatMoney(
        r.newOutstanding
      )}</b>`;

  return (
    `<b>✅ Cash-in recorded</b>\n` +
    `<code>${escapeHtml(r.sellerCode)}</code>\n\n` +
    `<b>💵 Amount applied</b>\n${formatMoney(r.amountUsed)}\n\n` +
    `${outstandingBlock}\n\n` +
    `<b>📊 Sheet updates</b>\n` +
    `• Sales_Log rows set to cashed: <b>${String(r.salesLogRowsUpdated)}</b>\n` +
    `• Square (primary) deleted: <b>${String(r.squareRowsDeletedPrimary)}</b>\n` +
    `• Square (M) deleted: <b>${String(r.squareRowsDeletedM)}</b>`
  );
}

function formatCashCommandUsageHtml(errorDetail: string): string {
  return `<b>💷 Cash-in</b>\n\n${escapeHtml(errorDetail)}`;
}

function formatBreakdownUsageHtml(errorDetail: string): string {
  return `<b>📊 Breakdown</b>\n\n${escapeHtml(errorDetail)}`;
}

function formatUpdateSquareIdsUsageHtml(errorDetail: string): string {
  return `<b>🔄 Square Team sync</b>\n\n${escapeHtml(errorDetail)}`;
}

function formatUpdateSquareIdsErrorHtml(detail: string): string {
  return (
    `<b>⚠️ Square Team sync failed</b>\n\n${escapeHtml(detail)}\n\n` +
    `<i>Check Square OAuth tokens for both merchants and spreadsheet access.</i>`
  );
}

function formatUpdateSquareIdsSuccessMessages(result: {
  primaryTeamMembersFetched: number;
  mTeamMembersFetched: number;
  rowsWritten: number;
  withTh: number;
  withM: number;
  withBoth: number;
  insertedRows: Array<{ email: string; th: string; m: string }>;
  primaryFetchError?: string;
  mFetchError?: string;
}): string[] {
  const primaryWarning =
    result.primaryFetchError != null
      ? `\n\n<b>⚠️ Primary account</b>\n<i>${escapeHtml(
          result.primaryFetchError
        )}</i>`
      : "";
  const mWarning =
    result.mFetchError != null
      ? `\n\n<b>⚠️ M account</b>\n<i>${escapeHtml(result.mFetchError)}</i>`
      : "";

  const summary =
    `<b>✅ Square team updated</b>\n\n` +
    `<b>📥 Square team members fetched</b>\n` +
    `• Primary (TH) — <b>${String(result.primaryTeamMembersFetched)}</b>\n` +
    `• M — <b>${String(result.mTeamMembersFetched)}</b>\n\n` +
    `<b>📊 Square Team tab</b>\n` +
    `• Rows on sheet — <b>${String(result.rowsWritten)}</b>\n` +
    `• With TH — <b>${String(result.withTh)}</b>\n` +
    `• With M — <b>${String(result.withM)}</b>\n` +
    `• With both — <b>${String(result.withBoth)}</b>` +
    primaryWarning +
    mWarning;

  if (result.insertedRows.length === 0) {
    return [
      `${summary}\n\n<b>📋 New rows inserted</b>\n<i>No new emails — existing rows were updated only.</i>`,
    ];
  }

  const widths = computeInsertedSquareTeamRowWidths(result.insertedRows);
  const entries = result.insertedRows.map((row) =>
    formatInsertedSquareTeamRow(row, widths)
  );
  const limit = 3800;
  const messages: string[] = [];
  let currentSummary =
    `${summary}\n\n<b>📋 New rows inserted are as follows:</b>\n<i>Email · TH · M</i>\n`;
  let currentBlock = "";
  for (const entry of entries) {
    const nextBlock = `${currentBlock}${entry}\n`;
    const nextMessage = `${currentSummary}<pre>${nextBlock.trimEnd()}</pre>`;
    if (nextMessage.length > limit && currentBlock.trim() !== "") {
      messages.push(`${currentSummary}<pre>${currentBlock.trimEnd()}</pre>`);
      currentSummary =
        `<b>📋 New rows inserted</b> <i>(continued)</i>\n<i>Email · TH · M</i>\n`;
      currentBlock = `${entry}\n`;
      continue;
    }
    currentBlock = nextBlock;
  }
  if (currentBlock.trim() !== "") {
    messages.push(`${currentSummary}<pre>${currentBlock.trimEnd()}</pre>`);
  }
  return messages;
}

function formatSquareTeamIdCell(id: string): string {
  const s = id.trim();
  return s === "" ? "—" : s;
}

function formatInsertedSquareTeamRow(
  row: { email: string; th: string; m: string },
  widths: { email: number; th: number; m: number }
): string {
  const email = row.email.padEnd(widths.email, " ");
  const th = formatSquareTeamIdCell(row.th).padStart(widths.th, " ");
  const m = formatSquareTeamIdCell(row.m).padStart(widths.m, " ");
  return escapeHtml(`${email}  ${th}  ${m}`);
}

function computeInsertedSquareTeamRowWidths(
  rows: Array<{ email: string; th: string; m: string }>
): { email: number; th: number; m: number } {
  return {
    email: Math.max("Email".length, ...rows.map((row) => row.email.length)),
    th: Math.max(
      "TH".length,
      ...rows.map((row) => formatSquareTeamIdCell(row.th).length)
    ),
    m: Math.max(
      "M".length,
      ...rows.map((row) => formatSquareTeamIdCell(row.m).length)
    ),
  };
}

function formatCashApplyErrorHtml(detail: string): string {
  return (
    `<b>⚠️ Cash-in could not be completed</b>\n\n${escapeHtml(detail)}\n\n` +
    `<i>If this persists, check sheet names and bot logs.</i>`
  );
}

function formatCashPreviewErrorHtml(detail: string): string {
  return (
    `<b>⚠️ Preview unavailable</b>\n\n${escapeHtml(detail)}\n\n` +
    `<i>Verify the seller exists on L/M/B cash-in tabs.</i>`
  );
}

function formatCashConfirmPayloadTooLongHtml(): string {
  return (
    `<b>⚠️ Confirm button unavailable</b>\n\n` +
    `<i>Telegram limits button payload size. Try a shorter seller code or a simpler amount, then run /cash again.</i>`
  );
}

function formatBalanceLoadErrorHtml(detail: string): string {
  return (
    `<b>⚠️ Balance unavailable</b>\n\n${escapeHtml(detail)}\n\n` +
    `<i>Check spreadsheet access and GOOGLE_SERVICE_ACCOUNT / SPREADSHEET_ID.</i>`
  );
}

function formatBalanceEmptyHtml(): string {
  return (
    `<b>📭 No balance data</b>\n\n` +
    `<i>No sellers were found on the cash-in or Outstanding tabs yet.</i>`
  );
}

function formatSellerNotFoundHtml(sellerCode: string): string {
  return (
    `<b>🔍 Seller not found</b>\n\n` +
    `<code>${escapeHtml(sellerCode)}</code>\n\n` +
    `<i>There is no cash-in row and no outstanding balance for this code. Check the seller ID or use </i><code>/balance</code><i> without a code to browse everyone.</i>`
  );
}

function formatBreakdownLoadErrorHtml(detail: string): string {
  return (
    `<b>⚠️ Breakdown unavailable</b>\n\n${escapeHtml(detail)}\n\n` +
    `<i>Confirm SALES_LOG_SHEET_NAME and Ticket_rules are reachable.</i>`
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

function parseBalanceCommand(
  text: string
): { sellerCode: string | null } | null {
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

/** One monospace row: label left-padded column + gap + right-aligned amount. */
function formatBalanceLabelAmountLine(
  label: string,
  amountFormatted: string,
  labelColumnWidth: number,
  amountColumnWidth: number
): string {
  return `${label.padEnd(labelColumnWidth, " ")}  ${amountFormatted.padStart(
    amountColumnWidth,
    " "
  )}`;
}

function formatSingleSellerBalanceHtml(input: {
  sellerCode: string;
  email: string;
  l: CashInTabAggregate;
  m: CashInTabAggregate;
  b: CashInTabAggregate;
  outstandingL: number;
  outstandingM: number;
  outstandingB: number;
}): string {
  const { sellerCode, email, l, m, b, outstandingL, outstandingM, outstandingB } =
    input;
  const grandTotal =
    b.sumE + m.sumE + l.sumE + outstandingL + outstandingM + outstandingB;

  type RowDef = { label: string; value: number };
  const mRows: RowDef[] = [
    { label: "Collected", value: m.sumCollected },
    { label: "Hand in", value: m.sumC },
    { label: "Commission", value: m.sumCommission },
    { label: "Card", value: m.sumD },
    { label: "Cash in (E)", value: m.sumE },
    { label: "Outstanding M", value: outstandingM },
  ];
  const lRows: RowDef[] = [
    { label: "Collected", value: l.sumCollected },
    { label: "Hand in", value: l.sumC },
    { label: "Commission", value: l.sumCommission },
    { label: "Card", value: l.sumD },
    { label: "Cash in (E)", value: l.sumE },
    { label: "Outstanding L", value: outstandingL },
  ];
  const bRows: RowDef[] = [
    { label: "Collected", value: b.sumCollected },
    { label: "Hand in", value: b.sumC },
    { label: "Commission", value: b.sumCommission },
    { label: "Card", value: b.sumD },
    { label: "Cash in (E)", value: b.sumE },
    { label: "Outstanding B", value: outstandingB },
  ];
  const allRows = [...mRows, ...lRows, ...bRows];
  const totalLabel = "◆ GRAND TOTAL";
  const labelColumnWidth = Math.max(
    totalLabel.length,
    ...allRows.map((r) => r.label.length)
  );
  const amountStrings = [
    ...allRows.map((r) => formatMoney(r.value)),
    formatMoney(grandTotal),
  ];
  const amountColumnWidth = Math.max(
    ...amountStrings.map((s) => s.length),
    1
  );

  const lines: string[] = [];
  const pushSection = (heading: string, rows: RowDef[]): void => {
    lines.push(heading);
    for (const row of rows) {
      lines.push(
        formatBalanceLabelAmountLine(
          row.label,
          formatMoney(row.value),
          labelColumnWidth,
          amountColumnWidth
        )
      );
    }
  };

  pushSection("━━ M SHEET ━━", mRows);
  lines.push("");
  pushSection("━━ L SHEET ━━", lRows);
  lines.push("");
  pushSection("━━ B SHEET ━━", bRows);
  lines.push("");
  lines.push(
    formatBalanceLabelAmountLine(
      totalLabel,
      formatMoney(grandTotal),
      labelColumnWidth,
      amountColumnWidth
    )
  );

  const headline =
    `<b>💰 Seller balance</b>\n` +
    `<code>${escapeHtml(sellerCode)}</code>` +
    (email.trim() !== ""
      ? `\n📧 <code>${escapeHtml(email)}</code>`
      : `\n<i>No email on Users sheet</i>`) +
    `\n\n`;

  return `${headline}<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function formatAllBalancesHtml(
  rows: SellerCashInRow[],
  outstandingBySeller: Map<
    string,
    {
      outstandingL: number;
      outstandingM: number;
      outstandingB: number;
      outstanding: number;
    }
  >,
  emailBySeller: Map<string, string>
): string {
  const bySeller = new Map<
    string,
    { l: number; m: number; b: number; outstanding: number; total: number }
  >();
  for (const row of rows) {
    const code = normalizeSellerCode(row.sellerId);
    if (code === "") continue;
    const l = row.l.sumE;
    const m = row.m.sumE;
    const b = row.b.sumE;
    const outstanding = outstandingBySeller.get(code)?.outstanding ?? 0;
    const total = l + m + b + outstanding;
    bySeller.set(code, {
      l,
      m,
      b,
      total,
      outstanding,
    });
  }
  for (const [code, outstanding] of outstandingBySeller.entries()) {
    if (code === "" || bySeller.has(code)) continue;
    bySeller.set(code, {
      l: 0,
      m: 0,
      b: 0,
      total: outstanding.outstanding,
      outstanding: outstanding.outstanding,
    });
  }

  const items = [...bySeller.entries()]
    .map(([code, v]) => ({
      code,
      shortCode: truncateSellerCode(code),
      email: emailBySeller.get(code) ?? "",
      l: v.l,
      m: v.m,
      b: v.b,
      total: v.total,
      outstanding: v.outstanding,
    }))
    .sort((a, b) => b.total - a.total);

  if (items.length === 0) {
    return (
      `<b>📭 No sellers listed</b>\n\n` +
      `<i>No rows with a valid seller code were found on the cash-in tabs.</i>`
    );
  }

  const widths = computeBalanceGridWidths(
    items.map((item) => ({
      l: item.l,
      m: item.m,
      b: item.b,
      outstanding: item.outstanding,
      total: item.total,
    }))
  );

  const sections = items.map((item) => {
    const title = `${item.shortCode} | ${item.email || "-"}`;
    return formatSellerCashSectionHtml({
      title,
      l: item.l,
      m: item.m,
      b: item.b,
      outstanding: item.outstanding,
      total: item.total,
      widths,
    });
  });

  return (
    `<b>💰 Cash-in overview</b>\n` +
    `<i>Per seller · £ cash-in E · L / M / B · outstanding · total</i>\n\n` +
    `${sections.join("\n\n")}`
  );
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
  b: number;
  outstanding: number;
  total: number;
  widths: {
    l: number;
    m: number;
    b: number;
    outstanding: number;
    total: number;
  };
}): string {
  const header =
    `${"L".padStart(input.widths.l, " ")} | ` +
    `${"M".padStart(input.widths.m, " ")} | ` +
    `${"B".padStart(input.widths.b, " ")} | ` +
    `${"OUT".padStart(input.widths.outstanding, " ")} | ` +
    `${"TOTAL".padStart(input.widths.total, " ")}`;
  const values =
    `${formatMoney(input.l).padStart(input.widths.l, " ")} | ` +
    `${formatMoney(input.m).padStart(input.widths.m, " ")} | ` +
    `${formatMoney(input.b).padStart(input.widths.b, " ")} | ` +
    `${formatMoney(input.outstanding).padStart(
      input.widths.outstanding,
      " "
    )} | ` +
    `${formatMoney(input.total).padStart(input.widths.total, " ")}`;

  return (
    `<b>👤</b> <u>${escapeHtml(input.title)}</u>\n` +
    `<pre>${escapeHtml(header)}\n${escapeHtml(values)}</pre>`
  );
}

function computeBalanceGridWidths(
  rows: Array<{ l: number; m: number; b: number; outstanding: number; total: number }>
): { l: number; m: number; b: number; outstanding: number; total: number } {
  return {
    l: Math.max("L".length, ...rows.map((row) => formatMoney(row.l).length)),
    m: Math.max("M".length, ...rows.map((row) => formatMoney(row.m).length)),
    b: Math.max("B".length, ...rows.map((row) => formatMoney(row.b).length)),
    outstanding: Math.max(
      "OUT".length,
      ...rows.map((row) => formatMoney(row.outstanding).length)
    ),
    total: Math.max(
      "TOTAL".length,
      ...rows.map((row) => formatMoney(row.total).length)
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

function formatBreakdownSummaryHtml(breakdown: SellerBreakdownResult): string {
  const sc = escapeHtml(breakdown.sellerCode);
  return (
    `<b>📊 Sales breakdown</b>\n<code>${sc}</code>\n\n` +
    `<b>📈 Uncashed sales</b>\n` +
    `• Count — <b>${String(breakdown.saleCount)}</b>\n` +
    `• Gross — <b>${formatMoneyCompact(breakdown.totalGross)}</b>\n` +
    `• Commission — <b>${formatMoneyCompact(breakdown.totalCommission)}</b>\n` +
    `• Hand-in (sheet L/M/B) — ${formatMoneyCompact(
      breakdown.handInSheetL
    )} / ${formatMoneyCompact(breakdown.handInSheetM)} / ${formatMoneyCompact(
      breakdown.handInSheetB
    )}\n` +
    `• Hand-in total — <b>${formatMoneyCompact(breakdown.handInSheetTotal)}</b>\n\n` +
    `<b>🏷 Cash-in tabs</b>\n` +
    `• L — ${formatMoneyCompact(breakdown.cashInSheetL)}\n` +
    `• M — ${formatMoneyCompact(breakdown.cashInSheetM)}\n` +
    `• B — ${formatMoneyCompact(breakdown.cashInSheetB)}\n` +
    `• Sum — <b>${formatMoneyCompact(breakdown.cashInSheetTotal)}</b>\n\n` +
    `<b>💳 Card payments (Square)</b>\n` +
    `• Primary — ${formatMoneyCompact(breakdown.cardTotalPrimary)}\n` +
    `• M tab — ${formatMoneyCompact(breakdown.cardTotalM)}\n` +
    `• Combined — <b>${formatMoneyCompact(breakdown.cardTotalCombined)}</b>\n\n` +
    `<b>📌 Outstanding</b>\n` +
    `• L — ${formatMoneyCompact(breakdown.outstandingL)}\n` +
    `• M — ${formatMoneyCompact(breakdown.outstandingM)}\n` +
    `• B — ${formatMoneyCompact(breakdown.outstandingB)}\n` +
    `• Total — <b>${formatMoneyCompact(breakdown.outstandingTotal)}</b>\n\n` +
    `<b>💵 CASH IN view</b> <i>(tabs + outstanding)</i>\n` +
    `<b>${formatMoneyCompact(breakdown.cashInIncludingOutstanding)}</b>`
  );
}

function formatBreakdownMessages(breakdown: SellerBreakdownResult): string[] {
  const summaryBlock = formatBreakdownSummaryHtml(breakdown);

  if (breakdown.sales.length === 0) {
    return [
      `${summaryBlock}\n\n<b>📋 All sales</b>\n<i>Price · commission · hand-in · location</i>\n<pre>${escapeHtml(
        "No uncashed sales found for this seller."
      )}</pre>`,
    ];
  }

  const widths = computeBreakdownSaleWidths(breakdown.sales);
  const entries = breakdown.sales.map((sale) =>
    formatBreakdownSaleEntry(sale, widths)
  );
  const limit = 3800;
  const messages: string[] = [];
  let currentSummary = `${summaryBlock}\n\n<b>📋 All sales</b>\n<i>Order · qty · ticket · amounts · LOC</i>\n`;
  let currentBlock = "";
  for (const entry of entries) {
    const nextBlock = `${currentBlock}${entry}\n`;
    const nextMessage = `${currentSummary}<pre>${nextBlock.trimEnd()}</pre>`;
    if (nextMessage.length > limit && currentBlock.trim() !== "") {
      messages.push(`${currentSummary}<pre>${currentBlock.trimEnd()}</pre>`);
      currentSummary =
        `<b>📋 All sales</b> <i>(continued)</i>\n<i>Order · qty · ticket · amounts · LOC</i>\n`;
      currentBlock = `${entry}\n`;
      continue;
    }
    currentBlock = nextBlock;
  }
  if (currentBlock.trim() !== "") {
    messages.push(`${currentSummary}<pre>${currentBlock.trimEnd()}</pre>`);
  }
  return messages;
}

function formatBreakdownSaleEntry(
  sale: SellerUncashedSaleBreakdownRow,
  widths: {
    qty: number;
    name: number;
    gross: number;
    commission: number;
    handIn: number;
    location: number;
  }
): string {
  const ticketDisplay =
    sale.ticketDisplayName.trim() === ""
      ? sale.ticketTypeSlug
      : sale.ticketDisplayName;
  const qty = `X${formatNumberCompact(sale.qty)}`.padEnd(widths.qty, " ");
  const name = (ticketDisplay || "-").padEnd(widths.name, " ");
  const orderNumber = String(sale.orderId ?? "").trim() || "-";
  if (sale.isCancelled) {
    return escapeHtml(
      `#${orderNumber}  ${qty} ${name} : CANCELED`
    );
  }
  const gross = formatMoneyCompact(sale.grossAmount).padStart(
    widths.gross,
    " "
  );
  const commission = formatMoneyCompact(sale.grossCommission).padStart(
    widths.commission,
    " "
  );
  const handIn = formatMoneyCompact(sale.handInAmount).padStart(
    widths.handIn,
    " "
  );
  const locRaw = sale.location.trim() === "" ? "N/A" : sale.location.trim();
  const loc = locRaw.padEnd(widths.location, " ");
  const row = `${qty} ${name} : ${gross} | ${commission} | ${handIn} | ${loc}`;
  return escapeHtml(`#${orderNumber}  ${row}`);
}

function computeBreakdownSaleWidths(sales: SellerUncashedSaleBreakdownRow[]): {
  qty: number;
  name: number;
  gross: number;
  commission: number;
  handIn: number;
  location: number;
} {
  const locationLabel = (sale: SellerUncashedSaleBreakdownRow): string => {
    const s = sale.location.trim();
    return s === "" ? "N/A" : s;
  };
  return {
    qty: Math.max(
      2,
      ...sales.map((sale) => `X${formatNumberCompact(sale.qty)}`.length)
    ),
    name: Math.max(
      1,
      ...sales.map(
        (sale) =>
          (sale.ticketDisplayName.trim() === ""
            ? sale.ticketTypeSlug
            : sale.ticketDisplayName || "-"
          ).length
      )
    ),
    gross: Math.max(
      1,
      ...sales.map((sale) => formatMoneyCompact(sale.grossAmount).length)
    ),
    commission: Math.max(
      1,
      ...sales.map((sale) => formatMoneyCompact(sale.grossCommission).length)
    ),
    handIn: Math.max(
      1,
      ...sales.map((sale) => formatMoneyCompact(sale.handInAmount).length)
    ),
    location: Math.max(
      3,
      ...sales
        .filter((sale) => !sale.isCancelled)
        .map((sale) => locationLabel(sale).length)
    ),
  };
}

function formatMoneyCompact(n: number): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatNumberCompact(n: number): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function strikeThroughText(s: string): string {
  const overlay = "\u0336";
  return Array.from(s)
    .map((ch) => `${ch}${overlay}`)
    .join("");
}

/** Strip buttons after successful confirm so the same preview cannot be applied twice. */
async function telegramRemoveInlineKeyboardFromMessage(
  token: string,
  chatId: number,
  messageId: number
): Promise<void> {
  await telegramBotApi(
    token,
    "editMessageReplyMarkup",
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    },
    "[TelegramWebhook] editMessageReplyMarkup (after cash-in success)"
  );
}

/** Remove Confirm/Cancel and show cancellation footer so Confirm cannot be used again. */
async function telegramCancelCashPreviewMessage(
  token: string,
  callback: CallbackQueryExtract
): Promise<void> {
  const emptyKeyboard: { inline_keyboard: unknown[] } = {
    inline_keyboard: [],
  };
  const footer = "\n\n<i>❌ Cancelled — cash-in was not applied.</i>";

  if (callback.messageText !== undefined) {
    let bodyText = `${callback.messageText}${footer}`;
    if (bodyText.length > 4096) {
      const reserve = footer.length + 5;
      bodyText = `${callback.messageText.slice(
        0,
        Math.max(0, 4096 - reserve)
      )}…${footer}`;
    }
    const ok = await telegramBotApi(
      token,
      "editMessageText",
      {
        chat_id: callback.chatId,
        message_id: callback.messageId,
        text: bodyText,
        parse_mode: "HTML",
        reply_markup: emptyKeyboard,
      },
      "[TelegramWebhook] editMessageText (cancel preview)"
    );
    if (ok) return;
  }

  await telegramBotApi(
    token,
    "editMessageReplyMarkup",
    {
      chat_id: callback.chatId,
      message_id: callback.messageId,
      reply_markup: emptyKeyboard,
    },
    "[TelegramWebhook] editMessageReplyMarkup (cancel preview)"
  );
}

async function telegramBotApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  logLabel: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    token
  )}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(
      logLabel,
      JSON.stringify({ status: res.status, body: errText.slice(0, 500) })
    );
    return false;
  }
  return true;
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
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    token
  )}/sendMessage`;
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
