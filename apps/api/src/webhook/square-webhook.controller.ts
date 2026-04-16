import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { SheetsService } from "../sheets/sheets.service";
import type { SquarePaymentRow } from "./square-payment.types";

@Controller("webhooks/square")
export class SquareWebhookController {
  constructor(private readonly sheetsService: SheetsService) {}

  @Post("payment")
  @HttpCode(200)
  async handlePaymentWebhook(@Body() body: unknown): Promise<{ ok: boolean }> {
    const payload = isRecord(body) ? body : {};
    const payment = getPaymentObject(payload);
    const amount =
      getNumericField(getNestedRecord(payment, "amount_money"), "amount") ??
      getNumericField(getNestedRecord(payment, "total_money"), "amount");
    const status = (getStringField(payment, "status") ?? "").trim();
    const paymentId = (getStringField(payment, "id") ?? "").trim();
    const row: SquarePaymentRow = {
      payment_id: paymentId,
      payment_time:
        getStringField(payment, "updated_at") ??
        getStringField(payment, "created_at") ??
        "",
      team_member: getStringField(payment, "team_member_id") ?? "",
      amount_cents: amount == null ? "" : String(amount),
      status,
    };
    // Keep runtime logs concise: only emit the four extracted values.
    console.log(
      JSON.stringify({
        payment_id: row.payment_id,
        team_member: row.team_member,
        amount_cents: row.amount_cents,
        status: row.status,
      })
    );

    if (status.toUpperCase() !== "COMPLETED") {
      return { ok: true };
    }

    if (paymentId === "" || row.team_member.trim() === "") {
      return { ok: true };
    }

    const teamMemberAlreadyExists =
      await this.sheetsService.squarePaymentTeamMemberExists(row.team_member);
    if (teamMemberAlreadyExists) {
      return { ok: true };
    }

    await this.sheetsService.appendSquarePaymentRows([row]);

    return { ok: true };
  }
}

function getPaymentObject(payload: Record<string, unknown>): Record<string, unknown> {
  const data = getNestedRecord(payload, "data");
  const object = getNestedRecord(data, "object");
  return getNestedRecord(object, "payment");
}

function getNestedRecord(
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

function getStringField(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function getNumericField(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
