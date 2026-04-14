import { Controller, Post, Body, UseGuards } from "@nestjs/common";
import { IdempotencyService } from "../database/idempotency.service";
import { SheetsService } from "../sheets/sheets.service";
import { WebhookSecretGuard } from "./webhook-secret.guard";
import { orderToSalesLogRows } from "./order-to-sales-log";
import type { WooCommerceOrderDto } from "./dto/woocommerce-order.dto";
import { ConfigService } from "@nestjs/config";

const SOURCE_WOOCOMMERCE_ORDER = "woocommerce_order";

@Controller("webhooks/woocommerce")
@UseGuards(WebhookSecretGuard)
export class WebhookController {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly sheets: SheetsService,
    private readonly config: ConfigService
  ) {}

  @Post("order")
  async handleOrder(
    @Body() body: WooCommerceOrderDto & { webhook_id?: string }
  ): Promise<{ ok: boolean }> {
    console.log("Webhook received:", JSON.stringify(body, null, 2));
    if (
      body?.webhook_id != null &&
      (body?.id == null || !Array.isArray(body?.line_items))
    ) {
      return { ok: true };
    }
    const orderId = body?.id != null ? String(body.id) : "";
    const orderKey = body?.order_key ?? "";
    const eventId = orderKey
      ? `${orderId}:${orderKey}`
      : `${orderId}:${body?.date_created ?? Date.now()}`;

    const result = await this.idempotency.claimEvent(
      eventId,
      SOURCE_WOOCOMMERCE_ORDER,
      orderId || undefined
    );

    if (!result.claimed) {
      return { ok: true };
    }

    const defaultSellerCode =
      this.config.get<string>("defaultSellerCode") ?? "UNKNOWN";

    const rows = orderToSalesLogRows(body, {
      webhookEventId: eventId,
      defaultSellerCode,
    });

    if (rows.length > 0) {
      await this.sheets.appendSalesLogRows(rows);
    }

    return { ok: true };
  }
}
