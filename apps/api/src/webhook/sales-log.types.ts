/**
 * One row for the Sales_Log sheet (matches plan columns).
 */
export interface SalesLogRow {
  logged_at: string;
  order_created_at: string;
  order_id: string;
  order_status: string;
  webhook_event_id: string;
  line_item_id: string;
  ticket_type: string;
  qty: string;
  unit_price_paid: string;
  gross_amount: string;
  seller_code: string;
  "Category (Company)": string;
  hand_in_amount: string;
  notes: string;
}
