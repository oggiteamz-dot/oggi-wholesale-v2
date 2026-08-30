// =============================================================================
// OGGI Wholesale v2 — BROWSE OUR WHOLESALERS            DR-01..DR-05, 29 Aug 2026
// =============================================================================
// The first screen in this product that shows a buyer a business they have not
// been let into. See js/data/directory.js for why that is deliberate, what was
// deleted here on 18 Aug, and why it is back.
//
// WHAT THIS SCREEN OWES THE BUYER
//   * their own stores first, because "where do I shop today" is the commoner
//     question than "who else is there"
//   * an honest access state on every card -- in, asked, or neither -- so the
//     button never lies about what pressing it will do
//   * a search that finds a wholesaler by name (DR-03)
//
// WHAT IT OWES THE WHOLESALER
//   * a name and the categories they sell, and NOTHING ELSE. No products, no
//     prices, no count of either. A directory entry is not consent to publish
//     the size of your catalogue.
// =============================================================================

import { esc, pageHeader } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { listDirectory, requestAccess } from "../data/directory.js";
// AC-07/AC-11/PB-01: where the requests this buyer has already made stand.
import { listMyAccessRequests, requestStanding, humanHours }
  from "../data/access-requests.js";

const ACCESS_LABEL = {
  member:  "You have access",
  pending: "Requested",
  none:    "",
};

