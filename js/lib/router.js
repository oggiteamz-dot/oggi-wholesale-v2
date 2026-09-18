// OGGI Wholesale v2 — minimal hash router
//
// Deliberately tiny and dependency-free (no build step, per Batch 0 goal of
// a scaffold Hadi can open and test immediately). Routes are registered as
// { pattern, render } where pattern is a leading-colon path like
// "/buyer/orders/:id". Re-render happens on hashchange and on manual
// router.go() calls (so views can navigate programmatically after actions).

const routes = [];
let notFoundHandler = null;
let outlet = null;

function compile(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^/${regexStr}/?$`), paramNames };
}

// Increments on every navigation. A render that started under an older
// generation has been superseded and must not touch the outlet again.
let generation = 0;
let listening = false;

export const router = {
  init(outletEl) {
    outlet = outletEl;
    // ONCE. init() is called from mountShell(), and mountShell() runs again on
    // every sign-in, sign-out and role switch. Each call used to add ANOTHER
    // hashchange listener, so after signing in, one navigation fired _resolve()
    // twice; after switching role, three times. See the generation guard below
    // for what that actually did to the screen.
    if (!listening) {
      window.addEventListener("hashchange", () => this._resolve());
      listening = true;
    }
    this._resolve();
  },

  register(pattern, render) {
    // REPLACE, don't accumulate. registerXRoutes() is called once per shell
    // mount by design ("registering is cheap"), but `routes` is module-level
    // and was never cleared, so the array grew by ~60 entries every time
    // anyone signed in. _resolve() returns on the first match so the duplicates
    // were harmless to correctness -- they were a slow leak, and they made the
    // array a misleading thing to read while debugging the bug above.
    const at = routes.findIndex((r) => r.pattern === pattern);
    const entry = { pattern, render, ...compile(pattern) };
    if (at >= 0) routes[at] = entry; else routes.push(entry);
    return this;
  },

  notFound(render) {
    notFoundHandler = render;
    return this;
  },

  go(path) {
    window.location.hash = path.startsWith("#") ? path : `#${path}`;
  },

  currentPath() {
    const hash = window.location.hash || "#/";
    return hash.slice(1) || "/";
  },

  /**
   * Does a path resolve to a registered route?
   *
   * Added 18 Aug 2026 because app.js needed to ask this question and could
   * not, so it guessed instead -- it checked only for an EMPTY hash and
   * therefore missed the single most common case: signing in while the hash
   * still reads "#/login". The shell mounted correctly, the router found no
   * route for "/login", and the first thing every new user saw after entering
   * their password was "Page not found".
   *
   * Uses the same `routes` array and the same compiled regexes as _resolve(),
   * so it cannot disagree with what _resolve() will actually do -- which a
   * hand-maintained list of "known paths" in app.js certainly would.
   */
  matches(path) {
    return routes.some((r) => path.match(r.regex));
  },

  /**
   * ⚠️ THE CONCURRENCY GUARD — read this before simplifying it.
   *
   * View functions are async and they APPEND as they go: header first, then a
   * round trip, then the rows. `outlet.innerHTML = ""` at the top only clears
   * what is there at that instant, so two _resolve() runs overlapping on the
   * same outlet interleave -- the second clears the screen while the first is
   * still awaiting its data, and the first then appends its rows on top of the
   * second's. The result is a screen with everything on it TWICE.
   *
   * That is exactly what the warehouse desk showed on 18 Sep 2026: three stat
   * cards and an empty state, then the same three stat cards and the same
   * empty state again. It was reachable at all for the first time that day,
   * which is why nobody had seen it.
   *
   * The duplicate listener in init() is what made two runs overlap; fixing that
   * removes today's cause. This guard removes the CLASS: any render that has
   * been superseded stops touching the outlet, whatever started it -- a fast
   * double-tap on a nav item is enough.
   */
  async _resolve() {
    const path = this.currentPath();
    const mine = ++generation;
    for (const r of routes) {
      const m = path.match(r.regex);
      if (m) {
        const params = {};
        r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
        // EACH RENDER GETS ITS OWN CONTAINER.
        // Checking the generation only AFTER the render is too late: by then a
        // superseded view has already appended its header, its stat strip and
        // its rows into the shared outlet, on top of whatever the newer render
        // put there. Giving every render its own host means an abandoned one
        // takes its DOM with it when it goes.
        //
        // `display: contents` so the wrapper is invisible to layout -- the
        // view's own children remain the outlet's layout children, and no
        // existing grid, flex or :first-child rule can tell the difference.
        outlet.innerHTML = "";
        const host = document.createElement("div");
        host.style.display = "contents";
        host.setAttribute("data-render", String(mine));
        outlet.appendChild(host);

        // ANNOUNCE THE NAVIGATION BEFORE THE RENDER, NOT AFTER.     19 Sep 2026
        //
        // This line used to sit below the await. Everything that listens for it
        // -- the sidebar highlight, the bottom bar, the drawer that closes when
        // you leave a screen -- therefore waited for the SCREEN to finish
        // before it would admit you had moved. On /wholesaler/inventory, which
        // waits on four reads and takes six to ten seconds on a real
        // catalogue, the sidebar went on pointing at the screen you had just
        // left for the whole of it: you clicked Inventory, Inventory began
        // loading, and the sidebar still said Team & Buyers.
        //
        // And when a render THREW, the event never fired at all, so the
        // highlight was stuck on the previous screen until the next successful
        // navigation. A "you are here" that names somewhere else is worse than
        // none, because it is believed.
        //
        // Nothing here depends on the render: the path is already decided, and
        // it is the URL these listeners are reading. A superseded render is
        // still correct, because the newer navigation dispatches its own event
        // afterwards and the last one wins.
        document.dispatchEvent(new CustomEvent("v2:navigated", { detail: { path, params } }));

        await r.render(host, params);
        if (mine !== generation) { host.remove(); return; }   // superseded
        return;
      }
    }
    if (notFoundHandler) {
      outlet.innerHTML = "";
      await notFoundHandler(outlet);
    }
  },
};
