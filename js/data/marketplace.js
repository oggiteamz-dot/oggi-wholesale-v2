// =============================================================================
// OGGI Wholesale v2 — THE MARKETPLACE SESSION            ID-03, ID-09, 30 Aug 2026
// =============================================================================
// Signing in to OGGI, and moving between the stores that let you in.
//
// Hadi, 30 August: "Make the client bound to us, to the main market. And then
// each wholesaler gives them access."
//
// ==== WHAT IS KEPT ON THE PHONE, AND WHAT IS NOT ===========================
//
// Stored (localStorage, key `oggi-v2-marketplace`):
//     { sessionId, token, personId, displayName, expiresAt, activeWid }
//
// The token is a 32-byte secret the database issued ONCE at login and stores
// only as a SHA-256 hash. It EXPIRES and it can be REVOKED — which is the whole
// of why ID-02 came out of Phase 7 with this feature rather than after it.
//
// NOT stored: the list of stores, and the per-store account id.
//
// That is deliberate. Both are re-fetched from the server on every boot and on
// every store switch, so a wholesaler who revokes access at 3pm cannot be
// entered at 4pm out of a stale copy on the buyer's phone. The database
// re-checks the membership inside v2_session_account every single time; caching
// the answer here would be a way of disagreeing with it.
//
// ==== HOW THIS SITS BESIDE THE OLD SESSION =================================
//
// It does not replace it. `devAuth` still owns the app session, and every one
// of the ~15 call sites that read `devAuth.getSession()` keeps working
// untouched. What happens on a marketplace sign-in, and on every store switch,
// is that this module RESOLVES the store and then writes exactly the same
// buyer session shape devAuth has written since Batch 0:
//
//     { role:"buyer", wid, wholesalerName, actorId, actorLabel,
//       accountId, clientId, shopName, discountPct }
//
// So the rest of the app cannot tell which door someone came through, which is
// the point: two doors, one app, and no second copy of the buyer screens.
// GP-02 — nobody is forced to re-register — holds by construction.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

const MKT_KEY = "oggi-v2-marketplace";

function readMkt() {
  try {
    const raw = localStorage.getItem(MKT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.sessionId || !s?.token) return null;
    // Expiry is checked here as well as on the server. The server is the
    // authority — this is only so an obviously dead session does not cause a
    // pointless round trip on every boot.
    if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}
function writeMkt(s) {
  try { localStorage.setItem(MKT_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
function clearMkt() {
  try { localStorage.removeItem(MKT_KEY); } catch { /* ignore */ }
}

/** Is there a marketplace session on this device? Synchronous, like
 *  devAuth.getSession(), because render paths call it. */
export function hasMarketplaceSession() {
  return !!readMkt();
}

export function marketplaceSession() {
  return readMkt();
}

/** ID-03 — sign in to OGGI with a phone or an email. No wholesaler code.
 *
 *  Returns { ok, error?, stores? }. On success the session is stored and the
 *  caller decides which store to enter (see enterStore below): a buyer with one
 *  store goes straight in, a buyer with several is asked. */
export async function marketplaceLogin(identifier, password) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_marketplace_login", {
      p_identifier: String(identifier || "").trim(),
      p_password: String(password || ""),
    })
  );
  if (error) return { ok: false, error: "Could not sign in just now. Try again." };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    // The server deliberately returns ONE message for an unknown number, a
    // wrong password, and a person who has not set a marketplace password yet.
    // It is passed through verbatim and never elaborated on here — inventing a
    // more helpful client-side message would rebuild, in the browser, the
    // enumeration oracle the database was careful not to be.
    return { ok: false, error: row?.msg || "That phone or email and password do not match." };
  }

  writeMkt({
    sessionId: row.session_id,
    token: row.session_token,
    personId: row.person_id,
    displayName: row.display_name || null,
    expiresAt: row.expires_at,
    activeWid: null,
  });

  const stores = await listStores();
  return { ok: true, stores };
}

/** ID-09 — every store this person can still enter.
 *
 *  Always from the server. See the header: a cached copy is a way of
 *  disagreeing with the wholesaler who revoked you. */
export async function listStores() {
  const s = readMkt();
  if (!s) return [];
  const { data, error } = await sbCall(
    supabase.rpc("v2_session_stores", { p_session_id: s.sessionId, p_token: s.token })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    wid: r.wid,
    wholesalerName: r.wholesaler_name || r.wid,
    brand: r.brand || null,
    logo: r.logo || null,
    currency: r.currency || "$",
    accountId: r.account_id || null,
    clientId: r.client_id || null,
  }));
}

/** Enter one store: resolve it server-side, then write the ordinary buyer
 *  session so the whole existing app works unchanged.
 *
 *  The membership is re-checked inside v2_session_account on every call, so
 *  this is also the thing that makes a revoked store stop working immediately
 *  rather than at the end of the 30-day session. */
export async function enterStore(wid) {
  const s = readMkt();
  if (!s) return { ok: false, error: "Please sign in again." };

  const { data, error } = await sbCall(
    supabase.rpc("v2_session_account", {
      p_session_id: s.sessionId, p_token: s.token, p_wid: wid,
    })
  );
  if (error) return { ok: false, error: "Could not open that store just now." };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok || !row.account_id) {
    // Covers three different underlying states — expired session, revoked
    // membership, a store they were never in — with one message, for the same
    // reason the login does.
    return { ok: false, error: "You do not have access to that store." };
  }

  writeMkt({ ...s, activeWid: wid });

  // The SAME shape devAuth has written since Batch 0. Nothing downstream needs
  // to know a marketplace session exists.
  devAuth.adoptBuyerSession({
    role: "buyer",
    wid,
    wholesalerName: row.wholesaler_name || wid,
    actorId: row.account_id,
    actorLabel: s.displayName || row.wholesaler_name || "Buyer",
    accountId: row.account_id,
    clientId: row.client_id || null,
    shopName: s.displayName || null,
    discountPct: 0,
  });

  return { ok: true, wid, wholesalerName: row.wholesaler_name, currency: row.currency };
}

/** Re-enter whichever store was active, on boot. Returns false when the
 *  session is gone or the store is no longer enterable, and the caller sends
 *  them to the login screen — which is the correct outcome for an expired or
 *  revoked session, and the reason this is checked rather than assumed. */
export async function resumeStore() {
  const s = readMkt();
  if (!s) return false;
  if (s.activeWid) {
    const r = await enterStore(s.activeWid);
    if (r.ok) return true;
  }
  const stores = await listStores();
  if (stores.length === 1) return (await enterStore(stores[0].wid)).ok;
  return false;
}

/** Set a marketplace password by proving an existing per-store one.
 *  For the people the back-fill deliberately skipped — those with several
 *  stores and several different passwords. */
export async function setMarketplacePassword({ wid, username, oldPassword, newPassword }) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_marketplace_password", {
      p_wid: wid, p_username: username,
      p_old_pass: oldPassword, p_new_pass: newPassword,
    })
  );
  if (error) return { ok: false, error: "Could not save that just now." };
  const row = Array.isArray(data) ? data[0] : data;
  return row?.ok ? { ok: true } : { ok: false, error: row?.msg || "Could not save that." };
}

/** Sign out of OGGI. Revokes the session server-side FIRST, so a stolen copy of
 *  the token is dead even if the local clear fails (private mode, quota). */
export async function marketplaceLogout() {
  const s = readMkt();
  if (s) {
    await sbCall(
      supabase.rpc("v2_session_logout", { p_session_id: s.sessionId, p_token: s.token })
    );
  }
  clearMkt();
}
