// =============================================================================
// CHECK: the count check, on the screen                    (CNT-00, 6 Sep 2026)
// =============================================================================
//   node checks/check_receive_count.mjs
//
// THE OTHER HALF OF checks/check_receive_count.sql.
// The SQL file proves the DATABASE refuses a breakdown that does not equal the
// invoice. This file proves the PERSON is never surprised by that refusal: the
// button is dead before they press it and it says which way and by how much.
// Both are needed and neither substitutes for the other -- a rule only on the
// screen dies the first time somebody writes a second screen, and a rule only
// in the database is a form that fails after you fill it in.
//
// EVERY ASSERTION HERE DRIVES THE REAL COMPONENT IN A REAL DOM. Nothing below
// is a string search of the source: renderReceiveProduct is mounted, values are
// typed into its inputs, buttons are clicked, and what comes back out of
// onConfirm is what is checked.
//
// THE FIXTURE HAS A HOLE IN IT ON PURPOSE. There is no Rust/XL variant, so a
// grid that quietly treats "we do not make it" as "we received none" fails
// assertion 2 -- and so does a fill tool that spreads across boxes that do not
// exist, which would put the total right and the stock wrong.
// =============================================================================
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

let mod = null;
try { mod = await import("../js/components/receive-product.js"); }
catch (e) { fail.push(`js/components/receive-product.js could not be loaded: ${String(e).split("\n")[0]}`); }

const { renderReceiveProduct, apportion, parsePackingList, cellKey } = mod || {};

// ---- the fixture ----------------------------------------------------------
// Sizes are deliberately entered OUT of trade order, so assertion 3 is about
// the screen sorting them and not about the fixture being tidy.
const COLOURS = ["Navy", "Ecru", "Olive", "Rust"];
const SIZES = ["XL", "S", "L", "M"];
const variants = [];
for (const c of COLOURS) {
  for (const s of SIZES) {
    if (c === "Rust" && s === "XL") continue;   // THE HOLE
    variants.push({ id: `v-${c}-${s}`, sku: `SKU-${c}-${s}`, extra_attrs: { color: c, size: s, colorHex: "#123456" } });
  }
}
const product = { id: "p1", name: "Poplin Shirt", variants };

function mount(extra = {}) {
  const seen = { confirmed: null, saved: null };
  const el = renderReceiveProduct({
    product,
    locationName: "Main Warehouse",
    onConfirm: async (payload) => { seen.confirmed = payload; return { ok: true }; },
    onSaveRatio: async (r) => { seen.saved = r; return { ok: true }; },
    ...extra,
  });
  document.body.innerHTML = "";
  document.body.appendChild(el);
  return { el, seen };
}

