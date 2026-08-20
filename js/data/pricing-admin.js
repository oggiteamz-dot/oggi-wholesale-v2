// OGGI Wholesale v2 — wholesaler-side pricing/MOQ admin (Batch 6)
import { supabase, sbCall } from "../lib/supabase-client.js";

/** Everything one product's pricing panel needs in one call: its own
 * MOQ fields, its tiers, and its variants' SKU-level MOQ + retail price. */
export async function getProductPricing(productId) {
  const [{ data: product }, { data: tiers }, { data: variants }] = await Promise.all([
    sbCall(supabase.from("v2_products").select("id, moq_qty, moq_reorder_qty").eq("id", productId).maybeSingle()),
    sbCall(supabase.from("v2_pricing_tiers").select("*").eq("product_id", productId).order("min_qty", { ascending: true })),
    sbCall(supabase.from("v2_product_variants").select("id, sku, price, moq_qty, retail_price, extra_attrs, reorder_point, reorder_qty, lead_time_days, barcode, image_url, images").eq("product_id", productId).eq("archived", false)),
  ]);
  return {
    moqQty: product?.moq_qty ?? 1,
    moqReorderQty: product?.moq_reorder_qty ?? null,
    // migration 063 — minimum units of EACH colour, summed across sizes
    moqPerColour: product?.moq_per_colour ?? null,
    tiers: (tiers || []).map((t) => ({ id: t.id, minQty: t.min_qty, unitPrice: Number(t.unit_price) })),
    variants: (variants || []).map((v) => ({
      id: v.id, sku: v.sku, price: Number(v.price ?? 0),
      moqQty: v.moq_qty ?? 1, retailPrice: v.retail_price != null ? Number(v.retail_price) : null,
      color: v.extra_attrs?.color, size: v.extra_attrs?.size,
      // Batch 9: reorder-point automation fields, all nullable -- a SKU
      // with none of these set never generates a reorder suggestion.
      reorderPoint: v.reorder_point, reorderQty: v.reorder_qty, leadTimeDays: v.lead_time_days,
      // Batch 10: the real scannable barcode (UPC/EAN or an internal
      // warehouse label), separate from the SKU string -- see
      // migrations/016 for why these are kept distinct.
      barcode: v.barcode,
      // Batch 13: product photography for the hologram/360 viewer. imageUrl
      // is a single hero shot; images is an ordered array of {url} frames
      // for a true drag-to-rotate 360 view once real multi-angle photos
      // exist for this SKU (see js/lib/animations/product-hologram.js).
      imageUrl: v.image_url, images: Array.isArray(v.images) ? v.images : [],
    })),
  };
}

export async function setProductMoq(productId, { moqQty, moqReorderQty, moqPerColour }) {
  return sbCall(supabase.from("v2_products").update({
    moq_qty: moqQty, moq_reorder_qty: moqReorderQty === "" || moqReorderQty == null ? null : moqReorderQty,
    // Sent as undefined-safe: an explicit null CLEARS the colour rule,
    // which is a real thing a wholesaler wants to do. Only `undefined`
    // means "leave it alone", so callers that don't know about this
    // field cannot wipe it by omission.
    ...(moqPerColour === undefined ? {} : {
      moq_per_colour: moqPerColour === "" || moqPerColour == null ? null : parseInt(moqPerColour, 10),
    }),
    updated_at: new Date().toISOString(),
  }).eq("id", productId));
}

export async function addTier(productId, minQty, unitPrice) {
  return sbCall(supabase.from("v2_pricing_tiers").insert({ product_id: productId, min_qty: minQty, unit_price: unitPrice }));
}

export async function removeTier(tierId) {
  return sbCall(supabase.from("v2_pricing_tiers").delete().eq("id", tierId));
}

export async function setVariantMoq(variantId, moqQty) {
  return sbCall(supabase.from("v2_product_variants").update({ moq_qty: moqQty, updated_at: new Date().toISOString() }).eq("id", variantId));
}

export async function setVariantRetailPrice(variantId, retailPrice) {
  return sbCall(supabase.from("v2_product_variants").update({
    retail_price: retailPrice === "" || retailPrice == null ? null : retailPrice,
    updated_at: new Date().toISOString(),
  }).eq("id", variantId));
}

/** Batch 10: the real scannable barcode for this SKU, used by the mobile
 * receive-scan and pick-scan screens (js/views/mobile-ops.js). null clears
 * it. The unique-when-set index on the column (migrations/016) means a
 * duplicate barcode across two SKUs fails here with a real Postgres
 * uniqueness error rather than silently overwriting the other SKU's
 * assignment. */
export async function setVariantBarcode(variantId, barcode) {
  return sbCall(supabase.from("v2_product_variants").update({
    barcode: barcode === "" || barcode == null ? null : barcode.trim(),
    updated_at: new Date().toISOString(),
  }).eq("id", variantId));
}

/** Batch 9: per-SKU reorder-point automation settings. All three fields are
 * optional/independent -- a wholesaler can set just a reorder point without
 * a reorder qty (the reorder-suggestions report falls back to a computed
 * suggestion, see js/data/inventory-intelligence.js) or just a lead time
 * for reference without opting into the reorder feature at all. */
export async function setVariantReorderSettings(variantId, { reorderPoint, reorderQty, leadTimeDays }) {
  return sbCall(supabase.from("v2_product_variants").update({
    reorder_point: reorderPoint === "" || reorderPoint == null ? null : reorderPoint,
    reorder_qty: reorderQty === "" || reorderQty == null ? null : reorderQty,
    lead_time_days: leadTimeDays === "" || leadTimeDays == null ? null : leadTimeDays,
    updated_at: new Date().toISOString(),
  }).eq("id", variantId));
}

/** Batch 13: save this SKU's photo(s) for the hologram/360 viewer.
 * `urls` is an ordered array of image URLs typed/pasted by the wholesaler,
 * one per physical angle they have a real photo for (front, 3/4, back,
 * etc.) -- as few as zero (clears imagery back to the generated
 * placeholder) or one (single hero shot, tilt-only viewer) or many (true
 * drag-to-rotate 360). The first URL doubles as image_url (used anywhere
 * in the app that just wants a single representative photo, e.g. a future
 * catalog thumbnail) so that column never silently drifts out of sync
 * with images[0]. */
export async function setVariantImages(variantId, urls) {
  const cleaned = (urls || []).map((u) => u.trim()).filter(Boolean);
  return sbCall(supabase.from("v2_product_variants").update({
    image_url: cleaned[0] || null,
    images: cleaned.map((url) => ({ url })),
    updated_at: new Date().toISOString(),
  }).eq("id", variantId));
}

/** Order-level MOQ lives on v2_wholesalers (Batch 5's mirror table), not
 * per-product -- one wholesaler-wide minimum. */
export async function getOrderMinimums(wid) {
  const { data } = await sbCall(supabase.from("v2_wholesalers").select("order_min_qty, order_min_value").eq("wid", wid).maybeSingle());
  return { orderMinQty: data?.order_min_qty ?? null, orderMinValue: data?.order_min_value != null ? Number(data.order_min_value) : null };
}

export async function setOrderMinimums(wid, { orderMinQty, orderMinValue }) {
  return sbCall(supabase.from("v2_wholesalers").update({
    order_min_qty: orderMinQty === "" || orderMinQty == null ? null : orderMinQty,
    order_min_value: orderMinValue === "" || orderMinValue == null ? null : orderMinValue,
    updated_at: new Date().toISOString(),
  }).eq("wid", wid));
}
