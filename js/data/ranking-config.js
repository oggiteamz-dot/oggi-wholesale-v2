// =============================================================================
// OGGI Wholesale v2 — THE RANKING RECORD                       SR-07, 30 Aug 2026
// =============================================================================
// The numbers that decide what the recommendation shelves show, the permanent
// record of every change ever made to them, and the answer to the only question
// this record exists to answer: WHAT WERE THE RULES ON A GIVEN DAY?
//
// ==== NOTHING HERE DOES THE RECORDING ======================================
//
// Worth stating plainly, because it looks like an omission. The recording is
// done by a database trigger installed in migration 101, NOT by this file.
// That is deliberate: until tonight the only thing that had ever written to
// v2_ranking_config was a hand-typed statement in the Supabase SQL editor, and
// an audit written in JavaScript would have recorded none of it while looking
// perfectly healthy. `setRankingNumber` below is a convenience for the owner,
// not the mechanism. Every path -- this file, a migration, the SQL editor --
// lands in the same record with the same shape.
//
// ==== EVERY CALL IS OWNER-ONLY, CHECKED IN THE DATABASE ====================
//
// The RPCs are SECURITY DEFINER and re-check v2_is_owner() inside themselves.
// A non-owner gets zero rows rather than an error, so nothing here leaks even
// the names of the settings. Hiding the nav item is presentation, not security.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** The ranking numbers as they stand, with who last touched each and why.
 *  Returns [] for anyone who is not the owner, and [] on error — this is
 *  called from a render path and a screen that throws is a screen that is
 *  simply gone.
 */
export async function listRankingConfig() {
  const { data, error } = await sbCall(supabase.rpc("v2_ranking_config_list"));
  if (error || !Array.isArray(data)) return [];
  // Fixed field list, matching the function's nine output columns exactly. No
  // row spread: a column added to the function for one screen must not appear
  // on another because nobody was looking.
  return data.map((r) => ({
    key: r.key,
    intValue: r.int_value,
    textValue: r.text_value,
    note: r.note,
    updatedAt: r.updated_at,
    lastReason: r.last_reason,
    lastActor: r.last_actor,
    lastSource: r.last_source,      // 'app' | 'database'
    changeCount: r.change_count,
  }));
}

/** The timeline of changes, newest first. `key` narrows it to one setting. */
export async function listRankingHistory({ key = null, limit = 200 } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_ranking_history_list", { p_key: key || null, p_limit: limit }),
  );
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => ({
    id: r.id,
    key: r.key,
    op: r.op,                        // baseline | insert | update | delete
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: r.reason,
    actor: r.actor,
    actorSource: r.actor_source,
    changedAt: r.changed_at,
  }));
}

/** What every ranking number WAS at that moment.
 *
 *  Rebuilt in the database from the history, never from the current table —
 *  see the comment on v2_ranking_config_as_of. An empty array means the record
 *  had not begun yet on that date, which is a real answer and not an error.
 *
 *  @param {Date|string} when
 */
export async function rankingConfigAsOf(when) {
  const iso = when instanceof Date ? when.toISOString() : String(when);
  const { data, error } = await sbCall(
    supabase.rpc("v2_ranking_config_as_of", { p_when: iso }),
  );
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => ({
    key: r.key,
    intValue: r.int_value,
    textValue: r.text_value,
    note: r.note,
    asOfEvent: r.as_of_event,
    stillTrue: r.still_true,
  }));
}

/** Change one ranking number. A reason is REQUIRED and is refused server-side
 *  if it is missing — the check below is a courtesy that saves a round trip,
 *  not the enforcement.
 *
 *  Returns { ok, message } and never throws.
 */
export async function setRankingNumber({ key, intValue = null, textValue = null, reason }) {
  if (!key) return { ok: false, message: "No setting was named." };
  if (!reason || reason.trim().length < 5) {
    return {
      ok: false,
      message: "Say why this is changing — it goes into the permanent record, and an entry with no reason is one nobody can explain later.",
    };
  }
  const { data, error } = await sbCall(
    supabase.rpc("v2_ranking_config_set", {
      p_key: key,
      p_int: intValue === null || intValue === "" ? null : Number(intValue),
      p_text: textValue === null || textValue === "" ? null : String(textValue),
      p_reason: reason.trim(),
    }),
  );
  if (error) return { ok: false, message: "Could not save that change." };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, message: row?.message || "" };
}

/** Recompute the whole hash chain. An EMPTY array means the record is intact.
 *  Anything in it is a row that has been altered after the fact.
 */
export async function verifyRankingHistory() {
  const { data, error } = await sbCall(supabase.rpc("v2_ranking_history_verify"));
  if (error || !Array.isArray(data)) return null;   // null = could not check
  return data.map((r) => ({ id: r.bad_id, key: r.bad_key, problem: r.problem }));
}
