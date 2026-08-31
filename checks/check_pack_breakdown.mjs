// =============================================================================
// OGGI Wholesale v2 — GATE: THE PACK BREAKDOWN                  MK-03, 1 Sep 2026
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// `Packing content` is the line a wholesale buyer reads to know what is in the
// carton. Before this module it was built by walking pack.components in
// Postgres row order, which is right for a RATIO pack (one component per size)
// and badly wrong for a SERIES pack (one component per colour × size). C-117
// Byblos Ballet Flat has 24 components over 6 sizes and printed:
//
//     1x39/1x40/1x39/1x38/1x41/1x40/1x37/1x41/1x36/...
//
// Six sizes, each shown four times, in no order. Casa Sole (C-101/103/105) and
// Vantage (V-149) have the same shape.
//
// WHAT THIS ASSERTS
//   1. AGGREGATION — one row per distinct size label, quantities summed.
//   2. TOTALITY — `units` equals the plain sum of qtyPerPack, and the sum of
//      the printed quantities equals it too, on every case in the corpus.
//      This is the assertion that matters: a breakdown which drops a
//      component reads as correct and gets ordered short.
//   3. ORDER — the run comes out in size order (36..41, S..XXL, 2Y..8Y), not
//      row order, using the one comparator in js/lib/size-order.js.
//   4. RATIO PACKS ARE UNCHANGED — the packs that were already right stay
//      right, byte for byte.
//   5. Junk in, no crash out: null, undefined, [], missing size, missing qty,
//      a component that is itself null.
//
// RUN:  node checks/check_pack_breakdown.mjs
//
// PROVEN TO GO RED — see checks/GATE-EVIDENCE.md.
// =============================================================================

import { packBreakdown } from "../js/lib/pack-breakdown.js";

let assertions = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  assertions++;
  if (!cond) failures.push(`${label}${detail ? `\n       ${detail}` : ""}`);
};

const comp = (qtyPerPack, size, extra = {}) => ({ qtyPerPack, size, ...extra });

// -- the real shape of the bug: C-117, 24 components over 6 sizes ------------
const SERIES_C117 = [];
for (const colour of ["Black", "Ecru", "Tan", "Navy"]) {
  for (const size of ["39", "40", "38", "41", "37", "36"]) {
    SERIES_C117.push(comp(1, size, { color: colour, sku: `C-117-${colour}-${size}` }));
  }
}

// -- 1. aggregation ----------------------------------------------------------
{
  const got = packBreakdown(SERIES_C117);
  ok("C-117 collapses to 6 rows", got.rows.length === 6, `got ${got.rows.length}`);
  ok("C-117 reads 4× per size", got.text === "4×36/4×37/4×38/4×39/4×40/4×41", `got ${got.text}`);
  ok("no size appears twice",
     new Set(got.rows.map((r) => r.label)).size === got.rows.length);
}

// A series pack with an UNEVEN colour spread — 3 colours in 36, 1 in 41 — so
// the aggregation cannot be faked with "count × distinct".
{
  const uneven = [
    comp(1, "36"), comp(1, "36"), comp(1, "36"),
    comp(2, "37"), comp(1, "37"),
    comp(1, "41"),
  ];
  const got = packBreakdown(uneven);
  ok("uneven spread sums per size", got.text === "3×36/3×37/1×41", `got ${got.text}`);
}

// -- 2. TOTALITY -------------------------------------------------------------
const CORPUS = [
  SERIES_C117,
  [comp(1, "28"), comp(2, "30"), comp(3, "32"), comp(3, "34"), comp(2, "36"), comp(1, "38"), comp(1, "40")],
  [comp(2, "S"), comp(3, "M"), comp(3, "L"), comp(2, "XL")],
  [comp(1, "2Y"), comp(2, "4Y"), comp(2, "6Y"), comp(1, "8Y")],
  [comp(6, "One Size")],
  [comp(1, "M"), comp(1, "M"), comp(1, "M"), comp(1, "M"), comp(1, "M")],
  [comp(0, "S"), comp(4, "M")],
  [comp(3, null, { sku: "SKU-A" }), comp(2, null, { sku: "SKU-B" })],
];
for (const [i, pack] of CORPUS.entries()) {
  const plain = pack.reduce((s, c) => s + c.qtyPerPack, 0);
  const got = packBreakdown(pack);
  ok(`corpus[${i}] units preserved`, got.units === plain, `${got.units} vs ${plain}`);
  const printed = got.rows.reduce((s, r) => s + r.qty, 0);
  ok(`corpus[${i}] printed total preserved`, printed === plain, `${printed} vs ${plain}`);
  ok(`corpus[${i}] every label kept`,
     new Set(pack.map((c) => String(c.size || c.sku))).size === got.rows.length,
     `${new Set(pack.map((c) => String(c.size || c.sku))).size} distinct in, ${got.rows.length} out`);
}

// -- 3. ORDER ----------------------------------------------------------------
const ORDERS = [
  [[comp(1, "L"), comp(1, "XS"), comp(1, "XXL"), comp(1, "M"), comp(1, "S"), comp(1, "XL")],
   "1×XS/1×S/1×M/1×L/1×XL/1×XXL"],
  [[comp(1, "41"), comp(1, "36"), comp(1, "39")], "1×36/1×39/1×41"],
  [[comp(1, "8Y"), comp(1, "2Y"), comp(1, "4Y")], "1×2Y/1×4Y/1×8Y"],
];
for (const [pack, want] of ORDERS) {
  const got = packBreakdown(pack);
  ok(`orders ${want}`, got.text === want, `got ${got.text}`);
}

// -- 4. ratio packs, already correct, must not move --------------------------
{
  const meridian = [comp(1, "28"), comp(2, "30"), comp(3, "32"), comp(3, "34"), comp(2, "36"), comp(1, "38"), comp(1, "40")];
  const got = packBreakdown(meridian);
  ok("Meridian ratio pack unchanged",
     got.text === "1×28/2×30/3×32/3×34/2×36/1×38/1×40", `got ${got.text}`);
  ok("Meridian units still 13", got.units === 13, `got ${got.units}`);
}

// -- 5. junk in, no crash out ------------------------------------------------
for (const junk of [null, undefined, [], "not an array", 7, [null], [undefined], [{}]]) {
  let got;
  try { got = packBreakdown(junk); } catch (e) { got = { threw: e.message }; }
  ok(`survives ${JSON.stringify(junk)}`,
     got && !got.threw && Array.isArray(got.rows) && typeof got.text === "string" &&
     Number.isFinite(got.units),
     JSON.stringify(got));
}
{
  // A component with a quantity but no size or sku still has to be counted.
  const got = packBreakdown([comp(2, null), comp(3, "M")]);
  ok("nameless component is kept, not dropped", got.units === 5, `got ${got.units}`);
  ok("nameless component is labelled", got.rows.some((r) => r.label === "—"), got.text);
  // And a NaN quantity must not poison the total.
  const nan = packBreakdown([{ qtyPerPack: "x", size: "M" }, comp(3, "L")]);
  ok("NaN quantity does not poison the total", nan.units === 3, `got ${nan.units}`);
}

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
