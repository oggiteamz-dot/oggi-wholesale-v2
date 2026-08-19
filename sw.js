// OGGI Wholesale v2 — service worker
//
// Scope: makes the app installable (a manifest alone is not enough —
// Chrome/Android require an active service worker before it will offer
// an install prompt, and Bubblewrap's TWA build requires the same) and
// caches the static app shell so the UI itself loads instantly and
// works offline. Deliberately does NOT cache anything from Supabase —
// this app's actual data (products, orders, inventory, auth) must
// always be live and correct, never served stale from a cache. Caching
// only the shell (HTML/CSS/JS/icons) and always going to the network
// for supabase.co requests keeps "offline" honest: you can open the
// app with no signal, but you can't place an order until you have one.
//
// ---------------------------------------------------------------------
// WHY THIS FILE CHANGED — 15 Aug 2026
// ---------------------------------------------------------------------
// The previous version served static assets cache-first and NEVER
// revalidated them:
//
//     caches.match(request).then(cached => { if (cached) return cached; ... })
//
// Once a JS or CSS file entered the cache it was served forever, and the
// only way to dislodge it was to hand-bump CACHE_NAME. The old header
// comment said so plainly: "the one piece of manual upkeep a
// static-shell service worker needs."
//
// That is a correctness guarantee resting on a human remembering, which
// is the same failure class as a helper function copy-pasted into ten
// files. It had already bitten: the escaping fix deployed on 15 Aug did
// not reach any already-installed client, and a verification pass run
// against the LIVE site reported the deploy had failed — because the
// service worker handed back cached copies of the old files.
//
// A deploy that cannot reach the people already using the app is not a
// deploy. Worse, it fails silently and looks fine to anyone testing in a
// fresh browser.
//
// THE FIX: stale-while-revalidate for static assets. Serve the cached
// copy immediately (so loads stay instant and offline still works), but
// ALWAYS fetch a fresh copy in the background and overwrite the cache.
// The user gets the new code on their next load, automatically, with no
// version bump and nothing to remember.
//
// CACHE_NAME is still bumped here — once — so every client that already
// holds the stale August shell drops it on activation rather than
// waiting one extra load. From here on the bump is a convenience, not a
// correctness requirement. That is the point of the change: if someone
// forgets it, users still converge on the current code.
//
// TRADE-OFF, STATED HONESTLY: a returning user can be one load behind on
// static assets. That is a deliberate exchange — instant loads and real
// offline support, against a single load of lag — and it is strictly
// better than the previous behaviour, which was an unbounded number of
// loads behind. Anything needing immediate correctness (orders,
// inventory, auth, pricing) never touches this cache: it is Supabase
// traffic, excluded below.
// ---------------------------------------------------------------------
// WHY THIS FILE CHANGED AGAIN — 19 Aug 2026
// ---------------------------------------------------------------------
// The stale-while-revalidate above works. What it cannot do is tell
// anyone, and that turned out to be the part that mattered.
//
// This app is a single-page app. Moving between Inventory, Products and
// Catalogs only changes the URL hash, so the page never loads again. A
// person who leaves the tab open -- which is what you do with the tool
// you run your business on -- can go days without a single navigation,
// and SWR only revalidates on a fetch. Their app keeps working
// perfectly, from code that is weeks old, and nothing anywhere says so.
//
// That happened. On 19 Aug a build was deployed, verified byte-for-byte
// against the live URL, and reported as live -- and it was. The person
// using it was still looking at a build four commits older, and we spent
// a round trip talking past each other about a feature that was on his
// screen in one version and not the other. He had no way to know. Nor
// did I: "the server serves the new file" and "the user is running the
// new file" are different claims, and only the first was ever checked.
//
// Two changes:
//
//   1. event.waitUntil() around the revalidation. Without it the browser
//      may terminate the worker the instant respondWith settles, killing
//      the in-flight cache write. It usually wins that race, which is
//      the worst kind of bug -- one that works until it matters.
//
//   2. The worker now COMPARES what it fetched with what it had (by
//      ETag) and posts a message to every open page when they differ.
//      The page turns that into a "new version -- reload" bar. A tab
//      that has been open for a week can also ask, via a
//      "check-for-update" message, and the worker re-validates
//      everything it holds and answers honestly.
//
// The cache name is bumped once more so any client still holding the
// August shell -- including the one this was found on -- drops it on
// activation rather than carrying it forward.
const CACHE_NAME = "oggi-wholesale-v2-shell-v3";

