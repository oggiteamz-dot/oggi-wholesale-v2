// =============================================================================
// OGGI Wholesale v2 — BEHAVIOUR CHECK: IMAGE DOWNSCALE
// =============================================================================
// The upload path's whole value is that a 4000px phone photo does not travel
// whole over a 43.9 Mbps connection. That claim is testable, so it is tested.
//
// Only downscaleImage() is exercised here -- uploading needs a signed-in
// wholesaler and would be testing storage policy, which was already proven
// directly against the live database (as SQUARE: writing sq/ = true,
// writing mg/ = false).
// =============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8189;
const MIME = { ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  try {
    const f = join(ROOT, decodeURIComponent(req.url.split("?")[0]));
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(PORT, r));

// downscaleImage is imported on its own. uploads.js also imports the supabase
// client, which needs window.supabase at module-load time -- so a minimal stub
// stands in. It is never called by the code under test.
const PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<script>window.supabase = { createClient: () => ({ storage:{from:()=>({})}, auth:{ onAuthStateChange(){}, getSession:async()=>({data:{}}) } }) };</script>
<script type="module">
import { downscaleImage } from "/js/data/uploads.js";
window.__downscale = downscaleImage;

// A synthetic "phone photo": 4032x3024, the real output size of a 12MP camera,
// with noise so it does not compress to nothing and flatter the result.
window.__makePhoto = async (w = 4032, h = 3024) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#0E2230"); g.addColorStop(0.5, "#00845F"); g.addColorStop(1, "#54E5A0");
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) {
    x.fillStyle = \`rgba(\${(i*37)%255},\${(i*91)%255},\${(i*53)%255},0.5)\`;
    x.fillRect((i*137)%w, (i*211)%h, 14, 14);
  }
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  return new File([blob], "IMG_4821.png", { type: "image/png" });
};
window.__ready = true;
</script></body></html>`;

const fails = [];
let n = 0;
function check(label, cond, detail = "") {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) fails.push(label);
}

console.log("============================================================");
console.log(" BEHAVIOUR — IMAGE DOWNSCALE");
console.log("============================================================");

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.route("**/u.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
await page.goto(`http://127.0.0.1:${PORT}/u.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

const r = await page.evaluate(async () => {
  const file = await window.__makePhoto();
  const t0 = performance.now();
  const out = await window.__downscale(file);
  return {
    inBytes: file.size, outBytes: out.blob.size,
    w: out.width, h: out.height, type: out.type,
    ms: Math.round(performance.now() - t0),
  };
});

const kb = (b) => `${Math.round(b / 1024)} KB`;
console.log(`   4032x3024 ${kb(r.inBytes)} -> ${r.w}x${r.h} ${kb(r.outBytes)} as ${r.type} in ${r.ms}ms\n`);

check("longest edge capped at 1600px", Math.max(r.w, r.h) === 1600, `${r.w}x${r.h}`);
check("aspect ratio preserved", Math.abs((r.w / r.h) - (4032 / 3024)) < 0.01);
check("re-encoded to webp where supported", r.type === "image/webp", r.type);
check("well under the 5 MB server cap", r.outBytes < 5 * 1024 * 1024, kb(r.outBytes));
check("meaningfully smaller than the original",
  r.outBytes < r.inBytes * 0.5, `${Math.round((1 - r.outBytes / r.inBytes) * 100)}% saved`);
// A wholesaler adding ten photos should not be staring at a frozen screen.
check("fast enough to feel instant", r.ms < 3000, `${r.ms}ms`);

// A small image must not be scaled UP -- that would make the file bigger for
// no reason, the opposite of the point.
const small = await page.evaluate(async () => {
  const f = await window.__makePhoto(300, 200);
  const o = await window.__downscale(f);
  return { w: o.width, h: o.height };
});
check("a small image is not upscaled", small.w === 300 && small.h === 200, `${small.w}x${small.h}`);

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
server.close();
console.log("------------------------------------------------------------");
if (!fails.length) { console.log(` ✓ PASS — ${n} behaviours.`); process.exit(0); }
console.log(` ✗ FAIL — ${fails.length} of ${n}:`); fails.forEach(f => console.log(`   • ${f}`));
process.exit(1);
