// =============================================================================
// CHECK: Inventory is ONE module, and nothing was lost folding it   (Batch 8B)
// =============================================================================
//
// WHAT THIS IS GUARDING
// ---------------------
// The wholesaler sidebar had FIFTEEN entries and seven of them were inventory:
// Inventory, Stock Movements, Barcode Labels, Locations, Suppliers,
// Intelligence, Scan to Receive. Batch 6 folded Products in and stopped there,
// which was fairly criticised as moving one item and calling it a system.
//
// Folding six screens into sub-tabs is the highest-regression change in this
// batch, for a specific and well-evidenced reason: **this project's failure
// mode is losing things during a move.** The 2.0 rewrite lost the size axis
// that way. Batch 6 moved Products and silently took the "create a product"
// button with it, which Hadi found by trying to make one.
//
// So this gate checks three separable things, and the distinction matters:
//
//   1. THE NAVIGATION SHRANK — exactly the six intended items left, and the
//      count landed on nine. Asserted against the real nav-config array.
//   2. EVERY RETIRED ROUTE STILL RESOLVES — asked of the real router, the same
//      call app.js makes. An installed PWA holds the OLD navigation in its
//      cache for as long as its service worker takes to revalidate, and every
//      bookmark anyone made still points at the old path. A retired route that
//      404s is a screen that "disappeared" for the person least able to
//      explain what happened.
//   3. EVERY SUB-TAB IS REAL — nine entries, nine distinct routes, nine
//      distinct render functions. A tab that exists in the strip and paints
//      nothing is worse than the scattered nav it replaced.
//
// And one thing that is NOT structural but sinks the whole idea if wrong:
//   4. NINE TABS MUST SURVIVE A PHONE. On a 360px screen nine labelled tabs are
//      about 900px of content. If tabs 5-9 are off-screen with nothing to
//      suggest they exist, the module has hidden six screens rather than
//      organised them. The strip must scroll AND say so, and the active tab
//      must be scrolled into view on load or a deep link lands on a tab the
//      reader cannot see is selected.
//
//   node checks/check_inventory_module.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

async function load(path, label) {
  try { return await import(path); }
  catch (e) { fail.push(`${label} — could not be loaded: ${String(e).split("\n")[0]}`); return null; }
}

// ------------------------------------------------------- 1. the navigation --
const navMod = await load("../js/lib/nav-config.js", "js/lib/nav-config.js");
const nav = navMod?.NAV_BY_ROLE?.wholesaler || [];

// The six that fold in. Named individually rather than counted, because
// "six fewer items" would also be satisfied by deleting the wrong six.
const ABSORBED = [
  ["/wholesaler/movements",    "Stock Movements"],
  ["/wholesaler/labels",       "Barcode Labels"],
  ["/wholesaler/locations",    "Locations"],
  ["/wholesaler/suppliers",    "Suppliers"],
  ["/wholesaler/intelligence", "Intelligence"],
  ["/wholesaler/receive-scan", "Scan to Receive"],
];

// The nine that stay. Asserted as a SET, so an item quietly disappearing is a
// failure even though the count would still be nine if something else was
// added in the same commit.
const EXPECTED_NAV = [
  "/wholesaler", "/wholesaler/orders", "/wholesaler/clients", "/wholesaler/catalogs",
  "/wholesaler/team", "/wholesaler/inventory", "/wholesaler/import",
  "/wholesaler/integrations", "/wholesaler/settings",
];

const navPaths = nav.map((i) => i.path);
ok(navPaths.length === 9, `the wholesaler sidebar has nine entries (got ${navPaths.length}) — fifteen was two screens' worth of scrolling before you reached Settings`);

for (const [path, label] of ABSORBED) {
  ok(!navPaths.includes(path), `"${label}" is no longer a top-level nav item — it is a view of your inventory, not a separate place`);
}
const missing = EXPECTED_NAV.filter((p) => !navPaths.includes(p));
ok(missing.length === 0, `every screen that should have stayed top-level did${missing.length ? `: MISSING ${missing.join(", ")}` : ""} — folding six things in must not quietly take a seventh`);

