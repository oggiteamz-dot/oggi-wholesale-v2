// CHECK: the service worker cannot serve stale code forever.
//
// Behaviour check. It loads the real sw.js into a mocked ServiceWorker
// global scope and drives real fetch events through it, asserting what
// comes back and what lands in the cache. It does not care what the
// caching strategy is called or how it is written — only what it does.
//
// Why this exists: the previous service worker served static assets
// cache-first with no revalidation, so a deployed fix never reached an
// already-installed client. A verification pass against the live site
// reported the deploy had FAILED because the worker handed back cached
// copies of the old files. Deploys that cannot reach existing users are
// not deploys, and the failure is silent.
//
// Run:  node checks/check_service_worker.mjs
// Exit 0 = all assertions held. Exit 1 = something regressed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(join(here, "..", "sw.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? "\n        " + detail : ""}`); fail++; }
};
const tick = () => new Promise((r) => setImmediate(r));

// ---- minimal ServiceWorkerGlobalScope -----------------------------------
function makeScope({ cacheSeed = {}, network }) {
  const store = new Map(Object.entries(cacheSeed));
  const caches = {
    _store: store,
    open: async () => ({
      addAll: async () => {},
      put: async (req, res) => { store.set(typeof req === "string" ? req : req.url, res); },
    }),
    match: async (req) => store.get(typeof req === "string" ? req : req.url),
    keys: async () => ["oggi-wholesale-v2-shell-v1"],
    delete: async () => true,
  };
  const listeners = {};
  const scope = {
    self: null,
    caches,
    URL,
    console,
    setTimeout, setImmediate, Promise,
    fetch: network,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    // matchAll, not just claim: the worker now posts an "app-updated"
    // message to open pages when a revalidation finds the server has moved
    // on. A mock without matchAll makes that path throw, and a throw inside
    // the revalidation looks exactly like "the cache was never refreshed" --
    // which is what this mock reported the first time it was run against it.
    clients: {
      claim: async () => {},
      _posted: [],
      matchAll: async () => [{ postMessage: (m) => scope.clients._posted.push(m) }],
    },
    location: { origin: "https://app.test" },
    __listeners: listeners,
  };
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(swSource, scope);
  return scope;
}

// Responses carry headers, because the worker now decides whether a file
// actually changed by comparing ETags. A headerless mock response would make
// every deploy look identical to the one before it.
const body = (text, opts = {}) => ({
  ok: opts.ok !== false, status: opts.status ?? 200, type: opts.type ?? "basic",
  headers: { get: (k) => (opts.headers || {})[String(k).toLowerCase()] ?? null },
  _text: text, clone() { return { ...this, clone: this.clone }; },
});

async function dispatch(scope, request) {
  let responded;
  // waitUntil is RECORDED, not swallowed. The previous version of this mock
  // defined it as a no-op, and that is why this check could pass while the
  // real worker was free to be terminated mid-revalidation: in Node an
  // unheld promise still runs, so the mock was strictly more forgiving than
  // the browser it was standing in for.
  const held = [];
  const event = {
    request,
    respondWith: (p) => { responded = p; },
    waitUntil: (p) => held.push(p),
  };
  scope.__held = held;
  scope.__listeners.fetch(event);
  return responded === undefined ? "PASSED_THROUGH" : await responded;
}

const req = (url, mode = "cors", method = "GET") => ({ url, mode, method });

console.log("Service worker behaviour checks\n");

// 1. A cached asset is still served instantly (speed + offline preserved).
{
  const seed = { "https://app.test/js/views/buyer.js": body("OLD", { headers: { etag: '"aaa"' } }) };
  const scope = makeScope({ cacheSeed: seed, network: async () => body("NEW", { headers: { etag: '"bbb"' } }) });
  const res = await dispatch(scope, req("https://app.test/js/views/buyer.js"));
  ok("cached asset is served immediately (offline/speed preserved)", res._text === "OLD");

  // 2. ...but the cache is refreshed in the background, so the NEXT load is current.
  for (let i = 0; i < 12; i++) await tick();
  const after = scope.caches._store.get("https://app.test/js/views/buyer.js");
  ok("cache is revalidated in the background (next load gets the fix)",
     after && after._text === "NEW",
     after ? `cache still holds "${after._text}"` : "nothing in cache");

  // The whole point of the 19 Aug change: refreshing the cache silently is
  // what let someone run a build four commits old for days without knowing.
  ok("and the open page is TOLD the app moved on",
     scope.clients._posted.some((m) => m.type === "app-updated"),
     `posted: ${JSON.stringify(scope.clients._posted)}`);
}

