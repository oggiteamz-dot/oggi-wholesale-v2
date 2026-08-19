// =============================================================================
// CHECK: the catalog builder — settings, the two buttons, and the picker
// =============================================================================
// Hadi: "in the catalog builder... they can create the actual catalog, create
// the name, and the other stuff in it. After they set up the original side,
// they can then add products. There will be two buttons. One's going to be
// create new product. And the second one pick product from inventory. And when
// they click the product from inventory, the list of all the different
// products will pop up. And they can click multiple ones to add them."
//
// The picker is rendered for real in a DOM. Two of its behaviours are easy to
// get wrong and expensive to discover late, so they are pinned here:
//
//   1. SELECTION SURVIVES SEARCHING. Tick two, type in the search box, tick a
//      third -- all three must still be selected. Reading the ticks off the
//      checkboxes would lose them on every re-render, and losing a selection
//      to a keystroke is the kind of small betrayal that makes people stop
//      trusting a screen.
//
//   2. PRODUCTS ALREADY IN THE CATALOG ARE SHOWN BUT NOT SELECTABLE. Hiding
//      them would send a wholesaler hunting for a product they know they own.
//
//   node checks/check_catalog_builder.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://app.test/" });
for (const k of ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "Event", "MouseEvent"]) {
  try { globalThis[k] = dom.window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}

const { renderProductPicker } = await import("../js/components/product-picker.js");
globalThis.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };
const { settingsProblem, DISCOUNT_MODES } = await import("../js/data/catalogs.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---- the three settings, and the bounds the database also enforces ---------
ok(DISCOUNT_MODES.length === 3, `three discount modes offered (${DISCOUNT_MODES.length})`);
ok(DISCOUNT_MODES.map((m) => m.value).join(",") === "combine,catalog_only,customer_only",
  "combine, catalog only, customer only");
ok(DISCOUNT_MODES.every((m) => m.help && m.help.length > 20),
  "each mode explains itself in words, not just a label");

const good = { accessTier: 2, discountPct: -10, discountMode: "combine" };
ok(settingsProblem(good) === null, "a -10% catalog at tier 2 is valid — a negative discount is a supported input");
ok(/whole number from 1 to 5/.test(settingsProblem({ ...good, accessTier: 9 }) || ""),
  "tier 9 is refused, in words that say what to type instead");
ok(/between -100 and 100/.test(settingsProblem({ ...good, discountPct: 250 }) || ""),
  "250% is refused before the database has to");
ok(settingsProblem({ ...good, discountMode: "whatever" }) !== null, "an unknown mode is refused");
ok(settingsProblem({ ...good, accessTier: 2.5 }) !== null, "tier 2.5 is refused");

// ---- the picker: a wall of photographs, not a list of bars -----------------
const products = [
  { id: "p1", name: "Heavyweight Hoodie", variantCount: 6, priceRange: [18, 22], available: 40, onHand: 44, images: ["u1"], colors: [{ name: "Crimson" }], variants: [{ sku: "HOOD-CRI-M" }] },
  { id: "p2", name: "Wide-Leg Denim",     variantCount: 9, priceRange: [30, 30], available: 12, onHand: 12, images: ["u2"], colors: [{ name: "Indigo" }],  variants: [{ sku: "DEN-IND-32" }] },
  { id: "p3", name: "Linen Camp Shirt",   variantCount: 4, priceRange: [0, 0],   available: 0,  onHand: 0,  images: [],     colors: [],                    variants: [] },
  { id: "p4", name: "Already Filed Tee",  variantCount: 2, priceRange: [9, 9],   available: 5,  onHand: 5,  images: ["u4"], colors: [],                    variants: [] },
];

let added = null;
const picker = renderProductPicker({
  products,
  alreadyIn: new Set(["p4"]),
  catalogName: "Summer 26",
  cardFacts: ["price", "available", "onHand"],
  locations: [],
  onAdd: async (ids) => { added = ids; },
  onClose: () => {},
});
document.body.appendChild(picker.el);
const el = picker.el;

const cards = () => [...el.querySelectorAll(".picker-card")];

ok(cards().length === 4, `every product is a card, including the one already filed (${cards().length})`);
// Hadi: "I don't want it to be a bar. I want them to be large images." The
// photo block is the first child of the tile, so this is a structural fact and
// is checked structurally rather than by looking at CSS.
ok(cards().every((c) => c.firstElementChild?.classList.contains("pcard-media")),
  "each card leads with the photo, not a stamp beside text");
ok(el.querySelector(".pcard-grid"), "and they are laid out as a grid");
ok(el.querySelectorAll(".picker-row").length === 0, "the old row layout is gone");

ok(el.querySelectorAll(".picker-card-in").length === 1, "the already-filed one is marked");
ok(/Already in this catalog/i.test(el.textContent), "and says so in words");
ok(el.querySelector(".picker-card-in").getAttribute("role") !== "checkbox",
  "and cannot be ticked");

const addBtn = el.querySelector(".picker-add");
ok(addBtn.disabled, "Add is disabled until something is picked");

function tick(name) {
  const card = cards().find((c) => c.textContent.includes(name));
  card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

tick("Heavyweight Hoodie");
tick("Wide-Leg Denim");
ok(!addBtn.disabled && /Add 2 products/.test(addBtn.textContent),
  `the button counts what is picked (“${addBtn.textContent}”)`);
ok(el.querySelectorAll(".picker-card-on").length === 2, "and the picked cards are visibly picked");

// A card must be reachable and operable by keyboard, since the whole card is
// the target and there is no checkbox left to tab to.
const first = cards().find((c) => !c.classList.contains("picker-card-in"));
ok(first.getAttribute("role") === "checkbox" && first.tabIndex === 0,
  "a pickable card is a real checkbox to a screen reader, and reachable by tab");
ok(first.getAttribute("aria-checked") === "true", "and reports whether it is picked");

// THE ONE THAT MATTERS: searching re-renders, and must not lose the picks.
const search = el.querySelector(".picker-search");
search.value = "linen";
search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
ok(cards().length === 1, "searching filters the wall");
ok(/Add 2 products/.test(addBtn.textContent),
  `and the two already picked are still picked (“${addBtn.textContent}”) — off screen, not forgotten`);

tick("Linen Camp Shirt");
ok(/Add 3 products/.test(addBtn.textContent), "a third can be picked from the filtered wall");

search.value = "";
search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
ok(el.querySelectorAll(".picker-card-on").length === 3,
  `clearing the search brings all three back still picked (${el.querySelectorAll(".picker-card-on").length})`);

// Clicking a picked card again must UNPICK it, or there is no way to correct a
// mis-tap on a screen where the whole card is the target.
tick("Linen Camp Shirt");
ok(/Add 2 products/.test(addBtn.textContent), "clicking a picked card again unpicks it");
tick("Linen Camp Shirt");

search.value = "zzzz";
search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
ok(/Nothing matches/.test(el.textContent), "a search with no matches says so rather than showing an empty box");
search.value = "";
search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

addBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
ok(added && added.length === 3 && !added.includes("p4"),
  `Add hands over exactly the three picked, never the already-filed one (${JSON.stringify(added)})`);

// ---- the view is wired to all of it ----------------------------------------
// Static, and labelled as such: without a database this cannot render the real
// Catalogs screen, so it asserts only that the screen reaches for these pieces.
const src = readFileSync("js/views/wholesaler.js", "utf8");
const view = src.slice(src.indexOf("async function catalogsView"));
ok(/\+ Create new product/.test(view), "Catalogs offers “+ Create new product”");
ok(/Pick from inventory/.test(view), "and “Pick from inventory”");
ok(/renderProductPicker\(/.test(view), "which opens the real picker");
ok(/addProductsToCatalog\(/.test(view), "and files the chosen products in one call");
ok(/catalogSettingsCard\(/.test(view), "the settings card is on the screen");
ok(/updateCatalogSettings\(/.test(view), "and saves tier, discount and mode");
ok(/cat-tier[\s\S]{0,2000}cat-discount[\s\S]{0,2000}cat-mode/.test(view),
  "all three settings are present, in that order");
ok(/pay \$\{pct\}% LESS|% LESS than the price/.test(view),
  "the discount box says in words what the number will do — “-10” is read as “ten percent off” by someone in a hurry");

// ---- the link is the only way in ------------------------------------------
// Hadi: "There is no website for the actual buyer. That's never going to
// happen... There is just a custom link for each catalog."
ok(/catalogLink\(/.test(view), "the settings card builds the link the wholesaler sends");
ok(/Copy link/.test(view), "with a Copy button");
ok(/setCatalogPublic\(/.test(view), "the public toggle is wired");
ok(/rotateCatalogLink\(/.test(view), "and a way to kill every link already sent");

const buyerSrc = readFileSync("js/views/buyer.js", "utf8");
ok(/router\.register\("\/c\/:token"/.test(buyerSrc), "the link resolves to a real route");
[["dead link", /not_found/], ["asks for a login", /login_required/], ["refuses the wrong account", /denied/]]
  .forEach(([what, re]) => ok(re.test(buyerSrc), `and handles ${what}`));
// The switcher was the browsable storefront that is never being built.
ok(!/buyer-catalog-tabs/.test(buyerSrc),
  "the buyer catalog switcher is GONE — there is no browse-my-catalogs screen");

console.log("=".repeat(64));
console.log(" CHECK — THE CATALOG BUILDER");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
