// OGGI Wholesale v2 — wholesaler inventory management (Batch 3)
// Every write here goes through Batch 1's RPCs (v2_receive_stock etc.) --
// never a direct UPDATE on v2_inventory_balances, per the architecture's
// own rule (see 001_v2_inventory_core.sql header).
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function getLocations(wid) {
  // An EXPLICIT column list, not select("*").
  //
  // Migration 047 dropped the table-wide grant on v2_locations and granted a
  // named set of columns instead. Under a column-level grant, `select("*")`
  // expands to every column in the table -- including ones the role cannot
  // read -- and the whole query is refused. So `*` does not mean "everything
  // I'm allowed", it means "everything, and fail if that isn't permitted".
  //
  // Same reasoning as js/data/catalog.js's variant select, which has carried
  // this warning since the 15 Aug cost leak: adding a sensitive column to this
  // table must never silently start publishing it, and must never silently
  // break every caller either.
  const { data } = await sbCall(
    supabase.from("v2_locations")
      .select("id, wid, name, is_default, archived, created_at")
      .eq("wid", wid).eq("archived", false)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true })
  );
  return data || [];
}

// =============================================================================
// THE STOCK TABLE
// =============================================================================
// Rewritten 18 Aug 2026 to start from VARIANTS rather than from BALANCES.
//
// THE BUG THIS FIXES
// ------------------
// The previous version built its rows by mapping over v2_inventory_balances.
// A variant with no balance row therefore produced no row at all -- it was
// absent from the Inventory screen entirely, with nothing saying why.
//
// A balance row only comes into existence when stock is first RECEIVED. So a
// product that had been created but never stocked was invisible here: sellable
// in the catalogue, present in Products, and simply missing from Inventory.
// The screen showed no error, no zero, no placeholder. It looked like the
// product had not been created.
//
// That was tolerable while the CSV importer was the only way to create a
// product, because the importer receives opening stock in the same pass. It
// stopped being tolerable the moment products could be created by hand with no
// opening stock -- which is exactly what "create a product and it goes into
// inventory" has to mean.
//
// WHY NOT JUST WRITE A ZERO-QUANTITY BALANCE ROW ON CREATE
// -------------------------------------------------------
// Because balances are a projection of the movement ledger, not a table you
// write to. 001_v2_inventory_core.sql says so in its own header, and every
// write in this file goes through an RPC for that reason. A hand-written zero
// row would be a balance with no movement explaining it -- the first thing to
// desynchronise the two. Fixing the READ is the honest fix; the data was never
// wrong, the query was.
//
// SHAPE OF THE RESULT IS UNCHANGED. Callers get the same fields they always
// did, so the Inventory view, the intelligence view's dedupeVariants() and the
// dashboard's low-stock counts all keep working. Rows for unstocked variants
// carry the wholesaler's DEFAULT location and zeros, which is what makes the
// Receive button on them work -- receiving needs somewhere to receive into.
// =============================================================================