/** Tell every open page that the code on the server has moved on. */
async function announceUpdate(url) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: "app-updated", url }));
}

/** Have these two responses for the same URL got different code in them?
 *
 *  ETag first: it is what Cloudflare sends, it is what must-revalidate is
 *  built on, and it costs nothing to compare. Then content-length.
 *
 *  Then, if the server offers NEITHER validator, the bodies themselves --
 *  because the alternative is returning false and silently never announcing
 *  anything, which is the exact failure this whole mechanism exists to end.
 *  A guarantee that quietly depends on a response header is not a guarantee;
 *  it is the header's behaviour wearing a guarantee's name. Reading two small
 *  text bodies on a path that only runs when a file was refetched anyway is a
 *  cheap price for the check not being a lie on some future host.
 */
async function changed(cached, fresh) {
  if (!cached || !fresh) return false;
  const a = cached.headers.get("etag"), b = fresh.headers.get("etag");
  if (a && b) return a !== b;
  const la = cached.headers.get("content-length"), lb = fresh.headers.get("content-length");
  if (la && lb) return la !== lb;
  try {
    const [x, y] = await Promise.all([cached.clone().text(), fresh.clone().text()]);
    return x !== y;
  } catch {
    return false;
  }
}

const SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/tokens.css",
  "/css/base.css",
  "/css/components.css",
  "/css/layout.css",
  "/css/animations.css",
  "/js/app.js",
  "/js/lib/vendor/supabase-js.umd.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept Supabase traffic (data, auth, storage, realtime,
  // edge functions) -- always go straight to the network. This is the
  // most important line in this file: caching an RPC or auth response
  // would silently serve stale or wrong data.
  if (url.hostname.endsWith("supabase.co")) return;

  // Only handle same-origin GETs; let everything else (cross-origin,
  // non-GET) pass through untouched.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigations (loading index.html itself): network-first, so a
  // redeploy is picked up immediately on the next load if there's a
  // connection, with the cached shell as the offline fallback only.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static shell assets (css/js/icons): STALE-WHILE-REVALIDATE.
  //
  // Return the cached copy at once if there is one, so the app still
  // loads instantly and still works with no signal. Regardless, kick off
  // a network fetch and write the result back into the cache, so the
  // NEXT load gets the current file. No manual version bump involved.
  //
  // If the cache is empty (first visit, or a file added since the shell
  // list was last edited) we simply wait on the network fetch, which is
  // the same behaviour as before.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request)
        .then(async (response) => {
          // Only cache real successes. Caching an opaque or error
          // response would poison the cache with a broken asset that
          // then gets served instantly forever -- exactly the failure
          // mode this rewrite exists to remove.
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            if (await changed(cached, response)) await announceUpdate(event.request.url);
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, copy);
          }
          return response;
        })
        .catch(() => cached);

      // waitUntil, not fire-and-forget. Once respondWith settles the
      // browser is entitled to shut this worker down, and an unawaited
      // fetch/cache.put dies with it. On a fast connection it usually
      // finishes first, which is precisely why its absence survived two
      // rewrites of this file.
      event.waitUntil(fresh);

      // Cached copy now if we have one; otherwise wait for the network.
      return cached || fresh;
    })
  );
});

// A page that has been open for days never fetches anything, so the
// revalidation above never runs and the tab has no way to discover that
// it is behind. It can ask instead: the worker re-validates everything it
// is holding and replies honestly either way. Nothing is hardcoded here --
// the cache already knows exactly which files this build consists of.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "check-for-update") return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let stale = null;
    await Promise.all(keys.map(async (request) => {
      try {
        const cached = await cache.match(request);
        const fresh = await fetch(request, { cache: "reload" });
        if (!fresh || !fresh.ok || fresh.type !== "basic") return;
        if (await changed(cached, fresh)) stale = stale || request.url;
        await cache.put(request, fresh.clone());
      } catch { /* offline: nothing to report, keep what we have */ }
    }));
    const source = event.source;
    if (source) source.postMessage(stale ? { type: "app-updated", url: stale } : { type: "app-current" });
  })());
});
