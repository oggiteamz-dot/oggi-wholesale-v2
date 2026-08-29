// =============================================================================
// OGGI Wholesale v2 — THE PRODUCT RAIL                         RC-01, 30 Aug 2026
// =============================================================================
// One horizontally-scrolling row of product tiles under a title.
//
// ==== WHY THIS IS A COMPONENT AND NOT A STRIP INSIDE buyer.js ==============
//
// Hadi described the buyer home on 30 Aug as a FEED: "buy it again", "new from
// your stores", "recommended for you", "featured by OGGI", "recommended
// wholesalers". Every one of those is this same row with a different title and
// a different source. Written into the buyer view, the first one would have to
// be rewritten as the second one arrived; written here, the feed is a list of
// rails and RC-02, RC-03 and the paid shelf all mount without touching this
// file.
//
// ==== THE RULES THIS COMPONENT ENFORCES ====================================
//
// 1. NOTHING IS RENDERED WHEN THERE IS NOTHING TO SHOW. Not an empty card, not
//    "you haven't ordered yet". Returns null, and the caller appends nothing.
//    A permanently empty shelf pinned to the top of a new buyer's home is worse
//    than no shelf: it takes the best space on the screen to say "no".
//
//    This is not a hypothetical. As of 30 Aug NO account that can log in has
//    ever placed an order, so `null` is the only thing this component returns
//    on production today. The empty case is the shipping case.
//
// 2. THE ORDER IT IS GIVEN IS THE ORDER IT RENDERS. No client-side sorting.
//    The database decided the ranking (095 orders by most-recent, then
//    frequency, then name); a second opinion in the browser would mean the
//    ranking a gate proved is not the ranking anybody sees.
//
// 3. EVERY TILE NAMES ITS STORE. This rail is cross-store, so "who am I buying
//    this from" has to be answerable without a tap. Same reasoning as DR-05,
//    running the other way: a supplier's NAME is the buyer's business.
//
// 4. A PAID RAIL SAYS SO, IN THE TITLE ROW, ALWAYS. `paidLabel` is not styling
//    — passing it is the disclosure. There is deliberately no way to render a
//    promoted rail without it.
//
// 5. EVERYTHING USER-SUPPLIED IS ESCAPED. Product names come from wholesaler
//    catalogue imports, which is untrusted input arriving through a CSV.
// =============================================================================

import { esc } from "../lib/utils.js";

/**
 * @param {object}   opts
 * @param {string}   opts.title       Row heading, e.g. "Buy it again".
 * @param {Array}    opts.items       Rows from a mapper (see js/data/reorder.js).
 * @param {string}   [opts.paidLabel] REQUIRED for any commercial rail. Rendered
 *                                    beside the title. Omitting it on a paid rail
 *                                    is the failure the gate looks for.
 * @param {string}   [opts.subtitle]  Optional quiet line under the title.
 * @param {Function} [opts.onOpen]    (item) => void. Defaults to navigating into
 *                                    that item's store at that product.
 * @param {string}   [opts.testId]    data-rail value, for gates and for support.
 * @returns {HTMLElement|null}        null when there is nothing to show.
 */
export function renderProductRail({ title, items, paidLabel, subtitle, onOpen, testId } = {}) {
  const rows = Array.isArray(items) ? items : [];
  // RULE 1. The caller appends whatever comes back, so returning null is what
  // makes "no shelf at all" the empty state rather than an empty shelf.
  if (!rows.length) return null;

  const wrap = document.createElement("section");
  wrap.className = "product-rail";
  if (testId) wrap.setAttribute("data-rail", testId);
  wrap.style.cssText = "margin:0 0 22px;";

  const head = document.createElement("div");
  head.className = "product-rail-head";
  head.style.cssText = "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;";
  head.innerHTML = `
    <h3 style="margin:0;font-size:16px;font-weight:650;">${esc(title || "")}</h3>
    ${paidLabel ? `<span class="rail-paid" data-paid="1" style="font-size:12px;color:var(--text-secondary);">${esc(paidLabel)}</span>` : ""}
    ${subtitle ? `<span class="rail-sub" style="font-size:12px;color:var(--text-tertiary);">${esc(subtitle)}</span>` : ""}
  `;
  wrap.appendChild(head);

  const track = document.createElement("div");
  track.className = "product-rail-track";
  // overflow-x on the track, never on the page. -webkit-overflow-scrolling and
  // scroll-snap make this feel like a native carousel on a phone, which is what
  // the whole buyer app is.
  track.style.cssText =
    "display:flex;gap:12px;overflow-x:auto;overflow-y:hidden;" +
    "scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;" +
    "padding:2px 2px 8px;margin:0 -2px;";

  // RULE 2: rows.forEach, in the order given. Never rows.slice().sort(...).
  rows.forEach((it) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "product-rail-tile card";
    tile.setAttribute("data-tile", "1");
    tile.setAttribute("data-wid", String(it.wid ?? ""));
    tile.setAttribute("data-product-id", String(it.productId ?? ""));
    tile.style.cssText =
      "flex:0 0 152px;scroll-snap-align:start;text-align:left;padding:0;" +
      "border-radius:12px;overflow:hidden;cursor:pointer;background:var(--surface);";

    const money =
      it.priceFrom == null
        ? ""
        : `${esc(it.currency || "$")}${Number(it.priceFrom).toFixed(2)}`;

    const times = Number(it.timesOrdered) || 0;

    tile.innerHTML = `
      <div class="rail-thumb" style="width:100%;aspect-ratio:1/1;background:var(--surface-2, #eee);overflow:hidden;">
        ${
          it.imageUrl
            ? `<img src="${esc(it.imageUrl)}" alt="" loading="lazy"
                    style="width:100%;height:100%;object-fit:cover;display:block;">`
            : ""
        }
      </div>
      <div style="padding:8px 10px 10px;">
        <div class="rail-name" style="font-size:13px;font-weight:600;line-height:1.3;
             display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
          ${esc(it.productName || "")}
        </div>
        <!-- RULE 3. Cross-store: the tile must say whose product this is. -->
        <div class="rail-store" data-store="1"
             style="font-size:11px;color:var(--text-tertiary);margin-top:3px;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(it.wholesalerName || it.wid || "")}
        </div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-top:5px;">
          ${money ? `<span class="rail-price" style="font-size:13px;font-weight:650;">${money}</span>` : ""}
          ${
            times > 0
              ? `<span class="rail-times" style="font-size:11px;color:var(--text-tertiary);">${times}&times; ordered</span>`
              : ""
          }
        </div>
      </div>
    `;

    tile.addEventListener("click", () => {
      if (typeof onOpen === "function") { onOpen(it); return; }
      // DEFAULT: navigate into that item's store, at that product.
      //
      // It cannot add to the current cart. The cart is per-store (see
      // js/data/cart.js), so a tile from another wholesaler dropped into the
      // cart the buyer is currently filling would build an order that cannot be
      // submitted — and the buyer would find out at the checkout, not at the
      // tap. Moving stores is honest about what the tap does; the store name
      // above the price is what makes it unsurprising.
      window.location.hash = `#/buyer/p/${encodeURIComponent(it.wid)}/${encodeURIComponent(it.productId)}`;
    });

    track.appendChild(tile);
  });

  wrap.appendChild(track);
  return wrap;
}
