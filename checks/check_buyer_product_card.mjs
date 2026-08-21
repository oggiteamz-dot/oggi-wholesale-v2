// =============================================================================
// CHECK: the buyer's product card, rendered                        (Batch 5)
// =============================================================================
// There has never been a gate on this component. checks/check_product_cards_
// and_detail.mjs covers the WHOLESALER's tile and view panel; the card the
// customer actually shops from had none -- which is how it went from Batch 2
// to Batch 19 rendering no <img> at all while js/data/catalog.js fetched
// image_url and images on every request and dropped them one line later. The
// one wholesaler on production with real photography has a photo on all 46 of
// their variants, and their buyers saw a wall of text.
//
// A missing picture is not the kind of bug a source-text check finds, because
// there is no wrong line to find -- only an absent one. So this renders the
// real component into a real DOM and asks what a customer would see.
//
// It also pins the three things Batch 5 promised, in Hadi's words (20 Aug):
//   "The price they will read in the thumbnail is going to be the per unit
//    price ... every single time they click plus on the colour red they get
//    20 ... they see that there's a x12 or x20 next to it, which will be
//    multiplied in the final total."
//
//   node checks/check_buyer_product_card.mjs
// =============================================================================
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://check.local/", pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
// node 22 exposes globalThis.crypto as a getter-only property, so it is given
// to the jsdom window instead -- which is where the modules under test look.
if (!dom.window.crypto?.randomUUID) dom.window.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };
// The card's module graph reaches the Supabase client. Nothing here goes near
// the network -- every assertion is about the element tree.
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const { renderProductCard } = await import("../js/components/product-card.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
// A gate must SAY what is wrong, not throw. Run against the pre-Batch-5 card
// this file died on a TypeError at the first missing element and reported none
// of the other 43 findings -- which is exactly the "a check that only asserts
// something failed will eventually lie" trap. attr() and text() return safe
// empty values so every assertion gets to run and name itself.
const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);
const text = (el) => (el && el.textContent != null ? el.textContent : "");

const RED = "https://cdn.test/red-1.webp";
const RED2 = "https://cdn.test/red-2.webp";
const BLUE = "https://cdn.test/blue-1.webp";

function makeProduct(over = {}) {
  const variants = [
    { id: "v-r-s", sku: "R-S", price: 8, color: "Red", colorHex: "#c00", size: "S", available: 100, moqQty: 1, retailPrice: null, imageUrl: RED, images: [RED, RED2] },
    { id: "v-r-m", sku: "R-M", price: 8, color: "Red", colorHex: "#c00", size: "M", available: 100, moqQty: 1, retailPrice: null, imageUrl: RED, images: [] },
    { id: "v-b-s", sku: "B-S", price: 8, color: "Blue", colorHex: "#00c", size: "S", available: 100, moqQty: 1, retailPrice: null, imageUrl: BLUE, images: [] },
  ];
  const imagesByColor = new Map([["Red", [RED, RED2]], ["Blue", [BLUE]]]);
  return {
    id: "p1", name: "Boxy Cotton Tee", description: "", createdAt: new Date().toISOString(),
    sellingModel: "open", isNew: false, lowStock: false, outOfStock: false,
    minPrice: 8, maxPrice: 8,
    colors: [{ name: "Red", hex: "#c00" }, { name: "Blue", hex: "#00c" }],
    sizes: ["S", "M"], variants,
    moqQty: 1, moqReorderQty: null, moqPerColour: null,
    baseUnit: 1, imagesByColor, primaryImage: RED,
    ...over,
  };
}

function render(over = {}, opts = {}) {
  localStorage.clear();
  return renderProductCard({
    product: makeProduct(over), wid: "wtest", locationId: "loc1", currency: "$",
    tiers: [], overridesByVariant: new Map(), packs: [], onCartChange: () => {},
    ...opts,
  });
}

