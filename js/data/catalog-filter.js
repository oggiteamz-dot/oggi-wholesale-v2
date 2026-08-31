import { sortSizes } from "../lib/size-order.js";
// OGGI Wholesale v2 — catalog grid filter/sort logic (Batch 8)
// Pure functions, deliberately kept free of any DOM/Supabase code so they
// can be unit-reasoned-about and reused by both the buyer catalog toolbar
// and (later, if needed) a wholesaler-side "what would a buyer see" preview.
// Filtering runs entirely client-side against the already-fetched catalog
// array (see js/data/catalog.js's getCatalog) -- there's no server round
// trip per filter change, so the grid re-renders instantly as the buyer
// types/toggles.

/** Default filter state -- exported so the toolbar component and any
 * consumer agree on the shape without duplicating it. */
export function defaultCatalogFilters() {
  return {
    search: "",
    colors: new Set(),
    sizes: new Set(),
    inStockOnly: false,
    lowMoqOnly: false,
    sort: "newest",
  };
}

/** Every distinct colour/size across the whole catalog, for the toolbar to
 * render as selectable chips -- computed from the real product data (not a
 * static list), so a wholesaler with only 3 colours never sees 20 dead
 * filter chips. */
export function distinctColorsAndSizes(catalog) {
  const colors = new Map(); // name -> hex
  const sizes = new Set();
  catalog.forEach((p) => {
    p.colors.forEach((c) => { if (c.name && !colors.has(c.name)) colors.set(c.name, c.hex); });
    p.sizes.forEach((s) => { if (s) sizes.add(s); });
  });
  return {
    colors: [...colors.entries()].map(([name, hex]) => ({ name, hex })),
    // localeCompare is ALPHABETICAL, which printed the chips L, M, S, XL, XXL.
    // Same fix, same table as the order sheet's columns (31 Aug 2026).
    sizes: sortSizes([...sizes.values()]),
  };
}

const SORTERS = {
  newest: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  "price-asc": (a, b) => a.minPrice - b.minPrice,
  "price-desc": (a, b) => b.maxPrice - a.maxPrice,
  "name-asc": (a, b) => a.name.localeCompare(b.name),
};

/** Applies search + colour + size + stock + low-MOQ filters, then the
 * chosen sort, and returns a NEW array (never mutates the source catalog --
 * the caller's original fetch result stays the reusable source of truth
 * across re-filters). `lowMoqThreshold` comes from the wholesaler's own
 * v2_wholesalers.low_moq_threshold (Batch 8 settings) since "low MOQ" isn't
 * a fixed number across wholesalers/categories.
 *
 * The low-MOQ check deliberately uses the product's FIRST-ORDER moqQty, not
 * the per-buyer reorder threshold (product-card.js resolves that
 * distinction per-card via isReorder) -- a grid-level filter is shown
 * before we know which specific card each buyer has already reordered, so
 * it uses the same minimum every buyer sees on a first look. */
export function filterAndSortCatalog(catalog, filters, { lowMoqThreshold = 12 } = {}) {
  const search = filters.search.trim().toLowerCase();
  const result = catalog.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search) && !p.variants.some((v) => v.sku?.toLowerCase().includes(search))) return false;
    if (filters.colors.size && !p.colors.some((c) => filters.colors.has(c.name))) return false;
    if (filters.sizes.size && !p.sizes.some((s) => filters.sizes.has(s))) return false;
    if (filters.inStockOnly && p.outOfStock) return false;
    if (filters.lowMoqOnly && p.moqQty > lowMoqThreshold) return false;
    return true;
  });
  const sorter = SORTERS[filters.sort] || SORTERS.newest;
  return result.sort(sorter);
}
