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
export function renderSubTabs({ tabs, active }) {
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
    await current.render(host);
  }

  return { el: wrap, paint, activeKey: current.key };
}
