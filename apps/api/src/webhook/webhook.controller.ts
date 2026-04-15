import { Controller, Post, Body, HttpCode, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SheetsService } from "../sheets/sheets.service";
import { WebhookSecretGuard } from "./webhook-secret.guard";
import { orderToSalesLogRows } from "./order-to-sales-log";
import type { WooCommerceOrderDto } from "./dto/woocommerce-order.dto";

@Controller("webhooks/woocommerce")
@UseGuards(WebhookSecretGuard)
export class WebhookController {
  constructor(
    private readonly sheetsService: SheetsService,
    private readonly configService: ConfigService
  ) {}

  @Post("order")
  @HttpCode(200)
  async handleOrder(@Body() body: unknown): Promise<{ ok: boolean }> {
    const payload = isObject(body) ? body : null;

    if (isWooCommerceTestPing(payload)) {
      return { ok: true };
    }

    const order = toWooOrder(payload);

    const webhookEventId =
      order.order_key != null && String(order.order_key).trim() !== ""
        ? `${order.id}:${order.order_key}`
        : `${order.id}:${order.date_created ?? Date.now()}`;

    const salesRows = orderToSalesLogRows(order, {
      webhookEventId,
      defaultSellerCode:
        this.configService.get<string>("defaultSellerCode") ?? "UNKNOWN",
    });

    await this.sheetsService.appendSalesLogRows(salesRows);
    return { ok: true };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

function isWooCommerceTestPing(
  payload: Record<string, unknown> | null
): payload is Record<string, unknown> & { webhook_id: string | number } {
  if (!payload) return false;
  return (
    "webhook_id" in payload &&
    payload.webhook_id != null &&
    !("id" in payload) &&
    !("line_items" in payload)
  );
}

function toWooOrder(payload: Record<string, unknown> | null): WooCommerceOrderDto {
  const safe = payload ?? {};
  return {
    id: Number(safe.id ?? 0),
    customer_id:
      typeof safe.customer_id === "number" || typeof safe.customer_id === "string"
        ? safe.customer_id
        : undefined,
    status: typeof safe.status === "string" ? safe.status : "",
    date_created: typeof safe.date_created === "string" ? safe.date_created : "",
    order_key: typeof safe.order_key === "string" ? safe.order_key : undefined,
    line_items: Array.isArray(safe.line_items)
      ? (safe.line_items as WooCommerceOrderDto["line_items"])
      : [],
    coupon_lines: Array.isArray(safe.coupon_lines)
      ? (safe.coupon_lines as WooCommerceOrderDto["coupon_lines"])
      : [],
    total:
      typeof safe.total === "string" || typeof safe.total === "number"
        ? String(safe.total)
        : undefined,
    meta_data: Array.isArray(safe.meta_data)
      ? (safe.meta_data as Array<{ key?: string; value?: unknown }>)
      : [],
  };
}

