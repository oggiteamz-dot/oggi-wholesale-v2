// =============================================================================
// OGGI Wholesale v2 — THE ORDER HANDOFF                Batch N step 4, 28 Aug
// =============================================================================
// One order, reachable by a link, by someone who is not signed in to anything.
//
// Everything here goes through migration 088's SECURITY DEFINER functions. The
// tables are not touched, and must not be: migration 085 revoked every table
// privilege from `anon`, and buyers, sales reps and total strangers are all
// `anon`. The grant is the only lock they have.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** One order, from its token alone.
 *
 *  The function takes NOTHING else -- no order id, no wid -- so there is
 *  nothing a caller can claim about itself. A dead link and an invented link
 *  answer identically ('not_found'), which is deliberate: distinguishing them
 *  tells a stranger whether an order exists. */
export async function getOrderByToken(token) {
  const { data, error } = await sbCall(supabase.rpc("v2_order_by_token", { p_token: token }));
  if (error) return { status: "error", error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.status !== "ok") return { status: row?.status || "not_found" };
  return {
    status: "ok",
    orderId: row.order_id,
    orderStatus: row.order_status,
    buyerLabel: row.buyer_label,
    subtotal: Number(row.subtotal || 0),
    currency: row.currency || "$",
    // The BUYER's own words about the order (086). The wholesaler's internal
    // note is not here and is not filtered out here either -- migration 088
    // does not return it at all, so there is nothing to drop.
    buyerOrderNote: row.buyer_order_note || null,
    createdAt: row.created_at,
    wholesalerName: row.wholesaler_name || "",
    items: Array.isArray(row.items) ? row.items : [],
  };
}

/** Issue a new token, killing every link already sent for this order.
 *
 *  The only remedy that exists once a link has been forwarded to someone it
 *  was not meant for -- and links WILL be forwarded, because travelling on
 *  WhatsApp is the entire point of them.
 *
 *  `anon` is deliberately not granted execute on this (see 088): buyers and
 *  sales reps ARE anon, and a buyer must never be able to invalidate their
 *  wholesaler's links. */
export async function rotateOrderToken(orderId) {
  const { data, error } = await sbCall(supabase.rpc("v2_rotate_order_token", { p_order_id: orderId }));
  if (error) return { ok: false, error: error.message };
  return { ok: true, token: data };
}

/** The link itself. Built from the live origin rather than a stored base URL,
 *  which is the fix migration-era code learned the hard way: a hard-coded base
 *  goes stale the day the app moves, and a link that 404s is worse than no
 *  link at all. */
export function orderLink(token) {
  return `${window.location.origin}/#/o/${token}`;
}

/** Hand it to WhatsApp.
 *
 *  TEXT AND A LINK, never an attachment. wa.me can carry text; it cannot
 *  carry a file, and the Web Share API's file support is absent on most of
 *  the Android hardware this app actually runs on (roughly a fifth of Lebanese
 *  mobile traffic is 2-4GB budget Android). A share button that silently does
 *  nothing on the phones your buyers own is worse than a link they can paste. */
export function whatsappHref(token, { orderRef, wholesalerName } = {}) {
  const line = [
    wholesalerName ? `Order from ${wholesalerName}` : "Your order",
    orderRef ? `Ref ${orderRef}` : null,
    orderLink(token),
  ].filter(Boolean).join("\n");
  return `https://wa.me/?text=${encodeURIComponent(line)}`;
}
