// =============================================================================
// OGGI Wholesale v2 — THE STORE SWITCHER                       ID-09, 30 Aug 2026
// =============================================================================
// One session, many stores, one active. This is the control that makes the
// directory, cross-store search and the reorder rail lead anywhere at all.
//
// ==== IT RENDERS NOTHING FOR A BUYER WITH ONE STORE ========================
//
// Most buyers have exactly one wholesaler and always will. A "switch store"
// control with nothing to switch to is a permanent question about a decision
// that does not exist, sitting at the top of the screen. So: fewer than two
// stores, no control.
//
// This is the same rule as the reorder rail, for the same reason, and it is
// worth stating twice because the temptation both times is to render an empty
// affordance "for consistency".
//
// ==== SWITCHING IS A SERVER ROUND TRIP, NOT A LOCAL TOGGLE =================
//
// Every switch calls v2_session_account, which re-checks the membership. A
// switcher that flipped a local variable would let a buyer whose access was
// revoked an hour ago walk back into that store, because the only thing saying
// otherwise would be a list fetched before the revoke.
//
// So a switch can FAIL, and the failure is shown rather than swallowed. A
// revoked store is removed from the list at the same time, so the buyer is not
// left tapping a door that will never open again.
// =============================================================================

import { esc } from "../lib/utils.js";
import { listStores, enterStore, marketplaceSession } from "../data/marketplace.js";

/**
 * @param {object}   opts
 * @param {string}   opts.activeWid    Which store is open right now.
 * @param {Function} opts.onSwitch     async (wid) => void, called after a
 *                                     SUCCESSFUL switch. The caller re-renders.
 * @returns {Promise<HTMLElement|null>} null when there is nothing to switch between.
 */
export async function renderStoreSwitcher({ activeWid, onSwitch } = {}) {
  if (!marketplaceSession()) return null;   // per-store login: no switcher, by design

  let stores = await listStores();
  if (stores.length < 2) return null;       // see the header

  const wrap = document.createElement("div");
  wrap.className = "store-switcher card";
  wrap.setAttribute("data-store-switcher", "1");
  wrap.style.cssText = "padding:10px 12px;margin-bottom:14px;";

  const msg = document.createElement("div");
  msg.setAttribute("data-slot", "msg");
  msg.style.cssText = "font-size:12px;margin-top:8px;display:none;";

  function paint() {
    wrap.innerHTML = `
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                  color:var(--text-tertiary);margin-bottom:8px;">Shopping from</div>
      <div data-slot="chips" style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;"></div>
    `;
    const chips = wrap.querySelector('[data-slot="chips"]');
    stores.forEach((st) => {
      const on = st.wid === activeWid;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm " + (on ? "btn-primary" : "btn-secondary");
      b.setAttribute("data-store-chip", st.wid);
      if (on) b.setAttribute("aria-current", "true");
      b.style.cssText = "flex:0 0 auto;white-space:nowrap;";
      b.textContent = st.wholesalerName;
      b.addEventListener("click", async () => {
        if (on) return;
        b.disabled = true;
        const prev = b.textContent;
        b.textContent = "Opening…";
        const r = await enterStore(st.wid);
        b.disabled = false;
        b.textContent = prev;
        if (!r.ok) {
          // The store went away between listing it and tapping it — almost
          // always a revoke. Say so, and take it off the list, so the buyer is
          // not left tapping a door that will not open.
          msg.textContent = r.error || "You do not have access to that store.";
          msg.style.color = "var(--danger-600,#b3261e)";
          msg.style.display = "";
          stores = stores.filter((x) => x.wid !== st.wid);
          if (stores.length < 2) { wrap.remove(); return; }
          paint();
          wrap.appendChild(msg);
          return;
        }
        if (typeof onSwitch === "function") await onSwitch(st.wid);
      });
      chips.appendChild(b);
    });
    wrap.appendChild(msg);
  }

  paint();
  return wrap;
}
