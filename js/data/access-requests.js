// =============================================================================
// OGGI Wholesale v2 — WHERE MY REQUESTS STAND      AC-07, AC-11, PB-01, 30 Aug 2026
// =============================================================================
// A shop asks a wholesaler for access. Until now the answer to "did they get
// it?" and "what happened?" was nothing at all, in either direction.
//
// The complaint this is built from, verbatim, from Shopify Collective:
//   "Without confirmation that suppliers have even seen the request, it makes
//    it nearly impossible to move forward with any certainty, which delays
//    potential sales."
//
// AC-10, 30 Aug 2026: and what happens when the answer was no. The states a
// declined shop can be in are NOT decided here either — the database answers
// `reapply_state` and this module turns it into a sentence. A cooldown the
// browser computes is a cooldown the browser can be talked out of.
//
// ==== NOTHING HERE DECIDES WHAT THE BUYER IS TOLD ==========================
//
// The wording for a decline comes from js/data/decline-reasons.js, which is the
// same list the wholesaler picked from and is asserted against the database's
// own constraint. This module maps rows; it does not author sentences. Two
// places writing buyer-facing wording is two places for it to drift.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";
import { declineWordingForBuyer } from "./decline-reasons.js";

/** Every access request this person has made, newest first.
 *
 *  Returns [] with no session and [] on error — never throws. This renders on
 *  the buyer's own home screen and a throw there takes the whole screen down.
 */
export async function listMyAccessRequests() {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return [];

  const { data, error } = await sbCall(
    supabase.rpc("v2_my_access_requests", { p_account_id: String(accountId) }),
  );
  if (error || !Array.isArray(data)) return [];

  // Fixed field list, matching the function's twelve output columns. No row
  // spread: a column added for one screen must not surface on another because
  // nobody was looking.
  return data.map((r) => ({
    requestId: r.request_id,
    wid: r.wid,
    wholesalerName: r.wholesaler_name,
    brand: r.brand,
    status: r.status,                      // pending | approved | rejected
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    slaHours: r.sla_hours,
    hoursWaiting: r.hours_waiting,
    overdue: !!r.overdue,
    // The buyer NEVER sees reason_code. The wording comes from the shared list.
    declineWording: r.status === "rejected"
      ? declineWordingForBuyer(r.reason_code, r.reason_text)
      : null,
    // AC-10. All five come from the server and none is recomputed here.
    // `superseded` is the older attempts, which are history and not a state;
    // the standing is on exactly one row per wholesaler, the newest.
    attempt: Number(r.attempt) || 1,
    superseded: !!r.superseded,
    reapplyState: r.reapply_state || null,
    canReapply: !!r.can_reapply,
    reapplyAt: r.reapply_at || null,
    reapplyNoteRequired: !!r.reapply_note_required,
    reapplyAdvice: r.reapply_advice || null,
  }));
}

/** What a declined shop may do next, as one sentence.
 *
 *  Returns null when there is nothing to say — approved, still pending, or an
 *  older attempt that has been superseded. A row with nothing to say renders
 *  nothing, rather than an empty box with a heading over it.
 *
 *  ==== WHY THIS TAKES THE SERVER'S WORD FOR IT ============================
 *
 *  Every branch below switches on `reapplyState`, which migration 106 computed.
 *  None of them recomputes a date or counts an attempt. The button this feeds
 *  can therefore be wrong in only one direction — it can offer to send
 *  something the server then refuses, which is a wasted tap — and never in the
 *  other, where it hides a door that is actually open.
 */
export function reapplyStanding(r) {
  if (!r || r.superseded || r.status !== "rejected") return null;
  switch (r.reapplyState) {
    case "ok":
      return r.reapplyNoteRequired
        ? `You can ask again. ${r.reapplyAdvice || "Tell them something they did not have last time."}`
        : "You can ask this store again.";
    case "wait":
      return `You can ask again on ${formatDay(r.reapplyAt)}.`
           + (r.reapplyAdvice ? ` ${r.reapplyAdvice}` : "");
    case "blocked":
      return r.reapplyAdvice
          || "Asking again will not help here — contact the store directly.";
    case "exhausted":
      return "You have asked this store more than once and been turned down. "
           + "Talking to them directly will get further than another request.";
    default:
      return null;
  }
}

/** A date a person would say out loud. Falls back to nothing rather than to
 *  "Invalid Date", which is the kind of string that ends up in a screenshot. */
export function formatDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The sentence under a request. Written here rather than in the view so the
 *  four states are visible in one place and none of them can quietly become a
 *  blank — a pending buyer staring at an unlabelled row is the dead end this
 *  whole feature exists to remove. */
export function requestStanding(r) {
  if (!r) return "";
  if (r.status === "approved") return "Approved — you can shop here now.";
  if (r.status === "rejected") return r.declineWording || "This store declined the request.";
  if (r.overdue) {
    return `Still waiting. This is longer than ${r.wholesalerName} usually takes`
         + `${r.slaHours ? ` (about ${humanHours(r.slaHours)})` : ""} — it is worth chasing them directly.`;
  }
  return `With ${r.wholesalerName}. They usually answer within ${humanHours(r.slaHours)}.`;
}

/** Hours as something a person would say out loud. 48 is "2 days", not
 *  "48 hours", and 1 is "an hour" rather than "1 hours". */
export function humanHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return "a short time";
  if (n === 1) return "an hour";
  if (n < 24) return `${n} hours`;
  const d = Math.round(n / 24);
  return d === 1 ? "a day" : `${d} days`;
}
