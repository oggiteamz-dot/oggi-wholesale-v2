// =============================================================================
// OGGI Wholesale v2 — THE ORDER BAR                        GAP-4, 28 Aug 2026
// =============================================================================
//
// WHAT WAS MISSING
// ----------------
// The approved buyer mockup (24 Aug) pins a bar to the bottom of the
// catalogue: how many pieces are in the order, what they come to, and the way
// onward. Nothing like it shipped.
//
// What existed instead was a badge on the TOPBAR, and it has two problems the
// mockup's bar does not:
//
//   1. It is at the top of the screen. ~85% of phone touches are thumb-driven
//      (Hoober, 1,333 field observations) -- the same measurement that put the
//      navigation at the bottom in js/components/bottomnav.js. A running total
//      a buyer has to reach for is a running total they stop reading.
//   2. It adds packs and pieces together. cart.count() returns
//      `l.isPack ? l.packQty : l.qty`, so two boxes of twelve and two loose
//      shirts both read "2". For a wholesale buyer, whose entire question is
//      "how many pieces have I taken", that number is not wrong so much as
//      meaningless.
//
// So this counts PIECES -- expanding every pack into the units inside it --
// and prices them through priceCart(), whose subtotal is the value that has to
// equal v2_orders.subtotal. The bar and the invoice cannot disagree, because
// they are the same function.
//
// ONE DELIBERATE DEVIATION FROM THE MOCKUP, stated rather than smuggled:
// the mockup's button says "Submit order" and submits. Here it says "Review
// order" and opens the cart. The mockup is a single screen; the real app has a
// cart screen that carries the buyer's order note (Batch N step 1, shipped
// 28 Aug), their name, and the per-line notes. A submit button on the
// catalogue would walk a buyer straight past all three -- shipping a
// regression to honour a drawing. Flagged to Hadi; his call to change it.
//
// NO PAYMENT LANGUAGE. checks/check_no_payment_path.mjs fails the build on any
// phrase promising a payment action, and it is right to: Hadi, 24 Aug --
// "there will be no card needed... No money will be paid through this app."
// =============================================================================

import { priceCart } from "../data/line-pricing.js";
import { cart } from "../data/cart.js";
import { money } from "../lib/utils.js";

/** Pieces, not lines. A pack is the units inside it. */
export function piecesInCart(lines) {
  return (lines || []).reduce((n, l) => n + (l.isPack
    ? (l.components || []).reduce((s, c) => s + c.qtyPerPack * l.packQty, 0)
    : (l.qty || 0)), 0);
}

/**
 * @param wid            the wholesaler being shopped
 * @param currency       display currency
 * @param pricingCtx     { basePriceFor, tiersByProduct, overridesByVariant,
 *                         discountPct, customerPct } -- the same context the
 *                         cards are given, so the bar quotes the same numbers
 * @param onReview       called when the buyer presses through to the cart
 */
export function renderOrderBar({ wid, currency = "$", pricingCtx = {}, onReview }) {
  const bar = document.createElement("div");
  bar.className = "order-bar";
  bar.setAttribute("role", "status");
  // Announced politely: a total that re-reads itself on every press would talk
  // over a screen-reader user filling a sixteen-cell sheet.
  bar.setAttribute("aria-live", "polite");

  const summary = document.createElement("div");
  summary.className = "order-bar-summary";
  const action = document.createElement("button");
  action.type = "button";
  action.className = "btn btn-primary order-bar-cta";
  action.textContent = "Review order";
  action.addEventListener("click", () => { if (onReview) onReview(); });
  bar.appendChild(summary);
  bar.appendChild(action);

  function paint() {
    const lines = cart.get(wid);
    const pieces = piecesInCart(lines);
    if (!pieces) {
      bar.classList.add("order-bar-empty");
      // Says what it is, rather than showing "0 pieces · $0.00" -- a row of
      // zeroes reads as a broken total, an empty state reads as a fact.
      summary.innerHTML = `<span class="order-bar-idle">Nothing in the order yet</span>`;
      action.disabled = true;
      return;
    }
    bar.classList.remove("order-bar-empty");
    action.disabled = false;
    const { subtotal } = priceCart(lines, pricingCtx);
    summary.innerHTML =
      `<strong class="order-bar-pieces">${pieces}</strong> pieces` +
      `<span class="order-bar-sep">·</span>` +
      `<strong class="order-bar-total">${money(subtotal, currency)}</strong>`;
  }

  paint();
  document.addEventListener("v2:cart-changed", paint);
  // Handed back so a view that tears itself down does not leave a listener
  // repainting a bar that is no longer on the page.
  bar.destroy = () => document.removeEventListener("v2:cart-changed", paint);
  return bar;
}