const type = (input, value) => {
  input.value = String(value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const cellAt = (el, c, s) => el.querySelector(`input[data-colour="${c}"][data-size="${s}"]`);
const confirmBtn = (el) => el.querySelector('[data-a="confirm"]');
const total = (el) => [...el.querySelectorAll("input.rcvp-q")].reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);

if (renderReceiveProduct) {
  // -- 1. the grid is one card per colour, and every box that exists is a box
  {
    const { el } = mount();
    const cards = el.querySelectorAll(".rcvp-colour");
    ok(cards.length === 4, `one card per colour (${cards.length} of 4)`);
    ok(el.querySelectorAll("input.rcvp-q").length === 15,
       `15 boxes, not 16 — the Rust/XL the wholesaler does not make is not an input (${el.querySelectorAll("input.rcvp-q").length})`);
  }

  // -- 2. THE HOLE IS SHOWN, NOT HIDDEN. An absent size in the middle of a run
  //       is information, and dropping it makes the columns stop lining up.
  {
    const { el } = mount();
    const rust = [...el.querySelectorAll(".rcvp-colour")].find((c) => c.textContent.includes("Rust"));
    ok(rust && rust.querySelectorAll(".rcvp-cell").length === 4,
       "the missing Rust/XL still occupies its place in the row");
    ok(rust && rust.querySelector(".rcvp-cell.is-absent"),
       "…and is marked unavailable rather than shown as an empty box that means zero");
  }

  // -- 3. sizes in TRADE order, not the order they were entered
  {
    const { el } = mount();
    const labels = [...el.querySelectorAll(".rcvp-colour")[0].querySelectorAll(".rcvp-size")].map((n) => n.textContent);
    ok(labels.join(",") === "S,M,L,XL",
       `sizes read S,M,L,XL and not the entry order XL,S,L,M (got ${labels.join(",")})`);
  }

  // -- 4. CNT-05: no spinner anywhere. 2.999 in the reference ERP is a spinner
  //       artefact, and a spinner on a count of physical objects invites it.
  {
    const { el } = mount();
    ok(el.querySelectorAll('input[type="number"]').length === 0,
       "no <input type=number> anywhere on the screen — CNT-05, whole pieces, typing not stepping");
  }

  // -- 5. CNT-03/CNT-04: 270 against 250 is refused, and the BUTTON says why
  {
    const { el, seen } = mount();
    type(el.querySelector("#rcvp-billed"), 250);
    for (const c of COLOURS) for (const s of SIZES) {
      const box = cellAt(el, c, s);
      if (box) type(box, 18);
    }
    // 15 boxes x 18 = 270
    ok(total(el) === 270, `the fixture entered 270 (${total(el)})`);
    const btn = confirmBtn(el);
    ok(btn.disabled === true, "Save is BLOCKED at 270 against a billed 250 — blocked, not warned");
    ok(btn.textContent === "20 too many",
       `the button carries the reason: "20 too many" (got "${btn.textContent}")`);
    click(btn);
    ok(seen.confirmed === null, "…and clicking it anyway writes nothing");
  }

  // -- 6. short counts are caught too, and say so the other way round
  {
    const { el } = mount();
    type(el.querySelector("#rcvp-billed"), 250);
    for (const c of COLOURS) for (const s of SIZES) {
      const box = cellAt(el, c, s);
      if (box) type(box, 15);   // 15 x 15 = 225
    }
    const btn = confirmBtn(el);
    ok(btn.disabled === true && btn.textContent === "25 still to enter",
       `a short count is blocked and says "25 still to enter" (got "${btn.textContent}")`);
  }

  // -- 7. and when they agree, it goes — with the lines it showed
  {
    const { el, seen } = mount();
    type(el.querySelector("#rcvp-billed"), 150);
    for (const c of COLOURS) for (const s of SIZES) {
      const box = cellAt(el, c, s);
      if (box) type(box, 10);   // 15 x 10 = 150
    }
    const btn = confirmBtn(el);
    ok(btn.disabled === false && btn.textContent === "Receive 150 pieces",
       `at zero difference the button opens and says what it will do (got "${btn.textContent}")`);
    click(btn);
    await new Promise((r) => setTimeout(r, 0));
    ok(seen.confirmed && seen.confirmed.lines.length === 15,
       `it hands over one line per filled box (${seen.confirmed ? seen.confirmed.lines.length : "none"})`);
    ok(seen.confirmed && seen.confirmed.lines.reduce((a, l) => a + l.qty, 0) === 150,
       "…and they sum to exactly what the invoice said");
    ok(seen.confirmed && !seen.confirmed.lines.some((l) => l.variantId === "v-Rust-XL"),
       "…and nothing is sent for a variant that does not exist");
  }

  // -- 8. CNT-11 + CNT-09: spread evenly places the remainder AND names it
  {
    const { el } = mount();
    type(el.querySelector("#rcvp-billed"), 250);
    click(el.querySelector('[data-t="spread"]'));
    ok(total(el) === 250, `spread evenly places every piece (${total(el)} of 250)`);
    const note = el.querySelector("#rcvp-note").textContent;
    ok(/does not divide by 15/.test(note) && /extra 10 went to/.test(note),
       `the remainder is named, not dropped: "${note.slice(0, 90)}"`);
    ok(confirmBtn(el).disabled === false, "…and the screen is immediately ready to save");
  }

  // -- 9. CNT-12: a curve fills by SIZE NAME, and says which sizes it missed
  {
    const { el } = mount();
    type(el.querySelector("#rcvp-billed"), 200);
    click(el.querySelector('[data-t="curve"]'));
    // 2-3-3-2 over S,M,L and nothing for XL
    const w = (s) => el.querySelector(`[data-w="${s}"]`);
    type(w("S"), 2); type(w("M"), 3); type(w("L"), 3); type(w("XL"), 0);
    click(el.querySelector('[data-c="fill"]'));
    ok(total(el) === 200, `the curve places every piece (${total(el)} of 200)`);
    const xlSum = COLOURS.map((c) => cellAt(el, c, "XL")).filter(Boolean)
      .reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    ok(xlSum === 0, `a size with no weight gets nothing (XL total ${xlSum})`);
    const sSum = COLOURS.map((c) => cellAt(el, c, "S")).reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    const mSum = COLOURS.map((c) => cellAt(el, c, "M")).reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    ok(mSum > sSum, `the 3 column holds more than the 2 column (S ${sSum}, M ${mSum}) — the curve is applied, not averaged`);
  }

  // -- 10. CNT-15: the curve can be NAMED AND SAVED. createRatio()'s first
  //        caller since it was written on 24 August.
  {
    const { el, seen } = mount();
    type(el.querySelector("#rcvp-billed"), 100);
    click(el.querySelector('[data-t="curve"]'));
    type(el.querySelector('[data-w="S"]'), 2);
    type(el.querySelector('[data-w="M"]'), 3);
    type(el.querySelector("#rcvp-curve-name"), "House 2-3");
    click(el.querySelector('[data-c="save"]'));
    await new Promise((r) => setTimeout(r, 0));
    ok(seen.saved && seen.saved.name === "House 2-3",
       "a curve can be named and saved — the whole return on this feature, because nobody types sixteen numbers correctly twice");
    ok(seen.saved && seen.saved.weights.length === 4 && seen.saved.sizes.join(",") === "S,M,L,XL",
       "…and it is saved against the sizes this product actually has");
  }

  // -- 11. a saved curve loads by NAME, not by position. A curve written for
  //        S-M-L applied to S-M-L-XL must not shift one column across.
  {
    const { el } = mount({ savedRatios: [{ name: "Bell", sizes: ["M", "L"], weights: [4, 6] }] });
    type(el.querySelector("#rcvp-billed"), 100);
    click(el.querySelector('[data-t="curve"]'));
    click(el.querySelector('[data-load-curve="Bell"]'));
    ok(el.querySelector('[data-w="S"]').value === "0" &&
       el.querySelector('[data-w="M"]').value === "4" &&
       el.querySelector('[data-w="L"]').value === "6",
       "a saved curve lands on the sizes it names, and leaves the others at zero");
  }

  // -- 11b. ⭐ AND "FILL NOW" APPLIES IT BY NAME, not by position. This is the
  //         only path that hands the fill a size list different from the
  //         screen's, and it is the one that would silently shift a run across
  //         if the match were positional: a curve saved for M-L would land on
  //         S-M instead, the total would be right, and the stock would be
  //         wrong. The gate had no assertion for this until a sabotage that
  //         swapped name-matching for position-matching went undetected.
  {
    const { el } = mount({ savedRatios: [{ name: "Bell", sizes: ["M", "L"], weights: [4, 6] }] });
    type(el.querySelector("#rcvp-billed"), 100);
    click(el.querySelector('[data-t="curve"]'));
    click(el.querySelector('[data-fill-now="Bell"]'));
    const col = (s) => COLOURS.map((c) => cellAt(el, c, s)).filter(Boolean)
      .reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    ok(total(el) === 100, `a saved curve fills in one tap (${total(el)} of 100)`);
    ok(col("S") === 0 && col("XL") === 0,
       `sizes the curve does not name get nothing (S ${col("S")}, XL ${col("XL")})`);
    ok(col("L") > col("M"),
       `and the 6 lands on L, not shifted onto M (M ${col("M")}, L ${col("L")})`);
    ok(/S, XL are not in this curve/.test(el.querySelector("#rcvp-note").textContent),
       "…and the screen names the sizes that got none rather than leaving them to be found");
  }

  // -- 12. CNT-08: one-level undo
  {
    const { el } = mount();
    type(el.querySelector("#rcvp-billed"), 150);
    for (const c of COLOURS) for (const s of SIZES) { const b = cellAt(el, c, s); if (b) type(b, 10); }
    click(el.querySelector('[data-t="spread"]'));
    ok(el.querySelector('[data-t="undo"]').hidden === false, "a bulk action offers an undo");
    click(el.querySelector('[data-t="undo"]'));
    ok(total(el) === 150, `undo puts the hand-typed numbers back (${total(el)})`);
    ok(el.querySelector('[data-t="undo"]').hidden === true, "…and one level only — the undo goes away after it is used");
  }

  // -- 13. CNT-06: row and column totals, always on screen
  {
    const { el } = mount();
    type(cellAt(el, "Navy", "M"), 7);
    type(cellAt(el, "Ecru", "M"), 5);
    const navy = [...el.querySelectorAll(".rcvp-colour")].find((c) => c.textContent.includes("Navy"));
    ok(navy.querySelector(".rcvp-rowtotal").textContent === "7", "the colour's own total is on its row");
    const mCol = [...el.querySelectorAll(".rcvp-coltotal")].find((n) => n.querySelector(".rcvp-size").textContent === "M");
    ok(mCol.querySelector("b").textContent === "12",
       "and the size's column total adds the colours up — a mistake shows where it happened");
  }

  // -- 14. THE CARTON TRAP. Entering 250 into a field that means cartons is
  //        how a 250 becomes a 6,000, so the unit is on the field and the
  //        button says both numbers.
  {
    const { el, seen } = mount({ packSize: 12 });
    ok(/cartons/.test(el.querySelector(".rcvp-billed-unit").textContent),
       "when the product is bought in cartons the field says cartons, not pieces");
    type(el.querySelector("#rcvp-billed"), 15);
    for (const c of COLOURS) for (const s of SIZES) { const b = cellAt(el, c, s); if (b) type(b, 1); }
    const btn = confirmBtn(el);
    ok(btn.textContent === "Receive 15 cartons (180 pieces)",
       `the button states both numbers (got "${btn.textContent}")`);
    click(btn);
    await new Promise((r) => setTimeout(r, 0));
    ok(seen.confirmed && seen.confirmed.pieces === 180 && seen.confirmed.lines[0].qty === 12,
       "…and what is handed over is PIECES, so nothing downstream has to guess the unit");
  }
}

// -- 15. apportion() never loses or invents a piece. A property, over awkward
//        numbers, because "it looked right on 250 over 16" is how a rounding
//        bug survives.
if (apportion) {
  let worst = null;
  for (const t of [1, 7, 250, 251, 999, 1000, 1001]) {
    for (const n of [1, 3, 7, 15, 16, 32]) {
      const parts = apportion(t, Array.from({ length: n }, () => 1));
      if (parts.reduce((a, b) => a + b, 0) !== t) worst = `${t} over ${n} came to ${parts.reduce((a, b) => a + b, 0)}`;
    }
  }
  ok(worst === null, `apportion places exactly the total, every time${worst ? " — " + worst : ""}`);
  const weighted = apportion(200, [2, 3, 3, 0]);
  ok(weighted.reduce((a, b) => a + b, 0) === 200 && weighted[3] === 0,
     "…and a zero weight gets nothing while the total still lands exactly");
}

// -- 16. CNT-14: the packing-list paste matches by NAME and refuses the rest
if (parsePackingList) {
  const withHeader = parsePackingList("colour\tS\tM\tL\nNavy\t2\t3\t3\nEcru\t1\t1\t1", COLOURS, ["S", "M", "L", "XL"]);
  ok(withHeader.matched === 6 && withHeader.cells.get(cellKey("Navy","M")) === 3,
     "a paste with a header row lands by size NAME");
  const noHeader = parsePackingList("Navy,4,5,6,7", COLOURS, ["S", "M", "L", "XL"]);
  ok(noHeader.cells.get(cellKey("Navy","S")) === 4 && noHeader.cells.get(cellKey("Navy","XL")) === 7,
     "a paste with no header falls back to the order on screen");
  const strange = parsePackingList("Turquoise\t9\nNavy\t9", COLOURS, ["S", "M", "L", "XL"]);
  ok(strange.matched === 1 && strange.skipped.includes("Turquoise"),
     "a colour this product does not have is SKIPPED and named — a paste that silently lands in the wrong row is worse than one that refuses");
  // A header naming sizes out of the screen's order must still land correctly:
  // this is the assertion that separates "matches by name" from "matches by
  // position and happened to agree".
  const reordered = parsePackingList("colour\tL\tS\nNavy\t8\t2", COLOURS, ["S", "M", "L", "XL"]);
  ok(reordered.cells.get(cellKey("Navy","L")) === 8 && reordered.cells.get(cellKey("Navy","S")) === 2,
     "a header in a different order than the screen still lands on the right sizes");
}

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
