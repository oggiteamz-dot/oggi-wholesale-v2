// =============================================================================
// OGGI Wholesale v2 — GATE 3: MOBILE NAVIGATION RENDERS AND IS TAPPABLE
// =============================================================================
//
// WHY THIS EXISTS ON TOP OF GATE 2
// --------------------------------
// Gate 2 proves the CONFIG is complete: bar + more = every destination.
// It does not prove any of it reaches a screen. A component that throws on
// its first line would still pass Gate 2.
//
// This project has been burned by exactly that gap twice:
//   - the 14 Aug deploy was "verified" by checking assets returned 200 with
//     a clean console, while every database call was failing;
//   - check_pack_moq.sh reported 7 green while the function it tested
//     crashed on every single call.
//
// So this gate opens a real Chromium at a real phone width, renders the real
// component with the real config, and asserts on the DOM that actually exists.
//
// WHAT IT ASSERTS, PER ROLE
//   1. The bar renders, with exactly the expected number of tabs.
//   2. Every tab is at least 48px tall (the touch-target floor).
//   3. Every tab has a VISIBLE text label, not just an icon.
//   4. Opening "More" reveals the overflow, and the hub closes again.
//   5. THE ONE THAT MATTERS: the union of hrefs in the bar and the hub
//      equals every path in NAV_BY_ROLE for that role. Measured from the
//      DOM, not from the config -- so a component that silently drops an
//      item fails here even though the config is fine.
//
// It also writes a screenshot per role to checks/screenshots/ so a human can
// look at the thing rather than trust a green tick.
//
// RUN:  node checks/check_bottomnav_render.mjs
// PROVEN TO GO RED — see checks/GATE-EVIDENCE.md.
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "checks/screenshots");
const PORT = 8123;

// A phone, not a tablet. 375x667 is the small-iPhone baseline; the Tecno /
// Infinix devices that make up ~13% of Lebanese mobile traffic are commonly
// 360 wide, so anything that fits 375 needs a second look at 360.
const VIEWPORTS = [{ width: 360, height: 640 }, { width: 375, height: 667 }];

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

const failures = [];
let assertions = 0;
function assert(cond, msg) { assertions++; if (!cond) failures.push(msg); }

// ---------------------------------------------------------------------------
// A bare static server. Deliberately not a dependency -- one less thing to
// install, and it makes this gate runnable anywhere Node and Playwright are.
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = join(ROOT, urlPath === "/" ? "/index.html" : urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

// ---------------------------------------------------------------------------
// A minimal harness page. It mounts ONLY the navigation component, with no
// login and no database, so this gate tests the navigation and nothing else.
// If it needed a session it would also be testing auth, and a failure would
// be ambiguous.
// ---------------------------------------------------------------------------
const HARNESS = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/css/tokens.css" />
<link rel="stylesheet" href="/css/base.css" />
<link rel="stylesheet" href="/css/components.css" />
<link rel="stylesheet" href="/css/layout.css" />
<link rel="stylesheet" href="/css/mobile.css" />
</head><body>
<div id="app-root"><main id="view-outlet"><p style="padding:16px">Harness content</p></main>
<nav id="bottomnav"></nav></div>
<script type="module">
  import { renderBottomNav } from "/js/components/bottomnav.js";
  import { NAV_BY_ROLE } from "/js/lib/nav-config.js";
  window.__NAV = NAV_BY_ROLE;
  window.__mount = (role) => {
    document.getElementById("bottomnav").innerHTML = "";
    renderBottomNav(document.getElementById("bottomnav"), role);
  };
  window.__ready = true;
</script></body></html>`;

console.log("============================================================");
console.log(" GATE 3 — MOBILE NAV RENDERS AND IS TAPPABLE");
console.log(`============================================================`);
console.log(` Viewports: ${VIEWPORTS.map(v=>v.width+"x"+v.height).join(", ")}`);
console.log("------------------------------------------------------------");

if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORTS[1] });

// Any uncaught page error is a hard failure -- a component that throws is
// indistinguishable to a user from one that was never built.
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.route("**/harness.html", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: HARNESS }));
await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

const NAV = await page.evaluate(() => window.__NAV);

for (const vp of VIEWPORTS) {
await page.setViewportSize(vp);
console.log(`  --- ${vp.width}px ---`);
for (const role of Object.keys(NAV)) {
  const expectedPaths = NAV[role].map((i) => i.path);
  await page.evaluate((r) => window.__mount(r), role);
  await page.waitForTimeout(60);

  // --- 1. tabs render ---
  const tabs = await page.$$("#bottomnav .bottomnav-item");
  const expectedTabs = expectedPaths.length <= 5 ? expectedPaths.length : 5;
  assert(tabs.length === expectedTabs,
    `${role}: bar rendered ${tabs.length} tabs, expected ${expectedTabs}`);

  // --- 2. touch targets + 3. visible labels ---
  let tooSmall = 0, unlabelled = 0;
  for (const t of tabs) {
    const box = await t.boundingBox();
    if (!box || box.height < 48) tooSmall++;
    const label = (await t.$eval(".bottomnav-label", (e) => e.textContent.trim()).catch(() => ""));
    if (!label) unlabelled++;
  }
  assert(tooSmall === 0, `${role}: ${tooSmall} tab(s) under the 48px touch-target floor`);
  assert(unlabelled === 0, `${role}: ${unlabelled} tab(s) have no visible text label`);

  // --- 5. THE REACHABILITY ASSERTION ---
  const barHrefs = await page.$$eval("#bottomnav a.bottomnav-item",
    (els) => els.map((e) => e.getAttribute("href").slice(1)));

  let hubHrefs = [];
  const moreBtn = await page.$("#bottomnav button.bottomnav-item");
  if (moreBtn) {
    await moreBtn.click();
    await page.waitForSelector(".bottomnav-hub", { timeout: 3000 });
    hubHrefs = await page.$$eval(".bottomnav-hub-item",
      (els) => els.map((e) => e.getAttribute("href").slice(1)));
    await page.screenshot({ path: join(SHOTS, `${role}-more-hub-${vp.width}.png`) });
    // --- 4. the hub must close again, or the user is trapped ---
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    const stillOpen = await page.$(".bottomnav-hub");
    assert(!stillOpen, `${role}: the More hub did not close on Escape — user is trapped`);
  }

  const reachable = [...barHrefs, ...hubHrefs];
  const missing = expectedPaths.filter((p) => !reachable.includes(p));
  assert(missing.length === 0,
    `${role}: ${missing.length} destination(s) NOT TAPPABLE in the rendered DOM — ${missing.join(", ")}`);

  await page.screenshot({ path: join(SHOTS, `${role}-bottomnav-${vp.width}.png`) });

  const ok = !missing.length && !tooSmall && !unlabelled;
  console.log(`  ${ok ? "✓" : "✗"} ${role.padEnd(11)} ${String(tabs.length)} tabs + ` +
    `${hubHrefs.length} in hub → ${reachable.length}/${expectedPaths.length} tappable`);
}
}

assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(" | ")}`);

await browser.close();
server.close();

console.log("------------------------------------------------------------");
console.log(` Screenshots: checks/screenshots/`);
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions, 0 page errors.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
