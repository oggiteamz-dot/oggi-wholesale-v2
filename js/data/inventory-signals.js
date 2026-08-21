// OGGI Wholesale v2 — the inventory signal (Batch 1, migrations 066/067/068)
//
// WHY THIS IS ITS OWN MODULE.
// Three different screens need to answer the same question -- "is this SKU in
// trouble?" -- and before Batch 1 all three answered it separately, each with
// its own copy of `available <= 15`:
//     js/views/wholesaler.js:215    the dashboard count
//     js/views/wholesaler.js:1183   the inventory row badge
//     js/data/inventory-admin.js:281 the per-product lowCount
// Four copies of a magic number, in three files, none aware of the others.
// That is the same shape as the HTML-escape helper living in ten copies under
// four names, and as the availability subtraction that carried the
// reservation leak into six files at once.
//
// So the definition lives here, once, and is fetched from the database which
// computes it once. This module deliberately imports NOTHING but the Supabase
// client: js/data/inventory-admin.js and js/data/inventory-intelligence.js
// both need it, and inventory-intelligence.js already imports
// inventory-admin.js for adjustStock -- putting the signal in either of them
// would create an import cycle.

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * One row per active variant, straight from the database: how fast it moves,
 * how many days of cover are left, when to reorder, where that reorder number
 * came from, and whether it is outselling its sibling colourways.
 *
 * WHY THIS IS AN RPC AND NOT COMPUTED HERE.
 * The old code fetched variants, balances and orders separately and did the
 * arithmetic in the browser. That is four round trips, it cannot be tested
 * without a browser, and -- the reason that actually decided it -- the
 * `available = on_hand - reserved` subtraction was copied into six files, and
 * the reservation leak lived in every one of them. One server-side definition
 * cannot drift from itself.
 *
 * Status values, which are five DIFFERENT facts and not degrees of one:
 *   not_tracked  never received into stock; a catalogue entry, not a problem
 *   out          has been stocked, and is now at zero
 *   no_data      in stock, but nothing sold in the window, so cover is unknowable
 *   reorder      at or below the reorder point
 *   low          above the reorder point but under the cover target
 *   ok           comfortable
 */
export async function getInventorySignals(wid) {
  const { data, error } = await sbCall(supabase.rpc("v2_inventory_signals", { p_wid: wid }));
  if (error || !data) return [];
  return data.map((r) => ({
    variantId: r.variant_id,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    color: r.color,
    size: r.size,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.available,
    unitsSold: r.units_sold,
    velocityPerDay: r.velocity_per_day == null ? 0 : Number(r.velocity_per_day),
    daysOfCover: r.days_of_cover == null ? null : Number(r.days_of_cover),
    leadTimeDays: r.lead_time_days_used,
    reorderPoint: r.reorder_point,
    // 'manual' | 'derived' | null. Shown in the UI on purpose: a number whose
    // origin cannot be seen is a number that gets ignored, and an ignored
    // signal is the same as no signal at all.
    reorderPointSource: r.reorder_point_source,
    suggestedQty: r.suggested_qty,
    status: r.status,
    isBreakout: r.is_breakout === true,
    siblingMedianVelocity: r.sibling_median_velocity == null ? 0 : Number(r.sibling_median_velocity),
    breakoutRatio: r.breakout_ratio == null ? null : Number(r.breakout_ratio),
    // 0 means "there was nothing to compare this against", which is a fact
    // about the catalogue's shape, not a quiet failure of the alert.
    siblingCount: r.sibling_count == null ? 0 : Number(r.sibling_count),
  }));
}

/**
 * Everything that needs buying, most urgent first.
 *
 * WHAT CHANGED AND WHY. This used to be:
 *     variants.filter(v => v.reorderPoint != null && v.available <= v.reorderPoint)
 * On production that returned an empty list for the entire platform, because
 * zero of 191 variants had a reorder point set. The screen read as working
 * and did nothing, while a SKU sat at 9.25 days of cover.
 *
 * A reorder point is now DERIVED from real demand when nobody has set one --
 * expected demand across the restock lead time, plus a safety buffer. An
 * explicitly-set point still wins, and the row says which of the two applied.
 *
 * Variants with no demand history are deliberately absent: with no velocity
 * there is no honest way to say how much to buy, and inventing a number would
 * be worse than saying nothing.
 *
 * The signature and every field name are unchanged, so existing callers keep
 * working exactly as before.
 */
export async function getReorderSuggestions(wid) {
  const signals = await getInventorySignals(wid);
  return signals
    .filter((s) => (s.status === "reorder" || s.status === "out") && s.suggestedQty > 0)
    .sort((a, b) => {
      // Most urgent = fewest days of cover left. Anything already out ranks
      // above everything with stock, however thin.
      const aCover = a.status === "out" ? -1 : (a.daysOfCover ?? Infinity);
      const bCover = b.status === "out" ? -1 : (b.daysOfCover ?? Infinity);
      return aCover - bCover;
    });
}

/** The breakout alert restored from v1: a colourway outselling its siblings
 *  while stock runs down. Requires no configuration at all. */
export async function getBreakouts(wid) {
  const signals = await getInventorySignals(wid);
  return signals
    .filter((s) => s.isBreakout)
    .sort((a, b) => (b.breakoutRatio ?? 0) - (a.breakoutRatio ?? 0));
}

/**
 * variantId -> status, for screens that need to badge a row without pulling
 * the whole signal. One shared definition of "low", so the dashboard, the
 * inventory list and the intelligence screen can never disagree about the
 * same SKU -- which they could, and did, when each held its own threshold.
 */
export async function getVariantStatuses(wid) {
  const signals = await getInventorySignals(wid);
  const byVariant = new Map();
  signals.forEach((s) => {
    byVariant.set(s.variantId, {
      status: s.status,
      daysOfCover: s.daysOfCover,
      velocityPerDay: s.velocityPerDay,
      reorderPoint: s.reorderPoint,
      reorderPointSource: s.reorderPointSource,
      isBreakout: s.isBreakout,
    });
  });
  return byVariant;
}
