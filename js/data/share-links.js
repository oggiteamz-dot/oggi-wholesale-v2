// =============================================================================
// OGGI Wholesale v2 — SHARE LINKS                        Block 3, 8 Sep 2026
// =============================================================================
// The one door. Hadi's description of it, in his words:
//
//   "When they create a share link, they're gonna put in that person's phone
//    number... and they're gonna set a discount for that link. And this is a
//    one time use link... give them the function, the ability to decide. Is
//    this a one time link for one person, or this is like an unlimited use
//    link, or is this link but the approval is needed? Or if it's auto
//    approval with, like, a certain number of link users?...
//    But either way, they get access and they are logged in. THEY ARE SIGNED
//    UP TO THE MARKETPLACE ITSELF."
//
// Everything here goes through migrations 127-129's SECURITY DEFINER
// functions. `anon` holds no privilege on v2_share_links and must not: the
// table has row security ON and NO policy, which denies every browser role
// outright whatever the grants say. A token is a capability; a table grant is
// not.
//
// ==== THE BROWSER DECIDES NOTHING =========================================
//
// Not which links may be created, not who gets in, not what a dead link says.
// Every one of those is a branch in the database, and this file's whole job is
// to pass a token in and render the sentence that comes back. Migration 121
// wrote down what the other arrangement costs: a disabled button is a UI
// state, not a rule.
//
// The one thing this file does add is `shareLinkUrl`, and even that is only
// string concatenation around a token the DATABASE generated. Nothing here
// makes a token. `rotateCatalogLink` in js/data/catalogs.js is the one place
// in this codebase that generates a token in the browser, and it is the
// counter-example rather than the pattern.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { adoptMarketplaceSession } from "./marketplace.js";

/** The URL to paste into WhatsApp. `j` for JOIN — deliberately not `c` (a
 *  catalogue link) or `i` (a v2_buyer_invites link), so the three cannot be
 *  confused in a log, in a support conversation, or by isPublicPath. */
export function shareLinkUrl(token) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#/j/${token}`;
}

/** What the holder of a token is told, BEFORE they fill anything in.
 *
 *  Returns { status: 'ok'|'unavailable', wid, wholesalerName, kind, hint, msg }.
 *  `hint` is one of 'immediate' | 'phone_must_match' | 'needs_approval'.
 *
 *  Note what is NOT in that list: the invitee's name and phone. The database
 *  deliberately does not return them (migration 129's header), so this module
 *  could not show them even if a future screen wanted to. A one-person link
 *  travels by WhatsApp and WhatsApp messages get forwarded. */
export async function peekShareLink(token) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_share_link_peek", { p_token: String(token || "") })
  );
  if (error) {
    // A network failure is NOT "this link is dead". Saying so would tell
    // somebody with a perfectly good link to go and ask for a new one.
    return { status: "error", msg: "Could not open this link just now. Check your connection and try again." };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: "unavailable", msg: "This link is no longer active. Ask whoever sent it to you for a new one." };
  return {
    status: row.status,
    wid: row.wid || null,
    wholesalerName: row.wholesaler_name || null,
    kind: row.kind || null,
    hint: row.hint || null,
    msg: row.msg || "",
  };
}

/** Redeem it. One call, one transaction, and on success the person is SIGNED
 *  IN whether or not the store let them in.
 *
 *  Returns { ok, error?, outcome, wid, wholesalerName, clientId, accountId }.
 *  `outcome` is 'joined' | 'requested' | 'already'.
 *
 *  THE SESSION IS ADOPTED HERE AND NOT BY THE VIEW. A view that forgets the
 *  call leaves somebody who was signed in by the server signed out in the
 *  browser -- which is exactly the "signed up to the marketplace itself"
 *  promise failing silently, in the one place nothing would notice. */