export async function getStockTable(wid) {
  const { data: products } = await sbCall(
    // CHANGED 20 Aug 2026 (migration 062): catalog-only products are
    // excluded from Inventory entirely. Hadi: "this is a catalog-only
    // product, don't put it in the inventory."
    //
    // This is the ONE place that decision is made for the whole stock
    // system -- every report downstream (low stock, reorder, dead stock,
    // valuation, the stock table) reads getStockTable, so filtering here
    // means a made-to-order or drop-shipped line cannot sit at zero in
    // six different reports forever, training the wholesaler to ignore
    // them. Filtering in each report instead would be six chances to
    // forget one.
    supabase.from("v2_products").select("id,name").eq("wid", wid).eq("catalog_only", false)
  );
  if (!products || !products.length) return [];
  const productById = new Map(products.map((p) => [p.id, p.name]));
  const productIds = products.map((p) => p.id);

  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("*").in("product_id", productIds).eq("archived", false)
  );
  const variantIds = (variants || []).map((v) => v.id);
  if (!variantIds.length) return [];

  const [{ data: balances }, locations] = await Promise.all([
    // v2_inventory_balances_live, NOT the table. The table's qty_reserved is a
    // counter that is never filtered by expires_at, so reading it made every
    // abandoned cart suppress real stock forever -- see migration 064. The
    // view has the identical column names plus qty_available, so this is a
    // one-identifier change with no downstream effect except accuracy.
    sbCall(supabase.from("v2_inventory_balances_live").select("*, v2_locations(name)").in("variant_id", variantIds)),
    getLocations(wid),
  ]);

  // getLocations() already sorts is_default first, so [0] is the default when
  // one exists. Migration 043 guarantees every wholesaler has exactly one, and
  // checks/check_data_invariants.sql fails if that ever stops being true --
  // but this still copes with its absence rather than throwing, because an
  // Inventory screen that crashes tells the operator less than one that shows
  // the variant and says it has nowhere to put stock.
  const defaultLocation = locations[0] || null;

  const rows = [];
  const withBalance = new Set();

  (balances || []).forEach((b) => {
    const variant = (variants || []).find((v) => v.id === b.variant_id);
    if (!variant) return;
    withBalance.add(b.variant_id);
    rows.push({
      variantId: b.variant_id,
      locationId: b.location_id,
      locationName: b.v2_locations?.name || "—",
      productId: variant.product_id,
      productName: productById.get(variant.product_id) || "—",
      // Batch 18: the row shows what the garment looks like. Variants carry
      // the photo (a colourway has its own), so it comes from here.
      // Deduplicated: uploadProductImage writes the SAME url to image_url and
      // into images[], so the naive concatenation counted one photo twice and
      // the thumbnail badge cheerfully announced "2".
      images: [...new Set(
        [variant.image_url, ...(Array.isArray(variant.images) ? variant.images : [])]
          .map((u) => String(u || "").trim()).filter(Boolean)
      )],
      sku: variant.sku,
      color: variant.extra_attrs?.color,
      size: variant.extra_attrs?.size,
      // Batch 9: base unit cost, needed by the landed-cost receipt flow
      // (js/data/landed-cost.js).
      cost: variant.cost != null ? Number(variant.cost) : 0,
      onHand: Number(b.qty_on_hand),
      reserved: Number(b.qty_reserved),
      // Taken from the view, not re-derived here. Every place that does this
      // subtraction by hand is a place the 064 reservation leak can come back.
      available: Number(b.qty_available),
      neverStocked: false,
    });
  });

  // The variants nothing has ever been received into. These are the rows that
  // used to vanish.
  (variants || []).forEach((variant) => {
    if (withBalance.has(variant.id)) return;
    rows.push({
      variantId: variant.id,
      locationId: defaultLocation?.id || null,
      locationName: defaultLocation?.name || "No location set",
      productId: variant.product_id,
      productName: productById.get(variant.product_id) || "—",
      // Batch 18: the row shows what the garment looks like. Variants carry
      // the photo (a colourway has its own), so it comes from here.
      // Deduplicated: uploadProductImage writes the SAME url to image_url and
      // into images[], so the naive concatenation counted one photo twice and
      // the thumbnail badge cheerfully announced "2".
      images: [...new Set(
        [variant.image_url, ...(Array.isArray(variant.images) ? variant.images : [])]
          .map((u) => String(u || "").trim()).filter(Boolean)
      )],
      sku: variant.sku,
      color: variant.extra_attrs?.color,
      size: variant.extra_attrs?.size,
      cost: variant.cost != null ? Number(variant.cost) : 0,
      onHand: 0,
      reserved: 0,
      available: 0,
      // Lets the view distinguish "sold out" from "never had any". They look
      // identical as a number and mean entirely different things: one needs
      // reordering, the other has simply not been received yet.
      neverStocked: true,
    });
  });

  return rows.sort((a, b) => a.available - b.available); // low stock first -- most actionable
}

export async function receiveStock(variantId, locationId, qty, note) {
  return sbCall(supabase.rpc("v2_receive_stock", {
    p_variant_id: variantId, p_location_id: locationId, p_qty: qty,
    p_reference_type: "manual_receive", p_reference_id: null, p_actor_id: null,
    p_note: note || "Manual stock receipt (Batch 3 wholesaler UI)",
  }));
}

export async function adjustStock(variantId, locationId, qty, note) {
  // A manual count correction can go either direction: positive = receive,
  // negative = decrement. Route to the matching RPC rather than exposing a
  // raw balance write.
  if (qty > 0) {
    return sbCall(supabase.rpc("v2_receive_stock", {
      p_variant_id: variantId, p_location_id: locationId, p_qty: qty,
      p_reference_type: "count_correction", p_reference_id: null, p_actor_id: null, p_note: note,
    }));
  }
  if (qty < 0) {
    return sbCall(supabase.rpc("v2_decrement_stock", {
      p_variant_id: variantId, p_location_id: locationId, p_qty: Math.abs(qty),
      p_movement_type: "count_correction", p_reference_type: null, p_reference_id: null, p_actor_id: null, p_note: note,
    }));
  }
  return { ok: true };
}


/** The same stock, grouped one entry per PRODUCT.
 *
 *  Inventory used to be a row per colour+size+location, which meant a
 *  seven-variant product filled seven rows carrying the same photo and the
 *  same name. As cards that becomes seven near-identical playing cards, which
 *  is not what a wall of cards is for -- so the card is the product and the
 *  variant detail lives inside it.
 *
 *  Nothing is thrown away: every original row is kept on `variants`, so the
 *  breakdown, Receive and Transfer all still work on the exact rows they
 *  always did. This is a regrouping, not a second source of truth. */
