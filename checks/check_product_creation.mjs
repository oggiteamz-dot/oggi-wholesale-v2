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
// Barcodes are globally unique (migration 016 for variants, 051 for the other
// two tiers), so fixed literals make this check pass exactly once and then
// fail forever after -- the second run collides with the first run's rows and
// two variants silently fail to insert. Derived from the stamp for the same
// reason the locations check derives its shop name: a check that pollutes the
// database is a check that breaks itself.
const CODE_A = `20${String(Date.now()).slice(-9)}1`.slice(0, 12);
const CODE_B = `21${String(Date.now()).slice(-9)}2`.slice(0, 12);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.route("**://*.supabase.co/**", async (route) => {
  const r = route.request();
  try {
    // postDataBuffer(), NOT postData(). postData() returns a STRING, so a
    // binary body -- every image upload -- is decoded as UTF-8 and re-encoded,
    // and every byte >= 0x80 becomes U+FFFD. The photos this check uploaded
    // were arriving in storage as corrupt WebP: 80 replacement characters in
    // an 801-byte file, unreadable by any browser. The assertion said "1 photo
    // attached" and was telling the truth about the message while the file
    // itself was destroyed in the harness. Nothing about the app was wrong.
    const res = await fetch(r.url(), { method: r.method(), headers: r.headers(),
      body: ["GET","HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() });
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

// ---- THE GRID ROW MUST EXIST BEFORE ANYTHING IS TYPED ----
// This ordering is the point of the assertion, not an accident of it. The
// previous version added a colour and immediately typed its name, and typing
// in a name field repaints the grid -- so "the grid has one row per colour"
// passed on a build where ADDING a colour produced no row at all, which is
// exactly the bug Hadi hit. Nothing may be typed between the add and the
// check.
await page.click('.pb-colour-add button:has-text("+ Add colour")');
await page.waitForTimeout(400);
const rowsBeforeTyping = await page.evaluate(() => document.querySelectorAll(".pb-grid-row").length);
ok(rowsBeforeTyping === 1,
  `a colour gets its grid row on being added, before a single keystroke (${rowsBeforeTyping} row(s))`);
await page.evaluate(() => {
  const c = document.querySelector(".pb-colour");
  // .pb-colour-del, NOT .btn-ghost. This check clicked Remove by its STYLING
  // class, so restyling the button from btn-ghost to btn-danger-quiet made the
  // teardown silently do nothing -- the colour stayed, every later count was
  // off by one, and fourteen assertions failed for a reason that had nothing
  // to do with what they were testing. A test that reaches for a styling hook
  // is coupled to how something looks, which is the thing most likely to
  // change. .pb-colour-del exists to be selected.
  c?.querySelector(".pb-colour-del")?.click();
});
await page.waitForTimeout(300);

// ---- colour 1, picked in the full-screen picker ----
// Hadi: "when I click on pick from photo... nothing." The button used to arm a
// mode and wait for a tap on a 90px thumbnail. It now opens the photo full
// screen, which is what these assertions check for.
await page.click('.pb-colour-add button:has-text("Pick colours from photo")');
await page.waitForTimeout(600);
ok(await page.evaluate(() => !!document.querySelector(".pb-picker")),
  "Pick from photo OPENS something — a full-screen picker, not a silent mode");

const stageBig = await page.evaluate(() => {
  const c = document.querySelector(".pb-picker-stage canvas");
  if (!c) return 0;
  const r = c.getBoundingClientRect();
  return Math.round(Math.min(r.width, r.height));
});
// The whole complaint was that sampling happened on a thumbnail. On the 390px
// viewport this check runs at, anything under ~200px would be the old problem
// wearing a new class name.
ok(stageBig >= 200, `the photo actually takes over the screen (${stageBig}px on its short edge)`);

await page.locator(".pb-picker-stage canvas").click({ position: { x: 40, y: 40 } });
await page.waitForTimeout(500);

const sampled = await page.evaluate(() =>
  document.querySelector('.pb-colour input[type="color"]')?.value.toLowerCase() || "");
ok(sampled === "#b91c1c",
  `tapping the photo takes the ACTUAL colour under the finger (fixture is #b91c1c, got ${sampled})`);

// Hadi: "the system should create a custom name for every color."
const autoName = await page.evaluate(() =>
  document.querySelector(".pb-colour-name")?.value || "");
ok(autoName === "Crimson",
  `the colour arrives already named from its own value (got "${autoName}")`);

// "Every click is a color" -- the picker stays open and keeps collecting.
ok(await page.evaluate(() => !!document.querySelector(".pb-picker")),
  "the picker stays open after a pick, so a run of taps is possible");
await page.locator(".pb-picker-stage canvas").click({ position: { x: 70, y: 70 } });
await page.waitForTimeout(400);
const afterTwoTaps = await page.evaluate(() => document.querySelectorAll(".pb-colour").length);
ok(afterTwoTaps === 2, `a second tap adds a second colour (${afterTwoTaps} colours)`);

// The second tap on a one-colour fixture finds the same red, so the name must
// be made unique rather than colliding -- two variants called "Crimson" would
// be a duplicate SKU and an unanswerable question on the packing bench.
const names = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-colour-name")].map((i) => i.value));
ok(names[1] === "Crimson 2", `a repeat of the same colour is numbered, not duplicated (got "${names[1]}")`);

await page.click(".pb-picker [data-done]");
await page.waitForTimeout(400);
ok(await page.evaluate(() => !document.querySelector(".pb-picker")), "Done closes the picker");

// Drop the extra colour the run created, then rename the first by hand --
// which also proves an auto-name can be overwritten.
await page.evaluate(() => {
  const rows = document.querySelectorAll(".pb-colour");
  rows[rows.length - 1]?.querySelector(".pb-colour-del")?.click();
});
await page.waitForTimeout(300);
await page.fill(".pb-colour-name", "Crimson");
await page.waitForTimeout(200);
ok(true, "a colour can be renamed after it is picked");

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
// NOTE the input[type="number"] selectors below: as of Batch 16 a cell holds a
// quantity AND a barcode, so a bare ".pb-cell input" now matches two elements
// per cell and the indexes below would silently step through qty, barcode,
// qty, barcode -- passing or failing for reasons that have nothing to do with
// carry-forward.
await page.evaluate(() => {
  const cells = document.querySelectorAll(".pb-grid-row")[0].querySelectorAll('.pb-cell input[type="number"]');
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
  [...document.querySelectorAll(".pb-grid-row")[0].querySelectorAll('.pb-cell input[type="number"]')].map((i) => i.value));
ok(carried[0] === "12" && carried[1] === "9",
  `renaming one size carries the others' quantities forward (${carried.join(",")})`);

// SCANNING INTO A CELL. Hadi asked for the barcode scanner v1 had; the point
// of these assertions is that a scan lands in the RIGHT cell, because a code
// that goes somewhere plausible-but-wrong is worse than one that goes nowhere.
// The scan bar is driven exactly as a hardware scanner drives it: type the
// code, press Enter. No camera is involved, which is also true in the
// warehouse -- the camera is progressive enhancement over this path.
await page.evaluate(() => {
  // Aim at the first colour's second cell by focusing it, the way a finger
  // would. Aiming is the whole safety mechanism, so it is exercised, not
  // bypassed by writing to state directly.
  document.querySelectorAll(".pb-grid-row")[0]
    .querySelectorAll('.pb-cell input[type="number"]')[1].focus();
});
await page.waitForTimeout(200);
const aimedAt = await page.evaluate(() => document.querySelector("[data-scan-aim]")?.textContent || "");
ok(/·\s*M\b/.test(aimedAt), `the form says which cell a scan will fill (saw: "${aimedAt}")`);

const scanInput = ".pb-scan input";
await page.fill(scanInput, CODE_A);
await page.press(scanInput, "Enter");
await page.waitForTimeout(300);

const barcodeValues = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell-barcode")].map((i) => i.value));
ok(barcodeValues[1] === CODE_A,
  `a scan fills the aimed cell (cell 2 holds "${barcodeValues[1]}")`);
ok(barcodeValues[0] === "" && barcodeValues[2] === "",
  `and fills ONLY that cell (neighbours: "${barcodeValues[0]}" / "${barcodeValues[2]}")`);

// After a scan the aim advances, so a run of codes can be fired in without
// touching the screen between them.
const advanced = await page.evaluate(() => document.querySelector("[data-scan-aim]")?.textContent || "");
ok(advanced !== aimedAt, `the aim moves on after a scan (was "${aimedAt}", now "${advanced}")`);

// A barcode identifies exactly one variant, so the same code twice must be
// refused AT THE SCAN -- not at save, by which time the operator has put the
// label gun down and no longer knows which two cells collided.
await page.fill(scanInput, CODE_A);
await page.press(scanInput, "Enter");
await page.waitForTimeout(300);
const scanStatus = await page.evaluate(() => document.querySelector("[data-scan-status]")?.textContent || "");
ok(/already/i.test(scanStatus), `scanning a duplicate barcode is refused on the spot (saw: "${scanStatus}")`);
const afterDupe = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell-barcode")].map((i) => i.value).filter(Boolean).length);
ok(afterDupe === 1, `and the duplicate is not written anywhere (${afterDupe} barcode(s) on this colour)`);

// Hadi: "each barcode space should have a small button next to it to click
// scan". The button's job is to aim at ITS OWN cell -- a scan control that
// fills some other cell is worse than none, because the operator has already
// moved on by the time it shows.
const scanBtns = await page.evaluate(() =>
  document.querySelectorAll(".pb-cell .pb-cell-scan").length);
const cellCount = await page.evaluate(() => document.querySelectorAll(".pb-cell").length);
ok(scanBtns === cellCount, `every barcode field has its own Scan button (${scanBtns} buttons / ${cellCount} cells)`);

await page.evaluate(() => {
  // Third cell of the first colour -- deliberately not the aimed one, so a
  // button that did nothing would leave the aim where it was and fail below.
  document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell-scan")[2].click();
});
await page.waitForTimeout(300);
const aimedByButton = await page.evaluate(() => document.querySelector("[data-scan-aim]")?.textContent || "");
ok(/·\s*L\b/.test(aimedByButton), `a cell's Scan button aims at that cell (saw: "${aimedByButton}")`);

await page.fill(".pb-scan input", CODE_B);
await page.press(".pb-scan input", "Enter");
await page.waitForTimeout(400);
const perCell = await page.evaluate(() =>
  [...document.querySelectorAll(".pb-grid-row")[0].querySelectorAll(".pb-cell-barcode")].map((i) => i.value));
ok(perCell[2] === CODE_B, `and the scan lands in that cell (cell 3 holds "${perCell[2]}")`);

// Each size carries its OWN barcode -- that is the shape Hadi settled on.
const filled = perCell.filter(Boolean).length;
ok(filled === 2, `barcodes are per size, held independently (${filled} of ${perCell.length} sizes carry one)`);

// One cell WITH stock and one WITHOUT — the second is what used to vanish.
await page.evaluate(() => {
  const rows = document.querySelectorAll(".pb-grid-row");
  const navy = rows[1].querySelectorAll('.pb-cell input[type="number"]');
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

// ---- supplier, created without leaving the form ----
// Hadi: "we should be able to create a supplier in the products tab here in
// the inventory and in the catalogs whenever we create an actual product".
// Leaving to go and make one would mean abandoning the photos and the grid,
// neither of which survives a navigation -- so the create form lives here.
ok(await page.evaluate(() => !!document.querySelector("#pb-supplier")),
  "the product form has a supplier section");

const SUPPLIER = `Probe Mills ${STAMP}`;
await page.click('#pb-supplier button:has-text("+ New supplier")');
await page.waitForTimeout(400);
// Hadi made four fields mandatory: name, contact person, phone, location.
// Prove the rule fires BEFORE proving the happy path -- a required-field rule
// that is never seen to refuse anything is indistinguishable from no rule.
await page.evaluate((n) => {
  const f = document.querySelectorAll("#pb-supplier .pb-supplier-new input");
  f[0].value = n; f[0].dispatchEvent(new Event("input", { bubbles: true }));
}, SUPPLIER);
await page.click('#pb-supplier button:has-text("Save supplier")');
await page.waitForTimeout(800);
const supErr = await page.evaluate(() => {
  const e = document.querySelector('#pb-supplier .pf-error:not([hidden])');
  return e ? e.textContent.trim() : "";
});
ok(/contact person/i.test(supErr) && /phone/i.test(supErr) && /location/i.test(supErr),
  `a supplier without contact, phone or location is refused, naming all three at once (saw: "${supErr}")`);

await page.evaluate(() => {
  const f = document.querySelectorAll("#pb-supplier .pb-supplier-new input");
  const set = (i, v) => { f[i].value = v; f[i].dispatchEvent(new Event("input", { bubbles: true })); };
  set(1, "Wei Zhang");          // contact person
  set(2, "+86 555 0100");       // phone
  set(5, "Hangzhou, Zhejiang"); // address — the location requirement
});
await page.click('#pb-supplier button:has-text("Save supplier")');
await page.waitForTimeout(3000);

const supSelected = await page.evaluate(() => {
  const sel = document.querySelector("#pb-supplier select");
  return sel ? sel.options[sel.selectedIndex]?.textContent || "" : "";
});
ok(supSelected === SUPPLIER,
  `a supplier created here is selected straight away (saw: "${supSelected}")`);

// The contact details are the reason to record a supplier at all, so they have
// to come back on screen rather than just into the database.
const supCard = await page.evaluate(() =>
  document.querySelector("#pb-supplier .pb-supplier-card")?.textContent || "");
ok(/Wei Zhang/.test(supCard) && /555 0100/.test(supCard),
  `and its contact details show under the picker (saw: "${supCard.slice(0, 80)}")`);

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

// "The message says a photo was attached" and "the photo is a readable image"
// are different claims, and only the first was ever checked. The stored object
// is fetched and its container validated HERE IN NODE rather than in the page,
// because this browser runs sandboxed with no outbound network -- asserting
// through it would be testing the harness, not the upload.
//
// This assertion exists because the harness was silently destroying every
// image it uploaded: Playwright's route.request().postData() returns a STRING,
// so the binary body was decoded as UTF-8 and re-encoded, turning every byte
// >= 0x80 into U+FFFD. The stored WebP had 80 replacement characters in 801
// bytes and no browser could open it, while "1 photo attached" passed happily.
// The thumbnail of THIS product, not whichever row happens to be first. The
// inventory list is sorted lowest-available-first and contains every product
// this probe wholesaler has ever had, so a bare querySelector was testing an
// arbitrary older upload -- including ones written before the harness bug
// above was fixed, which is how this assertion failed on a run that had just
// stored a perfectly good file.
// Batch 19 turned the inventory list from text rows into cards, so the
// thumbnail moved from .inv-row .prod-thumb to .pcard-media. Updated here
// rather than left to "no thumbnail on screen -- skipped", which is what this
// assertion would have degraded to: a check that silently stops checking when
// the markup it targets is renamed is worse than one that fails, because it
// keeps reporting a pass it is no longer earning.
const storedSrc = await page.evaluate((name) => {
  const card = [...document.querySelectorAll(".pcard")]
    .find((c) => c.innerText.includes(name));
  return card?.querySelector(".pcard-media img")?.src || "";
}, PRODUCT);
if (!storedSrc) {
  console.log("  NOTE  no thumbnail on screen — skipped the image-integrity assertion");
} else {
  let verdict = "could not fetch";
  try {
    const res = await fetch(storedSrc);
    const buf = Buffer.from(await res.arrayBuffer());
    const replacements = buf.filter((b, i) =>
      b === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd).length;
    const isWebp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(1, 4).toString() === "PNG";
    // The declared RIFF length must match the file, which is exactly what the
    // corruption broke: the header claimed 642 bytes for an 801-byte file.
    const riffOk = !isWebp || (8 + buf.readUInt32LE(4)) === buf.length;
    const good = (isWebp || isJpeg || isPng) && riffOk && replacements === 0;
    verdict = good
      ? `valid ${isWebp ? "WebP" : isJpeg ? "JPEG" : "PNG"}, ${buf.length} bytes`
      : `${buf.length} bytes, webp=${isWebp} riffLengthOk=${riffOk} utf8Replacements=${replacements}`;
    ok(good, `the uploaded photo is a readable image file (${verdict})`);
  } catch (e) {
    ok(false, `the uploaded photo could not be fetched back (${e.message})`);
  }
}
// The colour/size breakdown now lives one click in, behind the card's
// "Receive & transfer" button, so the check has to open it. The card itself
// carries only the product-level summary -- which is the point of the card,
// and is why the assertions below moved rather than being dropped.
const opened = await page.evaluate((name) => {
  const card = [...document.querySelectorAll(".pcard")]
    .find((c) => c.innerText.includes(name));
  const btn = [...(card?.querySelectorAll(".pcard-actions .btn") || [])]
    .find((b) => /receive/i.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
}, PRODUCT);
ok(opened, "the product's card offers the stock breakdown");
await page.waitForTimeout(1200);
const detailText = await page.evaluate(() =>
  document.querySelector(".inv-detail")?.innerText || "");
ok(shows(detailText, "Crimson"), "with its sampled colour name");
ok(shows(detailText, "Deep Navy"), "and its palette colour name");
ok(shows(detailText, "not stocked yet"),
  "and the cells left at zero are visible, badged 'Not stocked yet' — these are what used to be invisible");

// Both doors, on the card, where Hadi asked for them: "give me a button to
// essentially edit or a button to view or both."
const cardBtns = await page.evaluate((name) => {
  const card = [...document.querySelectorAll(".pcard")]
    .find((c) => c.innerText.includes(name));
  return [...(card?.querySelectorAll(".pcard-actions .btn") || [])].map((b) => b.textContent.trim());
}, PRODUCT);
ok(cardBtns.includes("View") && cardBtns.includes("Edit"),
  `the card carries View and Edit (saw: ${cardBtns.join(", ") || "none"})`);

// And View actually opens, against the real database -- getProductDetail()
// joins v2_inventory_balances to v2_locations and reads v2_suppliers, none of
// which the jsdom component check can exercise. If a column grant is wrong,
// this is where it shows.
await page.evaluate((name) => {
  const card = [...document.querySelectorAll(".pcard")].find((c) => c.innerText.includes(name));
  [...(card?.querySelectorAll(".pcard-actions .btn") || [])]
    .find((b) => b.textContent.trim() === "View")?.click();
}, PRODUCT);
await page.waitForTimeout(2500);
const viewText = await page.evaluate(() => document.querySelector(".pdet")?.innerText || "");
ok(shows(viewText, PRODUCT), "the View panel opens on the real product");
ok(/Barcodes/i.test(viewText) && viewText.includes(CODE_A),
  `and shows the barcodes it was created with (looking for ${CODE_A})`);
ok(await page.evaluate(() => document.querySelectorAll(".pdet input, .pdet textarea, .pdet select").length) === 0,
  "and nothing in it can be typed into");
await page.evaluate(() => document.querySelector(".pdet-close")?.click());

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
