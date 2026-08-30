// =============================================================================
// OGGI Wholesale v2 — THE PREVIOUS APPLICATION, ATTACHED          AC-10, 30 Aug 2026
// =============================================================================
// A shop asks a wholesaler for access, is turned down, and asks again. Before
// this, the second request arrived looking exactly like a first one: same card,
// same two buttons, nothing joining it to the decision already made. The
// wholesaler reviewed the same shop blind, and could not have known.
//
// ==== WHY THIS IS A COMPONENT AND NOT TWO BLOCKS OF MARKUP =================
//
// Two screens review access requests -- the wholesaler's own queue and the
// owner console -- and both had their own hand-rolled card. Written twice, this
// would drift within a month, and the way anybody would find out is a
// wholesaler on one screen deciding without history that the other screen
// shows. That is the exact failure README.md's "don't duplicate helpers"
// section was written about, where an escape helper reached fourteen copies
// under four names and three of the seven `pageHeader`s silently lost the
// ability to host a button.
//
// ==== IT RENDERS NOTHING FOR A FIRST APPLICATION ===========================
//
// Not an empty box, not "no previous applications" -- nothing. Most requests
// are first requests, and a reassurance repeated on every card is noise that
// teaches people to stop reading the cards.
// =============================================================================

import { DECLINE_REASONS } from "../data/decline-reasons.js";

/** The wholesaler-facing wording for a decline reason.
 *
 *  DELIBERATELY THE `label`, NOT THE `buyer` SENTENCE. The buyer's version is
 *  written to be read by the shop it is about ("we could not confirm the
 *  details of your shop"); the wholesaler is reading their own note back and is
 *  owed the words they picked from ("We could not verify the shop"). Same
 *  shared list, the half meant for this reader. */
function reasonLabel(code) {
  const r = DECLINE_REASONS.find((x) => x.value === code);
  return r ? r.label : null;
}

/** A block describing the request this one replaces, or null when there is
 *  none. `r` is a row from v2_pending_access_requests.
 *
 *  Everything here comes from that row. Nothing is fetched, because a second
 *  round trip would land AFTER the Approve and Decline buttons are already
 *  live -- which would make the fastest route to a decision the uninformed one,
 *  and that is the whole defect this exists to close. */
export function priorApplication(r) {
  const attempt = Number(r?.attempt) || 1;
  const priorCount = Number(r?.prior_count) || 0;
  if (attempt <= 1 && priorCount === 0) return null;

  const box = document.createElement("div");
  box.className = "prior-app";
  // On the element, not only in the copy: a gate asserting that history is
  // shown must not have to grep for a sentence somebody may improve later.
  box.setAttribute("data-attempt", String(attempt));
  box.setAttribute("data-prior-count", String(priorCount));

  const head = document.createElement("p");
  head.className = "prior-app-head";
  head.textContent = attempt > 1
    ? `Application ${attempt} from this shop.`
    : `This shop has asked ${priorCount === 1 ? "once" : priorCount + " times"} before.`;
  box.appendChild(head);

  // A count with no linked row: they asked before, under a different account or
  // before the chain existed, and we can say so but not what was decided.
  // Saying "asked before" and nothing else is more useful than saying nothing,
  // and far more honest than implying we know why.
  if (!r.prior_id) {
    const p = document.createElement("p");
    p.className = "prior-app-line";
    p.textContent = "The earlier request is not linked to this one, so what was "
                  + "decided then is not shown here.";
    box.appendChild(p);
    return box;
  }

  const when = r.prior_decided_at ? new Date(r.prior_decided_at) : null;
  const label = reasonLabel(r.prior_reason_code);

  const decided = document.createElement("p");
  decided.className = "prior-app-line";
  decided.textContent = "Last time: "
    + (label || "declined")
    + (r.prior_reason_text ? ` — ${r.prior_reason_text}` : "")
    + (when && !Number.isNaN(when.getTime())
        ? `, on ${when.toLocaleDateString()}` : "")
    + (r.prior_by ? `, by ${r.prior_by}` : "")
    + ".";
  box.appendChild(decided);

  if (r.prior_note) {
    const said = document.createElement("p");
    said.className = "prior-app-line prior-app-said";
    // EVERY LINE IN THIS FILE IS textContent, NOT innerHTML, and this one is
    // why it matters: the quote is a buyer-typed string being shown to a
    // wholesaler. It needs no escape helper because it is never parsed as
    // markup -- which is a stronger guarantee than remembering to call one.
    said.textContent = `They said then: “${r.prior_note}”`;
    box.appendChild(said);
  }

  return box;
}
