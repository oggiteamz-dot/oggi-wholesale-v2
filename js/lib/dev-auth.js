// OGGI Wholesale v2 — real authentication (Batch 14)
//
// Replaces the Batch 0 dev-mode stub ("pick any role, no password") with
// real credentialed login for all four roles. The file path and the
// `devAuth` export name are UNCHANGED on purpose -- Batch 0's own comment
// said "Batch 14 can swap the implementation without rewriting every call
// site", and that is exactly what this file does. Every one of the ~15+
// call sites across the app that do `const session = devAuth.getSession();`
// keeps working untouched. Session shape is also unchanged:
// { role, wid, wholesalerName, actorId, actorLabel, ...extras }.
//
// Two tiers, mirroring v1's already-proven pattern (full rationale in
// migrations/022_v2_auth_schema.sql's header comment):
//   owner / wholesaler -> real Supabase Auth (email+password, a real JWT
//     session, persisted by the Supabase client itself -- see
//     supabase-client.js's `storageKey: "oggi-v2-auth"`).
//   sales / buyer      -> lightweight v2_portal_accounts credentials,
//     verified server-side by the throttled v2_sales_login/v2_buyer_login
//     RPCs, cached client-side in the SAME localStorage key this app has
//     used since Batch 0 -- only now the row only ever gets written after
//     a real bcrypt password check succeeds, not freely chosen.
//
// getSession() MUST stay synchronous -- every existing call site expects
// that. The one async step (resolving whichever session currently exists)
// happens exactly once, in bootstrap(), which app.js now awaits before its
// first render. After that, getSession() just returns an in-memory cache.

import { supabase } from "./supabase-client.js";

const STORAGE_KEY = "oggi-v2-dev-session"; // unchanged since Batch 0
const ROLES = ["owner", "wholesaler", "sales", "buyer"];

let cachedSession = null;
let bootstrapped = false;

function readLocalSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !ROLES.includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeLocalSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}
function clearLocalSession() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Builds the app session object for an owner/wholesaler from their
 * v2_user_profiles row. Returns null if there's a real Supabase Auth
 * user but no profile yet (signed up but hasn't redeemed an invite, or
 * mid-signup with email confirmation pending) -- the login screen
 * handles that case by offering the "redeem an invite" step next,
 * rather than treating it as a usable app session. */
async function loadOwnerWholesalerProfile(authUser) {
  const { data, error } = await supabase
    .from("v2_user_profiles")
    .select("role, wid, wholesaler_name, actor_label")
    .eq("id", authUser.id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    role: data.role,
    wid: data.wid || null,
    wholesalerName: data.wholesaler_name || null,
    actorId: authUser.id,
    actorLabel: data.actor_label || (data.role === "owner" ? "Owner" : "Wholesaler"),
    authUserId: authUser.id,
  };
}

async function resolveSession() {
  const { data } = await supabase.auth.getSession();
  const authUser = data?.session?.user;
  if (authUser) {
    const profile = await loadOwnerWholesalerProfile(authUser);
    if (profile) return profile;
    // Signed in (real Supabase Auth identity exists) but no role yet --
    // not a usable app session. login.js checks for this shape
    // (role === null && pendingAuthUser) to jump straight to the
    // "redeem your invite code" step instead of the sign-in form.
    return { role: null, pendingAuthUser: authUser };
  }
  const local = readLocalSession();
  if (local && (local.role === "buyer" || local.role === "sales")) return local;
  return null;
}

