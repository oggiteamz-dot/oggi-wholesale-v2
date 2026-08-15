// OGGI Wholesale v2 — scan-to-pick data access (Batch 10)
//
// IMPORTANT CONTEXT (checked directly against the real RPCs before building
// this): v2_submit_order already calls v2_confirm_reservation per line at
// the moment a buyer places an order, which converts the reservation
// straight into a real 'sale' stock decrement. So by the time an order
// exists at all, its stock has ALREADY left the ledger. Picking here is a
// pure fulfillment-verification checklist (did the physical units for this
// order actually get pulled and packed?) layered on top via
// v2_order_pick_items -- it never touches v2_inventory_balances/movements
// again. See migrations/016/017 for the schema/RPCs this wraps.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Everything the mobile pick screen needs for one order: its own real
 * line items (product/SKU/colour/size for display) joined with pick
 * progress. Calls v2_start_order_pick first (idempotent -- never resets
 * progress already made) so a pick checklist always exists by the time
 * this reads it, even the very first time the screen opens for an order. */
export async function getPickProgress(orderId) {
  await sbCall(supabase.rpc("v2_start_order_pick", { p_order_id: orderId }));

  const { data: picks } = await sbCall(
    supabase.from("v2_order_pick_items")
      .select("*, v2_product_variants(sku, barcode, extra_attrs, v2_products(name))")
      .eq("order_id", orderId)
      .order("updated_at", { ascending: true })
  );

  return (picks || []).map((p) => ({
    id: p.id, orderItemId: p.order_item_id, variantId: p.variant_id,
    sku: p.v2_product_variants?.sku, barcode: p.v2_product_variants?.barcode,
    productName: p.v2_product_variants?.v2_products?.name || "Product",
    color: p.v2_product_variants?.extra_attrs?.color, size: p.v2_product_variants?.extra_attrs?.size,
    expectedQty: p.expected_qty, pickedQty: p.picked_qty,
    complete: p.picked_qty >= p.expected_qty,
    pickedAt: p.picked_at,
  }));
}

/** Scans one unit. Returns { ok:true, pick } with the SERVER's real,
 * updated row on success, or { ok:false, error } with the server's own
 * message ("This SKU is not part of this order", "Already fully picked for
 * this SKU on this order", "No SKU or barcode matches...") on failure --
 * every failure mode is a real, specific Postgres exception, never a
 * generic "scan failed". */
export async function scanPickItem(orderId, code) {
  const { data, error } = await sbCall(supabase.rpc("v2_scan_pick_item", { p_order_id: orderId, p_code: code }));
  if (error || !data) return { ok: false, error };
  return { ok: true, pick: data };
}

export async function undoPickItem(orderId, code) {
  const { data, error } = await sbCall(supabase.rpc("v2_undo_pick_item", { p_order_id: orderId, p_code: code }));
  if (error || !data) return { ok: false, error };
  return { ok: true, pick: data };
}
