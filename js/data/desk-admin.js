// =============================================================================
// OGGI Wholesale v2 — THE OFFICE'S SIDE OF THE DESKS            Block 7, 11 Sep 2026
// =============================================================================
// Sending an order to a desk, and the standing rule that sends it without
// anybody pressing anything. Migrations 134/138.
//
// SEPARATE FROM js/data/desk.js ON PURPOSE. That module is what a DESK calls
// and every function in it runs as anon behind v2_staff_wid(). Everything here
// is `authenticated` and gated on v2_my_wid() -- a different caller, a different
// authority, a different failure mode. One file containing both would be one
// file where it is easy to reach for the wrong one.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

export const DESKS = [
  { key: "warehouse", label: "Warehouse", icon: "📦" },
  { key: "finance",   label: "Finance",   icon: "🧾" },
];

export const AUTO_LABEL = {
  never: "Only when I send it",
  on_new: "As soon as the order arrives",
  on_confirmed: "When I confirm the order",
};

/** What each desk has done with one order. Returns a map keyed by desk, so a
 *  screen can say "warehouse: in progress, finance: not sent" without four
 *  separate round trips. */
export async function deskStatesForOrder(orderId) {
  const { data, error } = await sbCall(
    supabase.from("v2_order_desk_assignments")
      .select("desk, state, sent_at, accepted_at, completed_at, returned_at, return_reason, desk_note, auto")
      .eq("order_id", orderId)
  );
  const byDesk = {};
  if (error) return byDesk;
  (data || []).forEach((r) => {
    byDesk[r.desk] = {
      desk: r.desk, state: r.state, sentAt: r.sent_at,
      acceptedAt: r.accepted_at, completedAt: r.completed_at,
      returnedAt: r.returned_at,
      returnReason: r.return_reason || null,
      deskNote: r.desk_note || null,
      auto: r.auto === true,
    };
  });
  return byDesk;
}

export async function sendOrderToDesk(orderId, desk) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_desk_send", { p_order_id: orderId, p_desk: desk })
  );
  if (error) return { ok: false, error: "Could not send that just now." };
  const r = Array.isArray(data) ? data[0] : data;
  return r?.ok ? { ok: true, msg: r.msg } : { ok: false, error: r?.msg || "Could not send that." };
}

export async function getDeskRouting(wid) {
  const { data, error } = await sbCall(
    supabase.from("v2_order_desk_routing").select("desk, auto_send_on").eq("wid", wid)
  );
  // Absent means 'never'. A store that has not hired a warehouse manager should
  // not be filling a queue nobody opens, so the default is off and the absence
  // of a row means exactly that rather than "not configured yet".
  const out = { warehouse: "never", finance: "never" };
  if (error) return out;
  (data || []).forEach((r) => { out[r.desk] = r.auto_send_on; });
  return out;
}

export async function setDeskRouting(wid, desk, autoSendOn) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_desk_routing", { p_wid: wid, p_desk: desk, p_auto_send_on: autoSendOn })
  );
  if (error) return { ok: false, error: "Could not save that just now." };
  const r = Array.isArray(data) ? data[0] : data;
  return r?.ok ? { ok: true } : { ok: false, error: r?.msg || "Could not save that." };
}

/** Routing that FAILED. Empty is the expected state (134): a row here means the
 *  trigger swallowed an error to protect an order, and somebody should look. */
export async function recentRoutingFailures(wid, limit = 5) {
  const { data, error } = await sbCall(
    supabase.from("v2_order_routing_failures")
      .select("order_id, desk, failed_at, message")
      .eq("wid", wid)
      .order("failed_at", { ascending: false })
      .limit(limit)
  );
  if (error) return [];
  return (data || []).map((r) => ({
    orderId: r.order_id, desk: r.desk, failedAt: r.failed_at, message: r.message,
  }));
}
