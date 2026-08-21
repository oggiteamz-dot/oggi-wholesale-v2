// =============================================================================
// CHECK: folding Products into Inventory did not lose anything   (Batch 6)
// =============================================================================
// Hadi asked for Products to become a sub-tab of Inventory. Six things lived
// ONLY on the Products screen, and moving a screen is exactly when they go
// missing quietly -- the batch plan says so in as many words: "Deleting
// Products loses a feature -> Batch 6 is last and gated on new homes existing."
// This file is that gate.
//
// It checks three different kinds of thing, and the difference matters:
//
//   1. THE ROUTES, against the real router. The real registerWholesalerRoutes()
//      is run against the real js/lib/router.js and asked whether each path
//      resolves. Not a string search -- an actual resolution, the same call
//      app.js makes.
//
//   2. THE TAB BAR, rendered in a real DOM. Which tab is marked active, what
//      aria-selected says, what clicking does.
//
//   3. THE SIX FEATURES, anchored to the pane they must live in. This part IS
//      source-based, and it is worth being precise about why that is not the
//      failure this project has burned on before. On 15 Aug a feature check
//      reported "Full series: PRESENT" because the string matched inside
//      .git/hooks/*.sample, and another reported "Product images: MISSING"
//      because it searched for a table name when the feature is a column. Both
//      searched a whole file (or tree) for a word. This one parses out the
//      exact byte range of each pane function and asserts the feature appears
//      INSIDE that range -- so "the string is somewhere in the 200KB file"
//      cannot pass, and a feature that survived the move but landed in the
//      wrong pane fails.
//
//   node checks/check_inventory_panes.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

/** Import a project module, reporting a missing one as a FAILED ASSERTION
 *  rather than crashing. Run against the pre-Batch-6 tree this file died on
 *  `js/components/sub-tabs.js` not existing and reported none of its other 26
 *  findings -- the same "a gate that only throws tells you nothing" trap the
 *  Batch 5 card gate hit. A negative test is only useful if you can read it. */
async function load(path, label) {
  try { return await import(path); }
  catch (e) { fail.push(`${label} — could not be loaded: ${String(e).split("\n")[0]}`); return null; }
}

// ---------------------------------------------------------------- 1. routes --
const routerMod = await load("../js/lib/router.js", "js/lib/router.js");
const wholesalerMod = await load("../js/views/wholesaler.js", "js/views/wholesaler.js");
const router = routerMod?.router;
if (router && wholesalerMod?.registerWholesalerRoutes) wholesalerMod.registerWholesalerRoutes(router);

for (const [path, why] of [
  ["/wholesaler/inventory",          "the screen itself"],
  ["/wholesaler/inventory/products", "the Products pane, which is where the old screen went"],
  ["/wholesaler/inventory/pricing",  "the Pricing rules pane, the new home for the two catalogue-wide controls"],
  ["/wholesaler/products",           "the OLD path — kept, because an installed PWA can hold the old navigation in its cache and a bookmark outlives any refactor"],
]) {
  ok(!!router && router.matches(path) === true, `${path} resolves — ${why}`);
}

// --------------------------------------------------------------- 2. the bar --
const subTabsMod = await load("../js/components/sub-tabs.js", "js/components/sub-tabs.js — the component the whole fold is built on");
const renderSubTabs = subTabsMod?.renderSubTabs;

const painted = [];
const TABS = [
  { key: "stock",    icon: "📊", label: "Stock",         path: "/wholesaler/inventory",          render: (h) => { painted.push("stock");    h.textContent = "STOCK"; } },
  { key: "products", icon: "📦", label: "Products",      path: "/wholesaler/inventory/products", render: (h) => { painted.push("products"); h.textContent = "PRODUCTS"; } },
  { key: "pricing",  icon: "💲", label: "Pricing rules", path: "/wholesaler/inventory/pricing",  render: (h) => { painted.push("pricing");  h.textContent = "PRICING"; } },
];

if (!renderSubTabs) {
  fail.push("the sub-tab bar cannot be exercised at all, because the component is missing");
} else {
  const t = renderSubTabs({ tabs: TABS, active: "products" });
  await t.paint();
  const btns = [...t.el.querySelectorAll(".sub-tab")];
  ok(btns.length === 3, `three tabs render (got ${btns.length})`);
  ok(painted.length === 1 && painted[0] === "products", `only the ACTIVE pane is painted (painted ${JSON.stringify(painted)}) — painting all three would run three sets of queries to show one`);
  const active = btns.filter((b) => b.getAttribute("aria-selected") === "true");
  ok(active.length === 1 && /Products/.test(active[0].textContent), `exactly one tab is aria-selected, and it is Products (got "${active[0]?.textContent?.trim()}")`);
  ok(active[0].classList.contains("sub-tab-active"), "and it is marked visually as well as for assistive tech");
  ok(t.el.querySelector(".sub-tab-pane")?.textContent === "PRODUCTS", "the pane content is the active tab's");
}

