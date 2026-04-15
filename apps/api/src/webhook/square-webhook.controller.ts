import { Body, Controller, HttpCode, Post } from "@nestjs/common";

@Controller("webhooks/square")
export class SquareWebhookController {
  @Post("payment")
  @HttpCode(200)
  async handlePaymentWebhook(@Body() body: unknown): Promise<{ ok: boolean }> {
    const payload = isRecord(body) ? body : {};
    const payment = getPaymentObject(payload);
    const amount =
      getNumericField(getNestedRecord(payment, "amount_money"), "amount") ??
      getNumericField(getNestedRecord(payment, "total_money"), "amount");

    console.log(
      JSON.stringify(
        {
          event: "square_payment_webhook_extracted",
          received_at: new Date().toISOString(),
          event_id: getStringField(payload, "event_id"),
          event_type: getStringField(payload, "type"),
          payment_time:
            getStringField(payment, "updated_at") ??
            getStringField(payment, "created_at") ??
            "",
          status: getStringField(payment, "status") ?? "",
          amount,
          team_member_id: getStringField(payment, "team_member_id") ?? "",
        },
        null,
        2
      )
    );

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
