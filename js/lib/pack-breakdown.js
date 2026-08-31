// =============================================================================
// OGGI Wholesale v2 — THE PACK BREAKDOWN                        MK-03, 1 Sep 2026
// =============================================================================
// The one line that tells a buyer what is actually inside a carton:
//
//     Packing content    2×36 3×37 3×38 2×39 1×40 1×41
//
// It is the field the reference app (MyStories Moow) prints at the top of every
// product page, and it is the reason their whole buying interface can be one
// row per colour: once the size run is stated once, size stops being a thing
// the buyer picks.
//
// WHAT WAS WRONG
// The card built this string by walking pack.components in Postgres row order:
//
//     pack.components.map(c => `${c.qtyPerPack}×${c.size || c.sku}`).join("/")
//
// A RATIO pack has one component per size, so that read correctly. A SERIES
// pack has one component per COLOUR × SIZE — 24 of them on C-117 across 6
// sizes — and the colour is not in the label, so the same size appeared four
// times over and the line read:
//
//     1x39/1x40/1x39/1x38/1x41/1x40/1x37/1x41/1x36/...
//
// which looks like a catalogue that has entered its sizes four times by
// mistake. Casa Sole and Vantage both ship series packs; both are on screen
// tomorrow.
//
// WHAT THIS DOES
// Aggregates by size label, sums the quantities, and orders the result with the
// one size comparator (js/lib/size-order.js) rather than leaving it in whatever
// order the rows arrived in. C-117 becomes:
//
//     4×36 4×37 4×38 4×39 4×40 4×41
//
// TOTALITY IS THE POINT. This is an aggregation over quantities that a buyer
// reads as "what is in the box", so the sum must survive it exactly. A
// breakdown that quietly drops a component is worse than the duplicated one:
// the duplicated line looks wrong and gets questioned, a short line looks
// right and gets ordered. checks/check_pack_breakdown.mjs asserts the sum on
// every case it has.
//
// DISPLAY ONLY. Nothing here touches pricing or the pieces count — those come
// from priceCart / line-pricing.js, off the same components array, unchanged.
// =============================================================================

import { compareSizes } from "./size-order.js";

/**
 * Aggregate a pack's components into one printable size run.
 *
 * @param {Array<{qtyPerPack:number,size?:string,sku?:string}>} components
 * @param {object}  [o]
 * @param {string}  [o.sep="/"]   what to join the groups with
 * @returns {{rows: Array<{label:string,qty:number}>, text: string, units: number}}
 *   `units` is the total piece count in one pack — the same number
 *   `components.reduce((s,c) => s + c.qtyPerPack, 0)` gives, always.
 */
export function packBreakdown(components, { sep = "/" } = {}) {
  const list = Array.isArray(components) ? components : [];

  // Aggregate first, in first-seen order, so two labels that the comparator
  // ranks equally ("39" and "39 EU") keep the order the pack was built in.
  const byLabel = new Map();
  const order = [];
  let units = 0;

  for (const c of list) {
    if (!c) continue;
    // A component with no size AND no sku still has a quantity, and that
    // quantity is in the carton whether or not we can name it. Label it
    // rather than drop it — see TOTALITY above.
    const label = String(c.size || c.sku || "—").trim() || "—";
    const qty = Number(c.qtyPerPack);
    const n = Number.isFinite(qty) ? qty : 0;
    units += n;
    if (!byLabel.has(label)) {
      byLabel.set(label, 0);
      order.push(label);
    }
    byLabel.set(label, byLabel.get(label) + n);
  }

  const rows = order
    .map((label, index) => ({ label, qty: byLabel.get(label), index }))
    .sort((a, b) => compareSizes(a.label, b.label) || a.index - b.index)
    .map(({ label, qty }) => ({ label, qty }));

  return {
    rows,
    text: rows.map((r) => `${r.qty}×${r.label}`).join(sep),
    units,
  };
}
