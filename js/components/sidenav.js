// OGGI Wholesale v2 — side navigation component
import { NAV_BY_ROLE } from "../lib/nav-config.js";
import { router } from "../lib/router.js";

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
    a.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
    container.appendChild(a);
  });

  function highlightActive() {
    const current = router.currentPath();
    container.querySelectorAll("a.nav-item").forEach((a) => {
      const path = a.getAttribute("href").slice(1);
      const isActive = path === current || (path !== "" && current.startsWith(path) && path !== "/");
      const isRootMatch = path === `/${role}` && current === `/${role}`;
      a.classList.toggle("active", isActive || isRootMatch);
    });
  }

  highlightActive();
  document.addEventListener("v2:navigated", highlightActive);
}
