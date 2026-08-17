// =============================================================================
// OGGI Wholesale v2 — BOTTOM NAVIGATION (mobile)
// =============================================================================
//
// THE PROBLEM THIS SOLVES
// -----------------------
// `css/layout.css` hides #sidenav below 880px and, until this file existed,
// nothing replaced it. On a phone every role -- owner, wholesaler, rep, buyer
// -- had NO navigation at all. Twenty-eight destinations existed, worked, and
// could not be opened by tapping. You could only move around by typing a
// "#/..." URL by hand.
//
// WHY A BOTTOM BAR RATHER THAN A HAMBURGER
// ----------------------------------------
// Measured, not preference. Nielsen Norman Group tested 179 participants
// across three navigation conditions:
//   - navigation actually used, on mobile:  57% hidden  vs  86% combo
//   - content discoverability:              >20% drop with hidden navigation
//   - task time on mobile:                  15% slower with hidden navigation
//   - perceived difficulty:                 +21% with hidden navigation
// Separately, ~85% of phone touches are thumb-driven (Hoober, 1,333 field
// observations), which is why the bar sits at the bottom rather than the top.
//
// The winning condition in the NN/g study was "combo" -- visible items PLUS
// a way to reach the rest. That is exactly what this is: up to four visible
// destinations and a "More" hub. It is not a hamburger, and it is not a
// five-item bar pretending the other seven screens don't exist.
//
// THE SAFETY PROPERTY THAT MATTERS
// --------------------------------
// This component NEVER lists destinations of its own. It asks
// js/lib/nav-config.js -- the same array the desktop sidebar reads -- and
// renders whatever comes back. A screen therefore cannot go missing from
// mobile while still existing on desktop: there is no separate list to forget
// to update. checks/check_nav_completeness.mjs enforces this by failing if
// this file contains any hard-coded route string.
//
// ACCESSIBILITY
// -------------
// Targets are 48px tall (WCAG 2.2 SC 2.5.8 requires 24px at AA; Apple asks
// 44pt, Material 48dp -- 48 satisfies all three). Labels are always visible:
// icon-only bars recreate the discoverability problem the bar was built to
// solve. `aria-current="page"` marks the active destination for screen
// readers, and the hub is a real modal dialog with focus handling and Escape.
//
// The bar respects `env(safe-area-inset-bottom)` -- without it, iOS Safari's
// bottom toolbar sits on top of the last row of tap targets.
// =============================================================================

import { NAV_BY_ROLE, splitNav, shortLabel } from "../lib/nav-config.js";
import { router } from "../lib/router.js";
import { esc } from "../lib/utils.js";

// Module-level handle so the hub can be closed from anywhere (route change,
// Escape key, backdrop tap) without each caller needing a reference.
let openHub = null;

/**
 * Is `itemPath` the destination currently being viewed?
 *
 * Mirrors the matching logic in components/sidenav.js deliberately. If the
 * two ever disagree, the sidebar and the bar would highlight different
 * things at the same viewport width during a resize, which reads as a bug.
 */
function isActivePath(itemPath, current, role) {
  if (!itemPath) return false;
  if (itemPath === current) return true;
  // A role's root ("/buyer") should not light up for every child route
  // ("/buyer/cart"), or every tab looks active at once.
  if (itemPath === `/${role}`) return current === `/${role}`;
  return itemPath !== "/" && current.startsWith(itemPath);
}

/**
 * The "More" hub: a full-screen sheet listing every destination that did not
 * fit in the bar, with FULL labels (the bar uses shortened ones; the hub has
 * room for the real thing).
 *
 * Full-screen rather than a small dropdown because this is the overflow for a
 * role with up to eight hidden sections -- NN/g's "navigation hub" pattern,
 * which is what suits an app whose users tend to work in one branch of the
 * hierarchy per session (a wholesaler doing a stock session, a buyer placing
 * an order).
 */
