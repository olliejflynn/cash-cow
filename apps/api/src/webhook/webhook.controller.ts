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
    try {
      const payload = isObject(body) ? body : null;
      console.log(
        "[WooWebhook] Received order webhook",
        JSON.stringify({
          body_type: typeof body,
          payload_keys: payload ? Object.keys(payload).slice(0, 20) : [],
        })
      );

      if (isWooCommerceTestPing(payload)) {
        console.log("[WooWebhook] Received WooCommerce test ping");
        return { ok: true };
      }

      const order = toWooOrder(payload);
      const orderId = String(order.id ?? "").trim();
      const orderStatus = String(order.status ?? "");

      console.log(
        "[WooWebhook] Parsed order payload",
        JSON.stringify({
          order_id: orderId,
          order_status: orderStatus,
          line_item_count: Array.isArray(order.line_items)
            ? order.line_items.length
            : 0,
          order_key: order.order_key ?? "",
          date_created: order.date_created ?? "",
        })
      );

      const payloadLineIds = (order.line_items ?? [])
        .map((li) => li.id)
        .slice(0, 40);
      const syncResult =
        await this.sheetsService.syncSalesLogRowsFromWooOrder(order);
      const { matchedRows, updatedRows } = syncResult;
      console.log(
        "[WooWebhook] Sales_Log sync result",
        JSON.stringify({
          order_id: orderId,
          order_status: orderStatus,
          matched_rows: matchedRows,
          updated_rows: updatedRows,
          target_cancelled_rows: syncResult.targetCancelledRows,
          target_active_rows: syncResult.targetActiveRows,
          payload_line_item_ids_sample: payloadLineIds,
        })
      );
      if (matchedRows > 0) {
        console.log(
          `[WooWebhook] Existing order found; status sync complete for order_id=${orderId}`
        );
        return { ok: true };
      }

      const webhookEventId =
        order.order_key != null && String(order.order_key).trim() !== ""
          ? `${order.id}:${order.order_key}`
          : `${order.id}:${order.date_created ?? Date.now()}`;

      const commissionBySlug =
        await this.sheetsService.getTicketCommissionBySlug();
      const salesRows = orderToSalesLogRows(order, {
        webhookEventId,
        defaultSellerCode:
          this.configService.get<string>("defaultSellerCode") ?? "UNKNOWN",
        commissionBySlug,
      });

      console.log(
        "[WooWebhook] No existing order rows; appending new sales rows",
        JSON.stringify({
          order_id: orderId,
          order_status: orderStatus,
          webhook_event_id: webhookEventId,
          rows_to_append: salesRows.length,
        })
      );

      await this.sheetsService.appendSalesLogRows(salesRows);
      console.log(
        `[WooWebhook] Append complete for order_id=${orderId} rows=${salesRows.length}`
      );
      return { ok: true };
    } catch (error) {
      console.error("[WooWebhook] Failed to process order webhook", error);
      throw error;
    }
  }

  @Post("order-updated")
  @HttpCode(200)
  async handleOrderUpdated(@Body() body: unknown): Promise<{ ok: boolean }> {
    try {
      const payload = isObject(body) ? body : null;
      console.log(
        "[WooWebhook][OrderUpdated] Received order webhook",
        JSON.stringify({
          body_type: typeof body,
          payload_keys: payload ? Object.keys(payload).slice(0, 20) : [],
        })
      );

      if (isWooCommerceTestPing(payload)) {
        console.log(
          "[WooWebhook][OrderUpdated] Received WooCommerce test ping"
        );
        return { ok: true };
      }

      const order = toWooOrder(payload);
      const orderId = String(order.id ?? "").trim();
      const orderStatus = String(order.status ?? "");

      console.log(
        "[WooWebhook][OrderUpdated] Parsed order payload",
        JSON.stringify({
          order_id: orderId,
          order_status: orderStatus,
          line_item_count: Array.isArray(order.line_items)
            ? order.line_items.length
            : 0,
          order_key: order.order_key ?? "",
          date_created: order.date_created ?? "",
        })
      );

      const payloadLineIds = (order.line_items ?? [])
        .map((li) => li.id)
        .slice(0, 40);
      const syncResult =
        await this.sheetsService.syncSalesLogRowsFromWooOrder(order);
      const { matchedRows, updatedRows } = syncResult;
      console.log(
        "[WooWebhook][OrderUpdated] Sales_Log sync result",
        JSON.stringify({
          order_id: orderId,
          order_status: orderStatus,
          matched_rows: matchedRows,
          updated_rows: updatedRows,
          target_cancelled_rows: syncResult.targetCancelledRows,
          target_active_rows: syncResult.targetActiveRows,
          payload_line_item_ids_sample: payloadLineIds,
        })
      );

      if (matchedRows === 0) {
        console.warn(
          `[WooWebhook][OrderUpdated] No Sales_Log rows found for order_id=${orderId}; nothing updated`
        );
      }

      return { ok: true };
    } catch (error) {
      console.error(
        "[WooWebhook][OrderUpdated] Failed to process order update webhook",
        error
      );
      throw error;
    }
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
      ? safe.line_items
          .map((el) => normalizeWooLineItem(el))
          .filter((x): x is WooCommerceOrderDto["line_items"][number] => x != null)
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

function normalizeWooLineItem(
  raw: unknown
): WooCommerceOrderDto["line_items"][number] | null {
  if (!isObject(raw)) return null;
  const idNum = Number(raw.id);
  if (!Number.isFinite(idNum)) return null;
  const qtyNum = Number(raw.quantity);
  const quantity = Number.isFinite(qtyNum) ? qtyNum : 0;
  const productIdNum = Number(raw.product_id);
  const product_id = Number.isFinite(productIdNum) ? productIdNum : 0;
  const variationIdNum = Number(raw.variation_id);
  const variation_id = Number.isFinite(variationIdNum) ? variationIdNum : 0;
  const name = typeof raw.name === "string" ? raw.name : "";
  const price =
    typeof raw.price === "string" || typeof raw.price === "number"
      ? raw.price
      : "";
  const total =
    typeof raw.total === "string" || typeof raw.total === "number"
      ? String(raw.total)
      : "";
  const subtotal =
    typeof raw.subtotal === "string" || typeof raw.subtotal === "number"
      ? String(raw.subtotal)
      : "";
  const total_tax =
    typeof raw.total_tax === "string" || typeof raw.total_tax === "number"
      ? String(raw.total_tax)
      : undefined;
  const subtotal_tax =
    typeof raw.subtotal_tax === "string" || typeof raw.subtotal_tax === "number"
      ? String(raw.subtotal_tax)
      : undefined;
  const meta_data = Array.isArray(raw.meta_data)
    ? (raw.meta_data as WooCommerceOrderDto["line_items"][number]["meta_data"])
    : undefined;
  return {
    id: idNum,
    product_id,
    variation_id,
    name,
    quantity,
    price,
    total,
    subtotal,
    total_tax,
    subtotal_tax,
    meta_data,
  };
}

