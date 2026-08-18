// =============================================================================
// CHECK: multiple locations, and stock actually moving between them
// =============================================================================
// Regression ledger #17: "the only transfer tokens in the entire repo are the
// enum values transfer_out/transfer_in on one line. No function, RPC or UI.
// An enum value is not a feature."
//
// So this check refuses to be satisfied by the enum, the function, or the
// button existing. It drives the real screens in a real browser against the
// real database and then asserts the STOCK MOVED -- a number went down in one
// place and up in another, and the archive guard changed state as a result.
//
//   LOC_EMAIL=... LOC_PASS=... node checks/check_locations_transfer.mjs
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { shows } from "./_rendered-text.mjs";

const EMAIL = process.env.LOC_EMAIL, PASS = process.env.LOC_PASS;
if (!EMAIL || !PASS) { console.log("  LOC_EMAIL / LOC_PASS not set — skipping."); process.exit(0); }
// A UNIQUE name per run. The first version reused "Check Shop", so a second
// run collided with the location the first one left behind: createLocation
// refused the duplicate, the name was still on screen from before, and the
// assertions after it drifted into testing last run's leftovers. A check must
// not depend on -- or be broken by -- its own history.
const SHOP = process.env.LOC_NAME || `Check Shop ${Date.now().toString(36).slice(-5)}`;

const ROOT = process.env.APP_ROOT || process.cwd(), PORT = 8217;
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

// Answer prompt() with whatever the current step needs.
let promptAnswer = null;
page.on("dialog", async (d) => { await d.accept(promptAnswer ?? ""); });

await page.goto(`http://127.0.0.1:${PORT}/index.html#/login`, { waitUntil: "load" });
await page.waitForSelector("#si-email", { timeout: 15000 });
await page.fill("#si-email", EMAIL);
await page.fill("#si-pass", PASS);
await page.click("#signin-btn");
await page.waitForFunction(() => location.hash.includes("/wholesaler"), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);

// ---- Locations screen ----
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/locations`, { waitUntil: "load" });
await page.waitForTimeout(4000);
let text = await page.evaluate(() => document.body.innerText);
ok(shows(text, "Main Warehouse"), "the Locations screen lists the existing warehouse");
ok(shows(text, "Default"), "the default location is marked as such");   // innerText is UPPERCASED by the badge's CSS

promptAnswer = SHOP;
await page.click('button:has-text("+ New location")');
await page.waitForTimeout(4000);
text = await page.evaluate(() => document.body.innerText);
ok(shows(text, SHOP), `a second location can be created (${SHOP})`);

// Archive must be refused while the default holds stock — and must SAY so
// before the click, not after.
const archiveState = await page.evaluate((shop) => {
  const rows = [...document.querySelectorAll(".inv-row")];
  const shopRow = rows.find((r) => r.textContent.includes(shop));
  const btn = shopRow?.querySelector("button.btn-ghost");
  return { found: !!btn, disabled: btn?.disabled ?? null, title: btn?.title || "" };
}, SHOP);
ok(archiveState.found, "a brand-new empty location offers Archive");
ok(archiveState.disabled === false, "and it is enabled, because it holds no stock yet");

// ---- Inventory: move stock ----
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/inventory`, { waitUntil: "load" });
await page.waitForTimeout(4500);

const before = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => /avail/.test(r.textContent) && !/Not stocked/i.test(r.textContent));
  return row ? { text: row.innerText.replace(/\n/g, " | "), hasTransfer: !!row.querySelector("button.btn-secondary") } : null;
});
ok(!!before, "Inventory shows a stocked row to move from");
ok(before?.hasTransfer, "a Transfer button appears once a second location exists");

await page.evaluate(() => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => /avail/.test(r.textContent) && !/Not stocked/i.test(r.textContent));
  [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Transfer")?.click();
});
await page.waitForSelector("#transfer-panel", { timeout: 8000 });
ok(true, "the transfer panel opens");

const availShown = await page.evaluate(() =>
  document.querySelector("#transfer-panel .pf-hint")?.textContent || "");
ok(/available/.test(availShown), `the panel states what is actually movable (saw: "${availShown.trim()}")`);

// Refuse more than available, before the round trip.
const maxAvail = parseInt(availShown, 10) || 0;
await page.fill("#tr-qty", String(maxAvail + 1000));
await page.click("#tr-go");
await page.waitForTimeout(700);
const overErr = await page.evaluate(() => {
  const e = document.querySelector('#transfer-panel .pf-error[data-for="tr-qty"]');
  return e && !e.hidden ? e.textContent.trim() : "";
});
ok(/Only \d+ available/.test(overErr), `moving more than available is refused (saw: "${overErr}")`);

