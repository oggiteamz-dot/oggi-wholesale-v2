// OGGI Wholesale v2 — "add to cart" fly animation (Batch 13)
//
// A small coloured chip visually travels from the button/swatch the buyer
// just interacted with to the cart icon in the topbar, then the cart icon
// bumps. Pure visual feedback — the actual cart mutation has already
// succeeded by the time this is called (see product-card.js), so this
// module never blocks or affects real state; if it can't find a cart
// icon target (e.g. wholesaler/owner roles, which don't have one) it's a
// silent no-op rather than an error.
//
// Uses the Web Animations API directly (`Element.animate`) rather than a
// CSS class + transitionend listener, because the start/end coordinates
// are computed per-call from real getBoundingClientRect() values — a
// fixed CSS animation can't parametrize an arbitrary start point.

import { prefersReducedMotion } from "./motion-prefs.js";

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.sourceEl - element to fly FROM (its center is the start point)
 * @param {string} [opts.color] - chip background colour (defaults to the accent token)
 */
export function flyToCart({ sourceEl, color } = {}) {
  const targetEl = document.getElementById("v2-cart-icon");
  if (!targetEl || !sourceEl || !sourceEl.getBoundingClientRect) {
    bumpCartIcon();
    return;
  }

  if (prefersReducedMotion()) {
    // Skip the flying-element motion entirely, but still deliver the
    // "something happened" signal via the (much smaller, single-pulse)
    // cart bump — satisfies WCAG 2.3.3 by keeping the functional outcome
    // visible without the large cross-screen motion.
    bumpCartIcon();
    return;
  }

  const startRect = sourceEl.getBoundingClientRect();
  const endRect = targetEl.getBoundingClientRect();
  const startX = startRect.left + startRect.width / 2;
  const startY = startRect.top + startRect.height / 2;
  const endX = endRect.left + endRect.width / 2;
  const endY = endRect.top + endRect.height / 2;

  const chip = document.createElement("div");
  chip.className = "v2-fly-chip";
  chip.style.width = "14px";
  chip.style.height = "14px";
  chip.style.left = `${startX}px`;
  chip.style.top = `${startY}px`;
  chip.style.background = color || "var(--accent-500)";
  document.body.appendChild(chip);

  // A gentle arc (via a midpoint control offset) reads much more naturally
  // than a straight line — approximated with a 3-keyframe path since WAAPI
  // has no native bezier-path support.
  const dx = endX - startX;
  const dy = endY - startY;
  const midX = startX + dx * 0.5 + (dy === 0 ? 0 : -Math.abs(dy) * 0.15);
  const midY = startY + dy * 0.5 - Math.max(40, Math.abs(dx) * 0.25);

  const anim = chip.animate(
    [
      { transform: "translate(0,0) scale(1)", opacity: 1, offset: 0 },
      { transform: `translate(${midX - startX}px, ${midY - startY}px) scale(0.85)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.15, offset: 1 },
    ],
    { duration: 620, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }
  );

  anim.onfinish = () => {
    chip.remove();
    bumpCartIcon();
  };
  // Safety net: if onfinish never fires (some older engines skip it for
  // detached-DOM edge cases), don't leave an orphaned fixed-position chip
  // stuck on screen.
  setTimeout(() => chip.remove(), 900);
}

function bumpCartIcon() {
  const el = document.getElementById("v2-cart-icon");
  if (!el) return;
  el.classList.remove("v2-cart-bump");
  // Force reflow so re-adding the class restarts the animation even if
  // called twice in quick succession (rapid add-to-cart clicks).
  void el.offsetWidth;
  el.classList.add("v2-cart-bump");
}