export async function redeemShareLink(token, { phone, name, shopName, username, password, answers } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_redeem_share_link", {
      p_token: String(token || ""),
      p_phone: String(phone || "").trim(),
      p_name: name ? String(name).trim() : null,
      p_shop_name: String(shopName || "").trim(),
      p_username: String(username || "").trim(),
      p_password: String(password || ""),
      p_answers: answers || null,
    })
  );
  if (error) return { ok: false, error: "Could not finish signing you up just now. Try again." };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    // The server's own words, verbatim. It knows things this form cannot --
    // that the username is taken for this store, that the link was used while
    // they were typing -- and it says them in plain language. Elaborating here
    // would rebuild in the browser the enumeration care the database took.
    return { ok: false, error: row?.msg || "That did not work. Please try again." };
  }

  adoptMarketplaceSession({
    sessionId: row.session_id,
    token: row.session_token,
    personId: row.person_id,
    displayName: shopName || name || null,
    expiresAt: row.expires_at,
  });

  return {
    ok: true,
    outcome: row.outcome,
    wid: row.wid || null,
    wholesalerName: row.wholesaler_name || null,
    clientId: row.client_id || null,
    accountId: row.account_id || null,
    msg: row.msg || "",
  };
}

// =============================================================================
// THE WHOLESALER'S SIDE
// =============================================================================

/** Every link this wholesaler has made, newest first.
 *
 *  Not scoped by wid here, and that is not an omission: v2_my_share_links is
 *  SECURITY DEFINER and scopes to v2_my_wid() INSIDE the function, over a
 *  table no browser role may read at all. Adding an `.eq("wid", ...)` here
 *  would be a filter on a query this module cannot make. */
export async function listMyShareLinks() {
  const { data, error } = await sbCall(supabase.rpc("v2_my_share_links"));
  if (error) return [];
  return (data || []).map((r) => ({
    id: r.id,
    token: r.token,
    kind: r.kind,
    // ONE state, computed in SQL. See migration 129: four `if`s in the browser
    // is four places for the rules to drift apart.
    state: r.state,
    inviteeName: r.invitee_name || null,
    inviteePhone: r.invitee_phone || null,
    discountPct: r.discount_pct == null ? null : Number(r.discount_pct),
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    usesCount: Number(r.uses_count || 0),
    // People who came through and were sent to the approval queue. uses_count
    // counts GRANTS, so without this a link forty people opened reads "0 used".
    requestsCount: Number(r.requests_count || 0),
    catalogName: r.catalog_name || null,
    note: r.note || null,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at || null,
    createdAt: r.created_at,
  }));
}

export async function createShareLink({ kind, inviteeName, inviteePhone, discountPct, maxUses, catalogId, days, note } = {}) {
  const { data, error } = await sbCall(supabase.rpc("v2_create_share_link", {
    p_kind: kind || "one_time",
    p_invitee_name: inviteeName || null,
    p_invitee_phone: inviteePhone || null,
    p_discount_pct: discountPct == null || discountPct === "" ? null : Number(discountPct),
    p_max_uses: maxUses == null || maxUses === "" ? null : Number(maxUses),
    p_catalog_id: catalogId || null,
    p_days: days || 30,
    p_note: note || null,
  }));
  if (error) return { ok: false, error: "Could not make the link just now. Try again." };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.msg || "Could not make the link" };
  return { ok: true, id: row.link_id, token: row.token, expiresAt: row.expires_at };
}

/** Withdraw one. A stamp, never a delete — the access requests that came
 *  through it still name it, and a link that was sent and withdrawn is a thing
 *  that happened. */
export async function revokeShareLink(id) {
  const { data, error } = await sbCall(supabase.rpc("v2_revoke_share_link", { p_id: id }));
  if (error) return { ok: false, error: "Could not withdraw that link just now." };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, error: row?.ok ? null : (row?.msg || "Could not withdraw that link") , msg: row?.msg || "" };
}

/** The message a wholesaler sends. Their own thread, their own words — this
 *  only saves them typing the link. */
export function shareLinkWhatsappHref(token, { wholesalerName, inviteeName } = {}) {
  const hi = inviteeName ? `Hi ${inviteeName}, ` : "";
  const who = wholesalerName ? `${wholesalerName} ` : "";
  const text = `${hi}${who}has set you up to order online. Open this to finish signing up: ${shareLinkUrl(token)}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
