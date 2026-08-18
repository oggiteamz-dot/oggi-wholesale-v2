// OGGI Wholesale v2 — catalog data access (Batch 2)
// Reads v2_products + v2_product_variants + the v2_inventory_by_variant
// aggregate view and assembles a buyer-friendly nested shape. Colour/size
// are read straight from each variant's extra_attrs (written at migration
// time and by every future write path) rather than re-joining the
// option/option-value tables — cheaper, and the option tables remain the
// structural source of truth for anything that needs to enumerate all
// possible values (e.g. a size filter across a whole catalog).

import { supabase, sbCall } from "../lib/supabase-client.js";

const NEW_BADGE_DAYS = 30;
const LOW_STOCK_THRESHOLD = 15;

// NOTE (fixed in Batch 5, see migrations/008_v2_wholesaler_directory.sql):
// these read `v2_wholesalers`, a v2-owned mirror of the wholesaler roster,
// NOT v1's real `wholesalers` table. v1's table has real RLS scoped to the
// `authenticated` role only -- under v2's dev-mode `anon` key every query
// against it silently returns empty (not an error), which is exactly what
// happened here from Batch 2 until this was caught in Batch 5 testing.
export async function getWholesaler(wid) {
  // Batch 8: also selects the catalog-UX settings columns (migrations/013)
  // -- low_moq_threshold feeds the buyer catalog toolbar's "Low MOQ only"
  // filter, the other three feed the cart trust/guarantee card -- so the
  // one getWholesaler() call already every buyer page makes covers both,
  // no extra query needed.
  //
  // 18 Aug 2026 (migration 042): this no longer selects the table. Buyers and
  // sales reps run as the `anon` role -- they authenticate through
  // v2_portal_accounts, so auth.uid() is NULL and the database has no way to
  // tell WHICH wholesaler an anon caller belongs to. That meant no row policy
  // could scope this read, and anon consequently held SELECT on every row and
  // every column: the whole roster plus contact phone, contact email, owner
  // notes and subscription prices, readable with the publishable key alone.
  //
  // v2_public_wholesaler() takes an exact id and returns AT MOST ONE ROW of
  // catalogue-facing columns. There is no argument to it that returns a list,
  // so the roster cannot be enumerated even by a caller who bypasses this file
  // entirely and hits the REST endpoint by hand.
  const { data } = await sbCall(
    supabase.rpc("v2_public_wholesaler", { p_wid: wid })
  );
  return (Array.isArray(data) ? data[0] : data) || null;
}

/**
 * REMOVED AS A CAPABILITY, KEPT AS A FUNCTION. Always returns [].
 *
 * This used to return every active wholesaler, and it fed the buyer app's
 * "Suppliers" screen -- a grid of every OGGI customer by brand name with a
 * "Browse catalog" button beside each one. Any buyer of any wholesaler could
 * read the full client list of the platform and walk into a competitor's
 * catalogue.
 *
 * It is left here, returning an empty array, rather than deleted outright, so
 * that any caller added later fails visibly (an empty list) instead of failing
 * to compile and getting "fixed" by someone re-adding the query.
 *
 * The database now refuses this read regardless of what this file does:
 * migration 042 revoked the anon role's access to v2_wholesalers entirely.
 *
 * The buyer-facing way to see products from more than one wholesaler is the
 * Marketplace -- deliberately unbranded, no wholesaler names, everything
 * presented as OGGI. That is a separate build, not a rename of this.
 */
export async function listWholesalers() {
  return [];
}

