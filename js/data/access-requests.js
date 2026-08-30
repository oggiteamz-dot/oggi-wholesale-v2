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
  }));
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
