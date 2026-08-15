// OGGI Wholesale v2 — buyer catalog filter/search toolbar (Batch 8)
// A single sticky-ish toolbar above the product grid: text search, colour
// swatch multi-select, size chip multi-select, "In stock only" and
// "Low MOQs only" toggles, and a sort dropdown. Pure UI -- all the actual
// filtering/sorting logic lives in js/data/catalog-filter.js so it stays
// testable without a DOM.

import { defaultCatalogFilters, distinctColorsAndSizes } from "../data/catalog-filter.js";

/** Renders the toolbar and wires it to call `onChange(filters)` on every
 * user-driven change. Deliberately does NOT fire an initial synchronous
 * onChange during construction -- a caller whose onChange closure reads
 * back the object this function returns (e.g. to call setResultCount)
 * would hit a temporal-dead-zone error, since that object doesn't exist
 * until this call returns. Callers render their own initial (unfiltered)
 * grid using `defaultCatalogFilters()` right after construction instead;
 * see js/views/buyer.js's dashboard(). Returns the toolbar element plus
 * `setResultCount` so the caller can report how many products matched
 * after each re-render. */
export function renderCatalogToolbar({ catalog, lowMoqThreshold, onChange }) {
  const filters = defaultCatalogFilters();
  const { colors, sizes } = distinctColorsAndSizes(catalog);

  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.style.cssText = "padding:14px 16px;margin-bottom:16px;display:flex;flex-direction:column;gap:10px;";

  const topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "input";
  searchInput.placeholder = "Search products or SKU…";
  searchInput.style.cssText = "flex:1;min-width:180px;";
  searchInput.addEventListener("input", () => { filters.search = searchInput.value; emit(); });

  const sortSelect = document.createElement("select");
  sortSelect.className = "input";
  sortSelect.style.width = "auto";
  sortSelect.innerHTML = `
    <option value="newest">Newest first</option>
    <option value="price-asc">Price: low to high</option>
    <option value="price-desc">Price: high to low</option>
    <option value="name-asc">Name A–Z</option>
  `;
  sortSelect.addEventListener("change", () => { filters.sort = sortSelect.value; emit(); });

  const inStockLabel = toggleChip("In stock only", (checked) => { filters.inStockOnly = checked; emit(); });
  const lowMoqLabel = toggleChip(`Low MOQ only (≤ ${lowMoqThreshold})`, (checked) => { filters.lowMoqOnly = checked; emit(); });

  topRow.appendChild(searchInput);
  topRow.appendChild(inStockLabel);
  topRow.appendChild(lowMoqLabel);
  topRow.appendChild(sortSelect);
  wrap.appendChild(topRow);

  if (colors.length > 1) {
    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
    const label = document.createElement("span");
    label.textContent = "Colour:";
    label.style.cssText = "font-size:12px;color:var(--text-tertiary);margin-right:2px;";
    colorRow.appendChild(label);
    colors.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.title = c.name;
      sw.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c.hex};cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px var(--border-default);`;
      sw.addEventListener("click", () => {
        if (filters.colors.has(c.name)) { filters.colors.delete(c.name); sw.style.borderColor = "transparent"; }
        else { filters.colors.add(c.name); sw.style.borderColor = "var(--accent-500)"; }
        emit();
      });
      colorRow.appendChild(sw);
    });
    wrap.appendChild(colorRow);
  }

  if (sizes.length > 1) {
    const sizeRow = document.createElement("div");
    sizeRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
    const label = document.createElement("span");
    label.textContent = "Size:";
    label.style.cssText = "font-size:12px;color:var(--text-tertiary);margin-right:2px;";
    sizeRow.appendChild(label);
    sizes.forEach((s) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = s;
      chip.className = "btn btn-sm btn-secondary";
      chip.addEventListener("click", () => {
        if (filters.sizes.has(s)) { filters.sizes.delete(s); chip.classList.remove("btn-primary"); chip.classList.add("btn-secondary"); }
        else { filters.sizes.add(s); chip.classList.remove("btn-secondary"); chip.classList.add("btn-primary"); }
        emit();
      });
      sizeRow.appendChild(chip);
    });
    wrap.appendChild(sizeRow);
  }

  const resultCount = document.createElement("div");
  resultCount.style.cssText = "font-size:12px;color:var(--text-tertiary);";
  wrap.appendChild(resultCount);

  function toggleChip(text, onToggle) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => onToggle(cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(text));
    return label;
  }

  function emit() {
    onChange({ ...filters, colors: new Set(filters.colors), sizes: new Set(filters.sizes) });
  }

  return {
    el: wrap,
    setResultCount(matched, total) {
      resultCount.textContent = matched === total ? `${total} product${total === 1 ? "" : "s"}` : `${matched} of ${total} products match your filters`;
    },
  };
}