export const devAuth = {
  ROLES,

  /** Must be awaited exactly once, before the app's first render (see
   * app.js). Resolves whichever session -- if any -- is currently valid,
   * and also registers a background listener that keeps the cache
   * accurate across token refreshes. Deliberately does NOT trigger a
   * re-render on every auth event (a silent hourly token refresh
   * shouldn't blow away whatever the wholesaler is in the middle of
   * doing) -- callers that change the session (signIn/redeemInvite/
   * loginBuyer/loginSales/logout) are responsible for their own explicit
   * navigation afterward, exactly like the pre-Batch-14 login flow. */
  async bootstrap() {
    cachedSession = await resolveSession();
    bootstrapped = true;
    supabase.auth.onAuthStateChange(async (event, authSession) => {
      if (event === "TOKEN_REFRESHED") return; // cache is still correct, nothing to redo
      const authUser = authSession?.user;
      if (authUser) {
        const profile = await loadOwnerWholesalerProfile(authUser);
        cachedSession = profile || { role: null, pendingAuthUser: authUser };
      } else if (!readLocalSession()) {
        cachedSession = null;
      }
    });
    return cachedSession;
  },

  isBootstrapped() {
    return bootstrapped;
  },

  /** Synchronous, unchanged contract. Returns null until bootstrap() has
   * resolved once (app.js guarantees that happens before the first
   * mountShell() call, so no existing call site ever observes the
   * pre-bootstrap "always null" state). */
  getSession() {
    return cachedSession;
  },

  isLoggedIn() {
    return !!cachedSession && !!cachedSession.role;
  },

  // ---- Owner / wholesaler: real Supabase Auth ----

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    const profile = await loadOwnerWholesalerProfile(data.user);
    cachedSession = profile || { role: null, pendingAuthUser: data.user };
    return { ok: true, needsInvite: !profile };
  },

  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    if (!data.session) {
      // Email confirmation is required by this project's Auth settings
      // (the honest, secure default) -- no session exists yet, so there
      // is nothing to cache. The caller tells the user to check email
      // and come back to sign in once confirmed.
      return { ok: true, needsEmailConfirmation: true };
    }
    cachedSession = { role: null, pendingAuthUser: data.user };
    return { ok: true, needsInvite: true };
  },

  async redeemInvite(code, actorLabel) {
    const { data, error } = await supabase.rpc("v2_redeem_invite", { p_code: code, p_actor_label: actorLabel });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];
    if (!row?.ok) return { ok: false, error: row?.msg || "Could not redeem invite" };
    const { data: sessData } = await supabase.auth.getSession();
    if (sessData?.session?.user) {
      cachedSession = await loadOwnerWholesalerProfile(sessData.session.user);
    }
    return { ok: true };
  },

  /** Owner only. Returns the raw invite code once -- there is nowhere
   * else to retrieve it after this call returns. */
  async createInvite(role, wid, wholesalerName) {
    const { data, error } = await supabase.rpc("v2_create_invite", {
      p_role: role, p_wid: wid || null, p_wholesaler_name: wholesalerName || null, p_expires_in_days: 14,
    });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];
    return row?.ok ? { ok: true, code: row.code } : { ok: false, error: row?.msg || "Could not create invite" };
  },

  // ---- Buyer / sales: v2_portal_accounts ----

  async loginBuyer(wid, username, password) {
    const { data, error } = await supabase.rpc("v2_buyer_login", { p_wid: wid, p_user: username, p_pass: password });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];

    // BANNED (migration 059). The server only ever returns this when the
    // password was CORRECT -- a wrong password still comes back as the
    // same generic failure below, so this cannot be used to find out
    // which usernames exist.
    //
    // The message names the wholesaler on purpose. Hadi, 20 Aug 2026:
    // "we'll just say the name of the company has banned you from all of
    // their catalogs." A blank refusal here would send the person to
    // OGGI support for something only their wholesaler can undo.
    if (row?.status === "banned") {
      return {
        ok: false,
        banned: true,
        error: `${row.banned_by_name || "This wholesaler"} has banned you from all of their catalogues. Contact them directly if you think this is a mistake.`,
      };
    }

    if (!row?.ok) return { ok: false, error: "Incorrect username or password (or this account is temporarily locked after repeated failed attempts -- try again in 15 minutes)" };
    const session = {
      role: "buyer", wid: row.wid, wholesalerName: row.wholesaler_name,
      actorId: row.account_id, actorLabel: row.actor_label,
      accountId: row.account_id, clientId: row.client_id,
      shopName: row.shop_name, discountPct: row.discount_pct,
    };
    writeLocalSession(session);
    cachedSession = session;
    return { ok: true };
  },

  /** Adopt an already-verified buyer session written by another door.
   *
   *  ADDED 30 Aug 2026 for the marketplace login (ID-03). js/data/marketplace.js
   *  signs a person in to OGGI and then resolves ONE store server-side through
   *  v2_session_account, which re-checks the membership. What comes back is the
   *  same account id and client id v2_buyer_login would have returned, so the
   *  only thing left to do is write it into the same place, in the same shape,
   *  under the same key this app has used since Batch 0.
   *
   *  ⚠️ THIS PERFORMS NO CHECK OF ITS OWN, AND MUST NOT BE CALLED WITH
   *  ANYTHING A USER SUPPLIED. It is a setter, not a login. The verification
   *  lives in the database — v2_session_person proves the session token, and
   *  v2_session_account proves the membership — and duplicating a weaker copy
   *  of that check here would create a second, softer authority that could
   *  drift out of agreement with the real one. The only two callers are
   *  enterStore() and resumeStore(), both of which pass through the RPC first.
   *
   *  Deliberately kept OUT of loginBuyer: that function still does its own
   *  bcrypt round trip and is untouched, so the per-store door works exactly as
   *  it did yesterday (GP-02). */
  adoptBuyerSession(session) {
    if (!session || session.role !== "buyer" || !session.accountId) return false;
    writeLocalSession(session);
    cachedSession = session;
    return true;
  },

  async loginSales(username, password) {
    const { data, error } = await supabase.rpc("v2_sales_login", { p_user: username, p_pass: password });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];
    if (!row?.ok) return { ok: false, error: "Incorrect username or password (or this account is temporarily locked after repeated failed attempts -- try again in 15 minutes)" };
    const session = {
      role: "sales", wid: row.wid, wholesalerName: row.wholesaler_name,
      actorId: row.account_id, actorLabel: row.actor_label, accountId: row.account_id,
    };
    writeLocalSession(session);
    cachedSession = session;
    return { ok: true };
  },

  /** Owner or the owning wholesaler only. Returns the generated
   * temp_password once, same one-time-reveal pattern as invites. */
  async createPortalAccount({ role, wid, username, password, clientId, actorLabel }) {
    const { data, error } = await supabase.rpc("v2_create_portal_account", {
      p_role: role, p_wid: wid, p_username: username, p_password: password,
      p_client_id: clientId || null, p_actor_label: actorLabel || null,
    });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];
    return row?.ok ? { ok: true, accountId: row.account_id } : { ok: false, error: row?.msg || "Could not create account" };
  },

  /** Anyone, no session required -- the public "request buyer access"
   * form. Always lands as status='pending'; a wholesaler/owner approves
   * it later via js/data/owner.js's approveSignupRequest. */
  async requestBuyerAccess(wid, buyerName, location, volume, sells) {
    const { data, error } = await supabase.rpc("v2_submit_signup_request", {
      p_wid: wid, p_buyer_name: buyerName, p_location: location, p_volume: volume, p_sells: sells,
    });
    if (error) return { ok: false, error: error.message };
    const row = data?.[0];
    return row?.ok ? { ok: true } : { ok: false, error: row?.msg || "Could not submit request" };
  },

  async logout() {
    // Synchronous parts first, so a fire-and-forget call (topbar.js
    // doesn't await this) still leaves getSession() correct immediately
    // -- the actual network sign-out call trails behind harmlessly.
    const wasOwnerWholesaler = cachedSession?.role === "owner" || cachedSession?.role === "wholesaler";
    clearLocalSession();
    cachedSession = null;

    // ID-02, 30 Aug 2026. A marketplace session must be REVOKED SERVER-SIDE on
    // sign-out, not merely forgotten by this device. Clearing localStorage
    // leaves a token that is still valid for the rest of its 30 days, which is
    // exactly the thing the session table was added to stop -- "I logged out"
    // has to mean the token is dead, not that this browser stopped presenting
    // it.
    //
    // Imported lazily so dev-auth keeps no import of a module that imports it
    // back. The import is inside the try because a failure here must never stop
    // the local session from being cleared: signing out locally is the part the
    // person can see.
    try {
      const { marketplaceLogout } = await import("../data/marketplace.js");
      await marketplaceLogout();
    } catch { /* the local session is already gone, which is the visible half */ }

    if (wasOwnerWholesaler) await supabase.auth.signOut();
  },
};
