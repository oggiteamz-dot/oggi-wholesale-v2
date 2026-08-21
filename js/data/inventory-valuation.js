// OGGI Wholesale v2 — stock valuation and dead stock (Batch 3, migrations 072/073/075)
//
// Restores two things v1 had and the 2.0 rewrite dropped: a headline stock
// valuation (cost / list price / margin) and the aggregate money tied up in
// dead stock.
//
// THE ONE IDEA THIS FILE EXISTS TO PROTECT.
// Measured on production before any of it was written:
//
//     omni  2,960 units  100% carry a cost
//     sq    1,538 units  100%
//     test  1,400 units    0%   <-- zero
//     demo    495 units  100%
//
// A plain SUM(qty x cost) tells wholesaler `test` their stock is worth $0.00.
// That is not "worthless", it is "unknown", and the two are opposite
// instructions: one says panic, the other says go and fill in your costs.
//
// So every figure arrives with its COVERAGE, and the UI is expected to show
// it. An unpriced unit is excluded from the total and counted separately --
// never silently multiplied by zero.
//
// The arithmetic itself is server-side and has to be: migration 031 revoked
// the `cost` column from `authenticated` at the column level, so a wholesaler
// cannot read their own costs directly by design. The RPC returns totals, not
// a per-variant cost list the browser would have to be trusted with.

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * The whole valuation picture in one row.
 *
 * Returns null on failure rather than a zeroed object, so a caller cannot
 * mistake "the query failed" for "you have no stock" -- the same distinction
 * this batch exists to make.
 */
export async function getInventoryValuation(wid) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_inventory_valuation", { p_wid: wid || null })
  );
  if (error || !data || !data.length) return null;
  const r = data[0];
  const num = (v) => (v == null ? null : Number(v));
  return {
    unitsOnHand:       Number(r.units_on_hand),
    unitsValued:       Number(r.units_valued),
    unitsUnvalued:     Number(r.units_unvalued),
    variantsTotal:     Number(r.variants_total),
    variantsValued:    Number(r.variants_valued),
    variantsUnvalued:  Number(r.variants_unvalued),
    // null when nothing is on hand: "no coverage" and "0% coverage" differ.
    coveragePct:       num(r.coverage_pct),
    valueAtCost:       Number(r.value_at_cost),
    valueAtPrice:      Number(r.value_at_price),
    marginValue:       Number(r.margin_value),
    // null when nothing could be valued. Never rendered as 0%.
    marginPct:         num(r.margin_pct),
    deadUnits:         Number(r.dead_units),
    deadVariants:      Number(r.dead_variants),
    deadValueAtCost:   Number(r.dead_value_at_cost),
    // Stock with no recorded arrival. NOT dead -- just undateable.
    unknownAgeUnits:   Number(r.unknown_age_units),
    unknownAgeVariants:Number(r.unknown_age_variants),
    deadStockDays:     Number(r.dead_stock_days),
    velocityWindowDays:Number(r.velocity_window_days),
  };
}

/** True when the valuation is computed over every unit on the floor. Used to
 *  decide whether the screen shows a number plainly or shows it with a
 *  caveat attached -- a partial total presented as a total is a lie. */
export function isFullyCosted(v) {
  return !!v && v.unitsOnHand > 0 && v.unitsUnvalued === 0;
}
