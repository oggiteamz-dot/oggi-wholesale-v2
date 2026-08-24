// =============================================================================
// CHECK: one order-setup panel, and it writes the boxes it shows  (CR-0001)
// =============================================================================
//
// WHAT THIS GUARDS
// ----------------
// CR-0001 deleted two builders (253 lines of renderRatioSection, plus a
// per-variant list that was 64 rows on an 8x8 product) and replaced them with
// one colour x size grid. Every gate in the suite stayed green while that
// happened -- 37 of 37 -- which means not one of them covered the thing being
// deleted. That is the "a gate that lies" failure this project keeps
// relearning, and this file exists because of it.
//
// It checks three separable things:
//
//   1. THE PANEL WORKS, in a real DOM. The grid renders, the shortcut fills
//      it, the preview sentence describes what the buyer actually receives.
//      Behavioural, not a string search.
//   2. THE OLD BUILDERS ARE ACTUALLY GONE. A replacement that leaves the old
//      one behind is what caused this whole change: the ratio row shipped
//      ABOVE the 64-row list instead of replacing it, so both were on screen.
//   3. NOTHING WAS SILENTLY DROPPED. The two features that lived only inside
//      the removed UI -- "suggest from sell-through" and the saved-mix
//      library -- must still be reachable.
//
//   node checks/check_order_setup.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;
// A chainable stub. The thin `{ from: () => ({}) }` version blew up on the
// first .select(), which is not a finding about the app -- it is a finding
// about the stub. A gate that dies in its own scaffolding reports nothing.
const thenable = (rows) => {
  const chain = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res) => Promise.resolve({ data: rows, error: null }).then(res);
      return () => chain;
    },
    apply() { return chain; },
  });
  return chain;
};
dom.window.supabase = { createClient: () => ({ from: () => thenable([]), rpc: () => thenable([]) }) };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

let mod = null;
try { mod = await import("../js/components/order-setup.js"); }
catch (e) { fail.push(`js/components/order-setup.js could not be loaded: ${String(e).split("\n")[0]}`); }

// A product with a deliberate HOLE: there is no Blue/L variant. A cell that
// cannot be ordered must not be typeable, or the wholesaler builds a box
// containing something that does not exist.
const V = (id, color, size, hex, img) => ({
  id, sku: `T-${color}-${size}`,
  extra_attrs: { color, size, colorHex: hex },
  image_url: img || null, images: [],
});
const product = {
  id: "p1", name: "Test Tee", selling_model: "open", base_unit: null,
  moq_qty: null, moq_per_colour: null,
  variants: [
    V("v1", "Red", "S", "#c0392b"), V("v2", "Red", "M", "#c0392b"), V("v3", "Red", "L", "#c0392b"),
    V("v4", "Blue", "S", "#2c5f9e", "https://example.invalid/blue.jpg"),
    V("v5", "Blue", "M", "#2c5f9e"),   // <- no Blue / L
  ],
};

