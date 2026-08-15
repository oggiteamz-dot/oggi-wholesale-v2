// OGGI Wholesale v2 — barcode/SKU lookup for the mobile receive-scan screen
// (Batch 10)
// A plain read (no RPC needed -- receiving itself still goes through the
// existing v2_receive_stock RPC from migrations/001 unchanged). Barcode is
// checked first, falling back to SKU, same precedence as the pick-scan RPCs
// (migrations/017) so both scan surfaces behave identically for the same
// scanned code.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Resolves a scanned/typed code to a variant + its product + current
 * stock, scoped to one wholesaler (a barcode is globally unique, but a
 * receiving screen should only ever act on this wholesaler's own catalog).
 * Returns null if nothing matches -- the caller shows "not found" rather
 * than guessing. */
export async function lookupByCode(wid, code) {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const { data: products } = await sbCall(supabase.from("v2_products").select("id,name").eq("wid", wid));
  const productIds = (products || []).map((p) => p.id);
  if (!productIds.length) return null;
  const productNameById = new Map((products || []).map((p) => [p.id, p.name]));

  let { data: variant } = await sbCall(
    supabase.from("v2_product_variants").select("id, sku, barcode, cost, extra_attrs, product_id").eq("barcode", trimmed).in("product_id", productIds).maybeSingle()
  );
  if (!variant) {
    ({ data: variant } = await sbCall(
      supabase.from("v2_product_variants").select("id, sku, barcode, cost, extra_attrs, product_id").eq("sku", trimmed).in("product_id", productIds).maybeSingle()
    ));
  }
  if (!variant) return null;

  const { data: balances } = await sbCall(supabase.from("v2_inventory_balances").select("location_id, qty_on_hand, qty_reserved").eq("variant_id", variant.id));
  const totalOnHand = (balances || []).reduce((s, b) => s + Number(b.qty_on_hand), 0);

  return {
    variantId: variant.id, sku: variant.sku, barcode: variant.barcode,
    cost: variant.cost != null ? Number(variant.cost) : 0,
    productName: productNameById.get(variant.product_id) || "Product",
    color: variant.extra_attrs?.color, size: variant.extra_attrs?.size,
    totalOnHand, balances: balances || [],
  };
}
