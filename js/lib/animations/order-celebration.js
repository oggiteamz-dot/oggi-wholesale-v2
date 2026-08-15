// OGGI Wholesale v2 — full-screen "order sent" celebration (Batch 13)
//
// A brief full-screen overlay: an animated checkmark (SVG stroke-dashoffset
// draw-in, pure CSS — see css/animations.css) plus a real confetti burst
// (small coloured pieces animated outward via the Web Animations API, not
// a canvas library dependency). Returns a Promise that resolves once the
// celebration is done, so a caller can `await showOrderCelebration(...)`
// before navigating away — the celebration is always allowed to finish
// (or be dismissed) before the buyer lands on the order confirmation
// screen, rather than racing a hash change against it.
//
// Respects prefers-reduced-motion: skips confetti and the scale/blur
// entrance entirely, shows a static checkmark for a short fixed dwell,
// and still resolves the Promise on the same rough timeline so calling
// code doesn't need two code paths.

import { prefersReducedMotion } from "./motion-prefs.js";

import { esc } from "../utils.js";
const CONFETTI_COLORS = ["#4F46E5", "#12B76A", "#F79009", "#2E90FA", "#F04438", "#7A5AF8"];

function launchConfetti(count = 26) {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight * 0.42;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "v2-confetti-piece";
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.left = `${centerX}px`;
    piece.style.top = `${centerY}px`;
    document.body.appendChild(piece);

    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const distance = 140 + Math.random() * 180;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 60; // bias upward-outward, then it falls
    const rotate = (Math.random() - 0.5) * 720;
    const duration = 900 + Math.random() * 500;

    const anim = piece.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1, offset: 0 },
        { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${rotate * 0.6}deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy + 260}px) rotate(${rotate}deg)`, opacity: 0, offset: 1 },
      ],
      { duration, easing: "cubic-bezier(0.2, 0, 0.4, 1)", fill: "forwards" }
    );
    anim.onfinish = () => piece.remove();
    setTimeout(() => piece.remove(), duration + 200);
  }
}

/**
 * @param {Object} opts
 * @param {string} [opts.message]
 * @returns {Promise<void>} resolves once the celebration has finished (or
 *   the user dismissed it early by clicking the backdrop).
 */
export function showOrderCelebration({ message = "Order placed!" } = {}) {
  const reduced = prefersReducedMotion();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "v2-celebration-overlay";
    overlay.innerHTML = `
      <div class="v2-celebration-card">
        <svg width="96" height="96" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="v2-celebration-check-circle" cx="26" cy="26" r="24" />
          <path class="v2-celebration-check-mark" d="M14 27l7 7 17-17" />
        </svg>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${esc(message)}</div>
        <div style="font-size:12px;color:var(--text-tertiary);">Tap anywhere to continue</div>
      </div>
    `;
    document.body.appendChild(overlay);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      overlay.classList.remove("v2-visible");
      setTimeout(() => overlay.remove(), 250);
      resolve();
    };

    overlay.addEventListener("click", finish);
    requestAnimationFrame(() => overlay.classList.add("v2-visible"));

    if (!reduced) {
      setTimeout(() => launchConfetti(), 120);
      setTimeout(finish, 1900);
    } else {
      // Static checkmark, short fixed dwell, no confetti/motion.
      setTimeout(finish, 900);
    }
  });
}

