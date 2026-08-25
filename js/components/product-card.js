// OGGI Wholesale v2 — buyer catalog product card (Batch 2)
// One card per product. Colour swatches select a colour; a size grid then
// appears for that colour with per-size availability; qty stepper adds/
// updates the cart line for the selected variant directly (in-place, no
// delete-and-re-add -- the #1 buyer complaint fixed per Research 3).

import { cart } from "../data/cart.js";
import { toast } from "./toast.js";
import { tierForQty, nextTier, effectivePrice, productMoqStatus, variantMoqStatus, marginPct, round2 } from "../data/pricing.js";
import { flyToCart } from "../lib/animations/fly-to-cart.js";
import { openHologramModal } from "../lib/animations/product-hologram.js";

import { priceLine, aggregateQtyByProduct } from "../data/line-pricing.js";

import { esc, money } from "../lib/utils.js";
/** Sum of this product's qty already in the cart, across every colour/
 * size -- the "aggregated across colorways" basis for both tiered pricing
 * and product-level MOQ (Batch 6).
 *
 * BATCH 5 CORRECTION. This used to filter on `l.variantId`, which a PACK line
 * does not have (it carries `components`), so every pack in the cart counted
 * as zero pieces. A buyer with ten 12-piece packs of one product -- 120 pieces
 * -- was treated as having ordered none of it, so the quantity break they had
 * earned was never offered and the product-MOQ warning fired on a cart that
 * already met it. v2_submit_order has always counted those pieces, so the
 * invoice quietly disagreed with the screen.
 *
 * It now goes through aggregateQtyByProduct(), the same expansion the pricing
 * engine and checks/check_line_pricing.mjs use, so there is one answer to
 * "how many of this product is in the cart" rather than three. */
function cartQtyForProduct(wid, product) {
  const agg = aggregateQtyByProduct(cart.get(wid));
  const own = agg.get(product.id) || 0;
  if (own) return own;
  // Fallback for lines written before pack lines recorded their productId:
  // match by the variant ids we know belong to this product.
  const variantIds = new Set(product.variants.map((v) => v.id));
  return cart.get(wid).reduce((sum, l) => {
    if (l.isPack) return sum + (l.components || []).filter((c) => variantIds.has(c.variantId)).reduce((s2, c) => s2 + c.qtyPerPack * l.packQty, 0);
    return sum + (variantIds.has(l.variantId) ? l.qty : 0);
  }, 0);
}

/** How many pieces one press of "+" adds. Per product, never a wholesaler-wide
 *  default (Hadi, 20 Aug 2026: "they decide the base unit per product").
 *  1 means the product is sold by the single piece. */
