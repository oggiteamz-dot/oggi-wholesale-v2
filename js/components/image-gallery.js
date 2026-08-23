// OGGI Wholesale v2 — product thumbnails and a scrollable gallery (Batch 18)
//
// Hadi: "whenever the product is created, I want it to have a thumbnail. To
// have the actual image and a scrollable image, so we can see all the
// different images."
//
// Photos were being uploaded and attached to variants from Batch 16 onward and
// then never shown again -- every product list was text. For a clothing
// catalogue that is close to useless: a wholesaler recognises a style by
// looking at it, not by reading "Denim Utility Jacket" among forty other rows
// that also say jacket.
//
// Images live on VARIANTS (image_url and the images[] array added in Batch 13),
// not on products, because a colourway has its own photograph. So a product's
// gallery is the union of its variants' images, deduplicated -- the same photo
// is usually attached to every variant created in one go by the builder, and
// showing it eight times would be worse than showing it once.

import { esc } from "../lib/utils.js";
import { openModal, closeModal } from "../lib/modal-stack.js";

/** Collect a product's distinct images from its variants, main one first. */
export function imagesForVariants(variants) {
  const seen = new Set();
  const out = [];
  (variants || []).forEach((v) => {
    const list = [v.image_url, ...(Array.isArray(v.images) ? v.images : [])];
    list.forEach((url) => {
      const u = String(url || "").trim();
      if (!u || seen.has(u)) return;
      seen.add(u);
      out.push(u);
    });
  });
  return out;
}

/** A thumbnail that opens the gallery. Returns an element either way -- a
 *  product with no photos gets a neutral placeholder rather than a ragged row,
 *  because a missing image should not change the shape of the list. */
export function productThumb(images, label) {
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "prod-thumb";
  wrap.setAttribute("aria-label", images.length
    ? `View ${images.length} photo${images.length === 1 ? "" : "s"} of ${label || "this product"}`
    : `${label || "This product"} has no photos yet`);

  if (!images.length) {
    wrap.classList.add("prod-thumb-empty");
    wrap.innerHTML = `<span aria-hidden="true">🧵</span>`;
    wrap.disabled = true;
    return wrap;
  }

  wrap.innerHTML = `<img src="${esc(images[0])}" alt="" loading="lazy">` +
    (images.length > 1 ? `<span class="prod-thumb-count">${images.length}</span>` : "");
  wrap.addEventListener("click", (ev) => {
    ev.stopPropagation();     // the row itself may be clickable
    openGallery(images, 0, label);
  });
  return wrap;
}

/** Full-screen, swipeable/scrollable gallery. */
export function openGallery(images, startIndex = 0, label = "") {
  if (!images || !images.length) return null;
  let index = Math.max(0, Math.min(startIndex, images.length - 1));

  const overlay = document.createElement("div");
  overlay.className = "gallery";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label ? `Photos of ${label}` : "Product photos");
  overlay.innerHTML = `
    <div class="gallery-bar">
      <span class="gallery-title">${esc(label || "Photos")}</span>
      <span class="gallery-count" data-count></span>
      <button type="button" class="btn btn-secondary btn-sm" data-close>Close</button>
    </div>
    <div class="gallery-stage" data-stage>
      ${images.map((u, i) => `<img src="${esc(u)}" alt="Photo ${i + 1}" loading="lazy">`).join("")}
    </div>
    <div class="gallery-strip" data-strip></div>
  `;

  const stage = overlay.querySelector("[data-stage]");
  const strip = overlay.querySelector("[data-strip]");
  const count = overlay.querySelector("[data-count]");

  function paintCount() { count.textContent = `${index + 1} of ${images.length}`; }

  function goTo(i, smooth = true) {
    index = Math.max(0, Math.min(i, images.length - 1));
    const target = stage.children[index];
    if (target) {
      // scrollIntoView on a horizontally scrolling parent moves the PAGE too
      // in some browsers; setting scrollLeft keeps the movement inside the
      // strip where it belongs.
      stage.scrollTo({ left: target.offsetLeft - stage.offsetLeft, behavior: smooth ? "smooth" : "auto" });
    }
    paintCount();
    [...strip.children].forEach((b, i2) => b.classList.toggle("is-active", i2 === index));
  }

  if (images.length > 1) {
    images.forEach((u, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gallery-thumb" + (i === index ? " is-active" : "");
      b.setAttribute("aria-label", `Photo ${i + 1}`);
      b.innerHTML = `<img src="${esc(u)}" alt="" loading="lazy">`;
      b.addEventListener("click", () => goTo(i));
      strip.appendChild(b);
    });
  }

  // Keep the counter honest when the person swipes the stage directly, which
  // is what they will actually do on a phone.
  stage.addEventListener("scroll", () => {
    const w = stage.clientWidth || 1;
    const at = Math.round(stage.scrollLeft / w);
    if (at !== index) {
      index = Math.max(0, Math.min(at, images.length - 1));
      paintCount();
      [...strip.children].forEach((b, i2) => b.classList.toggle("is-active", i2 === index));
    }
  }, { passive: true });

  // Batch 8A. Escape, the scroll lock and closing-on-navigation are the modal
  // stack's. The arrow keys are NOT -- they are this viewer's own behaviour,
  // so that listener stays and is removed in onClose.
  const close = () => closeModal(overlay);
  function onKey(ev) {
    if (ev.key === "ArrowRight") goTo(index + 1);
    else if (ev.key === "ArrowLeft") goTo(index - 1);
  }

  overlay.querySelector("[data-close]").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  openModal(overlay, {
    label: "Photo viewer",
    onClose: () => document.removeEventListener("keydown", onKey),
  });
  paintCount();
  goTo(index, false);
  return overlay;
}
