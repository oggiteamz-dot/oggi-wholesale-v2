// OGGI Wholesale v2 — what a product card shows (Batch 21)
//
// Hadi: "other than the price, I don't want colours and sizes. Instead, I want
// the ability for the wholesaler to pick the two to three pieces of
// information that he wants... he can toggle on price, colours, sizes,
// supplier, sales and orders."
//
// The point of the card layout is that the PHOTO is the biggest thing on it.
// Every fact added takes space from the photo, which is why three is a hard
// cap rather than a suggestion: past three the card is a text block with a
// picture on top, which is the layout it was built to replace.
//
// This module is the single definition of what each fact MEANS. Inventory,
// Products, Catalogs and the "pick from inventory" picker all read it, so a
// wholesaler who turns on "Margin %" sees the same number computed the same
// way wherever they look. Four screens each deciding what "available" means is
// how two screens end up disagreeing about one product.
//
// A fact declares what it needs (`needs`), so a screen that cannot supply the
// data says so plainly instead of rendering a confident "0".

import { money } from "./utils.js";
import { INVENTORY_SETTING_DEFAULTS } from "./inventory-defaults.js";

/** Every fact a wholesaler can choose from.
 *
 *  `get(p, ctx)` returns { value, tone } or null. Returning NULL means "this
 *  screen does not know", and the card shows an em dash rather than inventing
 *  a zero -- "0 sold" and "I have not been told how many sold" look identical
 *  on a card and mean opposite things to someone deciding what to reorder. */
export const CARD_FACTS = [
  // ---- commercial basics ----
  { key: "price", label: "Price", group: "Commercial", needs: "priceRange",
    get: (p) => {
      const lo = p.priceRange?.[0], hi = p.priceRange?.[1];
      if (lo == null || hi == null) return null;
      if (!hi) return { value: "—" };
      return { value: lo === hi ? money(lo) : `${money(lo)}–${money(hi)}` };
    } },
  { key: "available", label: "Available", group: "Commercial", needs: "stock",
    // Batch 1: the amber threshold is the wholesaler's own setting when the
    // caller passes one, and otherwise the single platform default. It used
    // to be the literal 15, which was the sixth copy of that number in the
    // codebase. This is a product-level colour hint, not the alerting
    // surface -- per-SKU "low" is decided by days of cover in
    // js/data/inventory-signals.js.
    get: (p, ctx) => (p.available == null ? null : {
      value: String(p.available),
      tone: p.available <= 0 ? "danger"
          : p.available <= (ctx?.lowStockThreshold ?? INVENTORY_SETTING_DEFAULTS.lowStockThreshold) ? "warning" : "",
    }) },
  { key: "onHand", label: "On hand", group: "Commercial", needs: "stock",
    get: (p) => (p.onHand == null ? null : { value: String(p.onHand) }) },

  // ---- what it is ----
  { key: "variantCount", label: "Colours & sizes", group: "What it is", needs: "variants",
    get: (p) => (p.variantCount == null ? null : { value: String(p.variantCount) }) },
  { key: "supplier", label: "Supplier", group: "What it is", needs: "supplier",
    get: (p) => (p.supplierName ? { value: p.supplierName } : null) },
  { key: "category", label: "Category", group: "What it is", needs: "category",
    get: (p) => (p.category ? { value: p.category } : null) },

  // ---- how it sells ----
  { key: "unitsSold", label: "Units sold", group: "How it sells", needs: "sales",
    get: (p) => (p.unitsSold == null ? null : { value: String(p.unitsSold) }) },
  { key: "orderCount", label: "Orders", group: "How it sells", needs: "sales",
    get: (p) => (p.orderCount == null ? null : { value: String(p.orderCount) }) },
  { key: "lastSold", label: "Last sold", group: "How it sells", needs: "sales",
    get: (p) => (p.lastSold ? { value: sinceLabel(p.lastSold) } : p.unitsSold === 0 ? { value: "never" } : null) },

  // ---- your side ----
  { key: "cost", label: "Cost", group: "Your side", needs: "cost",
    get: (p) => (p.costRange?.[0] == null ? null : {
      value: p.costRange[0] === p.costRange[1] ? money(p.costRange[0]) : `${money(p.costRange[0])}–${money(p.costRange[1])}`,
    }) },
  { key: "margin", label: "Margin %", group: "Your side", needs: "cost",
    get: (p) => {
      if (p.marginPct == null) return null;
      return {
        value: `${p.marginPct.toFixed(0)}%`,
        // Negative margin is not a styling flourish. It means this product
        // loses money on every unit, and it should be impossible to scan past.
        tone: p.marginPct < 0 ? "danger" : p.marginPct < 15 ? "warning" : "",
      };
    } },
  { key: "lastReceived", label: "Last received", group: "Your side", needs: "receipts",
    get: (p) => (p.lastReceived ? { value: sinceLabel(p.lastReceived) } : null) },
];

