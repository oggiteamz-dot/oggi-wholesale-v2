// =============================================================================
// OGGI Wholesale v2 — THE MARKETPLACE HOME                      MK-01, 1 Sep 2026
// =============================================================================
// Hadi, 1 Sep 2026, after being shown the store picker:
//   "That's not what I wanted. I wanted one marketplace, full-scale marketplace,
//    imagine Amazon, with different stores inside that marketplace."
//
// So this screen never asks which store you are in. It shows products from
// every catalogue their owners published, from all of them at once, and the
// store is a LABEL on the card rather than a gate in front of it.
//
// WHAT IS ON IT, AND WHY IN THIS ORDER
//   1. Named rails — Best sellers, New arrivals. From the MyStories Moow
//      reference: a rail has a NAME, and a name is somewhere honest to put a
//      rule. An empty rail is hidden rather than shown empty.
//   2. "All products" — the woven browse, every store in rotation, paged.
//
// THE CARD SAYS WHAT YOU CAN DO
// Every tile carries the wholesaler's name and one of two states. `member` gets
// "Open" — the existing /buyer/s/:wid/p/:id route walks them into that store
// and focuses the product. `none` gets "Request access", which is the real
// request flow, not a placeholder.
//
// A PUBLIC CATALOGUE SHOWS ITS PRICES TO EVERYONE — that is already true of the
// share links, which need no login at all — so the price is on the card in both
// states. Seeing a price and being allowed to order against it are different
// things, and the button is what says which you have.
//
// SIGNED OUT IS A REAL STATE HERE. The marketplace is the public face of OGGI;
// v2_marketplace_feed takes a null account happily and simply marks nothing as
// yours. Nothing on this screen assumes a session.
// =============================================================================

// money comes from utils rather than a local copy: two money formatters in
// one app is how $17.6 and $17.60 end up on the same screen.
import { esc, pageHeader, money } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { feedPage, loadRails, searchProducts } from "../data/marketplace-feed.js";
import { splitReference } from "../lib/product-reference.js";
import { requestAccess, listDirectory } from "../data/directory.js";
import { toast } from "../components/toast.js";

const PAGE = 24;

/** One product tile. Used by the rails and by the grid, so a product cannot
 *  look like two different things depending which shelf it landed on. */
function tile(item, { wide = false } = {}) {
  const el = document.createElement("article");
  el.className = "mk-tile card";
  el.style.cssText = [
    "display:flex;flex-direction:column;overflow:hidden;",
    "border-radius:var(--radius-lg);background:var(--bg-surface);",
    "border:1px solid var(--border-subtle);",
    wide ? "" : "flex:0 0 168px;width:168px;",
  ].join("");

  // ---- the photograph -------------------------------------------------
  // A FIXED 4:5 FRAME, reserved before the image loads. The buyer catalogue
  // learned this the hard way: a box that grows when the picture arrives
  // reflows every card below it, and on a rail that is a row of products
  // jumping sideways under the reader's thumb.
  const frame = document.createElement("div");
  frame.style.cssText = "position:relative;aspect-ratio:4/5;background:var(--bg-sunken);flex:none;";
  if (item.imageUrl) {
    const img = document.createElement("img");
    img.src = item.imageUrl;
    img.alt = "";
    img.loading = "lazy";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    frame.appendChild(img);
  } else {
    frame.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;opacity:.45;font-size:22px;">🧵</div>`;
  }

  // SR-03. A paid placement is labelled, always. What OGGI earns is not the
  // buyer's business and never leaves the server, but THAT it earns something
  // here is the buyer's business and is said out loud.
  if (item.isPromoted) {
    const ad = document.createElement("span");
    ad.textContent = "Sponsored";
    ad.style.cssText = "position:absolute;top:6px;left:6px;background:rgba(0,0,0,.62);color:#fff;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600;";
    frame.appendChild(ad);
  }
  el.appendChild(frame);

  // ---- the words ------------------------------------------------------
  const body = document.createElement("div");
  body.style.cssText = "padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;";

  const { ref, rest } = splitReference(item.name);
  if (ref) {
    const r = document.createElement("div");
    r.textContent = ref;
    r.style.cssText = "font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--text-tertiary);";
    body.appendChild(r);
  }

  const h = document.createElement("h4");
  h.textContent = rest;
  h.style.cssText = "margin:0;font-size:13px;line-height:1.25;font-weight:650;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
  body.appendChild(h);

  const price = document.createElement("div");
  price.innerHTML = item.priceFrom == null
    ? `<span style="color:var(--text-tertiary);font-size:12px;">Price on request</span>`
    : `<strong style="font-size:14px;">${esc(money(item.priceFrom, item.currency))}</strong>`
      + `<span style="font-size:10px;color:var(--text-tertiary);"> from</span>`;
  price.style.cssText = "margin-top:2px;";
  body.appendChild(price);

  // The store, named. This is the 28 Aug decision — buyers see wholesalers by
  // name — and it is what makes this a marketplace of shops rather than an
  // anonymous grid that cannot answer "who am I buying this from".
  const store = document.createElement("div");
  store.style.cssText = "display:flex;align-items:center;gap:5px;margin-top:2px;min-width:0;";
  if (item.wholesalerLogo) {
    const lg = document.createElement("img");
    lg.src = item.wholesalerLogo;
    lg.alt = "";
    lg.loading = "lazy";
    lg.style.cssText = "width:16px;height:16px;border-radius:4px;object-fit:cover;flex:none;";
    store.appendChild(lg);
  }
  const sn = document.createElement("span");
  sn.textContent = item.wholesalerName;
  sn.style.cssText = "font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  store.appendChild(sn);
  body.appendChild(store);

  // ---- what you can do about it ---------------------------------------
  const act = document.createElement("button");
  act.className = "btn btn-sm " + (item.access === "member" ? "btn-primary" : "btn-secondary");
  act.textContent = item.access === "member" ? "Open" : "Request access";
  // margin-top:auto, not a fixed gap. The body is a flex column, so this pins
  // every button to the floor of its card — without it a two-line product name
  // pushes its button down and a rail of otherwise identical cards gets a
  // ragged row of buttons at three different heights. Seen in the render
  // harness before this shipped.
  act.style.cssText = "margin-top:auto;padding-top:8px;width:100%;";
  act.addEventListener("click", async () => {
    if (item.access === "member") {
      location.hash = `#/buyer/s/${encodeURIComponent(item.wid)}/p/${encodeURIComponent(item.productId)}`;
      return;
    }
    act.disabled = true;
    const r = await requestAccess(item.wid);
    act.disabled = false;
    if (r?.ok) {
      act.textContent = "Requested";
      act.disabled = true;
      toast(`Access requested from ${item.wholesalerName}. They will let you in from their side.`, { type: "success" });
    } else {
      // The commonest reason is "not signed in", and saying so beats a
      // blank refusal on a screen that works signed out by design.
      toast(r?.msg || "Sign in to ask this wholesaler for access.", { type: "danger" });
    }
  });
  body.appendChild(act);

  el.appendChild(body);
  return el;
}

