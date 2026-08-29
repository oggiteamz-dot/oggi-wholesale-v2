// =============================================================================
// OGGI Wholesale v2 — BUY IT AGAIN                             RC-01, 30 Aug 2026
// =============================================================================
// The products this shop has ordered before, across EVERY store they can still
// enter — not just the one they happen to be looking at.
//
// Everything interesting about this feature lives in migration 095, not here.
// The set is recomputed from ACTIVE memberships on every call, so a store that
// revokes access disappears from the shelf on the next render with nothing to
// invalidate. This file's only job is to carry that answer to the screen
// without adding to it.
//
// ==== THE FIELD LIST IS FIXED, AND THAT IS THE POINT =======================
//
// Nine fields, matching v2_buy_it_again's nine output columns exactly. Not
// eight, not ten.
//
// A mapper that quietly spreads the row (`...r`) is how a column added to a
// function for one screen ends up rendered on another, and how the DR-05 class
// of leak happens: nobody decided to show it, nobody noticed it was there.
// checks/check_buy_it_again.mjs asserts the exact key set, so adding a field
// here without deciding to fails a gate rather than shipping quietly.
//
// ==== WHY THERE IS NO wid ARGUMENT =========================================
//
// The same rule as the directory and cross-store search: scope is derived
// inside the database from the account, never supplied by the caller. There is
// deliberately nothing here for a caller to claim.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Products this buyer has ordered before, most recent first.
 *
 *  Returns [] when there is no session and [] on error — never throws and never
 *  rejects. This is called from a render path, and a shelf that throws takes the
 *  whole buyer home down with it. An empty shelf renders as no shelf at all
 *  (see the strip in js/views/buyer.js), which is the honest outcome for a buyer
 *  who has not ordered yet.
 *
 *  @param {{limit?: number}} opts
 *  @returns {Promise<Array<{
 *    productId: string, productName: string, wid: string, wholesalerName: string,
 *    imageUrl: string|null, priceFrom: number|null, currency: string,
 *    timesOrdered: number, lastOrderedAt: string|null }>>}
 */
export async function listBuyItAgain({ limit = 12 } = {}) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return [];

  const { data, error } = await sbCall(
    supabase.rpc("v2_buy_it_again", {
      p_account_id: String(accountId),
      p_limit: limit,
    })
  );
  if (error) return [];

  return (data || []).map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    wid: r.wid,
    // Migration 095 already falls back through name -> brand -> wid, so this is
    // never empty in practice. The `|| r.wid` is here for the one case 095
    // cannot cover: a row that arrives malformed. A tile with a blank supplier
    // is worse than a tile labelled with the store code.
    wholesalerName: r.wholesaler_name || r.wid,
    imageUrl: r.image_url || null,
    // Number(null) is 0, and a product priced at zero is a real thing that must
    // not be rendered as "from $0.00" when the truth is "we do not know". The
    // null check comes first for that reason.
    priceFrom: r.price_from == null ? null : Number(r.price_from),
    currency: r.currency || "$",
    // bigint arrives as a string over PostgREST. Number() it once, here, rather
    // than in the view where a string would silently render as "1 times" and
    // sort wrong.
    timesOrdered: Number(r.times_ordered) || 0,
    lastOrderedAt: r.last_ordered_at || null,
  }));
}

/** The nine keys listBuyItAgain returns, in order.
 *
 *  Exported so the gate can assert the mapper's output shape against ONE list
 *  rather than a copy of it — a duplicated expectation drifts, and then the
 *  check passes while agreeing with itself about the wrong thing. */
export const REORDER_FIELDS = Object.freeze([
  "productId",
  "productName",
  "wid",
  "wholesalerName",
  "imageUrl",
  "priceFrom",
  "currency",
  "timesOrdered",
  "lastOrderedAt",
]);
