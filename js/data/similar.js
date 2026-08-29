// =============================================================================
// OGGI Wholesale v2 — MORE LIKE THIS                           RC-03, 30 Aug 2026
// =============================================================================
// Products like the one on screen, across every store this buyer can still
// enter.
//
// ==== WHAT "LIKE" MEANS HERE, AND WHY IT IS NOT WHAT WAS SPECIFIED =========
//
// RC-03 was written down as ATTRIBUTE similarity — colour family, size system,
// category. Those columns exist (migration 097 built them) and they do not
// discriminate: EIGHT of 23 live products carry every colour family there is,
// because each is stocked in beige, blue, green and red. Matching on them puts
// a tote bag beside a jacket and calls it a recommendation.
//
// So migration 100 matches on the words in the product's NAME and uses the
// attributes only to order what a shared word already qualified. "Cargo Pant"
// in one store finds "Cargo Pant" in another — the same item from a second
// supplier, which is the most useful thing a wholesale marketplace can show
// anyone, and which no attribute column in the schema knows about.
//
// ==== THE FIELD LIST IS FIXED =============================================
//
// Ten fields, matching the function's ten output columns. No row spread — same
// rule as RC-01 and RC-02, and the same reason: a column added for one screen
// must not surface on another because nobody was looking.
//
// ==== THERE IS NO wid ARGUMENT ============================================
//
// Scope is derived in the database from active memberships, and the ANCHOR is
// scope-checked too — passing a product id from a store the buyer cannot enter
// returns nothing rather than revealing what the marketplace thinks resembles
// it.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Products similar to `productId`, best match first.
 *
 *  Returns [] with no session, on error, and whenever nothing clears the
 *  overlap floor — never throws. This is called from a render path.
 *
 *  An empty result is a normal answer, not a failure: a product whose name
 *  shares no meaningful word with anything else in the buyer's stores has no
 *  honest neighbours, and the rail renders nothing.
 *
 *  @param {{productId: string, limit?: number}} opts
 */
export async function listSimilarProducts({ productId, limit = 12 } = {}) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId || !productId) return [];

  const { data, error } = await sbCall(
    supabase.rpc("v2_similar_products", {
      p_account_id: String(accountId),
      p_product_id: String(productId),
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
    // Number(null) is 0, and "from $0.00" is a different claim from "we do not
    // know what this costs".
    priceFrom: r.price_from == null ? null : Number(r.price_from),
    currency: r.currency || "$",
    sharedWords: Number(r.shared_words) || 0,
    sameCategory: r.same_category === true,
    crossStore: r.cross_store === true,
  }));
}

/** The ten keys listSimilarProducts returns, in order. Exported so the gate
 *  asserts against ONE list rather than a copy of it. */
export const SIMILAR_FIELDS = Object.freeze([
  "productId",
  "productName",
  "wid",
  "wholesalerName",
  "imageUrl",
  "priceFrom",
  "currency",
  "sharedWords",
  "sameCategory",
  "crossStore",
]);

/** The line under the heading, derived from the RESULTS.
 *
 *  When the shelf actually reaches other suppliers, say so — that is the whole
 *  value of the marketplace, and it is invisible from the tiles alone unless a
 *  buyer reads every store name. When it does not, claim nothing. */
export function similarSubtitle(rows) {
  if (!rows.length) return null;
  const others = new Set(rows.filter((r) => r.crossStore).map((r) => r.wid));
  if (others.size === 0) return null;
  return others.size === 1
    ? "Including one other supplier you buy from"
    : `Including ${others.size} other suppliers you buy from`;
}