function card(w, onRequest) {
  const el = document.createElement("article");
  el.className = "dir-card";
  el.setAttribute("data-wid", w.wid);
  el.setAttribute("data-access", w.access);

  const head = document.createElement("div");
  head.className = "dir-head";

  const mark = document.createElement("div");
  mark.className = "dir-mark";
  if (w.logo) {
    const img = document.createElement("img");
    img.src = w.logo;
    img.alt = "";              // decorative: the name is right beside it
    img.loading = "lazy";
    mark.appendChild(img);
  } else {
    // A letter, not a broken image icon. Every wholesaler has a name.
    mark.textContent = (w.name || w.wid || "?").trim().charAt(0).toUpperCase();
  }
  head.appendChild(mark);

  const titles = document.createElement("div");
  titles.className = "dir-titles";
  const h = document.createElement("h3");
  h.className = "dir-name";
  h.textContent = w.name || w.wid;
  titles.appendChild(h);
  if (w.brand && w.brand !== w.name) {
    const b = document.createElement("p");
    b.className = "dir-brand";
    b.textContent = w.brand;
    titles.appendChild(b);
  }
  head.appendChild(titles);

  if (w.access !== "none") {
    const chip = document.createElement("span");
    chip.className = "dir-chip dir-chip-" + w.access;
    chip.textContent = ACCESS_LABEL[w.access];
    head.appendChild(chip);
  }
  el.appendChild(head);

  // DR-02. Categories, and only categories.
  const cats = document.createElement("ul");
  cats.className = "dir-cats";
  if (w.categories.length) {
    w.categories.slice(0, 6).forEach((c) => {
      const li = document.createElement("li");
      li.textContent = c;
      cats.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.className = "dir-cat-none";
    // Honest rather than blank. They have not said, and we are not guessing.
    li.textContent = "Hasn't listed what they sell yet";
    cats.appendChild(li);
  }
  el.appendChild(cats);

  const foot = document.createElement("div");
  foot.className = "dir-foot";
  const msg = document.createElement("p");
  msg.className = "dir-msg";
  msg.setAttribute("role", "status");   // announced when it changes
  foot.appendChild(msg);

  if (w.access === "member") {
    const a = document.createElement("a");
    a.className = "btn btn-primary dir-open";
    a.href = "#/buyer";
    a.textContent = "Open catalogue";
    foot.appendChild(a);
  } else if (w.access === "pending") {
    // PB-01, THE RETURN VISIT. The confirmation below (in onRequest) is seen
    // once, in the second after pressing the button. THIS is what the same
    // buyer sees every time they come back, and until 30 Aug it was the dead
    // end -- "Waiting for them to approve you." -- which says nothing about
    // whether anyone has seen it or when an answer is due. It was the worse of
    // the two, because it is the one that persists.
    //
    // The two sentences deliberately do not share wording: one is "I have just
    // sent this", the other is "this is still out". They DO share the same
    // stated time and the same pointer to where the answer will appear.
    const p = document.createElement("p");
    p.className = "dir-waiting";
    p.textContent = `Asked. ${w.name || w.wid} usually answers within `
      + `${humanHours(w.accessSlaHours)} — where it stands is under `
      + `“Your requests” at the top of this page.`;
    foot.appendChild(p);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn dir-ask";
    btn.textContent = "Ask for access";
    btn.addEventListener("click", () => onRequest(w, btn, msg));
    foot.appendChild(btn);
  }
  el.appendChild(foot);
  return el;
}

export async function directoryView(outlet) {
  outlet.appendChild(pageHeader(
    "Wholesalers",
    "Every wholesaler on OGGI. Ask for access to the ones you want to buy from."
  ));

  const wrap = document.createElement("section");
  wrap.className = "dir-wrap";

  const form = document.createElement("form");
  form.className = "dir-search";
  form.setAttribute("role", "search");
  const label = document.createElement("label");
  label.className = "sr-only";
  label.setAttribute("for", "dir-q");
  label.textContent = "Search wholesalers by name";
  const input = document.createElement("input");
  input.id = "dir-q";
  input.type = "search";
  input.name = "q";
  input.placeholder = "Search by name…";
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "none");
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "btn";
  go.textContent = "Search";
  form.append(label, input, go);
  wrap.appendChild(form);

  // AC-07/AC-11. Above the grid, not below it: a buyer who has already asked
  // came back to find out what happened, and making them scroll past the
  // thing they already did to reach the answer is the dead end again.
  const mine = document.createElement("section");
  mine.className = "dir-mine";
  mine.setAttribute("data-mine", "");
  wrap.appendChild(mine);

  const grid = document.createElement("div");
  grid.className = "dir-grid";
  wrap.appendChild(grid);
  outlet.appendChild(wrap);

  async function paintMine() {
    const rows = await listMyAccessRequests();
    mine.textContent = "";
    // Nothing asked for yet is not a state worth a heading. An empty box
    // labelled "Your requests" on a first visit is noise.
    if (!rows.length) return;

    const h = document.createElement("h2");
    h.className = "dir-mine-title";
    h.textContent = "Your requests";
    mine.appendChild(h);

    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "dir-mine-row";
      row.setAttribute("data-status", r.status);
      if (r.overdue) row.setAttribute("data-overdue", "");

      const name = document.createElement("strong");
      name.textContent = r.wholesalerName;

      const state = document.createElement("span");
      state.className = "dir-mine-state";
      state.textContent = r.status === "approved" ? "Approved"
        : r.status === "rejected" ? "Declined"
        : r.overdue ? "Still waiting" : "Waiting";

      const said = document.createElement("p");
      said.className = "dir-mine-said";
      said.textContent = requestStanding(r);

      row.append(name, state, said);
      mine.appendChild(row);
    });
  }
  paintMine();

  async function onRequest(w, btn, msg) {
    btn.disabled = true;
    btn.textContent = "Sending…";
    const res = await requestAccess(w.wid);
    msg.textContent = res.msg || (res.ok ? "Sent." : "Could not send that.");
    msg.className = "dir-msg " + (res.ok ? "dir-msg-ok" : "dir-msg-no");
    if (res.ok) {
      btn.remove();
      // PB-01. "Waiting for them to approve you" is a dead end: it says nothing
      // about whether anyone has seen it or when to expect an answer, which is
      // the exact complaint this is built from. Say what happens next, and how
      // long it usually takes THIS wholesaler.
      const p = document.createElement("p");
      p.className = "dir-waiting";
      p.textContent = `Sent to ${w.name || w.wid}. They usually answer within `
        + `${humanHours(w.accessSlaHours)}. You can check back here any time — `
        + `it will show up under “Your requests” at the top of this page.`;
      msg.parentElement.appendChild(p);
      const cardEl = msg.closest(".dir-card");
      if (cardEl) cardEl.setAttribute("data-access", "pending");
      // Re-paint the standing list so the new request appears where the
      // sentence above just promised it would be.
      paintMine();
    } else {
      btn.disabled = false;
      btn.textContent = "Ask for access";
    }
  }

  async function paint(search) {
    grid.textContent = "";
    const loading = document.createElement("p");
    loading.className = "dir-loading";
    loading.textContent = "Loading…";
    grid.appendChild(loading);

    const rows = await listDirectory({ search });
    grid.textContent = "";

    if (!rows.length) {
      grid.appendChild(emptyState({
        icon: "\u{1F3EC}",
        title: search ? "No wholesaler by that name" : "No wholesalers yet",
        body: search
          ? "Try part of the name instead of the whole thing."
          : "When wholesalers join OGGI they'll appear here.",
      }));
      return;
    }
    rows.forEach((w) => grid.appendChild(card(w, onRequest)));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    paint(form.querySelector('[name="q"]').value.trim());
  });

  await paint("");
}

export function registerDirectoryRoutes(router) {
  router.register("/buyer/wholesalers", (outlet) => directoryView(outlet));
}
