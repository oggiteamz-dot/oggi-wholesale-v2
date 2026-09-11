// =============================================================================
// OGGI Wholesale v2 — THE DESK DATA LAYER                      Block 7, 11 Sep 2026
// =============================================================================
// One module for both desks, because they share a lifecycle (sent → accepted →
// done, or handed back with a reason) and share exactly nothing else.
//
// ⭐ WHAT EACH DESK MAY SEE IS DECIDED ON THE SERVER, NOT HERE.
//
// The warehouse functions (135) have NO price, total or cost in their return
// tables at all; the finance functions (137) have no bin, no pick progress and
// no fulfil_note. That is deliberate and it is why this file is thin: there is
// no filtering to do in the browser, because there is nothing on the wire to
// filter. A screen cannot leak a column it was never sent.
//
// If you are about to add a field to one of these mappers and it is not in the
// server's return table, the answer is not to fetch it from somewhere else.
// Read the header of migration 135.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

// Every call re-states the desk. The server checks it against the staff id
// (v2_staff_wid, 133) and returns nothing if they disagree -- so a warehouse
// session cannot reach finance's data by asking nicely.
const num = (v) => (v == null ? null : Number(v));

// ============================================================== THE WAREHOUSE

export async function warehouseQueue(staffId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_warehouse_queue", { p_staff_id: staffId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    orderId: r.order_id,
    reference: r.reference,
    buyerLabel: r.buyer_label,
    placedAt: r.placed_at,
    state: r.state,
    sentAt: r.sent_at,
    lineCount: Number(r.line_count) || 0,
    unitCount: Number(r.unit_count) || 0,
    pickedCount: Number(r.picked_count) || 0,
    hasFulfilNote: r.has_fulfil_note === true,
    hasBuyerNote: r.has_buyer_note === true,
    locationName: r.location_name || null,
  }));
}

export async function warehouseOrderHead(staffId, orderId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_warehouse_order_head", { p_staff_id: staffId, p_order_id: orderId })
  );
  if (error) return null;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r) return null;
  return {
    orderId: r.order_id, reference: r.reference, buyerLabel: r.buyer_label,
    placedAt: r.placed_at, state: r.state,
    orderNote: r.order_note || null,       // the buyer, about the whole order
    fulfilNote: r.fulfil_note || null,     // ⭐ 087's column, finally read
    locationName: r.location_name || null,
    returnReason: r.return_reason || null,
  };
}

export async function warehouseOrderLines(staffId, orderId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_warehouse_order", { p_staff_id: staffId, p_order_id: orderId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    orderItemId: r.order_item_id,
    variantId: r.variant_id,
    productName: r.product_name,
    sku: r.sku,
    colour: r.colour,
    colourHex: r.colour_hex,
    size: r.size,
    qty: Number(r.qty) || 0,
    pickedQty: Number(r.picked_qty) || 0,
    packId: r.pack_id || null,
    packQty: r.pack_qty == null ? null : Number(r.pack_qty),
    buyerNote: r.buyer_note || null,
    fulfilNote: r.fulfil_note || null,
    imageUrl: r.image_url || null,
    // Number(null) is 0 and "none in stock" is a different claim from "we did
    // not ask" -- but here the server always answers with coalesce(...,0), so 0
    // genuinely means none at this location.
    qtyOnHand: Number(r.qty_on_hand) || 0,
    barcode: r.barcode || null,
  }));
}

export async function pickLine(staffId, orderId, orderItemId, pickedQty) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_desk_pick", {
      p_staff_id: staffId, p_order_id: orderId,
      p_order_item_id: orderItemId, p_picked_qty: pickedQty,
    })
  );
  if (error) return { ok: false, error: "Could not save that just now." };
  const r = Array.isArray(data) ? data[0] : data;
  return r?.ok ? { ok: true, pickedQty: Number(r.picked_qty) || 0 }
               : { ok: false, error: r?.msg || "Could not save that." };
}

// ================================================================= THE FINANCE

export async function financeQueue(staffId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_finance_queue", { p_staff_id: staffId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    orderId: r.order_id, reference: r.reference, buyerLabel: r.buyer_label,
    clientId: r.client_id || null, placedAt: r.placed_at,
    orderStatus: r.order_status, state: r.state, sentAt: r.sent_at,
    subtotal: num(r.subtotal) || 0,
    received: num(r.received) || 0,
    outstanding: num(r.outstanding) || 0,
    daysOld: Number(r.days_old) || 0,
    currency: r.currency || "$",
  }));
}

