// =============================================================================
// OGGI Wholesale v2 — THE COLOUR x SIZE GRID, in one place    (CNT-00, 6 Sep 2026)
// =============================================================================
// Four helpers that answer "what does this product's grid look like?":
// which colours, which sizes, which variant sits at a given intersection, and
// what a colour actually looks like.
//
// WHY THEY MOVED HERE
// They were private functions inside js/components/order-setup.js, written for
// the pack builder. The receive screen needs exactly the same four answers,
// and this repo's own rule -- stated in js/views/wholesaler.js and enforced by
// check_cross_module_imports -- is that a helper copy-pasted into two places is
// a bug waiting for one copy to be fixed. So this is a MOVE, not a fork:
// order-setup.js now imports them and holds no second definition.
//
// If the two screens ever disagree about which colours a product has, the
// wholesaler is looking at a grid on one screen that does not exist on the
// other, and there is no way to tell which is right.
//
// This module deliberately imports nothing except the size ordering, so a Node
// gate can exercise it without a browser or a database.
// =============================================================================
import { sortSizes } from "./size-order.js";

/** Colour names of a product, in the order its variants were created.
 *  Creation order, not alphabetical: the wholesaler entered them in the order
 *  the garment actually comes, and re-sorting that is a small lie about the
 *  range. */
export function coloursOf(product) {
  const seen = [];
  (product?.variants || []).forEach((v) => {
    const c = v.extra_attrs?.color ?? v.color;
    if (c && !seen.includes(c)) seen.push(c);
  });
  return seen;
}

/** Size names. Left-to-right order matters: a size run read out of order turns
 *  "2 Small, 3 Medium" into nonsense, and a curve written 2-3-3-2 against the
 *  wrong column order fills the wrong boxes. */
export function sizesOf(product) {
  const seen = [];
  (product?.variants || []).forEach((v) => {
    const s = v.extra_attrs?.size ?? v.size;
    if (s && !seen.includes(s)) seen.push(s);
  });
  return seen;
}

/** Sizes in TRADE order (XS S M L XL, or 36 38 40 42), not entry order.
 *  Separate from sizesOf() on purpose: order-setup has always used entry
 *  order and changing it there would silently reorder every existing pack's
 *  columns, which is a different decision from the one this file is making. */
export function sizesInOrder(product) {
  return sortSizes(sizesOf(product));
}

/** The variant at one intersection, or null where the wholesaler simply does
 *  not make that colour in that size. A null cell is a real answer and the
 *  grid must render it as unavailable rather than as zero -- "we do not make
 *  it" and "we received none" are different statements. */
export function variantAt(product, colour, size) {
  return (product?.variants || []).find((v) => {
    const c = v.extra_attrs?.color ?? v.color;
    const s = v.extra_attrs?.size ?? v.size;
    return c === colour && s === size;
  }) || null;
}

/**
 * Swatch and photo for a colour.
 *
 * Hadi, 24 Aug 2026: "I can read blue, green, navy, whatever. I don't know if
 * these are the right names for them, and I might forget... I want to see the
 * actual colour. Also I want to see the small image of the product."
 *
 * A word is the weakest possible identifier here: "Navy" and "Blue" are two
 * taps apart in a grid and nothing on screen distinguishes them. On a receive
 * screen that matters more than on the pack builder, because the person is
 * looking at actual garments in actual boxes while they type.
 */
export function colourMeta(product, colour) {
  const vs = (product?.variants || []).filter((v) => (v.extra_attrs?.color ?? v.color) === colour);
  const hex = vs.map((v) => v.extra_attrs?.colorHex ?? v.colorHex).find(Boolean) || "#999";
  // First real photo on any variant of this colour. image_url first, then the
  // images array -- the same order js/data/catalog.js resolves them in, so the
  // wholesaler sees the picture the buyer will see rather than a second guess.
  const image = vs.map((v) => v.image_url || (Array.isArray(v.images) ? v.images[0] : null)).find(Boolean) || null;
  return { hex, image };
}
