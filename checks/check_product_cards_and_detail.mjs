// =============================================================================
// CHECK: the product CARD and the read-only VIEW panel            (Batch 19)
// =============================================================================
// Hadi, on the inventory list: "It's too tiny. The thumbnail is ultra tiny.
// Instead of them being horizontal bars, make them vertical cards... where the
// thumbnail is the biggest piece." And: "I can't edit the product at all.
// Maybe there's a mistake. Maybe I want to look at the data. So give me a
// button to essentially edit or a button to view or both."
//
// This renders the REAL components in a real DOM (jsdom) against fixture data,
// rather than asserting on the source text. Source-text assertions pass on code
// that throws the moment it runs; this one only passes if the element tree the
// browser would build actually comes out right.
//
// The load-bearing assertion is the LAST one: the View panel must contain no
// input, select or textarea anywhere. "View" and "Edit" being different things
// is the entire point of Hadi's ask -- if View quietly renders editable fields
// then reading a product is one stray keystroke away from changing it, and the
// person who came to check a barcode leaves having silently altered a price.
// That is a promise about the panel that only a check can hold in place.
//
//   node checks/check_product_cards_and_detail.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;

const { renderProductTile, productGrid } = await import("../js/components/admin-product-tile.js");
const { renderProductDetail } = await import("../js/components/product-detail.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---------------------------------------------------------------- the card --
const grid = productGrid();
let viewed = 0, edited = 0;
const tile = renderProductTile({
  id: "p1",
  name: "Heavyweight Oversized Tee — Garment Dyed, Long Staple Cotton",
  images: ["https://example.test/a.webp", "https://example.test/b.webp", "https://example.test/c.webp"],
  badges: [{ text: "3 out", kind: "badge-danger" }, { text: "2 low", kind: "badge-warning" }],
  facts: [
    { label: "Available", value: "0", tone: "danger" },
    { label: "On hand", value: "12" },
    { label: "Colours & sizes", value: "7" },
  ],
  actions: [
    { label: "View", variant: "btn-primary", onClick: () => { viewed++; } },
    { label: "Edit", onClick: () => { edited++; } },
  ],
  onOpen: () => { viewed++; },
});
grid.appendChild(tile);

ok(grid.className === "pcard-grid", "the grid is a grid, not a stack of rows");
ok(tile.tagName === "ARTICLE" && tile.classList.contains("pcard"), "each product renders as one card");

// The photo must be the FIRST child, i.e. the top of a vertical card -- not a
// thumbnail sitting beside text. This is the difference Hadi described, and it
// is a structural fact, so it is checked structurally.
ok(tile.firstElementChild?.classList.contains("pcard-media"),
  "the photo is the first thing in the card, not a stamp beside the name");
ok(tile.querySelector(".pcard-media img")?.getAttribute("src") === "https://example.test/a.webp",
  "the first image is the one shown");
ok(tile.querySelector(".pcard-count")?.textContent === "3 photos",
  "and the card says how many more there are");
ok(tile.querySelector(".pcard-media").getAttribute("role") === "button" &&
   tile.querySelector(".pcard-media").getAttribute("tabindex") === "0",
  "the photo is reachable by keyboard, not mouse-only");

ok(tile.querySelector(".pcard-name")?.textContent.startsWith("Heavyweight Oversized Tee"),
  "the name renders");
ok(tile.querySelector(".pcard-name")?.getAttribute("title")?.length > 40,
  "the full name is on the title attribute, because the visible one clamps");
ok(tile.querySelectorAll(".pcard-badges .badge").length === 2, "both badges render");
ok(tile.querySelectorAll(".pcard-facts > div").length === 3, "all three facts render");
ok(!!tile.querySelector(".pcard-fact-danger"), "a zero-available card is toned as a problem");

const btns = [...tile.querySelectorAll(".pcard-actions .btn")];
ok(btns.length === 2, `both actions render as buttons (${btns.length})`);
ok(btns.map((b) => b.textContent).join("|") === "View|Edit",
  "View comes before Edit — the safe door first");
ok(btns[0].className.includes("btn-primary"), "View is the primary action");
btns[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
ok(edited === 1, "Edit fires its handler");
// A button click must NOT also fire the card's onOpen. Without the
// stopPropagation in the component, clicking Edit would open View underneath
// it and the editor would be buried by a panel the person never asked for.
ok(viewed === 0, "and clicking a button does not also trigger the card body");
tile.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
ok(viewed === 1, "clicking the card body opens the product");

const bare = renderProductTile({ id: "p2", name: "No photo yet", images: [] });
ok(bare.querySelector(".pcard-media-empty") && bare.querySelector(".pcard-media"),
  "a product with no photo keeps the same block so the grid stays a grid");

// ----------------------------------------------------------- the View panel --
const detail = {
  ok: true,
  product: {
    id: "p1", name: "Heavyweight Tee", description: "240gsm, boxy.",
    category: "T-shirts", selling_model: "prepack", moq_qty: 12,
    barcode: "5012345678900", archived: false,
  },
  supplier: {
    name: "Zhejiang Textiles", contactName: "Wei Zhang", phone: "+86 555 0100",
    address: "12 Loom Rd", country: "China", sells: ["knitwear", "denim"],
    brands: ["Loomcraft"], leadTime: "45 days", moq: "300 units",
    paymentTerms: "30% deposit", refCode: "ZJT-4",
  },
  images: ["https://example.test/a.webp", "https://example.test/b.webp"],
  colourBarcodes: [{ color: "Crimson", barcode: "5012345678917" }],
  variants: [
    {
      id: "v1", sku: "TEE-CRI-M", colour: "Crimson", colourHex: "#B91C1C", size: "M",
      price: 18.5, cost: 7.25, retailPrice: 45, moqQty: 6,
      sizeBarcode: "5012345678924", colourBarcode: "5012345678917",
      stock: [
        { locationId: "l1", locationName: "Main warehouse", onHand: 40, reserved: 6, available: 34 },
        { locationId: "l2", locationName: "Showroom", onHand: 5, reserved: 0, available: 5 },
      ],
      onHand: 45, available: 39,
    },
    {
      id: "v2", sku: "TEE-NAV-M", colour: "Deep Navy", colourHex: "#1E293B", size: "M",
      price: 18.5, cost: null, retailPrice: null, moqQty: 6,
      sizeBarcode: "", colourBarcode: "",
      stock: [], onHand: 0, available: 0,
    },
  ],
  archivedVariantCount: 1,
};

let editClicked = 0, closeClicked = 0;
const panel = renderProductDetail(detail, { onEdit: () => editClicked++, onClose: () => closeClicked++ });
const text = panel.textContent;

ok(!!panel.querySelector(".pdet-head h4"), "the panel names the product");
ok(/1 archived/.test(text), "it says how many variants are archived, rather than pretending they are gone");
ok(panel.querySelectorAll(".pdet-photo").length === 2, "every photo is in the strip");
ok(/T-shirts/.test(text), "category shows");
ok(/sold only as whole packs/i.test(text),
  "the selling model is spelled out, not left as the raw enum 'prepack'");

ok(/Zhejiang Textiles/.test(text) && /Wei Zhang/.test(text) && /\+86 555 0100/.test(text),
  "the supplier and how to reach them show");
ok(/knitwear, denim/.test(text), "what the supplier sells shows — Hadi: \"what category do they sell?\"");
ok(/Loomcraft/.test(text), "and what brands they hold");

// All three tiers, on screen together. This is the only place in the app where
// you can see WHY a scan resolved to seven variants instead of one.
ok(/5012345678900/.test(text), "the product-level barcode shows");
ok(/5012345678917/.test(text), "the colour-level barcode shows");
ok(/5012345678924/.test(text), "the size-level barcode shows");
ok(panel.querySelectorAll(".pdet-code").length >= 3, "all three tiers render as codes at once");
ok((text.match(/not set/g) || []).length >= 2,
  "a missing barcode says 'not set' rather than leaving a blank cell that could equally mean 'failed to load'");

ok(/Main warehouse/.test(text) && /Showroom/.test(text),
  "stock is broken down by location, not just totalled");
ok(/34<\/strong> available \(6 held\)/.test(panel.innerHTML.replace(/<strong>/g, "<strong>")) ||
   /6 held/.test(text),
  "reserved units are shown as held, so available and on-hand disagreeing is explained");
ok(/Never received into stock/.test(text),
  "a variant that has never been stocked says so, instead of reading as zero");
ok(/7\.25/.test(text), "cost is visible here — it is safe to show in a panel that cannot be typed into");
ok(!!panel.querySelector(".pdet-swatch"), "the colour swatch renders");

panel.querySelector(".pdet-edit").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
panel.querySelector(".pdet-close").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
ok(editClicked === 1, "View leads into Edit");
ok(closeClicked === 1, "and it closes");

// THE ONE THAT MATTERS.
const editable = panel.querySelectorAll("input, textarea, select, [contenteditable]");
ok(editable.length === 0,
  `the View panel contains nothing editable (${editable.length} field${editable.length === 1 ? "" : "s"} found) — reading a product must never be one keystroke away from changing it`);

// ------------------------------------------------- the views are wired up --
// Static, and labelled as such: without a database this cannot render the real
// screens, so it asserts only that each one reaches for the card component and
// offers both doors. It would not catch a runtime failure inside those views.
const wsrc = readFileSync("js/views/wholesaler.js", "utf8");
for (const [view, marker] of [
  ["Inventory", "async function inventoryView"],
  ["Products", "async function productsView"],
  ["Catalogs", "async function catalogsView"],
]) {
  const start = wsrc.indexOf(marker);
  const body = wsrc.slice(start, start + 12000);
  ok(start > -1 && /renderProductTile\(/.test(body), `${view} builds cards with the shared tile`);
  ok(/label: "View"/.test(body), `${view} offers a View button`);
  ok(/label: "Edit"/.test(body), `${view} offers an Edit button`);
}
ok(!/table\.appendChild\(row\(p\)\)/.test(wsrc), "the old horizontal text-row list is gone");

console.log("=".repeat(64));
console.log(" CHECK — PRODUCT CARDS AND THE READ-ONLY VIEW PANEL");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
