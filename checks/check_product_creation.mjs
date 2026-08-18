// =============================================================================
// CHECK: a product created in the interface lands in the catalog AND inventory
// =============================================================================
// Hadi's ask has two halves and the second is the one that silently fails:
// "when you create these new products, you automatically have them be put into
// the inventory."
//
// A product creation that inserts the rows but leaves the variant invisible in
// Inventory looks, to the person using it, exactly like a product creation
// that did not work. That was the real behaviour before 18 Aug 2026:
// getStockTable() built its rows from v2_inventory_balances, and a balance row
// only exists once stock has been RECEIVED -- so a variant with no opening
// stock appeared nowhere.
//
// So this drives the real form in a real browser, against the real database,
// and then goes and LOOKS at the Inventory screen. It deliberately creates one
// variant WITH opening stock and one WITHOUT, because only the second one
// catches the bug.
//
// Credentials come from the environment; the tenant used for the recorded run
// was a throwaway, created for it and deleted straight after.
//
//   PC_EMAIL=... PC_PASS=... node checks/check_product_creation.mjs
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const EMAIL = process.env.PC_EMAIL, PASS = process.env.PC_PASS;
if (!EMAIL || !PASS) { console.log("  PC_EMAIL / PC_PASS not set — skipping."); process.exit(0); }

const ROOT = process.env.APP_ROOT || process.cwd(), PORT = 8211;
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

const stamp = process.env.PC_STAMP || "CHK";
const PRODUCT = `Check Product ${stamp}`;
const SKU_STOCKED = `CHK-${stamp}-BLK-M`;
const SKU_BARE    = `CHK-${stamp}-RED-L`;   // no opening stock — the one that used to vanish

const pass = [], fail = [];
const assert = (cond, msg) => (cond ? pass : fail).push(msg);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// This container reaches the internet through a proxy Chromium does not use.
// Node does, so Supabase traffic is replayed through it. The app still issues
// every request itself; only the transport is borrowed.
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
  } catch { await route.abort(); }
});

await page.goto(`http://127.0.0.1:${PORT}/index.html#/login`, { waitUntil: "load" });
await page.waitForSelector("#si-email", { timeout: 15000 });
await page.fill("#si-email", EMAIL);
await page.fill("#si-pass", PASS);
await page.click("#signin-btn");
await page.waitForTimeout(4000);

