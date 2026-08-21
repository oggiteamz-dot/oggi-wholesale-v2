// OGGI Wholesale v2 — barcode assignment (Batch 4, migration 076)
//
// Measured on production before this existed: 0 of 191 variants carried a
// barcode. v2 could decode a barcode from the camera since Batch 18 and had
// never been able to produce one, so the scanner had nothing to scan.
//
// Minting happens server-side (v2_assign_internal_barcodes) rather than here,
// for one concrete reason: v2_product_variants.barcode carries a UNIQUE index,
// so two people assigning at the same moment collide, and the retry logic to
// survive that has no business living in a view.

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * Mints EAN-13 codes for every variant that has none, optionally limited to
 * one product. Returns the rows it created.
 *
 * NEVER overwrites an existing barcode -- a manufacturer's GTIN is a fact
 * about the goods, not a field for this app to reuse. That rule is enforced in
 * SQL, not here, so it holds however this is called.
 */
export async function assignInternalBarcodes(wid, { productId = null } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_assign_internal_barcodes", {
      p_product_id: productId,
      p_wid: wid || null,
    })
  );
  if (error) return { assigned: [], error };
  return {
    assigned: (data || []).map((r) => ({
      variantId: r.variant_id, sku: r.sku, barcode: r.barcode,
    })),
    error: null,
  };
}

/** Every variant of this wholesaler, with whatever barcode it has, ready to
 *  print. Reads the columns a label needs and nothing more. */
export async function getLabelRows(wid, { productId = null } = {}) {
  let q = supabase
    .from("v2_product_variants")
    .select("id, sku, barcode, extra_attrs, product_id, v2_products!inner(id, name, wid)")
    .eq("archived", false)
    .eq("v2_products.wid", wid)
    .eq("v2_products.archived", false);
  if (productId) q = q.eq("product_id", productId);

  const { data, error } = await sbCall(q);
  if (error || !data) return { rows: [], error: error || null };
  const rows = data.map((v) => ({
    variantId: v.id,
    sku: v.sku,
    barcode: v.barcode || null,
    productId: v.product_id,
    productName: v.v2_products?.name || "—",
    color: v.extra_attrs?.color || null,
    size: v.extra_attrs?.size || null,
  }));
  rows.sort((a, b) =>
    a.productName.localeCompare(b.productName) ||
    String(a.color).localeCompare(String(b.color)) ||
    String(a.size).localeCompare(String(b.size)));
  return { rows, error: null };
}
