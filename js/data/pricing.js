// OGGI Wholesale v2 — client-side pricing/MOQ engine (Batch 6)
//
// This is a DISPLAY/UX mirror of the server-authoritative logic in
// migrations/010_v2_pricing_moq_enforcement.sql (v2_effective_unit_price +
// the MOQ checks inside v2_submit_order). It exists so the cart can show
// instant "add 2 more to unlock $15/unit" feedback without a network
// round-trip per keystroke -- but it is NEVER the source of truth. The
// submit RPC recomputes everything itself from the same tables and ignores
// whatever price this module displayed, exactly like inventory reservations
// are a UX convenience while the RPCs are the real stock ledger.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Batch-fetches everything needed to price and MOQ-check a whole catalog
 * view in one round trip: tiers for every given product, MOQ/retail fields
 * already come back on the product/variant rows themselves from
 * catalog.js, so this only needs to add tiers + (if a client is known)
 * that buyer's own overrides (keyed off their portal account, not off a
 * client id the caller chooses -- see below). */
export async function getPricingContext(productIds, accountId, { clientId = null, catalogId = null } = {}) {
  const tiersByProduct = new Map();
  if (productIds.length) {
    const { data: tiers } = await sbCall(
      supabase.from("v2_pricing_tiers").select("*").in("product_id", productIds).order("min_qty", { ascending: true })
    );
    (tiers || []).forEach((t) => {
      const list = tiersByProduct.get(t.product_id) || [];
      list.push({ minQty: t.min_qty, unitPrice: Number(t.unit_price) });
      tiersByProduct.set(t.product_id, list);
    });
  }

  // Batch 16: this used to be a direct select filtered by .eq("client_id", ...),
  // which meant the client id was whatever the CALLER passed -- and the table
  // was readable by anon, so anyone holding the publishable key could point it
  // at any client and read that shop's negotiated prices. It now goes through
  // v2_buyer_price_overrides, which takes NO client id at all: it validates the
  // account and reads the client off that row. The strongest question a buyer
  // can ask is "what do I pay", and there is no longer a parameter through
  // which to ask a different one.
  const overridesByVariant = new Map();
  if (accountId) {
    const { data: overrides } = await sbCall(
      supabase.rpc("v2_buyer_price_overrides", { p_account_id: accountId })
    );
    (overrides || []).forEach((o) => overridesByVariant.set(o.variant_id, Number(o.override_price)));
  }

  // Migration 053. The server applies a discount percentage AFTER the
  // override/tier/list decision, and v2_submit_order re-prices every line with
  // it -- so a screen that does not apply the same percentage shows a cart
  // that disagrees with the invoice. It is fetched here, from the same
  // function the server itself calls, rather than recomputed from a catalog
  // row and a client row in JavaScript: two implementations of one arithmetic
  // rule is how the cart and the invoice drift apart.
  let discountPct = 0;
  if (clientId || catalogId) {
    const { data } = await sbCall(
      supabase.rpc("v2_catalog_discount_pct", { p_catalog_id: catalogId || null, p_client_id: clientId || null })
    );
    discountPct = Number(data) || 0;
  }

  return { tiersByProduct, overridesByVariant, discountPct };
}

/** Best-effort client_id resolution for a buyer session: matches the
 * dev-session's actorLabel against a real v2_clients.shop_name for this
 * wid, same string-matching precedent already used by salesperson.js's
 * recency sort (Batch 4). Returns null (no override applies -- safe
 * default) if there's no match, e.g. a guest/unlabeled buyer. */
export async function resolveClientId(wid, buyerLabel) {
  if (!buyerLabel) return null;
  const { data } = await sbCall(
    supabase.from("v2_clients").select("id").eq("wid", wid).eq("shop_name", buyerLabel).maybeSingle()
  );
  return data?.id || null;
}

/** The tier that would apply at this aggregate qty (highest min_qty <=
 * qty), or null if the qty doesn't reach any tier yet. */
