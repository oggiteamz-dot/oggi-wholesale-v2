// OGGI Wholesale v2 — "hologram" 360° product viewer (Batch 13)
//
// This is the feature the Feature Ledger calls out by name: designed once
// (the "Ben-10-Omnitrix idea") and never shipped, because it was waiting
// on real multi-angle product photography that was never delivered. That
// blocker is real — you cannot rotate through photos that don't exist —
// so this component is built to be honest about three real, distinct
// states rather than faking one:
//
//   2+ photos saved for a SKU (js/data/pricing-admin.js setVariantImages)
//     -> a REAL drag-to-rotate viewer: dragging left/right cycles through
//        the actual saved frames, exactly like a real product-photography
//        360 spin. A slow auto-preview loop plays when idle (paused
//        instantly on interaction) so the feature is discoverable.
//   1 photo saved
//     -> a single-image viewer with a real pointer-driven 3D tilt + a
//        holographic glare sheen that tracks the pointer. Genuinely
//        reactive, but never pretends to show an angle that wasn't
//        photographed.
//   0 photos saved (the current real state of every seed SKU in this
//   build, since no product photography exists yet in this dev database)
//     -> a generated on-brand placeholder silhouette, tinted with the
//        variant's real colour swatch hex, with the same tilt+sheen
//        treatment — so the wholesaler and buyer still get a premium,
//        working "hologram" feel today, with zero fabricated imagery.
//
// All three states share the same stage/sheen/border chrome so switching
// a SKU from 0 -> 1 -> many photos is a purely additive upgrade, never a
// different-looking feature.

import { prefersReducedMotion, watchReducedMotion } from "./motion-prefs.js";

import { esc } from "../utils.js";
const AUTO_ROTATE_INTERVAL_MS = 160;

function placeholderSilhouetteSvg(colorHex) {
  // A simple, generic garment silhouette (works reasonably for tops,
  // jackets, knitwear — the majority of this catalog) tinted with the
  // variant's real colour. Not a stand-in for real photography; an
  // honest "no photo yet" state that still looks intentional.
  const c = colorHex || "#9AA0C9";
  return `
    <svg viewBox="0 0 200 200" width="62%" height="62%" aria-hidden="true">
      <path fill="${esc(c)}" opacity="0.85" d="M100 12c-10 0-19 6-23 15l-27 10-22 26 16 20 18-12v101c0 9 7 16 16 16h44c9 0 16-7 16-16V71l18 12 16-20-22-26-27-10c-4-9-13-15-23-15z"/>
      <path fill="#ffffff" opacity="0.18" d="M100 12c-10 0-19 6-23 15l-27 10-22 26 16 20 18-12v10l38-49c8 0 8 0 0 0z"/>
    </svg>
  `;
}

/** Renders a self-contained hologram stage. Returns { el, destroy } —
 * callers that mount this into a modal (or any DOM that gets torn down)
 * MUST call destroy() to stop the auto-rotate interval and pointer
 * listeners; openHologramModal() below does this automatically. */
