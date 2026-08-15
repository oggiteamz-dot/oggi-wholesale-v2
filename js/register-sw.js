// OGGI Wholesale v2 — service worker registration
//
// Kept as its own tiny external file (not inline in index.html) because
// this build's CSP is script-src 'self' with no 'unsafe-inline' -- an
// inline <script> block would be silently blocked by the browser and
// fail exactly the installability this file exists to enable. Loaded
// as a plain, non-module script (not part of app.js's module graph) so
// a failure in the app's own code can never prevent the service worker
// from registering, and vice versa -- installability and app logic
// fail independently. See sw.js's header comment for what it does.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("[sw] registration failed", err);
    });
  });
}
