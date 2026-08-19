// OGGI Wholesale v2 — "Pick from inventory" (Batch 20)
//
// Hadi, on the catalog builder: "There will be two buttons. One's going to be
// create new product. And the second one pick product from inventory. And when
// they click the product from inventory, the list of all the different
// products will pop up. And they can click multiple ones to add them."
//
// Two things this gets right that a naive picker does not:
//
// 1. Products already in the catalog are SHOWN, marked, and not selectable.
//    They could simply be hidden, but then a wholesaler looking for a hoodie
//    they know they own would find it missing and reasonably conclude the
//    picker was broken. "It is here, you already added it" answers the
//    question they actually have.
//
// 2. Selection survives searching. Type "hood", tick two, clear the box, type
//    "denim", tick another -- all three are still selected, because the set
//    lives outside the rendered list rather than being read off the checkboxes
//    that a re-render destroys. Losing a selection to a keystroke is the kind
//    of small betrayal that makes people stop trusting a screen.
//
// Rewritten as CARDS on 19 Aug. Hadi: "again, I don't want it to be a bar. I
// want them to be large images. So the wholesaler can actually see what he's
// picking." He is right, and it was the same mistake twice -- a list of rows
// is a ledger, and you cannot recognise a garment from a 48px stamp. It uses
// the same tile every other screen uses, so a product looks the same here as
// it does in Inventory, with the same facts the wholesaler chose.

import { esc } from "../lib/utils.js";
import { renderProductTile, productGrid } from "./admin-product-tile.js";
import { factsFor } from "../lib/card-facts.js";

/**
 * @param {object} o
 * @param {Array} o.products      every product the wholesaler owns
 * @param {Set<string>} o.alreadyIn  product ids already filed in this catalog
 * @param {string} o.catalogName
 * @param {(ids: string[]) => Promise<any>} o.onAdd
 * @param {Function} o.onClose
 */
export function renderProductPicker({
  products = [], alreadyIn = new Set(), catalogName = "",
  cardFacts = ["price", "available", "onHand"], locations = [],
  onAdd, onClose,
}) {
  const chosen = new Set();

  const overlay = document.createElement("div");
  overlay.className = "prod-edit picker";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `Pick products for ${catalogName}`);

  const panel = document.createElement("div");
  panel.className = "card picker-panel";

  const head = document.createElement("div");
  head.className = "pdet-head";
  head.innerHTML = `<div>
      <h4>Add products to ${esc(catalogName)}</h4>
      <p>Tick everything you want. ${products.length} product${products.length === 1 ? "" : "s"} in your inventory.</p>
    </div>`;
  const headActions = document.createElement("div");
  headActions.className = "pdet-head-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-ghost btn-sm picker-close";
  closeBtn.textContent = "Cancel";
  closeBtn.addEventListener("click", () => onClose());
  headActions.appendChild(closeBtn);
  head.appendChild(headActions);
  panel.appendChild(head);

  const search = document.createElement("input");
  search.className = "input picker-search";
  search.type = "search";
  search.placeholder = "Search by name, colour or code…";
  search.setAttribute("aria-label", "Search your products");
  panel.appendChild(search);

  const list = document.createElement("div");
  list.className = "picker-list";
  panel.appendChild(list);

  const bar = document.createElement("div");
  bar.className = "picker-bar";
  const count = document.createElement("span");
  count.className = "picker-count";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-primary picker-add";
  bar.appendChild(count);
  bar.appendChild(addBtn);
  panel.appendChild(bar);

  function haystack(p) {
    return [
      p.name,
      ...(p.colors || []).map((c) => c.name),
      ...(p.variants || []).map((v) => v.sku),
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function paintBar() {
    const n = chosen.size;
    count.textContent = n === 0
      ? "Nothing picked yet"
      : `${n} product${n === 1 ? "" : "s"} picked`;
    addBtn.textContent = n === 0 ? "Add products" : `Add ${n} product${n === 1 ? "" : "s"}`;
    addBtn.disabled = n === 0;
  }

  function paintList() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? products.filter((p) => haystack(p).includes(q)) : products;
    list.innerHTML = "";

    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "pdet-none";
      empty.textContent = q
        ? `Nothing matches "${search.value.trim()}".`
        : "You have no products yet. Use “+ Create new product” instead.";
      list.appendChild(empty);
      return;
    }

    const grid = productGrid();
    shown.forEach((p) => {
      const inAlready = alreadyIn.has(p.id);
      const badges = inAlready
        ? [{ text: "Already in this catalog", kind: "badge-neutral" }]
        : chosen.has(p.id) ? [{ text: "Picked", kind: "badge-success" }] : [];

      const tile = renderProductTile({
        id: p.id,
        name: p.name,
        images: p.images || [],
        badges,
        facts: factsFor(p, cardFacts, { locations }),
        // No action buttons: the whole card is the target. A tick-box beside a
        // big photo invites people to aim at the box, and the box is the
        // smallest thing on the card.
        onOpen: inAlready ? undefined : () => {
          if (chosen.has(p.id)) chosen.delete(p.id); else chosen.add(p.id);
          paintList();
          paintBar();
        },
      });
      tile.classList.add("picker-card");
      if (inAlready) tile.classList.add("picker-card-in");
      if (chosen.has(p.id)) tile.classList.add("picker-card-on");

      // A visible state, not just a border: on a wall of photographs a thin
      // outline is invisible, and "which ones did I already tick" is the only
      // question this screen exists to answer.
      const mark = document.createElement("span");
      mark.className = "picker-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = inAlready ? "✓" : chosen.has(p.id) ? "✓" : "";
      tile.appendChild(mark);

      tile.setAttribute("role", inAlready ? "img" : "checkbox");
      if (!inAlready) tile.setAttribute("aria-checked", String(chosen.has(p.id)));
      tile.setAttribute("aria-label",
        inAlready ? `${p.name} — already in this catalog` : `Add ${p.name}`);
      if (!inAlready) {
        tile.tabIndex = 0;
        tile.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); tile.click(); }
        });
      }

      grid.appendChild(tile);
    });
    list.appendChild(grid);
  }

  search.addEventListener("input", paintList);

  addBtn.addEventListener("click", async () => {
    if (!chosen.size) return;
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    await onAdd([...chosen]);
  });

  paintList();
  paintBar();
  overlay.appendChild(panel);

  const prevOverflow = document.body.style.overflow;
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  function close() {
    document.body.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  // The backdrop closes; the panel does not. A mis-aimed click inside a list
  // someone has spent a minute ticking must never throw the ticks away.
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) onClose(); });

  return { el: overlay, close, focus: () => search.focus() };
}
