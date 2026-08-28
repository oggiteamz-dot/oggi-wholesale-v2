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

/** Returns [{ id, name, description, createdAt, isNew, sellingModel, baseUnit,
 *   moqPerColour, imagesByColor, primaryImage,
 *   variants: [{id, sku, price, cost, compareAtPrice, color, colorHex, size,
 *               sellMode, available, onHand, reserved, imageUrl, images}] }] */
/**
 * ⛔ WHOLESALER-SIDE ONLY. NEVER CALL THIS FROM A BUYER VIEW.
 *
 * Reads v2_products, v2_product_variants and v2_inventory_by_variant DIRECTLY,
 * for the WHOLE wholesaler, with no catalog gate of any kind. That was the
 * defect Batch S closed: three buyer views called this, and the share-token
 * gate had no say over any of it.
 *
 * As of 25 Aug 2026 it has NO CALLERS. It is kept rather than deleted because
 * a wholesaler reading their own full range is a legitimate thing to want, and
 * they are `authenticated` with real RLS behind them — the grants S7 revokes
 * are anon's, not theirs. But it is a loaded gun pointing at the buyer side,
 * so `checks/check_buyer_reads_are_gated.mjs` fails the build if
 * js/views/buyer.js so much as names it.
 *
 * If you want a buyer's products, you want getCatalogByToken() (a link) or
 * getBuyerCatalog() (signed in). Both are gated. This one is not.
 */
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

  const variantsByProduct = new Map();
  (variants || []).forEach((v) => {
    const list = variantsByProduct.get(v.product_id) || [];
    list.push(shapeVariant(v, availByVariant.get(v.id)));
    variantsByProduct.set(v.product_id, list);
  });

  return products.map((p) => shapeProduct(p, variantsByProduct.get(p.id) || []));
}

/**
 * One variant row -> the shape the buyer cards read. Batch S.
 *
 * Extracted so that getCatalog() (table reads, wholesaler side) and
 * getCatalogByToken() (the gated RPC, buyer side) produce IDENTICAL objects.
 * Two functions each building this by hand is how the two paths end up
 * disagreeing about what a variant is -- and the buyer path is the one nobody
 * is looking at when the wholesaler path gets edited.
 *
 * `avail` may be undefined: a variant with no stock row anywhere is zero
 * available, not an error.
 */
function shapeVariant(v, avail) {
  return {
    id: v.id,
    sku: v.sku,
    price: Number(v.price ?? 0),
    // cost is never exposed to the buyer catalogue. The table read revokes it
    // at column level (migration 031); the RPC omits it from its return type
    // (migration 080), which matters MORE, because a definer function
    // outranks that revoke and would hand it over if asked.
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
  };
}

/** One product row plus its already-shaped variants -> the buyer card's
 *  product. Batch S: shared by both read paths, same reason as shapeVariant. */
function shapeProduct(p, vs) {
  {
    const now = Date.now();
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
      // Batch 5. How many pieces ONE orderable unit of this product is.
      //
      // Hadi, 20 Aug 2026: "Let's say the MOQ is 20 -- every single time they
      // click plus on the colour red they get 20 ... they see that there's a
      // x12 or x20 next to it, which will be multiplied in the final total."
      //
      // The column has existed since migration 061 and the wholesaler has been
      // able to set it since the same day, but nothing on the buyer side has
      // ever read it -- so the stepper counted single pieces and the x N the
      // buyer was promised did not exist anywhere. Blank/1 means the product
      // is sold by the single piece, which is every product on production
      // today, so this is additive for all of them.
      baseUnit: p.base_unit != null && Number(p.base_unit) > 1 ? Number(p.base_unit) : 1,
      // Minimum pieces per COLOUR (migration 063). The server enforces it in
      // v2_enforce_selling_model; the card needs it to say so before the
      // buyer reaches checkout and is refused.
      moqPerColour: p.moq_per_colour != null ? Number(p.moq_per_colour) : null,
      // Batch 5. Photography, grouped by colour, so the card can show the
      // picture for whichever swatch is selected.
      //
      // This data has been fetched on every catalog request since Batch 13 and
      // thrown away on every one of them: the buyer product card rendered no
      // <img> at all, and the only thing that touched these urls was the 360
      // viewer's modal. A wholesaler who had uploaded 46 photos saw a
      // text-only catalog. Grouping happens here rather than in the card
      // because it is a property of the data, and two cards computing it
      // twice is how two cards end up disagreeing.
      imagesByColor: imagesByColor(vs),
      primaryImage: firstImageOf(vs),
      // Batch S: set by the token path, absent on the wholesaler path. The
      // catalog, not the client, decides what is pinned -- see the ORDER BY in
      // migration 080.
      highlighted: !!p.highlighted,
    };
  }
}

