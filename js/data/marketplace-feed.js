// =============================================================================
// OGGI Wholesale v2 — THE MARKETPLACE FEED                      MK-01, 1 Sep 2026
// =============================================================================
// Hadi, 1 Sep: "one marketplace, full-scale, imagine Amazon, with different
// stores inside that marketplace ... the products we recommend in the homepage
// are the products the wholesalers made public."
//
// THE SCOPE IS NOT SET HERE, AND CANNOT BE.
// v2_marketplace_feed takes no wid and no catalogue id. What is browsable is
// decided inside the function, by one rule — the catalogue's own is_public —
// and a client that could name a store to browse is a client that could name a
// store whose private line it has no business seeing. Same reasoning as
// js/data/search.js, and the same reason the two are separate functions: search
// answers "stores I belong to", the feed answers "catalogues their owners
// published", and those must never come to share a definition.
//
// EVERY ROW IS MAPPED ONTO A FIXED SHAPE below. Anything the server starts
// returning by accident stops here rather than reaching the page — the lesson
// of DR-05, and the reason `commission_pct` cannot leak into a buyer's browser
// even if someone adds it to the function's return type by mistake.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";
// Pure string logic, in its own import-free module so a Node gate can run it.
export { splitReference } from "../lib/product-reference.js";

/** The named rails on the marketplace home, in order.
 *
 *  Rails rather than one endless grid, from the reference Hadi sent (see
 *  "[C] REFERENCE — MyStories Moow"): a rail has a NAME, and a name is
 *  somewhere honest to put a rule. A sponsored product inside a rail whose
 *  heading says what it is beats the same product sprinkled invisibly through
 *  one long list.
 *
 *  `sort` maps to v2_marketplace_feed's p_sort. An empty rail is HIDDEN rather
 *  than shown empty — "Best Sellers" over a blank space is worse than no
 *  shelf, and on a young marketplace it is the common case, not the edge one. */
export const RAILS = [
  {
    key: "popular",
    title: "Best sellers",
    subtitle: "Ordered by the most shops in the last 90 days",
    sort: "popular",
    limit: 12,
  },
  {
    key: "new",
    title: "New arrivals",
    subtitle: "The newest products across every wholesaler",
    sort: "new",
    limit: 12,
  },
];

/** One page of the feed.
 *
 *  Signed out is a legitimate state — the marketplace is the public face of
 *  OGGI — and simply means nothing comes back marked as yours.
 *
 *  @param {object}  o
 *  @param {string}  [o.sort]      'woven' | 'new' | 'popular'
 *  @param {number}  [o.limit]
 *  @param {number}  [o.offset]
 *  @param {string}  [o.category]
 *  @returns {Promise<Array>} [] on any failure — a home page that renders one
 *    fewer shelf is better than a home page that renders an error.
 */
export async function feedPage({ sort = "woven", limit = 40, offset = 0, category = null } = {}) {
  const accountId = devAuth.getSession()?.accountId || null;
  const { data, error } = await sbCall(
    supabase.rpc("v2_marketplace_feed", {
      p_account_id: accountId,
      p_limit: limit,
      p_offset: offset,
      p_category: category,
      p_sort: sort,
    })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    productId: r.product_id,
    name: r.product_name,
    category: r.category,
    wid: r.wid,
    wholesalerName: r.wholesaler_name,
    wholesalerLogo: r.wholesaler_logo,
    imageUrl: r.image_url,
    priceFrom: r.price_from == null ? null : Number(r.price_from),
    currency: r.currency || "$",
    // 'member' -> can buy now. 'none' -> can look, and must ask.
    // The card MUST branch on this rather than on "is there a price", because
    // a public catalogue shows its prices to everyone; being able to see the
    // price and being allowed to order are two different things.
    access: r.access === "member" ? "member" : "none",
    isPromoted: r.is_promoted === true,
    slot: r.slot === "promoted" ? "promoted" : "organic",
  }));
}

/** Every rail that actually has something in it, fetched together.
 *
 *  Promise.all rather than one after another: three rails served in sequence
 *  is three round trips of latency before the first pixel, and they do not
 *  depend on each other. */
export async function loadRails() {
  const results = await Promise.all(
    RAILS.map((rail) => feedPage({ sort: rail.sort, limit: rail.limit }))
  );
  return RAILS
    .map((rail, i) => ({ ...rail, items: results[i] }))
    .filter((rail) => rail.items.length > 0);
}
