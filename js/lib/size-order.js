// =============================================================================
// OGGI Wholesale v2 — PUTTING SIZES IN SIZE ORDER                 31 Aug 2026
// =============================================================================
// WHAT WAS WRONG
// --------------
// The buyer's order-sheet built its column headers with:
//
//     [...new Set(product.variants.map((v) => v.size))]
//
// and the comment above it said "in the order the catalogue gave them". The
// catalogue gives them in whatever order Postgres returned the variant rows,
// which is not an order at all. On a live demo catalogue on 31 Aug the
// trucker jacket's columns read:
//
//     XL   S   L   XXL   M
//
// The grid is correct — every cell holds the right number — and it is still
// unusable, because a buyer reads a size grid by position, not by squinting
// at each header. The filter bar had the neighbouring bug: it sorted with
// localeCompare, which is alphabetical, so the chips read L, M, S, XL, XXL.
//
// Both were invisible to every existing check, because nothing asserts the
// ORDER of a list whose CONTENTS are right.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// Three call sites need the same answer — the order sheet's columns, the
// product's `sizes` array, and the filter chips — and three private copies of
// a size table is how they drift. One table, one comparator, one import.
//
// FOUR VOCABULARIES, NOT ONE
// --------------------------
// This product's wholesalers do not share a size language, and a single sort
// has to hold all of them without mixing them together:
//
//   alpha    XS S M L XL XXL 3XL          (jackets, knitwear, tees)
//   numeric  24 26 28 30 …  / 36 37 38 …  (denim waists, EU shoe sizes)
//   age      0-3M 3-6M 6-12M 3-4Y 5-6Y    (childrenswear)
//   one-size OS, ONE SIZE, TU, U          (scarves, bags, jewellery)
//
// Each family gets a BAND, so a product that somehow carries two of them
// keeps them grouped rather than interleaving 28 with L. Within a band the
// rank is numeric and exact. Anything unrecognised keeps its original
// position at the end — an unknown size is never silently reordered into a
// place it does not belong, and never dropped.
// =============================================================================

/** Alpha sizes, smallest first. Both spellings of the doubled sizes are
 *  present because both are written in the trade, and a wholesaler typing
 *  "2XL" must not sort away from one typing "XXL". */
const ALPHA = {
  XXXS: -3, "3XS": -3,
  XXS: -2, "2XS": -2,
  XS: -1,
  S: 0, SM: 0, SMALL: 0,
  M: 1, MED: 1, MEDIUM: 1,
  L: 2, LG: 2, LARGE: 2,
  XL: 3, "1XL": 3,
  XXL: 4, "2XL": 4,
  XXXL: 5, "3XL": 5,
  XXXXL: 6, "4XL": 6,
  "5XL": 7, "6XL": 8,
};

/** One-size labels. They sort FIRST rather than last: a one-size product
 *  normally has exactly this one column, and where it appears beside real
 *  sizes it is the catch-all the others are exceptions to. */
const ONE_SIZE = new Set(["OS", "O/S", "ONE SIZE", "ONESIZE", "ONE-SIZE", "TU", "U", "UNI", "FREE"]);

const BAND_ONE_SIZE = 0;
const BAND_AGE = 1;
const BAND_ALPHA = 2;
const BAND_NUMERIC = 3;
const BAND_UNKNOWN = 9;

/** "0-3M" -> 0, "12-18M" -> 12, "3-4Y" -> 36, "18M" -> 18, "2Y" -> 24.
 *  Returns null when the label is not an age at all. Years are converted to
 *  months so that 18-24M sorts BELOW 3-4Y, which is the whole point — a
 *  string sort puts "18-24M" after "3-4Y" and a newborn range after a
 *  toddler one. */
function ageInMonths(s) {
  const m = /^(\d+)\s*(?:[-–/]\s*\d+\s*)?(M|MO|MTH|MONTHS?|Y|YR|YRS|YEARS?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return /^Y/.test(m[2]) ? n * 12 : n;
}

/** Rank one label: [band, value]. Never throws, never returns undefined. */
function rank(raw) {
  const s = String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, " ");
  if (!s) return [BAND_UNKNOWN, 0];

  if (ONE_SIZE.has(s)) return [BAND_ONE_SIZE, 0];

  const age = ageInMonths(s);
  if (age != null) return [BAND_AGE, age];

  const alphaKey = s.replace(/[\s./-]/g, "");
  if (Object.prototype.hasOwnProperty.call(ALPHA, alphaKey)) return [BAND_ALPHA, ALPHA[alphaKey]];

  // A plain number, or a number with a trade suffix: 30, 32.5, 30W, 41 EU.
  const num = /^(\d+(?:[.,]\d+)?)\s*(?:W|EU|UK|US|CM|FR|IT)?$/.exec(s);
  if (num) return [BAND_NUMERIC, Number(num[1].replace(",", "."))];

  return [BAND_UNKNOWN, 0];
}

/**
 * Sort size labels into the order a buyer expects. Pure, stable, and total:
 * every input label comes out exactly once, unknown labels keep their
 * relative order at the end, and nothing is dropped or renamed.
 *
 * @param {Array<string>} sizes
 * @returns {Array<string>} a NEW array — the input is never mutated, because
 *   two of the three call sites pass an array that other code still holds.
 */
export function sortSizes(sizes) {
  const list = Array.isArray(sizes) ? sizes : [];
  return list
    .map((value, index) => ({ value, index, r: rank(value) }))
    .sort((a, b) => {
      if (a.r[0] !== b.r[0]) return a.r[0] - b.r[0];
      if (a.r[1] !== b.r[1]) return a.r[1] - b.r[1];
      // Same rank (two spellings of one size, or two unknowns): first seen
      // wins, so the result is stable across renders.
      return a.index - b.index;
    })
    .map((x) => x.value);
}

/** The comparator on its own, for a caller that is sorting something bigger
 *  than a list of strings (a row object, say) and needs to key on its size. */
export function compareSizes(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1];
}
