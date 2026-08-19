// OGGI Wholesale v2 — the catalog billboard (Batch 22)
//
// Hadi: "like a billboard essentially. Like there's a main screen that is
// basically either an advertisement for a specific product, where they click
// on a button and they move to that specific item inside that specific
// catalog, or just a normal poster, and it's toggleable on and off."
// And: "they might choose to put in a video or a GIF for the billboard."
//
// Three things this has to get right:
//
// 1. A VIDEO THAT AUTOPLAYS MUST BE SILENT AND STOPPABLE. Autoplay only works
//    at all when muted, on every browser worth naming — but more importantly,
//    a shop owner opening a catalog on their phone in a quiet room should not
//    have sound come out of it. `playsinline` keeps iOS from hijacking the
//    whole screen into its fullscreen player.
//
// 2. REDUCED MOTION IS AN INSTRUCTION, NOT A HINT. Someone who has asked their
//    device for less movement has usually asked for a reason. The video does
//    not autoplay for them; it gets a poster frame and a play button, and the
//    catalog underneath is completely unaffected.
//
// 3. THE BUTTON HAS TO ACTUALLY GO SOMEWHERE. A billboard advertising a
//    product that has since been removed from the catalog renders as a plain
//    poster rather than a button that scrolls to nothing.

import { esc } from "../lib/utils.js";

/**
 * @param {object} o
 * @param {string} o.url          poster, GIF or clip
 * @param {"image"|"video"} o.mediaType
 * @param {string} [o.cta]        button label; only used when onGo is given
 * @param {Function} [o.onGo]     omitted when the billboard is just a poster
 * @param {string} [o.label]      accessible name, e.g. the catalog name
 */
export function renderBillboard({ url, mediaType = "image", cta, onGo, label = "" }) {
  if (!url) return null;

  const el = document.createElement("section");
  el.className = "billboard";
  el.setAttribute("aria-label", label ? `${label} — featured` : "Featured");

  const media = document.createElement("div");
  media.className = "billboard-media";

  if (mediaType === "video") {
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const video = document.createElement("video");
    video.src = url;
    video.muted = true;          // property, not just the attribute: Safari
    video.defaultMuted = true;   // reads the property when deciding to autoplay
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.loop = true;
    video.preload = reduced ? "metadata" : "auto";
    video.controls = reduced;
    video.autoplay = !reduced;
    if (!reduced) {
      // .play() can be refused (a battery-saving mode, a strict autoplay
      // policy). Catching it means a still first frame instead of an uncaught
      // rejection in the console of every catalog that has a video.
      video.addEventListener("canplay", () => { video.play().catch(() => { video.controls = true; }); }, { once: true });
    }
    media.appendChild(video);
  } else {
    // An animated GIF is still an <img>. It was uploaded untouched precisely
    // so it would still move here.
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "eager";   // it is the first thing on the page; lazy is wrong
    media.appendChild(img);
  }

  el.appendChild(media);

  if (onGo) {
    const bar = document.createElement("div");
    bar.className = "billboard-bar";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary billboard-cta";
    btn.textContent = cta && cta.trim() ? cta.trim() : "See this product";
    btn.addEventListener("click", () => onGo());
    bar.appendChild(btn);
    el.appendChild(bar);
  }

  return el;
}

/** The header above a pinned group. Hadi corrected himself on this one: "not a
 *  ribbon, like a header. Basically, there's a header for new arrivals or
 *  featured items, top selling, favorites, whatever they choose to name it."
 *  A ribbon on each card competes with the photograph; a header names the
 *  group once and gets out of the way. */
export function sectionHeader(text, count) {
  const h = document.createElement("div");
  h.className = "cat-section-head";
  h.innerHTML = `<h3>${esc(text)}</h3>${
    count != null ? `<span>${count} item${count === 1 ? "" : "s"}</span>` : ""
  }`;
  return h;
}
