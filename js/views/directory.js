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
    const p = document.createElement("p");
    p.className = "dir-waiting";
    p.textContent = "Waiting for them to approve you.";
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

  const grid = document.createElement("div");
  grid.className = "dir-grid";
  wrap.appendChild(grid);
  outlet.appendChild(wrap);

  async function onRequest(w, btn, msg) {
    btn.disabled = true;
    btn.textContent = "Sending…";
    const res = await requestAccess(w.wid);
    msg.textContent = res.msg || (res.ok ? "Sent." : "Could not send that.");
    msg.className = "dir-msg " + (res.ok ? "dir-msg-ok" : "dir-msg-no");
    if (res.ok) {
      btn.remove();
      const p = document.createElement("p");
      p.className = "dir-waiting";
      p.textContent = "Waiting for them to approve you.";
      msg.parentElement.appendChild(p);
      const cardEl = msg.closest(".dir-card");
      if (cardEl) cardEl.setAttribute("data-access", "pending");
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
