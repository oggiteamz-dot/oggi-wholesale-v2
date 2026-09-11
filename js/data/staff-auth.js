// =============================================================================
// OGGI Wholesale v2 — THE STORE-STAFF SESSION                  Block 7, 11 Sep 2026
// =============================================================================
// A warehouse manager or a finance manager signing in to the store they work
// for. Migrations 132/133.
//
// THIS IS A THIRD TIER AND IT IS DELIBERATELY NOT EITHER OF THE OTHER TWO.
//
//   * NOT v2_user_profiles (owner|wholesaler). v2_my_wid() is the tenant
//     predicate at 201 policy sites and carries no role, so a staff profile
//     row there would be indistinguishable from the owner of the business at
//     every one of them -- prices, deletions, cost, bans.
//
//   * NOT v2_portal_accounts (buyer|sales). check_person_identity.sql requires
//     every portal account to have a person_id, which would make a warehouse
//     manager a MARKETPLACE PERSON keyed on their phone number -- and merge
//     their staff login with their personal buyer account if they happen to
//     shop somewhere else. v2_people means "one human, many stores"; a picker
//     at one warehouse is the opposite of that sentence.
//
// SO: its own table, and the browser runs as `anon`. That is the security
// model, not a limitation -- a desk can do nothing at all until somebody writes
// a SECURITY DEFINER function saying what it may do, and every one of those
// re-checks the id it is handed (an id from a browser is a claim, not a
// credential -- the salesperson tier learned that in 048).
//
// ⚠️ THE SESSION IS RE-VALIDATED ON EVERY PAGE LOAD, not just trusted from
// localStorage. A suspended picker stops working at the next reload rather than
// whenever a cached session happens to expire. That costs one round trip at
// boot and it is the difference between revoking access and hoping.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

const STORAGE_KEY = "oggi-v2-desk-session";

/** Sign in at a desk. The store must be named: a desk always belongs to one
 *  store, so unlike the salesperson door there is no global username space to
 *  search and nothing to guess at. */
export async function staffLogin(wid, username, password) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_staff_login", {
      p_wid: (wid || "").trim(),
      p_username: (username || "").trim(),
      p_password: password || "",
    })
  );
  if (error) return { ok: false, error: "Could not sign in just now. Try again." };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    // One sentence for every failure. The server answers identically for a
    // wrong password, an unknown user, a suspended account, a closed store and
    // a throttled key (133), and this message must not undo that by guessing.
    return {
      ok: false,
      error: "Incorrect store, username or password — or this login is locked "
           + "for 15 minutes after repeated failed attempts.",
    };
  }
  const session = sessionFromRow(row);
  writeSession(session);
  return { ok: true, session };
}

function sessionFromRow(row) {
  return {
    role: row.desk,                 // "warehouse" | "finance" -- the app's role IS the desk
    desk: row.desk,
    staffId: row.staff_id,
    wid: row.wid,
    wholesalerName: row.wholesaler_name,
    actorLabel: row.actor_label || null,
  };
}

function writeSession(session) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* private mode */ }
}

export function readDeskSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.staffId || (s.desk !== "warehouse" && s.desk !== "finance")) return null;
    return s;
  } catch { return null; }
}

export function clearDeskSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Ask the SERVER whether the remembered id is still good. Returns a fresh
 *  session (names and labels may have changed) or null.
 *
 *  Null here means sign out. It covers: suspended, deleted, store closed, and
 *  a localStorage value somebody typed in by hand. */
export async function resumeDeskSession() {
  const local = readDeskSession();
  if (!local?.staffId) return null;
  const { data, error } = await sbCall(
    supabase.rpc("v2_staff_session", { p_staff_id: local.staffId })
  );
  // ⚠️ A NETWORK ERROR IS NOT A REVOCATION. Signing somebody out of a warehouse
  // tablet because the wifi dropped for a second is its own outage; the desk
  // keeps the session it had and the next call will fail honestly on its own.
  if (error) return local;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) { clearDeskSession(); return null; }
  const session = sessionFromRow(row);
  writeSession(session);
  return session;
}

// ============================================================ hiring a desk
// Called from the wholesaler's Team screen. `authenticated` only -- a desk
// cannot hire a desk (133 revokes these from anon explicitly).

export async function listStaffAccounts(wid) {
  const { data, error } = await sbCall(
    supabase.from("v2_staff_accounts")
      .select("id, wid, desk, username, actor_label, active, created_at")
      .eq("wid", wid)
      .order("desk", { ascending: true })
      .order("username", { ascending: true })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    id: r.id, wid: r.wid, desk: r.desk, username: r.username,
    actorLabel: r.actor_label || null, active: r.active === true,
    createdAt: r.created_at,
  }));
}

export async function createStaffAccount({ wid, desk, username, password, actorLabel }) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_create_staff_account", {
      p_wid: wid, p_desk: desk, p_username: username,
      p_password: password, p_actor_label: actorLabel || null,
    })
  );
  if (error) return { ok: false, error: "Could not create that login just now." };
  const row = Array.isArray(data) ? data[0] : data;
  return row?.ok ? { ok: true, staffId: row.staff_id } : { ok: false, error: row?.msg || "Could not create that login." };
}

export async function setStaffActive(staffId, active) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_staff_active", { p_staff_id: staffId, p_active: !!active })
  );
  if (error) return { ok: false, error: "Could not change that just now." };
  const row = Array.isArray(data) ? data[0] : data;
  return row?.ok ? { ok: true, msg: row.msg } : { ok: false, error: row?.msg || "Could not change that." };
}
