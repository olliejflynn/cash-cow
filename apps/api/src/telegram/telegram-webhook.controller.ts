import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const HELP_REPLY =
  "This will display a list of commands.";

/** Telegram sends this header when setWebhook was called with secret_token. */
const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

@Controller("telegram")
export class TelegramWebhookController {
  constructor(private readonly config: ConfigService) {}

  @Post("webhook")
  @HttpCode(200)
  async handleWebhook(
    @Headers(TELEGRAM_SECRET_HEADER) secretHeader: string | undefined,
    @Body() body: unknown
  ): Promise<{ ok: boolean }> {
    const expectedSecret =
      this.config.get<string>("telegramWebhookSecret")?.trim() ?? "";
    if (expectedSecret !== "") {
      const got = (secretHeader ?? "").trim();
      if (got !== expectedSecret) {
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

    const chatId = extractChatIdFromUpdate(body);
    const text = extractMessageText(body);
    if (chatId == null || text == null) {
      return { ok: true };
    }

    if (!isHelpCommand(text)) {
      return { ok: true };
    }

    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: HELP_REPLY,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(
        "[TelegramWebhook] sendMessage failed",
        JSON.stringify({ status: res.status, body: errText.slice(0, 500) })
      );
    }

    return { ok: true };
  }
}

function extractChatIdFromUpdate(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const message = body["message"];
  if (!isRecord(message)) return null;
  const chat = message["chat"];
  if (!isRecord(chat)) return null;
  const id = chat["id"];
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function extractMessageText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const message = body["message"];
  if (!isRecord(message)) return null;
  const text = message["text"];
  return typeof text === "string" ? text : null;
}

function isHelpCommand(text: string): boolean {
  const trimmed = text.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  return /^\/help(@\w+)?$/i.test(firstToken);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
