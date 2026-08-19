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

  // Batch 18: a scanned code can belong to any of three tiers -- the whole
  // product, one colourway, or one size within a colourway. v2_resolve_barcode
  // answers all three with "most specific wins" and returns EVERY variant the
  // code covers, so this can tell the difference between "that is the item"
  // and "that is eight items, which one". Guessing would put stock on the
  // wrong SKU, which is the exact failure barcodes exist to prevent.
  const { data: resolved } = await sbCall(
    supabase.rpc("v2_resolve_barcode", { p_wid: wid, p_code: trimmed })
  );
  if (resolved && resolved.length > 1) {
    return {
      ambiguous: true,
      tier: resolved[0].tier,
      productName: resolved[0].product_name,
      // Sorted so the chooser reads in a predictable order rather than
      // whatever the join happened to emit.
      options: resolved
        .map((r) => ({
          variantId: r.variant_id, sku: r.sku,
          color: r.color, size: r.size, productName: r.product_name,
        }))
        .sort((a, b) => `${a.color}${a.size}`.localeCompare(`${b.color}${b.size}`)),
    };
  }
  if (resolved && resolved.length === 1) {
    // Fall through to the detail lookup below using the resolved variant, so
    // one code path builds the stock figures for every tier.
    return withStock(resolved[0].variant_id, resolved[0].product_name, resolved[0]);
  }

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

  return withStock(variant.id, productNameById.get(variant.product_id) || "Product", {
    sku: variant.sku, barcode: variant.barcode,
    cost: variant.cost, color: variant.extra_attrs?.color, size: variant.extra_attrs?.size,
  });
}

/** Loads the stock figures for one variant and shapes the result the receive
 *  screen expects. Shared by the direct lookup and the three-tier resolver so
 *  the two cannot drift into reporting different numbers for the same scan. */
async function withStock(variantId, productName, info) {
  const { data: variant } = await sbCall(
    supabase.from("v2_product_variants")
      .select("id, sku, barcode, cost, extra_attrs")
      .eq("id", variantId).maybeSingle()
  );
  const { data: balances } = await sbCall(
    supabase.from("v2_inventory_balances")
      .select("location_id, qty_on_hand, qty_reserved").eq("variant_id", variantId)
  );
  const totalOnHand = (balances || []).reduce((s, b) => s + Number(b.qty_on_hand), 0);
  return {
    variantId,
    sku: variant?.sku ?? info.sku,
    barcode: variant?.barcode ?? info.barcode ?? null,
    cost: variant?.cost != null ? Number(variant.cost) : (info.cost != null ? Number(info.cost) : 0),
    productName,
    color: variant?.extra_attrs?.color ?? info.color,
    size: variant?.extra_attrs?.size ?? info.size,
    totalOnHand, balances: balances || [],
  };
}
