// OGGI Wholesale v2 — inventory intelligence (Batch 9)
// Reorder-point automation, GMROI/aging/sell-through reporting, and
// ABC-tiered cycle counting. All three read from real data already in the
// database (v2_inventory_movements/balances, v2_order_items, the landed
// costs recorded by js/data/landed-cost.js) -- nothing here is simulated or
// pre-seeded. Classification (ABC tier) is derived live every call rather
// than stored, same "don't cache a snapshot that goes stale" principle
// Batch 7 used for its sell-through ratio suggestion.

import { supabase, sbCall } from "../lib/supabase-client.js";
import { getLatestLandedCosts } from "./landed-cost.js";
import { adjustStock } from "./inventory-admin.js";
import { getInventorySettings } from "./inventory-settings.js";

async function loadVariantsWithBalances(wid) {
  const { data: products } = await sbCall(supabase.from("v2_products").select("id,name").eq("wid", wid).eq("archived", false));
  if (!products || !products.length) return [];
  const productNameById = new Map(products.map((p) => [p.id, p.name]));
  const productIds = products.map((p) => p.id);

  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("*").in("product_id", productIds).eq("archived", false)
  );
  if (!variants || !variants.length) return [];
  const variantIds = variants.map((v) => v.id);

  // Live view, not the table (064): this feeds reorder and dead-stock
  // intelligence, so a phantom "reserved" here becomes a wrong buying decision.
  const { data: balances } = await sbCall(supabase.from("v2_inventory_balances_live").select("*").in("variant_id", variantIds));
  const balByVariant = new Map();
  (balances || []).forEach((b) => {
    const cur = balByVariant.get(b.variant_id) || { onHand: 0, reserved: 0 };
    cur.onHand += Number(b.qty_on_hand);
    cur.reserved += Number(b.qty_reserved);
    balByVariant.set(b.variant_id, cur);
  });

  return variants.map((v) => {
    const bal = balByVariant.get(v.id) || { onHand: 0, reserved: 0 };
    return {
      variantId: v.id, productId: v.product_id,
      productName: productNameById.get(v.product_id) || "—",
      sku: v.sku, color: v.extra_attrs?.color, size: v.extra_attrs?.size,
      cost: v.cost != null ? Number(v.cost) : 0,
      onHand: bal.onHand, reserved: bal.reserved, available: bal.onHand - bal.reserved,
      reorderPoint: v.reorder_point, reorderQty: v.reorder_qty, leadTimeDays: v.lead_time_days,
    };
  });
}

// The signal itself now lives in js/data/inventory-signals.js so that
// js/data/inventory-admin.js can use it too without an import cycle (this
// file already imports adjustStock from there). Re-exported here so nothing
// that used to import it from this module breaks.
export { getInventorySignals, getReorderSuggestions, getBreakouts, getVariantStatuses } from "./inventory-signals.js";

// ---------- GMROI / aging / sell-through report + ABC classification ----------

/** Full inventory intelligence report: one row per active variant, with
 * trailing-period sales, GMROI, an aging bucket, sell-through rate, and an
 * ABC tier derived from this variant's share of trailing revenue. */
