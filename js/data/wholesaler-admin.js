// OGGI Wholesale v2 — owner-side wholesaler administration (CR-0001 R1/R3)
//
// WHAT THIS FILE IS FOR
// Creating a wholesaler. Until 17 Aug 2026 the product had no way to do
// this at all -- not in the interface, not in the database -- so a real
// wholesaler could never be onboarded. This is the data layer for the
// "Add wholesaler" form.
//
// WHY IT IS ONE `rpc()` CALL AND NOT SIX `insert()` CALLS
// Creating a wholesaler touches six places (two auth tables, v1's
// wholesalers table, v2's, and BOTH role-profile tables -- this product
// has two). Doing that from here would be six requests that can each fail
// on their own and leave a half-made wholesaler nobody can finish or
// delete. All of it lives in one database function instead
// (`v2_create_wholesaler`, migration 036) which runs as a single
// transaction: it all works, or nothing happens and you get a reason.
//
// So if you are looking for the creation logic, it is NOT in this file --
// it is in supabase/migrations/036_v2_create_wholesaler_rpc.sql. This
// file only carries the form's answers there and brings the result back.

import { supabase, sbCall } from "../lib/supabase-client.js";
// AC-01: the request queue is scoped to the signed-in wholesaler's own wid,
// in the query as well as in the policy. That needs the session.
import { devAuth } from "../lib/dev-auth.js";

/**
 * Creates a wholesaler, their login, and their category links in one go.
 *
 * @param {object} form
 * @param {string} form.handle      short lowercase name, e.g. "square".
 *                                  Becomes BOTH the wid and the login
 *                                  square@oggiwholesale.app.
 * @param {string} form.brand       required, shown to buyers
 * @param {string} form.password    min 8 characters
 * @param {string} [form.name]      legal/company name; defaults to brand
 * @param {string} [form.industry]
 * @param {string} [form.location]
 * @param {string} [form.phone]     WhatsApp number for sending credentials
 * @param {string} [form.email]
 * @param {string} [form.currency]  defaults to "$"
 * @param {string[]} [form.categories] category NAMES. Any that don't
 *                                  exist yet are created -- that is what
 *                                  makes "type your own" work.
 * @param {string} [form.notes]     owner-only notes
 *
 * @returns {Promise<{ok:boolean, error:string, wid:string|null, loginEmail:string|null}>}
 *
 * NOTE: this never throws for a *business* problem (handle taken, weak
 * password, not the owner). Those come back as `{ok:false, error:"..."}`
 * with a sentence you can show the user directly. It only throws if the
 * network or the database itself is unreachable.
 */
export async function createWholesaler(form) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_create_wholesaler", {
      p_handle: form.handle,
      p_brand: form.brand,
      p_password: form.password,
      p_name: form.name || null,
      p_industry: form.industry || null,
      p_location: form.location || null,
      p_phone: form.phone || null,
      p_email: form.email || null,
      p_currency: form.currency || "$",
      p_categories: form.categories || [],
      p_notes: form.notes || null,
    })
  );

  if (error) {
    return { ok: false, error: error.message || "Could not reach the server", wid: null, loginEmail: null };
  }

  // The function returns a single-row table, so unwrap it. Defensive
  // about shape: a bare object comes back in some client versions.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, error: "The server returned nothing — nothing was created", wid: null, loginEmail: null };
  }

  return {
    ok: !!row.ok,
    error: row.error || "",
    wid: row.wid || null,
    loginEmail: row.login_email || null,
  };
}

/**
 * Every wholesaler currently linked to a category, used by the owner list
 * to show "what do they sell" without a second round trip per row.
 * Returns a Map of wid -> [categoryName, ...].
 */
export async function getCategoriesByWholesaler() {
  const { data } = await sbCall(
    supabase.from("v2_wholesaler_categories").select("wid, v2_categories(name)")
  );
  const byWid = new Map();
  (data || []).forEach((row) => {
    const name = row.v2_categories?.name;
    if (!name) return;
    if (!byWid.has(row.wid)) byWid.set(row.wid, []);
    byWid.get(row.wid).push(name);
  });
  return byWid;
}


