// =============================================================================
// OGGI Wholesale v2 — GATE 6: TOUCH TARGET SIZE
// =============================================================================
//
// WHAT THIS IS ACTUALLY CHECKING, STATED HONESTLY
// -----------------------------------------------
// This app does NOT violate WCAG 2.2 AA on target size. SC 2.5.8 sets the AA
// floor at 24x24 CSS px, and every control here clears it: buttons are 38px,
// small buttons 30px, colour swatches 26px. Claiming an accessibility
// violation would be overstating it, and a gate that cries wolf gets switched
// off.
//
// What it checks is the PLATFORM guidance, which is stricter and is the one
// that matters for the people who use this:
//     Apple HIG      44 x 44 pt
//     Material       48 x 48 dp  ("about 9mm; recommended 7-10mm")
//     WCAG AAA 2.5.5 44 x 44 px
//
// The users are wholesalers and buyers working from phones -- counting stock
// on a warehouse floor, taking an order in a showroom, one hand holding a
// carton. Hoober's field study (1,333 observations) found ~85% of phone
// interactions are thumb-driven. A 30px size chip is hittable sitting at a
// desk and frustrating standing up.
//
// THRESHOLD: 44px, on TOUCH POINTERS ONLY.
//
// WHY POINTER AND NOT VIEWPORT WIDTH
// ----------------------------------
// The fix keys off `@media (pointer: coarse)`, not a width breakpoint, and
// this gate tests the same way. Width is a bad proxy for input method: a
// touchscreen laptop at 1400px is a coarse pointer and needs the bigger
// targets; a mouse user with a narrow browser window does not, and blowing
// their controls up to 44px would waste space for no benefit.
//
// RUN:  node checks/check_touch_targets.mjs
// PROVEN TO GO RED — run against the pre-fix stylesheet it reported 9
// controls under the threshold. See checks/GATE-EVIDENCE.md.
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "checks/screenshots");
const PORT = 8145;
const MIN = 44;

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript",
  ".png":"image/png", ".woff2":"font/woff2" };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const f = join(ROOT, p === "/" ? "/index.html" : p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(PORT, r));
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// A gallery of every interactive control the app renders, using the REAL
// classes and the REAL inline styles copied from the components that produce
// them. Rendering the live views would need a login and a database; this
// isolates the thing being measured, which is the CSS.
//
// The colour swatch and swatch row markup mirrors js/components/product-card.js
// exactly, including its inline width/height -- that is the whole point, since
// inline styles are what makes those two hard to fix from CSS.
// ---------------------------------------------------------------------------
const GALLERY = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/fonts.css">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/layout.css">
<link rel="stylesheet" href="/css/mobile.css">
<link rel="stylesheet" href="/css/brand.css">
</head><body><div id="app-root"><main id="view-outlet">

<div class="card" style="padding:16px;margin-bottom:12px">
  <button class="btn btn-primary" data-t="btn-primary">Add pack</button>
  <button class="btn btn-secondary" data-t="btn-secondary">View details</button>
  <button class="btn btn-ghost" data-t="btn-ghost">Cancel</button>
  <button class="btn btn-danger" data-t="btn-danger">Delete</button>
</div>

<div class="card" style="padding:16px;margin-bottom:12px">
  <button class="btn btn-sm btn-primary" data-t="btn-sm-primary">Add to cart</button>
  <button class="btn btn-sm btn-secondary" data-t="btn-sm-secondary">S</button>
  <button class="btn btn-sm btn-secondary" data-t="btn-sm-size-chip">M</button>
  <button class="btn btn-sm btn-secondary" data-t="btn-sm-size-chip-2">XL</button>
</div>

<div class="card" style="padding:16px;margin-bottom:12px">
  <input class="input" data-t="input-text" placeholder="Search products">
  <input class="input" type="number" data-t="input-qty" style="width:72px" value="0">
  <select class="input" data-t="select"><option>All colours</option></select>
</div>

<!-- swatch row: markup copied from product-card.js renderSwatches() -->
<div class="card" style="padding:16px;margin-bottom:12px">
  <div class="swatch-row" style="display:flex;gap:6px;flex-wrap:wrap;">
    <button type="button" class="color-swatch" title="Navy" data-t="color-swatch"
      style="width:26px;height:26px;border-radius:50%;background:#0E2230;cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px var(--border-default);"></button>
    <button type="button" class="color-swatch" title="Mint" data-t="color-swatch-2"
      style="width:26px;height:26px;border-radius:50%;background:#54E5A0;cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px var(--border-default);"></button>
    <button type="button" class="color-swatch" title="Sand" data-t="color-swatch-3"
      style="width:26px;height:26px;border-radius:50%;background:#E4EDE9;cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px var(--border-default);"></button>
  </div>
</div>