/** A named, horizontally scrolling shelf. */
function rail(def) {
  const wrap = document.createElement("section");
  wrap.style.cssText = "margin-bottom:26px;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap;";
  const h = document.createElement("h3");
  h.textContent = def.title;
  h.style.cssText = "margin:0;font-size:16px;";
  head.appendChild(h);
  if (def.subtitle) {
    const s = document.createElement("span");
    s.textContent = def.subtitle;
    s.style.cssText = "font-size:12px;color:var(--text-tertiary);";
    head.appendChild(s);
  }
  wrap.appendChild(head);

  // Scrolls sideways, with the scrollbar left visible rather than hidden:
  // a shelf whose overflow is invisible is a shelf whose other half nobody
  // finds. Snap points so a flick lands on a card and not between two.
  const strip = document.createElement("div");
  strip.style.cssText = [
    "display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;",
    "scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;",
  ].join("");
  def.items.forEach((it) => {
    const t = tile(it);
    t.style.scrollSnapAlign = "start";
    strip.appendChild(t);
  });
  wrap.appendChild(strip);
  return wrap;
}

// =============================================================================
// MK-04 — ONE SEARCH BAR, TWO QUESTIONS                            1 Sep 2026
// =============================================================================
// Hadi: "At the top, there's just going to be a search bar, a normal search
// bar that ... gives them the ability to decide, I want a product or I want a
// wholesaler or a brand or whatever."
//
// So it does not ask the buyer to pick a mode first. One box, and BOTH answers
// come back: matching products, and matching shops. A buyer who types "casa"
// means the shop; a buyer who types "boot" means the product; a buyer who
// types "C-117" means exactly one thing and gets it first. Nobody should have
// to know which of those they meant before they start typing.
//
// The two halves are deliberately different functions with different scopes:
// v2_marketplace_search covers published catalogues, v2_directory_list covers
// every active wholesaler. Neither is allowed to become the other.
// =============================================================================

/** One shop, as a row. Wider than a tile because a shop's useful facts are
 *  words — its name and what it sells — not a photograph. */