// 2b. An unchanged file must NOT cry wolf. A reload bar that appears on every
// load is a reload bar people learn to ignore.
{
  const same = { headers: { etag: '"same"' } };
  const seed = { "https://app.test/js/views/buyer.js": body("SAME", same) };
  const scope = makeScope({ cacheSeed: seed, network: async () => body("SAME", same) });
  await dispatch(scope, req("https://app.test/js/views/buyer.js"));
  for (let i = 0; i < 12; i++) await tick();
  ok("an unchanged file does not announce an update",
     !scope.clients._posted.some((m) => m.type === "app-updated"),
     `posted: ${JSON.stringify(scope.clients._posted)}`);
}

// 3. A first-visit asset (nothing cached) comes from the network.
{
  const scope = makeScope({ cacheSeed: {}, network: async () => body("FRESH") });
  const res = await dispatch(scope, req("https://app.test/js/lib/utils.js"));
  ok("uncached asset falls through to the network", res._text === "FRESH");
}

// 4. Supabase traffic is never intercepted — orders/auth must never be cached.
{
  const scope = makeScope({ cacheSeed: {}, network: async () => body("DATA") });
  const res = await dispatch(scope, req("https://xyz.supabase.co/rest/v1/v2_orders"));
  ok("Supabase requests are never intercepted", res === "PASSED_THROUGH");
}

// 5. Navigations stay network-first.
{
  // NOTE: the worker stores the shell with cache.put("/index.html", ...),
  // i.e. under the PATH, not the absolute URL -- seed it the same way or
  // the mock lies about a fallback that works fine in a real browser.
  const scope = makeScope({ cacheSeed: { "/index.html": body("OLD SHELL") },
                            network: async () => body("NEW SHELL") });
  const res = await dispatch(scope, req("https://app.test/", "navigate"));
  ok("navigation is network-first", res._text === "NEW SHELL");
}

// 6. Offline navigation falls back to the cached shell.
{
  const scope = makeScope({ cacheSeed: { "/index.html": body("OLD SHELL") },
                            network: async () => { throw new Error("offline"); } });
  const res = await dispatch(scope, req("https://app.test/", "navigate"));
  ok("offline navigation falls back to the cached shell", res && res._text === "OLD SHELL");
}

// 7. Offline asset request still serves the cached copy.
{
  const scope = makeScope({ cacheSeed: { "https://app.test/css/base.css": body("CSS") },
                            network: async () => { throw new Error("offline"); } });
  const res = await dispatch(scope, req("https://app.test/css/base.css"));
  ok("offline asset request still serves from cache", res._text === "CSS");
}

// 8. A failed response must never poison the cache.
{
  const seed = { "https://app.test/js/app.js": body("GOOD") };
  const scope = makeScope({ cacheSeed: seed,
                            network: async () => body("404 PAGE", { ok: false, status: 404 }) });
  await dispatch(scope, req("https://app.test/js/app.js"));
  await tick(); await tick(); await tick();
  ok("an error response is not written into the cache",
     scope.caches._store.get("https://app.test/js/app.js")._text === "GOOD");
}

// 8b. The revalidation must be handed to waitUntil, or the browser may kill
// the worker before the cache is written.
{
  const scope = makeScope({ cacheSeed: { "https://app.test/js/app.js": body("OLD", { headers: { etag: '"1"' } }) },
                            network: async () => body("NEW", { headers: { etag: '"2"' } }) });
  await dispatch(scope, req("https://app.test/js/app.js"));
  ok("the background revalidation is held open with waitUntil",
     (scope.__held || []).length > 0,
     "nothing was passed to event.waitUntil — the write can be cancelled");
}

// 9. Non-GET requests pass straight through.
{
  const scope = makeScope({ cacheSeed: {}, network: async () => body("X") });
  const res = await dispatch(scope, req("https://app.test/anything", "cors", "POST"));
  ok("non-GET requests pass through untouched", res === "PASSED_THROUGH");
}

console.log(`\n  passed: ${pass}   failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
