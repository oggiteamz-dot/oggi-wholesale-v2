// =============================================================================
// CHECK: a deploy actually reaches someone who already has the app installed
// =============================================================================
// This is the assertion the other service-worker check cannot make.
//
// checks/check_service_worker.mjs drives sw.js inside a mocked
// ServiceWorkerGlobalScope, and its mock defines `waitUntil: () => {}`. That
// mock is why it passes: in Node, a promise nobody holds onto still runs to
// completion. In a real browser it does not -- the moment respondWith settles,
// the browser is free to terminate the worker, and any fetch/cache.put still in
// flight dies with it. A stale-while-revalidate that never calls
// event.waitUntil() therefore revalidates only when it happens to win a race.
//
// That is not theoretical. On 19 Aug the live site was serving a wholesaler.js
// FOUR COMMITS BEHIND to an installed client while the network had the current
// one, and the person using it was told, truthfully, that it was deployed. The
// deploy was real; it just could not reach him. This has now happened twice
// (the 15 Aug escaping fix was the first).
//
// So this check refuses to reason about the code at all. It starts a real
// server, installs the real sw.js in real Chromium, CHANGES A FILE ON DISK the
// way a deploy does, reloads, and demands the new code actually run. If it
// takes more than one reload, that is reported and failed -- "eventually" is
// what we had.
//
//   node checks/check_deploy_reaches_installed_client.mjs
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, extname, dirname } from "node:path";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---- a throwaway site whose one module we can "redeploy" -------------------
const ROOT = await mkdtemp(join(tmpdir(), "swdeploy-"));
await cp(join(process.cwd(), "sw.js"), join(ROOT, "sw.js"));
await cp(join(process.cwd(), "js", "register-sw.js"), join(ROOT, "register-sw.js"));

// sw.js precaches a fixed SHELL_FILES list and install() rejects if ANY of
// them 404 -- cache.addAll is all-or-nothing. So the fixture has to provide
// every one of them, read out of the real sw.js rather than hand-copied, or
// this check would silently be testing a worker that never installed.
const shellList = (await readFile(join(ROOT, "sw.js"), "utf8"))
  .match(/const SHELL_FILES = \[([\s\S]*?)\]/)[1]
  .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter((s) => s && s !== "/");
for (const f of shellList) {
  if (f === "/index.html") continue;
  await mkdir(dirname(join(ROOT, f)), { recursive: true });
  await writeFile(join(ROOT, f), "/* fixture */");
}

