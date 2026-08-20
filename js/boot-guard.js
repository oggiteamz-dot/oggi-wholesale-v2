// OGGI Wholesale v2 — boot guard
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------
// Hadi, 20 Aug 2026: "Don't let the website completely go down for five,
// ten, fifteen minutes... it should go down for seconds. The second you
// apply, boom, it's back. I don't want it to go down through the entire
// maintenance phase."
//
// What actually happened that day: js/views/wholesaler.js was pushed to
// main while js/data/client-bans.js -- a module it imports -- was still
// missing from the repo. Every push to main auto-deploys, so Cloudflare
// faithfully published a build whose module graph could not resolve. ONE
// failed import kills the ENTIRE graph: no error on screen, no partial
// render, just a white page. Then the service worker cached that white
// page and kept serving it even after the fix landed, so the outage
// outlived its own cause.
//
// Three separate things had to be fixed, and this file is one of them:
//
//   1. checks/check_imports_resolve.sh  -- stops a broken graph ever
//      being pushed. Prevention.
//   2. The atomic branch-then-merge push protocol -- stops main from
//      ever holding a half-finished change. Prevention.
//   3. THIS FILE -- assumes 1 and 2 will one day both fail anyway, and
//      makes the failure self-heal in seconds instead of lasting until
//      a human notices. Recovery.
//
// Prevention that has no recovery behind it is a promise, not a
// guarantee.
//
// HOW IT WORKS
// ---------------------------------------------------------------------
// It watches for the one symptom that covers every cause: the app root
// is still empty a few seconds after load. It does not try to diagnose
// why. A failed import, a syntax error in a new file, a half-deployed
// bundle, a poisoned cache -- all of them look identical from here, and
// all of them have the same cure: throw away the cached copy and try
// once more against the network.
//
// It reloads AT MOST ONCE per tab session. A self-healer that can loop
// is worse than the bug -- it turns one white screen into an infinite
// refresh that also burns the user's data. The sessionStorage latch is
// the whole safety argument.
//
// NOT AN INLINE SCRIPT, DELIBERATELY: index.html sends
// `script-src 'self'` with no 'unsafe-inline'. An inline <script> here
// would be silently blocked by our own CSP -- the guard would look
// present in the HTML and never run, which is the worst of both worlds.
(function () {
  "use strict";

  var GRACE_MS   = 7000;          // generous: slow phone, cold cache, big bundle
  var LATCH      = "oggi-boot-selfheal";
  var ROOT_ID    = "app-root";

  function rootIsEmpty() {
    var root = document.getElementById(ROOT_ID);
    // No root at all is also a failure -- index.html is malformed or
    // was replaced by something that isn't our app.
    if (!root) return true;
    return root.children.length === 0;
  }

  // Boot succeeded: drop the latch so a genuine failure WEEKS later is
  // still allowed its one free retry. Without this, a single self-heal
  // would permanently spend the tab's only attempt.
  function bootSucceeded() {
    try { sessionStorage.removeItem(LATCH); } catch (e) {}
  }

  function alreadyTried() {
    try { return sessionStorage.getItem(LATCH) === "1"; } catch (e) { return false; }
  }

  function latch() {
    try { sessionStorage.setItem(LATCH, "1"); } catch (e) {}
  }

  // Throw away everything a stale deploy could be hiding in, then reload.
  // Order matters: unregister the worker FIRST, so it cannot re-serve a
  // cached response to the reload we are about to trigger.
  function purgeAndReload() {
    latch();
    var done = function () {
      // cache:'reload' semantics -- bypass the HTTP cache too, not just
      // the service worker's.
      location.reload();
    };

    var jobs = [];

    if ("serviceWorker" in navigator) {
      jobs.push(
        navigator.serviceWorker.getRegistrations()
          .then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })
          .catch(function () {})
      );
    }
    if (window.caches && caches.keys) {
      jobs.push(
        caches.keys()
          .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
          .catch(function () {})
      );
    }

    // Never let a hanging promise strand the user on the white screen the
    // guard exists to escape -- reload regardless after 2s.
    var raced = false;
    var go = function () { if (!raced) { raced = true; done(); } };
    Promise.all(jobs).then(go).catch(go);
    setTimeout(go, 2000);
  }

  // Second failure in the same tab: stop reloading and SAY something.
  // A white screen tells the user nothing; this at least tells them the
  // truth and gives them the one button that might help.
  function showFailure() {
    var root = document.getElementById(ROOT_ID) || document.body;
    root.innerHTML =
      '<div style="max-width:420px;margin:14vh auto;padding:0 24px;text-align:center;' +
      'font-family:-apple-system,\'Segoe UI\',sans-serif;color:#2E2C27;">' +
      '<div style="font-size:34px;line-height:1;margin-bottom:12px;">⚠️</div>' +
      '<div style="font-size:17px;font-weight:700;margin-bottom:8px;">OGGI could not start</div>' +
      '<div style="font-size:13px;color:#6B6A63;line-height:1.5;margin-bottom:18px;">' +
      'We cleared the saved copy and tried again, and it still would not load. ' +
      'This is usually a release that is still going out — it normally clears within a minute.' +
      '</div>' +
      '<button id="oggi-retry" style="background:#00845F;color:#fff;border:0;border-radius:8px;' +
      'padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;">Try again</button>' +
      '</div>';
    var b = document.getElementById("oggi-retry");
    if (b) b.addEventListener("click", function () {
      try { sessionStorage.removeItem(LATCH); } catch (e) {}
      location.reload();
    });
  }

  function check() {
    if (!rootIsEmpty()) { bootSucceeded(); return; }
    if (alreadyTried()) { showFailure(); return; }
    purgeAndReload();
  }

  // A module that fails to load fires an error event on window with the
  // <script> as the target. That is a faster, more certain signal than
  // waiting out the full grace period, so act on it immediately -- but
  // still go through the same latch, so it cannot loop either.
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t.tagName === "SCRIPT" && t.src) {
      setTimeout(check, 300);
    }
  }, true);

  if (document.readyState === "complete") {
    setTimeout(check, GRACE_MS);
  } else {
    window.addEventListener("load", function () { setTimeout(check, GRACE_MS); });
  }
})();