// ---------------------------------------------------------------- the photo --
{
  const card = render();
  const img = card.querySelector(".pc-photo img");
  ok(!!img, "the card renders a real <img> — the whole point of this gate, and the thing that was missing from Batch 2 to Batch 19");
  ok(attr(img, "src") === RED, `and it is the SELECTED colour's photo (got ${attr(img, "src")})`);
  ok(attr(img, "loading") === "lazy", "lazily, so a 40-product grid does not fetch 40 photos before the first one is on screen");
  ok(/Red/.test(attr(img, "alt") || ""), "with alt text naming the product and the colour");
  ok((attr(card.querySelector(".pc-photo"), "style") || "").includes("aspect-ratio"),
     "in a box whose height is reserved before the image loads, so the card does not jump under the reader's thumb");

  // Rule 1: the picture follows the swatch.
  const swatches = card.querySelectorAll(".swatch-row .color-swatch");
  ok(swatches.length === 2, `two colour swatches (got ${swatches.length})`);
  if (swatches[1]) swatches[1].dispatchEvent(new dom.window.Event("click"));
  ok(attr(card.querySelector(".pc-photo img"), "src") === BLUE,
     "selecting Blue shows the BLUE photo — showing the red one would be worse than showing nothing");

  // More than one photo for a colour is announced rather than hidden.
  if (swatches[0]) swatches[0].dispatchEvent(new dom.window.Event("click"));
  const more = [...card.querySelectorAll(".pc-photo button")].find((b) => /more/.test(b.textContent));
  ok(text(more) === "+1 more", `Red's second photo is offered ("${text(more)}")`);
}

// ------------------------------------------------- no photography at all ----
{
  const card = render({ imagesByColor: new Map(), primaryImage: null });
  ok(!card.querySelector(".pc-photo img"), "a product with no photos renders NO <img>");
  ok(/No photo yet/.test(text(card.querySelector(".pc-photo"))),
     "and says so, because an unexplained grey box reads as a failure");
}

// ------------------------------------------------ a photo that 404s ---------
{
  const card = render();
  const img = card.querySelector(".pc-photo img");
  if (img) img.dispatchEvent(new dom.window.Event("error"));
  ok(!!img && !card.querySelector(".pc-photo img"), "a dead image URL falls back to the placeholder");
  ok(/No photo yet/.test(text(card.querySelector(".pc-photo"))), "not to a broken-image icon");
}

// ------------------------------------------- the price is the EFFECTIVE one --
{
  const plain = render();
  ok(/\$8\.00/.test(plain.textContent), "with no discount the card shows $8.00");
  ok(/per piece/.test(plain.textContent), "labelled per piece, not just a bare number");

  const discounted = render({}, { discountPct: 25 });
  ok(/\$6\.00/.test(discounted.textContent),
     "in a 25% catalog the card shows $6.00 — the price the buyer will actually be charged");
  ok(!/\$8\.00/.test(discounted.textContent.split("per piece")[0]),
     "and does not lead with the list price it used to show (product.minPrice, undiscounted)");

  // A CUSTOMER's own share may be struck through; a catalog's own may not.
  const cust = render({}, { discountPct: 25, customerPct: 25 });
  ok(!!cust.querySelector("s.pc-was"), "a customer discount shows a struck-through before-price");
  const catOnly = render({}, { discountPct: 25, customerPct: 0 });
  ok(!catOnly.querySelector("s.pc-was"),
     "a catalog-only discount shows ONE price and no strikethrough — the catalog's share is silent by design");
}

// ------------------------------------------------------- the x N multiplier --
{
  const single = render({ baseUnit: 1 });
  ok(!single.querySelector(".pc-multiplier"), "a product sold by the single piece shows no multiplier badge");

  const twelve = render({ baseUnit: 12 });
  const badge = twelve.querySelector(".pc-multiplier");
  ok(text(badge) === "×12", `a base unit of 12 shows "×12" (got ${text(badge)})`);
  ok(/units of 12/.test(twelve.textContent), "and says in words that it is sold in units of 12");
}

// -------------------------------------------------- + steps by the base unit --
{
  const card = render({ baseUnit: 12 });
  // Choose a size to reveal the stepper.
  const sizeChip = card.querySelectorAll("button.btn-secondary");
  const chip = [...sizeChip].find((b) => b.textContent === "S");
  ok(!!chip, "a size chip is offered for an open-stock product");
  if (chip) chip.dispatchEvent(new dom.window.Event("click"));

  const qty = card.querySelector('input[type="number"]') || { value: "(no qty input)" };
  const plus = [...card.querySelectorAll("button.pc-step")].find((b) => b.textContent === "+");
  const minus = [...card.querySelectorAll("button.pc-step")].find((b) => b.textContent === "−");
  ok(!!plus && !!minus, "the stepper has real + and − buttons, not the number input's own spinners");

  if (plus) plus.dispatchEvent(new dom.window.Event("click"));
  ok(qty.value === "12", `one press of + adds a whole unit: 12 pieces (got ${qty.value}) — Hadi: "every single time they click plus on the colour red they get 20"`);
  if (plus) plus.dispatchEvent(new dom.window.Event("click"));
  ok(qty.value === "24", `two presses is 24 (got ${qty.value})`);
  if (minus) minus.dispatchEvent(new dom.window.Event("click"));
  ok(qty.value === "12", `− takes a whole unit back off (got ${qty.value})`);

  // A typed part-unit is corrected, not silently accepted and then refused.
  qty.value = "13";
  if (qty.dispatchEvent) qty.dispatchEvent(new dom.window.Event("blur"));
  ok(qty.value === "24", `typing 13 rounds UP to the next whole unit, 24 (got ${qty.value})`);

  // And the multiplication is written out where the buyer can read it.
  qty.value = "24";
  if (qty.dispatchEvent) qty.dispatchEvent(new dom.window.Event("input"));
  ok(/24<\/strong> pieces/.test(card.innerHTML) || /24\s*pieces/.test(card.textContent),
     "the feedback states the piece count");
  ok(/\$192\.00/.test(card.textContent), "and the total: 24 pieces at $8.00 = $192.00");
}