if (renderSubTabs) {
  // Clicking a tab NAVIGATES. The tab has to be in the URL, or a reload
  // silently sends the reader back to a tab they were not on and they blame
  // themselves for losing their place.
  const t = renderSubTabs({ tabs: TABS, active: "stock" });
  await t.paint();
  const btns = [...t.el.querySelectorAll(".sub-tab")];
  dom.window.location.hash = "#/wholesaler/inventory";
  btns[2].dispatchEvent(new dom.window.Event("click"));
  ok(dom.window.location.hash === "#/wholesaler/inventory/pricing",
     `clicking "Pricing rules" changes the URL (got ${dom.window.location.hash}) rather than swapping panes invisibly`);

  const before = dom.window.location.hash;
  btns[0].dispatchEvent(new dom.window.Event("click"));  // the ALREADY-active tab
  ok(dom.window.location.hash === before, "clicking the tab you are already on does nothing — no redundant navigation, no re-render");
}

// --------------------------------------------- 3. the six features, anchored --
const src = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");

/** The byte range of one top-level `async function NAME(` ... up to the next
 *  top-level function. Anchoring to a range is what stops this from being the
 *  "the word is somewhere in the file" check that has lied here before. */
function bodyOf(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return null;
  const rest = src.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function [A-Za-z_$]/);
  return nextFn < 0 ? src.slice(start) : src.slice(start, start + 1 + nextFn);
}

const productsPane = bodyOf("productsPane");
const pricingPane  = bodyOf("pricingRulesPane");
const stockPane    = bodyOf("stockPane");

ok(!!productsPane, "productsPane() exists");
ok(!!pricingPane,  "pricingRulesPane() exists");
ok(!!stockPane,    "stockPane() exists");

const SIX = [
  ["pricing tiers",          productsPane, "renderPricingPanel",  "Products pane, on each card"],
  ["product MOQ",            productsPane, "Pricing & MOQ",       "the same panel"],
  ["archive / unarchive",    productsPane, "toggleArchived",      "Products pane, on each card"],
  ["duplicate as template",  productsPane, "duplicateAsTemplate", "Products pane, on each card"],
  ["bulk price update",      pricingPane,  "applyBulkPrice",      "Pricing rules pane, rebuilt safe"],
  ["order-level minimum",    pricingPane,  "setOrderMinimums",    "Pricing rules pane"],
];
for (const [feature, body, needle, home] of SIX) {
  ok(!!body && body.includes(needle), `"${feature}" survived the fold and lives in its stated home: ${home}`);
}

// It has to be GONE from where it used to be, too. A feature that exists in
// both panes is a feature that will be fixed in one of them.
ok(!!productsPane && !productsPane.includes("setOrderMinimums"), "the order minimum no longer also sits at the foot of the product list");
ok(!!productsPane && !productsPane.includes("applyBulkPrice") && !productsPane.includes("bulkUpdatePrice"),
   "and neither does the bulk reprice — a control that changes every price in the catalogue does not belong under a grid people scroll past forty times a day");

// The old unsafe path must not be callable any more.
const admin = readFileSync(new URL("../js/data/products-admin.js", import.meta.url), "utf8");
ok(/RETIRED AS A CAPABILITY/.test(admin), "js/data/products-admin.js's old bulkUpdatePrice is retired in place, not deleted, so a later caller fails visibly");
ok(!/for \(const u of updates\)/.test(admin), "and its browser-side per-variant UPDATE loop is gone");

// --------------------------------------------------------- 4. the navigation --
const nav = readFileSync(new URL("../js/lib/nav-config.js", import.meta.url), "utf8");
const wholesalerBlock = nav.slice(nav.indexOf("wholesaler: ["), nav.indexOf("sales: ["));
ok(!/label:\s*"Products"/.test(wholesalerBlock), "the wholesaler navigation no longer lists Products as its own destination");
ok(/label:\s*"Inventory"/.test(wholesalerBlock), "Inventory is still there — it is the screen Products folded into");
ok(/\/wholesaler\/products/.test(nav), "and the comment explaining where it went names the surviving route, so the next person does not 'restore' it");

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