function storeRow(s) {
  const el = document.createElement("article");
  el.className = "card";
  el.style.cssText = [
    "display:flex;align-items:center;gap:12px;padding:10px 12px;",
    "border:1px solid var(--border-subtle);border-radius:var(--radius-lg);",
    "background:var(--bg-surface);min-width:0;",
  ].join("");

  const lg = document.createElement("div");
  lg.style.cssText = "width:40px;height:40px;border-radius:8px;flex:none;background:var(--bg-sunken);overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:16px;";
  if (s.logo) {
    const img = document.createElement("img");
    img.src = s.logo; img.alt = ""; img.loading = "lazy";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;";
    lg.appendChild(img);
  } else {
    lg.textContent = "🏬";
  }
  el.appendChild(lg);

  const body = document.createElement("div");
  body.style.cssText = "flex:1;min-width:0;";
  const n = document.createElement("div");
  n.textContent = s.name || s.wid;
  n.style.cssText = "font-weight:650;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  body.appendChild(n);
  const cats = document.createElement("div");
  // What they sell, never how much of it. DR-05: products, prices and even a
  // product COUNT are absent from this answer, and migration 091 asserts there
  // is nowhere in its return type to put one.
  cats.textContent = (s.categories || []).slice(0, 4).join(" · ") || "Wholesaler";
  cats.style.cssText = "font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  body.appendChild(cats);
  el.appendChild(body);

  const act = document.createElement("button");
  act.style.cssText = "flex:none;";
  if (s.access === "member") {
    act.className = "btn btn-sm btn-primary";
    act.textContent = "Open";
    act.addEventListener("click", () => {
      location.hash = `#/buyer/s/${encodeURIComponent(s.wid)}`;
    });
  } else if (s.access === "pending" || s.access === "requested") {
    // A standing request is not a button. Saying "Requested" and how long they
    // take to answer is the honest state; a second Request access here would
    // send a duplicate the wholesaler has to dismiss.
    act.className = "btn btn-sm btn-secondary";
    act.textContent = "Requested";
    act.disabled = true;
    act.title = `Usually answered within ${s.accessSlaHours} hours.`;
  } else {
    act.className = "btn btn-sm btn-secondary";
    act.textContent = "Request access";
    act.addEventListener("click", async () => {
      act.disabled = true;
      const r = await requestAccess(s.wid);
      if (r?.ok) {
        act.textContent = "Requested";
        toast(`Access requested from ${s.name}. They usually answer within ${s.accessSlaHours} hours.`, { type: "success" });
      } else {
        act.disabled = false;
        toast(r?.msg || "Sign in to ask this wholesaler for access.", { type: "danger" });
      }
    });
  }
  el.appendChild(act);
  return el;
}

/** A titled block with a count, used by both halves of the results. */
function resultBlock(title, count) {
  const sec = document.createElement("section");
  sec.style.cssText = "margin-bottom:26px;";
  const h = document.createElement("div");
  h.style.cssText = "display:flex;align-items:baseline;gap:8px;margin-bottom:8px;";
  const t = document.createElement("h3");
  t.textContent = title;
  t.style.cssText = "margin:0;font-size:16px;";
  h.appendChild(t);
  const c = document.createElement("span");
  c.textContent = count === 1 ? "1 result" : `${count} results`;
  c.style.cssText = "font-size:12px;color:var(--text-tertiary);";
  h.appendChild(c);
  sec.appendChild(h);
  return sec;
}

/** The rails and the woven browse — everything the marketplace shows when
 *  nobody has typed anything. */
async function renderBrowse(host) {
  // Skeletons before anything is asked for, so the page has its shape from the
  // first frame rather than snapping into existence when the data lands.
  const skel = document.createElement("div");
  skel.style.cssText = "display:flex;gap:12px;overflow:hidden;margin-bottom:26px;";
  for (let i = 0; i < 6; i++) {
    const s = document.createElement("div");
    s.className = "skeleton card";
    s.style.cssText = "flex:0 0 168px;height:280px;border-radius:var(--radius-lg);";
    skel.appendChild(s);
  }
  host.appendChild(skel);

  const [rails, firstPage] = await Promise.all([loadRails(), feedPage({ limit: PAGE, offset: 0 })]);
  skel.remove();

  if (!rails.length && !firstPage.length) {
    host.appendChild(emptyState({
      icon: "🏬",
      title: "Nothing is published yet",
      body: "Wholesalers choose which of their catalogues are public. As soon as one publishes, its products appear here.",
    }));
    return;
  }

  rails.forEach((def) => host.appendChild(rail(def)));

  // ---- everything else, woven and paged -------------------------------
  const section = document.createElement("section");
  const h = document.createElement("h3");
  h.textContent = "All products";
  h.style.cssText = "margin:0 0 8px;font-size:16px;";
  section.appendChild(h);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px;";
  section.appendChild(grid);

  const seen = new Set();
  const add = (items) => {
    items.forEach((it) => {
      // Paging is exact server-side, but a client that de-dupes anyway cannot
      // ever render the same product twice — and a duplicated product on a
      // marketplace looks like a bug in the catalogue, not in the paging.
      if (seen.has(it.productId)) return;
      seen.add(it.productId);
      grid.appendChild(tile(it, { wide: true }));
    });
  };
  add(firstPage);

  const more = document.createElement("button");
  more.className = "btn btn-secondary";
  more.textContent = "Show more";
  more.style.cssText = "margin:16px auto 0;display:block;";
  let offset = firstPage.length;
  if (firstPage.length < PAGE) more.style.display = "none";
  more.addEventListener("click", async () => {
    more.disabled = true;
    more.textContent = "Loading…";
    const next = await feedPage({ limit: PAGE, offset });
    add(next);
    offset += next.length;
    more.disabled = false;
    more.textContent = "Show more";
    // Fewer than a full page means that was the last one. Hiding the button is
    // the honest end of a list; a button that returns nothing is not.
    if (next.length < PAGE) more.remove();
  });
  section.appendChild(more);
  host.appendChild(section);
}

