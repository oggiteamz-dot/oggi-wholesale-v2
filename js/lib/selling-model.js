// OGGI Wholesale v2 — how a product is sold, said out loud on the card.
//
// Batch 8, 23 Aug 2026. All four selling models have been enforced
// server-side since migrations 029 and 030 (v2_enforce_selling_model, called
// inside v2_submit_order), and none of them was visible anywhere in the
// wholesaler UI. You could not tell a ratio product from an open-stock one
// without opening it and reading a panel that -- until this same batch --
// opened off-screen.
//
// Hadi, 23 Aug 2026: "I can't see how to use the different ratio in the
// pre-pack and so on in the catalog."
//
// A rule the server enforces and the screen never mentions is the exact
// shape of the 2.0 loss this repo keeps a ledger about: the instruction
// survived in the data, the API exposed it, and the interface behaved as
// though it did not exist.
//
// ONE definition, imported by Products and by Catalogs, because two copies
// of a label is how the two screens start disagreeing about what a product
// is.

/** Full sentences — for detail panels, where there is room to explain. */
export const MODEL_LABEL = {
  open:    "Open — any quantity of any variant",
  ratio:   "Ratio — sizes bought in a fixed proportion",
  prepack: "Prepack — sold only as whole packs",
  series:  "Series — the whole size run or nothing",
};

/** Short — for a badge on a card, where there is not. */
export const MODEL_SHORT = {
  open:    "Open stock",
  ratio:   "Ratio",
  prepack: "Prepack",
  series:  "Full series",
};

/** Why it matters, on hover. The badge says what it is; the title says what
 *  it does to the buyer, which is the part that is actually load-bearing. */
export const MODEL_HINT = {
  open:    "Buyers can order any quantity of any size or colour, subject to the minimums.",
  ratio:   "Buyers order a fixed size curve per colour — the server rejects an order that breaks the proportion.",
  prepack: "Buyers order whole packs only. Stock still decrements per real SKU underneath.",
  series:  "Buyers take the entire size run for a colour or none of it.",
};

/**
 * The badge for a product's selling model, or null for plain open stock.
 *
 * Returns null for "open" ON PURPOSE. Open stock is the default and the
 * overwhelming majority; badging every card with "Open stock" would add a
 * row of identical grey pills to a grid and make the three models that DO
 * change how a buyer must order harder to spot, not easier. A badge earns
 * its place by being the exception.
 *
 * @param {string|null|undefined} model  v2_products.selling_model
 * @returns {{text:string, kind:string, title:string}|null}
 */
export function sellingModelBadge(model) {
  const key = model || "open";
  if (key === "open") return null;

  const text = MODEL_SHORT[key];
  if (!text) return null;               // an unknown model is not a badge to invent
  return { text, kind: "badge-info", title: MODEL_HINT[key] || "" };
}
