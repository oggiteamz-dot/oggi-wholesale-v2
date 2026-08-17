// =============================================================================
// OGGI Wholesale v2 — BEHAVIOUR CHECK: TAG INPUT
// =============================================================================
//
// The multi-brand box is the feature Hadi asked for twice and could not see,
// so "it renders" is not the bar. This drives it the way a person does --
// typing, pressing Enter, pasting a list, hitting Backspace -- and asserts on
// what actually ends up in the value array.
//
// Every case here is one somebody will really do:
//   - types a brand and presses Enter                 (the core interaction)
//   - types "Nike, Adidas" without thinking           (comma should commit)
//   - pastes a list copied out of a WhatsApp message  (multi-add)
//   - types the same brand twice in different case    (must not duplicate)
//   - taps × on the wrong one                         (removal)
//   - hits Backspace on an empty field                (removes the last)
//   - types a brand and taps Save without pressing Enter
//        ^ the one that loses data in most naive implementations
//
// RUN:  node checks/check_tag_input.mjs
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8167;
const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".woff2":"font/woff2" };

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
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css"><link rel="stylesheet" href="/css/mobile.css">
<link rel="stylesheet" href="/css/brand.css"></head>
<body><div id="mount" style="padding:20px"></div>
<script type="module">
import { renderTagInput } from "/js/components/tag-input.js";
window.__changes = 0;
window.__t = renderTagInput({ placeholder: "e.g. Nike", onChange: () => { window.__changes++; } });
document.getElementById("mount").appendChild(window.__t.el);
window.__ready = true;
</script></body></html>`;

const failures = [];
let n = 0;
function check(label, actual, expected) {
  n++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) { console.log(`      expected ${e}\n      got      ${a}`); failures.push(label); }
}

console.log("============================================================");
console.log(" BEHAVIOUR — TAG INPUT (the multi-brand box)");
console.log("============================================================");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 700 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.route("**/t.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
await page.goto(`http://127.0.0.1:${PORT}/t.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

const field = "#mount .tag-input-field";
const vals = () => page.evaluate(() => window.__t.getValues());

// --- the core interaction -------------------------------------------------
await page.click(field);
await page.type(field, "Nike");
await page.keyboard.press("Enter");
check("type a brand + Enter", await vals(), ["Nike"]);

// --- comma commits too ----------------------------------------------------
await page.type(field, "Adidas,");
check("comma commits", await vals(), ["Nike", "Adidas"]);

// --- duplicate, different case -------------------------------------------
await page.type(field, "nike");
await page.keyboard.press("Enter");
check("duplicate ignored, first spelling kept", await vals(), ["Nike", "Adidas"]);

// --- paste a list ---------------------------------------------------------
// The pasted text is passed as an ARGUMENT, not baked into the function
// source. Written inline, the newline escape survives into the page as a
// literal backslash-n and one tag silently swallows two brands -- which is
// exactly what happened the first time this ran, and every later assertion
// shifted by one and looked like a component bug.
await page.evaluate((text) => {
  const el = document.querySelector("#mount .tag-input-field");
  el.focus();
  const dt = new DataTransfer();
  dt.setData("text", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, "Dsquared2, Emporio Armani\nStone Island");
check("paste a comma/newline list", await vals(),
  ["Nike", "Adidas", "Dsquared2", "Emporio Armani", "Stone Island"]);

// --- a two-word brand stays one tag --------------------------------------
check("a space is not a separator", (await vals()).includes("Emporio Armani"), true);

// --- Backspace on empty removes the last ---------------------------------
await page.click(field);
await page.keyboard.press("Backspace");
check("Backspace on empty removes the last", await vals(),
  ["Nike", "Adidas", "Dsquared2", "Emporio Armani"]);

// --- tap the × on a specific chip ----------------------------------------
await page.click('#mount .tag-chip:nth-child(2) .tag-chip-remove');
check("× removes that chip only", await vals(), ["Nike", "Dsquared2", "Emporio Armani"]);

// --- THE ONE THAT LOSES DATA IN NAIVE VERSIONS ---------------------------
await page.click(field);
await page.type(field, "Balenciaga");
await page.click("body"); // blur without pressing Enter, as if tapping Save
check("typed-but-not-Entered is kept on blur", await vals(),
  ["Nike", "Dsquared2", "Emporio Armani", "Balenciaga"]);

// --- the aria label names the brand --------------------------------------
const aria = await page.$eval("#mount .tag-chip .tag-chip-remove", (e) => e.getAttribute("aria-label"));
check("remove button announces which brand", aria, "Remove Nike");

// --- a typed value is never parsed as HTML -------------------------------
await page.click(field);
await page.type(field, "<img src=x onerror=alert(1)>");
await page.keyboard.press("Enter");
const injected = await page.evaluate(() => document.querySelectorAll("#mount img").length);
check("a typed value is not parsed as HTML", injected, 0);

// --- setValues / clear ----------------------------------------------------
await page.evaluate(() => window.__t.setValues(["Puma", "Puma", "Reebok"]));
check("setValues de-duplicates", await vals(), ["Puma", "Reebok"]);
await page.evaluate(() => window.__t.clear());
check("clear empties it", await vals(), []);

check("no uncaught page errors", errs, []);

// A populated shot, so the screenshot on file shows the control doing its job
// rather than the empty state left behind by the clear() test above.
await page.evaluate(() => window.__t.setValues(
  ["Nike", "Dsquared2", "Emporio Armani", "Stone Island", "Balenciaga", "Adidas", "Puma"]));
await page.waitForTimeout(150);
await page.screenshot({ path: join(ROOT, "checks/screenshots/tag-input.png") });
await browser.close();
server.close();

console.log("------------------------------------------------------------");
if (!failures.length) { console.log(` ✓ PASS — ${n} behaviours.`); process.exit(0); }
console.log(` ✗ FAIL — ${failures.length} of ${n}:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