// Choose the destination explicitly. Leaving it on the select's first option
// makes the check depend on how the location list happens to sort, and a
// leftover location from an earlier run silently sent the stock elsewhere --
// the assertions then failed against working code.
await page.selectOption("#tr-to", { label: SHOP });
const chosen = await page.evaluate(() => {
  const sel = document.querySelector("#tr-to");
  return sel.options[sel.selectedIndex]?.text || "";
});
ok(chosen.includes(SHOP), `the destination is the one this check created (${chosen})`);

// Choose the destination BY NAME. Leaving the <select> on its first option
// made this check depend on alphabetical order and on whatever locations a
// previous run left behind -- it silently transferred into the wrong shop and
// then failed the assertion about the right one. A check that depends on
// leftovers from its own last run is not a check.
const picked = await page.evaluate((shop) => {
  const sel = document.querySelector("#tr-to");
  const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(shop));
  if (!opt) return null;
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return opt.textContent.trim();
}, SHOP);
ok(picked !== null, `the destination list offers ${SHOP} (picked: ${picked})`);

await page.fill("#tr-qty", "7");
await page.fill("#tr-note", "check: moving to the shop");
await page.click("#tr-go");
await page.waitForTimeout(6000);

const after = await page.evaluate((shop) => {
  const rows = [...document.querySelectorAll(".inv-row")].map((r) => r.innerText.replace(/\n/g, " | "));
  return { atShop: rows.filter((t) => t.includes(shop)), all: rows.length };
}, SHOP);
ok(after.atShop.length > 0, `stock now exists at ${SHOP} (${after.atShop[0] || "nothing"})`);
ok(shows(after.atShop.join(" "), "7 avail"), "and it is exactly the 7 units that were moved");

await page.screenshot({ path: join(ROOT, "checks/screenshots/locations-transfer-mobile.png"), fullPage: true });

// Now the shop holds stock, so archiving it must be blocked WITH a reason.
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/locations`, { waitUntil: "load" });
await page.waitForTimeout(4000);
const blocked = await page.evaluate((shop) => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => r.textContent.includes(shop));
  const btn = row?.querySelector("button.btn-ghost");
  return { disabled: btn?.disabled ?? null, title: btn?.title || "" };
}, SHOP);
ok(blocked.disabled === true, "archiving a location that now holds stock is disabled");
ok(/Transfer them out first/i.test(blocked.title),
  `and says why before the click, not after (saw: "${blocked.title}")`);

await page.screenshot({ path: join(ROOT, "checks/screenshots/locations-mobile.png"), fullPage: true });
ok(errs.length === 0, `no uncaught page errors (${errs.length}${errs.length ? ": " + errs[0].slice(0,80) : ""})`);

// ---- put it back, and prove the last transition works ----
//
// The first version of this teardown called the app's data-layer functions
// inside page.evaluate(). Those are ES module imports; they do not exist in
// the page's global scope, so the whole block threw, was swallowed by its own
// catch, and every run quietly left another shop behind. A cleanup that fails
// silently is worse than none -- it looks like it worked. (Found by counting
// locations in the database after two runs: three, not one.)
//
// Driving the UI instead does the job AND tests the one transition nothing
// else covers: archiving is blocked while stock is present, so moving the
// units home should make it possible again. Blocked becoming allowed once the
// reason goes away is the half of the rule that is easy to get wrong.
await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/inventory`, { waitUntil: "load" });
await page.waitForTimeout(4500);
await page.evaluate((shop) => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => r.textContent.includes(shop));
  [...(row?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "Transfer")?.click();
}, SHOP);
await page.waitForSelector("#transfer-panel", { timeout: 10000 });
await page.evaluate(() => {
  const sel = document.querySelector("#tr-to");
  const opt = [...sel.options].find((o) => o.textContent.includes("Main Warehouse"));
  if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
});
await page.fill("#tr-qty", "7");
await page.fill("#tr-note", "check: putting it back");
await page.click("#tr-go");
await page.waitForTimeout(6000);

await page.goto(`http://127.0.0.1:${PORT}/index.html#/wholesaler/locations`, { waitUntil: "load" });
await page.waitForTimeout(4000);
const freed = await page.evaluate((shop) => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => r.textContent.includes(shop));
  const btn = row?.querySelector("button.btn-ghost");
  return btn ? btn.disabled : null;
}, SHOP);
ok(freed === false,
  "once the stock is moved back out, archiving becomes possible again — the block was about the stock, not the location");

await page.evaluate((shop) => {
  const row = [...document.querySelectorAll(".inv-row")].find((r) => r.textContent.includes(shop));
  row?.querySelector("button.btn-ghost")?.click();
}, SHOP);
await page.waitForTimeout(4500);
const gone = await page.evaluate((shop) => !document.body.innerText.includes(shop), SHOP);
ok(gone, `the test location archives cleanly, leaving nothing behind (${SHOP})`);

await browser.close();
server.close();
console.log("=".repeat(62));
console.log(" CHECK — MULTIPLE LOCATIONS AND REAL TRANSFERS");
console.log("=".repeat(62));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(62));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
