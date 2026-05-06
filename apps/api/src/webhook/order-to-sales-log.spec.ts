import { describe, expect, it } from "vitest";
import { orderToSalesLogRows } from "./order-to-sales-log";
import type { WooCommerceOrderDto } from "./dto/woocommerce-order.dto";

function minimalOrder(overrides: Partial<WooCommerceOrderDto> = {}): WooCommerceOrderDto {
  return {
    id: 9001,
    customer_id: 42,
    status: "processing",
    date_created: "2026-05-01T12:00:00.000Z",
    line_items: [
      {
        id: 101,
        product_id: 1,
        variation_id: 0,
        name: "Ticket",
        quantity: 2,
        price: "50",
        total: "100",
        subtotal: "100",
        meta_data: [
          { key: "pa_ticket-type", value: "alpha-slug" },
          { key: "loc", value: "H" },
        ],
      },
    ],
    coupon_lines: [],
    ...overrides,
  };
}

describe("orderToSalesLogRows H commission override", () => {
  const opts = {
    webhookEventId: "9001:key",
    defaultSellerCode: "UNKNOWN",
    commissionBySlug: new Map<string, number>([["alpha-slug", 10]]),
    hCommissionBySlug: new Map<string, number>([["alpha-slug", 25]]),
  };

  it("uses H Commission when Location is H and override exists", () => {
    const rows = orderToSalesLogRows(minimalOrder(), opts);
    expect(rows).toHaveLength(1);
    expect(rows[0].Location).toBe("H");
    expect(rows[0].unit_commission).toBe("25");
    expect(rows[0].gross_commission).toBe("50");
    expect(rows[0].gross_amount).toBe("100");
    expect(rows[0].hand_in_amount).toBe("50");
  });

  it("uses regular Commission when Location is not H", () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 101,
          product_id: 1,
          variation_id: 0,
          name: "Ticket",
          quantity: 2,
          price: "50",
          total: "100",
          subtotal: "100",
          meta_data: [
            { key: "pa_ticket-type", value: "alpha-slug" },
            { key: "loc", value: "L" },
          ],
        },
      ],
    });
    const rows = orderToSalesLogRows(order, opts);
    expect(rows[0].unit_commission).toBe("10");
    expect(rows[0].gross_commission).toBe("20");
    expect(rows[0].hand_in_amount).toBe("80");
  });

  it("uses regular Commission at H when H override map has no entry", () => {
    const rows = orderToSalesLogRows(minimalOrder(), {
      ...opts,
      hCommissionBySlug: new Map(),
    });
    expect(rows[0].unit_commission).toBe("10");
    expect(rows[0].gross_commission).toBe("20");
  });

  it("applies explicit zero H Commission override", () => {
    const rows = orderToSalesLogRows(minimalOrder(), {
      ...opts,
      hCommissionBySlug: new Map([["alpha-slug", 0]]),
    });
    expect(rows[0].unit_commission).toBe("0");
    expect(rows[0].gross_commission).toBe("0");
    expect(rows[0].hand_in_amount).toBe("100");
  });

  it("treats loc h case-insensitively as H", () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 101,
          product_id: 1,
          variation_id: 0,
          name: "Ticket",
          quantity: 1,
          price: "40",
          total: "40",
          subtotal: "40",
          meta_data: [
            { key: "pa_ticket-type", value: "alpha-slug" },
            { key: "loc", value: "h" },
          ],
        },
      ],
    });
    const rows = orderToSalesLogRows(order, opts);
    expect(rows[0].Location).toBe("h");
    expect(rows[0].unit_commission).toBe("25");
  });
});