// ------------------------------------------------ a single-piece product -----
{
  const card = render({ baseUnit: 1 });
  const chip = [...card.querySelectorAll("button.btn-secondary")].find((b) => b.textContent === "S");
  if (chip) chip.dispatchEvent(new dom.window.Event("click"));
  const qty = card.querySelector('input[type="number"]') || { value: "(no qty input)" };
  const plus = [...card.querySelectorAll("button.pc-step")].find((b) => b.textContent === "+");
  if (plus) plus.dispatchEvent(new dom.window.Event("click"));
  ok(qty.value === "1", `with no base unit, + adds one piece (got ${qty.value}) — nothing changes for the products that have always been sold this way`);
}

// ------------------------------------------------------------ pack pricing --
{
  const pack = {
    id: "pk1", name: "Boutique Pack", color: "Red", productId: "p1", unitCount: 12,
    price: 96, flatPackPrice: 50, isFlatPrice: true,
    components: [
      { variantId: "v-r-s", qtyPerPack: 6, price: 8, sku: "R-S", color: "Red", size: "S" },
      { variantId: "v-r-m", qtyPerPack: 6, price: 8, sku: "R-M", color: "Red", size: "M" },
    ],
  };
  const card = render({ sellingModel: "prepack" }, { packs: [pack] });
  ok(/Sold in fixed cartons/.test(card.textContent), "a prepack product explains how it is sold");
  ok(!card.querySelector("button.pc-step"), "and offers no per-size stepper, because the server refuses loose lines for it");
  ok(/\$8\.00/.test(card.textContent), "the pack quotes a PER PIECE price");
  const badge = [...card.querySelectorAll(".pc-multiplier")].find((b) => b.textContent === "×12");
  ok(!!badge, "with a ×12 badge for the pieces in one pack");
  ok(!/\$50\.00/.test(card.textContent),
     "and NEVER the stored flat pack price of $50.00 — decision D4: v2_submit_order does not read pack_price, so showing it would be quoting a number nobody is charged");

  // Discounted, the pack must quote the discounted piece price.
  const disc = render({ sellingModel: "prepack" }, { packs: [pack], discountPct: 25 });
  ok(/\$6\.00/.test(disc.textContent),
     "in a 25% catalog the pack quotes $6.00 a piece — it used to quote the undiscounted $96.00 total while the invoice came to $72.00");
}

// ------------------------------------------------ nothing was lost on the way --
{
  const card = render({ isNew: true, outOfStock: false, lowStock: true, moqQty: 24 });
  ok(/New/.test(card.textContent), "the New badge still renders");
  ok(/Low stock/.test(card.textContent), "the Low stock badge still renders");
  ok(/Min 24/.test(card.textContent), "the product minimum still renders");
  ok(!!card.querySelector("button[aria-label='Open 360-degree product view']"), "the 360° button is still there");
  ok(card.dataset.productId === "p1", "and the card is still findable by product id, which the billboard's button needs");

  const hl = render({}, { highlighted: true });
  ok(hl.classList.contains("product-card-highlighted"), "a highlighted product still says so");

  const empty = render({ sellingModel: "series" }, { packs: [] });
  ok(/cannot be ordered/.test(empty.textContent), "a bundle product with no bundles set up still warns instead of showing a dead card");
}

// ------------------------------------------------------- per-colour minimum --
{
  const card = render({ moqPerColour: 30 });
  ok(/30 pieces of each colour/.test(card.textContent),
     "a per-colour minimum is stated up front — the server enforces it (migration 063) and no screen used to mention it, so buyers met the product MOQ and were refused at checkout by a rule they had never seen");
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
