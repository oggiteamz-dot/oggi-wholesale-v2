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
// CACHE_NAME is version-stamped by hand -- bump it on every deploy that
// changes any cached file, so returning visitors get the new shell
// instead of a stale one stuck in the cache forever. This is the one
// piece of manual upkeep a static-shell service worker needs.
const CACHE_NAME = "oggi-wholesale-v2-shell-v1";

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

  // Static shell assets (css/js/icons): cache-first for instant loads,
  // falling back to network for anything not pre-cached (e.g. a css/js
  // file added after this list was last updated).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
