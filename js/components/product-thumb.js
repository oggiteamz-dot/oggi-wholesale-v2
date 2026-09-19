// =============================================================================
// OGGI Wholesale v2 — PRODUCT THUMBNAIL                          19 Sep 2026
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Hadi, twice, about My Orders: show the image of the actual product ordered.
// He named it a gate, so it is one — checks/check_ordered_lines_show_a_picture.mjs
// fails the build if an ordered line ever renders without a picture.
//
// It is ONE component rather than a copy per screen, for the reason this
// repo's own README gives: "Duplicated helpers do not stay identical. They
// wait." A thumbnail appears on the buyer's My Orders, the wholesaler's
// Orders, the picking sheet and the reorder rail; four copies would drift into
// four different answers to "what does a missing photo look like".
//
// THE THREE RULES, taken from js/components/product-card.js so that a
// thumbnail and a product card fail the same way:
//
//   1. THE BOX NEVER CHANGES SIZE. The frame is reserved before the image
//      loads, so a row does not jump under a reader's thumb when photography
//      arrives — the layout shift that makes people tap the wrong thing.
//   2. ABSENT AND BROKEN LOOK THE SAME, AND BOTH LOOK DELIBERATE. A dead
//      storage URL falls back to the same honest placeholder as no photo at
//      all, never a broken-image icon.
//   3. IT IS THIS VARIANT'S PHOTOGRAPH OR NONE. Never a sibling's. A buyer
//      who ordered the black jean is not shown the brown one; CR-0004 removed
//      exactly that fallback from the product card on 25 Aug, and migration
//      141 keeps it out of the data. Hadi, that day: "if it's not available,
//      then it's not available from my client's side."
//
// The placeholder is tinted with the variant's own colour hex when there is
// one, so a row of unphotographed items still reads as a row of different
// garments rather than a row of identical grey squares.
// =============================================================================

import { esc } from "../lib/utils.js";

/** A short, stable label for a product with no photograph. Initials rather
 *  than a truncated name: "Insulated Work Jacket" and "Insulated Work Pant"
 *  truncate to the same string and would read as the same product. */
function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * @param {object}  o
 * @param {string?} o.imageUrl   this variant's photograph, or null
 * @param {string}  o.productName
 * @param {string?} o.color      colour NAME, for the alt text and the title
 * @param {string?} o.colorHex   colour HEX, to tint the placeholder
 * @param {string?} o.variantSize the garment size ("M", "32") — not pixels
 * @param {number?} o.qty        badged bottom-right when > 0
 * @param {number}  o.px         the side of the square, default 56
 * @param {Function?} o.onClick  makes it a button; omitted leaves it inert
 * @returns {HTMLElement}
 */
