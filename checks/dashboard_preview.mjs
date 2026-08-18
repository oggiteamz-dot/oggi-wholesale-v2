// =============================================================================
// WHOLESALER DASHBOARD — render it and look at it
// =============================================================================
// Signs in as a real wholesaler through the app's own login form and renders
// the real dashboard against the real database. Nothing is mocked: the figures
// on screen come back from migration 039's SQL through migration 044's guard.
//
// WHY THE REQUEST FORWARDING BELOW EXISTS
// ---------------------------------------
// This container reaches the internet through an HTTP proxy. Node honours it;
// Chromium does not, and pointing Chromium at it breaks the local page load.
// So Supabase calls are intercepted and replayed from Node, which can reach it.
// The APP still issues every call itself, with its own headers and its own
// token -- only the transport is borrowed. Nothing about the request or the
// response is synthesised.
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

// Credentials come from the environment so this file never hardcodes a
// tenant. Point it at any wholesaler login you are willing to sign in as:
//
//   DASH_EMAIL=someone@oggiwholesale.app DASH_PASS=... node checks/dashboard_preview.mjs
//
// The tenant used to produce the screenshots in GATE-EVIDENCE.md was a
// throwaway ("Northgate Supply") created for the purpose and deleted straight
// after -- deliberately, rather than screenshotting a real customer's revenue.
const EMAIL = process.env.DASH_EMAIL;
const PASS  = process.env.DASH_PASS;
if (!EMAIL || !PASS) {
  console.log("  DASH_EMAIL / DASH_PASS not set — skipping. See this file's header.");
  process.exit(0);
}

const ROOT = process.env.APP_ROOT || process.cwd(), PORT = 8209;
const MIME = { ".css":"text/css", ".js":"text/javascript", ".woff2":"font/woff2",
               ".png":"image/png", ".html":"text/html", ".json":"application/json" };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const results = [];

for (const vp of [{ w: 390, h: 900, n: "mobile", touch: true },
                  { w: 1280, h: 1100, n: "desktop", touch: false }]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  // Forward Supabase traffic through Node.
  await page.route("**://*.supabase.co/**", async (route) => {
    const r = route.request();
    try {
      const res = await fetch(r.url(), {
        method: r.method(), headers: r.headers(),
        body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postData(),
      });
      const body = Buffer.from(await res.arrayBuffer());
      const headers = Object.fromEntries(res.headers.entries());
      delete headers["content-encoding"]; delete headers["content-length"];
      await route.fulfill({ status: res.status, headers, body });
    } catch (e) { await route.abort(); }
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html#/login`, { waitUntil: "load" });
  await page.waitForSelector("#si-email", { timeout: 15000 });
  await page.fill("#si-email", EMAIL);
  await page.fill("#si-pass", PASS);
  await page.click("#signin-btn");
  await page.waitForTimeout(5000);
  if (!page.url().includes("/wholesaler")) {
    await page.evaluate(() => { window.location.hash = "#/wholesaler"; });
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(5000);

  // The [hidden] fix, checked in both directions. `hidden` alone proves
  // nothing here -- the attribute was faithfully set the whole time the inputs
  // were on screen. Only the computed style says whether they are visible.
  const beforeCustom = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".date-range-custom")).display);
  await page.click('.date-range-row button:has-text("Custom")');
  await page.waitForTimeout(400);
  const afterCustom = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".date-range-custom")).display);
  console.log(`    custom row display: preset="${beforeCustom}" (want none) → custom="${afterCustom}" (want flex)`);
  await page.click('.date-range-row button:has-text("This month")');
  await page.waitForTimeout(2500);

  const shot = `checks/screenshots/wholesaler-dashboard-${vp.n}.png`;
  await page.screenshot({ path: join(ROOT, shot), fullPage: true });

  const seen = await page.evaluate(() => {
    const t = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim());
    return {
      labels: t(".stat-label"), values: t(".stat-value"),
      cards: t(".detail-card-head h3"),
      svgs: document.querySelectorAll(".chart-svg").length,
      bars: document.querySelectorAll(".chart-bar-row").length,
      ranges: t(".date-range-row button"),
      note: document.querySelector(".date-range-note")?.textContent?.trim() || "",
    };
  });
  results.push({ vp, seen, errs });
  console.log(`  ${vp.n} ${vp.w}px — page errors: ${errs.length ? errs.slice(0,3).join(" | ") : "none"}`);
  console.log(`    stats:  ${seen.labels.map((l, i) => `${l}=${seen.values[i]}`).join("   ") || "(none)"}`);
  console.log(`    cards:  ${seen.cards.join(" · ") || "(none)"}`);
  console.log(`    ranges: ${seen.ranges.join(", ") || "(none)"}`);
  console.log(`    window: ${seen.note}`);
  console.log(`    charts: ${seen.svgs} line/axis svg, ${seen.bars} bar rows`);
  await page.close();
}
await browser.close();
server.close();
console.log("  screenshots: checks/screenshots/wholesaler-dashboard-{mobile,desktop}.png");
