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
    supabase.from("v2_products").select("id,name").eq("wid", wid)
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
    sbCall(supabase.from("v2_inventory_balances").select("*, v2_locations(name)").in("variant_id", variantIds)),
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
      available: Number(b.qty_on_hand) - Number(b.qty_reserved),
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