<!-- NEW PRODUCT FORM swatches (js/components/product-form.js, 18 Aug 2026).
     Different markup from the catalogue swatch above and a different class,
     so passing that one says nothing about this one. These are the smallest
     controls on the product form and there are eighteen of them in a row on a
     390px screen -- exactly the shape that ends up 26px and untappable if
     nobody measures it. The real component's classes are used so the real
     stylesheet decides the size; only the surrounding scaffolding is copied. -->
<section class="card detail-card product-form" style="margin-bottom:12px">
  <div class="detail-card-body">
    <div class="pf-colorbar">
      <span class="pf-label">Swatch</span>
      <div class="pf-swatches">
        <button type="button" class="pf-swatch" data-t="pf-swatch" aria-label="Black" aria-pressed="false"><span class="pf-swatch-dot" style="background:#111827"></span></button>
        <button type="button" class="pf-swatch" data-t="pf-swatch-2" aria-label="Mint" aria-pressed="true"><span class="pf-swatch-dot" style="background:#54E5A0"></span></button>
        <button type="button" class="pf-swatch" data-t="pf-swatch-3" aria-label="Sand" aria-pressed="false"><span class="pf-swatch-dot" style="background:#D6C3A5"></span></button>
      </div>
      <label class="pf-label pf-custom-label" for="pf-hex">Custom</label>
      <input type="color" class="pf-color-input" id="pf-hex" data-t="pf-color-input" value="#111827">
    </div>
    <div class="pf-actions">
      <button type="button" class="btn btn-primary" data-t="pf-create">Create product</button>
      <button type="button" class="btn btn-secondary" data-t="pf-cancel">Cancel</button>
    </div>
  </div>
</section>

</main>
<nav id="sidenav"><div class="nav-section-label">Navigate</div>
  <a href="#" class="nav-item"><span class="nav-icon">◆</span><span>Dashboard</span></a>
  <a href="#" class="nav-item">📦 Products</a>
</nav>
<nav id="bottomnav" style="grid-template-columns:repeat(5,1fr)">
  <a class="bottomnav-item" href="#" data-t="bottomnav-item"><span class="bottomnav-icon">◆</span><span class="bottomnav-label">Home</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">📦</span><span class="bottomnav-label">Products</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">📥</span><span class="bottomnav-label">Orders</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">👥</span><span class="bottomnav-label">Clients</span></a>
  <button class="bottomnav-item"><span class="bottomnav-icon">☰</span><span class="bottomnav-label">More</span></button>
</nav>
</div></body></html>`;

console.log("============================================================");
console.log(" GATE 6 — TOUCH TARGET SIZE");
console.log("============================================================");
console.log(` Threshold: ${MIN}px (Apple HIG 44 / WCAG AAA 2.5.5).`);
console.log(" WCAG AA floor is 24px and is NOT what this measures.");
console.log(" Emulating a COARSE pointer, not merely a narrow window.");
console.log("------------------------------------------------------------");

const browser = await chromium.launch();
// hasTouch + isMobile is what makes Chromium report `pointer: coarse`.
const ctx = await browser.newContext({
  viewport: { width: 375, height: 800 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.route("**/gallery.html", (r) =>
  r.fulfill({ status: 200, contentType: "text/html", body: GALLERY }));
await page.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await page.waitForTimeout(700);

// Sanity: if the emulation did not actually produce a coarse pointer, every
// result below is meaningless. Fail loudly rather than reporting a false pass.
const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
if (!coarse) {
  console.log("\n  ✗ Emulation failed: (pointer: coarse) does not match.");
  console.log("    Every measurement below would be from the desktop rules.");
  await browser.close(); server.close(); process.exit(1);
}
console.log("  ✓ (pointer: coarse) matches — measuring the touch rules\n");

// Measure the RENDERED box, plus any hit area added by a ::before overlay
// (the technique used for the colour swatches, where an inline width cannot
// be overridden without !important).
const results = await page.$$eval("[data-t]", (els, min) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    const before = getComputedStyle(el, "::before");
    if (before && before.content !== "none" && before.position === "absolute") {
      const px = (v) => parseFloat(v) || 0;
      // Negative insets grow the hit area beyond the element box.
      w += -px(before.left) + -px(before.right);
      h += -px(before.top) + -px(before.bottom);
    }
    return { name: el.dataset.t, w: Math.round(w), h: Math.round(h),
             ok: Math.round(w) >= min && Math.round(h) >= min };
  }), MIN);

const failures = [];
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(22)} ${String(r.w).padStart(3)} x ${String(r.h).padStart(3)} px`);
  if (!r.ok) failures.push(`${r.name}: ${r.w}x${r.h}px, needs ${MIN}x${MIN}`);
}