export async function getInventoryIntelligenceReport(wid, { trailingDays } = {}) {
  // Batch 1: the trailing window is the wholesaler's own setting, not a
  // constant. It still DEFAULTS to 90 -- the number that was hardcoded here
  // -- so no wholesaler's existing report changes value the day this ships.
  // Only the ability to change it is new.
  if (trailingDays == null) {
    const { settings } = await getInventorySettings(wid);
    trailingDays = settings.velocityWindowDays;
  }
  const variants = await loadVariantsWithBalances(wid);
  if (!variants.length) return { rows: [], trailingDays, generatedAt: new Date().toISOString() };
  const variantIds = variants.map((v) => v.variantId);

  const since = new Date(Date.now() - trailingDays * 86400000).toISOString();
  const { data: orders } = await sbCall(supabase.from("v2_orders").select("id").eq("wid", wid).gte("created_at", since));
  const salesByVariant = new Map();
  if (orders && orders.length) {
    const { data: items } = await sbCall(
      supabase.from("v2_order_items").select("variant_id, qty, unit_price").in("order_id", orders.map((o) => o.id)).in("variant_id", variantIds)
    );
    (items || []).forEach((it) => {
      const cur = salesByVariant.get(it.variant_id) || { qty: 0, revenue: 0 };
      cur.qty += it.qty;
      cur.revenue += it.qty * Number(it.unit_price);
      salesByVariant.set(it.variant_id, cur);
    });
  }

  const { data: receiveMovements } = await sbCall(
    supabase.from("v2_inventory_movements").select("variant_id, created_at").eq("movement_type", "receive").in("variant_id", variantIds).order("created_at", { ascending: false })
  );
  const lastReceivedByVariant = new Map();
  (receiveMovements || []).forEach((m) => { if (!lastReceivedByVariant.has(m.variant_id)) lastReceivedByVariant.set(m.variant_id, m.created_at); });

  const landedCosts = await getLatestLandedCosts(variantIds);
  const now = Date.now();

  const rows = variants.map((v) => {
    const sales = salesByVariant.get(v.variantId) || { qty: 0, revenue: 0 };
    const landedCost = landedCosts.get(v.variantId) ?? v.cost;
    const cogs = sales.qty * landedCost;
    const grossMargin = sales.revenue - cogs;
    const avgInventoryValue = v.onHand * landedCost;
    const gmroi = avgInventoryValue > 0 ? grossMargin / avgInventoryValue : null;
    const sellThroughDenom = sales.qty + v.onHand;
    const sellThroughPct = sellThroughDenom > 0 ? Math.round((sales.qty / sellThroughDenom) * 1000) / 10 : null;

    const lastReceivedAt = lastReceivedByVariant.get(v.variantId) || null;
    const agingDays = lastReceivedAt ? Math.floor((now - new Date(lastReceivedAt).getTime()) / 86400000) : null;
    const agingBucket = v.onHand <= 0 ? "No stock" : agingDays == null ? "Never received" : agingDays <= 30 ? "0–30d" : agingDays <= 60 ? "31–60d" : agingDays <= 90 ? "61–90d" : "90d+";

    return {
      ...v, unitsSold: sales.qty, revenue: sales.revenue, landedCost,
      grossMargin, gmroi, sellThroughPct, lastReceivedAt, agingDays, agingBucket,
    };
  });

  // ABC classification: sort by trailing revenue desc, tier by cumulative
  // share of TOTAL revenue (classic Pareto cut at 80%/95%). If there's no
  // trailing revenue at all across the whole catalog, nothing can honestly
  // be classified -- every row gets tier=null rather than a meaningless
  // "everything is A" from a 0/0 cumulative share.
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const byRevenueDesc = [...rows].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;
  const tierByVariant = new Map();
  byRevenueDesc.forEach((r) => {
    if (totalRevenue <= 0) { tierByVariant.set(r.variantId, null); return; }
    cumulative += r.revenue;
    const cumPct = cumulative / totalRevenue;
    tierByVariant.set(r.variantId, cumPct <= 0.8 ? "A" : cumPct <= 0.95 ? "B" : "C");
  });
  rows.forEach((r) => { r.abcTier = tierByVariant.get(r.variantId); });

  return { rows, trailingDays, generatedAt: new Date().toISOString() };
}

// ---------- ABC-tiered cycle counting ----------

const CYCLE_FREQUENCY_DAYS = { A: 30, B: 90, C: 180 };
const DEFAULT_FREQUENCY_DAYS = 180; // unclassified (no trailing sales data) -- least urgent, not skipped entirely

export async function getCycleCountSchedule(wid) {
  const { rows } = await getInventoryIntelligenceReport(wid);
  if (!rows.length) return [];

  const { data: counts } = await sbCall(
    supabase.from("v2_cycle_counts").select("variant_id, counted_at").eq("wid", wid).order("counted_at", { ascending: false })
  );
  const lastCountByVariant = new Map();
  (counts || []).forEach((c) => { if (!lastCountByVariant.has(c.variant_id)) lastCountByVariant.set(c.variant_id, c.counted_at); });

  const now = Date.now();
  return rows.map((r) => {
    const frequencyDays = CYCLE_FREQUENCY_DAYS[r.abcTier] || DEFAULT_FREQUENCY_DAYS;
    const lastCountedAt = lastCountByVariant.get(r.variantId) || null;
    const daysSinceCount = lastCountedAt ? Math.floor((now - new Date(lastCountedAt).getTime()) / 86400000) : Infinity;
    return {
      variantId: r.variantId, sku: r.sku, productName: r.productName, color: r.color, size: r.size,
      onHand: r.onHand, abcTier: r.abcTier, frequencyDays, lastCountedAt, daysSinceCount,
      due: daysSinceCount >= frequencyDays,
    };
  }).sort((a, b) => (b.daysSinceCount - b.frequencyDays) - (a.daysSinceCount - a.frequencyDays));
}

/** Logs a physical count and, if it differs from the system's expected
 * qty, applies the correction through the SAME v2_receive_stock/
 * v2_decrement_stock-backed adjustStock() the manual inventory screen
 * already uses (Batch 3) -- a cycle count is just a more disciplined way
 * of triggering the same correction path, never a second way to mutate
 * balances. */
export async function logCycleCount(wid, { variantId, locationId, expectedQty, countedQty, countedBy }) {
  const variance = countedQty - expectedQty;
  const { error: insertError } = await sbCall(
    supabase.from("v2_cycle_counts").insert({
      wid, variant_id: variantId, location_id: locationId,
      expected_qty: expectedQty, counted_qty: countedQty, variance, counted_by: countedBy || null,
    })
  );
  if (insertError) return { ok: false, error: insertError };

  if (variance !== 0) {
    const { error: adjustError } = await adjustStock(variantId, locationId, variance, `Cycle count correction (expected ${expectedQty}, counted ${countedQty})`);
    if (adjustError) return { ok: false, error: adjustError, variance };
  }
  return { ok: true, variance };
}
