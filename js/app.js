// OGGI Wholesale v2 — app entry point
// Wires dev-auth -> router -> role-scoped views -> shell chrome (topbar/nav).
// No build step: this is loaded directly as <script type="module"> from
// index.html. Keep this file thin — it should only ever compose the pieces
// in js/lib, js/components, js/views, never contain view logic itself.

import { devAuth } from "./lib/dev-auth.js";
import { router } from "./lib/router.js";
import { renderTopbar } from "./components/topbar.js";
import { renderSidenav } from "./components/sidenav.js";
import { renderBottomNav } from "./components/bottomnav.js";
import { renderLogin } from "./views/login.js";
import { registerOwnerRoutes } from "./views/owner.js";
import { registerWholesalerRoutes } from "./views/wholesaler.js";
import { registerSalespersonRoutes } from "./views/salesperson.js";
import { registerBuyerRoutes } from "./views/buyer.js";
import { registerMobileOpsRoutes } from "./views/mobile-ops.js";
import { registerImportRoutes } from "./views/import-catalog.js";
import { registerIntegrationsRoutes } from "./views/integrations.js";

const root = document.getElementById("app-root");

function mountShell() {
  const session = devAuth.getSession();
  root.innerHTML = "";

  // A session with role === null means bootstrap() found a real,
  // signed-in Supabase Auth identity that hasn't redeemed an invite yet
  // (see dev-auth.js) -- not a usable app session, so this still goes to
  // the login screen (which recognizes that shape and jumps straight to
  // the "enter your invite code" step instead of the sign-in form).
  if (!session || !session.role) {
    const outlet = document.createElement("div");
    root.appendChild(outlet);
    renderLogin(outlet, () => mountShell());
    return;
  }

  root.innerHTML = `
    <header id="topbar"></header>
    <div id="app-body">
      <nav id="sidenav" aria-label="Primary"></nav>
      <main id="view-outlet"></main>
    </div>
    <nav id="bottomnav"></nav>
  `;

  renderTopbar(document.getElementById("topbar"), { onLogout: () => mountShell() });
  renderSidenav(document.getElementById("sidenav"), session.role);
  // Mobile navigation. Rendered ALWAYS, alongside the sidebar -- CSS decides
  // which is visible, so rotating a phone or resizing a window needs no JS.
  renderBottomNav(document.getElementById("bottomnav"), session.role);

  // Register all role routes once per shell mount. Registering is cheap
  // and idempotent-enough for a hash router with a fresh `routes` array
  // per module load; app.js only mounts the shell once per session change.
  registerOwnerRoutes(router);
  registerWholesalerRoutes(router);
  registerSalespersonRoutes(router);
  registerBuyerRoutes(router);
  registerMobileOpsRoutes(router);
  registerImportRoutes(router);
  registerIntegrationsRoutes(router);
  router.notFound((outlet) => {
    outlet.innerHTML = `<div class="empty-state card"><h4>Page not found</h4><p>That route doesn't exist in v2 yet.</p></div>`;
  });

  const outlet = document.getElementById("view-outlet");

  // If the hash doesn't resolve to a real route, send them home.
  //
  // This comment was already here and was already right. The CODE underneath
  // it was not: it only checked for an empty hash or "#/", so the commonest
  // case of all fell straight through. Signing in leaves the hash at
  // "#/login"; that is neither empty nor "#/", no route is registered for it,
  // and the router did exactly what it was told and rendered the not-found
  // page. Every user's first sight after typing their password was "Page not
  // found. That route doesn't exist in v2 yet." -- with a working navigation
  // bar underneath it, so it looked like the app had half-loaded.
  //
  // Now it asks the router whether the path resolves, rather than trying to
  // enumerate the paths that do not. Enumerating is what produced the bug:
  // "#/login" simply was not on the list, and neither is "#/owner" when a
  // BUYER lands on it from a stale bookmark, which had the same outcome.
  //
  // Decided BEFORE router.init(), not after. Redirecting afterwards works, but
  // init() resolves immediately, so the not-found page renders for one frame
  // and is then replaced -- a visible flash of "Page not found" on every
  // single sign-in. Setting the hash first means the first resolve is already
  // the right route.
  const homeByRole = { owner: "/owner", wholesaler: "/wholesaler", sales: "/sales", buyer: "/buyer" };
  if (!router.matches(router.currentPath())) {
    const home = homeByRole[session.role] || "/";
    // Assign the hash directly rather than via router.go(): nothing is
    // listening for hashchange yet (init() attaches that listener), so go()
    // would set the hash and no resolve would follow. init() below does it.
    window.location.hash = home;
  }

  router.init(outlet);
}

// Batch 14: session resolution is now async (a real Supabase Auth
// session needs a lookup against v2_user_profiles before we know the
// role/wid) -- bootstrap() is awaited exactly once here, before the
// first render, so every other call site's synchronous
// `devAuth.getSession()` contract stays true the moment mountShell()
// ever runs. A brief "Loading…" placeholder covers the one real network
// round trip this adds to page load.
root.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:13px;">Loading…</div>`;
devAuth.bootstrap().then(mountShell);
