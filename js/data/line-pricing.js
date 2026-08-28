// OGGI Wholesale v2 — one arithmetic for what a cart costs (Batch 5)
//
// WHY THIS FILE EXISTS
// --------------------
// Until now the buyer app priced a cart in two different ways depending on
// what kind of line it was, and only one of them agreed with the invoice.
//
//   * A LOOSE line went through effectivePrice() -- negotiated price, then
//     quantity break, then the discount percentage -- which is a faithful
//     mirror of wholesale_v2.v2_effective_unit_price.
//
//   * A PACK line did not go through it at all. It used the pack's own
//     `price` field: v2_pack_definitions.pack_price when the wholesaler had
//     set one, otherwise the sum of its components at LIST price. No
//     negotiated price, no quantity break, no discount.
//
// The server has never had two ways. v2_submit_order prices EVERY line the
// same: qty x v2_effective_unit_price(...), pack lines included, and it does
// not read pack_price at all (verified against the live function body, 21 Aug
// 2026 -- the string "pack_price" does not appear in it). So a buyer looking
// at a pack in a discounted catalog was shown the undiscounted total and
// invoiced the discounted one. Nobody notices a cart that is too expensive
// until the invoice is cheaper, and nobody trusts either number afterwards.
//
// This module is the single answer to "what does this cart cost", used by the
// product card, by the cart screen, and by checks/check_line_pricing.mjs,
// which runs its output against the real SQL function. One implementation can
// be wrong. It cannot silently disagree with itself.
//
// PURITY: no network, no DOM. It takes data and returns numbers, so the gate
// can run it in node against worked examples.

import { effectivePrice, round2 } from "./pricing.js";

/**
 * Every piece in this cart line, whatever shape the line has.
 *
 * A loose line is one variant at some qty. A pack line is N packs, each of
 * which is a fixed composition of component variants -- so the real piece
 * count is the sum over components of qtyPerPack x packQty. This is the same
 * expansion cart.submit() does when it builds the RPC payload, which is what
 * makes the aggregate below match the server's own `agg` CTE.
 *
 * Returns [{ variantId, qty }], never a total, because the caller needs the
 * per-variant split to price each piece at its own variant's price.
 */
export function linePieces(line) {
  if (line?.isPack) {
    return (line.components || []).map((c) => ({
      variantId: c.variantId,
      qty: c.qtyPerPack * line.packQty,
      // CR-0008, 28 Aug 2026. This was `Number(c.price ?? 0)`.
      //
      // priceLine() only consults ctx.basePriceFor when basePrice IS NULL, and
      // `0` is not null -- so a component with no price of its own became a
      // component priced at ZERO, and the lookup that would have found the
      // real price was never reached. cart.addPack() writes its components as
      // { variantId, qtyPerPack, sku, color, size, reservationId, expiresAt }
      // and has never written a price, so EVERY pack line in EVERY real cart
      // priced at 0.00 while v2_submit_order charged the true amount: the
      // buyer approved a subtotal with their packs missing from it and was
      // invoiced for them anyway.
      //
      // checks/check_line_pricing.mjs stayed green the whole time because
      // every one of its pack fixtures adds a `price` to each component -- a
      // shape the application does not produce. Null now means "ask", and an
      // explicit 0 still means free.
      basePrice: c.price != null ? Number(c.price) : null,
      color: c.color,
      size: c.size,
      sku: c.sku,
    }));
  }
  if (!line) return [];
  return [{
    variantId: line.variantId,
    qty: line.qty,
    // A loose cart line already carries the price it was added at. That is
    // deliberately NOT used as the base here: `price` on a loose line is an
    // ALREADY-EFFECTIVE price (the card ran effectivePrice() before writing
    // it), so feeding it back in would apply the discount twice. The caller
    // supplies the variant's list price instead -- see basePriceFor below.
    basePrice: null,
    color: line.color,
    size: line.size,
  }];
}