export function renderHologramStage({ images = [], colorHex, productName = "Product" } = {}) {
  const stage = document.createElement("div");
  stage.className = "v2-hologram-stage";
  stage.setAttribute("role", "img");
  stage.setAttribute("aria-label", `360-degree view of ${productName}`);

  const sheen = document.createElement("div");
  sheen.className = "v2-hologram-sheen";
  const border = document.createElement("div");
  border.className = "v2-hologram-border";

  let reduced = prefersReducedMotion();
  let destroyed = false;
  let autoRotateTimer = null;
  let frameIndex = 0;

  const cleanupFns = [];
  const unwatchMotion = watchReducedMotion((matches) => {
    reduced = matches;
    if (reduced) stopAutoRotate();
    else if (images.length >= 2) startAutoRotate();
  });
  cleanupFns.push(unwatchMotion);

  function stopAutoRotate() {
    if (autoRotateTimer) { clearInterval(autoRotateTimer); autoRotateTimer = null; }
  }
  function startAutoRotate() {
    if (reduced || images.length < 2 || autoRotateTimer) return;
    autoRotateTimer = setInterval(() => {
      if (!stage.isConnected) { stopAutoRotate(); return; }
      frameIndex = (frameIndex + 1) % images.length;
      renderFrame();
    }, AUTO_ROTATE_INTERVAL_MS);
  }

  let visual; // the img or placeholder element that receives tilt transforms
  let hint;
  // Declared in this outer scope (not inside the `if` block below) on
  // purpose: startAutoRotate()'s setInterval callback is defined up here
  // too, and a block-scoped `function renderFrame(){}` inside the `if`
  // would NOT be visible to that callback's closure (real bug caught
  // during Batch 13's own review — see the deploy record) even though it
  // would have looked correct at a glance and only thrown once the
  // interval actually fired for a 2+-photo product.
  let renderFrame = () => {};

  if (images.length >= 2) {
    visual = document.createElement("img");
    visual.className = "v2-hologram-frame";
    visual.draggable = false;
    visual.alt = `${productName} — angle ${frameIndex + 1} of ${images.length}`;
    stage.appendChild(visual);

    renderFrame = function () {
      visual.src = images[frameIndex].url;
      visual.alt = `${productName} — angle ${frameIndex + 1} of ${images.length}`;
    };
    renderFrame();

    let dragging = false;
    let dragStartX = 0;
    let dragStartFrame = 0;
    const PX_PER_FRAME = 14;

    const onPointerDown = (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartFrame = frameIndex;
      stopAutoRotate();
      stage.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      const delta = e.clientX - dragStartX;
      const framesMoved = Math.round(delta / PX_PER_FRAME);
      frameIndex = ((dragStartFrame - framesMoved) % images.length + images.length) % images.length;
      renderFrame();
    };
    const onPointerUp = () => {
      dragging = false;
      startAutoRotate();
    };
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    cleanupFns.push(() => {
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerUp);
    });

    hint = document.createElement("div");
    hint.className = "v2-hologram-hint";
    hint.textContent = "Drag to rotate";
    stage.appendChild(hint);

    startAutoRotate();
  } else {
    // 0 or 1 photo — tilt-on-pointer single visual, real photo if present,
    // generated placeholder if not.
    if (images.length === 1) {
      visual = document.createElement("img");
      visual.className = "v2-hologram-frame";
      visual.src = images[0].url;
      visual.alt = productName;
      visual.draggable = false;
    } else {
      visual = document.createElement("div");
      visual.className = "v2-hologram-placeholder";
      visual.innerHTML = placeholderSilhouetteSvg(colorHex);
      hint = document.createElement("div");
      hint.className = "v2-hologram-hint";
      hint.textContent = "No photos yet";
    }
    stage.appendChild(visual);
    if (hint) stage.appendChild(hint);

    const MAX_TILT_DEG = 12;
    const onPointerMove = (e) => {
      if (reduced) return;
      const rect = stage.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
      const ny = (e.clientY - rect.top) / rect.height - 0.5;
      const rotateY = nx * MAX_TILT_DEG * 2;
      const rotateX = -ny * MAX_TILT_DEG * 2;
      visual.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      sheen.style.backgroundPosition = `${50 + nx * 60}% ${50 + ny * 60}%`;
    };
    const onPointerLeave = () => {
      visual.style.transition = "transform 260ms var(--ease-emphasized, ease-out)";
      visual.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg)";
      sheen.style.backgroundPosition = "0% 0%";
      setTimeout(() => { visual.style.transition = ""; }, 280);
    };
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerleave", onPointerLeave);
    cleanupFns.push(() => {
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerleave", onPointerLeave);
    });
  }

  stage.appendChild(sheen);
  stage.appendChild(border);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopAutoRotate();
    cleanupFns.forEach((fn) => fn());
  }

  return { el: stage, destroy };
}

/** Opens the hologram stage in a centered modal with a close button,
 * backdrop-click-to-close, and Escape-to-close — and reliably calls the
 * stage's destroy() (stopping the auto-rotate interval) when it closes,
 * however it closes. */
export function openHologramModal({ images = [], colorHex, productName = "Product" } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "v2-hologram-modal-backdrop";
  const panel = document.createElement("div");
  panel.className = "v2-hologram-modal-panel";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
  header.innerHTML = `<h4 style="margin:0;">${esc(productName)}</h4>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-ghost btn-sm";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close");
  header.appendChild(closeBtn);

  const { el: stage, destroy } = renderHologramStage({ images, colorHex, productName });

  panel.appendChild(header);
  panel.appendChild(stage);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  function close() {
    destroy();
    backdrop.classList.remove("v2-visible");
    document.removeEventListener("keydown", onKeydown);
    setTimeout(() => backdrop.remove(), 220);
  }
  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKeydown);

  requestAnimationFrame(() => backdrop.classList.add("v2-visible"));

  return { close };
}
