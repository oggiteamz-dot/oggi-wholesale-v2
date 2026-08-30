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

/** AC-05. Invite a list of shops in one go.
 *
 *  `rows` is [{ shopName, phone, note }]. Returns one result per input row, IN
 *  ORDER, including the ones that failed — a bulk operation that silently drops
 *  rows is a wholesaler believing they invited forty shops when they invited
 *  thirty-eight.
 *
 *  ==== NOTHING HERE DECIDES WHAT COUNTS AS A DUPLICATE ====================
 *
 *  A row whose phone already has a live invitation comes back as `existing`,
 *  with the SAME token. That is decided by migration 109, matched on the same
 *  normaliser the whole schema uses. The browser does not get an opinion,
 *  because two live tokens for one shop means withdrawing the one you can see
 *  leaves the other working. */
export async function issueInvitesBulk(rows, days = 30) {
  const payload = (Array.isArray(rows) ? rows : []).map((r) => ({
    shop_name: r.shopName || null, phone: r.phone || null, note: r.note || null,
  }));
  if (!payload.length) return { ok: false, error: "Nothing to invite.", rows: [] };
  const { data, error } = await sbCall(supabase.rpc("v2_issue_buyer_invites_bulk", {
    p_rows: payload, p_days: days,
  }));
  if (error) return { ok: false, error: "Could not send those invitations.", rows: [] };
  const out = (data || []).map((r) => ({
    index: r.row_index, ok: !!r.ok, outcome: r.outcome,
    shopName: r.shop_name || null, phone: r.phone || null,
    inviteId: r.invite_id || null, token: r.token || null,
    expiresAt: r.expires_at || null, message: r.msg || null,
  }));
  // A refusal of the WHOLE batch comes back as one row with index 0 — too many
  // rows, no session, nothing to invite. Told apart from per-row failures here
  // so the screen can say "none of this was sent" rather than listing one line.
  const whole = out.length === 1 && out[0].index === 0 && !out[0].ok;
  return whole
    ? { ok: false, error: out[0].message || "Could not send those invitations.", rows: [] }
    : { ok: true, rows: out };
}

/** The list a wholesaler pastes somewhere else. CSV because it opens in the
 *  spreadsheet they already keep their customers in, and because a link is
 *  useless in a screenshot.
 *
 *  Every field is quoted and every embedded quote doubled: a shop name with a
 *  comma in it would otherwise shift every column after it, which is the kind
 *  of corruption nobody notices until the wrong shop gets the wrong link. */
export function invitesCsv(results) {
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["Shop", "Phone", "Link", "Expires", "Status"].map(q).join(",");
  const lines = (results || []).filter((r) => r.token).map((r) => [
    r.shopName || "", r.phone || "", inviteLink(r.token),
    r.expiresAt ? new Date(r.expiresAt).toISOString().slice(0, 10) : "",
    r.outcome === "existing" ? "Already invited — same link" : "Invited",
  ].map(q).join(","));
  return [head, ...lines].join("\r\n");
}

/** One pasted line to one row. "Maison Rita, 03 456 789" and
 *  "Maison Rita 03 456 789" and a bare number all have to work, because this is
 *  a box a person pastes into from wherever their customer list already lives.
 *
 *  THE NUMBER IS FOUND AT THE END OF THE LINE, not by splitting on the comma:
 *  a shop name may contain one ("Rita, Beirut") and a phone number may not.
 *  Splitting on the comma would put half the shop name in the phone column. */
export function parseInviteLines(text) {
  return String(text || "").split(/\r?\n/)
    .map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)[,;\s]*([+0-9][0-9\s().+-]{5,})$/);
      if (m && m[2]) {
        return { shopName: m[1].replace(/[,;\s]+$/, "").trim() || null, phone: m[2].trim() };
      }
      return { shopName: line.replace(/[,;]+$/, "").trim() || null, phone: null };
    });
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
