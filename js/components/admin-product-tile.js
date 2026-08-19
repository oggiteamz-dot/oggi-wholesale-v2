// OGGI Wholesale v2 — the admin product card (Batch 19)
//
// Hadi: "I don't want them the way you built it. It's too tiny. The thumbnail
// is ultra tiny. Instead of them being horizontal bars, make them vertical
// cards. Imagine five, six, seven playing cards next to each other, where the
// thumbnail is the biggest piece, then the other pieces of information and any
// kind of function needed."
//
// He is describing the difference between a LEDGER and a CATALOGUE. A row of
// text with a 48px thumbnail is a ledger: it is optimised for reading down a
// column of numbers, which is right for accounts and wrong for clothing.
// A wholesaler finds a garment by recognising it, and recognition needs the
// picture to be the largest thing on screen, not a stamp beside the name.
//
// The photo therefore gets a 3:4 block at the top of the card, which is the
// proportion garments are actually shot in -- a square crops the hem off a
// dress and a 16:9 crops everything. Below it, in order: the name, the numbers
// that decide what you do next, then the buttons.
//
// One tile, three screens. Inventory, Products and Catalogs all show the same
// object and differ only in which actions belong on it, so they take the same
// component with a different `actions` list rather than growing three card
// layouts that drift apart.

import { esc } from "../lib/utils.js";
import { openGallery } from "./image-gallery.js";

/**
 * @param {object} o
 * @param {string} o.id           product id
 * @param {string} o.name
 * @param {string[]} o.images
 * @param {Array<{label:string, value:string, tone?:string}>} o.facts
 * @param {Array<{text:string, kind?:string}>} o.badges
 * @param {Array<{label:string, onClick:Function, variant?:string, title?:string}>} o.actions
 * @param {Function} [o.onOpen]   clicking the card body (not a button)
 */
export function renderProductTile({ id, name, images = [], facts = [], badges = [], actions = [], onOpen }) {
  const card = document.createElement("article");
  card.className = "pcard";
  card.dataset.productId = id || "";

  // ---- photo ----
  const media = document.createElement("div");
  media.className = "pcard-media";
  if (images.length) {
    media.innerHTML = `<img src="${esc(images[0])}" alt="" loading="lazy">` +
      (images.length > 1 ? `<span class="pcard-count">${images.length} photos</span>` : "");
    // The photo opens the gallery rather than the product, because a person
    // who taps a picture is asking to see the picture. Everything else on the
    // card opens the product.
    media.addEventListener("click", (ev) => { ev.stopPropagation(); openGallery(images, 0, name); });
    media.setAttribute("role", "button");
    media.setAttribute("tabindex", "0");
    media.setAttribute("aria-label", `View ${images.length} photo${images.length === 1 ? "" : "s"} of ${name}`);
    media.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openGallery(images, 0, name); }
    });
  } else {
    // A product with no photo keeps the same block, so a grid of cards stays a
    // grid. A collapsed tile would break the row and draw the eye to the one
    // thing that has least to show.
    media.classList.add("pcard-media-empty");
    media.innerHTML = `<span aria-hidden="true">🧵</span><span class="pcard-nophoto">No photo yet</span>`;
  }
  card.appendChild(media);

  // ---- body ----
  const body = document.createElement("div");
  body.className = "pcard-body";

  const title = document.createElement("h4");
  title.className = "pcard-name";
  title.textContent = name;
  title.title = name;              // the full name on hover, since it clamps
  body.appendChild(title);

  if (badges.length) {
    const badgeRow = document.createElement("div");
    badgeRow.className = "pcard-badges";
    badgeRow.innerHTML = badges
      .map((b) => `<span class="badge ${esc(b.kind || "badge-neutral")}">${esc(b.text)}</span>`)
      .join("");
    body.appendChild(badgeRow);
  }

  if (facts.length) {
    const dl = document.createElement("dl");
    dl.className = "pcard-facts";
    dl.innerHTML = facts
      .map((f) => `<div${f.tone ? ` class="pcard-fact-${esc(f.tone)}"` : ""}><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
      .join("");
    body.appendChild(dl);
  }

  card.appendChild(body);

  // ---- actions ----
  if (actions.length) {
    const bar = document.createElement("div");
    bar.className = "pcard-actions";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn ${a.variant || "btn-secondary"} btn-sm`;
      b.textContent = a.label;
      if (a.title) b.title = a.title;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); a.onClick(ev); });
      bar.appendChild(b);
    });
    card.appendChild(bar);
  }

  if (onOpen) {
    card.classList.add("pcard-clickable");
    card.addEventListener("click", () => onOpen());
  }

  return card;
}

/** The grid these live in. Returns the element; append tiles to it. */
export function productGrid() {
  const grid = document.createElement("div");
  grid.className = "pcard-grid";
  return grid;
}
