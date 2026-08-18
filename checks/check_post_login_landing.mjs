// =============================================================================
// CHECK: signing in lands you on your home screen, not on "Page not found"
// =============================================================================
// 18 Aug 2026. Found by smoke-testing the LIVE site rather than a local build,
// and it is the single most visible bug this product has had: after typing a
// correct email and password, every user of every role saw
//
//     Page not found
//     That route doesn't exist in v2 yet.
//
// with a working topbar and navigation bar around it, so it read as a half-
// broken app rather than a routing detail.
//
// WHY IT SURVIVED SO LONG. app.js carried the comment "If the hash doesn't
// match anything for this role yet, send them home" above code that only
// tested for an EMPTY hash or "#/". Signing in leaves the hash at "#/login",
// which is neither, so the guard never fired. The comment described the
// intended behaviour and the code did something narrower; a reader checking
// the comment would have concluded it was handled.
//
// The check runs the REAL router against the REAL registered routes, in a
// browser, for all four roles -- not just the one that happened to be tested.
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = process.env.APP_ROOT || process.cwd(), PORT = 8215;
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

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });

// Load the real router and the real route registrations, and ask the same
// question app.js asks. No mock router: a mock would have happily "matched"
// /login and hidden the bug.
const result = await page.evaluate(async () => {
  const { router } = await import("/js/lib/router.js");
  const mods = await Promise.all([
    import("/js/views/owner.js"), import("/js/views/wholesaler.js"),
    import("/js/views/salesperson.js"), import("/js/views/buyer.js"),
    import("/js/views/mobile-ops.js"), import("/js/views/import-catalog.js"),
    import("/js/views/integrations.js"),
  ]);
  mods[0].registerOwnerRoutes(router);
  mods[1].registerWholesalerRoutes(router);
  mods[2].registerSalespersonRoutes(router);
  mods[3].registerBuyerRoutes(router);
  mods[4].registerMobileOpsRoutes(router);
  mods[5].registerImportRoutes(router);
  mods[6].registerIntegrationsRoutes(router);

  const homeByRole = { owner: "/owner", wholesaler: "/wholesaler", sales: "/sales", buyer: "/buyer" };
  return {
    hasMatches: typeof router.matches === "function",
    // The path the hash actually holds at the moment of a successful sign-in.
    loginResolves: typeof router.matches === "function" ? router.matches("/login") : null,
    homesResolve: Object.fromEntries(
      Object.entries(homeByRole).map(([role, path]) => [role, router.matches(path)])),
    // A stale bookmark into another role's area: same failure shape.
    strayResolves: typeof router.matches === "function" ? router.matches("/not-a-real-route") : null,
  };
});

ok(result.hasMatches,
  "router exposes matches() so app.js can ASK whether a path resolves instead of enumerating the ones that do not");
ok(result.loginResolves === false,
  "'/login' does not resolve to a route once the shell is mounted — which is exactly why the redirect has to fire for it");
ok(result.strayResolves === false,
  "an unknown path does not resolve either");
for (const [role, resolves] of Object.entries(result.homesResolve)) {
  ok(resolves === true, `the home route for ${role} resolves, so redirecting there lands somewhere real`);
}

// The guard in app.js must be driven by matches(), not by an equality test
// against a hand-written list of paths. Checked as source because this is a
// statement about HOW the decision is made, and the wrong how is what broke.
const appSrc = await (await fetch(`http://127.0.0.1:${PORT}/js/app.js`)).text();
ok(/router\.matches\(\s*router\.currentPath\(\)\s*\)/.test(appSrc),
  "app.js decides the redirect with router.matches(router.currentPath())");
ok(!/window\.location\.hash === "#\/"/.test(appSrc),
  "app.js no longer decides it by comparing the hash against a fixed string");

await browser.close();
server.close();

console.log("=".repeat(62));
console.log(" CHECK — SIGNING IN LANDS SOMEWHERE REAL");
console.log("=".repeat(62));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(62));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
