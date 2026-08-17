// =============================================================================
// OGGI Wholesale v2 — BRAND PREVIEW (a human looks at it)
// =============================================================================
// Not a gate. Gates verify the properties somebody thought to assert; this
// renders the real stylesheets over realistic markup so a person can see
// whether it actually looks like OGGI. Both widths, screenshots to
// checks/screenshots/.
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "checks/screenshots");
const PORT = 8134;
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
  ".png":"image/png", ".woff2":"font/woff2", ".json":"application/json" };

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

const PAGE = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/fonts.css">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/layout.css">
<link rel="stylesheet" href="/css/mobile.css">
<link rel="stylesheet" href="/css/brand.css">
</head><body>
<div id="app-root">
<header id="topbar">
  <div class="brand"><span class="brand-mark">O</span><span>OGGI Wholesale</span><span class="env-tag">v2 · dev</span></div>
  <div class="topbar-right"><div class="who"><span>Wholesaler</span> · <strong>Milano Garments</strong></div>
  <button class="btn btn-ghost btn-sm">Switch role</button></div>
</header>
<div id="app-body">
  <nav id="sidenav"><div class="nav-section-label">Navigate</div>
    <a class="nav-item active" href="#"><span class="nav-icon">◆</span><span>Dashboard</span></a>
    <a class="nav-item" href="#"><span class="nav-icon">📦</span><span>Products</span></a>
    <a class="nav-item" href="#"><span class="nav-icon">📥</span><span>Orders</span></a>
    <a class="nav-item" href="#"><span class="nav-icon">👥</span><span>Clients</span></a>
  </nav>
  <main id="view-outlet">
    <div class="page-header"><div class="page-title-group">
      <h1>Dashboard</h1><p>Milano Garments · today</p></div>
      <div class="page-actions"><button class="btn btn-secondary">Export</button>
      <button class="btn btn-primary">+ Add product</button></div></div>

    <div class="stat-grid">
      <div class="card stat-card"><div class="stat-label">Orders this month</div><div class="stat-value">128</div></div>
      <div class="card stat-card"><div class="stat-label">Revenue</div><div class="stat-value">$24,180</div></div>
      <div class="card stat-card"><div class="stat-label">Active buyers</div><div class="stat-value">37</div></div>
      <div class="card stat-card"><div class="stat-label">Low stock</div><div class="stat-value">6</div></div>
    </div>

    <div class="brand-band" style="margin-bottom:24px">
      <div class="stat-label">Lifetime through OGGI</div>
      <div class="stat-value" style="font-size:36px">$412,900</div>
    </div>

    <div class="card" style="padding:24px;margin-bottom:16px">
      <h3 style="margin-bottom:8px">Merino Crew Knit</h3>
      <p style="color:var(--text-secondary);margin-bottom:14px">Full series · 4 colours × 4 sizes · 16 SKUs</p>
      <span class="badge badge-success">In stock</span>
      <span class="badge badge-accent">Series</span>
      <span class="badge badge-warning">Reorder soon</span>
      <p style="color:var(--text-tertiary);font-size:13px;margin-top:14px">Last ordered 3 days ago by Square Retail</p>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button class="btn btn-primary">Add pack — $384</button>
        <button class="btn btn-secondary">View details</button></div>
    </div>

    <div class="card" style="padding:24px">
      <label class="stat-label" style="display:block;margin-bottom:6px">Search products</label>
      <input class="input" placeholder="Try &quot;merino&quot;" style="max-width:340px">
    </div>
  </main>
</div>
<nav id="bottomnav" style="grid-template-columns:repeat(5,1fr)">
  <a class="bottomnav-item active" href="#"><span class="bottomnav-icon">◆</span><span class="bottomnav-label">Home</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">📦</span><span class="bottomnav-label">Products</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">📥</span><span class="bottomnav-label">Orders</span></a>
  <a class="bottomnav-item" href="#"><span class="bottomnav-icon">👥</span><span class="bottomnav-label">Clients</span></a>
  <button class="bottomnav-item"><span class="bottomnav-icon">☰</span><span class="bottomnav-label">More</span></button>
</nav>
</div></body></html>`;

const browser = await chromium.launch();
for (const vp of [{ w: 375, h: 900, name: "mobile" }, { w: 1280, h: 900, name: "desktop" }]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.route("**/preview.html", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
  await page.goto(`http://127.0.0.1:${PORT}/preview.html`);
  await page.waitForTimeout(900); // let the webfont land so the shot shows Poppins
  const fontOk = await page.evaluate(() => document.fonts.check('700 24px Poppins'));
  const logoOk = await page.evaluate(() => {
    const el = document.querySelector("#topbar .brand-mark");
    return getComputedStyle(el).backgroundImage.includes("oggi-logo");
  });
  await page.screenshot({ path: join(SHOTS, `brand-${vp.name}.png`), fullPage: true });
  console.log(`  ${vp.name} ${vp.w}px — Poppins loaded: ${fontOk} · logo applied: ${logoOk}`);
  await page.close();
}
await browser.close();
server.close();
console.log("  screenshots: checks/screenshots/brand-mobile.png, brand-desktop.png");
