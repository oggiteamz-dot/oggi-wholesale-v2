// =============================================================================
// OGGI Wholesale v2 — CROSS-STORE SEARCH                SR-01, SR-10, 29 Aug 2026
// =============================================================================
// "Find me black denim" — across every wholesaler this buyer can enter, and
// across none that they cannot.
//
// THE SCOPE IS NOT SET HERE, AND THAT IS DELIBERATE.
// This module sends no wid and cannot send one: v2_search_products takes no
// such argument. The set of stores is computed inside the function from the
// buyer's own membership rows. A client that could name a store to search is a
// client that could name a store it has no business searching.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Products across the stores this buyer belongs to. [] when signed out. */
export async function searchProducts(q, { limit = 30, offset = 0 } = {}) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return [];
  const { data, error } = await sbCall(
    supabase.rpc("v2_search_products", {
      p_account_id: accountId,
      p_q: q || "",
      p_limit: limit,
      p_offset: offset,
    })
  );
  if (error) return [];
  // Mapped onto a fixed shape. Anything the server starts returning by
  // accident stops here rather than reaching the page — the lesson of the
  // directory's DR-05 pass (see checks/check_wholesaler_directory.mjs).
  return (data || []).map((r) => ({
    productId: r.product_id,
    name: r.product_name,
    category: r.category,
    wid: r.wid,
    wholesalerName: r.wholesaler_name,
    imageUrl: r.image_url,
    priceFrom: r.price_from == null ? null : Number(r.price_from),
    currency: r.currency || "$",
  }));
}