// =============================================================================
// THE WHOLESALER'S OWN ACCESS-REQUEST QUEUE                 AC-01, 28 Aug 2026
// =============================================================================
// A buyer asking for access has worked end to end since Batch 14 — the table
// (007), the anon submit RPC (024, rate-limited 30/hour) and the approval
// routine (024) that provisions the CRM row AND a working login in ONE
// transaction. And `v2_approve_signup_request` has ALWAYS authorised the
// wholesaler:
//
//     if not (v2_is_owner() or v2_my_wid() = v_req.wid) then ...
//
// The wholesaler simply had no screen to press it on. The only review UI lived
// in the OWNER console, so in practice OGGI had to approve every buyer for
// every wholesaler by hand. The server was ready; the door had no handle.
//
// These are deliberately NOT re-exports of js/data/owner.js. Two reasons:
// that module is the cross-tenant console and reaches for owner-only reads, and
// its `listSignupRequests` selects with NO wid filter at all, trusting RLS
// alone. That is correct today. It is also one dropped policy away from being a
// cross-tenant list, and this project has already been bitten once by a view
// that quietly bypassed RLS (v2_wholesaler_billing, migration 042). So the wid
// is in the query here as well as in the policy — belt and braces, the way
// every buyer read was rewritten in Batch S.
// =============================================================================

/** Access requests addressed to THIS wholesaler. */
export async function listMySignupRequests(status = "pending") {
  const session = devAuth.getSession();
  const wid = session?.wid;
  if (!wid) return [];
  const { data } = await sbCall(
    supabase.from("v2_signup_requests")
      .select("*")
      .eq("wid", wid)
      .eq("status", status)
      .order("created_at", { ascending: false })
  );
  return data || [];
}

/** How many are waiting — for the badge on the navigation, so a request cannot
 *  sit unseen for a week. Cheap: head-only count, no rows fetched. */
export async function countMyPendingRequests() {
  const session = devAuth.getSession();
  const wid = session?.wid;
  if (!wid) return 0;
  const { count } = await sbCall(
    supabase.from("v2_signup_requests")
      .select("id", { count: "exact", head: true })
      .eq("wid", wid)
      .eq("status", "pending")
  );
  return count || 0;
}

/** Approve — and PROVISION. Deliberately the RPC and never a status update:
 *  a bare flip would mark someone approved while creating no login at all,
 *  which is worse than refusing them, because both sides believe it worked.
 *
 *  The password comes back exactly once and is never recoverable. There is no
 *  email anywhere in this system (migration 024 says so in its own comment),
 *  so whoever approves has to relay it by hand — which is why the screen
 *  renders it rather than toasting it. */
export async function approveMySignupRequest(requestId, username) {
  const { data, error } = await sbCall(supabase.rpc("v2_approve_signup_request", {
    p_id: requestId, p_username: username || null,
  }));
  if (error) return { ok: false, error: error.message };
  const row = data?.[0];
  if (!row?.ok) return { ok: false, error: row?.msg || "Could not approve this request" };
  return { ok: true, username: row.username, tempPassword: row.temp_password, clientId: row.client_id, accountId: row.account_id };
}

/** Decline. A STATE, never a deletion.
 *
 *  Shopify's reject IS "delete the company", and B2B Wave's is "click X to
 *  decline and delete the request". Both lose the history, so the same
 *  applicant can loop forever and nobody can see they were ever here. Keeping
 *  the row means a re-application arrives with its predecessor attached, and
 *  `reviewed_by` answers the question a wholesaler eventually asks out loud:
 *  who let this shop in, or who turned them away? */
export async function rejectMySignupRequest(requestId, reviewerLabel) {
  const session = devAuth.getSession();
  const wid = session?.wid;
  if (!wid) return { error: { message: "No wholesaler session" } };
  return sbCall(supabase.from("v2_signup_requests").update({
    status: "rejected",
    reviewed_by: reviewerLabel || "Wholesaler",
    reviewed_at: new Date().toISOString(),
  }).eq("id", requestId).eq("wid", wid));
}