/** Every distinct photo for each colour of a product, in variant order and
 *  de-duplicated -- the same photo attached to S, M and L of one colour is one
 *  photo of that colour, not three. */
function imagesByColor(variants) {
  const byColor = new Map();
  variants.forEach((v) => {
    if (!v.color) return;
    const urls = byColor.get(v.color) || [];
    [v.imageUrl, ...(v.images || [])].forEach((u) => {
      if (u && !urls.includes(u)) urls.push(u);
    });
    byColor.set(v.color, urls);
  });
  return byColor;
}

/** The card's fallback when the selected colour has no photo of its own: the
 *  first photo anywhere on the product, so a partly-photographed range still
 *  shows a picture instead of an empty box. Returns null when there is
 *  genuinely no photography, which the card renders as an honest placeholder
 *  rather than a broken image. */
function firstImageOf(variants) {
  for (const v of variants) {
    if (v.imageUrl) return v.imageUrl;
    if (v.images && v.images.length) return v.images[0];
  }
  return null;
}

/**
 * THE BUYER'S READ PATH. Batch S / S2.
 *
 * Everything getCatalog(wid) returns, for exactly ONE catalog, through the
 * gated function instead of the tables.
 *
 * WHY THIS EXISTS AT ALL. The token gate was already real -- and it protected
 * the wrong thing. v2_catalog_products_by_token returns a list of product IDs;
 * buyer.js then called getCatalog(wid), which read v2_products,
 * v2_product_variants and v2_inventory_by_variant DIRECTLY for the WHOLE
 * wholesaler, and filtered to those ids in the browser. So the gate decided
 * what got DRAWN and had no say in what the database HANDED OVER. Measured
 * signed-out on production, 25 Aug 2026, with the key that ships in this app:
 * 23 products, 264 variants, 143 stock rows, across SIX wholesalers.
 *
 * ONE ROUND TRIP, NOT THREE. The RPC returns a flat product x variant join;
 * the grouping below rebuilds the nested shape. That is why this is faster
 * than what it replaces, not slower, despite doing strictly more checking.
 *
 * ⚠️ ORDER IS THE DATABASE'S. The rows arrive highlighted-first, then by the
 * wholesaler's sort order. Map preserves insertion order, so the grouping
 * preserves it too. Do NOT add a sort here: "no matter what order they put
 * them in, always the highlighted items will be on the top" is a property of
 * the catalog, and a second sort in JS is a second place for it to be wrong --
 * which is exactly how the highlighted-first rule survived the query and died
 * in the filter on the path this replaces.
 *
 * ⚠️ A PRODUCT WITH NO VARIANTS COMES BACK WITH variant_id NULL. That is the
 * LEFT JOIN doing its job -- a catalog_only product, or one whose colours have
 * not been added yet, must still appear. Dropping those rows here would
 * reintroduce the silent disappearance the join was written to prevent.
 */
export async function getCatalogByToken(token, accountId = null) {
  if (!token) return [];
  const { data } = await sbCall(
    supabase.rpc("v2_catalog_read", { p_token: token, p_account_id: accountId || null })
  );
  return groupCatalogRows(data);
}

/**
 * THE SIGNED-IN BUYER'S READ PATH. Batch S / S2b.
 *
 * The path the 23 Aug research did not mention. Measured on production on
 * 25 Aug 2026: ALL TEN catalogs are private and none is public, so this is
 * not the secondary path -- it is the one buyers actually use.
 *
 * ⛔ IT ALSO REPLACES A LIVE BUG. What this supersedes was:
 *
 *     const ids = new Set(await buyerCatalogProductIds(accountId, cat.id));
 *     return catalog.filter((p) => ids.has(p.id));
 *
 * ...where buyerCatalogProductIds returns OBJECTS ({id, highlighted}), so the
 * Set held object references and `ids.has(p.id)` -- a string -- was ALWAYS
 * false. Every signed-in buyer's catalogue rendered EMPTY. It broke on
 * 20 Aug 2026 in 978d415, which changed that function's return shape so the
 * billboard page could read `highlighted`, and silently broke this caller;
 * the filter itself (c8f0ff8, the same day) had been correct when written.
 *
 * The class of failure is the one this project keeps hitting: a change in
 * RECORD SHAPE, invisible to every check that matches on names. The name was
 * still there. The call still ran. The data still arrived.
 */
export async function getBuyerCatalog(accountId, catalogId) {
  if (!accountId || !catalogId) return [];
  const { data } = await sbCall(
    supabase.rpc("v2_buyer_catalog_read", { p_account_id: accountId, p_catalog_id: catalogId })
  );
  return groupCatalogRows(data);
}

