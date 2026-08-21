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
    // A partly-photographed range still shows a picture rather than a gap --
    // but only from this same product, never from a neighbour.
    return product.primaryImage ? [product.primaryImage] : [];
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
      row.appendChild(packQtyInput);
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

  function renderSizes() {
    sizeRow.innerHTML = "";
    footer.innerHTML = "";
    // Bundle-only products (series / prepack / ratio) get no per-size chips and
    // no quantity stepper -- the server refuses loose lines for them, so the
    // only honest control is the pack selector rendered further down.
    if (isBundleOnly) return;
    const sizesForColor = product.variants.filter((v) => v.color === selectedColor);
    sizesForColor.forEach((v) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = v.size;
      chip.disabled = v.available <= 0;
      const isSelected = chip.dataset.selected === "true";
      chip.className = "btn btn-sm " + (isSelected ? "btn-primary" : "btn-secondary");
      chip.style.opacity = v.available <= 0 ? "0.4" : "1";
      chip.addEventListener("click", () => {
        sizeRow.querySelectorAll("button").forEach((b) => b.classList.remove("btn-primary"));
        sizeRow.querySelectorAll("button").forEach((b) => b.classList.add("btn-secondary"));
        chip.classList.remove("btn-secondary");
        chip.classList.add("btn-primary");
        renderStepper(v);
      });
      sizeRow.appendChild(chip);
    });
  }

  function renderStepper(variant) {
    footer.innerHTML = "";
    const existing = cart.get(wid).find((l) => l.variantId === variant.id);
    const stepperWrap = document.createElement("div");
    stepperWrap.style.cssText = "display:flex;align-items:center;gap:8px;";

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.className = "input";
    qtyInput.min = "0";
    qtyInput.max = String(variant.available);
    qtyInput.step = String(baseUnit);
    qtyInput.value = String(existing?.qty || 0);
    qtyInput.style.width = "72px";
    qtyInput.setAttribute("aria-label", `Pieces of ${product.name} in ${variant.color}, size ${variant.size}`);

    // ---------------------------------------------------------------------
    // + and - , stepping by the product's base unit. Batch 5.
    //
    // Hadi, 20 Aug 2026: "Let's say the MOQ is 20 -- every single time they
    // click plus on the colour red they get 20 ... they see that there's a x12
    // or x20 next to it, which will be multiplied in the final total."
    //
    // The number in the box stays PIECES, not units, on purpose. Pieces are
    // what stock is counted in, what every MOQ is measured in, and what the
    // invoice lists -- so one number means one thing on every screen. What the
    // base unit changes is the STEP: pressing + adds a whole unit, and typing
    // a number that is not a whole one is rounded up rather than silently
    // accepted and then refused at checkout.
    //
    // Real buttons rather than the number input's own spinners: those spinners
    // are a few pixels tall, are absent on mobile Safari, and cannot be given
    // a base-unit step that a phone keyboard will respect.
    // ---------------------------------------------------------------------
    const maxWhole = baseUnit > 1 ? Math.floor(variant.available / baseUnit) * baseUnit : variant.available;

    function snap(n) {
      if (n <= 0) return 0;
      if (baseUnit <= 1) return Math.min(n, variant.available);
      return Math.min(Math.ceil(n / baseUnit) * baseUnit, maxWhole);
    }

    function step(delta) {
      const now = parseInt(qtyInput.value, 10) || 0;
      const next = Math.max(0, Math.min(now + delta * baseUnit, maxWhole || variant.available));
      qtyInput.value = String(next);
      renderFeedback();
    }

    const minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.className = "btn btn-secondary btn-sm pc-step";
    minusBtn.textContent = "−";
    minusBtn.setAttribute("aria-label", baseUnit > 1 ? `Remove ${baseUnit} pieces` : "Remove one piece");
    minusBtn.addEventListener("click", () => step(-1));

    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = "btn btn-secondary btn-sm pc-step";
    plusBtn.textContent = "+";
    plusBtn.setAttribute("aria-label", baseUnit > 1 ? `Add ${baseUnit} pieces` : "Add one piece");
    plusBtn.addEventListener("click", () => step(1));

    // Typing wins over the buttons, but a part-unit is corrected the moment
    // the buyer looks away -- with the reason said out loud, because a number
    // that changes itself and does not explain is worse than one that is
    // refused later.
    qtyInput.addEventListener("blur", () => {
      const typed = parseInt(qtyInput.value, 10) || 0;
      const snapped = snap(typed);
      if (snapped !== typed) {
        qtyInput.value = String(snapped);
        if (baseUnit > 1 && typed > 0) toast(`Sold in units of ${baseUnit} — rounded up to ${snapped} pieces`, { type: "info" });
        renderFeedback();
      }
    });

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary btn-sm";
    addBtn.textContent = existing ? "Update" : "Add to cart";

    // Batch 6: live "add N more to unlock $X/ea" / MOQ feedback as the
    // buyer types a qty, computed with the same tier/MOQ precedence the
    // server enforces at submit time (pricing.js mirrors migrations/010).
    const feedback = document.createElement("div");
    feedback.style.cssText = "font-size:11px;line-height:1.5;margin-top:4px;text-align:right;";

    function renderFeedback() {
      const typedQty = parseInt(qtyInput.value, 10) || 0;
      const otherVariantsQty = cartQtyForProduct(wid, product) - (existing?.qty || 0);
      const aggQty = otherVariantsQty + typedQty;

      const lines = [];
      if (typedQty > 0) {
        const { price, listPrice, source } = effectivePrice({
          basePrice: variant.price, productId: product.id, variantId: variant.id,
          aggregateQty: aggQty, tiersByProduct: tiersByProductLocal, overridesByVariant,
          discountPct, customerPct,
        });
        const label = source === "override" ? "your price" : source === "tier" ? "tier price" : "price";
        // The strikethrough appears only when the CUSTOMER's own discount is
        // doing something. A catalog-only discount shows one price and no
        // theatre, because the buyer was never meant to know it exists.
        const shown = listPrice > price
          ? `<s class="pc-was">${money(listPrice, currency)}</s> <strong>${money(price, currency)}</strong>`
          : money(price, currency);
        lines.push(`<div>${shown} per piece (${label})</div>`);
        // Batch 5: the multiplication the buyer was promised, written out.
        // The price on screen times the pieces IS the line total -- there is
        // no second arithmetic anywhere, which is the whole point of
        // checks/check_line_pricing.mjs.
        lines.push(`<div><strong>${typedQty}</strong> pieces${baseUnit > 1 ? ` <span class="pc-multiplier">(${typedQty / baseUnit} × ${baseUnit})</span>` : ""} = <strong>${money(round2(price * typedQty), currency)}</strong></div>`);

        const skuMoq = variantMoqStatus(variant, typedQty);
        if (!skuMoq.met) lines.push(`<div style="color:var(--warning-600,#a15c00);">Add ${skuMoq.short} more of this SKU (min ${skuMoq.required})</div>`);

        const prodMoq = productMoqStatus(product, aggQty, isReorder);
        if (!prodMoq.met) lines.push(`<div style="color:var(--warning-600,#a15c00);">Add ${prodMoq.short} more of this product, any colour/size (min ${prodMoq.required})</div>`);
      }
      const nt = nextTier(tiers, aggQty);
      if (nt) lines.push(`<div style="color:var(--accent-600,#2f6b4f);">Add ${nt.minQty - aggQty} more pieces (any colour/size) to reach ${money(nt.unitPrice, currency)} each</div>`);

      // Batch 5: the per-colour minimum the server enforces in
      // v2_enforce_selling_model (migration 063). It was invisible here, so a
      // buyer met the product MOQ, pressed submit, and was refused by a rule
      // no screen had mentioned.
      if (product.moqPerColour) {
        const thisColour = cart.get(wid)
          .filter((l) => !l.isPack && l.color === variant.color && product.variants.some((v) => v.id === l.variantId))
          .reduce((sum, l) => sum + (l.variantId === variant.id ? 0 : l.qty), 0) + typedQty;
        if (thisColour > 0 && thisColour < product.moqPerColour) {
          lines.push(`<div style="color:var(--warning-600,#a15c00);">Add ${product.moqPerColour - thisColour} more in ${esc(variant.color)} (min ${product.moqPerColour} per colour)</div>`);
        }
      }

      feedback.innerHTML = lines.join("");
    }

    qtyInput.addEventListener("input", renderFeedback);

    addBtn.addEventListener("click", async () => {
      // Snap here too, not only on blur: a buyer can type 7 and press Add
      // without the field ever losing focus.
      const qty = snap(parseInt(qtyInput.value, 10) || 0);
      qtyInput.value = String(qty);
      const otherVariantsQty = cartQtyForProduct(wid, product) - (existing?.qty || 0);
      const { price } = effectivePrice({
        basePrice: variant.price, productId: product.id, variantId: variant.id,
        aggregateQty: otherVariantsQty + qty, tiersByProduct: tiersByProductLocal, overridesByVariant,
        discountPct, customerPct,
      });
      addBtn.disabled = true;
      const result = await cart.setLineQty(
        wid,
        {
          variantId: variant.id, productId: product.id, locationId, productName: product.name,
          color: variant.color, colorHex: variant.colorHex, size: variant.size, price,
          // Batch 5: the variant's LIST price travels with the line so the
          // cart screen can re-price it without applying the discount twice.
          listPrice: variant.price,
        },
        qty
      );
      addBtn.disabled = false;
      if (!result.ok) {
        toast(`Only ${variant.available} available in ${variant.color} / ${variant.size}`, { type: "danger" });
        return;
      }
      toast(qty > 0 ? `Cart updated — ${product.name} (${variant.color}, ${variant.size})` : "Removed from cart", { type: "success" });
      addBtn.textContent = qty > 0 ? "Update" : "Add to cart";
      // Batch 13: fly-to-cart micro-interaction on a genuine add (never on
      // a qty-zero removal) -- purely additive feedback, the cart write
      // above has already succeeded by this point.
      if (qty > 0) flyToCart({ sourceEl: addBtn, color: variant.colorHex });
      renderFeedback();
      // Crossing a quantity break changes the price shown at the top of the
      // card, so it is repainted rather than left showing the old one.
      renderHeader();
      if (onCartChange) onCartChange();
    });

    stepperWrap.appendChild(minusBtn);
    stepperWrap.appendChild(qtyInput);
    stepperWrap.appendChild(plusBtn);
    stepperWrap.appendChild(addBtn);
    footer.appendChild(stepperWrap);
    const availNote = document.createElement("div");
    availNote.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-top:4px;text-align:right;";
    availNote.textContent = `${variant.available} available${variant.retailPrice ? ` · MSRP ${money(variant.retailPrice, currency)}${marginPct(variant.price, variant.retailPrice) != null ? ` (${marginPct(variant.price, variant.retailPrice)}% margin)` : ""}` : ""}`;
    footer.appendChild(availNote);
    footer.appendChild(feedback);
    renderFeedback();
  }

  renderSwatches();
  renderSizes();
  renderPhoto();

  return el;
}