/**
 * Aggregate quantity per product across the WHOLE cart -- the number the
 * quantity-break lookup is done against.
 *
 * This is the fix for a defect that was invisible from the screen: pack lines
 * carry `components`, not `variantId`, so every previous aggregate (which
 * filtered on l.variantId) counted a 120-piece pack order as zero. A buyer
 * who had genuinely earned a quantity break was never told, and the invoice
 * came back cheaper than the cart they approved.
 *
 * Requires each line to know its productId. cart.addPack() now records it;
 * a pack line saved before that (an older cart still in localStorage) has no
 * productId and is aggregated under its own packId instead, which keeps it
 * out of OTHER products' totals rather than corrupting them.
 */
export function aggregateQtyByProduct(lines) {
  const agg = new Map();
  (lines || []).forEach((line) => {
    const key = line.productId || (line.isPack ? `pack:${line.packId}` : null);
    if (!key) return;
    const units = linePieces(line).reduce((s, p) => s + p.qty, 0);
    agg.set(key, (agg.get(key) || 0) + units);
  });
  return agg;
}

/**
 * Price one cart line exactly the way v2_submit_order will.
 *
 * @param line              a cart line (loose or pack)
 * @param ctx.aggregateQty  this product's total pieces across the whole cart
 * @param ctx.basePriceFor  (variantId) => list price. For a pack line the
 *                          component already carries its own price, so this is
 *                          only consulted for loose lines and as a fallback.
 * @param ctx.tiersByProduct / overridesByVariant / discountPct / customerPct
 *                          exactly as effectivePrice() takes them.
 *
 * Returns:
 *   units      total pieces on this line
 *   lineTotal  what the server will charge for it
 *   unitPrice  price of ONE piece
 *   isBlended  true when the pieces on this line do not all cost the same,
 *              so unitPrice is an average and unitPrice x units will NOT
 *              reproduce lineTotal. The UI must say "avg" when this is set.
 *              Every pack on production today is uniform (verified: zero packs
 *              have more than one distinct component price), so this is a
 *              correctness guard for a future mixed pack, not a common case --
 *              but showing an average as though it were exact is precisely the
 *              class of lie this file exists to stop.
 */
export function priceLine(line, ctx) {
  const {
    productId = line.productId || null,
    aggregateQty = 0,
    basePriceFor = () => 0,
    tiersByProduct, overridesByVariant,
    discountPct = 0, customerPct = 0,
  } = ctx || {};

  const pieces = linePieces(line);
  let units = 0;
  let lineTotal = 0;
  const unitPrices = new Set();

  pieces.forEach((p) => {
    const base = p.basePrice != null ? p.basePrice : Number(basePriceFor(p.variantId) ?? 0);
    const { price } = effectivePrice({
      basePrice: base, productId, variantId: p.variantId,
      aggregateQty, tiersByProduct, overridesByVariant, discountPct, customerPct,
    });
    // Mirrors the server: it rounds the UNIT price to 2dp, then multiplies by
    // an integer qty. Rounding the product instead would drift by a cent on
    // long lines, and the drift would be in the invoice, not the cart.
    units += p.qty;
    lineTotal = round2(lineTotal + round2(price) * p.qty);
    unitPrices.add(round2(price));
  });

  const isBlended = unitPrices.size > 1;
  const unitPrice = units > 0
    ? (isBlended ? round2(lineTotal / units) : [...unitPrices][0] ?? 0)
    : 0;

  return { units, lineTotal, unitPrice, isBlended };
}

/**
 * Price a whole cart. Returns the priced lines in input order plus the
 * subtotal, which is the number that must equal v2_orders.subtotal.
 */
export function priceCart(lines, ctx) {
  const agg = aggregateQtyByProduct(lines);
  const priced = (lines || []).map((line) => {
    const key = line.productId || (line.isPack ? `pack:${line.packId}` : null);
    const out = priceLine(line, { ...ctx, productId: line.productId || null, aggregateQty: agg.get(key) || 0 });
    return { line, ...out };
  });
  const subtotal = round2(priced.reduce((s, p) => s + p.lineTotal, 0));
  return { lines: priced, subtotal, aggregateByProduct: agg };
}