if (mod?.renderOrderSetup) {
  const el = mod.renderOrderSetup({ product, wid: "test", onSaved: () => {} });
  await new Promise((r) => setTimeout(r, 40));   // the async pack/ratio loaders

  const boxCards = () => [...el.querySelectorAll(".os-box")];
  const cellsOf = (card) => [...card.querySelectorAll(".os-cell")];
  const setRow = (card, rowIdx, vals) => {
    const row = [...card.querySelectorAll("tbody tr")][rowIdx];
    const cs = [...row.querySelectorAll(".os-cell")];
    vals.forEach((v, i) => { if (cs[i] && !cs[i].disabled) { cs[i].value = String(v); cs[i].dispatchEvent(new dom.window.Event("input", { bubbles: true })); } });
    return cs;
  };

  // -- 1. the one question -------------------------------------------------
  const radios = [...el.querySelectorAll('input[name="os-mode"]')];
  ok(radios.length === 2, `exactly two ways to order are offered (got ${radios.length}) — the four-model picker is what nobody could navigate`);
  ok(radios.map((r) => r.value).sort().join(",") === "boxes,open",
     "the two are 'any amount' and 'only in boxes' — the three-way ratio/prepack/series distinction the database never made is gone from the screen");

  // -- 2. ARBITRARY BOXES. This is the assertion that was missing. ----------
  // The first version of this panel could express exactly two shapes: one
  // mixed box, or one box per colour. The builder it replaced could create any
  // number of arbitrary packs, so shipping it was a REGRESSION -- and this
  // gate passed, because it was written to match the new design rather than to
  // preserve the old capability. That is how a feature-loss check goes green
  // on a feature loss.
  ok(boxCards().length === 1, `a product with no boxes starts with one empty box card (got ${boxCards().length})`);
  el.querySelector("#os-add-box").dispatchEvent(new dom.window.Event("click"));
  el.querySelector("#os-add-box").dispatchEvent(new dom.window.Event("click"));
  ok(boxCards().length === 3,
     `"Add a box" adds another box, without limit (got ${boxCards().length} after two clicks) — "Box A all colours L and M, Box B only S and XL, Box C just blue" has to be expressible`);

  // -- 3. and the boxes are INDEPENDENT -----------------------------------
  // Guarded. Proving this gate red by capping the panel at one box made it
  // CRASH here on an undefined second card -- exit 1, no readable finding.
  // A gate that only throws tells you nothing, which this project has already
  // written down once. Everything below needs two boxes, so if there are not
  // two, say so and stop rather than dying.
  const [b1, b2] = boxCards();
  if (!b1 || !b2) {
    fail.push("only one box could be created, so nothing below could be checked — the panel must support any number of arbitrary boxes");
  } else {
  setRow(b1, 0, [2, 3, 3]);
  const b2first = cellsOf(b2)[0];
  ok(b2first.value === "0",
     "filling one box leaves the others alone — boxes derived from each other are not arbitrary boxes");

  // -- 4. each box carries its own full grid ------------------------------
  ok(cellsOf(b1).length === 6, `each box has its own colours x sizes grid (2 x 3 = 6, got ${cellsOf(b1).length})`);
  ok(cellsOf(b1).filter((c) => c.disabled).length === 1,
     "the colour/size with no variant is not typeable — a box cannot contain something that does not exist");

  // -- 5. the shortcut fills THIS box only --------------------------------
  b1.querySelector(".os-b-same").dispatchEvent(new dom.window.Event("click"));
  const b1row2 = [...[...b1.querySelectorAll("tbody tr")][1].querySelectorAll(".os-cell")];
  ok(b1row2[0].value === "2" && b1row2[1].value === "3",
     `"Same mix for every colour" copies the first row down within its own box (got ${b1row2[0].value},${b1row2[1].value})`);
  ok(b1row2[2].disabled && b1row2[2].value === "",
     "…and does NOT fill the cell that has no variant — copying a row must not invent stock");
  ok(cellsOf(b2)[0].value === "0", "…and does not touch the other boxes");

  // -- 6. one box per colour is an ACTION, not a mode ----------------------
  const before = boxCards().length;
  el.querySelector("#os-add-per-colour").dispatchEvent(new dom.window.Event("click"));
  // Derived from the fixture, not typed as a literal: the first version of
  // this line said "3" against a two-colour product and failed for a reason
  // that had nothing to do with the app.
  const nColours = new Set(product.variants.map((v) => v.extra_attrs.color)).size;
  ok(boxCards().length === before + nColours,
     `"One box per colour" adds one ordinary, editable box per colour (got +${boxCards().length - before} for ${nColours} colours) — not a mode that locks the grid`);

  // -- 7. duplicate and remove --------------------------------------------
  const n0 = boxCards().length;
  b1.querySelector(".os-box-dup").dispatchEvent(new dom.window.Event("click"));
  const dup = boxCards()[boxCards().length - 1];
  ok(boxCards().length === n0 + 1 && cellsOf(dup)[0].value === "2",
     "Duplicate copies a box's contents, so a near-identical box is not retyped");
  const n1 = boxCards().length;
  dup.querySelector(".os-box-del").dispatchEvent(new dom.window.Event("click"));
  ok(boxCards().length === n1 - 1, "Remove deletes a box");

  // -- 8. THE COLOUR IS VISIBLE, not just spelled -------------------------
  // Hadi: "I don't know if these are the right names for them, and I might
  // forget." Both the hex and the per-colour photo were already in the data
  // and already drive the buyer's card; only this screen showed a word.
  const head = boxCards()[0].querySelector(".os-rowhead");
  ok(!!head.querySelector(".os-rowdot") || !!head.querySelector(".os-rowimg"),
     "each row shows the actual colour — a swatch, or the product photo for that colour — and not only its name");
  ok(/Red/.test(head.textContent), "…with the name still there, because a swatch alone is not searchable either");

  // -- 9. the sentence ----------------------------------------------------
  const prev = boxCards()[0].querySelector(".os-box-preview").textContent;
  ok(/gets/.test(prev) && /pieces/.test(prev),
     `each box says what a buyer receives — got "${prev.slice(0, 80)}"`);

  }

  // -- 10. the settings that were unreachable ------------------------------
  ok(!!el.querySelector("#os-unit"), "the 'each + adds this many pieces' setting is on this screen — live evidence 24 Aug: not one of four products had it set, because its only control was inside the drawer nobody could use");
  ok(!!el.querySelector("#os-moq-colour"), "the per-colour minimum is on this screen");
} else {
  fail.push("the panel cannot be exercised at all — renderOrderSetup is not exported");
}

// -- 7. the old builders are gone ------------------------------------------
const wsrc = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
const code = wsrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(!/function renderRatioSection\s*\(/.test(code),
   "renderRatioSection is gone — leaving it as dead code is how this repo ended up with 21 dead copies of 18 functions");
ok(!/qtyInputs\s*=\s*new Map\(\)/.test(code),
   "the per-variant pack builder is gone — 64 rows on an 8x8 product, and the approved Aug-20 spec said in as many words: 'Kill the 64-row list'");
ok(/renderOrderSetup\(/.test(code), "renderPacksPanel mounts the new panel");

// -- 8. nothing was silently dropped ---------------------------------------
const osrc = readFileSync(new URL("../js/components/order-setup.js", import.meta.url), "utf8");
ok(/suggestPackRatio\(/.test(osrc),
   "'Suggest from what sells' survived the deletion — it lived only in the removed builder and CR-0001 never named it, which is exactly how a feature disappears");
ok(/listRatios\(/.test(osrc),
   "the saved-mix library survived — as an optional shortcut, never a gate: you can now set a box up without naming or saving anything, which was the wall Hadi hit");

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