// ---- the catalog builder ----
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/catalogs`, { waitUntil: "load" });
await page.waitForTimeout(4500);

const catalogTabs = await page.$$eval(".date-range-row button", (b) => b.map((x) => x.textContent.trim()));
assert(catalogTabs.some((t) => t.includes("Main Catalog")),
  `catalogs screen shows a Main Catalog tab (saw: ${catalogTabs.join(", ") || "nothing"})`);

await page.click('button:has-text("+ New product")');
await page.waitForSelector(".product-form", { timeout: 10000 });
assert(true, "the New product form opens from the catalog builder");

await page.fill(".product-form .pf-grid input", PRODUCT);

// variant 1 — with opening stock
const row1 = ".product-form .pf-row:nth-of-type(1)";
await page.fill(`${row1} [data-k="sku"]`, SKU_STOCKED);
await page.fill(`${row1} [data-k="size"]`, "M");
await page.fill(`${row1} [data-k="price"]`, "42.50");
await page.fill(`${row1} [data-k="openingStock"]`, "24");
await page.click(`${row1} .pf-swatch[aria-label="Black"]`);
const carriedColour = await page.inputValue(`${row1} [data-k="color"]`);
assert(carriedColour === "Black", `clicking a swatch fills the blank colour name (got "${carriedColour}")`);
const hex1 = await page.inputValue(`${row1} [data-k="colorHex"]`);
assert(hex1.toLowerCase() === "#111827", `the swatch sets a real colorHex (got "${hex1}")`);

// variant 2 — deliberately NO opening stock
await page.click('button:has-text("+ Add another variant")');
await page.waitForTimeout(300);
const row2 = ".product-form .pf-row:nth-of-type(2)";
await page.fill(`${row2} [data-k="sku"]`, SKU_BARE);
await page.fill(`${row2} [data-k="size"]`, "L");
await page.fill(`${row2} [data-k="price"]`, "42.50");
await page.click(`${row2} .pf-swatch[aria-label="Red"]`);
// Row 2 inherits row 1's colour when it is added. Clicking a different swatch
// must RENAME it -- otherwise a variant reads "Black" with a red swatch, which
// is what the first screenshot showed.
const renamed = await page.inputValue(`${row2} [data-k="color"]`);
assert(renamed === "Red", `a swatch renames a carried-down colour (got "${renamed}")`);
const hex2 = await page.inputValue(`${row2} [data-k="colorHex"]`);
assert(hex2.toLowerCase() === "#b91c1c", `and sets the matching hex (got "${hex2}")`);
// But it must NOT overwrite a name the operator typed.
await page.fill(`${row2} [data-k="color"]`, "Crimson");
await page.click(`${row2} .pf-swatch[aria-label="Pink"]`);
const kept = await page.inputValue(`${row2} [data-k="color"]`);
assert(kept === "Crimson", `a typed colour name survives a later swatch click (got "${kept}")`);
await page.fill(`${row2} [data-k="color"]`, "Red");
await page.click(`${row2} .pf-swatch[aria-label="Red"]`);

const stock2 = await page.inputValue(`${row2} [data-k="openingStock"]`);
assert(stock2 === "0", `a new variant defaults to zero opening stock (got "${stock2}")`);

// duplicate-SKU validation, before the real submit
await page.fill(`${row2} [data-k="sku"]`, SKU_STOCKED);
await page.click('.product-form button:has-text("Create product")');
await page.waitForTimeout(600);
const dupErr = await page.$eval(`${row2} .pf-error`, (e) => (e.hidden ? "" : e.textContent.trim())).catch(() => "");
assert(/already used/i.test(dupErr), `a duplicate SKU is refused with a message on the field (saw: "${dupErr}")`);
await page.fill(`${row2} [data-k="sku"]`, SKU_BARE);

await page.screenshot({ path: join(ROOT, "checks/screenshots/product-form-mobile.png"), fullPage: true });

await page.click('.product-form button:has-text("Create product")');
await page.waitForTimeout(6000);
const status = await page.$eval(".pf-status", (e) => e.textContent.trim()).catch(() => "");
assert(/created with 2 variant/i.test(status), `the form reports success honestly (saw: "${status}")`);

// ---- did it land in the catalog? ----
// A full reload, not a hash assignment. Setting location.hash to the value it
// already holds fires no hashchange event, so the router does not re-run and
// the assertion would be reading the pre-save render. That is a test that
// passes or fails for reasons unrelated to the code under test.
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/catalogs`, { waitUntil: "load" });
await page.waitForTimeout(4500);
const catalogText = await page.evaluate(() => document.body.innerText);
assert(catalogText.includes(PRODUCT), "the new product appears in the catalog it was created in");
assert(/2 variants/.test(catalogText), "the catalog row counts both variants");

// ---- and in inventory? THIS is the assertion that used to fail ----
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/inventory`, { waitUntil: "load" });
await page.waitForTimeout(4500);
const invText = await page.evaluate(() => document.body.innerText);
assert(invText.includes(SKU_STOCKED), `the STOCKED variant appears in Inventory (${SKU_STOCKED})`);
assert(invText.includes(SKU_BARE),
  `the UNSTOCKED variant appears in Inventory (${SKU_BARE}) — this is the one that was invisible before 18 Aug`);
assert(/not stocked yet/i.test(invText),   // innerText is the RENDERED text, and .badge uppercases it
  "an unstocked variant is badged 'Not stocked yet', not 'Out' — different facts, different words");
assert(/24 avail/.test(invText), "the opening stock of 24 was actually received");

await page.screenshot({ path: join(ROOT, "checks/screenshots/inventory-new-product-mobile.png"), fullPage: true });

assert(pageErrors.length === 0, `no uncaught page errors (saw ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

await browser.close();
server.close();

console.log("=".repeat(60));
console.log(" CHECK — PRODUCT CREATION REACHES CATALOG AND INVENTORY");
console.log("=".repeat(60));
pass.forEach((m) => console.log(`  ✓ ${m}`));
fail.forEach((m) => console.log(`  ✗ ${m}`));
console.log("-".repeat(60));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
