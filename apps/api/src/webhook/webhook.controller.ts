import { Controller, Post, Body, HttpCode, UseGuards } from "@nestjs/common";
import { WebhookSecretGuard } from "./webhook-secret.guard";
import { orderToSalesLogRows } from "./order-to-sales-log";
import type { WooCommerceOrderDto } from "./dto/woocommerce-order.dto";

@Controller("webhooks/woocommerce")
@UseGuards(WebhookSecretGuard)
export class WebhookController {
  @Post("order")
  @HttpCode(200)
  handleOrder(@Body() body: unknown): { ok: boolean } {
    const payload = isObject(body) ? body : null;

    if (isWooCommerceTestPing(payload)) {
      console.log(
        JSON.stringify(
          {
            event: "woocommerce_test_ping",
            webhook_id: payload.webhook_id,
          },
          null,
          2
        )
      );
      return { ok: true };
    }

    const order = toWooOrder(payload);
    const place = getOrderMetaValue(order, "place");
    const loc = getOrderMetaValue(order, "loc");
    const card = getOrderMetaValue(order, "card");

    const webhookEventId =
      order.order_key != null && String(order.order_key).trim() !== ""
        ? `${order.id}:${order.order_key}`
        : `${order.id}:${order.date_created ?? Date.now()}`;

    const extracted = {
      order: {
        order_id: order.id,
        order_status: order.status ?? "",
        order_created_at: order.date_created ?? "",
        customer_id: order.customer_id ?? "",
        order_key: order.order_key ?? "",
      },
      metadata: {
        place,
        loc,
        card,
      },
      sales_rows: orderToSalesLogRows(order, {
        webhookEventId,
        defaultSellerCode: "UNKNOWN",
      }),
    };

    console.log(JSON.stringify(extracted, null, 2));
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

function getOrderMetaValue(order: WooCommerceOrderDto, key: string): string {
  const meta = Array.isArray(order.meta_data) ? order.meta_data : [];
  const found = meta.find(
    (m) => m && typeof m === "object" && m.key === key
  ) as { value?: unknown } | undefined;
  if (!found || found.value == null) return "";
  return String(found.value);
}
