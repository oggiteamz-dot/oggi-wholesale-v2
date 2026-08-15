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
const CACHE_NAME = "oggi-wholesale-v2-shell-v2";

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
        .then((response) => {
          // Only cache real successes. Caching an opaque or error
          // response would poison the cache with a broken asset that
          // then gets served instantly forever -- exactly the failure
          // mode this rewrite exists to remove.
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);

      // Cached copy now if we have one; otherwise wait for the network.
      return cached || fresh;
    })
  );
});
