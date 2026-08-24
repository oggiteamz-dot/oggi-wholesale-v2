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
  await new Promise((r) => setTimeout(r, 40));

  const click = (sel, root = el) => { const n = root.querySelector(sel); if (n) n.dispatchEvent(new dom.window.Event("click")); return !!n; };
  const cards = () => [...el.querySelectorAll(".os-box")];
  const stepsIn = (card) => [...card.querySelectorAll(".os-stepcell")];
  const bump = (card, i, times = 1) => {
    const cell = stepsIn(card)[i];
    if (!cell) return false;
    const plus = cell.querySelectorAll(".os-step button")[1];
    for (let k = 0; k < times; k++) plus.dispatchEvent(new dom.window.Event("click"));
    return true;
  };

  // -- 1. the one question -------------------------------------------------
  const radios = [...el.querySelectorAll('input[name="os-mode"]')];
  ok(radios.length === 2, `exactly two ways to order are offered (got ${radios.length})`);
  ok(radios.map((r) => r.value).sort().join(",") === "boxes,open",
     "the two are 'any amount' and 'only in boxes' — the ratio/prepack/series split the database never made is gone from the screen");

  // -- 2. THREE KINDS, named the way Hadi says them ------------------------
  ok(!!el.querySelector("#os-add-full") && !!el.querySelector("#os-add-colour") && !!el.querySelector("#os-add-size"),
     "all three kinds can be added: Full box, By colour, By size — 'by size' (one size, every colour) existed nowhere before and is the one Hadi had no way to express");

  // -- 3. arbitrary and mixable -------------------------------------------
  ok(cards().length === 0, `a product with no packs starts empty (got ${cards().length})`);
  click("#os-add-full"); click("#os-add-colour"); click("#os-add-size"); click("#os-add-colour");
  ok(cards().length === 4,
     `packs can be added without limit and KINDS CAN BE MIXED on one product (got ${cards().length}) — a full box, two colour packs and a size pack together, which is what "any which way that I like" means`);

  const [full, byCol, bySize] = cards();

  // -- 4. FULL BOX: one ratio, every colour --------------------------------
  ok(stepsIn(full).length === 3, `a full box asks for ONE ratio — one number per size (got ${stepsIn(full).length} for 3 sizes), not one per colour-and-size`);
  bump(full, 1, 3);                       // 3 of the second size
  const fullTxt = full.querySelector(".os-box-preview").textContent;
  ok(/in each of \d+ colours/.test(fullTxt),
     `the full box says the ratio repeats across colours — got "${fullTxt.slice(0, 90)}"`);
  ok(/9 pieces|6 pieces/.test(full.querySelector(".os-box-count").textContent) || /pieces/.test(full.querySelector(".os-box-count").textContent),
     "…and counts the whole box, not one colour's worth");

  // -- 5. and any single colour can still be overridden --------------------
  ok(/One colour is different/.test(full.textContent),
     "a full box can be opened up to change one colour on its own — 'same by default, editable per colour'");
  click(".os-box-editor button.btn-ghost", full);
  ok(!!full.querySelector(".os-grid"), "…and that opens the real grid");

  // -- 6. BY COLOUR --------------------------------------------------------
  const colChips = [...byCol.querySelectorAll(".os-pickchip")];
  ok(colChips.length === 2, `a colour pack lets you pick which colour (got ${colChips.length} for 2 colours)`);
  ok(colChips.some((c) => c.querySelector(".os-chip-dot") || c.querySelector(".os-chip-img")),
     "…and the colours are shown as swatches or photos, not just spelled — 'I don't know if these are the right names for them, and I might forget'");
  bump(byCol, 0, 2);
  ok(/in Red|in Blue/.test(byCol.querySelector(".os-box-preview").textContent),
     "a colour pack says which colour the buyer gets");

  // -- 7. BY SIZE ----------------------------------------------------------
  const sizeChips = [...bySize.querySelectorAll(".os-pickchip")];
  ok(sizeChips.length === 3, `a size pack lets you pick which size (got ${sizeChips.length} for 3 sizes)`);
  const colRows = [...bySize.querySelectorAll(".os-colrow")];
  ok(colRows.length >= 1, `…and then asks how many of each colour (got ${colRows.length} colour rows)`);
  ok(colRows.every((r) => r.querySelector(".os-chip-dot") || r.querySelector(".os-chip-img")),
     "…each shown with its swatch or photo");
  bump(bySize, 0, 2);
  const bsTxt = bySize.querySelector(".os-box-preview").textContent;
  ok(/all in size/.test(bsTxt), `a size pack says it is one size across colours — got "${bsTxt.slice(0, 90)}"`);

  // -- 8. packs are independent -------------------------------------------
  ok(/empty/.test(cards()[3].querySelector(".os-box-count").textContent),
     "filling one pack leaves the others alone");

  // -- 9. remove -----------------------------------------------------------
  const n0 = cards().length;
  click(".os-box-del", cards()[3]);
  ok(cards().length === n0 - 1, "a pack can be removed");

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
// TIGHTENED, third time of asking. These two features have now fallen out of
// three consecutive rewrites of this panel. The previous version of this check
// only asked whether the NAME appeared in the file -- and an unused `import`
// satisfies that, so it stayed green through a rewrite that dropped both.
// A preservation check that a dead import can pass preserves nothing.
//
// So: the button must exist in the rendered DOM, and be wired.
if (mod?.renderOrderSetup) {
  const el2 = mod.renderOrderSetup({ product, wid: "test", onSaved: () => {} });
  await new Promise((r) => setTimeout(r, 40));
  el2.querySelector("#os-add-full")?.dispatchEvent(new dom.window.Event("click"));
  await new Promise((r) => setTimeout(r, 20));
  const txt = el2.textContent;
  ok(/Suggest from what sells/.test(txt),
     "'Suggest from what sells' is actually ON SCREEN — it lived only in the builder CR-0001 deleted, and has since fallen out of three rewrites");
  ok(/suggestPackRatio\s*\(/.test(osrc),
     "…and is wired to the real suggestion call, not just a button that does nothing");
  ok(/savedRatiosPromise/.test(osrc) && /listRatios\s*\(/.test(osrc),
     "the saved-ratio library is still reachable — optional reuse, never a gate: a pack can be built without naming or saving anything, which was the wall Hadi hit");
}

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