export function productThumb({
  imageUrl = null,
  productName = "",
  color = null,
  colorHex = null,
  variantSize = null,
  qty = 0,
  px = 56,
  onClick = null,
} = {}) {
  const el = document.createElement(onClick ? "button" : "div");
  el.className = "p-thumb";
  if (onClick) {
    el.type = "button";
    el.addEventListener("click", onClick);
  }

  // The frame, reserved before anything loads. Rule 1.
  el.style.cssText =
    `position:relative;flex:none;width:${px}px;height:${px}px;border-radius:10px;` +
    `overflow:hidden;border:1px solid var(--line-hair,rgba(0,0,0,.08));` +
    `background:var(--bg-sunken,#F3F4F4);padding:0;display:block;` +
    (onClick ? "cursor:pointer;" : "");

  // The full description lives on the element, not only in the picture, so a
  // screen reader and a hover both get the whole line.
  const described = [productName, color, variantSize].filter(Boolean).join(" · ");
  el.title = described;

  // ---- the placeholder ----------------------------------------------------
  // Rendered first and replaced on a successful load, so there is never an
  // instant of empty frame and never a broken-image glyph. Rule 2.
  const hex = colorHex && /^#[0-9a-fA-F]{3,8}$/.test(colorHex) ? colorHex : "#c9d3cd";
  const placeholder = document.createElement("div");
  placeholder.className = "p-thumb-empty";
  placeholder.setAttribute("data-thumb", "placeholder");
  placeholder.style.cssText =
    `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;` +
    `background:linear-gradient(155deg, ${hex}2e, ${hex}0d);` +
    `font-size:${Math.max(10, Math.round(px * 0.26))}px;font-weight:700;letter-spacing:.02em;` +
    `color:var(--fg-2,#5c6b66);`;
  placeholder.textContent = initialsOf(productName);
  el.appendChild(placeholder);

  if (imageUrl) {
    const img = document.createElement("img");
    img.setAttribute("data-thumb", "image");
    img.alt = described || "Product photo";
    img.loading = "lazy";
    img.decoding = "async";
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;" +
      "transition:opacity 180ms ease;";
    // The placeholder stays underneath until the pixels are actually there, so
    // a slow image reveals rather than flashes.
    img.addEventListener("load", () => { img.style.opacity = "1"; });
    // Rule 2: a dead URL is not an error state, it is the no-photo state.
    img.addEventListener("error", () => {
      img.remove();
      el.setAttribute("data-thumb-failed", "1");
    });
    img.src = imageUrl;
    el.appendChild(img);
  }

  // ---- the quantity badge -------------------------------------------------
  // On the thumbnail rather than beside it, because the eye reads the picture
  // first and the number has to arrive with it. Shopify, Squarespace and
  // Programa all put it here.
  if (qty > 0) {
    const badge = document.createElement("span");
    badge.className = "p-thumb-qty";
    badge.textContent = qty > 999 ? "999+" : String(qty);
    badge.style.cssText =
      "position:absolute;right:3px;bottom:3px;min-width:18px;height:18px;padding:0 5px;" +
      "border-radius:9px;background:var(--brand-ink,#0b1f1a);color:#fff;font-size:11px;" +
      "font-weight:700;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;" +
      "box-shadow:0 0 0 1.5px var(--bg-surface,#fff);";
    el.appendChild(badge);
  }

  return el;
}

/**
 * A row of thumbnails for a list of ordered lines, with an overflow chip.
 *
 * Twenty-nine of one jean and twenty-nine of another is five thumbnails and
 * "+3", not twenty-nine squares: the point of the row is to recognise the
 * order at a glance, and past about six tiles recognition gets worse rather
 * than better.
 *
 * @param {Array}  lines  order items ({ imageUrl, productName, color, size, qty })
 * @param {object} o      { max = 6, px = 56, onLineClick }
 */
export function productThumbRow(lines, { max = 6, px = 56, onLineClick = null } = {}) {
  const row = document.createElement("div");
  row.className = "p-thumb-row";
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;";

  const list = Array.isArray(lines) ? lines : [];
  list.slice(0, max).forEach((line) => {
    // A pack collapses to one display line with its components underneath
    // (groupPackLines). Show the first component's photograph — it is a real
    // photograph of something genuinely in the box, which a generic pack icon
    // is not.
    const face = line.isPack && line.components?.length ? line.components[0] : line;
    row.appendChild(productThumb({
      imageUrl: face.imageUrl || null,
      productName: line.productName,
      color: face.color,
      colorHex: line.colorHex || face.colorHex || null,
      variantSize: face.size,
      qty: line.isPack ? line.packQty : line.qty,
      px,
      onClick: onLineClick ? () => onLineClick(line) : null,
    }));
  });

  if (list.length > max) {
    const more = document.createElement("span");
    more.className = "p-thumb-more";
    more.textContent = `+${list.length - max}`;
    more.style.cssText =
      `flex:none;height:${px}px;min-width:${px}px;padding:0 10px;border-radius:10px;` +
      "display:flex;align-items:center;justify-content:center;" +
      "background:var(--bg-sunken,#F3F4F4);border:1px solid var(--line-hair,rgba(0,0,0,.08));" +
      "font-size:12px;font-weight:600;color:var(--fg-2,#5c6b66);";
    more.title = `${list.length - max} more item${list.length - max === 1 ? "" : "s"} in this order`;
    row.appendChild(more);
  }

  return row;
}

/** True when this line can be drawn as a picture at all — i.e. the renderer
 *  has something to put in the frame, whether a photograph or the deliberate
 *  placeholder. Exported so the gate and the views agree on one definition
 *  rather than each having its own. */
export function lineIsRenderable(line) {
  return !!(line && (line.productName || line.sku || line.imageUrl));
}

export { esc };