export async function financeAging(staffId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_finance_aging", { p_staff_id: staffId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    clientId: r.client_id || null,
    shopName: r.shop_name || "—",
    phone: r.phone || null,
    orders: Number(r.orders) || 0,
    outstanding: num(r.outstanding) || 0,
    b0: num(r.bucket_0_30) || 0,
    b31: num(r.bucket_31_60) || 0,
    b61: num(r.bucket_61_90) || 0,
    b90: num(r.bucket_90_plus) || 0,
    oldestDays: Number(r.oldest_days) || 0,
    currency: r.currency || "$",
  }));
}

export async function financeOrderHead(staffId, orderId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_finance_order_head", { p_staff_id: staffId, p_order_id: orderId })
  );
  if (error) return null;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r) return null;
  return {
    orderId: r.order_id, reference: r.reference, buyerLabel: r.buyer_label,
    shopName: r.shop_name || null, phone: r.phone || null, email: r.email || null,
    placedAt: r.placed_at, orderStatus: r.order_status, state: r.state,
    subtotal: num(r.subtotal) || 0,
    received: num(r.received) || 0,
    outstanding: num(r.outstanding) || 0,
    currency: r.currency || "$",
    orderNote: r.order_note || null,
    // ⚠️ These two decide whether the margin below may be stated at all. A
    // costed count lower than the line count means the margin covers PART of
    // the order, and the screen has to say so -- "we do not know what three of
    // these cost" is a different sentence from a margin figure.
    linesTotal: Number(r.lines_total) || 0,
    linesCosted: Number(r.lines_costed) || 0,
    knownCost: num(r.known_cost),        // null stays null: unknown is not zero
    knownMargin: num(r.known_margin),
    returnReason: r.return_reason || null,
  };
}

export async function financeOrderLines(staffId, orderId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_finance_order", { p_staff_id: staffId, p_order_id: orderId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    orderItemId: r.order_item_id,
    productName: r.product_name, sku: r.sku, colour: r.colour, size: r.size,
    qty: Number(r.qty) || 0,
    unitPrice: num(r.unit_price) || 0,
    lineTotal: num(r.line_total) || 0,
    unitCost: num(r.unit_cost),          // null = we do not know
    lineCost: num(r.line_cost),
    lineMargin: num(r.line_margin),
    buyerNote: r.buyer_note || null,
  }));
}

export async function moneyReceivedFor(staffId, orderId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_money_received_for_order", { p_staff_id: staffId, p_order_id: orderId })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    id: r.id, amount: num(r.amount) || 0, currency: r.currency || "$",
    method: r.method, receivedOn: r.received_on, reference: r.reference || null,
    note: r.note || null, recordedAt: r.recorded_at, recordedBy: r.recorded_by,
  }));
}

/** Record money that ALREADY ARRIVED somewhere else. This app takes no money
 *  (check_no_payment_path.mjs) -- this is bookkeeping after the fact. */
export async function recordMoneyReceived(staffId, orderId, { amount, method, receivedOn, reference, note }) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_record_money_received", {
      p_staff_id: staffId, p_order_id: orderId,
      p_amount: amount, p_method: method || "bank",
      p_received_on: receivedOn || null,
      p_reference: reference || null, p_note: note || null,
    })
  );
  if (error) return { ok: false, error: "Could not record that just now." };
  const r = Array.isArray(data) ? data[0] : data;
  return r?.ok ? { ok: true } : { ok: false, error: r?.msg || "Could not record that." };
}

// ====================================================== THE SHARED LIFECYCLE

export async function deskAccept(staffId, orderId, desk) {
  return callDesk("v2_desk_accept", { p_staff_id: staffId, p_order_id: orderId, p_desk: desk });
}
export async function deskComplete(staffId, orderId, desk) {
  return callDesk("v2_desk_complete", { p_staff_id: staffId, p_order_id: orderId, p_desk: desk });
}
/** Hand the order back. The reason is REQUIRED -- both by this call and by the
 *  table (134). A refusal with nothing after it is the dead end PB-01 removed. */
export async function deskReturn(staffId, orderId, desk, reason) {
  return callDesk("v2_desk_return", {
    p_staff_id: staffId, p_order_id: orderId, p_desk: desk, p_reason: reason,
  });
}
export async function deskNote(staffId, orderId, desk, note) {
  return callDesk("v2_desk_note", {
    p_staff_id: staffId, p_order_id: orderId, p_desk: desk, p_note: note,
  });
}

async function callDesk(fn, args) {
  const { data, error } = await sbCall(supabase.rpc(fn, args));
  if (error) return { ok: false, error: "Could not do that just now. Try again." };
  const r = Array.isArray(data) ? data[0] : data;
  return r?.ok ? { ok: true, msg: r.msg } : { ok: false, error: r?.msg || "Could not do that." };
}