/** The flat product x variant rows the two gated RPCs return, rebuilt into the
 *  nested shape the cards read. Shared, so the link path and the signed-in
 *  path cannot disagree about what a product is. */
function groupCatalogRows(data) {
  if (!data || !data.length) return [];

  const byProduct = new Map();
  for (const r of data) {
    let entry = byProduct.get(r.product_id);
    if (!entry) {
      entry = {
        // Re-labelled to the column names shapeProduct expects. The RPC calls
        // it product_name because `name` collides with the catalog's own name
        // in a flat join, not because the shape differs.
        product: {
          id: r.product_id,
          name: r.product_name,
          description: r.description,
          created_at: r.created_at,
          selling_model: r.selling_model,
          ratio_curve: r.ratio_curve,
          moq_qty: r.moq_qty,
          moq_reorder_qty: r.moq_reorder_qty,
          base_unit: r.base_unit,
          moq_per_colour: r.moq_per_colour,
          catalog_only: r.catalog_only,
          highlighted: r.highlighted,
        },
        variants: [],
      };
      byProduct.set(r.product_id, entry);
    }
    if (!r.variant_id) continue;   // the no-variants product -- see above
    entry.variants.push(shapeVariant({
      id: r.variant_id,
      sku: r.sku,
      price: r.price,
      compare_at_price: r.compare_at_price,
      retail_price: r.retail_price,
      extra_attrs: r.extra_attrs,
      moq_qty: r.variant_moq_qty,
      image_url: r.image_url,
      images: r.images,
    }, {
      total_available: r.total_available,
      total_on_hand: r.total_on_hand,
      total_reserved: r.total_reserved,
    }));
  }

  return [...byProduct.values()].map((e) => shapeProduct(e.product, e.variants));
}

/**
 * Every product this buyer may see, across ALL the catalogs their tier allows.
 * Batch S / S2b.
 *
 * Favourites are stored as bare product ids in localStorage and a buyer may
 * star something in one catalog and open Favourites while another is active,
 * so this cannot read a single catalog: doing that would make a starred
 * product silently vanish from the list, which is the failure mode this whole
 * batch keeps guarding against.
 *
 * One request per visible catalog rather than one per product, de-duplicated
 * by product id -- the same product filed in two catalogs is one product. A
 * buyer sees a handful of catalogs at most (ten on production today, most see
 * one or two), so this is a small fan-out, not an N+1 over the range.
 *
 * ⚠️ Deliberately NOT a single "everything I may see" RPC. The gate is
 * per-catalog, and one function that answers "everything" is one function that
 * has to re-derive the tier rule a second time -- a second place for it to be
 * wrong. Ask the gate the question it already answers, once per catalog.
 */
export async function getBuyerVisibleProducts(accountId, catalogIds) {
  if (!accountId || !catalogIds || !catalogIds.length) return [];
  const lists = await Promise.all(
    catalogIds.map((cid) => getBuyerCatalog(accountId, cid))
  );
  const byId = new Map();
  for (const list of lists) {
    for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

export function findVariant(catalog, variantId) {
  for (const product of catalog) {
    const v = product.variants.find((x) => x.id === variantId);
    if (v) return { product, variant: v };
  }
  return null;
}

/**
 * List prices for a set of variants. Batch 5.
 *
 * The cart screen needs these because a cart line stores the price it was
 * priced AT -- discount and quantity break already applied -- and re-pricing
 * from that number would apply them a second time. The list price is the only
 * correct input to effectivePrice(), and the only authoritative copy of it is
 * the variant row, so the cart fetches it rather than trusting a value that
 * has been sitting in localStorage since before the wholesaler last edited
 * their prices.
 *
 * Returns a Map(variantId -> Number). Variants that come back missing are
 * simply absent from the map; the caller falls back to the line's own stored
 * listPrice, which is why cart lines carry one.
 */
export async function getVariantListPrices(accountId, variantIds) {
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  if (!accountId || !ids.length) return new Map();
  // Batch S / S5. Was a direct read of v2_product_variants -- the last one the
  // buyer app made, and the reason S7 could not revoke the variant grant.
  // Scoped now to variants in a catalogue this account may see; anything else
  // is simply absent, and the caller falls back to the line's stored
  // listPrice, which is why cart lines carry one.
  const { data } = await sbCall(
    supabase.rpc("v2_buyer_list_prices", { p_account_id: accountId, p_variant_ids: ids })
  );
  return new Map((data || []).map((v) => [v.variant_id, Number(v.price ?? 0)]));
}
