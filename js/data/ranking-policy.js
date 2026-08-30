// =============================================================================
// OGGI Wholesale v2 — THE PUBLISHED RANKING PARAMETERS          SR-05, 30 Aug 2026
// =============================================================================
// The numbers behind the published ranking policy, read LIVE from the database
// on every render.
//
// ==== WHY THIS EXISTS AT ALL ===============================================
//
// The obvious way to publish a ranking policy is to type the numbers into the
// page. That page is wrong the first time somebody changes a number, and
// nothing anywhere will say so — which turns a page written to build trust
// into a misrepresentation. That is the single exposure the 28 August research
// identified as actually reaching a company this size, and it would be
// self-inflicted.
//
// So: the page holds the prose, the database holds the numbers, and the page
// reads them every time it is opened. A published policy that CANNOT go stale
// is worth more than a more detailed one that can.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** The ranking numbers as they stand right now.
 *
 *  Returns a plain object keyed by parameter name, so the page can ask for one
 *  by name instead of searching an array. Returns null — NOT an empty object —
 *  when the numbers could not be read, because "we could not fetch this" and
 *  "there are no parameters" must not render the same way. A policy page that
 *  silently shows blanks where numbers belong is worse than one that says it
 *  could not load them.
 */
export async function publishedRankingParameters() {
  const { data, error } = await sbCall(
    supabase.rpc("v2_ranking_parameters_published"),
  );
  if (error || !Array.isArray(data)) return null;
  const out = {};
  for (const r of data) {
    // Fixed field list — the RPC returns exactly three columns and a fourth
    // would be a disclosure decision, not something to spread in by accident.
    out[r.key] = { intValue: r.int_value, textValue: r.text_value };
  }
  return out;
}
