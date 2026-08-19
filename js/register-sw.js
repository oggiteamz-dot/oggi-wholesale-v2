// OGGI Wholesale v2 — service worker registration, and the update bar
//
// Kept as its own tiny external file (not inline in index.html) because
// this build's CSP is script-src 'self' with no 'unsafe-inline' -- an
// inline <script> block would be silently blocked by the browser and
// fail exactly the installability this file exists to enable. Loaded
// as a plain, non-module script (not part of app.js's module graph) so
// a failure in the app's own code can never prevent the service worker
// from registering, and vice versa -- installability and app logic
// fail independently. See sw.js's header comment for what it does.
//
// ---------------------------------------------------------------------
// THE UPDATE BAR — 19 Aug 2026
// ---------------------------------------------------------------------
// This is a single-page app: switching between Inventory, Products and
// Catalogs only changes the URL hash, so the page itself never loads
// again. Someone who leaves the tab open -- which is what you do with
// the tool you run your business on -- can go for days without a real
// navigation, running code from whenever they last hard-loaded it,
// while every deploy since lands on the server unnoticed.
//
// That is not hypothetical. It cost a whole round trip on 19 Aug: a
// build was deployed, verified byte-for-byte against the live URL, and
// correctly reported as live -- and the person using it was looking at
// a build four commits older and reasonably concluded the work was
// wrong rather than invisible.
//
// So the app now says so. sw.js posts a message when it notices the
// server has moved on; this puts a bar on screen with a Reload button.
// It never reloads on its own: doing that under someone mid-order would
// trade a visible problem for a much worse invisible one.
(function () {
  if (!("serviceWorker" in navigator)) return;

  var barShown = false;

  function showUpdateBar() {
    if (barShown) return;
    barShown = true;

    var bar = document.createElement("div");
    bar.className = "app-update-bar";
    bar.setAttribute("role", "status");

    var text = document.createElement("span");
    text.textContent = "A newer version of OGGI is ready.";
    bar.appendChild(text);

    var reload = document.createElement("button");
    reload.type = "button";
    reload.className = "app-update-reload";
    reload.textContent = "Reload";
    reload.addEventListener("click", function () { location.reload(); });
    bar.appendChild(reload);

    // Dismissible, because "reload now" is not always the right answer --
    // a half-filled product form is worth more than being current.
    var later = document.createElement("button");
    later.type = "button";
    later.className = "app-update-later";
    later.setAttribute("aria-label", "Dismiss");
    later.textContent = "Later";
    later.addEventListener("click", function () { bar.remove(); });
    bar.appendChild(later);

    document.body.appendChild(bar);
  }

  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "app-updated") showUpdateBar();
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.error("[sw] registration failed", err);
    });

    // A long-open tab fetches nothing, so the worker's own revalidation
    // never runs and the tab cannot discover it is behind. Ask on the way
    // back in. Throttled, because coming back to a tab twenty times an
    // hour should not mean twenty full revalidations of the shell.
    var lastAsk = 0;
    function askIfStale() {
      if (document.visibilityState !== "visible") return;
      var now = Date.now();
      if (now - lastAsk < 10 * 60 * 1000) return;
      lastAsk = now;
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "check-for-update" });
      }
      // Separately, see whether sw.js ITSELF changed. The message above
      // covers app code; this covers a change to the caching rules.
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) reg.update();
      }).catch(function () {});
    }
    document.addEventListener("visibilitychange", askIfStale);
    setTimeout(askIfStale, 5000);
  });
})();