// Adjacent targets must not have overlapping hit areas -- two swatches whose
// expanded areas overlap make a tap ambiguous, which is worse than a small
// but unambiguous target.
const overlap = await page.evaluate(() => {
  // PER ROW, not across the whole document. Two swatch rows now exist -- the
  // catalogue's (.color-swatch, in product-card.js) and the new product form's
  // (.pf-swatch). Comparing the last swatch of one row against the first of
  // another compares elements that are nowhere near each other and reports a
  // large fictitious overlap. Only siblings can be mis-tapped for each other.
  let worst = 0;
  document.querySelectorAll(".swatch-row, .pf-swatches").forEach((rowEl) => {
    const sw = [...rowEl.querySelectorAll(".color-swatch, .pf-swatch")];
    const boxes = sw.map((el) => {
      const r = el.getBoundingClientRect();
      const b = getComputedStyle(el, "::before");
      const px = (v) => parseFloat(v) || 0;
      const grow = b && b.content !== "none" && b.position === "absolute";
      return { l: r.left - (grow ? -px(b.left) : 0), r: r.right + (grow ? -px(b.right) : 0),
               top: Math.round(r.top) };
    });
    // Wrapped rows put some swatches on a second visual line; those are not
    // horizontal neighbours either, so compare only within the same line.
    const byLine = new Map();
    boxes.forEach((b) => {
      if (!byLine.has(b.top)) byLine.set(b.top, []);
      byLine.get(b.top).push(b);
    });
    byLine.forEach((line) => {
      line.sort((a, b) => a.l - b.l);
      for (let i = 1; i < line.length; i++) {
        worst = Math.max(worst, Math.round(line[i - 1].r - line[i].l));
      }
    });
  });
  return worst;
});
const overlapOk = overlap <= 0;
console.log(`  ${overlapOk ? "✓" : "✗"} ${"swatch hit-area overlap".padEnd(22)} ${overlap}px (must be <= 0)`);
if (!overlapOk) failures.push(`adjacent colour swatches have hit areas overlapping by ${overlap}px — taps become ambiguous`);

await page.screenshot({ path: join(SHOTS, "touch-targets-375.png"), fullPage: true });

// --- SECOND CONTEXT: a touchscreen LAPTOP ----------------------------------
// #sidenav is display:none below 880px, so it is not a phone target at all.
// It becomes one on a touchscreen laptop: coarse pointer, desktop width.
// Measuring it at 375px would measure a hidden element and report nonsense.
console.log("\n  --- touchscreen laptop (1280px, coarse pointer) ---");
// A SEPARATE CONTEXT, not page.setViewportSize() on the phone one.
//
// This used to resize the existing page. That relies on Chromium's mobile
// emulation surviving a viewport change, and it does not do so reliably --
// `matchMedia("(pointer: coarse)")` came back FALSE after the resize, so the
// coarse-pointer rules stopped applying and the check reported 36px for a
// nav item that is 44px on a real touch laptop. It went unnoticed because the
// assertion happened to pass while it was passing for the wrong reason.
//
// Creating the context at the target size means the emulation is set up once,
// for the conditions being measured, and never mutated underneath the test.
const laptopCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  hasTouch: true,
  isMobile: false,          // a laptop is not a phone; it just has a touchscreen
  deviceScaleFactor: 1,
});
const laptop = await laptopCtx.newPage();
await laptop.route("**/gallery.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: GALLERY }));
await laptop.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await laptop.waitForTimeout(600);

// State the conditions being measured, so a pass cannot be silently vacuous.
const laptopConds = await laptop.evaluate(() => ({
  coarse: matchMedia("(pointer: coarse)").matches,
  width: window.innerWidth,
}));
console.log(`     (context: ${laptopConds.width}px, pointer: coarse = ${laptopConds.coarse})`);
if (!laptopConds.coarse) {
  failures.push("the touchscreen-laptop pass is not running with a coarse pointer — its result means nothing");
}

const sideItems = await laptop.$$eval("#sidenav .nav-item", (els, min) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    return { name: "sidenav nav-item", w: Math.round(r.width), h: Math.round(r.height),
             visible: r.height > 0, ok: Math.round(r.height) >= min };
  }), MIN);
for (const r of sideItems.slice(0, 1)) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(22)} ${String(r.w).padStart(3)} x ${String(r.h).padStart(3)} px`);
  if (!r.ok) failures.push(`${r.name}: ${r.w}x${r.h}px on a touch laptop, needs ${MIN}px tall`);
}
await laptopCtx.close();
await browser.close();
server.close();

console.log("------------------------------------------------------------");
if (!failures.length) {
  console.log(` ✓ PASS — ${results.length} controls, all at or above ${MIN}px on touch.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} control(s) below ${MIN}px on a touch device:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("\n   These are NOT WCAG AA violations — the AA floor is 24px and");
console.log("   they clear it. They are below Apple's 44pt and Material's 48dp,");
console.log("   which is what a thumb on a warehouse floor actually needs.\n");
process.exit(1);
