// =============================================================================
// CHECK: the product panel opens where a human can actually see it  (Batch 8)
// =============================================================================
// Hadi, 23 August 2026:
//
//   "I can't see how to use the different ratio in the pre-pack and so on
//    in the catalog."
//
// The feature was not missing. Every product card in a catalog had a
// "Packs & ratios" button, the button was wired, the handler ran, the panel
// rendered. It rendered 1608px down a 911px viewport and the page did not
// scroll, because openProductPanel() appended it after the whole product grid
// and then relied on
//
//     card.scrollIntoView({ block: "nearest" })
//
// resolving against a scrolling container that was not the one scrolling.
// It silently did nothing. No error. No console warning. Nothing moved.
//
// Measured on production before the fix:
//     panel top 1608px · viewport 911px · page scrolled 0px
//
// WHAT THIS FILE ASSERTS, AND WHY IT IS SHAPED THIS WAY
// -----------------------------------------------------
// The obvious gate -- "call scrollIntoView and check the panel is on screen"
// -- cannot be written honestly in jsdom: jsdom does not lay out or scroll,
// so getBoundingClientRect() returns zeroes and EVERY panel looks perfectly
// positioned. A gate written that way would have passed against the broken
// code. That is the exact failure this repo keeps a ledger about, so it is
// not repeated here.
//
// Instead this asserts the STRUCTURAL property that makes the bug impossible:
// the panel must be positioned against the VIEWPORT, not appended into page
// flow after a grid of unknown height. A fixed-position element cannot open
// off-screen no matter how many products sit above it, how far the page is
// scrolled, or which element owns the scrollbar -- the three things the old
// panel depended on and one of which silently changed.
//
// Proven red before being trusted: reverting openProductPanel to append into
// panelHost fails assertions 1, 2 and 3 below.
//
//   node checks/check_packs_panel_reachable.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>",
                      { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const src = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/components.css", import.meta.url), "utf8");

// Cut out openProductPanel's exact byte range, so a match anywhere else in a
// 200KB file cannot pass this. Same technique as check_inventory_panes.mjs,
// and for the same reason: on 15 Aug a feature check reported PRESENT because
// its string matched inside .git/hooks/*.sample.
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

const body = fnBody("openProductPanel");
ok(!!body, "openProductPanel() exists — the single opener shared by Products and Catalogs");

// -- 1. the panel is no longer appended into page flow after the grid --------
// This is the line that produced the 1608px. `panelHost` is still accepted as
// a parameter (both call sites pass it) but must no longer receive the panel.
ok(!!body && !/panelHost\.appendChild\s*\(/.test(body),
   "the panel is NOT appended into panelHost — that div sits after the entire product grid, which is what put it 1608px down the page");

// -- 2. it is attached to the document, not to the scrolling page content ----
ok(!!body && /document\.body\.appendChild\s*\(/.test(body),
   "the panel is attached to document.body, so its position cannot depend on how tall the grid above it is");

// -- 3. it does not depend on a scroll call landing correctly ----------------
ok(!!body && !/scrollIntoView/.test(body),
   "openProductPanel does not call scrollIntoView — visibility is structural, not the result of a scroll that can silently no-op");

// -- 4. fixed to the viewport in CSS, in both layouts ------------------------
const rootRule = css.match(/\.pdrawer-root\s*\{[^}]*\}/);
ok(!!rootRule && /position:\s*fixed/.test(rootRule[0]),
   ".pdrawer-root is position:fixed — pinned to the viewport, so it cannot open off-screen");

const drawerRule = css.match(/\.pdrawer\s*\{[^}]*\}/);
ok(!!drawerRule && /position:\s*absolute/.test(drawerRule[0]),
   ".pdrawer is positioned inside that fixed root rather than flowing with the page");

// A drawer that is 100% tall with no inner scroller traps long content off the
// bottom of the screen -- the same bug in a new costume.
const bodyRule = css.match(/\.pdrawer-body\s*\{[^}]*\}/);
ok(!!bodyRule && /overflow-y:\s*auto/.test(bodyRule[0]),
   ".pdrawer-body scrolls internally — a long ratio builder cannot run off the bottom with no way to reach it");

// The way out must not scroll away with the content.
const headRule = css.match(/\.pdrawer-head\s*\{[^}]*\}/);
ok(!!headRule && /position:\s*sticky/.test(headRule[0]),
   ".pdrawer-head is sticky — Close stays reachable however far the panel is scrolled");

// -- 5. it must survive a phone ---------------------------------------------
ok(/@media\s*\(max-width:\s*720px\)[\s\S]{0,600}\.pdrawer\s*\{/.test(css),
   "there is a phone layout — a 560px right-hand drawer on a 390px screen is not a drawer, it is the whole screen with no way back");

// -- 6. it cannot become the NEXT orphaned dialog ----------------------------
// A drawer on document.body is NOT removed when the view underneath repaints.
// That is precisely the orphaned product-edit dialog found sitting over the
// dashboard on 23 Aug, and the fix for one bug must not install the other.
ok(!!body && /v2:navigated/.test(body),
   "the drawer closes on navigation — it lives on document.body, so a repaint underneath would otherwise leave it floating over an unrelated screen");
ok(!!body && /Escape/.test(body),
   "Escape closes the drawer");

// -- 7. the dead end behind it is gone --------------------------------------
// Reaching the panel is worthless if it then says "add variants first" and
// offers nothing to press. Anchored to renderRatioSection's byte range.
const ratio = (() => {
  const start = src.indexOf("async function renderRatioSection(");
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
})();
ok(!!ratio, "renderRatioSection() exists");
ok(!!ratio && /Add colours & sizes/.test(ratio),
   "the no-variants state offers a button to add them, instead of stating a rule and refusing to say where it is satisfied");
ok(!!ratio && /openProductEditor\s*\(/.test(ratio),
   "that button opens the real product editor — one editor, not a second half-copy of it that drifts");
ok(!!ratio && /getProductForEdit\s*\(/.test(ratio),
   "it refetches after saving, so the ratio is built over sizes the database actually accepted");

// -- 8. the selling model is finally visible --------------------------------
const smSrc = readFileSync(new URL("../js/lib/selling-model.js", import.meta.url), "utf8");
const { sellingModelBadge, MODEL_SHORT } = await import("../js/lib/selling-model.js");
for (const m of ["ratio", "prepack", "series"]) {
  const b = sellingModelBadge(m);
  ok(!!b && b.text === MODEL_SHORT[m] && !!b.title,
     `"${m}" gets a badge with a hover that says what it does to the buyer — enforced server-side since migration 029/030 and, until Batch 8, never shown anywhere`);
}
ok(sellingModelBadge("open") === null,
   "open stock gets NO badge — it is the default and the majority; badging it would bury the three models that actually change how an order must be placed");
ok(sellingModelBadge("nonsense") === null && sellingModelBadge(undefined) === null,
   "an unknown or missing model produces no badge rather than an invented one");

// Both surfaces must use the SHARED helper. Two hand-rolled copies of a label
// is how Products and Catalogs start disagreeing about what a product is.
ok(/import\s*\{\s*sellingModelBadge\s*\}/.test(src),
   "wholesaler.js imports the shared badge helper");
ok((src.match(/sellingModelBadge\(/g) || []).length >= 2,
   "both Products and Catalogs use it — not one screen with a copy of the label in the other");

// ---------------------------------------------------------------- report ----
const line = "-".repeat(64);
console.log("\nPacks & ratios: reachable, usable, and honest about the selling model\n" + line);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log(line);
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — all ${pass.length} assertions held.\n`);
