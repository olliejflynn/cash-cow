/**
 * DTO matching WooCommerce REST API / Orders payload (webhook body).
 * Only fields used for Sales_Log are included.
 */
export class WooCommerceLineItemDto {
  id: number;
  product_id: number;
  variation_id: number;
  name: string;
  quantity: number;
  price: string | number;
  total: string;
  subtotal: string;
  total_tax?: string;
  subtotal_tax?: string;
  meta_data?: Array<{
    key?: string;
    value?: unknown;
    display_value?: unknown;
  }>;
}

export class WooCommerceCouponLineDto {
  code: string;
}

export class WooCommerceOrderDto {
  id: number;
  customer_id?: number | string;
  status: string;
  date_created: string;
  order_key?: string;
  line_items: WooCommerceLineItemDto[];
  coupon_lines: WooCommerceCouponLineDto[];
  meta_data?: Array<{
    key?: string;
    value?: unknown;
  }>;
  total?: string;
}