/** Returns [{ id, name, description, createdAt, isNew, sellingModel, variants: [{id, sku, price, cost, compareAtPrice, color, colorHex, size, sellMode, available, onHand, reserved}] }] */
export async function getCatalog(wid) {
  const { data: products } = await sbCall(
    supabase.from("v2_products").select("*").eq("wid", wid).eq("archived", false).order("created_at", { ascending: false })
  );
  if (!products || !products.length) return [];

  const productIds = products.map((p) => p.id);
  const { data: variants } = await sbCall(
    // Explicit column list, NOT select("*").
    //
    // `cost` is the wholesaler's buying price. It is deliberately absent: this
    // is the BUYER catalogue, and until 15 Aug 2026 an anonymous visitor could
    // read every wholesaler's cost prices through this query and derive their
    // exact margins. Buyers never needed it -- the margin shown on a product
    // card is computed from price vs retail/MSRP, never from cost.
    //
    // The database now revokes `cost` from the anon role, so select("*") here
    // would fail outright. Keep this list explicit: adding a sensitive column
    // to the table must never silently start publishing it.
    supabase.from("v2_product_variants")
      .select("id,product_id,sku,price,compare_at_price,retail_price,extra_attrs,moq_qty,barcode,image_url,images,archived")
      .in("product_id", productIds).eq("archived", false)
  );
  const variantIds = (variants || []).map((v) => v.id);

  let availability = [];
  if (variantIds.length) {
    const { data } = await sbCall(
      supabase.from("v2_inventory_by_variant").select("*").in("variant_id", variantIds)
    );
    availability = data || [];
  }
  const availByVariant = new Map(availability.map((a) => [a.variant_id, a]));

  const now = Date.now();
  const variantsByProduct = new Map();
  (variants || []).forEach((v) => {
    const list = variantsByProduct.get(v.product_id) || [];
    const avail = availByVariant.get(v.id);
    list.push({
      id: v.id,
      sku: v.sku,
      price: Number(v.price ?? 0),
      // cost intentionally not exposed to the buyer catalogue -- see the query above
      cost: null,
      compareAtPrice: v.compare_at_price != null ? Number(v.compare_at_price) : null,
      color: v.extra_attrs?.color || null,
      colorHex: v.extra_attrs?.colorHex || "#999",
      size: v.extra_attrs?.size || null,
      sellMode: v.extra_attrs?.sellMode || "open",
      available: avail ? Number(avail.total_available) : 0,
      onHand: avail ? Number(avail.total_on_hand) : 0,
      reserved: avail ? Number(avail.total_reserved) : 0,
      // Batch 6: SKU-level MOQ + optional retail/MSRP for margin display.
      moqQty: v.moq_qty || 1,
      retailPrice: v.retail_price != null ? Number(v.retail_price) : null,
      // Batch 13: photography for the hologram/360 viewer -- both are
      // opt-in and commonly empty (see js/lib/animations/product-hologram.js
      // for how the viewer degrades gracefully with zero real photos).
      imageUrl: v.image_url || null,
      images: Array.isArray(v.images) ? v.images : [],
    });
    variantsByProduct.set(v.product_id, list);
  });

  return products.map((p) => {
    const vs = variantsByProduct.get(p.id) || [];
    const prices = vs.map((v) => v.price).filter((n) => n > 0);
    const isNew = now - new Date(p.created_at).getTime() < NEW_BADGE_DAYS * 86400000;
    const lowStock = vs.length > 0 && vs.every((v) => v.available <= LOW_STOCK_THRESHOLD);
    const outOfStock = vs.length > 0 && vs.every((v) => v.available <= 0);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.created_at,
      // Migration 029/030: the selling model is now a real, constrained column
      // on the product rather than a loose key inside each variant's jsonb.
      // The buyer card uses it to decide WHICH buying control to show; the
      // server enforces the same value at checkout, so the two cannot drift
      // into the state where the app offers a purchase the server refuses.
      sellingModel: p.selling_model || "open",
      ratioCurve: p.ratio_curve || null,
      isNew,
      lowStock,
      outOfStock,
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      colors: [...new Map(vs.map((v) => [v.color, { name: v.color, hex: v.colorHex }])).values()].filter((c) => c.name),
      sizes: [...new Set(vs.map((v) => v.size))].filter(Boolean),
      variants: vs,
      // Batch 6: product-level MOQ (aggregated across every colour/size of
      // this product), with a separate reorder threshold when set.
      moqQty: p.moq_qty || 1,
      moqReorderQty: p.moq_reorder_qty != null ? Number(p.moq_reorder_qty) : null,
    };
  });
}

export function findVariant(catalog, variantId) {
  for (const product of catalog) {
    const v = product.variants.find((x) => x.id === variantId);
    if (v) return { product, variant: v };
  }
  return null;
}