// ------------------------------------------- 2. every retired route resolves --
const routerMod = await load("../js/lib/router.js", "js/lib/router.js");
const wholesalerMod = await load("../js/views/wholesaler.js", "js/views/wholesaler.js");
const mobileOpsMod = await load("../js/views/mobile-ops.js", "js/views/mobile-ops.js");
const router = routerMod?.router;
if (router) {
  wholesalerMod?.registerWholesalerRoutes?.(router);
  mobileOpsMod?.registerMobileOpsRoutes?.(router);
}

for (const [path, label] of ABSORBED) {
  ok(!!router && router.matches(path) === true,
     `the OLD path ${path} still resolves — an installed phone holds the old navigation in its cache and every bookmark still points here; "${label}" must not 404 for the person least able to explain why`);
}
// Batch 6 set this precedent and it must not rot either.
ok(!!router && router.matches("/wholesaler/products") === true,
   "/wholesaler/products still resolves — the precedent Batch 6 set for retired routes");

// --------------------------------------------------- 3. nine real sub-tabs --
// Source-anchored to the INVENTORY_TABS byte range, not the whole file. The
// 15 Aug lesson: a whole-file search reported a feature PRESENT on a match
// inside .git/hooks, and another reported one MISSING because it searched for
// a name when the feature was a shape.
const src = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
const tabsBlock = src.match(/const INVENTORY_TABS = \[([\s\S]*?)\n\];/);
ok(!!tabsBlock, "INVENTORY_TABS is declared in js/views/wholesaler.js");

if (tabsBlock) {
  const body = tabsBlock[1];
  const keys    = [...body.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
  const paths   = [...body.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  const renders = [...body.matchAll(/render:\s*\([^)]*\)\s*=>\s*([A-Za-z0-9_$]+)\(/g)].map((m) => m[1]);

  ok(keys.length === 9, `Inventory has nine sub-tabs (got ${keys.length})`);
  ok(new Set(keys).size === keys.length, `every sub-tab key is distinct (${keys.join(", ")}) — two tabs sharing a key means one of them can never be the active one`);
  ok(new Set(paths).size === paths.length, "every sub-tab has its own route — a tab that shares a path with another cannot be linked to or reloaded onto");
  ok(new Set(renders).size === renders.length,
     `every sub-tab paints a DIFFERENT view (${renders.join(", ")}) — two tabs calling the same function is the shape of a fold that lost a screen`);

  for (const p of paths) {
    ok(!!router && router.matches(p) === true, `sub-tab route ${p} resolves — the tab is in the URL, so a reload lands where the reader was`);
  }
}

// ----------------------------------------------- 4. it has to survive a phone --
const css = ["brand.css", "components.css", "mobile.css"]
  .map((f) => { try { return readFileSync(new URL(`../css/${f}`, import.meta.url), "utf8"); } catch { return ""; } })
  .join("\n");

const stripRule = css.match(/\.sub-tabs\s*\{[^}]*\}/);
ok(!!stripRule && /overflow-x:\s*auto/.test(stripRule[0]),
   ".sub-tabs scrolls sideways — nine labelled tabs are roughly 900px, and a 360px phone is the narrow end of the devices your buyers actually hold");

ok(/\.sub-tabs-wrap[^{]*\{[^}]*\}/.test(css) && /sub-tabs-wrap[\s\S]{0,400}(mask-image|::after)/.test(css),
   "the strip has an edge fade — a row that scrolls with no visual hint that it scrolls has hidden six screens rather than organised them");

const subTabsSrc = readFileSync(new URL("../js/components/sub-tabs.js", import.meta.url), "utf8");
ok(/scrollIntoView|scrollLeft\s*=/.test(subTabsSrc),
   "the active sub-tab is scrolled into view on paint — otherwise a deep link to the ninth tab renders the ninth pane with the FIRST tab visible, and the reader cannot see which one is selected");

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