export function tierForQty(tiers, aggregateQty) {
  const applicable = (tiers || []).filter((t) => t.minQty <= aggregateQty);
  if (!applicable.length) return null;
  return applicable.reduce((best, t) => (t.minQty > best.minQty ? t : best));
}

/** The next tier the buyer hasn't reached yet (lowest min_qty above
 * aggregate qty), for "add N more to unlock $X/unit" messaging. */
export function nextTier(tiers, aggregateQty) {
  const upcoming = (tiers || []).filter((t) => t.minQty > aggregateQty);
  if (!upcoming.length) return null;
  return upcoming.reduce((best, t) => (t.minQty < best.minQty ? t : best));
}

/**
 * Effective unit price for one line. This MIRRORS wholesale_v2.v2_effective_
 * unit_price and must keep mirroring it: v2_submit_order re-prices every line
 * server-side and writes that number to the invoice, so any disagreement here
 * is a cart that lies. checks/check_price_agreement.mjs runs the same worked
 * examples through both and fails if they ever diverge.
 *
 * Precedence, same order as the function:
 *   1. a hand-negotiated price for this customer -- returned untouched, no
 *      discount applies to it, because that number is a promise somebody made;
 *   2. otherwise the best quantity break, else the list price;
 *   3. then the discount percentage (catalog + customer, per the catalog's
 *      mode) on whatever that turned out to be.
 *
 * Returns `listPrice` alongside `price` so the buyer UI can show the strike-
 * through without recomputing anything: `listPrice` is what they would pay
 * with the CUSTOMER's share removed, which is the only "before" number that
 * does not leak the catalog's own discount.
 */
export function effectivePrice({
  basePrice, productId, variantId, aggregateQty,
  tiersByProduct, overridesByVariant,
  discountPct = 0, customerPct = 0,
}) {
  const override = overridesByVariant?.get(variantId);
  if (override != null) {
    return { price: override, listPrice: override, source: "override" };
  }

  const tier = tierForQty(tiersByProduct?.get(productId), aggregateQty);
  const before = tier ? tier.unitPrice : basePrice;
  const source = tier ? "tier" : "base";

  const pct = Number(discountPct) || 0;
  const price = pct === 0 ? round2(before) : round2(Math.max(before * (1 - pct / 100), 0));

  // The catalog's own share is invisible to the buyer, so the struck-through
  // "before" is the price with only the CUSTOMER's share added back. When the
  // customer has no share, before === price and the UI shows no strikethrough
  // at all -- one price, no theatre.
  const catalogOnlyPct = pct - (Number(customerPct) || 0);
  const listPrice = round2(Math.max(before * (1 - catalogOnlyPct / 100), 0));

  return { price, listPrice, source, tier: tier || undefined, discountPct: pct };
}

/** Two decimal places, the way Postgres round(numeric, 2) does it. Kept in one
 *  place so the cart, the line total and the check all round identically. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** MOQ status for a product given its current aggregate cart qty and
 * whether this buyer has ordered it before (reorder). Returns
 * { met, required, short } so the UI can show "add N more to meet the
 * M-unit minimum" inline, matching the server's own first-order vs.
 * reorder distinction. */
export function productMoqStatus(product, aggregateQty, isReorder) {
  const required = isReorder && product.moqReorderQty != null ? product.moqReorderQty : product.moqQty || 1;
  const met = aggregateQty >= required;
  return { met, required, short: met ? 0 : required - aggregateQty };
}

/** SKU-level MOQ status for one line. */
export function variantMoqStatus(variant, qty) {
  const required = variant.moqQty || 1;
  const met = qty >= required;
  return { met, required, short: met ? 0 : required - qty };
}

/** Margin display: wholesale (what the buyer pays) vs. retail (MSRP), as
 * a percentage. Returns null if there's no retail price set -- margin
 * display is opt-in per variant, not fabricated from nothing. */
export function marginPct(wholesalePrice, retailPrice) {
  if (!retailPrice || retailPrice <= 0) return null;
  return Math.round(((retailPrice - wholesalePrice) / retailPrice) * 1000) / 10;
}
