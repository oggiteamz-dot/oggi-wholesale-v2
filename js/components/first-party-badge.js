// =============================================================================
// OGGI Wholesale v2 — THE FIRST-PARTY BADGE                       OWN-05, 9 Sep
// =============================================================================
// One element, one place. Since 8 Sep 2026 OGGI sells on this platform and its
// products sit in the ORDINARY results rather than a shelf of their own, so
// this badge is the only thing that says whose a product is.
//
// WHY IT IS A FUNCTION AND NOT SIX COPIES OF EIGHT LINES
//
// The badge appears on the directory card, on the "Your requests" row a few
// hundred pixels below it, and on every search result. Copies drift: one gets
// reworded, one loses a border, one stops rendering, and a buyer learns that
// the mark is decorative -- which is the one thing it cannot afford to be.
//
// ⭐ AND BECAUSE IT IS A FUNCTION, checks/check_oggi_label.mjs CAN RENDER IT.
// A badge written inline can only be checked by reading the source, and on
// 9 Sep a source-shaped assertion was shown to survive `if (false && ...)`
// untouched -- it counted the markup and never asked whether the markup was
// reachable. Returning an element or null is a fact a gate can measure.
//
// Returns null for an ordinary store, deliberately: a label on everything
// labels nothing, and `null` is the caller's cue to append nothing at all.
// =============================================================================

/** The "OGGI's own" mark, or null when this is somebody else's store.
 *  @param {boolean} isFirstParty  the SERVER's answer (v2_first_party_wid,
 *                                 migration 131) — never a guess from the name
 *  @param {{inline?: boolean}} [opts]  inline: sits beside text rather than
 *                                 starting its own line
 *  @returns {HTMLElement|null} */
export function firstPartyBadge(isFirstParty, { inline = true } = {}) {
  if (!isFirstParty) return null;
  const own = document.createElement("span");
  own.className = "badge";
  // The hook this gate and every future one finds it by. Not a class name:
  // classes get restyled and renamed, and this is an assertion target.
  own.setAttribute("data-first-party", "1");
  // In words, not a colour. A buyer who cannot see the accent shade still
  // learns whose shop it is, and so does a screen reader.
  own.textContent = "OGGI's own";
  own.style.cssText =
    (inline ? "margin-left:6px;" : "align-self:flex-start;margin-top:2px;")
    + "font-size:9.5px;flex:none;padding:1px 6px;border-radius:999px;"
    + "background:var(--accent-50);color:var(--accent-700,var(--text-secondary));"
    + "border:1px solid var(--accent-500);letter-spacing:.01em;";
  return own;
}