function baseUnitOf(product) {
  const n = Number(product.baseUnit || 1);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

export function renderProductCard({ product, wid, locationId, currency, tiers = [], overridesByVariant = new Map(), isReorder = false, packs = [], onCartChange,
  // Migration 053. discountPct is the WHOLE percentage the server will apply
  // (catalog + customer, per the catalog's mode). customerPct is the part of
  // it the buyer is allowed to see: the catalog's own share is silent by
  // design, so only the customer's share may appear as a struck-through
  // "before" price. Both default to 0, so a screen that has not been taught
  // about discounts prices exactly as it did before.
  discountPct = 0, customerPct = 0,
  // Pinned to the top of this catalog. The card SAYS SO rather than relying on
  // the reader remembering that everything above a header is special -- by the
  // time you have scrolled past six of them the header is off screen and the
  // grouping has stopped meaning anything.
  highlighted = false }) {
  const el = document.createElement("div");
  el.className = "card product-card";
  // The billboard's button scrolls to a specific product, so a card has to be
  // findable by id. Without this the button lands on nothing, which is the
  // failure a poster with a call to action can least afford.
  el.dataset.productId = product.id;
  if (highlighted) el.classList.add("product-card-highlighted");
  el.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:10px;";

  let selectedColor = product.colors[0]?.name || null;

  // ---------------------------------------------------------------------
  // THE PHOTO. Batch 5.
  //
  // This card has rendered no <img> at all since it was written. catalog.js
  // has been fetching image_url and images on every variant of every request
  // the whole time and discarding them one line later; the only thing that
  // ever touched a product photo was the 360 viewer's modal, which a buyer has
  // to know to press. On production the one wholesaler with real photography
  // has a photo on all 46 of their variants -- and their buyers saw a wall of
  // text. It was the oldest open item in the project.
  //
  // Three rules, in order of how badly each is usually got wrong:
  //
  //  1. It follows the swatch. Photography is per colour, so selecting Blue
  //     and being shown the red one is worse than showing nothing.
  //  2. The box never changes size. A fixed 4:5 frame reserved before the
  //     image loads means the card does not jump under the reader's thumb
  //     when a photo arrives -- the layout shift that makes people tap the
  //     wrong product.
  //  3. Absent and broken look the same, and both look deliberate. A dead
  //     storage URL falls back to the same honest placeholder as no photo at
  //     all, never a broken-image icon.
  // ---------------------------------------------------------------------
  const photo = document.createElement("div");
  photo.className = "pc-photo";
  photo.style.cssText = "position:relative;aspect-ratio:4/5;width:100%;border-radius:10px;overflow:hidden;background:var(--surface-2,rgba(0,0,0,.04));display:flex;align-items:center;justify-content:center;";
  el.appendChild(photo);

  function photosFor(color) {
    const byColor = product.imagesByColor;
    const own = byColor && typeof byColor.get === "function" ? byColor.get(color) : null;
    if (own && own.length) return own;
    // CR-0004, 25 Aug 2026. This used to fall back to product.primaryImage --
    // "a partly-photographed range still shows a picture rather than a gap".
    //
    // That was harmless only for as long as every colour of a product carried
    // an identical gallery, which is what both save paths did until today. Now
    // that a colour can genuinely have its own photography, the same line
    // becomes the bug that shows a buyer the BLACK jean while they are
    // ordering the BROWN one -- a wrong picture read as fact, which is worse
    // than an honest empty frame.
    //
    // Hadi, 25 Aug: "if it's not available, then it's not available from my
    // client's side."
    //
    // Returning [] hands the caller renderPlaceholder(), which says "No photo
    // yet" tinted in this colour's own hex. The colour stays fully orderable:
    // a missing photograph must never quietly remove stock from sale.
    // Logged in REMOVALS-APPROVED.md.
    return [];
  }

  function renderPlaceholder() {
    const hex = product.colors.find((c) => c.name === selectedColor)?.hex || "#c9d3cd";
    photo.innerHTML = "";
    const ph = document.createElement("div");
    ph.style.cssText = `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:linear-gradient(160deg, ${hex}22, ${hex}0a);`;
    // Says what it is instead of pretending. A grey box with no words reads as
    // a failure; "No photo yet" reads as a fact about this product.
    ph.innerHTML = `<div style="font-size:26px;opacity:.5;">🧵</div><div style="font-size:11px;color:var(--text-tertiary);">No photo yet</div>`;
    photo.appendChild(ph);
  }

  function renderPhoto() {
    const urls = photosFor(selectedColor);
    if (!urls.length) { renderPlaceholder(); return; }
    photo.innerHTML = "";
    const img = document.createElement("img");
    // setAttribute, not the IDL properties: jsdom does not implement
    // HTMLImageElement.loading/decoding, so assigning the property leaves no
    // attribute for checks/check_buyer_product_card.mjs to see -- and a
    // lazy-loading promise nothing can verify is a promise that quietly stops
    // being true. The attribute form behaves identically in every browser.
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.alt = `${product.name}${selectedColor ? ` in ${selectedColor}` : ""}`;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    // A storage object can be deleted, made private, or simply 404. Whatever
    // the reason, the reader gets the placeholder, not a torn-page icon.
    img.addEventListener("error", renderPlaceholder, { once: true });
    img.src = urls[0];
    photo.appendChild(img);

    // More than one photo for this colour: say how many, and let the count
    // open the viewer that already exists rather than building a second one.
    if (urls.length > 1) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "btn btn-sm";
      more.style.cssText = "position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.62);color:#fff;border:0;border-radius:999px;padding:3px 10px;font-size:11px;";
      more.textContent = `+${urls.length - 1} more`;
      more.setAttribute("aria-label", `View all ${urls.length} photos of ${product.name}`);
      more.addEventListener("click", () => {
        const source = product.variants.find((v) => v.color === selectedColor) || product.variants[0];
        openHologramModal({ images: urls, colorHex: source?.colorHex, productName: product.name });
      });
      photo.appendChild(more);
    }
  }

  const badges = [];
  if (product.isNew) badges.push('<span class="badge badge-info">New</span>');
  if (product.outOfStock) badges.push('<span class="badge badge-danger">Out of stock</span>');
  else if (product.lowStock) badges.push('<span class="badge badge-warning">Low stock</span>');
  const moqReq = isReorder && product.moqReorderQty != null ? product.moqReorderQty : product.moqQty;
  if (moqReq > 1) badges.push(`<span class="badge badge-neutral">Min ${moqReq}${isReorder ? " (reorder)" : ""}</span>`);

  const baseUnit = baseUnitOf(product);
  const tiersByProductLocal = new Map([[product.id, tiers]]);

  /**
   * THE PRICE ON THE CARD. Batch 5.
   *
   * Hadi, 20 Aug 2026: "The price they will read in the thumbnail is going to
   * be the per unit price."
   *
   * It used to be product.minPrice/maxPrice, which is the raw list price off
   * the variant rows -- no negotiated price, no quantity break, no catalog
   * discount. So a buyer shopping a 25%-off catalog read the full price on
   * every card and only found the real one after adding to the cart. This runs
   * each variant through the same effectivePrice() the cart and the server
   * use, at the quantity already in the cart, so the number on the card is the
   * number they will pay for the next piece they add.
   */
  function unitPriceRange() {
    const aggQty = cartQtyForProduct(wid, product);
    const prices = product.variants
      .filter((v) => v.price > 0)
      .map((v) => effectivePrice({
        basePrice: v.price, productId: product.id, variantId: v.id,
        aggregateQty: aggQty, tiersByProduct: tiersByProductLocal, overridesByVariant,
        discountPct, customerPct,
      }));
    if (!prices.length) return null;
    const lo = Math.min(...prices.map((p) => p.price));
    const hi = Math.max(...prices.map((p) => p.price));
    const listLo = Math.min(...prices.map((p) => p.listPrice));
    const listHi = Math.max(...prices.map((p) => p.listPrice));
    return { lo, hi, listLo, listHi, cut: listLo > lo || listHi > hi };
  }

  const header = document.createElement("div");

  function renderHeader() {
    const r = unitPriceRange();
    const shown = !r ? "—" : r.lo === r.hi ? money(r.lo, currency) : `${money(r.lo, currency)} – ${money(r.hi, currency)}`;
    const was = r && r.cut
      ? ` <s class="pc-was" style="color:var(--text-tertiary);font-weight:400;">${r.listLo === r.listHi ? money(r.listLo, currency) : `${money(r.listLo, currency)} – ${money(r.listHi, currency)}`}</s>`
      : "";
    header.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">${badges.join("")}</div>
      <h4 style="margin-bottom:2px;">${esc(product.name)}</h4>
      <div style="color:var(--text-secondary);font-size:13px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
        <span><strong style="color:var(--text-primary);">${shown}</strong> <span style="font-size:11px;">per piece</span></span>${was}
        ${baseUnit > 1 ? `<span class="badge badge-neutral pc-multiplier" title="One unit of this product is ${baseUnit} pieces. Each + adds ${baseUnit}, and the total is the piece price times the pieces.">×${baseUnit}</span>` : ""}
      </div>
      ${baseUnit > 1 ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">Sold in units of ${baseUnit} — one unit is ${baseUnit} pieces.</div>` : ""}
      ${product.moqPerColour ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">At least ${product.moqPerColour} pieces of each colour you pick.</div>` : ""}
      ${tiers.length ? `<div style="font-size:11px;color:var(--accent-600,#2f6b4f);margin-top:2px;">${tiers.map((t) => `${t.minQty}+ pieces: ${money(t.unitPrice, currency)} each`).join(" · ")}</div>` : ""}
    `;
  }
  renderHeader();
  el.appendChild(header);

  const swatchBar = document.createElement("div");
  swatchBar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
  const swatchRow = document.createElement("div");
  swatchRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
  // Hook for the touch-target rules in css/mobile.css. Added rather than
  // folded into the line above, so this file gains lines and never loses any.
  swatchRow.className = "swatch-row";
  swatchBar.appendChild(swatchRow);

  // Batch 13: "360°" hologram viewer button -- opens the 3-tier viewer
  // (real drag-rotate / tilt+sheen / placeholder) for whichever colour is
  // currently selected. Always rendered (even for a 0-photo variant) so
  // the feature is honest and discoverable rather than hidden until real
  // photography exists -- see js/lib/animations/product-hologram.js.
  const hologramBtn = document.createElement("button");
  hologramBtn.type = "button";
  hologramBtn.className = "btn btn-ghost btn-sm";
  hologramBtn.title = "360° view";
  hologramBtn.setAttribute("aria-label", "Open 360-degree product view");
  hologramBtn.textContent = "360°";
  hologramBtn.addEventListener("click", () => {
    const variantsForColor = product.variants.filter((v) => v.color === selectedColor);
    const source = variantsForColor[0] || product.variants[0];
    openHologramModal({
      images: source?.images || [],
      colorHex: source?.colorHex,
      productName: product.name,
    });
  });
  swatchBar.appendChild(hologramBtn);
  el.appendChild(swatchBar);

  // How is this product sold? 'open' means pick any quantity of any size.
  // Anything else means it is sold as a fixed bundle, and the per-size
  // stepper must NOT be offered -- the server rejects loose lines for those
  // products (migrations 029, 030), so showing the stepper would let a buyer
  // build an order that cannot be submitted.
  const sellingModel = product.sellingModel || "open";
  const isBundleOnly = sellingModel !== "open";

  const sizeRow = document.createElement("div");
  sizeRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;";
  // The sheet is mounted into this slot further down, once it is built. The
  // slot is appended HERE so the sheet keeps the exact position in the card
  // that the old size row held -- above the pack section and the footer.
  if (!isBundleOnly) el.appendChild(sizeRow);

  // Say plainly how this product is sold, so the absence of a size stepper
  // reads as a rule rather than a missing feature.
  if (isBundleOnly) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:12px;color:var(--text-secondary);background:var(--surface-2,rgba(0,0,0,.03));border-radius:6px;padding:6px 8px;";
    note.textContent = {
      series:  "Sold as a full series — every colour and size together.",
      prepack: "Sold in fixed cartons. Choose a colour and how many cartons.",
      ratio:   "Sold in ratio packs — the wholesaler sets the size mix. Choose a colour and how many packs.",
    }[sellingModel] || "Sold as a fixed bundle.";
    el.appendChild(note);
  }

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:auto;display:flex;justify-content:flex-end;";
  el.appendChild(footer);

  // Batch 7: prepack/ratio-pack -- one-click, chat-orderable bundle units
  // ("2x Boutique Pack – Style ABC, Blue"). Shown for every pack defined
  // on this product regardless of the colour swatch currently selected
  // above (a pack is its own fixed bundle, not a variant of the open-mix
  // selector).
  //
  // CHANGED 15 Aug 2026: the open per-size stepper is NO LONGER an always-on
  // fallback. For a series/prepack/ratio product it is hidden entirely,
  // because the server now refuses loose lines for those products. Offering
  // a control whose result the server rejects is worse than offering none.
  // For an open-stock product nothing changes.
  if (isBundleOnly && !packs.length) {
    const warn = document.createElement("div");
    warn.style.cssText = "font-size:12px;color:var(--danger,#b42318);margin-top:8px;";
    warn.textContent = "This product has no bundles set up yet, so it cannot be ordered. Ask the wholesaler to add one.";
    el.appendChild(warn);
  }

  if (packs.length) {
    const packSection = document.createElement("div");
    packSection.style.cssText = "border-top:1px solid var(--border-subtle);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:8px;";
    packs.forEach((pack) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;";
      const breakdown = pack.components.map((c) => `${c.qtyPerPack}×${c.size || c.sku}`).join("/");
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";
      row.appendChild(info);

      /**
       * What this many of this pack actually costs.
       *
       * BEFORE BATCH 5 this line read `money(pack.price)/pack` -- the pack's
       * own price field, with no quantity break, no negotiated price and no
       * catalog discount applied, and with its pieces counted as zero toward
       * the aggregate that decides the break. v2_submit_order applies all
       * three to every component line. Proven against production on 21 Aug
       * 2026: the same 12-piece pack in a 25%-off catalog is charged 72.00
       * while this card displayed 96.00 (checks/check_line_pricing.sql).
       *
       * It now goes through the same priceLine() the cart and the gate use, at
       * the aggregate quantity including whatever is already in the cart, so
       * the pack quotes the same number the invoice will.
       */
      function pricePack(n) {
        const line = {
          isPack: true, packId: pack.id, packLineId: "preview", productId: product.id,
          packQty: Math.max(n, 1), unitCount: pack.unitCount,
          components: pack.components,
        };
        const inCart = cartQtyForProduct(wid, product);
        return priceLine(line, {
          productId: product.id,
          aggregateQty: inCart + pack.unitCount * Math.max(n, 1),
          basePriceFor: (vid) => product.variants.find((v) => v.id === vid)?.price || 0,
          tiersByProduct: tiersByProductLocal, overridesByVariant, discountPct, customerPct,
        });
      }

      function renderPackInfo() {
        const n = parseInt(packQtyInput.value, 10) || 0;
        const one = pricePack(1);
        const many = pricePack(n || 1);
        // Per PIECE, then the multiplier, then the total -- the order Hadi
        // asked for. The pack's own flat price, if the wholesaler set one, is
        // deliberately not shown: it is not what anyone is charged (D4).
        const perPiece = `${money(one.unitPrice, currency)}${one.isBlended ? " avg" : ""} per piece`;
        info.innerHTML = `
          <div style="font-weight:600;">${esc(pack.name)}${pack.color ? ` — ${esc(pack.color)}` : ""}</div>
          <div style="color:var(--text-tertiary);">${esc(breakdown)}</div>
          <div style="margin-top:2px;">
            <strong>${perPiece}</strong>
            <span class="badge badge-neutral pc-multiplier" title="One pack is ${pack.unitCount} pieces.">×${pack.unitCount}</span>
            ${n > 0 ? `<span style="color:var(--text-secondary);">= ${money(many.lineTotal, currency)} for ${pack.unitCount * n} pieces</span>` : ""}
          </div>
        `;
      }

      const packQtyInput = document.createElement("input");
      packQtyInput.type = "number"; packQtyInput.className = "input"; packQtyInput.min = "0"; packQtyInput.value = "0";
      packQtyInput.style.width = "56px";
      packQtyInput.setAttribute("aria-label", `How many of ${pack.name}`);
      packQtyInput.addEventListener("input", renderPackInfo);

      // Batch 5 follow-up. The plan sketched this row as
      //     [ − ]   1 pack   [ + ]         = $54.00
      // and it shipped with a bare number field. The open-stock stepper got
      // real buttons and this did not, which left the two ways of buying
      // behaving differently for no reason a buyer could see -- and left the
      // pack row without a 44px tap target on a phone.
      function stepPack(delta) {
        const now = parseInt(packQtyInput.value, 10) || 0;
        packQtyInput.value = String(Math.max(0, now + delta));
        renderPackInfo();
      }
      const packMinus = document.createElement("button");
      packMinus.type = "button";
      packMinus.className = "btn btn-secondary btn-sm pc-step pc-step-pack";
      packMinus.textContent = "−";
      packMinus.setAttribute("aria-label", `One less ${pack.name}`);
      packMinus.addEventListener("click", () => stepPack(-1));
      const packPlus = document.createElement("button");
      packPlus.type = "button";
      packPlus.className = "btn btn-secondary btn-sm pc-step pc-step-pack";
      packPlus.textContent = "+";
      packPlus.setAttribute("aria-label", `One more ${pack.name}`);
      packPlus.addEventListener("click", () => stepPack(1));
      const addPackBtn = document.createElement("button");
      addPackBtn.className = "btn btn-primary btn-sm";
      addPackBtn.textContent = "Add pack";
      addPackBtn.addEventListener("click", async () => {
        const n = parseInt(packQtyInput.value, 10) || 0;
        if (n <= 0) { toast("Enter how many packs", { type: "danger" }); return; }
        addPackBtn.disabled = true;
        // productId is passed so the line can be counted toward this product's
        // quantity break -- see cart.addPack and cartQtyForProduct above.
        const result = await cart.addPack(wid, pack, n, locationId, undefined, { productId: product.id });
        addPackBtn.disabled = false;
        if (!result.ok) {
          toast(result.sku ? `Not enough stock for ${result.sku} in this pack` : "Could not add pack — insufficient stock", { type: "danger" });
          return;
        }
        const priced = pricePack(n);
        toast(`${n}× ${pack.name} added — ${pack.unitCount * n} pieces, ${money(priced.lineTotal, currency)}`, { type: "success" });
        packQtyInput.value = "0";
        renderPackInfo();
        // The header price can change once a pack pushes the cart over a
        // quantity break, so it is repainted rather than left stale.
        renderHeader();
        if (onCartChange) onCartChange();
      });
      renderPackInfo();
      row.appendChild(packMinus);
      row.appendChild(packQtyInput);
      row.appendChild(packPlus);
      row.appendChild(addPackBtn);
      packSection.appendChild(row);
    });
    el.appendChild(packSection);
  }

  function variantFor(color, size) {
    return product.variants.find((v) => v.color === color && v.size === size);
  }

  function renderSwatches() {
    swatchRow.innerHTML = "";
    product.colors.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.title = c.name;
      // Same reason: a stable hook so CSS can expand the tap area on touch
      // without fighting the inline width/height below.
      sw.className = "color-swatch";
      const active = c.name === selectedColor;
      sw.style.cssText = `width:26px;height:26px;border-radius:50%;background:${c.hex};cursor:pointer;border:2px solid ${active ? "var(--accent-500)" : "transparent"};box-shadow:0 0 0 1px var(--border-default);`;
      sw.addEventListener("click", () => {
        selectedColor = c.name;
        renderSwatches();
        renderSizes();
        // Rule 1 of the photo block above: the picture follows the swatch.
        renderPhoto();
      });
      swatchRow.appendChild(sw);
    });
  }

  // ===========================================================================
  // THE ORDER SHEET                                          (CV-01, 25 Aug)
  // ===========================================================================
  // Hadi, 25 Aug 2026, choosing between two rebuilds of the buyer screen:
  //   "the matrix style ... the colors in a table vertically and the sizes in
  //    the table horizontally."
  //
  // WHAT THIS REPLACES, and why the old shape was wrong.
  //
  // Before today a buyer picked ONE colour, then ONE size, and a stepper
  // appeared. Everything about the order except the cell you were standing on
  // was invisible. On a four-colour product that is sixteen separate visits to
  // find out what you had ordered, and the size labels were reprinted under
  // every colour so nothing lined up into a column the eye could follow.
  //
  // The sheet answers the question a wholesale buyer actually asks -- "what
  // have I taken, and in what spread" -- because the numbers now sit in
  // columns. Forty 32s against twelve 36s is visible without adding anything
  // up. That is also why the per-size totals along the bottom exist.
  //
  // THE ONE CONTROL. Cells are not steppers. A cell wide enough to hold
  // "- 12 +" is a cell too wide for eight sizes on a phone, and a row of
  // sixty-four tiny buttons is the wall CR-0001 has just finished deleting
  // from the wholesaler's side. So a cell is a NUMBER you tap to aim at, and
  // one large control at the foot -- which never moves, so the thumb never
  // hunts -- changes whichever cell is aimed at.
  //
  // WHAT IS DELIBERATELY UNCHANGED: the control still commits explicitly.
  // Every quantity change releases and re-reserves stock server-side
  // (cart.js), so a sheet that wrote on every press would fire two round trips
  // per tap. Auto-commit needs a debounce and a rollback path, and that is its
  // own change with its own gate -- not something to smuggle in behind a
  // layout rewrite.
  // ===========================================================================
  function cellQty(variant) {
    const line = cart.get(wid).find((l) => l.variantId === variant.id);
    return line ? line.qty : 0;
  }

  let aimed = null;                 // the variant the foot control is pointing at
  const sheet = document.createElement("div");
  sheet.className = "os-sheet";
  const sheetScroll = document.createElement("div");
  sheetScroll.className = "os-sheet-scroll";
  const grid = document.createElement("table");
  grid.className = "os-grid";
  sheetScroll.appendChild(grid);
  sheet.appendChild(sheetScroll);
  const pad = document.createElement("div");
  pad.className = "os-pad";
  sheet.appendChild(pad);
  sizeRow.appendChild(sheet);
  // The slot was a flex row of chips; the sheet is a block. Reset it rather
  // than leaving the old layout to squeeze the table.
  sizeRow.style.cssText = "display:block;margin-top:2px;";

  /** Every size this product has, in the order the catalogue gave them --
   *  NOT per colour. A column has to mean the same thing on every row or the
   *  grid stops being a grid. */
  const allSizes = [...new Set(product.variants.map((v) => v.size).filter(Boolean))];

  function variantAt(colour, size) {
    return product.variants.find((v) => v.color === colour && v.size === size);
  }

  function renderSizes() {
    // Name kept. Fifteen-odd call sites and two gates already say renderSizes,
    // and renaming a function to describe its new drawing is how a rename
    // turns into a regression. It draws the sheet now.
    if (isBundleOnly) { sheet.innerHTML = ""; return; }
    grid.innerHTML = "";

    const thead = document.createElement("thead");
    thead.innerHTML = `<tr><th class="os-cch">Colour</th>${
      allSizes.map((sz) => `<th data-size="${esc(sz)}">${esc(sz)}</th>`).join("")
    }<th class="os-tch">Total</th></tr>`;
    grid.appendChild(thead);

    const tbody = document.createElement("tbody");
    product.colors.forEach((c) => {
      const tr = document.createElement("tr");
      tr.dataset.colour = c.name;
      const photo = photosFor(c.name)[0];
      const head = document.createElement("td");
      head.className = "os-cc";
      head.innerHTML = `<div class="os-ccwrap">${
        photo ? `<img src="${esc(photo)}" alt="" class="os-cthumb">`
              : `<span class="os-cdot" style="background:${esc(c.hex)}"></span>`
      }<span class="os-cname">${esc(c.name)}</span></div>`;
      // The thumbnail is the swatch's job too: tapping a colour's picture sets
      // the hero, so the big image follows what the buyer just looked at.
      const th = head.querySelector(".os-cthumb");
      if (th) th.addEventListener("click", () => { selectedColor = c.name; renderPhoto(); });
      tr.appendChild(head);

      allSizes.forEach((sz) => {
        const v = variantAt(c.name, sz);
        const td = document.createElement("td");
        td.className = "os-cell";
        if (!v) {
          // This colour is not made in this size. Blank, and unaimable --
          // never a zero, which would read as "available, none taken".
          td.classList.add("os-none");
          td.textContent = "";
          td.setAttribute("aria-label", `${c.name} is not made in size ${sz}`);
        } else {
          const q = cellQty(v);
          td.textContent = String(q);
          td.dataset.variantId = v.id;
          if (q > 0) td.classList.add("os-has");
          if (v.available <= 0) {
            // Out of stock stays VISIBLE and unaimable. Hiding it would let a
            // buyer think the size does not exist; the server would refuse the
            // line anyway, so offering it is worse than showing it greyed.
            td.classList.add("os-out");
            td.setAttribute("aria-label", `${c.name} size ${sz} is out of stock`);
          } else {
            td.setAttribute("role", "button");
            td.setAttribute("tabindex", "0");
            td.setAttribute("aria-label", `${c.name}, size ${sz}, ${q} pieces. Tap to change.`);
            const aim = () => { aimed = v; selectedColor = c.name; renderSizes(); renderPhoto(); };
            td.addEventListener("click", aim);
            td.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); aim(); } });
          }
          if (aimed && aimed.id === v.id) td.classList.add("os-aim");
        }
        tr.appendChild(td);
      });

      const total = allSizes.reduce((sum, sz) => {
        const v = variantAt(c.name, sz);
        return sum + (v ? cellQty(v) : 0);
      }, 0);
      const rt = document.createElement("td");
      rt.className = "os-rt";
      rt.textContent = String(total);
      // The per-colour minimum, on the colour it is about. The server enforces
      // it in v2_enforce_selling_model; a buyer used to meet the product MOQ,
      // press submit, and be refused by a rule no screen had mentioned.
      if (product.moqPerColour && total > 0 && total < product.moqPerColour) {
        rt.classList.add("os-short");
        rt.title = `Add ${product.moqPerColour - total} more in ${c.name} — minimum ${product.moqPerColour} per colour`;
      }
      tr.appendChild(rt);
      tbody.appendChild(tr);
    });
    grid.appendChild(tbody);

    // Per-size totals. The reason the columns were worth building: a buyer can
    // see they have taken forty 32s and twelve 36s without adding it up.
    const tfoot = document.createElement("tfoot");
    let grand = 0;
    const cells = allSizes.map((sz) => {
      const n = product.colors.reduce((sum, c) => {
        const v = variantAt(c.name, sz);
        return sum + (v ? cellQty(v) : 0);
      }, 0);
      grand += n;
      return `<td data-total-size="${esc(sz)}">${n}</td>`;
    }).join("");
    tfoot.innerHTML = `<tr><td class="os-cc">Per size</td>${cells}<td class="os-gt" data-grand>${grand}</td></tr>`;
    grid.appendChild(tfoot);

    sheetScroll.classList.toggle("os-wide", allSizes.length > 5);
    renderPad();
  }

  function renderPad() {
    pad.innerHTML = "";
    if (!aimed) {
      pad.className = "os-pad os-pad-idle";
      pad.innerHTML = `<div class="os-what"><b>Tap a box above</b><span>then use + and − here</span></div>`;
      return;
    }
    pad.className = "os-pad";
    const variant = aimed;
    const maxWhole = baseUnit > 1 ? Math.floor(variant.available / baseUnit) * baseUnit : variant.available;
    let draft = cellQty(variant);

    const what = document.createElement("div");
    what.className = "os-what";
    const minus = document.createElement("button");
    minus.type = "button"; minus.className = "btn os-step"; minus.textContent = "−";
    minus.setAttribute("aria-label", baseUnit > 1 ? `Remove ${baseUnit} pieces` : "Remove one piece");
    const val = document.createElement("div");
    val.className = "os-val";
    const plus = document.createElement("button");
    plus.type = "button"; plus.className = "btn os-step"; plus.textContent = "+";
    plus.setAttribute("aria-label", baseUnit > 1 ? `Add ${baseUnit} pieces` : "Add one piece");
    const commit = document.createElement("button");
    commit.className = "btn btn-primary btn-sm os-commit";

    const feedback = document.createElement("div");
    feedback.className = "os-feedback";

    function paint() {
      what.innerHTML = `<b>${esc(variant.color || "")} · size ${esc(variant.size || "")}</b>` +
        `<span>${baseUnit > 1 ? `each press is ${baseUnit} pieces · ` : ""}${variant.available} available${
          variant.retailPrice ? ` · MSRP ${money(variant.retailPrice, currency)}${
            marginPct(variant.price, variant.retailPrice) != null ? ` (${marginPct(variant.price, variant.retailPrice)}% margin)` : ""}` : ""}</span>`;
      val.textContent = String(draft);
      minus.disabled = draft <= 0;
      commit.textContent = cellQty(variant) > 0 ? "Update" : "Add to cart";
      commit.disabled = draft === cellQty(variant);

      // The same live feedback the old stepper gave, unchanged in substance:
      // price and its source, the multiplication written out, every minimum the
      // server will enforce, and the next quantity break as a nudge.
      const otherQty = cartQtyForProduct(wid, product) - cellQty(variant);
      const aggQty = otherQty + draft;
      const lines = [];
      if (draft > 0) {
        const { price, listPrice, source } = effectivePrice({
          basePrice: variant.price, productId: product.id, variantId: variant.id,
          aggregateQty: aggQty, tiersByProduct: tiersByProductLocal, overridesByVariant,
          discountPct, customerPct,
        });
        const label = source === "override" ? "your price" : source === "tier" ? "tier price" : "price";
        const shown = listPrice > price
          ? `<s class="pc-was">${money(listPrice, currency)}</s> <strong>${money(price, currency)}</strong>`
          : money(price, currency);
        lines.push(`<div>${shown} per piece (${label})</div>`);
        lines.push(`<div><strong>${draft}</strong> pieces${baseUnit > 1 ? ` <span class="pc-multiplier">(${draft / baseUnit} × ${baseUnit})</span>` : ""} = <strong>${money(round2(price * draft), currency)}</strong></div>`);
        const skuMoq = variantMoqStatus(variant, draft);
        if (!skuMoq.met) lines.push(`<div class="os-warn">Add ${skuMoq.short} more of this SKU (min ${skuMoq.required})</div>`);
        const prodMoq = productMoqStatus(product, aggQty, isReorder);
        if (!prodMoq.met) lines.push(`<div class="os-warn">Add ${prodMoq.short} more of this product, any colour/size (min ${prodMoq.required})</div>`);
      }
      const nt = nextTier(tiers, aggQty);
      if (nt) lines.push(`<div class="os-nudge">Add ${nt.minQty - aggQty} more pieces (any colour/size) to reach ${money(nt.unitPrice, currency)} each</div>`);
      if (product.moqPerColour) {
        const thisColour = allSizes.reduce((sum, sz) => {
          const v2 = variantAt(variant.color, sz);
          if (!v2) return sum;
          return sum + (v2.id === variant.id ? draft : cellQty(v2));
        }, 0);
        if (thisColour > 0 && thisColour < product.moqPerColour) {
          lines.push(`<div class="os-warn">Add ${product.moqPerColour - thisColour} more in ${esc(variant.color)} (min ${product.moqPerColour} per colour)</div>`);
        }
      }
      feedback.innerHTML = lines.join("");
    }

    function step(delta) {
      const next = Math.max(0, Math.min(draft + delta * baseUnit, maxWhole || variant.available));
      draft = next;
      paint();
    }
    minus.addEventListener("click", () => step(-1));
    plus.addEventListener("click", () => step(1));

    commit.addEventListener("click", async () => {
      const otherQty = cartQtyForProduct(wid, product) - cellQty(variant);
      const { price } = effectivePrice({
        basePrice: variant.price, productId: product.id, variantId: variant.id,
        aggregateQty: otherQty + draft, tiersByProduct: tiersByProductLocal, overridesByVariant,
        discountPct, customerPct,
      });
      commit.disabled = true;
      const result = await cart.setLineQty(wid, {
        variantId: variant.id, productId: product.id, locationId, productName: product.name,
        color: variant.color, colorHex: variant.colorHex, size: variant.size, price,
        listPrice: variant.price,
      }, draft);
      commit.disabled = false;
      if (!result.ok) {
        toast(`Only ${variant.available} available in ${variant.color} / ${variant.size}`, { type: "danger" });
        return;
      }
      toast(draft > 0 ? `Cart updated — ${product.name} (${variant.color}, ${variant.size})` : "Removed from cart", { type: "success" });
      if (draft > 0) flyToCart({ sourceEl: commit, color: variant.colorHex });
      // The sheet is the record of the order, so it is repainted from the cart
      // rather than trusted to still match it.
      renderSizes();
      renderHeader();
      if (onCartChange) onCartChange();
    });

    pad.appendChild(what);
    pad.appendChild(minus);
    pad.appendChild(val);
    pad.appendChild(plus);
    pad.appendChild(commit);
    pad.appendChild(feedback);
    paint();
  }

  renderSwatches();
  renderSizes();
  renderPhoto();

  return el;
}

