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
import type { SellerCashInRow } from "../sheets/sheets.service";
import { SheetsService } from "../sheets/sheets.service";

const HELP_REPLY =
  "This will display a list of commands.";

/** Telegram sends this when setWebhook included secret_token (name is case-insensitive). */
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Prefix for cash-in breakdown callback_data (seller id follows first `|`). */
const CASH_IN_CALLBACK_PREFIX = "ci|";

/** Telegram Bot API: callback_data max length (UTF-8 bytes). */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

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
      await this.handleCashInCallback(token, callback);
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

    if (isAllCommand(text)) {
      await this.handleAllCommand(token, chatId);
      return { ok: true };
    }

    return { ok: true };
  }

  private async handleAllCommand(
    token: string,
    chatId: number
  ): Promise<void> {
    let rows: SellerCashInRow[];
    try {
      rows = await this.sheetsService.getAllSellersCashInFromSheets();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading sheets.";
      console.error("[TelegramWebhook] /all sheets error", msg);
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: `Could not load cash-in data.\n${msg}`,
      });
      return;
    }

    if (rows.length === 0) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: "No sellers found on the L/M cash-in tabs.",
      });
      return;
    }

    rows.sort((a, b) => b.finalTotal - a.finalTotal);

    for (const row of rows) {
      const summary = formatSellerSummary(row);
      const cb = buildCashInCallbackData(row.sellerId);
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: summary,
      };
      if (cb.callbackData != null) {
        payload.reply_markup = {
          inline_keyboard: [
            [{ text: "Full breakdown", callback_data: cb.callbackData }],
          ],
        };
      } else {
        payload.text =
          summary +
          "\n\n(Breakdown button unavailable: seller id is too long for Telegram.)";
      }
      await telegramSendMessage(token, payload);
    }
  }

  private async handleCashInCallback(
    token: string,
    callback: CallbackQueryExtract
  ): Promise<void> {
    await telegramAnswerCallbackQuery(token, {
      callback_query_id: callback.callbackQueryId,
    });

    if (!callback.data.startsWith(CASH_IN_CALLBACK_PREFIX)) {
      return;
    }
    const sellerId = callback.data.slice(CASH_IN_CALLBACK_PREFIX.length);
    if (sellerId.trim() === "") {
      return;
    }

    let rows: SellerCashInRow[];
    try {
      rows = await this.sheetsService.getAllSellersCashInFromSheets();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading sheets.";
      console.error("[TelegramWebhook] callback sheets error", msg);
      await telegramSendMessage(token, {
        chat_id: callback.chatId,
        text: `Could not load breakdown.\n${msg}`,
      });
      return;
    }

    const row = rows.find((r) => r.sellerId === sellerId);
    if (row == null) {
      await telegramSendMessage(token, {
        chat_id: callback.chatId,
        text: `Seller "${sellerId}" was not found on the cash-in tabs.`,
      });
      return;
    }

    await telegramSendMessage(token, {
      chat_id: callback.chatId,
      text: formatSellerBreakdown(row),
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

function isAllCommand(text: string): boolean {
  const trimmed = text.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  return /^\/all(@\w+)?$/i.test(firstToken);
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSellerSummary(row: SellerCashInRow): string {
  return (
    `Cash in — ${row.sellerId}\n\n` +
    `L cash in (🍻): ${formatMoney(row.l.cashIn)}\n` +
    `M cash in (👑): ${formatMoney(row.m.cashIn)}\n` +
    `Final total (L + M): ${formatMoney(row.finalTotal)}`
  );
}

function formatSellerBreakdown(row: SellerCashInRow): string {
  return (
    `Seller: ${row.sellerId}\n` +
    `Final cash in (L + M): ${formatMoney(row.finalTotal)}\n\n` +
    `L cash in 🍻\n` +
    `Hand in total (sum C): ${formatMoney(row.l.sumC)}\n` +
    `Card amount (sum D): ${formatMoney(row.l.sumD)}\n` +
    `Cash in (C − D): ${formatMoney(row.l.cashIn)}\n` +
    `Column E (sheet): ${formatMoney(row.l.sumE)}\n\n` +
    `M cash in 👑\n` +
    `Hand in total (sum C): ${formatMoney(row.m.sumC)}\n` +
    `Card amount (sum D): ${formatMoney(row.m.sumD)}\n` +
    `Cash in (C − D): ${formatMoney(row.m.cashIn)}\n` +
    `Column E (sheet): ${formatMoney(row.m.sumE)}`
  );
}

function buildCashInCallbackData(sellerId: string): {
  callbackData: string | null;
} {
  const payload = `${CASH_IN_CALLBACK_PREFIX}${sellerId}`;
  if (utf8ByteLength(payload) <= TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return { callbackData: payload };
  }
  return { callbackData: null };
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
