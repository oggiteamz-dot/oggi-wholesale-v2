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
const V = (id, color, size) => ({ id, sku: `T-${color}-${size}`, extra_attrs: { color, size } });
const product = {
  id: "p1", name: "Test Tee", selling_model: "open", base_unit: null,
  moq_qty: null, moq_per_colour: null,
  variants: [
    V("v1", "Red", "S"), V("v2", "Red", "M"), V("v3", "Red", "L"),
    V("v4", "Blue", "S"), V("v5", "Blue", "M"),   // <- no Blue / L
  ],
};

if (mod?.renderOrderSetup) {
  const el = mod.renderOrderSetup({ product, wid: "test", onSaved: () => {} });
  await new Promise((r) => setTimeout(r, 30));   // the async pack/ratio loaders

  // -- 1. the one question -------------------------------------------------
  const radios = [...el.querySelectorAll('input[name="os-mode"]')];
  ok(radios.length === 2, `exactly two ways to order are offered (got ${radios.length}) — the four-model picker is what nobody could navigate`);
  ok(radios.map((r) => r.value).sort().join(",") === "boxes,open",
     "the two are 'any amount' and 'only in boxes' — the three-way ratio/prepack/series distinction the database never made is gone from the screen");

  // -- 2. the grid ---------------------------------------------------------
  const cells = [...el.querySelectorAll(".os-cell")];
  ok(cells.length === 6, `the grid is colours x sizes (2 x 3 = 6 cells, got ${cells.length}) — not one flat row per variant`);
  const disabled = cells.filter((c) => c.disabled);
  ok(disabled.length === 1, `the one colour/size that has no variant is not typeable (got ${disabled.length} disabled) — a box cannot contain something that does not exist`);

  // -- 3. the shortcut actually fills the grid ------------------------------
  const redRow = [...el.querySelectorAll("tbody tr")][0];
  const redCells = [...redRow.querySelectorAll(".os-cell")];
  redCells[0].value = "2"; redCells[1].value = "3"; redCells[2].value = "3";
  redCells.forEach((c) => c.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
  el.querySelector("#os-same").dispatchEvent(new dom.window.Event("click"));
  const blueRow = [...el.querySelectorAll("tbody tr")][1];
  const blueCells = [...blueRow.querySelectorAll(".os-cell")];
  ok(blueCells[0].value === "2" && blueCells[1].value === "3",
     `"Same mix for every colour" copies the first row down (Blue got ${blueCells[0].value},${blueCells[1].value}) — this is the "don't make me re-enter it per colour" complaint, answered`);
  ok(blueCells[2].disabled && blueCells[2].value === "",
     "…and it does NOT fill the cell that has no variant — copying a row must not invent stock");

  // -- 4. the sentence, which is the whole point ---------------------------
  const preview = el.querySelector("#os-box-preview");
  const text = preview?.textContent || "";
  ok(/1 box of Red/.test(text) && /2 S/.test(text) && /8 pieces/.test(text),
     `the preview says what a buyer actually receives — got "${text.slice(0, 90)}". Hadi could not tell what he was building; this is the fix for that`);

  // -- 5. per-colour vs one fixed box --------------------------------------
  const sw = el.querySelector("#os-per-colour");
  ok(!!sw, "there is a 'buyer picks the colour' switch");
  sw.checked = false;
  sw.dispatchEvent(new dom.window.Event("change"));
  ok(/They pick nothing/.test(el.querySelector("#os-box-preview").textContent),
     "turning it off describes ONE fixed box the buyer cannot choose within — the mixed box, which the old UI could not express at all");

  // -- 6. the open pane exposes the settings that were unreachable ---------
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
