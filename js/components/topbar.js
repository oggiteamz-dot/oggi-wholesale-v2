// OGGI Wholesale v2 — top bar component
import { devAuth } from "../lib/dev-auth.js";
import { ROLE_LABEL } from "../lib/nav-config.js";
import { cart } from "../data/cart.js";

import { esc } from "../lib/utils.js";
/** Batch 13: a real cart icon + live item-count badge for the buyer role —
 * this build had no cart indicator in the topbar at all before this batch.
 * It doubles as the landing target for the "add to cart" fly animation
 * (js/lib/animations/fly-to-cart.js looks it up by this exact id), so it
 * exists on every buyer-role page, not just the cart screen itself. */
function renderCartIcon(wid) {
  const link = document.createElement("a");
  link.href = "#/buyer/cart";
  link.id = "v2-cart-icon";
  link.className = "v2-cart-icon";
  link.setAttribute("aria-label", "View cart");
  link.style.cssText = "position:relative;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:var(--radius-md);text-decoration:none;font-size:18px;";
  link.textContent = "🧺";

  function refreshBadge() {
    const qty = cart.count(wid);
    let badge = link.querySelector(".v2-cart-badge");
    if (qty > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "v2-cart-badge";
        link.appendChild(badge);
      }
      badge.textContent = qty > 99 ? "99+" : String(qty);
    } else if (badge) {
      badge.remove();
    }
  }
  refreshBadge();
  document.addEventListener("v2:cart-changed", refreshBadge);
  return link;
}

export function renderTopbar(container, { onLogout } = {}) {
  const session = devAuth.getSession();
  container.innerHTML = "";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.innerHTML = `
    <span class="brand-mark">O</span>
    <span>OGGI Wholesale</span>
    <span class="env-tag">v2 · dev</span>
  `;

  const right = document.createElement("div");
  right.className = "topbar-right";

  if (session) {
    if (session.role === "buyer") {
      right.appendChild(renderCartIcon(session.wid));
    }

    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = `<span>${ROLE_LABEL[session.role] || session.role}</span> · <strong>${esc(session.wholesalerName || session.wid)}</strong>`;
    right.appendChild(who);

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "btn btn-ghost btn-sm";
    logoutBtn.textContent = "Switch role";
    logoutBtn.addEventListener("click", () => {
      devAuth.logout();
      if (onLogout) onLogout();
    });
    right.appendChild(logoutBtn);
  }

  container.appendChild(brand);
  container.appendChild(right);
}

