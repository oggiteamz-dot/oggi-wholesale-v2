// =============================================================================
// CHECK: the product builder — photos, eyedropper, colours, grid, inventory
// =============================================================================
// Rewritten 18 Aug 2026 when the flat variant list became a real builder.
//
// Hadi's ask had two halves and the second is the one that fails silently:
// "when you create these new products, you automatically have them be put into
// the inventory." A creation that inserts rows but leaves the variant
// invisible in Inventory looks, to the operator, exactly like one that did not
// work. That WAS the behaviour before today -- getStockTable() built its rows
// from v2_inventory_balances, and a balance only exists once stock has been
// received, so a variant with no opening stock appeared nowhere.
//
// So this drives the real screens in a real browser against the real database
// and then goes and LOOKS at Inventory. It deliberately creates one cell WITH
// stock and one WITHOUT, because only the second catches that bug.
//
// The eyedropper is checked against a fixture of a single known colour
// (#B91C1C), so "it sampled something" is not good enough -- it has to sample
// the RIGHT something.
//
//   PC_EMAIL=... PC_PASS=... node checks/check_product_creation.mjs
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { shows } from "./_rendered-text.mjs";

const EMAIL = process.env.PC_EMAIL, PASS = process.env.PC_PASS;
if (!EMAIL || !PASS) { console.log("  PC_EMAIL / PC_PASS not set — skipping."); process.exit(0); }
const STAMP = process.env.PC_STAMP || "CHK";

const ROOT = process.env.APP_ROOT || process.cwd(), PORT = 8219;
const MIME = { ".css":"text/css",".js":"text/javascript",".woff2":"font/woff2",
               ".png":"image/png",".html":"text/html",".json":"application/json" };
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

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const PRODUCT = `Builder Check ${STAMP}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.route("**://*.supabase.co/**", async (route) => {
  const r = route.request();
  try {
    const res = await fetch(r.url(), { method: r.method(), headers: r.headers(),
      body: ["GET","HEAD"].includes(r.method()) ? undefined : r.postData() });
    const body = Buffer.from(await res.arrayBuffer());
    const h = Object.fromEntries(res.headers.entries());
    delete h["content-encoding"]; delete h["content-length"];
    await route.fulfill({ status: res.status, headers: h, body });
  } catch { await route.abort(); }
});

await page.goto(`http://127.0.0.1:${PORT}/index.html#/login`, { waitUntil: "load" });
await page.waitForSelector("#si-email", { timeout: 15000 });
await page.fill("#si-email", EMAIL);
await page.fill("#si-pass", PASS);
await page.click("#signin-btn");
await page.waitForFunction(() => location.hash.includes("/wholesaler"), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2000);

