// OGGI Wholesale v2 — bulk price changes, recorded and reversible (Batch 6)
//
// WHAT THIS REPLACES
// ------------------
// The Products screen used to carry "Bulk price update (all products)": one
// number, one button, no confirmation, and a loop in the BROWSER issuing one
// UPDATE per variant. Three problems, each enough on its own to lose a
// catalogue:
//
//   * the previous price was overwritten and stored nowhere, so there was no
//     undo and no way to answer "what was this before". A wholesaler who typed
//     100 meaning 10 doubled every price permanently, in one click;
//   * N sequential round trips is not atomic -- close the laptop halfway and
//     the catalogue is half repriced, with nothing recording which half;
//   * archived products and archived variants were repriced too.
//
// Everything now happens in one server-side statement (migration 078), writing
// a row per variant to v2_price_changes. See that migration's header for why a
// log table rather than reusing compare_at_price, and why the undo is
// conditional.

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * What a change WOULD do, from the same query that will do it.
 *
 * The preview and the apply select their rows with identical predicates on the
 * server. Two different definitions of "which variants" is how a preview ends
 * up describing a different change from the one that runs -- and a preview the
 * reader cannot trust is worse than no preview, because it converts a careful
 * person into a confident one.
 *
 * Returns { variantCount, minBefore, maxBefore, minAfter, maxAfter,
 *           totalBefore, totalAfter, skippedArchived } or null on failure.
 */
export async function previewBulkPrice(wid, pct, { includeArchived = false } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_bulk_price_preview", { p_wid: wid, p_pct: pct, p_include_archived: includeArchived })
  );
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    variantCount: Number(row.variant_count || 0),
    minBefore: row.min_before != null ? Number(row.min_before) : null,
    maxBefore: row.max_before != null ? Number(row.max_before) : null,
    minAfter: row.min_after != null ? Number(row.min_after) : null,
    maxAfter: row.max_after != null ? Number(row.max_after) : null,
    totalBefore: Number(row.total_before || 0),
    totalAfter: Number(row.total_after || 0),
    skippedArchived: Number(row.skipped_archived || 0),
  };
}

/** Applies the change. Returns { ok, batchId, variantCount } -- the batchId is
 *  what the undo needs, so the screen keeps it. */
export async function applyBulkPrice(wid, pct, { includeArchived = false, reason = "bulk" } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_bulk_update_prices", { p_wid: wid, p_pct: pct, p_include_archived: includeArchived, p_reason: reason })
  );
  if (error) return { ok: false, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, batchId: row?.batch_id, variantCount: Number(row?.variant_count || 0) };
}

/**
 * Undo one batch.
 *
 * Returns { ok, restored, skipped }. `skipped` is not noise -- it is the count
 * of variants that were edited by hand SINCE the batch ran and were therefore
 * left alone. The screen must say so: an undo that silently declines to undo
 * part of what it undid is as misleading as one that clobbers deliberate work.
 */
export async function revertPriceBatch(batchId) {
  const { data, error } = await sbCall(supabase.rpc("v2_revert_price_batch", { p_batch_id: batchId }));
  if (error) return { ok: false, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, restored: Number(row?.restored || 0), skipped: Number(row?.skipped || 0) };
}

/** Recent batches, newest first, so the screen can offer "undo the last one"
 *  after a reload rather than only within the session that made it. */
export async function recentPriceBatches(wid, limit = 5) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_recent_price_batches", { p_wid: wid, p_limit: limit })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    batchId: r.batch_id,
    changedAt: r.changed_at,
    pctDelta: Number(r.pct_delta),
    reason: r.reason,
    variantCount: Number(r.variant_count || 0),
    reverted: !!r.reverted,
  }));
}

/** How a percentage reads to a person. "+10%" and "−15%", never a bare number
 *  whose sign the reader has to hunt for on the row that repriced everything. */
export function formatPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}%`;
}
