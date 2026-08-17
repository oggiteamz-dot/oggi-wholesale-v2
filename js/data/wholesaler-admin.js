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
