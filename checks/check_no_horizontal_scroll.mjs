// =============================================================================
// OGGI Wholesale v2 — GATE: NO HORIZONTAL SCROLL ON A PHONE
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// On 18 Sep 2026 the SIGN-IN SCREEN scrolled sideways on every phone. The role
// switcher is four buttons in `display:flex` with no `flex-wrap`, and their
// labels -- "Owner / Wholesaler", "Sales team", "Warehouse / Finance", "Buyer"
// -- measure 494px inside a 390px viewport. The fourth tab, BUYER, which is the
// role most of the people using this product are, sat entirely off-screen with
// nothing on the page to suggest it existed.
//
// It had been that way since the roles were added and nobody saw it, because at
// desktop width the row fits and looks correct. That is the whole character of
// this class of bug: it is invisible on the machine it is built on and it is
// the only thing the user sees.
//
// WHY A GATE AND NOT A SCREENSHOT
// -------------------------------
// A screenshot of an overflowing row looks fine -- the browser just clips it,
// and a clipped row of buttons looks like a row of buttons. The defect is only
// visible as a NUMBER: scrollWidth larger than clientWidth. So this asks for
// the number, and when it is wrong it names the exact elements whose right edge
// crosses the viewport, because "the page scrolls" is not actionable and
// "button.btn-sm at right: 494 in a 390 viewport" is.
//
// 390px is the iPhone 12/13/14 width. 360px is checked too: that is the narrow
// end of the Tecno and Infinix devices that are roughly 13% of Lebanese mobile
// traffic, and it is the width the 44px tap-target rule is written against.
//
// RUN:  node checks/check_no_horizontal_scroll.mjs
// PROVEN TO GO RED — see GATE-EVIDENCE. Run against login.js before the
// flex-wrap fix it reports: "390px: overflows by 104px -- button.btn.btn-sm".
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDTHS = [390, 360];
const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript",
  ".json":"application/json", ".woff2":"font/woff2", ".png":"image/png",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json" };

// A plain static server. The app is a static SPA, so this is exactly what
// Cloudflare serves -- no build step to diverge from.
const srv = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(ROOT, p);
  if (!existsSync(f) || f.endsWith("/")) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[extname(f)] || "text/plain" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

console.log("============================================================");
console.log(" GATE — NO HORIZONTAL SCROLL ON A PHONE");
console.log("============================================================");

const browser = await chromium.launch();
const failures = [];

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });

  const result = await page.evaluate(() => {
    const d = document.documentElement;
    const over = d.scrollWidth - d.clientWidth;
    if (over <= 0) return { over: 0, who: [] };
    const w = d.clientWidth;
    const who = [];
    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).position === "fixed") return;
      if (r.right > w + 1 || r.left < -1) {
        const cls = (el.className || "").toString().trim().split(/\s+/).slice(0, 3).join(".");
        who.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ` +
                 `[${Math.round(r.left)} -> ${Math.round(r.right)}] "${el.textContent.trim().slice(0, 24)}"`);
      }
    });
    return { over, who: [...new Set(who)].slice(0, 6) };
  });
  await page.close();

  if (result.over > 0) {
    console.log(`  ✗ ${width}px — page scrolls sideways by ${result.over}px`);
    result.who.forEach((w) => console.log(`      ${w}`));
    failures.push(`${width}px: overflows by ${result.over}px — ${result.who[0] || "unknown element"}`);
  } else {
    console.log(`  ✓ ${width}px — no horizontal scroll`);
  }
}

await browser.close();
srv.close();

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — no horizontal scroll at ${WIDTHS.join("px or ")}px.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} width(s) scroll sideways:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("");
console.log(" A fixed-position element is ignored on purpose: the drifting");
console.log(" background field is inset:-25vmax by design and never causes a");
console.log(" real scrollbar. Everything else counts.");
console.log("");
process.exit(1);