function renderMoreHub(items, role) {
  closeMoreHub(); // never stack two

  const backdrop = document.createElement("div");
  backdrop.className = "bottomnav-hub-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "More sections");

  const sheet = document.createElement("div");
  sheet.className = "bottomnav-hub";

  const header = document.createElement("div");
  header.className = "bottomnav-hub-header";
  const title = document.createElement("h3");
  title.textContent = "More";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-ghost bottomnav-hub-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeMoreHub);
  header.appendChild(title);
  header.appendChild(closeBtn);
  sheet.appendChild(header);

  const list = document.createElement("div");
  list.className = "bottomnav-hub-list";
  const current = router.currentPath();

  items.forEach((item) => {
    const a = document.createElement("a");
    a.className = "bottomnav-hub-item";
    a.href = `#${item.path}`;
    if (isActivePath(item.path, current, role)) {
      a.classList.add("active");
      a.setAttribute("aria-current", "page");
    }
    // esc() on the label because these strings come from config today but
    // will come from a database the moment per-tenant nav is configurable.
    // Escaping now costs nothing and removes a future injection path.
    a.innerHTML =
      `<span class="bottomnav-hub-icon" aria-hidden="true">${esc(item.icon)}</span>` +
      `<span class="bottomnav-hub-label">${esc(item.label)}</span>` +
      `<span class="bottomnav-hub-chevron" aria-hidden="true">›</span>`;
    a.addEventListener("click", closeMoreHub);
    list.appendChild(a);
  });

  sheet.appendChild(list);
  backdrop.appendChild(sheet);

  // Tapping the dimmed area closes; tapping the sheet itself must not.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeMoreHub();
  });

  document.body.appendChild(backdrop);
  // Stop the page behind the sheet from scrolling under the user's finger.
  document.body.classList.add("bottomnav-hub-open");
  openHub = backdrop;
  closeBtn.focus();
}

/** Closes the hub if one is open. Safe to call when none is. */
export function closeMoreHub() {
  if (!openHub) return;
  openHub.remove();
  openHub = null;
  document.body.classList.remove("bottomnav-hub-open");
}

/**
 * Renders the bottom bar for a role into `container`.
 *
 * Called once per shell mount, alongside renderSidenav(). Both are always
 * rendered; CSS decides which one is visible at the current width, so a
 * device rotation or a resized desktop window needs no JavaScript at all.
 *
 * @param {HTMLElement} container  the <nav id="bottomnav"> element
 * @param {string} role            "owner" | "wholesaler" | "sales" | "buyer"
 */
export function renderBottomNav(container, role) {
  const items = NAV_BY_ROLE[role] || [];
  const { bar, more } = splitNav(items);

  container.innerHTML = "";
  container.setAttribute("aria-label", "Primary");
  // Grid rather than flex so every tab gets an identical width -- with flex,
  // "Dashboard" would get a wider tap target than "Cart", which makes the
  // bar feel misaligned and gives the shorter labels smaller targets.
  container.style.gridTemplateColumns = `repeat(${bar.length}, 1fr)`;

  bar.forEach((item) => {
    // The More button is a <button>, not an <a>: it opens a dialog, it does
    // not navigate. Using an anchor with href="#" would announce it to a
    // screen reader as a link to nowhere.
    const el = document.createElement(item.isMore ? "button" : "a");
    el.className = "bottomnav-item";

    if (item.isMore) {
      el.type = "button";
      el.setAttribute("aria-haspopup", "dialog");
      el.addEventListener("click", () => renderMoreHub(more, role));
    } else {
      el.href = `#${item.path}`;
      el.dataset.path = item.path;
    }

    el.innerHTML =
      `<span class="bottomnav-icon" aria-hidden="true">${esc(item.icon)}</span>` +
      `<span class="bottomnav-label">${esc(shortLabel(item))}</span>`;
    container.appendChild(el);
  });

  /** Repaints the active state. Runs on every navigation, same as sidenav. */
  function highlightActive() {
    const current = router.currentPath();
    // Is the user inside one of the overflow destinations? If so, "More"
    // is the active tab -- otherwise a wholesaler on the Inventory screen
    // would see no tab highlighted at all and feel lost.
    const inMore = more.some((i) => isActivePath(i.path, current, role));

    container.querySelectorAll(".bottomnav-item").forEach((el) => {
      const path = el.dataset.path;
      const active = path ? isActivePath(path, current, role) : inMore;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  highlightActive();
  document.addEventListener("v2:navigated", highlightActive);

  // Navigating away must close the hub, or the sheet stays over the screen
  // the user just asked for. (This is the "stranded screen" failure the
  // Software Quality-of-Life checklist calls a Tier-1 defect.)
  document.addEventListener("v2:navigated", closeMoreHub);
}

// Escape closes the hub. Registered once at module scope rather than per
// render, so repeated shell mounts don't stack duplicate listeners.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMoreHub();
});