const marker = (v) => `export const VERSION = "${v}";\ndocument.title = "APP-" + VERSION;\n`;
await writeFile(join(ROOT, "feature.js"), marker("V1"));
// The real register-sw.js, not a stand-in: the bar it puts on screen IS the
// behaviour under test, and a hand-rolled registration here would be checking
// a fixture rather than the app.
await writeFile(join(ROOT, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<title>booting</title></head><body>
<script type="module">import "./feature.js";<\/script>
<script src="/register-sw.js"><\/script>
</body></html>`);

const MIME = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".css": "text/css" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  try {
    const buf = await readFile(join(ROOT, p));
    // Same headers Cloudflare serves the real app with, so the browser's own
    // HTTP cache behaves here the way it does in production -- including the
    // ETag, since the worker uses it to tell one build from another. (The
    // worker no longer DEPENDS on it: with no validator at all it falls back
    // to comparing bodies. But a fixture that omits what production sends is
    // testing a different system.)
    res.writeHead(200, {
      "Content-Type": MIME[extname(p)] || "application/octet-stream",
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: '"' + createHash("md5").update(buf).digest("hex") + '"',
    });
    res.end(buf);
  } catch { res.writeHead(404).end(); }
});
const PORT = 8241;
await new Promise((r) => server.listen(PORT, r));
const URL_ = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// ---- 1. install ------------------------------------------------------------
await page.goto(URL_, { waitUntil: "load" });
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
  .catch(() => {});
await page.reload({ waitUntil: "load" });     // first controlled load
await page.waitForTimeout(1500);

const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
ok(controlled, "the service worker installs and takes control");
ok(await page.title() === "APP-V1", `the app runs V1 (title: "${await page.title()}")`);

const cachedV1 = await page.evaluate(async () => {
  for (const n of await caches.keys()) {
    const r = await (await caches.open(n)).match(location.origin + "/feature.js");
    if (r) return (await r.text()).includes("V1");
  }
  return false;
});
ok(cachedV1, "and the shell cache holds it, so the app works offline");

// ---- 2. deploy -------------------------------------------------------------
await writeFile(join(ROOT, "feature.js"), marker("V2"));

const netIsV2 = await page.evaluate(async () =>
  (await (await fetch("/feature.js?bust=" + Math.random())).text()).includes("V2"));
ok(netIsV2, "the new build is genuinely on the server (the deploy itself worked)");

// ---- 3. does it reach this already-installed client? ------------------------
// Reload once. A correct stale-while-revalidate is allowed to serve the stale
// copy on THIS load, but it must have refreshed the cache by the end of it.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2500);
const titleAfter1 = await page.title();

const cacheAfter1 = await page.evaluate(async () => {
  for (const n of await caches.keys()) {
    const r = await (await caches.open(n)).match(location.origin + "/feature.js");
    if (r) return (await r.text()).includes("V2") ? "V2" : "V1";
  }
  return "absent";
});
ok(cacheAfter1 === "V2",
  `one load after the deploy, the cache holds the new build (holds: ${cacheAfter1})`);

// Reload again. By now there is no excuse left: the user has opened the app
// twice since the deploy.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2000);
const titleAfter2 = await page.title();
ok(titleAfter2 === "APP-V2",
  `two loads after the deploy, the user is RUNNING the new build (title: "${titleAfter2}", was "${titleAfter1}" one load earlier)`);

// ---- 4. THE POINT: a tab that never navigates must still find out ----------
// This is the failure that actually happened. Switching screens in this app
// only changes the URL hash, so the page never loads; the person keeps working
// in a tab that has been open for days while deploy after deploy lands on the
// server. Everything above tests reloads. Nothing above tests the case where
// there is no reload, which is the normal one.
const page2 = await ctx.newPage();
await page2.goto(URL_, { waitUntil: "load" });
await page2.waitForTimeout(2000);
await writeFile(join(ROOT, "feature.js"), marker("V3"));

// No reload, no navigation — the tab simply comes back to the foreground, and
// asks. (setTimeout in register-sw.js fires the first ask at 5s; force it here
// rather than sleeping, since the throttle is time-based by design.)
await page2.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "check-for-update" }));
await page2.waitForSelector(".app-update-bar", { timeout: 15000 }).catch(() => {});
const barred = await page2.evaluate(() => {
  const b = document.querySelector(".app-update-bar");
  return b ? b.innerText.replace(/\s+/g, " ").trim() : "";
});
ok(/newer version/i.test(barred),
  `a tab that never navigated is TOLD a new build exists (bar: "${barred}")`);

const reloadBtn = await page2.$(".app-update-reload");
ok(!!reloadBtn, "and the bar offers a Reload button rather than reloading under them");
if (reloadBtn) {
  await reloadBtn.click();
  await page2.waitForTimeout(2500);
  ok(await page2.title() === "APP-V3",
    `clicking Reload lands them on the new build (title: "${await page2.title()}")`);
}
await page2.close();

// ---- 5. and offline still works, which is why the cache exists at all -------
await ctx.setOffline(true);
await page.reload({ waitUntil: "load" }).catch(() => {});
await page.waitForTimeout(1200);
const offlineTitle = await page.title();
ok(/^APP-V/.test(offlineTitle),
  `with the network gone the app still boots from cache (title: "${offlineTitle}")`);
await ctx.setOffline(false);

await browser.close();
server.close();

console.log("=".repeat(64));
console.log(" CHECK — A DEPLOY REACHES AN ALREADY-INSTALLED CLIENT");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`);
  console.log("   A deploy that cannot reach existing users is not a deploy.");
  process.exit(1);
}
console.log(` ✓ PASS — ${pass.length} assertions.`);
