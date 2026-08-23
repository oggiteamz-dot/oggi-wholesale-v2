// =============================================================================
// CHECK: the app never loses your place            (Batch 8A, 23 Aug 2026)
// =============================================================================
// WHAT WENT WRONG, PRECISELY
// --------------------------
// Hadi: "I created a catalog and got sent back to the dashboard."
//
// The Batch 8 plan blamed js/app.js:97 (the not-found redirect). It was wrong,
// and it is worth writing down why, because the wrong diagnosis would have
// produced a fix that changed nothing.
//
// catalogsView() holds the catalog you are looking at in a plain variable:
//
//     let activeId = catalogs.find((c) => c.isDefault)?.id || catalogs[0].id;
//
// and after creating one it re-runs the whole view:
//
//     outlet.innerHTML = ""; catalogsView(outlet);
//
// which recomputes activeId FROM THE DEFAULT CATALOG. You create "Summer 26",
// the screen redraws, and you are back on Main Catalog. It never went to the
// dashboard. It went back to the first tab, which from the outside looks the
// same as being thrown out.
//
// The same variable is also wiped by any reload, any back button, and any
// re-render from anywhere. So the fix is a ROUTE, not a patch to one button.
//
// THE SECOND HALF: ORPHANED DIALOGS
// ---------------------------------
// On the morning of 23 Aug an edit form was found sitting open over the
// dashboard. Its cause: the "N on hand" link inside the product edit form runs
//     location.hash = "#/wholesaler/inventory"
// which navigates the page out from under a dialog that stays in the DOM,
// because a dialog appended to document.body does not care that the view
// underneath it was replaced.
//
// openProductPanel() already defends against this (it listens for
// "v2:navigated"). overlayHost() -- which is what the product VIEW and the
// product EDITOR both use -- does not. Neither does the ban dialog, nor the
// transfer dialog. Defending one of four is how the fourth one bites.
//
// So this gate asserts a SHARED mechanism exists and works, rather than
// asserting that four separate functions each remembered.
//
//   node checks/check_route_state.mjs
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

// ---------------------------------------------------------------- 1. ROUTES --
// Asked of the REAL router, the same call app.js makes. Not a string search:
// a route can be written in the file and still not resolve if its pattern is
// wrong, and a string search cannot tell the difference.
const routerMod = await load("../js/lib/router.js", "js/lib/router.js");
const wholesalerMod = await load("../js/views/wholesaler.js", "js/views/wholesaler.js");
const router = routerMod?.router;
if (router && wholesalerMod?.registerWholesalerRoutes) wholesalerMod.registerWholesalerRoutes(router);

for (const [path, why] of [
  ["/wholesaler/catalogs",
   "the list itself — the OLD path, which must keep resolving because it is what everyone has bookmarked"],
  ["/wholesaler/catalogs/6f1c2d3e-0000-4000-8000-000000000001",
   "ONE catalog by id — this is the actual fix for 'I created a catalog and got sent back'. Without it the selected catalog lives in a variable that every re-render resets to the default"],
  ["/wholesaler/catalogs/6f1c2d3e-0000-4000-8000-000000000001/product/abc-123/packs",
   "the packs & ratios drawer as a PLACE — so a reload with it open lands with it open, instead of silently dropping you back to the grid"],
]) {
  ok(!!router && router.matches(path) === true, `${path} resolves — ${why}`);
}

// Control assertions. If these ever fail, the gate itself has broken its
// router setup and every finding above is meaningless -- which is exactly how
// a gate reports "all clear" while testing nothing.
for (const path of ["/wholesaler", "/wholesaler/inventory", "/wholesaler/orders"]) {
  ok(!!router && router.matches(path) === true, `CONTROL: ${path} still resolves (if this fails, the gate is broken, not the app)`);
}

// ------------------------------------------------------ 2. THE MODAL STACK --
// A behavioural test, not a source search. Two dialogs are opened, a
// navigation is announced, and the DOM is asked how many are left.
const stackMod = await load("../js/lib/modal-stack.js",
  "js/lib/modal-stack.js — the ONE place a dialog is opened, so 'closes on navigation' is a property of the mechanism rather than something four call sites each had to remember");

