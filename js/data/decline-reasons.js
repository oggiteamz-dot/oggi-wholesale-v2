// =============================================================================
// OGGI Wholesale v2 — WHY AN ACCESS REQUEST WAS DECLINED         AC-08, 30 Aug 2026
// =============================================================================
// ONE list, used by the owner console and the wholesaler's own requests screen,
// and matched against the database's own constraint by
// checks/check_access_decisions_client.mjs.
//
// ==== WHY THIS IS A SHARED FILE AND NOT TWO ARRAYS =========================
//
// There are two screens that decline a request. Two copies of this list would
// disagree within a month, and the way you would find out is a wholesaler
// clicking Decline and getting a constraint violation they cannot read. The
// gate asserts these codes are exactly the ones migration 104 permits, so the
// screen and the database cannot drift apart at all.
//
// ==== WHY "not_taking_clients" IS ON THE LIST ==============================
//
// Because without it, every decline gets labelled with whichever code is least
// embarrassing to send. A wholesaler at capacity who has to choose between
// telling a real shop "we could not verify you" and "you are not a retailer"
// will pick one of them, and the buyer will read a judgement that was never
// made. The honest answer -- "not you, us" -- has to be available or the whole
// list becomes untrustworthy.
// =============================================================================

/** The permitted decline reasons. `value` MUST match migration 104's check
 *  constraint exactly; `label` is what the wholesaler picks; `buyer` is what
 *  the buyer will eventually be shown (AC-08's other half, built next). */
export const DECLINE_REASONS = [
  {
    value: "not_a_retailer",
    label: "They do not look like a retailer",
    hint: "For consumers or the curious. This is a wholesale account.",
    buyer: "This store sells to retailers, and we could not tell that yours is one.",
  },
  {
    value: "outside_area",
    label: "Outside the area we deliver to",
    hint: "Nothing to do with the shop itself — we just do not reach them.",
    buyer: "This store does not deliver to your area yet.",
  },
  {
    value: "cannot_verify",
    label: "We could not verify the shop",
    hint: "The details did not check out, or there was not enough to go on.",
    buyer: "We could not confirm the details of your shop.",
  },
  {
    value: "existing_account",
    label: "They already have access",
    hint: "Same shop, different name or number — the account already exists.",
    buyer: "This shop already has access under another account.",
  },
  {
    value: "not_taking_clients",
    label: "Not taking new clients right now",
    hint: "Capacity. Nothing about the applicant — and worth saying so plainly.",
    buyer: "This store is not taking on new clients at the moment.",
  },
  {
    value: "other",
    label: "Something else (you must explain)",
    hint: "An explanation is required — the database refuses this one without it.",
    buyer: null,   // there is no generic wording; the typed note is the wording
  },
];

/** The wording a buyer is shown for a decline. Falls back to the typed note,
 *  and then to a neutral sentence — never to a blank, and never to the internal
 *  code, which would tell a shop it was marked `not_a_retailer` in exactly the
 *  words we chose not to use to their face. */
export function declineWordingForBuyer(reasonCode, reasonText) {
  const r = DECLINE_REASONS.find((x) => x.value === reasonCode);
  const typed = (reasonText || "").trim();
  if (r && r.value === "other") return typed || "This store declined the request.";
  if (r && r.buyer) return typed ? `${r.buyer} ${typed}` : r.buyer;
  return typed || "This store declined the request.";
}
