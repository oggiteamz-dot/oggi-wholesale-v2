// OGGI Wholesale v2 — owner/admin cross-wholesaler data access (Batch 5)
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function logAudit({ actorLabel, action, targetType, targetId, details }) {
  return sbCall(supabase.from("v2_audit_log").insert({
    actor_label: actorLabel, action, target_type: targetType || null, target_id: targetId || null, details: details || {},
  }));
}

export async function getAuditLog(limit = 100) {
  const { data } = await sbCall(supabase.from("v2_audit_log").select("*").order("created_at", { ascending: false }).limit(limit));
  return data || [];
}

/** Cross-wholesaler dashboard: real aggregates across every wholesaler in
 * the system, not one wid's slice.
 *
 * Reads `v2_wholesalers` (a v2-owned mirror), not v1's real `wholesalers`
 * table -- v1's table has RLS scoped to the `authenticated` role only, and
 * v2 is still on dev-mode auth (anon key), so a direct query against it
 * silently returns zero rows (found + fixed in Batch 5, see
 * migrations/008_v2_wholesaler_directory.sql for the full story). */
export async function crossWholesalerStats() {
  const [{ data: wholesalers }, { data: orders }, { data: products }, { data: clients }] = await Promise.all([
    sbCall(supabase.from("v2_wholesalers").select("wid,brand,name,active")),
    sbCall(supabase.from("v2_orders").select("wid,subtotal,status")),
    sbCall(supabase.from("v2_products").select("wid").eq("archived", false)),
    sbCall(supabase.from("v2_clients").select("wid").eq("active", true)),
  ]);

  const byWid = new Map();
  (wholesalers || []).forEach((w) => byWid.set(w.wid, { wid: w.wid, name: w.brand || w.name, active: w.active, orders: 0, revenue: 0, products: 0, clients: 0 }));
  (orders || []).forEach((o) => {
    const row = byWid.get(o.wid);
    if (row) { row.orders++; row.revenue += Number(o.subtotal); }
  });
  (products || []).forEach((p) => { const row = byWid.get(p.wid); if (row) row.products++; });
  (clients || []).forEach((c) => { const row = byWid.get(c.wid); if (row) row.clients++; });

  const perWholesaler = [...byWid.values()];
  return {
    perWholesaler,
    totals: {
      wholesalers: perWholesaler.length,
      activeWholesalers: perWholesaler.filter((w) => w.active).length,
      orders: perWholesaler.reduce((s, w) => s + w.orders, 0),
      revenue: perWholesaler.reduce((s, w) => s + w.revenue, 0),
      products: perWholesaler.reduce((s, w) => s + w.products, 0),
      clients: perWholesaler.reduce((s, w) => s + w.clients, 0),
    },
  };
}

/** Onboarding checklist per wholesaler -- real completion signals (has a
 * product listed, has a client, has taken an order), not a fake progress bar. */
export function onboardingChecklist(wholesalerRow) {
  return [
    { label: "Has at least one product", done: wholesalerRow.products > 0 },
    { label: "Has at least one client", done: wholesalerRow.clients > 0 },
    { label: "Has received an order", done: wholesalerRow.orders > 0 },
  ];
}

/** Universal search across products, clients, and wholesalers by name --
 * real ILIKE queries against real tables, not a mocked result list. */
export async function universalSearch(query) {
  if (!query || query.trim().length < 2) return { wholesalers: [], products: [], clients: [] };
  const q = `%${query.trim()}%`;
  const [{ data: wholesalers }, { data: products }, { data: clients }] = await Promise.all([
    sbCall(supabase.from("v2_wholesalers").select("wid,brand,name").or(`brand.ilike.${q},name.ilike.${q}`).limit(10)),
    sbCall(supabase.from("v2_products").select("id,wid,name").ilike("name", q).limit(10)),
    sbCall(supabase.from("v2_clients").select("id,wid,shop_name").ilike("shop_name", q).limit(10)),
  ]);
  return { wholesalers: wholesalers || [], products: products || [], clients: clients || [] };
}

/** Owner-only (v2_invites_owner_read RLS, migration 022) -- lists every
 * invite ever created, newest first, so the owner can see what's
 * pending/used/expired without needing a separate "did it get used"
 * lookup. Invite CREATION stays on devAuth.createInvite (it's identity
 * machinery, same as login/redeem), this is just the read side. */
export async function listInvites() {
  const { data } = await sbCall(supabase.from("v2_invites").select("*").order("created_at", { ascending: false }));
  return data || [];
}

export async function listSignupRequests(status = "pending") {
  const { data } = await sbCall(supabase.from("v2_signup_requests").select("*").eq("status", status).order("created_at", { ascending: false }));
  return data || [];
}

/** Rejection only -- a plain status flip is fine here since nothing gets
 * provisioned. Direct table write, now owner/wholesaler-RLS-scoped by
 * migration 023 (v2_is_owner() OR wid = v2_my_wid()), so this only ever
 * succeeds for a real, authenticated owner/wholesaler session. */
export async function rejectSignupRequest(requestId, reviewerLabel) {
  return sbCall(supabase.from("v2_signup_requests").update({
    status: "rejected", reviewed_by: reviewerLabel, reviewed_at: new Date().toISOString(),
  }).eq("id", requestId));
}

/** Approval (Batch 14): routes through v2_approve_signup_request instead
 * of a raw status update -- approving now actually PROVISIONS a real
 * v2_clients CRM row + a working v2_portal_accounts buyer login, not
 * just a status flip (see migrations/024_v2_buyer_auth_bridge.sql). The
 * generated password comes back exactly once in this response -- there
 * is no email infrastructure yet, so the caller (js/views/owner.js) is
 * responsible for surfacing it to the approver so they can relay it to
 * the buyer out-of-band. p_username is optional; the RPC auto-generates
 * one from the buyer's shop name when omitted. */
export async function approveSignupRequest(requestId, username) {
  const { data, error } = await sbCall(supabase.rpc("v2_approve_signup_request", {
    p_id: requestId, p_username: username || null,
  }));
  if (error) return { ok: false, error: error.message };
  const row = data?.[0];
  if (!row?.ok) return { ok: false, error: row?.msg || "Could not approve request" };
  return { ok: true, username: row.username, tempPassword: row.temp_password, clientId: row.client_id, accountId: row.account_id };
}

/** Toggles a wholesaler active/inactive from the owner console.
 *
 * Writes to `v2_wholesalers.active` (the v2-owned mirror), NOT v1's real
 * `wholesalers.active` column. Originally this was meant to reuse v1's own
 * `active` column directly (deliberately avoiding a new column on v1's
 * table) -- but v1's `wholesalers` table has real RLS scoped to the
 * `authenticated` role, and v2's dev-mode `anon` key can't write to it at
 * all (confirmed via curl: the PATCH returns 200 OK with an empty array,
 * 0 rows matched, not an error). Writing to v2's own mirror instead keeps
 * v1's schema AND its real security posture completely untouched -- v1
 * still fully controls its own `active` column via its own real auth, and
 * this owner console controls v2's view of who's active for v2 purposes.
 * Once Batch 14 gives v2 real auth, this can be revisited to also write
 * through to v1's table if that's still wanted. */
export async function setWholesalerActive(wid, active, reason, actorLabel) {
  const { error } = await sbCall(supabase.from("v2_wholesalers").update({ active, updated_at: new Date().toISOString() }).eq("wid", wid));
  if (!error) {
    await logAudit({
      actorLabel, action: active ? "wholesaler.reactivate" : "wholesaler.deactivate",
      targetType: "wholesaler", targetId: wid, details: { reason: reason || null },
    });
  }
  return { error };
}
