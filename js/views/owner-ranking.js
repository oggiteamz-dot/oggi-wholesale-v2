// =============================================================================
// OGGI Wholesale v2 — /owner/ranking                           SR-07, 30 Aug 2026
// =============================================================================
// The eight numbers that decide what the recommendation shelves show, every
// change ever made to them, and a date picker that answers "what were the rules
// on this day?".
//
// ==== WHY THE EXPLANATION IS AS PROMINENT AS THE NUMBER ====================
//
// `popular_min_buyers = 3` means nothing on its own. The row's own note says
// what it does and why 3 was chosen, and that note is the only reason the value
// is changeable safely. A screen that shows eight numbers and hides their
// meaning behind a tooltip is a screen that invites a wrong edit, so the note
// is rendered at full size next to the value, not under an info icon.
//
// ==== THE REASON IS NOT OPTIONAL AND NOT A FORMALITY =======================
//
// Changing a value takes two steps: the new value, then why. Cancelling the
// second writes nothing. The database refuses a reasonless change anyway --
// this is the same rule stated where the person can see it, so the refusal is
// never a surprise.
// =============================================================================

import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { ask } from "../components/ask.js";
import { esc, pageHeader } from "../lib/utils.js";
import {
  listRankingConfig, listRankingHistory, rankingConfigAsOf,
  setRankingNumber, verifyRankingHistory,
} from "../data/ranking-config.js";

// A change made in the app names a human. One made straight against the
// database cannot, and says so rather than inventing one.
function sourceBadge(source) {
  return source === "app"
    ? `<span class="pill" title="Made in the owner console by a signed-in person">in the app</span>`
    : `<span class="pill pill-muted" title="Made directly against the database — no signed-in person to attribute it to">database</span>`;
}

function when(ts) {
  return ts ? new Date(ts).toLocaleString() : "";
}

