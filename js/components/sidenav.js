// OGGI Wholesale v2 — side navigation component
import { NAV_BY_ROLE } from "../lib/nav-config.js";
import { router } from "../lib/router.js";
import { navIcon } from "../lib/icons.js";

export function renderSidenav(container, role) {
  const items = NAV_BY_ROLE[role] || [];
  container.innerHTML = "";

  const label = document.createElement("div");
  label.className = "nav-section-label";
  label.textContent = "Navigate";
  container.appendChild(label);

  items.forEach((item) => {
    const a = document.createElement("a");
    a.className = "nav-item";
    a.href = `#${item.path}`;
    // The drawn icon when there is one, the config's emoji when there is not.
    // A new nav entry therefore still renders something rather than a blank
    // square, and js/lib/nav-config.js -- which check_nav_completeness.mjs
    // reads -- did not have to be edited to change how the nav looks.
    const icon = navIcon(item.path) || item.icon;
    a.innerHTML = `<span class="nav-icon">${icon}</span><span>${item.label}</span>`;
    container.appendChild(a);
  });

  function highlightActive() {
    const current = router.currentPath();

    // LONGEST MATCH WINS, AND ONLY ONE ITEM IS EVER ACTIVE.
    //
    // The old test was `current.startsWith(path)`, which is true for more than
    // one item whenever a role's root is a prefix of its other routes -- and
    // every role is built that way. On /buyer/market, "/buyer" also matched, so
    // MARKETPLACE and CATALOG were both lit on every buyer screen; the same
    // went for /wholesaler and /sales. The one job of this highlight is to say
    // where you are, and it was naming two places at once.
    //
    // A prefix also has to end at a segment boundary: "/buyer" must not match
    // "/buyers", and only "/buyer/cart" style children count.
    let best = null, bestLen = -1;
    container.querySelectorAll("a.nav-item").forEach((a) => {
      const path = a.getAttribute("href").slice(1);
      if (!path || path === "/") return;
      const hit = current === path || current.startsWith(path + "/");
      if (hit && path.length > bestLen) { best = a; bestLen = path.length; }
    });
    container.querySelectorAll("a.nav-item").forEach((a) => {
      a.classList.toggle("active", a === best);
      // Tell a screen reader too. A visual-only "you are here" is half a
      // feature, and aria-current is one attribute.
      if (a === best) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  highlightActive();
  document.addEventListener("v2:navigated", highlightActive);
}
