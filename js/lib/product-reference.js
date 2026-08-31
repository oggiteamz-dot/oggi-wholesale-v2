// =============================================================================
// OGGI Wholesale v2 — THE PRODUCT REFERENCE                     MK-02, 1 Sep 2026
// =============================================================================
// Wholesale buyers quote references, not names. In the reference app Hadi sent
// (MyStories Moow) the reference is its own labelled field on the product page
// — `Product reference  SG3286B` — and it is printed under every card in the
// feed and beside every line in the cart, because "send me 12 of SG3286B" is
// how the order actually gets placed over WhatsApp.
//
// In this data set the reference is not a column. It is glued to the front of
// the product name — "L-137 Relaxed Pima Tee" — so it has to be split back out
// for display. (v2_products.source_ref does hold it, but the feed returns the
// name, and adding a column to a function's return type is a change with a
// blast radius; splitting a string in the browser is not.)
//
// WHY ITS OWN IMPORT-FREE MODULE
// js/data/marketplace-feed.js imports supabase-client, which touches `window`
// at module load, so a Node gate cannot import anything defined in there — the
// same wall hit with login-doors.js. Pure string logic that a gate should
// exercise lives on its own.
//
// THE RULE: conservative. When in doubt, return no reference and let the caller
// print the whole name. A missed reference costs a small piece of polish; a
// wrong one puts "24" in bold above a product called "24 Hour Tee" and makes
// the app look like it cannot read.
// =============================================================================

/**
 * Split "L-137 Relaxed Pima Tee" into { ref: "L-137", rest: "Relaxed Pima Tee" }.
 *
 * A reference must:
 *   - be the first whitespace-delimited token,
 *   - be 2 to 8 characters,
 *   - contain at least one DIGIT, and
 *   - contain at least one LETTER.
 *
 * The letter requirement is the one doing the real work. Without it "24 Hour
 * Tee" splits to ref "24", which was the first thing this got wrong. Every real
 * reference in this catalogue carries a letter — L-137, A-102, W-209, P-101,
 * SG3286B — and a bare number at the front of a name is almost always part of
 * the name.
 *
 * @param {string} name
 * @returns {{ref: string|null, rest: string}} ref is null when there is none,
 *   and `rest` is then the untouched original, so a caller can always render
 *   `ref ? ref + " " + rest : rest` and get the input back.
 */
export function splitReference(name) {
  const raw = String(name == null ? "" : name).trim();
  const m = /^(\S{2,8})\s+(\S.*)$/.exec(raw);
  if (!m) return { ref: null, rest: raw };
  const ref = m[1];
  if (!/\d/.test(ref)) return { ref: null, rest: raw };
  if (!/[A-Za-z]/.test(ref)) return { ref: null, rest: raw };
  // A token that is mostly punctuation is not a reference either.
  if (!/^[A-Za-z0-9][A-Za-z0-9./-]*$/.test(ref)) return { ref: null, rest: raw };
  return { ref, rest: m[2] };
}
