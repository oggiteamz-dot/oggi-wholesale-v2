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

export const router = {
  init(outletEl) {
    outlet = outletEl;
    window.addEventListener("hashchange", () => this._resolve());
    this._resolve();
  },

  register(pattern, render) {
    routes.push({ pattern, render, ...compile(pattern) });
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

  async _resolve() {
    const path = this.currentPath();
    for (const r of routes) {
      const m = path.match(r.regex);
      if (m) {
        const params = {};
        r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
        outlet.innerHTML = "";
        await r.render(outlet, params);
        document.dispatchEvent(new CustomEvent("v2:navigated", { detail: { path, params } }));
        return;
      }
    }
    if (notFoundHandler) {
      outlet.innerHTML = "";
      await notFoundHandler(outlet);
    }
  },
};
