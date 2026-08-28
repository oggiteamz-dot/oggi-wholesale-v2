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
    // Batch N step 2: image_url and images come along so the detail screen can
    // show the PHOTO of what was ordered. They were already reachable and
    // simply never asked for -- the same shape as the Batch-19 bug where the
    // buyer's card fetched photography on every request and discarded it.
    supabase.from("v2_order_items").select("*, v2_product_variants(sku, extra_attrs, image_url, images, v2_products(name))").in("order_id", orderIds)
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
      // Migration 086 -- the buyer's own words about this line.
      buyerNote: it.buyer_note || null,
      colorHex: it.v2_product_variants?.extra_attrs?.colorHex || null,
      imageUrl: it.v2_product_variants?.image_url
        || (Array.isArray(it.v2_product_variants?.images) ? it.v2_product_variants.images[0] : null)
        || null,
    });
    itemsByOrder.set(it.order_id, list);
  });

  return orders.map((o) => ({
    id: o.id, buyerLabel: o.buyer_label, status: o.status,
    subtotal: Number(o.subtotal), notes: o.notes, createdAt: o.created_at,
    // Batch N step 2. `notes` is the BUYER's note on the order as a whole
    // (migration 086 -- it had been null on every order ever placed until
    // then). These three were already on the row and never mapped.
    clientId: o.client_id || null,
    locationId: o.location_id || null,
    catalogId: o.catalog_id || null,
    updatedAt: o.updated_at || null,
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
/** Batch N step 2 -- one order, for the detail screen.
 *
 * Scoped by wid AND id, not id alone. An order id is a uuid and therefore
 * hard to guess, but "hard to guess" is not an access rule: this repo has
 * already shipped one defect (S10, and the discount defect S4 fixed before it)
 * whose whole shape was a caller-supplied id that nothing scoped to a tenant.
 * The extra `.eq("wid", wid)` costs nothing and means a wholesaler cannot open
 * another wholesaler's order by pasting its id into the address bar.
 *
 * Deliberately NOT built on top of getWholesalerOrders(wid).find(...): that
 * would fetch every order this wholesaler has ever taken in order to render
 * one, which is fine at twenty orders and not at twenty thousand.
 */
export async function getWholesalerOrder(wid, orderId) {
  const { data: rows } = await sbCall(
    supabase.from("v2_orders").select("*").eq("wid", wid).eq("id", orderId).limit(1)
  );
  const o = rows && rows[0];
  if (!o) return null;

  const { data: items } = await sbCall(
    supabase.from("v2_order_items")
      .select("*, v2_product_variants(sku, extra_attrs, image_url, images, v2_products(name))")
      .eq("order_id", o.id)
  );

  const lines = (items || []).map((it) => ({
    variantId: it.variant_id,
    qty: it.qty,
    unitPrice: Number(it.unit_price),
    lineTotal: Number(it.line_total ?? it.qty * it.unit_price),
    sku: it.v2_product_variants?.sku,
    productName: it.v2_product_variants?.v2_products?.name || "Product",
    color: it.v2_product_variants?.extra_attrs?.color,
    size: it.v2_product_variants?.extra_attrs?.size,
    colorHex: it.v2_product_variants?.extra_attrs?.colorHex || null,
    imageUrl: it.v2_product_variants?.image_url
      || (Array.isArray(it.v2_product_variants?.images) ? it.v2_product_variants.images[0] : null)
      || null,
    packId: it.pack_id, packLineId: it.pack_line_id, packQty: it.pack_qty,
    buyerNote: it.buyer_note || null,
  }));

  return {
    id: o.id, buyerLabel: o.buyer_label, status: o.status,
    subtotal: Number(o.subtotal), notes: o.notes,
    createdAt: o.created_at, updatedAt: o.updated_at || null,
    clientId: o.client_id || null, locationId: o.location_id || null,
    catalogId: o.catalog_id || null,
    // Both shapes, deliberately. `items` is the collapsed view a human reads
    // ("2 x Boutique Pack"); `rawLines` is every real row, which is what a
    // warehouse actually picks. A pack shown only as a pack tells the person
    // pulling stock nothing about how many pieces to count.
    items: groupPackLines(lines),
    rawLines: lines,
  };
}

export async function advanceOrderStatus(orderId, toStatus) {
  return sbCall(supabase.from("v2_orders").update({ status: toStatus, updated_at: new Date().toISOString() }).eq("id", orderId));
}
