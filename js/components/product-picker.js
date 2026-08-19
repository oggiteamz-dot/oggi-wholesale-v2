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

import { esc, money } from "../lib/utils.js";
import { productThumb } from "./image-gallery.js";

/**
 * @param {object} o
 * @param {Array} o.products      every product the wholesaler owns
 * @param {Set<string>} o.alreadyIn  product ids already filed in this catalog
 * @param {string} o.catalogName
 * @param {(ids: string[]) => Promise<any>} o.onAdd
 * @param {Function} o.onClose
 */
export function renderProductPicker({ products = [], alreadyIn = new Set(), catalogName = "", onAdd, onClose }) {
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

    shown.forEach((p) => {
      const inAlready = alreadyIn.has(p.id);
      const row = document.createElement(inAlready ? "div" : "label");
      row.className = `picker-row${inAlready ? " picker-row-in" : ""}`;

      if (!inAlready) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "picker-tick";
        box.checked = chosen.has(p.id);
        box.setAttribute("aria-label", `Add ${p.name}`);
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(p.id); else chosen.delete(p.id);
          paintBar();
        });
        row.appendChild(box);
      } else {
        const mark = document.createElement("span");
        mark.className = "picker-tick picker-tick-in";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "✓";
        row.appendChild(mark);
      }

      row.appendChild(productThumb(p.images || [], p.name));

      const main = document.createElement("div");
      main.className = "picker-main";
      const lo = p.priceRange?.[0], hi = p.priceRange?.[1];
      const price = !hi ? "—" : lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
      main.innerHTML = `
        <div class="picker-name">${esc(p.name)}</div>
        <div class="picker-meta">${p.variantCount || 0} colour/size${(p.variantCount || 0) === 1 ? "" : "s"} · ${price}${
          inAlready ? ' · <span class="picker-already">already in this catalog</span>' : ""
        }</div>`;
      row.appendChild(main);

      list.appendChild(row);
    });
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
