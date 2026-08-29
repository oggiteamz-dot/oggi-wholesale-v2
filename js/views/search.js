// =============================================================================
// OGGI Wholesale v2 — SEARCH ACROSS YOUR STORES         SR-01, SR-10, 29 Aug 2026
// =============================================================================
// Every result names the wholesaler it came from. That is not decoration: a
// buyer looking at two similar products at two prices is making a decision
// about WHO to buy from, and a result that hides the seller makes that
// decision impossible.
//
// Prices are shown as "from". The exact price depends on the buyer's client
// record in that store, and a search result that quotes a price the order does
// not honour is a complaint. See migration 092's header.
// =============================================================================

import { pageHeader } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { searchProducts } from "../data/search.js";

function money(n, currency) {
  if (n == null) return "";
  return `${currency}${Number(n).toFixed(2)}`;
}

function resultCard(r) {
  const el = document.createElement("article");
  el.className = "sr-card";
  el.setAttribute("data-wid", r.wid);
  el.setAttribute("data-product", r.productId);

  const thumb = document.createElement("div");
  thumb.className = "sr-thumb";
  if (r.imageUrl) {
    const img = document.createElement("img");
    img.src = r.imageUrl;
    img.alt = "";
    img.loading = "lazy";
    thumb.appendChild(img);
  } else {
    thumb.classList.add("sr-thumb-empty");
  }
  el.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "sr-body";

  const h = document.createElement("h3");
  h.className = "sr-name";
  h.textContent = r.name;
  body.appendChild(h);

  // WHO it comes from — always, and never abbreviated away.
  const from = document.createElement("p");
  from.className = "sr-from";
  from.textContent = r.wholesalerName;
  body.appendChild(from);

  if (r.category) {
    const c = document.createElement("p");
    c.className = "sr-cat";
    c.textContent = r.category;
    body.appendChild(c);
  }

  if (r.priceFrom != null) {
    const p = document.createElement("p");
    p.className = "sr-price";
    // "from" is load-bearing: it is the difference between an indication and
    // a promise, and only one of those is true here.
    p.textContent = `from ${money(r.priceFrom, r.currency)}`;
    body.appendChild(p);
  }

  el.appendChild(body);

  // ------------------------------------------------------------- SR-11 ----
  // THE RESULTS ARE NOW TAPPABLE.
  //
  // ⚠️ THEY WERE NOT, FROM THE DAY SR-01 SHIPPED UNTIL 30 AUGUST 2026. This
  // card rendered a photo, a name, the wholesaler and a price, and attached no
  // click handler of any kind. A buyer could search across every store they
  // belonged to and then had no way to open anything they found.
  //
  // Nothing caught it because every assertion in check_cross_store_search.mjs
  // was about what the card SHOWS. A screen can be correct in every visible
  // detail and still be a dead end, and "is there any way out of this screen"
  // is the question none of those assertions asked.
  //
  // It could not be fixed before today either: the destination did not exist.
  // A search result belongs to a store the buyer may not currently be in, and
  // until the marketplace session (096) there was no way to move between
  // stores. MK-01 is that destination.
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.style.cursor = "pointer";
  const open = () => {
    window.location.hash = `#/buyer/s/${encodeURIComponent(r.wid)}/p/${encodeURIComponent(r.productId)}`;
  };
  el.addEventListener("click", open);
  // Keyboard too. A div made clickable and not focusable is a control that
  // exists only for people using a mouse.
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });

  return el;
}

/** SR-03: the shelf is labelled, and says plainly what it is.
 *  "Featured" alone would be a euphemism. A buyer is entitled to know that a
 *  placement was paid for — that is the whole difference between a disclosed
 *  shelf and the self-preferencing several marketplaces have been fined for. */
function promotedBlock(rows) {
  const sec = document.createElement("section");
  sec.className = "sr-promoted";
  sec.setAttribute("data-slot", "promoted");

  const head = document.createElement("p");
  head.className = "sr-promoted-label";
  head.textContent = "Featured by OGGI — we earn a commission on these";
  sec.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "sr-grid";
  rows.forEach((r) => {
    const card = resultCard(r);
    card.classList.add("sr-card-promoted");
    card.setAttribute("data-promoted", "true");
    grid.appendChild(card);
  });
  sec.appendChild(grid);
  return sec;
}

export async function searchView(outlet) {
  outlet.appendChild(pageHeader(
    "Search",
    "Across every wholesaler you have access to."
  ));

  const wrap = document.createElement("section");
  wrap.className = "sr-wrap";

  const form = document.createElement("form");
  form.className = "sr-form";
  form.setAttribute("role", "search");
  const label = document.createElement("label");
  label.className = "sr-only";
  label.setAttribute("for", "sr-q");
  label.textContent = "Search products across your wholesalers";
  const input = document.createElement("input");
  input.id = "sr-q";
  input.type = "search";
  input.name = "q";
  input.placeholder = "Search products…";
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "none");
  // Arabic is a first-class input here, not an afterthought.
  input.setAttribute("lang", "");
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "btn btn-primary";
  go.textContent = "Search";
  form.append(label, input, go);
  wrap.appendChild(form);

  const status = document.createElement("p");
  status.className = "sr-status";
  status.setAttribute("role", "status");
  wrap.appendChild(status);

  const grid = document.createElement("div");
  grid.className = "sr-grid";
  wrap.appendChild(grid);
  outlet.appendChild(wrap);

  async function run(q) {
    grid.textContent = "";
    if (!q || q.trim().length < 2) {
      status.textContent = q ? "Type at least two characters." : "";
      return;
    }
    status.textContent = "Searching…";
    const rows = await searchProducts(q);
    grid.textContent = "";

    if (!rows.length) {
      status.textContent = "";
      grid.appendChild(emptyState({
        icon: "\u{1F50D}",
        title: "Nothing found",
        // Honest about WHY, and about what would change it. A buyer who does
        // not know the search is scoped will read this as "OGGI has nothing".
        body: "No products matched in the wholesalers you have access to. "
            + "Ask another wholesaler for access on the Wholesalers tab, and "
            + "their products will appear here too.",
      }));
      return;
    }

    const promoted = rows.filter((r) => r.slot === "promoted");
    const organic  = rows.filter((r) => r.slot !== "promoted");

    // The count describes the ORGANIC results. Counting the shelf into the
    // total would inflate what the buyer thinks they found — the same three
    // products appear in both places, by design.
    const stores = new Set(organic.map((r) => r.wid));
    status.textContent =
      `${organic.length} result${organic.length === 1 ? "" : "s"} from ` +
      `${stores.size} wholesaler${stores.size === 1 ? "" : "s"}.`;

    if (promoted.length) grid.appendChild(promotedBlock(promoted));
    const organicGrid = document.createElement("div");
    organicGrid.className = "sr-grid sr-organic";
    organicGrid.setAttribute("data-slot", "organic");
    organic.forEach((r) => organicGrid.appendChild(resultCard(r)));
    grid.appendChild(organicGrid);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(form.querySelector('[name="q"]').value);
  });
}

export function registerSearchRoutes(router) {
  router.register("/buyer/search", (outlet) => searchView(outlet));
}
