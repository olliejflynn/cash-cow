import type { WooCommerceOrderDto } from "./dto/woocommerce-order.dto";
import type { SalesLogRow } from "./sales-log.types";

const COMMISSION_PER_TICKET = 10;

export interface OrderToSalesLogOptions {
  webhookEventId: string;
  defaultSellerCode: string;
}

/**
 * Map a WooCommerce order to one or more Sales_Log rows (one per line item).
 * Uses default seller code and hand-in for MVP (no Ticket_Rules/Seller_Overrides).
 */
export function orderToSalesLogRows(
  order: WooCommerceOrderDto,
  options: OrderToSalesLogOptions
): SalesLogRow[] {
  const now = new Date().toISOString();
  const orderCreatedAt = order.date_created ?? now;
  const orderId = String(order.id);
  const sellerCode = deriveSellerCode(order, options.defaultSellerCode);

  return (order.line_items ?? []).map((item) => {
    const qty = Number(item.quantity) || 1;
    const isDeposit = isDeposit20(item);
    const unitPricePaid = isDeposit ? 20 : getPaidInFullUnitPrice(item, qty);
    const grossAmount = unitPricePaid * qty;
    const handInAmount = grossAmount - qty * COMMISSION_PER_TICKET;
    const ticketType = getTicketType(item);
    const categoryCompany = getCategoryCompany(item);

    return {
      logged_at: now,
      order_created_at: orderCreatedAt,
      order_id: orderId,
      order_status: order.status ?? "",
      webhook_event_id: options.webhookEventId,
      line_item_id: String(item.id),
      ticket_type: ticketType,
      qty: String(qty),
      unit_price_paid: String(unitPricePaid),
      gross_amount: String(grossAmount),
      seller_code: sellerCode,
      "Category (Company)": categoryCompany,
      hand_in_amount: String(handInAmount),
      notes: "",
    };
  });
}

function getPaidInFullUnitPrice(
  item: WooCommerceOrderDto["line_items"][number],
  qty: number
): number {
  const price = parseFloat(String(item.price));
  if (!Number.isNaN(price) && price > 0) return price;

  const originalPriceMeta = getLineItemMeta(
    item,
    "_tm_epo_product_original_price"
  );
  const originalList = Array.isArray(originalPriceMeta?.value)
    ? originalPriceMeta?.value
    : [];
  const originalFirst =
    originalList.length > 0 ? parseFloat(String(originalList[0])) : NaN;
  if (!Number.isNaN(originalFirst) && originalFirst > 0) return originalFirst;

  const total = parseFloat(String(item.total));
  if (!Number.isNaN(total) && qty > 0) return total / qty;
  return 0;
}

function isDeposit20(item: WooCommerceOrderDto["line_items"][number]): boolean {
  const tmCartMeta = getLineItemMeta(item, "_tmcartepo_data");
  const values = Array.isArray(tmCartMeta?.value) ? tmCartMeta.value : [];
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const name =
      "name" in entry && entry.name != null ? String(entry.name).trim() : "";
    const value =
      "value" in entry && entry.value != null ? String(entry.value).trim() : "";
    if (name.toLowerCase() === "payment" && value === "20") {
      return true;
    }
  }
  return false;
}

function getTicketType(
  item: WooCommerceOrderDto["line_items"][number]
): string {
  const meta = getLineItemMeta(item, "pa_ticket-type");
  if (meta == null) return "";
  if (meta.value != null) return String(meta.value);
  if (meta.display_value != null) return String(meta.display_value);
  return "";
}

function getCategoryCompany(
  item: WooCommerceOrderDto["line_items"][number]
): string {
  const meta = getLineItemMeta(item, "category");
  if (meta == null) return "";
  if (meta.display_value != null) return String(meta.display_value);
  if (meta.value != null) return String(meta.value);
  return "";
}

function getLineItemMeta(
  item: WooCommerceOrderDto["line_items"][number],
  key: string
):
  | {
      key?: unknown;
      value?: unknown;
      display_value?: unknown;
    }
  | undefined {
  const meta = Array.isArray(item.meta_data) ? item.meta_data : [];
  return meta.find((m) => m && typeof m === "object" && m.key === key);
}

function deriveSellerCode(
  order: WooCommerceOrderDto,
  defaultCode: string
): string {
  if (order.customer_id != null && String(order.customer_id).trim() !== "") {
    return String(order.customer_id).trim();
  }
  return defaultCode;
}