if (stackMod?.openModal && stackMod?.closeTopModal && stackMod?.closeAllModals) {
  const a = dom.window.document.createElement("div");
  a.className = "test-modal-a";
  const b = dom.window.document.createElement("div");
  b.className = "test-modal-b";

  let aClosed = false, bClosed = false;
  stackMod.openModal(a, { label: "first",  onClose: () => { aClosed = true; } });
  ok(dom.window.document.body.contains(a), "openModal() actually puts the dialog in the document");
  ok(dom.window.document.body.style.overflow === "hidden", "the page behind a dialog cannot be scrolled — otherwise a phone scrolls the page instead of the sheet");

  stackMod.openModal(b, { label: "second", onClose: () => { bClosed = true; } });
  ok(stackMod.modalDepth() === 2, `two dialogs stack rather than clobbering each other (depth ${stackMod.modalDepth?.()})`);

  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  dom.window.document.dispatchEvent(new dom.window.CustomEvent("v2:navigated", { detail: { path: "/wholesaler/inventory" } }));
  ok(!dom.window.document.body.contains(a) && !dom.window.document.body.contains(b),
     "a route change removes EVERY open dialog from the DOM — this is the orphaned edit form found sitting over the dashboard on 23 Aug");
  ok(aClosed && bClosed, "and each one's onClose ran, so nothing is left holding a keydown listener or a body-scroll lock");
  ok(dom.window.document.body.style.overflow !== "hidden",
     "the scroll lock is released — a lock that outlives its dialog leaves the whole app unscrollable with nothing on screen to explain it");

  // Escape closes only the top one. A stacked confirm inside an editor must
  // not take the editor down with it.
  const c = dom.window.document.createElement("div");
  const d = dom.window.document.createElement("div");
  stackMod.openModal(c, { label: "editor" });
  stackMod.openModal(d, { label: "confirm inside the editor" });
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  ok(dom.window.document.body.contains(c) && !dom.window.document.body.contains(d),
     "Escape closes only the TOP dialog — a confirm opened inside an editor must not close the editor underneath it");
  stackMod.closeAllModals();
  ok(stackMod.modalDepth() === 0, "closeAllModals() empties the stack");
} else {
  fail.push("the modal stack cannot be exercised at all, because js/lib/modal-stack.js does not export openModal/closeTopModal/closeAllModals");
}

// --------------------------------------------- 3. NO NAVIGATION-FROM-DIALOG --
// Source-anchored, and anchored to a RANGE rather than to the whole file --
// the 15 Aug lesson, where a feature check passed on a match inside
// .git/hooks/*.sample and another missed a feature because it searched for a
// name instead of a shape.
const formSrc = readFileSync(new URL("../js/components/product-form.js", import.meta.url), "utf8");
ok(!/location\.hash\s*=/.test(formSrc),
   "the product form never sets location.hash — it is a DIALOG, and navigating from inside one leaves it hanging over whatever loads next (this is the 'N on hand' trapdoor at product-form.js:1239)");

// Every view that opens a dialog must do it through the stack. A bare
// `document.body.appendChild(overlay)` is a dialog nobody can close for you.
// Widened 23 Aug after the first three sites were converted: the original
// regex only knew the names `overlay` and `root`, so the ban dialog (`back`)
// and the product picker (`picker.el`) sailed straight past it. A gate that
// matches the variable names it happens to have seen is a gate that goes
// green while the next dialog is still undefended -- the same shape as the
// 15 Aug check that searched for a table name when the feature was a column.
//
// Every file below opens a REAL dialog. Deliberately excluded, with reasons:
//   toast.js, register-sw.js      — notifications, not dialogs; navigating past
//                                   a toast is correct behaviour
//   order-celebration, fly-to-cart,
//   product-hologram              — decorative animations that remove themselves
//   csv-export.js                 — a hidden <a> clicked to trigger a download
//   bottomnav.js                  — the More hub, which already closes on
//                                   navigation via its own openHub handle
const DIALOG_FILES = [
  ["../js/views/wholesaler.js",         "product view, product editor, packs drawer, ban dialog, product picker"],
  ["../js/components/client-form.js",   "the add/edit client sheet"],
  ["../js/components/product-form.js",  "the image cropper opened from inside the product form"],
  ["../js/components/image-gallery.js", "the full-screen photo viewer"],
  ["../js/components/scan-bar.js",      "the camera scanner overlay"],
];

for (const [rel, what] of DIALOG_FILES) {
  const fileSrc = readFileSync(new URL(rel, import.meta.url), "utf8");
  const bare = [...fileSrc.matchAll(/document\.body\.appendChild\(/g)];
  ok(bare.length === 0,
     `${rel.replace("../", "")} appends no dialog to document.body directly (found ${bare.length}) — ${what} all go through the modal stack, so 'closes on navigation' cannot be forgotten by whoever writes the next one`);
}

// ------------------------------------------------------------------ report --
const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`);
  process.exit(1);
}
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