async function rankingView(outlet) {
  outlet.appendChild(pageHeader(
    "Ranking settings",
    "The numbers behind “Popular right now” and “More like this”. Every change is recorded permanently, with who made it and why.",
  ));

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const [rows, history, tamper] = await Promise.all([
    listRankingConfig(), listRankingHistory({ limit: 200 }), verifyRankingHistory(),
  ]);
  loading.remove();

  if (!rows.length) {
    outlet.appendChild(emptyState({
      icon: "⚖️",
      title: "No ranking settings visible",
      body: "These are owner-only. If you are signed in as the owner and still see this, the settings have not been installed yet.",
    }));
    return;
  }

  // ---- the integrity line -------------------------------------------------
  // Shown whatever the answer. A tamper check you only see when it fails is a
  // check nobody knows exists, and its silence is indistinguishable from it
  // never having run.
  const integrity = document.createElement("div");
  integrity.className = "card";
  integrity.style.cssText = "padding:12px;margin-bottom:12px;";
  if (tamper === null) {
    integrity.innerHTML = `<strong>Record integrity:</strong> could not be checked just now.`;
  } else if (tamper.length === 0) {
    integrity.innerHTML =
      `<strong>Record integrity: intact.</strong> <span style="color:var(--text-secondary);">Every entry below still matches its own fingerprint, so nothing has been altered after it was written.</span>`;
  } else {
    integrity.classList.add("card-danger");
    integrity.innerHTML =
      `<strong>Record integrity: ${tamper.length} altered entr${tamper.length === 1 ? "y" : "ies"}.</strong> ` +
      tamper.map((t) => `<div style="font-size:13px;">#${esc(String(t.id))} ${esc(t.key)} — ${esc(t.problem)}</div>`).join("");
  }
  outlet.appendChild(integrity);

  // ---- the settings -------------------------------------------------------
  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";

  rows.forEach((r) => {
    const isText = r.textValue !== null && r.textValue !== undefined;
    const shown = isText ? r.textValue : String(r.intValue);
    const row = document.createElement("div");
    row.style.cssText = "padding:14px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
        <div style="min-width:0;">
          <div style="font-weight:600;">${esc(r.key)}</div>
          <div style="font-size:20px;margin:4px 0;word-break:break-word;">${esc(shown)}</div>
        </div>
        <button class="btn btn-ghost" data-edit="${esc(r.key)}" type="button">Change</button>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${esc(r.note || "")}</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">
        ${r.changeCount ? `changed ${esc(String(r.changeCount))} time${r.changeCount === 1 ? "" : "s"}` : "never changed since the record began"}
        · last touched ${esc(when(r.updatedAt))}
        ${r.lastActor ? " by " + esc(r.lastActor) : ""} ${sourceBadge(r.lastSource)}
        ${r.lastReason ? `<div style="margin-top:2px;font-style:italic;">“${esc(r.lastReason)}”</div>` : ""}
      </div>
    `;

    row.querySelector("[data-edit]").addEventListener("click", async () => {
      const value = await ask({
        title: `Change ${r.key}`,
        body: r.note || "",
        label: isText ? "New list of words (comma separated)" : "New number",
        value: shown,
        type: isText ? "text" : "number",
        confirmLabel: "Next",
        validate: (v) => {
          if (isText) return v.trim().length ? null : "This cannot be emptied — the shelf depends on it.";
          if (!/^\d+$/.test(v.trim())) return "A whole number, please.";
          return null;
        },
      });
      if (value === null) return;                       // cancelled, nothing written

      const reason = await ask({
        title: "Why is this changing?",
        body: "This goes into the permanent record. If a wholesaler ever asks why their product moved, this is the answer they will be shown.",
        label: "Reason (recorded permanently)",
        placeholder: "e.g. three shops is too low now that there are twelve",
        confirmLabel: "Save the change",
        validate: (v) => (v.trim().length >= 5
          ? null
          : "A few words at least — an entry with no reason is one nobody can explain later."),
      });
      if (reason === null) return;                      // cancelled, nothing written

      const res = await setRankingNumber({
        key: r.key,
        intValue: isText ? null : value,
        textValue: isText ? value : null,
        reason,
      });
      toast(res.message || (res.ok ? "Saved." : "Not saved."));
      if (res.ok) {
        // Re-render rather than patching the row in place: the timeline, the
        // change count and the integrity line all moved, and a screen that
        // updates one of the four is a screen that starts lying immediately.
        outlet.innerHTML = "";
        rankingView(outlet);
      }
    });

    list.appendChild(row);
  });
  outlet.appendChild(list);

  // ---- what were the rules on ... ----------------------------------------
  const asOf = document.createElement("div");
  asOf.className = "card";
  asOf.style.cssText = "padding:14px;margin-top:12px;";
  asOf.innerHTML = `
    <div style="font-weight:600;">What were the rules on…</div>
    <div style="font-size:13px;color:var(--text-secondary);margin:4px 0 8px;">
      Rebuilt from the record, not from what the settings say today.
    </div>
    <input class="input" type="date" id="asof-date" style="max-width:220px;">
    <button class="btn btn-ghost" id="asof-go" type="button">Show</button>
    <div id="asof-out" style="margin-top:10px;"></div>
  `;
  outlet.appendChild(asOf);

  asOf.querySelector("#asof-go").addEventListener("click", async () => {
    const v = asOf.querySelector("#asof-date").value;
    const out = asOf.querySelector("#asof-out");
    if (!v) { out.textContent = "Pick a date first."; return; }
    out.textContent = "Looking…";
    // End of the chosen day, so "on the 4th" includes a change made that
    // afternoon rather than silently meaning "at midnight as the 4th began".
    const at = new Date(`${v}T23:59:59`);
    const snap = await rankingConfigAsOf(at);
    if (!snap.length) {
      out.innerHTML = `<div style="color:var(--text-secondary);">The record had not begun on that date — nothing was being recorded yet.</div>`;
      return;
    }
    out.innerHTML = snap.map((s) => `
      <div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
        <span>${esc(s.key)}</span>
        <span><strong>${esc(s.intValue === null || s.intValue === undefined ? (s.textValue || "") : String(s.intValue))}</strong>
        ${s.stillTrue ? "" : ` <span class="pill pill-muted">changed since</span>`}</span>
      </div>`).join("");
  });

  // ---- the timeline -------------------------------------------------------
  const tl = document.createElement("div");
  tl.className = "card";
  tl.style.cssText = "padding:8px;margin-top:12px;";
  tl.innerHTML = `<div style="padding:10px 12px;font-weight:600;">Every change, newest first</div>`;
  if (!history.length) {
    tl.innerHTML += `<div style="padding:0 12px 12px;color:var(--text-secondary);">Nothing recorded yet.</div>`;
  }
  history.forEach((h) => {
    const e = document.createElement("div");
    e.style.cssText = "padding:10px 12px;border-top:1px solid var(--border-subtle);";
    e.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <strong>${esc(h.key)}</strong>
        <span style="font-size:12px;color:var(--text-tertiary);">${esc(when(h.changedAt))}</span>
      </div>
      <div style="font-size:13px;margin-top:2px;">
        ${h.op === "baseline"
          ? `started at <strong>${esc(h.newValue ?? "")}</strong>`
          : h.op === "delete"
            ? `removed (was <strong>${esc(h.oldValue ?? "")}</strong>)`
            : `<strong>${esc(h.oldValue ?? "—")}</strong> → <strong>${esc(h.newValue ?? "")}</strong>`}
        · ${esc(h.actor || "unknown")} ${sourceBadge(h.actorSource)}
      </div>
      ${h.reason ? `<div style="font-size:13px;color:var(--text-secondary);font-style:italic;margin-top:2px;">“${esc(h.reason)}”</div>` : ``}
    `;
    tl.appendChild(e);
  });
  outlet.appendChild(tl);
}

export function registerOwnerRankingRoute(router) {
  router.register("/owner/ranking", (outlet) => rankingView(outlet));
}
