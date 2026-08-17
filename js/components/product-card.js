// OGGI Wholesale v2 — buyer catalog product card (Batch 2)
// One card per product. Colour swatches select a colour; a size grid then
// appears for that colour with per-size availability; qty stepper adds/
// updates the cart line for the selected variant directly (in-place, no
// delete-and-re-add -- the #1 buyer complaint fixed per Research 3).

import { cart } from "../data/cart.js";
import { toast } from "./toast.js";
import { tierForQty, nextTier, effectivePrice, productMoqStatus, variantMoqStatus, marginPct } from "../data/pricing.js";
import { flyToCart } from "../lib/animations/fly-to-cart.js";
import { openHologramModal } from "../lib/animations/product-hologram.js";

import { esc, money } from "../lib/utils.js";
/** Sum of this product's qty already in the cart, across every colour/
 * size -- the "aggregated across colorways" basis for both tiered pricing
 * and product-level MOQ (Batch 6). */
function cartQtyForProduct(wid, product) {
  const variantIds = new Set(product.variants.map((v) => v.id));
  return cart.get(wid).filter((l) => variantIds.has(l.variantId)).reduce((s, l) => s + l.qty, 0);
}

export function renderProductCard({ product, wid, locationId, currency, tiers = [], overridesByVariant = new Map(), isReorder = false, packs = [], onCartChange }) {
  const el = document.createElement("div");
  el.className = "card product-card";
  el.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:10px;";

  let selectedColor = product.colors[0]?.name || null;

  const badges = [];
  if (product.isNew) badges.push('<span class="badge badge-info">New</span>');
  if (product.outOfStock) badges.push('<span class="badge badge-danger">Out of stock</span>');
  else if (product.lowStock) badges.push('<span class="badge badge-warning">Low stock</span>');
  const moqReq = isReorder && product.moqReorderQty != null ? product.moqReorderQty : product.moqQty;
  if (moqReq > 1) badges.push(`<span class="badge badge-neutral">Min ${moqReq}${isReorder ? " (reorder)" : ""}</span>`);

  const header = document.createElement("div");
  header.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">${badges.join("")}</div>
    <h4 style="margin-bottom:2px;">${esc(product.name)}</h4>
    <div style="color:var(--text-secondary);font-size:13px;">${
      product.minPrice === product.maxPrice ? money(product.minPrice, currency) : `${money(product.minPrice, currency)} – ${money(product.maxPrice, currency)}`
    }</div>
    ${tiers.length ? `<div style="font-size:11px;color:var(--accent-600,#2f6b4f);margin-top:2px;">${tiers.map((t) => `${t.minQty}+: ${money(t.unitPrice, currency)}/ea`).join(" · ")}</div>` : ""}
  `;
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
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${esc(pack.name)}${pack.color ? ` — ${esc(pack.color)}` : ""}</div>
          <div style="color:var(--text-tertiary);">${breakdown} (${pack.unitCount} units) · ${money(pack.price, currency)}/pack</div>
        </div>
      `;
      const packQtyInput = document.createElement("input");
      packQtyInput.type = "number"; packQtyInput.className = "input"; packQtyInput.min = "0"; packQtyInput.value = "0";
      packQtyInput.style.width = "56px";
      const addPackBtn = document.createElement("button");
      addPackBtn.className = "btn btn-primary btn-sm";
      addPackBtn.textContent = "Add pack";
      addPackBtn.addEventListener("click", async () => {
        const n = parseInt(packQtyInput.value, 10) || 0;
        if (n <= 0) { toast("Enter how many packs", { type: "danger" }); return; }
        addPackBtn.disabled = true;
        const result = await cart.addPack(wid, pack, n, locationId);
        addPackBtn.disabled = false;
        if (!result.ok) {
          toast(result.sku ? `Not enough stock for ${result.sku} in this pack` : "Could not add pack — insufficient stock", { type: "danger" });
          return;
        }
        toast(`${n}x ${pack.name} added — one line, ${pack.unitCount * n} units total`, { type: "success" });
        packQtyInput.value = "0";
        if (onCartChange) onCartChange();
      });
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
    qtyInput.value = String(existing?.qty || 0);
    qtyInput.style.width = "72px";

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary btn-sm";
    addBtn.textContent = existing ? "Update" : "Add to cart";

    // Batch 6: live "add N more to unlock $X/ea" / MOQ feedback as the
    // buyer types a qty, computed with the same tier/MOQ precedence the
    // server enforces at submit time (pricing.js mirrors migrations/010).
    const feedback = document.createElement("div");
    feedback.style.cssText = "font-size:11px;line-height:1.5;margin-top:4px;text-align:right;";
    const tiersByProductLocal = new Map([[product.id, tiers]]);

    function renderFeedback() {
      const typedQty = parseInt(qtyInput.value, 10) || 0;
      const otherVariantsQty = cartQtyForProduct(wid, product) - (existing?.qty || 0);
      const aggQty = otherVariantsQty + typedQty;

      const lines = [];
      if (typedQty > 0) {
        const { price, source } = effectivePrice({
          basePrice: variant.price, productId: product.id, variantId: variant.id,
          aggregateQty: aggQty, tiersByProduct: tiersByProductLocal, overridesByVariant,
        });
        const label = source === "override" ? "your price" : source === "tier" ? "tier price" : "price";
        lines.push(`<div>${money(price, currency)}/ea (${label})</div>`);

        const skuMoq = variantMoqStatus(variant, typedQty);
        if (!skuMoq.met) lines.push(`<div style="color:var(--warning-600,#a15c00);">Add ${skuMoq.short} more of this SKU (min ${skuMoq.required})</div>`);

        const prodMoq = productMoqStatus(product, aggQty, isReorder);
        if (!prodMoq.met) lines.push(`<div style="color:var(--warning-600,#a15c00);">Add ${prodMoq.short} more of this product, any colour/size (min ${prodMoq.required})</div>`);
      }
      const nt = nextTier(tiers, aggQty);
      if (nt) lines.push(`<div style="color:var(--accent-600,#2f6b4f);">Add ${nt.minQty - aggQty} more (any colour/size) to unlock ${money(nt.unitPrice, currency)}/ea</div>`);

      feedback.innerHTML = lines.join("");
    }

    qtyInput.addEventListener("input", renderFeedback);

    addBtn.addEventListener("click", async () => {
      const qty = parseInt(qtyInput.value, 10) || 0;
      const otherVariantsQty = cartQtyForProduct(wid, product) - (existing?.qty || 0);
      const { price } = effectivePrice({
        basePrice: variant.price, productId: product.id, variantId: variant.id,
        aggregateQty: otherVariantsQty + qty, tiersByProduct: tiersByProductLocal, overridesByVariant,
      });
      addBtn.disabled = true;
      const result = await cart.setLineQty(
        wid,
        {
          variantId: variant.id, productId: product.id, locationId, productName: product.name,
          color: variant.color, colorHex: variant.colorHex, size: variant.size, price,
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
      if (onCartChange) onCartChange();
    });

    stepperWrap.appendChild(qtyInput);
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

  return el;
}

