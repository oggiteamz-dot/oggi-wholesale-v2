// OGGI Wholesale v2 — order history data access (Batch 2, rewired in
// Batch 14 to a real per-buyer session instead of a client-supplied
// wid+buyer_label string).
//
// Before Batch 14, v2_orders/v2_order_items were anon-readable and this
// module read them directly, scoped only by whatever wid+buyer_label the
// caller happened to pass in -- meaning any anon caller who knew or
// guessed a buyer_label could read that buyer's entire order history
// (real PII/pricing exposure -- see migrations/023_v2_rls_hardening.sql's
// header for the full writeup). Those tables are now owner/wholesaler-
// only for direct access; buyer order reads go exclusively through
// v2_get_buyer_orders (SECURITY DEFINER), which independently validates
// a real, active v2_portal_accounts id rather than trusting the caller's
// own claim about who they are.
import { supabase, sbCall } from "../lib/supabase-client.js";
import { groupPackLines } from "./prepacks.js";

/** Returns orders for a buyer, newest first, each with its line items
 * (pack-purchased lines re-collapsed to one display entry per pack, see
 * groupPackLines/Batch 7). accountId is the real buyer session's
 * v2_portal_accounts id (session.accountId) -- callers with no real
 * account yet (e.g. mid "switch supplier" browsing a wholesaler they
 * don't have credentials with) pass null/undefined and correctly get an
 * empty history back, rather than an error. */
export async function getBuyerOrders(accountId) {
  if (!accountId) return [];
  const { data, error } = await sbCall(supabase.rpc("v2_get_buyer_orders", { p_account_id: accountId }));
  if (error || !data) return [];
  return data.map((o) => ({
    id: o.id,
    status: o.status,
    subtotal: Number(o.subtotal),
    notes: o.notes,
    createdAt: o.created_at,
    locationId: o.location_id,
    items: groupPackLines(o.items || []),
  }));
}

export function orderedTimesCount(orders, variantId) {
  return orders.reduce((n, o) => n + o.items.filter((i) => i.variantId === variantId).length, 0);
}

/** Batch 6: which product ids this buyer has ordered before at all (any
 * variant/colour/size counts) -- used for the first-order vs. reorder MOQ
 * distinction. Derived from the same v2_get_buyer_orders call as
 * getBuyerOrders (one RPC round trip covers both shapes a caller needs). */
export async function getBuyerOrderedProductIds(accountId) {
  const orders = await getBuyerOrders(accountId);
  const ids = new Set();
  orders.forEach((o) => o.items.forEach((i) => { if (i.productId) ids.add(i.productId); }));
  return ids;
}
