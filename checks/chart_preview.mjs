// =============================================================================
// OGGI Wholesale v2 — CHART PREVIEW
// =============================================================================
// Step 7 of the dataviz method: "render it and look at it". The validator
// checks colour; it cannot see a label collision, a bar overflowing its track,
// or a tooltip leaving the card. Only a picture can.
//
// Uses deliberately awkward data -- long product names, a huge outlier, a
// zero-sales week, many x points -- because pretty sample data hides exactly
// the problems this is meant to find.
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8178;
const MIME = { ".css":"text/css", ".js":"text/javascript", ".woff2":"font/woff2", ".png":"image/png" };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(PORT, r));

const PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/fonts.css"><link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/mobile.css">
<link rel="stylesheet" href="/css/brand.css"></head>
<body><div id="app-root"><main id="view-outlet" style="padding:16px">
<div class="card detail-card"><div class="detail-card-head"><h3>Sales over time</h3>
<p>Revenue per period. Empty periods are drawn as zero, not skipped.</p></div>
<div class="detail-card-body" id="a"></div></div>
<div class="card detail-card"><div class="detail-card-head"><h3>What sells, over time</h3>
<p>Up to six products, biggest first.</p></div>
<div class="detail-card-body" id="b"></div></div>
<div class="card detail-card"><div class="detail-card-head"><h3>Top products</h3>
<p>By revenue. Hover a bar for units and order count.</p></div>
<div class="detail-card-body" id="c"></div></div>
</main></div>
<script type="module">
import { renderLineChart, renderBarChart } from "/js/components/chart.js";

// 26 weekly buckets, with a deliberate dead stretch in the middle.
const buckets = Array.from({length:26},(_,i)=> new Date(2026,1,2+i*7).toISOString());
const wave = (a,b,p)=> buckets.map((_,i)=> i>10&&i<14 ? 0 : Math.round(a+b*Math.sin((i+p)/2.6)));

document.getElementById("a").appendChild(renderLineChart({
  buckets, series:[{name:"Revenue", points: wave(4200,2600,0)}], currency:"$",
}));

document.getElementById("b").appendChild(renderLineChart({
  buckets,
  series:[
    {name:"Merino Crew Knit", points: wave(1800,900,0)},
    {name:"Oversized Hoodie — Heavyweight Fleece", points: wave(1200,700,1)},
    {name:"Cargo Pant", points: wave(900,500,2)},
    {name:"Ribbed Tank", points: wave(600,380,3)},
    {name:"Denim Jacket", points: wave(420,260,4)},
    {name:"Wool Scarf", points: wave(260,180,5)},
    {name:"Other (14 products)", points: wave(700,300,6)},
  ], currency:"$",
}));

document.getElementById("c").appendChild(renderBarChart({
  currency:"$",
  rows:[
    // A deliberate outlier: everything else must stay legible beside it.
    {label:"Merino Crew Knit", value:48200, detail:[["Units","1,204"],["Orders","96"]]},
    {label:"Oversized Hoodie — Heavyweight Fleece Lined", value:12400, detail:[["Units","310"],["Orders","41"]]},
    {label:"Cargo Pant", value:8600, detail:[["Units","215"],["Orders","33"]]},
    {label:"Ribbed Tank", value:3100, detail:[["Units","155"],["Orders","28"]]},
    {label:"Wool Scarf", value:640, detail:[["Units","32"],["Orders","9"]]},
    {label:"Leather Belt", value:80, detail:[["Units","4"],["Orders","2"]]},
  ],
}));
window.__ready = true;
</script></body></html>`;

const browser = await chromium.launch();
for (const vp of [{ w: 1280, h: 1400, n: "desktop" }, { w: 375, h: 1500, n: "mobile" }]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/c.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
  await page.goto(`http://127.0.0.1:${PORT}/c.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
  await page.waitForTimeout(800);

  // Hover the multi-series line so the crosshair + tooltip are IN the picture.
  if (vp.n === "desktop") {
    const box = await page.locator("#b .chart-svg").boundingBox();
    if (box) await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.4);
    await page.waitForTimeout(250);
  }

  // Do any two x-axis labels overlap? This is what produced "Jul 20Jul 27".
  const collisions = await page.evaluate(() => {
    let worst = 0;
    document.querySelectorAll(".chart-svg").forEach((svg) => {
      const labels = [...svg.querySelectorAll(".chart-axis-label")]
        .filter((t) => t.getAttribute("text-anchor") === "middle")
        .map((t) => t.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      for (let i = 1; i < labels.length; i++) {
        worst = Math.max(worst, Math.round(labels[i - 1].right - labels[i].left));
      }
    });
    return worst;
  });

  // Does any bar overflow its track? A silent overflow looks like a full bar.
  const overflow = await page.evaluate(() => {
    let worst = 0;
    document.querySelectorAll(".chart-bar-row").forEach((r) => {
      const t = r.querySelector(".chart-bar-track").getBoundingClientRect();
      const f = r.querySelector(".chart-bar-fill").getBoundingClientRect();
      worst = Math.max(worst, Math.round(f.right - t.right));
    });
    return worst;
  });

  await page.screenshot({ path: join(ROOT, `checks/screenshots/charts-${vp.n}.png`), fullPage: true });
  console.log(`  ${vp.n} ${vp.w}px — page errors: ${errs.length ? errs.join(" | ") : "none"} · bar overflow: ${overflow}px · worst x-label overlap: ${collisions}px${collisions > 0 ? "  <-- COLLISION" : ""}`);
  await page.close();
}
await browser.close();
server.close();
console.log("  screenshots: checks/screenshots/charts-desktop.png, charts-mobile.png");