// =============================================================================
export async function marketplaceView(outlet) {
  outlet.appendChild(pageHeader(
    "Marketplace",
    "Every wholesaler on OGGI, in one place."
  ));

  // ---- the search bar -------------------------------------------------
  const form = document.createElement("form");
  form.setAttribute("role", "search");
  form.style.cssText = "display:flex;gap:8px;margin:0 0 22px;max-width:640px;";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "input";
  input.placeholder = "Search products, wholesalers or a reference…";
  input.setAttribute("aria-label", "Search the marketplace");
  input.style.cssText = "flex:1;min-width:0;";
  form.appendChild(input);
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "btn btn-primary";
  go.textContent = "Search";
  go.style.cssText = "flex:none;";
  form.appendChild(go);
  outlet.appendChild(form);

  const browse = document.createElement("div");
  const results = document.createElement("div");
  results.hidden = true;
  outlet.appendChild(results);
  outlet.appendChild(browse);

  await renderBrowse(browse);

  // A run counter, not an abort: two searches in flight, the slower one
  // landing second, would otherwise paint the answer to the previous
  // question over the answer to this one.
  let run = 0;

  async function search(q) {
    const mine = ++run;
    results.innerHTML = "";
    const loading = document.createElement("div");
    loading.textContent = "Searching…";
    loading.style.cssText = "color:var(--text-secondary);font-size:13px;padding:6px 0 18px;";
    results.appendChild(loading);
    results.hidden = false;
    browse.hidden = true;

    // Both halves at once. Asked in sequence this screen would wait for the
    // whole of one answer before starting the other, for no reason: they do
    // not depend on each other.
    const [products, stores] = await Promise.all([
      searchProducts({ query: q, limit: 48 }),
      listDirectory({ search: q, limit: 12 }),
    ]);
    if (mine !== run) return;

    results.innerHTML = "";

    const back = document.createElement("button");
    back.className = "btn btn-secondary btn-sm";
    back.textContent = "← Back to the marketplace";
    back.style.cssText = "margin-bottom:16px;";
    back.addEventListener("click", () => clear());
    results.appendChild(back);

    if (!products.length && !stores.length) {
      results.appendChild(emptyState({
        icon: "🔍",
        title: `Nothing found for “${q}”`,
        body: "Try a shorter word, a category like “denim”, or a product reference such as C-117. Private catalogues are never searched — ask the wholesaler for access and they appear inside their store.",
      }));
      return;
    }

    // SHOPS FIRST WHEN THEY MATCH. A buyer who types a shop's name wants the
    // shop, and burying it under forty of its own products is the wrong answer
    // to the question they asked.
    if (stores.length) {
      const sec = resultBlock("Wholesalers", stores.length);
      const list = document.createElement("div");
      list.style.cssText = "display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));";
      stores.forEach((s) => list.appendChild(storeRow(s)));
      sec.appendChild(list);
      results.appendChild(sec);
    }

    if (products.length) {
      const sec = resultBlock("Products", products.length);
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px;";
      products.forEach((it) => grid.appendChild(tile(it, { wide: true })));
      sec.appendChild(grid);
      results.appendChild(sec);
    }
  }

  function clear() {
    run++;
    input.value = "";
    results.hidden = true;
    results.innerHTML = "";
    browse.hidden = false;
    input.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) search(q); else clear();
  });
  // A cleared box goes back to browsing without needing the button — that is
  // what the little × in a type=search field is for, and a box that clears to
  // an empty screen reads as a broken search.
  input.addEventListener("search", () => {
    if (!input.value.trim()) clear();
  });
}

export function registerMarketplaceRoutes(router) {
  router.register("/buyer/market", (outlet) => marketplaceView(outlet));
}
