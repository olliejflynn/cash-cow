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

    return { ok: true };
  }

  private async handleBalanceCommand(
    token: string,
    chatId: number,
    sellerCode: string | null
  ): Promise<void> {
    let rows: SellerCashInRow[];
    try {
      rows = await this.sheetsService.getAllSellersCashInFromSheets();
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

    if (rows.length === 0) {
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: "No sellers found on the L/M cash-in tabs.",
      });
      return;
    }

    if (sellerCode != null) {
      const row = rows.find((r) => normalizeSellerCode(r.sellerId) === sellerCode);
      if (row == null) {
        await telegramSendMessage(token, {
          chat_id: chatId,
          text: `Seller ${sellerCode} was not found.`,
        });
        return;
      }
      await telegramSendMessage(token, {
        chat_id: chatId,
        text: formatSingleSellerBalance(row),
        parse_mode: "Markdown",
      });
      return;
    }

    const table = formatAllBalancesTable(rows);
    await telegramSendMessage(token, {
      chat_id: chatId,
      text: table,
    });
  }
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
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSingleSellerBalance(row: SellerCashInRow): string {
  const l = row.l.sumE;
  const m = row.m.sumE;
  const total = l + m;
  return (
    `L: ${formatMoney(l)}\n` +
    `M: ${formatMoney(m)}\n\n` +
    `Total: *${formatMoney(total)}*`
  );
}

function formatAllBalancesTable(rows: SellerCashInRow[]): string {
  const items = rows
    .map((row) => {
      const normalizedCode = normalizeSellerCode(row.sellerId);
      const total = row.l.sumE + row.m.sumE;
      return { normalizedCode, total };
    })
    .filter((item) => item.normalizedCode !== "")
    .map((item) => ({
      code: truncateSellerCode(item.normalizedCode),
      total: item.total,
    }))
    .sort((a, b) => b.total - a.total);

  if (items.length === 0) {
    return "No sellers with valid seller codes were found.";
  }

  const codeWidth = 4;
  const amountWidth = Math.max(
    5,
    ...items.map((item) => formatMoney(item.total).length),
    "Total".length
  );

  const lines = [
    `${"Code".padEnd(codeWidth, " ")}  ${"Total".padStart(amountWidth, " ")}`,
    `${"-".repeat(codeWidth)}  ${"-".repeat(amountWidth)}`,
  ];
  for (const item of items) {
    lines.push(
      `${item.code.padEnd(codeWidth, " ")}  ${formatMoney(item.total).padStart(amountWidth, " ")}`
    );
  }
  return lines.join("\n");
}

function truncateSellerCode(normalizedSellerCode: string): string {
  return normalizedSellerCode.slice(0, 4).padEnd(4, " ");
}

function normalizeSellerCode(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
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