await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/catalogs`, { waitUntil: "load" });
await page.waitForTimeout(4500);
await page.click('button:has-text("+ New product")');
await page.waitForSelector(".product-builder", { timeout: 10000 });
ok(true, "the builder opens from the catalog screen");

await page.fill(".product-builder .pf-grid input", PRODUCT);
await page.fill("#pb-photos ~ * , .product-builder .pf-grid input", PRODUCT).catch(() => {});
await page.evaluate((n) => {
  const i = document.querySelector(".product-builder .pf-grid input");
  i.value = n; i.dispatchEvent(new Event("input", { bubbles: true }));
}, PRODUCT);

// ---- photos ----
await page.setInputFiles(".pb-photo-add input[type=file]", join(ROOT, "checks/fixtures/swatch-b91c1c.png"));
await page.waitForTimeout(900);
const photoCount = await page.evaluate(() => document.querySelectorAll(".pb-photo img").length);
ok(photoCount === 1, `a photo can be added (${photoCount} on screen)`);
ok(await page.evaluate(() => !!document.querySelector(".pb-photo-primary")),
  "the first photo is marked as the main one");

// ---- colour 1, sampled from the photo ----
await page.click('.pb-colour-add button:has-text("+ Add colour")');
await page.waitForTimeout(300);
await page.click(".pb-colour .pb-eye");
await page.waitForTimeout(300);
ok(await page.evaluate(() => !!document.querySelector(".pb-eyedrop-hint")),
  "arming the eyedropper tells you what to do next");

// A locator click, not mouse.click at a measured point. Arming the eyedropper
// calls scrollIntoView({behavior:"smooth"}), so a boundingBox taken right
// after it is stale by the time the mouse moves -- the click landed on
// whatever had scrolled into that spot and the sample never happened. A
// locator re-measures and waits for the element to settle first.
await page.locator(".pb-photo img").first().click({ position: { x: 40, y: 40 } });
await page.waitForTimeout(600);

const sampled = await page.evaluate(() =>
  document.querySelector('.pb-colour input[type="color"]').value.toLowerCase());
ok(sampled === "#b91c1c",
  `the eyedropper samples the ACTUAL colour under the tap (fixture is #b91c1c, got ${sampled})`);

await page.fill(".pb-colour-name", "Crimson");
await page.waitForTimeout(200);
ok(true, "a colour can be named after it is picked");

// ---- colour 2, from the palette, with its OWN size run ----
await page.click('.pb-colour-add .pf-swatch[aria-label="Add Navy"]');
await page.waitForTimeout(400);
await page.evaluate(() => {
  const names = document.querySelectorAll(".pb-colour-name");
  const last = names[names.length - 1];
  last.value = "Deep Navy";
  last.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
const colourCount = await page.evaluate(() => document.querySelectorAll(".pb-colour").length);
ok(colourCount === 2, `a second colour can be added from the palette (${colourCount} colours)`);

// ---- the grid ----
const gridRows = await page.evaluate(() => document.querySelectorAll(".pb-grid-row").length);
ok(gridRows === 2, `the grid has one row per colour (${gridRows})`);
const cellsPerRow = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")].map((r) => r.querySelectorAll(".pb-cell").length));
ok(cellsPerRow.every((n) => n === 4), `each colour starts on the shared size run (${cellsPerRow.join(" / ")} cells)`);

// PER-COLOUR SIZE RUN: give Deep Navy a different set. This is the thing v1
// never shipped, and the reason it could not was a rectangular data model.
await page.evaluate(() => {
  const rows = document.querySelectorAll(".pb-grid-row");
  const input = rows[1].querySelector(".pb-grid-sizes input");
  input.value = "38, 40, 42";
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(500);
const afterCustom = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")].map((r) => r.querySelectorAll(".pb-cell").length));
ok(afterCustom[0] === 4 && afterCustom[1] === 3,
  `one colour can have its OWN sizes without touching the other (${afterCustom.join(" / ")})`);

// CARRY-FORWARD: type a quantity, then change the size list, and the cells
// whose size name did not change must keep their numbers. v1's rule, kept.
await page.evaluate(() => {
  const cells = document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell input");
  cells[0].value = "12"; cells[0].dispatchEvent(new Event("input", { bubbles: true }));
  cells[1].value = "9";  cells[1].dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  const input = document.querySelectorAll(".pb-grid-row")[0].querySelector(".pb-grid-sizes input");
  input.value = "S, M, L, XXL";       // XL renamed to XXL; S and M untouched
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(500);
const carried = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell input")].map((i) => i.value));
ok(carried[0] === "12" && carried[1] === "9",
  `renaming one size carries the others' quantities forward (${carried.join(",")})`);

// One cell WITH stock and one WITHOUT — the second is what used to vanish.
await page.evaluate(() => {
  const rows = document.querySelectorAll(".pb-grid-row");
  const navy = rows[1].querySelectorAll(".pb-cell input");
  navy[0].value = "6"; navy[0].dispatchEvent(new Event("input", { bubbles: true }));
  // navy[1] and navy[2] deliberately left at 0
});
await page.waitForTimeout(300);
await page.fill(`#${await page.evaluate(() => document.querySelectorAll(".product-builder .pf-grid input")[3].id)}`, "42.50")
  .catch(async () => {
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll(".product-builder .pf-grid input")];
      const price = inputs.find((i) => i.type === "number" && i.placeholder === "0.00");
      if (price) { price.value = "42.50"; price.dispatchEvent(new Event("input", { bubbles: true })); }
    });
  });

await page.screenshot({ path: join(ROOT, "checks/screenshots/product-builder-mobile.png"), fullPage: true });

// ---- unnamed colours must be refused ----
await page.evaluate(() => {
  const names = document.querySelectorAll(".pb-colour-name");
  names[0].value = ""; names[0].dispatchEvent(new Event("input", { bubbles: true }));
});
await page.click("#pb-save");
await page.waitForTimeout(600);
const nameErr = await page.evaluate(() => {
  const e = document.querySelector('.pf-error[data-for="colours"]');
  return e && !e.hidden ? e.textContent.trim() : "";
});
ok(/name/i.test(nameErr), `an unnamed colour is refused before saving (saw: "${nameErr}")`);
await page.evaluate(() => {
  const names = document.querySelectorAll(".pb-colour-name");
  names[0].value = "Crimson"; names[0].dispatchEvent(new Event("input", { bubbles: true }));
});

// ---- save ----
await page.click("#pb-save");
await page.waitForTimeout(12000);
const statusText = await page.evaluate(() => document.querySelector(".pf-status")?.textContent || "");
ok(/created with 7 variants/i.test(statusText),
  `4 sizes + 3 sizes = 7 variants, and it says so (saw: "${statusText}")`);
ok(/photo/i.test(statusText), `the photo is attached and reported (saw: "${statusText}")`);

// ---- inventory ----
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/inventory`, { waitUntil: "load" });
await page.waitForTimeout(5000);
const inv = await page.evaluate(() => document.body.innerText);
ok(shows(inv, PRODUCT), "the product reached Inventory");
ok(shows(inv, "Crimson"), "with its sampled colour name");
ok(shows(inv, "Deep Navy"), "and its palette colour name");
ok(shows(inv, "not stocked yet"),
  "and the cells left at zero are visible, badged 'Not stocked yet' — these are what used to be invisible");

await page.screenshot({ path: join(ROOT, "checks/screenshots/builder-inventory-mobile.png"), fullPage: true });
ok(errs.length === 0, `no uncaught page errors (${errs.length}${errs.length ? ": " + errs[0].slice(0,90) : ""})`);

await browser.close();
server.close();
console.log("=".repeat(64));
console.log(" CHECK — PRODUCT BUILDER: PHOTOS, EYEDROPPER, COLOURS, GRID");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