export async function getStockByProduct(wid) {
  const rows = await getStockTable(wid);
  const byProduct = new Map();

  rows.forEach((r) => {
    const key = r.productId || r.productName;
    let p = byProduct.get(key);
    if (!p) {
      p = {
        productId: r.productId || null,
        productName: r.productName,
        images: [],
        variants: [],
        onHand: 0,
        available: 0,
        reserved: 0,
      };
      byProduct.set(key, p);
    }
    p.variants.push(r);
    p.onHand += r.onHand;
    p.available += r.available;
    p.reserved += r.reserved;
    (r.images || []).forEach((u) => { if (!p.images.includes(u)) p.images.push(u); });
  });

  return [...byProduct.values()].map((p) => {
    // Counted per COLOUR+SIZE, not per row: the same variant can appear once
    // per location, and "3 sizes are out" must not become "6 are out" just
    // because the wholesaler happens to run two warehouses.
    const byVariant = new Map();
    p.variants.forEach((v) => {
      const cur = byVariant.get(v.variantId);
      if (cur) { cur.available += v.available; cur.neverStocked = cur.neverStocked && v.neverStocked; }
      else byVariant.set(v.variantId, { available: v.available, neverStocked: v.neverStocked });
    });
    const list = [...byVariant.values()];

    // Per-warehouse totals, for the "stock in each warehouse" and "stock at
    // <name>" card facts. Summed across variants, because the question the
    // card answers is "how much of this product is in that building", not
    // "how much of this size".
    const byLoc = new Map();
    p.variants.forEach((v) => {
      if (!v.locationId) return;
      const cur = byLoc.get(v.locationId)
        || { locationId: v.locationId, locationName: v.locationName, available: 0, onHand: 0 };
      cur.available += v.available;
      cur.onHand += v.onHand;
      byLoc.set(v.locationId, cur);
    });

    return {
      ...p,
      byLocation: [...byLoc.values()].sort((a, b) => a.locationName.localeCompare(b.locationName)),
      variantCount: list.length,
      outCount: list.filter((v) => !v.neverStocked && v.available <= 0).length,
      lowCount: list.filter((v) => !v.neverStocked && v.available > 0 && v.available <= 15).length,
      neverStockedCount: list.filter((v) => v.neverStocked).length,
    };
  }).sort((a, b) => {
    // Anything needing attention first -- out of stock, then low, then the
    // rest alphabetically. The old view sorted purely by lowest available,
    // which buried a product with one dead size beneath forty healthy ones.
    const rank = (x) => (x.outCount ? 0 : x.lowCount ? 1 : 2);
    return rank(a) - rank(b) || a.productName.localeCompare(b.productName);
  });
}

/**
 * How each product has actually sold: units, how many orders it appeared on,
 * and when it last moved.
 *
 * Batch 21, for the configurable card facts. Separate from getStockByProduct
 * because most screens never ask for it -- it reads every order line this
 * wholesaler has ever had, and making Inventory pay that cost to show two
 * numbers nobody switched on would be the wrong trade.
 *
 * Returns a Map of productId -> { unitsSold, orderCount, lastSold }. A product
 * with no history is present with zeroes and a null date, NOT absent: "never
 * sold" is an answer, and the card needs to be able to say it rather than
 * showing an em dash that means "I don't know".
 */
export async function getSalesByProduct(wid) {
  const { data: products } = await sbCall(
    supabase.from("v2_products").select("id").eq("wid", wid)
  );
  const out = new Map((products || []).map((p) => [p.id, { unitsSold: 0, orderCount: 0, lastSold: null }]));
  if (!out.size) return out;

  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("id, product_id").in("product_id", [...out.keys()])
  );
  const productOf = new Map((variants || []).map((v) => [v.id, v.product_id]));
  if (!productOf.size) return out;

  const { data: lines } = await sbCall(
    supabase.from("v2_order_items")
      .select("order_id, variant_id, qty, v2_orders!inner(wid, created_at)")
      .in("variant_id", [...productOf.keys()])
  );

  // Orders counted DISTINCTLY per product: an order holding four sizes of one
  // hoodie is one order for that hoodie, not four. Counting rows here would
  // quietly reward products with more sizes, which is the opposite of what
  // "how many orders has this been on" is asked for.
  const ordersSeen = new Map();
  (lines || []).forEach((l) => {
    const pid = productOf.get(l.variant_id);
    const row = out.get(pid);
    if (!row) return;
    row.unitsSold += Number(l.qty) || 0;
    const created = l.v2_orders?.created_at;
    if (created && (!row.lastSold || created > row.lastSold)) row.lastSold = created;
    if (!ordersSeen.has(pid)) ordersSeen.set(pid, new Set());
    ordersSeen.get(pid).add(l.order_id);
  });
  ordersSeen.forEach((set, pid) => { const r = out.get(pid); if (r) r.orderCount = set.size; });

  return out;
}
