// =============================================================================
// CHECK: the order bar                                     GAP-4, 28 Aug 2026
// =============================================================================
// The approved buyer mockup pins a bar to the bottom of the catalogue -- how
// many pieces, what they come to, and the way onward. Nothing like it shipped;
// what existed was a topbar badge that adds packs and pieces together.
//
// Two things this gate exists to stop coming back:
//   1. counting a pack as "1" -- cart.count() does exactly that, and a
//      wholesale buyer's whole question is how many PIECES they have taken;
//   2. a total that disagrees with the invoice, which is what happens the
//      moment anyone sums the numbers on screen instead of calling priceCart().
//
//   node checks/check_order_bar.mjs
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
if (!dom.window.crypto?.randomUUID) dom.window.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };
dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };

const { renderOrderBar, piecesInCart } = await import("../js/components/order-bar.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const text = (el) => (el && el.textContent != null ? el.textContent : "");

const WID = "w1";
const seed = (lines) => localStorage.setItem(`oggi-v2-cart-${WID}`, JSON.stringify(lines));
const ctx = {
  basePriceFor: () => 8,
  tiersByProduct: new Map(), overridesByVariant: new Map(),
  discountPct: 0, customerPct: 0,
};
const bar = (over = {}) => renderOrderBar({ wid: WID, currency: "USD", pricingCtx: { ...ctx, ...over } });

// ------------------------------------------------------------ empty state --
{
  localStorage.clear(); seed([]);
  const el = bar();
  ok(/Nothing in the order yet/i.test(text(el)),
     "an empty order says so in words rather than showing a row of zeroes");
  const cta = el.querySelector(".order-bar-cta");
  ok(cta && cta.disabled, "and the way onward is disabled until there is something to review");
}

// ------------------------------------------------- pieces, not cart lines --
{
  localStorage.clear();
  // Two boxes of twelve. cart.count() calls this "2".
  seed([{ isPack: true, packId: "pk1", productId: "p1", packQty: 2, unitCount: 12,
          components: [{ variantId: "v1", qtyPerPack: 6 }, { variantId: "v2", qtyPerPack: 6 }] }]);
  const el = bar();
  ok(/24\s*pieces/i.test(text(el)),
     `two 12-piece boxes read as 24 pieces, not 2 (got "${text(el).trim()}")`);
  // CR-0008. The first version of this block asserted the piece count and
  // nothing else, and went green while the bar displayed USD0.00 beside it --
  // a gate looking straight at the defect and not seeing it, because it had
  // not been told to look at the money. That is how this one was found.
  ok(/192\.00/.test(text(el)),
     `and those 24 pieces at $8.00 are priced at $192.00, not nothing (got "${text(el).trim()}")`);
  ok(piecesInCart([{ isPack: true, packQty: 2, components: [{ variantId: "v1", qtyPerPack: 6 }] }]) === 12,
     "piecesInCart expands a pack into the units inside it");
}

// -------------------------------------------- the total agrees with priceCart --
{
  localStorage.clear();
  seed([{ variantId: "v1", productId: "p1", qty: 5, price: 8, listPrice: 8 }]);
  const el = bar();
  ok(/40\.00/.test(text(el)), `5 pieces at $8.00 totals $40.00 (got "${text(el).trim()}")`);
}
{
  localStorage.clear();
  seed([{ variantId: "v1", productId: "p1", qty: 5, price: 8, listPrice: 8 }]);
  const el = bar({ discountPct: 25, customerPct: 25 });
  ok(/30\.00/.test(text(el)),
     `in a 25% catalog the same 5 pieces total $30.00, not $40.00 (got "${text(el).trim()}")`);
  ok(!/40\.00/.test(text(el)), "and the undiscounted total appears nowhere on the bar");
}

// ------------------------------------------------------------- it updates --
{
  localStorage.clear(); seed([]);
  const el = bar();
  ok(/Nothing in the order/i.test(text(el)), "starts empty");
  seed([{ variantId: "v1", productId: "p1", qty: 3, price: 8, listPrice: 8 }]);
  document.dispatchEvent(new dom.window.CustomEvent("v2:cart-changed"));
  ok(/3\s*pieces/i.test(text(el)), "and repaints when the cart changes, without the view re-rendering it");

  // A bar torn off the page must stop listening, or every visit to the
  // catalogue leaves another one repainting a detached node forever.
  el.destroy();
  seed([{ variantId: "v1", productId: "p1", qty: 9, price: 8, listPrice: 8 }]);
  document.dispatchEvent(new dom.window.CustomEvent("v2:cart-changed"));
  ok(/3\s*pieces/i.test(text(el)), "and stops listening once destroyed, so a stale bar cannot leak");
}

// ------------------------------------------------------- no payment claim --
{
  localStorage.clear();
  seed([{ variantId: "v1", productId: "p1", qty: 1, price: 8, listPrice: 8 }]);
  const t = text(bar()).toLowerCase();
  ok(!/pay|checkout|card|billing/.test(t),
     "the bar promises no payment action — Hadi, 24 Aug: \"no money will be paid through this app\"");
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
