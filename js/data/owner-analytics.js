// =============================================================================
// OGGI Wholesale v2 — OWNER ANALYTICS (data layer)
// =============================================================================
//
// Thin wrappers over the six functions in migration 039. Deliberately thin:
// every aggregate, every definition of "revenue", every decision about whether
// a cancelled order counts, lives in SQL. Nothing in this file re-derives a
// number, because the moment two places can compute the same figure, they
// eventually disagree and nobody can tell which screen is lying.
//
// If you find yourself about to sum something here, the sum belongs in 039.
//
// WHO MAY CALL THESE  (changed 18 Aug 2026, migration 044)
// --------------------------------------------------------
// Originally owner-only. Now: the OWNER may pass any wid, and a WHOLESALER may
// pass their own and nothing else. The database enforces it, not this file --
// v2_require_owner_or_own(p_wid) raises 42501 inside each RPC. These wrappers
// turn that raise into a plain-English message rather than leaking a Postgres
// error code into the UI.
//
// The wholesaler dashboard therefore calls THESE functions rather than getting
// a parallel set of its own. That is the whole point of migration 044: if the
// owner's drill-down and the wholesaler's dashboard each had their own
// definition of revenue, the two would eventually disagree, in front of a
// customer, with no way to tell which was right.
//
// The names still say `owner`. They are not renamed because a rename touches
// every call site for no behavioural gain and is exactly the sort of change
// that looks free and quietly breaks one caller nobody grepped for.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Turns a Postgres error into something an operator can act on. */
function readable(error) {
  const msg = error?.message || "";
  // Two different refusals, two different fixes -- so they get two different
  // sentences. Collapsing them into one message would tell a wholesaler whose
  // session went stale to go and find owner credentials they do not have.
  if (/only the platform owner/i.test(msg)) {
    return "You are not signed in as the owner. Sign out and back in.";
  }
  if (/only read your own figures/i.test(msg)) {
    return "These figures belong to a different wholesaler. If this is your own dashboard, sign out and back in.";
  }
  if (/fetch|network/i.test(msg)) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return msg || "Something went wrong loading these figures.";
}

/**
 * Headline figures for one wholesaler.
 * @param {string} wid
 * @param {{from?:string|null,to?:string|null}} range  ISO strings; null = unbounded
 */
export async function getWholesalerSummary(wid, { from = null, to = null } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_wholesaler_summary", { p_wid: wid, p_from: from, p_to: to })
  );
  if (error) return { ok: false, error: readable(error) };
  const r = (Array.isArray(data) ? data[0] : data) || {};
  return {
    ok: true,
    orders: Number(r.orders_count || 0),
    revenue: Number(r.revenue || 0),
    avgOrder: Number(r.avg_order_value || 0),
    medianOrder: Number(r.median_order_value || 0),
    units: Number(r.units_sold || 0),
    cancelled: Number(r.cancelled_count || 0),
    cancellationRate: Number(r.cancellation_rate || 0),
    clientsTotal: Number(r.clients_total || 0),
    clientsOrdered: Number(r.clients_ordered || 0),
    clientsNever: Number(r.clients_never || 0),
    clientsNew: Number(r.clients_new || 0),
    productsTotal: Number(r.products_total || 0),
    productsSold: Number(r.products_sold || 0),
    firstOrderAt: r.first_order_at || null,
    lastOrderAt: r.last_order_at || null,
  };
}

export async function getTopProducts(wid, { from = null, to = null, limit = 10 } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_top_products", { p_wid: wid, p_from: from, p_to: to, p_limit: limit })
  );
  if (error) return { ok: false, error: readable(error), rows: [] };
  return {
    ok: true,
    rows: (data || []).map((r) => ({
      productId: r.product_id,
      name: r.product_name,
      units: Number(r.units || 0),
      revenue: Number(r.revenue || 0),
      orders: Number(r.order_count || 0),
      pctOfRevenue: Number(r.pct_of_revenue || 0),
    })),
  };
}

export async function getTopClients(wid, { from = null, to = null, limit = 10 } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_top_clients", { p_wid: wid, p_from: from, p_to: to, p_limit: limit })
  );
  if (error) return { ok: false, error: readable(error), rows: [] };
  return {
    ok: true,
    rows: (data || []).map((r) => ({
      clientId: r.client_id,
      shopName: r.shop_name,
      phone: r.phone,
      orders: Number(r.order_count || 0),
      revenue: Number(r.revenue || 0),
      avgOrder: Number(r.avg_order || 0),
      lastOrderAt: r.last_order_at || null,
      pctOfRevenue: Number(r.pct_of_revenue || 0),
    })),
  };
}

/**
 * Orders / revenue / units per time bucket.
 * Empty buckets come back as zeros, not gaps -- see 039's header for why.
 */
export async function getSalesSeries(wid, { from = null, to = null, bucket = "day" } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_sales_series", { p_wid: wid, p_from: from, p_to: to, p_bucket: bucket })
  );
  if (error) return { ok: false, error: readable(error), rows: [] };
  return {
    ok: true,
    rows: (data || []).map((r) => ({
      at: r.bucket_start,
      orders: Number(r.order_count || 0),
      revenue: Number(r.revenue || 0),
      units: Number(r.units || 0),
    })),
  };
}

/**
 * Per-product sales over time, shaped for a multi-series chart.
 *
 * The RPC returns one row per (bucket, product). Charts want one series per
 * product with a value at every bucket, INCLUDING the buckets where that
 * product sold nothing -- otherwise a line jumps across a gap and implies
 * sales that never happened. The zero-filling happens here rather than in SQL
 * because it is a presentation concern: the raw fact is "no row", and only the
 * chart needs it rendered as a zero.
 *
 * @returns {{ok:boolean, buckets:string[], series:Array<{productId,name,points:number[],total:number}>}}
 */
export async function getProductSeries(wid, {
  from = null, to = null, bucket = "week", productIds = null, metric = "revenue",
} = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_product_series", {
      p_wid: wid, p_product_ids: productIds, p_from: from, p_to: to, p_bucket: bucket,
    })
  );
  if (error) return { ok: false, error: readable(error), buckets: [], series: [] };

  const rows = data || [];
  const buckets = [...new Set(rows.map((r) => r.bucket_start))].sort();
  const index = new Map(buckets.map((b, i) => [b, i]));

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) {
      byProduct.set(r.product_id, {
        productId: r.product_id,
        name: r.product_name,
        points: new Array(buckets.length).fill(0),
        total: 0,
      });
    }
    const s = byProduct.get(r.product_id);
    const v = metric === "units" ? Number(r.units || 0) : Number(r.revenue || 0);
    s.points[index.get(r.bucket_start)] = v;
    s.total += v;
  }

  // Biggest first, so the chart's colour order matches the legend's reading
  // order and slot 1 is always the most important series.
  const series = [...byProduct.values()].sort((a, b) => b.total - a.total);
  return { ok: true, buckets, series };
}

export async function getClientList(wid, { from = null, to = null } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_owner_client_list", { p_wid: wid, p_from: from, p_to: to })
  );
  if (error) return { ok: false, error: readable(error), rows: [] };
  return {
    ok: true,
    rows: (data || []).map((r) => ({
      clientId: r.client_id,
      shopName: r.shop_name,
      phone: r.phone,
      discountPct: Number(r.discount_pct || 0),
      active: r.active !== false,
      createdAt: r.created_at,
      orders: Number(r.order_count || 0),
      revenue: Number(r.revenue || 0),
      units: Number(r.units || 0),
      lastOrderAt: r.last_order_at || null,
    })),
  };
}
