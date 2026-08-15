// OGGI Wholesale v2 — wholesaler-side order management (Batch 3)
import { supabase, sbCall } from "../lib/supabase-client.js";
import { groupPackLines } from "./prepacks.js";

const STATUS_FLOW = ["new", "confirmed", "shipped", "delivered"];

export function nextStatus(current) {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx === -1 || idx === STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[idx + 1];
}

export async function getWholesalerOrders(wid) {
  const { data: orders } = await sbCall(
    supabase.from("v2_orders").select("*").eq("wid", wid).order("created_at", { ascending: false })
  );
  if (!orders || !orders.length) return [];

  const orderIds = orders.map((o) => o.id);
  const { data: items } = await sbCall(
    supabase.from("v2_order_items").select("*, v2_product_variants(sku, extra_attrs, v2_products(name))").in("order_id", orderIds)
  );
  const itemsByOrder = new Map();
  (items || []).forEach((it) => {
    const list = itemsByOrder.get(it.order_id) || [];
    list.push({
      variantId: it.variant_id,
      qty: it.qty,
      unitPrice: Number(it.unit_price),
      lineTotal: Number(it.line_total ?? it.qty * it.unit_price),
      sku: it.v2_product_variants?.sku,
      productName: it.v2_product_variants?.v2_products?.name || "Product",
      color: it.v2_product_variants?.extra_attrs?.color,
      size: it.v2_product_variants?.extra_attrs?.size,
      packId: it.pack_id, packLineId: it.pack_line_id, packQty: it.pack_qty,
    });
    itemsByOrder.set(it.order_id, list);
  });

  return orders.map((o) => ({
    id: o.id, buyerLabel: o.buyer_label, status: o.status,
    subtotal: Number(o.subtotal), notes: o.notes, createdAt: o.created_at,
    // Batch 7: pack-purchased lines re-collapse to one display entry per
    // pack ("2x Boutique Pack") -- see groupPackLines.
    items: groupPackLines(itemsByOrder.get(o.id) || []),
  }));
}

/** Advances an order's status. This updates the v2_orders.status column
 * directly (not through an RPC) -- status is a business-workflow field, not
 * a stock-affecting write, so it doesn't need the atomic-RPC-only
 * discipline that inventory balances do. Still routed through one function
 * so the "wholesaler can only move their own orders forward" rule (once
 * real auth lands in Batch 14) has exactly one call site to gate. */
export async function advanceOrderStatus(orderId, toStatus) {
  return sbCall(supabase.from("v2_orders").update({ status: toStatus, updated_at: new Date().toISOString() }).eq("id", orderId));
}
