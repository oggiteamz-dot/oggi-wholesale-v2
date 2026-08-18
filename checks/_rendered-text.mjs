// =============================================================================
// Asserting against what is ON THE SCREEN
// =============================================================================
// `element.innerText` returns the RENDERED text, after CSS. Badges in this app
// carry `text-transform: uppercase`, so the DOM says "Default" and innerText
// says "DEFAULT". A case-sensitive regex against innerText therefore fails
// while the feature works perfectly.
//
// I made exactly this mistake three times in two days -- "Not stocked yet",
// "Default", and once before that in check_tag_input where an escaped newline
// in page.evaluate source made five assertions fail against working code.
// Every time, the reflex was to go looking at the feature. Every time, the
// test was wrong.
//
// So the rule now has a home: when asserting on rendered text, compare
// case-insensitively and collapse whitespace, because neither casing nor line
// wrapping is what the assertion is about. If a check genuinely cares that a
// label is uppercase, it should assert on the computed style, which is where
// that fact actually lives.
// =============================================================================

/** Normalises rendered text for comparison: case-folded, whitespace collapsed. */
export function normalise(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Does the rendered text contain this phrase, ignoring case and wrapping? */
export function shows(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}
