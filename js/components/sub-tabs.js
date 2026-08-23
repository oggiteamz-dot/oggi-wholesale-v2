// OGGI Wholesale v2 — sub-tabs for a screen that holds more than one view
// of the same thing (Batch 6)
//
// WHY THIS EXISTS
// ---------------
// Hadi asked for Products to become a sub-tab of Inventory. The two screens
// were already showing the SAME products, from the same product-tile
// component, with the same card facts -- they differed only in which figures
// were shown and which buttons the card offered. Two doors into one room, and
// the wholesaler had to know in advance which door had the button they wanted.
//
// A tab is not a navigation item. Deliberately different from js/lib/nav-config
// on three points, each of which is a rule rather than a preference:
//
//   1. THE TAB IS IN THE URL. Reload, back, forward and a pasted link all land
//      where the reader was. A tab held only in a variable looks identical
//      until someone refreshes, at which point their work location silently
//      resets -- and they blame themselves.
//   2. EVERY TAB IS A REAL ROUTE. So router.matches() sees them, the boot guard
//      sees them, and a deep link from anywhere else in the app cannot rot.
//   3. THE PANES DO NOT SHARE STATE. Each paints into its own host and is
//      re-run on switch. A half-torn-down pane leaking listeners into its
//      successor is the classic tab bug, and the cheapest defence is not to
//      keep anything between them.

import { esc } from "../lib/utils.js";
import { router } from "../lib/router.js";

/**
 * @param {object}  opts
 * @param {Array}   opts.tabs     [{ key, label, path, render(host) }]
 * @param {string}  opts.active   key of the tab to show
 * @returns {{ el: HTMLElement, paint: Function }}
 */
export function renderSubTabs({ tabs, active, params = {} }) {
  const wrap = document.createElement("div");
  wrap.className = "sub-tabs-wrap";

  const bar = document.createElement("div");
  bar.className = "sub-tabs";
  bar.setAttribute("role", "tablist");
  wrap.appendChild(bar);

  const host = document.createElement("div");
  host.className = "sub-tab-pane";
  wrap.appendChild(host);

  const current = tabs.find((t) => t.key === active) || tabs[0];

  tabs.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-tab" + (t.key === current.key ? " sub-tab-active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(t.key === current.key));
    btn.innerHTML = `${t.icon ? `<span aria-hidden="true">${esc(t.icon)}</span> ` : ""}${esc(t.label)}`;
    // Navigating rather than swapping in place: rule 1 above. The route
    // registration is what actually renders the pane.
    btn.addEventListener("click", () => {
      if (t.key === current.key) return;
      router.go(t.path);
    });
    bar.appendChild(btn);
  });

  async function paint() {
    host.innerHTML = "";
    // params are the ROUTE's params (a product id, say). Passed through rather
    // than closed over, so a pane that wants them gets them and one that does
    // not can keep its one-argument signature.
    await current.render(host, params);
  }

  // ---- the phone problem, Batch 8B ---------------------------------------
  //
  // Three tabs fitted. NINE do not: roughly 900px of labels on a 360px screen,
  // which is the narrow end of the phones actually in use. The strip has always
  // scrolled sideways, but two things were missing and both are the difference
  // between "organised" and "hidden":
  //
  //   1. Nothing said it scrolled. A row that ends flush at the screen edge
  //      looks finished. The ::after fade in css/brand.css says otherwise.
  //   2. The ACTIVE tab could be off-screen. Land on /wholesaler/intelligence
  //      -- the ninth tab -- and the ninth pane paints while the strip still
  //      shows tabs one to four, none of them selected. The reader sees a
  //      screen with no indication of where they are.
  //
  // scrollIntoView with `inline: "center"` rather than a scrollLeft assignment:
  // the offsets are not known until layout, and reading them here forces one.
  function revealActive() {
    const el = bar.querySelector(".sub-tab-active");
    if (!el || typeof el.scrollIntoView !== "function") return;
    // `block: "nearest"` so bringing a tab into view horizontally never scrolls
    // the PAGE vertically -- which would jump the reader away from the content
    // they just navigated to.
    el.scrollIntoView({ inline: "center", block: "nearest" });
  }
  // After the element is in the document and has been laid out. Called by the
  // caller's append order in practice, so a microtask is enough.
  queueMicrotask(revealActive);

  return { el: wrap, paint, activeKey: current.key, revealActive };
}
