// OGGI Wholesale v2 — landed cost tracking (Batch 9)
// Records the real freight/duty/other costs attached to a specific stock
// receipt, on top of the variant's own base unit cost, so downstream GMROI
// reporting uses a real per-receipt landed cost rather than just the base
// wholesale cost. Deliberately a side table (v2_receipt_costs, see
// migrations/014) keyed loosely to the receiving movement rather than a
// required column on the core ledger -- most receipts (and every count
// correction/manual adjustment) have no landed-cost detail at all.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Records one receipt's landed cost. `qty` and `baseCost` (the variant's
 * own per-unit cost) come from the caller since this module doesn't fetch
 * the variant itself -- keeps this a pure write path. Best-effort links to
 * the actual v2_inventory_movements row the receipt just created (looked up
 * by variant/location/reference right after the RPC call, since
 * v2_receive_stock returns a balance row, not the movement's id) -- if that
 * lookup doesn't find a match for any reason, the cost entry is still saved
 * with movement_id left null rather than losing the cost data over a
 * best-effort traceability link. */
export async function recordReceiptCost({ variantId, locationId, qty, baseCost, freightCost, dutyCost, otherCost, referenceType }) {
  const freight = Number(freightCost) || 0;
  const duty = Number(dutyCost) || 0;
  const other = Number(otherCost) || 0;
  const landedUnitCost = (Number(baseCost) || 0) + (freight + duty + other) / qty;

  let movementId = null;
  const { data: recentMovement } = await sbCall(
    supabase.from("v2_inventory_movements")
      .select("id")
      .eq("variant_id", variantId).eq("location_id", locationId)
      .eq("movement_type", "receive")
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle()
  );
  if (recentMovement) movementId = recentMovement.id;

  return sbCall(supabase.from("v2_receipt_costs").insert({
    movement_id: movementId, variant_id: variantId, qty,
    freight_cost: freight, duty_cost: duty, other_cost: other,
    landed_unit_cost: landedUnitCost,
  }).select().single());
}

/** Latest landed cost per variant (most recent receipt with cost detail
 * wins) for the given variant ids, used by the GMROI report -- variants
 * with no recorded landed cost simply aren't in the returned map, and the
 * report falls back to the variant's own base `cost` for those. */
export async function getLatestLandedCosts(variantIds) {
  if (!variantIds.length) return new Map();
  const { data } = await sbCall(
    supabase.from("v2_receipt_costs").select("variant_id, landed_unit_cost, created_at").in("variant_id", variantIds).order("created_at", { ascending: false })
  );
  const byVariant = new Map();
  (data || []).forEach((row) => {
    if (!byVariant.has(row.variant_id)) byVariant.set(row.variant_id, Number(row.landed_unit_cost));
  });
  return byVariant;
}
