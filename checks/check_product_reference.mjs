// =============================================================================
// OGGI Wholesale v2 — GATE: THE PRODUCT REFERENCE                MK-02, 1 Sep 2026
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Wholesale buyers quote references, not names — "send me 12 of SG3286B" is how
// the order gets placed. The reference app Hadi sent puts it on the product
// page as its own labelled field and under every card in the feed, so the
// marketplace tile does too. In this data set it is glued to the front of the
// product name ("L-137 Relaxed Pima Tee") and has to be split back out.
//
// The first version of this function got it wrong in the direction that shows:
// it accepted a bare leading NUMBER, so "24 Hour Tee" rendered with a small
// bold "24" above a product called "Hour Tee". Not a crash, not a blank — a
// product that looks mis-catalogued, on the most public screen in the product.
//
// WHAT THIS ASSERTS
//   1. Every reference style actually in this catalogue splits: L-137, A-102,
//      W-209, P-101, SG3286B.
//   2. A LEADING BARE NUMBER IS NOT A REFERENCE. "24 Hour Tee", "501 Original".
//      This is the assertion the first version failed.
//   3. A name with no reference comes back untouched.
//   4. TOTALITY — `ref ? ref + " " + rest : rest` reconstructs the input for
//      every case. A splitter that drops a word is worse than one that splits
//      nothing, because the product's name is now wrong on the card and nothing
//      says so.
//   5. Junk in, no crash out: null, undefined, empty, whitespace, one char.
//
// RUN:  node checks/check_product_reference.mjs
//
// PROVEN TO GO RED — see checks/GATE-EVIDENCE.md.
// =============================================================================

import { splitReference } from "../js/lib/product-reference.js";

let assertions = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  assertions++;
  if (!cond) failures.push(`${label}${detail ? `\n       ${detail}` : ""}`);
};

// -- 1. the real reference styles in this catalogue --------------------------
const SPLITS = [
  ["L-137 Relaxed Pima Tee", "L-137", "Relaxed Pima Tee"],
  ["A-102 Beaded Column Gown (Made to Order)", "A-102", "Beaded Column Gown (Made to Order)"],
  ["W-209 Bootcut Jean", "W-209", "Bootcut Jean"],
  ["P-101 Cotton Bodysuit Prepack", "P-101", "Cotton Bodysuit Prepack"],
  ["H-502 Mens Baggy Jort", "H-502", "Mens Baggy Jort"],
  ["V-150 Vantage Club Tracksuit Premium", "V-150", "Vantage Club Tracksuit Premium"],
  // The reference app's own style, no hyphen.
  ["SG3286B Platform Sandal", "SG3286B", "Platform Sandal"],
];
for (const [input, ref, rest] of SPLITS) {
  const got = splitReference(input);
  ok(`splits ${JSON.stringify(input)}`, got.ref === ref && got.rest === rest,
     `got ${JSON.stringify(got)}`);
}

// -- 2. a bare leading number is NOT a reference -----------------------------
// The bug the first version shipped with.
for (const name of ["24 Hour Tee", "501 Original", "100 Cotton Shirt", "2 Pack Socks"]) {
  const got = splitReference(name);
  ok(`${JSON.stringify(name)} has no reference`, got.ref === null,
     `got ref ${JSON.stringify(got.ref)}`);
  ok(`${JSON.stringify(name)} comes back whole`, got.rest === name);
}

// -- 3. no reference at all --------------------------------------------------
for (const name of ["Cotton Bodysuit", "Silk Slip Dress", "Beanie"]) {
  const got = splitReference(name);
  ok(`${JSON.stringify(name)} is left alone`, got.ref === null && got.rest === name,
     `got ${JSON.stringify(got)}`);
}

// -- 4. TOTALITY: the input is always reconstructable ------------------------
const CORPUS = [
  ...SPLITS.map((s) => s[0]),
  "24 Hour Tee", "501 Original", "Cotton Bodysuit", "Beanie",
  "C-113 Litani Work Boot", "L-143 Ribbed Beanie", "A-140 Enamel Bangle Cuff",
  "  L-137   Relaxed Pima Tee  ", "X-1 A", "TAILLE UNIQUE Scarf",
];
for (const name of CORPUS) {
  const { ref, rest } = splitReference(name);
  const rebuilt = ref ? `${ref} ${rest}` : rest;
  ok(`reconstructs ${JSON.stringify(name)}`,
     rebuilt === name.trim().replace(/\s+/g, " ") || rebuilt === name.trim(),
     `rebuilt ${JSON.stringify(rebuilt)}`);
}

// -- 5. junk in, no crash out ------------------------------------------------
for (const junk of [null, undefined, "", "   ", "X", "-", "123456789012345"]) {
  let got;
  try { got = splitReference(junk); } catch (e) { got = { threw: e.message }; }
  ok(`survives ${JSON.stringify(junk)}`,
     got && !got.threw && typeof got.rest === "string" &&
     (got.ref === null || typeof got.ref === "string"),
     JSON.stringify(got));
}

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
