// =============================================================================
// OGGI Wholesale v2 — THE VISIBILITY MIRROR                     SR-06, 29 Aug 2026
// =============================================================================
// Migration 093 made wholesalers a promise: OGGI's paid shelf does not touch
// your ranking. This module is what lets them check it rather than take it on
// trust — their impressions, their average position, and how often somebody
// else's paid placement appeared alongside their product.
//
// NEITHER FUNCTION TAKES A WID, AND THIS MODULE CANNOT SEND ONE.
// The wholesaler is resolved server-side from their own session. A wid
// parameter here would be one careless call away from letting a wholesaler
// read a competitor's visibility, which is the worst thing this data could do.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Headline numbers for the signed-in wholesaler. Null when unavailable —
 *  callers render a "no data yet" state rather than zeroes, because zero
 *  impressions and "we could not ask" are different facts. */
export async function getVisibilityMirror(days = 30) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_search_visibility_mirror", { p_days: days })
  );
  if (error) return null;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r) return null;
  return {
    impressions: Number(r.impressions || 0),
    searches: Number(r.searches || 0),
    avgPosition: r.avg_position == null ? null : Number(r.avg_position),
    outrankedByPaid: Number(r.outranked_by_paid || 0),
    outrankedPct: r.outranked_pct == null ? 0 : Number(r.outranked_pct),
  };
}

/** Which searches showed this wholesaler's products. */
export async function getVisibilityQueries(days = 30, limit = 20) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_search_visibility_queries", { p_days: days, p_limit: limit })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    query: r.q_normalised,
    impressions: Number(r.impressions || 0),
    bestPosition: r.best_position == null ? null : Number(r.best_position),
  }));
}
