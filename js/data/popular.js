// =============================================================================
// OGGI Wholesale v2 — POPULAR RIGHT NOW                        RC-02, 30 Aug 2026
// =============================================================================
// Products that MANY DIFFERENT SHOPS bought recently, inside the stores this
// buyer can still enter.
//
// ==== WHAT THIS IS NOT =====================================================
//
// It is not "most ordered". Migration 099 ranks on COUNT(DISTINCT buyer) and
// the distinction is the whole feature: production holds a product with 37
// orders from ONE shop, and calling that popular would be showing a buyer
// somebody else's habit and labelling it the market's opinion. One shop
// reordering weekly is loyalty — RC-01 already has a shelf for it, directly
// above this one.
//
// It is also not an advert. 099 is asserted, in the migration and again in
// checks/check_popular_now.sql, never to read v2_oggi_promoted. When paid
// placement ships it gets its own rail with `paidLabel` set, because the moment
// "popular" can be bought the word stops meaning anything and every other shelf
// in the app inherits the doubt.
//
// ==== THE FIELD LIST IS FIXED ==============================================
//
// Ten fields, matching v2_popular_now's ten output columns exactly. No row
// spread. Same rule and same reason as RC-01's mapper: a column added to a
// function for one screen must not appear on another because nobody was
// looking. The gate asserts the exact key set.
//
// ==== THERE IS NO wid ARGUMENT =============================================
//
// Scope is derived inside the database from active memberships, on every call.
// There is deliberately nothing here for a caller to claim, which is why a
// revoked store falls off this shelf on the next render with nothing to
// invalidate.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Products many different shops are buying, most widely bought first.
 *
 *  Returns [] when there is no session and [] on error — never throws and never
 *  rejects. This is called from a render path, and a shelf that throws takes the
 *  whole buyer home down with it.
 *
 *  An EMPTY result is the normal, correct answer whenever nothing clears the
 *  minimum-buyer floor, which on today's production data is almost always. The
 *  rail renders nothing in that case. That is the feature working, not failing:
 *  the shelf turns itself on when it has something true to say.
 *
 *  @param {{categoryKey?: string|null, limit?: number}} opts
 */
export async function listPopularNow({ categoryKey = null, limit = 12 } = {}) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return [];

  const { data, error } = await sbCall(
    supabase.rpc("v2_popular_now", {
      p_account_id: String(accountId),
      p_category_key: categoryKey || null,
      p_limit: limit,
    })
  );
  if (error) return [];

  return (data || []).map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    wid: r.wid,
    wholesalerName: r.wholesaler_name || r.wid,
    imageUrl: r.image_url || null,
    // Number(null) is 0, and a product priced at zero is a real thing that must
    // not be rendered as "from $0.00" when the truth is "we do not know".
    priceFrom: r.price_from == null ? null : Number(r.price_from),
    currency: r.currency || "$",
    // bigint arrives as a string over PostgREST. Number() it once, here.
    buyerCount: Number(r.buyer_count) || 0,
    categoryKey: r.category_key || null,
    // Whether the database answered the NARROW question or the wide one. The
    // heading is built from this rather than from what was ASKED, so a rail can
    // never be titled "Popular in Tops" over a list that widened past Tops.
    narrowed: r.narrowed === true,
  }));
}

/** The ten keys listPopularNow returns, in order. Exported so the gate asserts
 *  the shape against ONE list rather than a copy of it — a duplicated
 *  expectation drifts, and then the check passes while agreeing with itself
 *  about the wrong thing. */
export const POPULAR_FIELDS = Object.freeze([
  "productId",
  "productName",
  "wid",
  "wholesalerName",
  "imageUrl",
  "priceFrom",
  "currency",
  "buyerCount",
  "categoryKey",
  "narrowed",
]);

/** The rail's heading, derived from the ANSWER and never from the question.
 *
 *  Passing the category that was asked for would let the heading claim a
 *  narrowing the database declined to make. This takes the rows. */
export function popularTitle(rows) {
  const narrowed = rows.length > 0 && rows[0].narrowed && rows[0].categoryKey;
  if (!narrowed) return "Popular right now";
  const k = String(rows[0].categoryKey);
  return "Popular in " + k.charAt(0).toUpperCase() + k.slice(1);
}

/** The line under the heading: what the number on each tile actually means.
 *
 *  "4 shops bought this" is a claim a buyer can check against their own
 *  judgement. "Popular" on its own is a claim they have to take on trust, and
 *  this shelf is asking them to spend money on it. */
export function popularSubtitle(rows) {
  if (!rows.length) return null;
  return "Ordered by several different shops in the last 90 days";
}