/** "Show stock at one named warehouse" is not a fixed fact -- it depends on
 *  which warehouses this wholesaler has. Hadi: "if they have multiple
 *  locations, they can pick which warehouse, or to show how many each
 *  warehouse has of each one." So these two are generated. */
export const LOCATION_ALL = "stockByLocation";
export const locationFactKey = (locationId) => `stockAt:${locationId}`;

export function locationFacts(locations = []) {
  if (locations.length < 2) return [];   // one warehouse: "at Main" IS "available"
  return [
    { key: LOCATION_ALL, label: "Stock in each warehouse", group: "Warehouses", needs: "stock" },
    ...locations.map((l) => ({
      key: locationFactKey(l.id), label: `Stock at ${l.name}`, group: "Warehouses", needs: "stock",
    })),
  ];
}

export const MAX_FACTS = 3;

export const DEFAULT_FACTS = ["price", "available", "onHand"];

function sinceLabel(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Turns a wholesaler's chosen fact keys into the `facts` array a product tile
 * renders, for ONE product.
 *
 * @param {object} p          the product row (whatever the screen has)
 * @param {string[]} keys     the wholesaler's chosen keys, in their order
 * @param {object} [ctx]
 * @param {Array} [ctx.locations]  [{id, name}] for the warehouse facts
 */
export function factsFor(p, keys = DEFAULT_FACTS, ctx = {}) {
  const out = [];
  for (const key of (keys || []).slice(0, MAX_FACTS)) {
    if (key === LOCATION_ALL) {
      (p.byLocation || []).forEach((l) => {
        out.push({ label: l.locationName, value: String(l.available) });
      });
      // A product held nowhere still has to say something, or the card
      // silently drops a fact the wholesaler asked for and looks broken.
      if (!(p.byLocation || []).length) out.push({ label: "In warehouses", value: "—" });
      continue;
    }
    if (key.startsWith("stockAt:")) {
      const id = key.slice("stockAt:".length);
      const row = (p.byLocation || []).find((l) => l.locationId === id);
      const name = row?.locationName
        || (ctx.locations || []).find((l) => l.id === id)?.name
        || "Warehouse";
      out.push({
        label: name,
        value: row ? String(row.available) : "0",
        tone: !row || row.available <= 0 ? "danger"
            : row.available <= (ctx?.lowStockThreshold ?? INVENTORY_SETTING_DEFAULTS.lowStockThreshold) ? "warning" : "",
      });
      continue;
    }

    const fact = CARD_FACTS.find((f) => f.key === key);
    if (!fact) continue;
    const got = fact.get(p, ctx);
    out.push(got ? { label: fact.label, ...got } : { label: fact.label, value: "—" });
  }
  return out;
}

/** Keeps a stored choice sane: known keys only, no duplicates, at most three,
 *  and never empty. A card with no facts is a photo with a name under it,
 *  which is a choice nobody makes on purpose. */
export function normaliseFacts(keys, locations = []) {
  const known = new Set([
    ...CARD_FACTS.map((f) => f.key),
    LOCATION_ALL,
    ...locations.map((l) => locationFactKey(l.id)),
  ]);
  const clean = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!known.has(k) || clean.includes(k)) continue;
    clean.push(k);
    if (clean.length === MAX_FACTS) break;
  }
  return clean.length ? clean : [...DEFAULT_FACTS];
}
