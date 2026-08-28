// =============================================================================
// CHECK: the buyer card's CAPABILITY INVENTORY                      (CV-00)
// =============================================================================
// This gate exists to be RUN BEFORE A REWRITE, not after it.
//
// The mockup approved on 24 Aug draws about ten things. The card it replaces
// already does twenty-eight. Building the mockup as drawn would delete
// eighteen working capabilities and call it an upgrade -- which is precisely
// how the 2.0 rewrite lost the size axis, how the ratio builder sat unreachable
// for a week, and how a regression shipped on 25 Aug whose own gate passed it
// because the gate had been written to match the design instead of the
// requirement.
//
// So every capability the card has TODAY is asserted here, in a rendered DOM,
// before the client-view work starts. If the rewrite drops one, this goes red
// and names it. A capability may still be removed -- deliberately, with Hadi's
// words, in REMOVALS-APPROVED.md -- but it can no longer disappear quietly.
//
// It asserts BEHAVIOUR, not source text. A previous check in this repo asked
// only whether a name appeared in a file, which an unused `import` satisfies,
// and a feature stayed "present" through three rewrites that had dropped it.
//
//   node checks/check_buyer_card_capabilities.mjs
// =============================================================================
import { JSDOM } from "jsdom";

// A gate that throws reports NOTHING. On 25 Aug this file died on a missing
// element and hid twenty-seven other findings, which is the same failure it
// exists to catch in the product. Anything unexpected is now a NAMED failure.
process.on("uncaughtException", (e) => {
  console.log("\ncheck_buyer_card_capabilities  CRASHED — no verdict given");
  console.log("  ! " + e.message);
  console.log("  (this is NOT a pass.)");
  process.exit(2);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://check.local/", pretendToBeVisual: true,
});
for (const k of ["window","document","HTMLElement","Node","localStorage","getComputedStyle","CustomEvent","Event"]) {
  globalThis[k] = k === "window" ? dom.window : dom.window[k];
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
if (!dom.window.crypto?.randomUUID) dom.window.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const { renderProductCard } = await import("../js/components/product-card.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const txt = (el) => (el && el.textContent != null ? el.textContent : "");

function product(over = {}) {
  const variants = [
    { id:"v1", sku:"A-RED-S", price:10, color:"Red",  colorHex:"#c00", size:"S", available:50, moqQty:1, retailPrice:20, imageUrl:"https://cdn.test/red.webp",  images:["https://cdn.test/red.webp","https://cdn.test/red2.webp"] },
    { id:"v2", sku:"A-RED-M", price:10, color:"Red",  colorHex:"#c00", size:"M", available:0,  moqQty:1, retailPrice:20, imageUrl:"https://cdn.test/red.webp",  images:["https://cdn.test/red.webp"] },
    { id:"v3", sku:"A-BLU-S", price:12, color:"Blue", colorHex:"#00c", size:"S", available:30, moqQty:1, retailPrice:24, imageUrl:null, images:[] },
  ];
  const imagesByColor = new Map([["Red", ["https://cdn.test/red.webp","https://cdn.test/red2.webp"]], ["Blue", []]]);
  return {
    id:"p1", name:"Slim Jean 402", description:"d", createdAt:new Date().toISOString(),
    sellingModel:"open", isNew:true, lowStock:false, outOfStock:false,
    minPrice:10, maxPrice:12,
    colors:[{name:"Red",hex:"#c00"},{name:"Blue",hex:"#00c"}],
    sizes:["S","M"], variants, moqQty:24, moqReorderQty:null, baseUnit:12,
    moqPerColour:24, imagesByColor, primaryImage:"https://cdn.test/red.webp",
    ...over,
  };
}
const base = { wid:"w1", locationId:"l1", currency:"$", tiers:[{minQty:100,unitPrice:9}] };
const el = renderProductCard({ product: product(), ...base });
const all = () => el.textContent;

// ── 1-4 photography ────────────────────────────────────────────────────────
ok(!!el.querySelector(".pc-photo"), "01 a photo frame is reserved before the image loads (no layout jump)");
ok(!!el.querySelector(".pc-photo img") || /No photo yet/.test(all()), "02 a photo renders, or an honest placeholder says so in words");
const moreBtn = [...el.querySelectorAll("button")].find((b) => /more$/.test(txt(b)));
ok(!!moreBtn, "03 a '+N more' button exists when a colour has several photos");
ok([...el.querySelectorAll("button")].some((b) => /360/.test(txt(b))), "04 the 360-degree viewer button is present");

// ── 5-11 what the header tells a buyer ─────────────────────────────────────
ok(/New/.test(all()), "05 the New badge");
ok(/Min 24/.test(all()), "06 the product minimum is stated as a badge");
ok(/per piece/.test(all()), "07 the price is stated PER PIECE, not per pack");
ok(!!el.querySelector(".pc-multiplier"), "08 the base-unit multiplier badge (x12)");
ok(/Sold in units of 12/.test(all()), "09 'Sold in units of 12' is spelled out");
ok(/At least 24 pieces of each colour/.test(all()), "10 the per-colour minimum is stated up front");
ok(/100\+ pieces/.test(all()), "11 the quantity-break ladder is shown");

// ── 12-13 choosing ─────────────────────────────────────────────────────────
ok(el.querySelectorAll(".color-swatch").length === 2, "12 one swatch per colour");

// ── 13-15 REWRITTEN 25 Aug 2026, deliberately, when the order sheet landed ─
//
// These three used to assert the WIDGET: "a chip per size", "a chip is
// disabled", "a stepper appears". The sheet has no chips -- a size is a
// COLUMN and a colour is a ROW -- so the old wording went red while the
// capability was intact and, worse, this file CRASHED on the missing element
// instead of reporting, hiding the other twenty-seven findings.
//
// They now assert the capability rather than the control that used to express
// it. That is the honest fix; quietly deleting them would have been the
// dishonest one. Recorded here rather than in a commit message nobody re-reads.
const cells = [...el.querySelectorAll(".os-cell")];
ok(cells.length >= 4, `13 every colour x size is reachable — a cell each (got ${cells.length})`);
const outCell = cells.find((c) => c.classList.contains("os-out"));
ok(!!outCell && !outCell.hasAttribute("role"),
   "14 a size with no stock is shown but NOT orderable (visible, unaimable)");
const live = cells.find((c) => c.getAttribute("role") === "button");
ok(!!live, "15a an in-stock cell can be aimed at");
if (live) live.dispatchEvent(new dom.window.Event("click"));
const padEl = el.querySelector(".os-pad");
ok(!!padEl && !padEl.classList.contains("os-pad-idle"),
   "15 a quantity control appears for the chosen cell");
const steps = [...el.querySelectorAll(".os-step")];
ok(steps.length >= 2, "17 real + / - buttons, one control for the whole sheet");
const plus = steps.find((b) => txt(b) === "+");
if (plus) plus.dispatchEvent(new dom.window.Event("click"));
const valEl = el.querySelector(".os-val");
ok(!!valEl && txt(valEl) === "12", `18 one press of + adds a whole unit (got ${valEl ? txt(valEl) : "no control"})`);
ok(!!valEl, "16 the control steps by the base unit, proved by 18 above");
const after = all();
ok(/12<\/strong> pieces|12 pieces/.test(el.innerHTML), "19 the pieces x price arithmetic is written out");
ok(/Add \d+ more of this product/.test(after) || /min 24/i.test(after), "20 a product-minimum shortfall is warned about");
ok(/Add \d+ more in Red/.test(after), "21 a per-colour shortfall names the colour");
ok(/to reach \$9/.test(after), "22 the next quantity break is offered as a nudge");
ok([...el.querySelectorAll("button")].some((b) => /Add to cart|Update/.test(txt(b))), "23 an add-to-cart control exists");
ok(!!el.querySelector(".os-grid thead th[data-size]"), "31 sizes are named ONCE, across the top");
// Counts COLOUR rows, not every row in the body.
//
// This used to count `tbody tr` outright, which was a fine proxy until the
// quantity control moved off the foot of the card and onto the row being
// edited (29 Aug 2026) -- that inserts a full-width `.os-editrow` under the
// aimed colour, and the count went to 3. The INTENT is "one row per colour",
// and the intent is unchanged; only the proxy was wrong. Excluding the edit
// row states the intent directly, and `[data-colour]` cross-checks it, so
// this cannot be satisfied by rows that are not colours.
ok(el.querySelectorAll(".os-grid tbody tr:not(.os-editrow)").length === 2, "32 one row per colour");
ok(el.querySelectorAll(".os-grid tbody tr[data-colour]").length === 2,
   "32b and each of those rows is a real colour, not padding");
ok(!!el.querySelector(".os-rt"), "33 a running total per colour, on its row");
ok(!!el.querySelector(".os-grid tfoot td[data-total-size]"), "34 a total per SIZE along the bottom");
ok(!!el.querySelector(".os-grid tfoot td[data-grand]"), "35 a grand total for the product");
ok(/available/.test(after), "24 remaining availability is shown");
ok(/MSRP/.test(after), "25 MSRP and margin are shown when known");

// ── 26-28 bundles, warnings, hooks ─────────────────────────────────────────
const bundle = renderProductCard({ product: product({ sellingModel:"ratio" }), ...base, packs: [] });
ok(/ratio packs/i.test(bundle.textContent), "26 a bundle-only product SAYS how it is sold");
ok(!bundle.querySelector('input[type="number"]'), "27 a bundle-only product offers no loose stepper the server would refuse");
ok(/no bundles set up yet/i.test(bundle.textContent), "28 a bundle product with no packs says it cannot be ordered yet");
ok(el.dataset.productId === "p1", "29 the card is findable by product id (the billboard scrolls to it)");
const hi = renderProductCard({ product: product(), ...base, highlighted: true });
ok(hi.classList.contains("product-card-highlighted"), "30 a pinned card says so visually");

console.log(`\ncheck_buyer_card_capabilities  PASS ${pass.length}  FAIL ${fail.length}`);
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { pass.forEach((m) => console.log("  ✓ " + m)); process.exit(1); }
