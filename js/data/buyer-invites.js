// =============================================================================
// OGGI Wholesale v2 — DOOR A: INVITATIONS                  AC-03, 29 Aug 2026
// =============================================================================
// The third way into a locked store, and the only one that was missing.
//
//   Door B — the shop asks, the wholesaler approves     (shipped 28 Aug)
//   Door C — the wholesaler types their phone in        (shipped 20 Aug)
//   Door A — the wholesaler sends them a link           <- this
//
// Everything goes through migration 089's SECURITY DEFINER functions. `anon`
// holds no privilege on v2_buyer_invites and must not: 085 revoked every table
// grant and set the standing rule that keeps doing so.
//
// WHY THERE IS NO SEND FUNCTION HERE
// There is no transactional email in this system, and migration 024 says so in
// its own comment rather than pretending otherwise. The 28 Aug research found
// the same failure across every platform surveyed -- "do not rely on an
// activation email arriving" -- and Cin7's answer, a copyable link per
// customer, is the one that works. The wholesaler pastes it into the WhatsApp
// thread they are already having with that shop. Honest, and it is how every
// credential in this product is already relayed.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Every invitation this wholesaler has sent, newest first.
 *
 *  Scoped by wid in the QUERY as well as by the policy -- the same belt and
 *  braces as the access-request queue, and for the same reason: RLS is correct
 *  today and is one dropped policy away from being a cross-tenant list. */
export async function listMyInvites() {
  const wid = devAuth.getSession()?.wid;
  if (!wid) return [];
  const { data } = await sbCall(
    supabase.from("v2_buyer_invites").select("*").eq("wid", wid).order("created_at", { ascending: false })
  );
  return (data || []).map((r) => ({
    id: r.id,
    token: r.token,
    shopName: r.shop_name || null,
    phone: r.phone || null,
    note: r.note || null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedAt: r.redeemed_at || null,
    revokedAt: r.revoked_at || null,
    // Four states, told apart on purpose. "It didn't work" is not something a
    // wholesaler can act on; each of these says what to do next.
    state: r.redeemed_at ? "accepted"
         : r.revoked_at ? "withdrawn"
         : new Date(r.expires_at) < new Date() ? "expired"
         : "waiting",
  }));
}

export async function issueInvite({ shopName, phone, note, days } = {}) {
  const { data, error } = await sbCall(supabase.rpc("v2_issue_buyer_invite", {
    p_shop_name: shopName || null, p_phone: phone || null,
    p_note: note || null, p_days: days || 30,
  }));
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.msg || "Could not create the invitation" };
  return { ok: true, id: row.invite_id, token: row.token, expiresAt: row.expires_at };
}

export async function revokeInvite(inviteId) {
  const { data, error } = await sbCall(supabase.rpc("v2_revoke_buyer_invite", { p_invite_id: inviteId }));
  if (error) return { ok: false, error: error.message };
  return { ok: !!data };
}

/** What the invited shop sees before they accept. */
export async function inviteByToken(token) {
  const { data, error } = await sbCall(supabase.rpc("v2_invite_by_token", { p_token: token }));
  if (error) return { status: "error", error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    status: row?.status || "not_found",
    wholesalerName: row?.wholesaler_name || "",
    shopName: row?.shop_name || "",
  };
}

/** Accept it. Creates the shop record and the login together, in one
 *  transaction -- a client who cannot sign in is not a client.
 *
 *  NAMED redeemBuyerInvite, not redeemInvite, and that is not fussiness.
 *  js/lib/dev-auth.js already has a redeemInvite() for the OWNER/WHOLESALER
 *  invite (migration 022) -- a completely different object with a completely
 *  different table behind it. check_cross_module_imports.mjs caught the
 *  collision immediately: it saw dev-auth calling "redeemInvite" and this
 *  module exporting one, and reported a call to an export not in scope.
 *
 *  One name meaning two things is exactly how `v2_suppliers` came to mean the
 *  opposite of "supplier" in this codebase, which its own migration header
 *  now has to warn every reader about. Not repeating that. */
export async function redeemBuyerInvite(token, { shopName, username, password }) {
  const { data, error } = await sbCall(supabase.rpc("v2_redeem_buyer_invite", {
    p_token: token, p_shop_name: shopName, p_username: username, p_password: password,
  }));
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.msg || "Could not accept the invitation" };
  return { ok: true, wid: row.wid, clientId: row.client_id, accountId: row.account_id };
}

/** The link the wholesaler pastes into WhatsApp.
 *  Built from the live origin: a stored base URL goes stale the day the app
 *  moves, and a dead invite link costs a relationship, not just a click. */
export function inviteLink(token) {
  return `${window.location.origin}/#/i/${token}`;
}

export function inviteWhatsappHref(token, { wholesalerName, shopName } = {}) {
  const line = [
    shopName ? `Hi ${shopName},` : "Hi,",
    wholesalerName ? `${wholesalerName} has set up an account for you to order online.` : "You have been invited to order online.",
    "Open this to choose a password:",
    inviteLink(token),
  ].join("\n");
  return `https://wa.me/?text=${encodeURIComponent(line)}`;
}
