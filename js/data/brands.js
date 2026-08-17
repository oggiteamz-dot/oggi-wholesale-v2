// =============================================================================
// OGGI Wholesale v2 — WHOLESALER BRANDS (data layer)
// =============================================================================
//
// WHAT PROBLEM THIS SOLVES
// ------------------------
// A wholesaler is not one label. A real one on this platform carries Nike,
// Dsquared, Emporio and four more under a single account. Until now
// v2_wholesalers had exactly one `brand` column, so six of those seven were
// invisible to the system: you could not search on them, filter on them, or
// show a buyer which houses a supplier actually stocks.
//
// migration 038 added `v2_wholesaler_brands` (wid, name, is_primary,
// sort_order) and the `v2_set_wholesaler_brands` RPC. Both have been live
// since 17 Aug. What was missing was any way to READ or WRITE them from the
// app -- the data layer for the feature did not exist, which is why the box
// never appeared on the form. This file is that missing half.
//
// WHY THE WRITE IS AN RPC AND NOT AN UPSERT FROM HERE
// ---------------------------------------------------
// Setting the brand list is a REPLACE, not an append: the list the owner sees
// on screen is the list that should exist afterwards, including the removals.
// Done from the browser that is a delete-then-insert, two round trips, and a
// dropped connection between them leaves a wholesaler with NO brands at all.
// v2_set_wholesaler_brands does both inside one transaction, so the list is
// either fully replaced or untouched. Same reasoning as v2_create_wholesaler.
//
// `brand` on v2_wholesalers is deliberately NOT replaced by this table. It
// stays the primary display name -- the one on the login screen and the
// invoice. This is the list of houses they carry, which is a different fact.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * Every brand a wholesaler carries, in the order the owner arranged them.
 *
 * Ordered by sort_order then name so the list is stable between loads -- an
 * unordered list that reshuffles on every refresh reads as a bug even when
 * the data is correct.
 *
 * @param {string} wid
 * @returns {Promise<Array<{id:string,name:string,isPrimary:boolean,sortOrder:number}>>}
 */
export async function listBrands(wid) {
  if (!wid) return [];
  const { data } = await sbCall(
    supabase
      .from("v2_wholesaler_brands")
      .select("id, name, is_primary, sort_order")
      .eq("wid", wid)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
  );
  return (data || []).map((r) => ({
    id: r.id,
    name: r.name,
    isPrimary: !!r.is_primary,
    sortOrder: r.sort_order ?? 0,
  }));
}

/**
 * Brands for MANY wholesalers in one round trip.
 *
 * The owner's wholesaler list shows brands per row. Calling listBrands() once
 * per row is the classic N+1: 40 wholesalers is 40 requests, which on a Beirut
 * connection is the difference between a list that appears and a list that
 * crawls in. One query, grouped here.
 *
 * @param {string[]} wids
 * @returns {Promise<Map<string, string[]>>} wid -> brand names
 */
export async function listBrandsByWholesaler(wids = []) {
  const byWid = new Map();
  if (!wids.length) return byWid;
  const { data } = await sbCall(
    supabase
      .from("v2_wholesaler_brands")
      .select("wid, name, sort_order")
      .in("wid", wids)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
  );
  (data || []).forEach((r) => {
    if (!byWid.has(r.wid)) byWid.set(r.wid, []);
    byWid.get(r.wid).push(r.name);
  });
  return byWid;
}

/**
 * Replaces a wholesaler's entire brand list, atomically.
 *
 * Pass the full list you want to exist afterwards -- this is not an append.
 * An empty array is a legitimate instruction meaning "they carry no named
 * brands", and is passed through rather than being treated as a mistake.
 *
 * Duplicates are removed case-insensitively before sending, keeping the FIRST
 * spelling the user typed. The database has its own constraint, but failing
 * here gives the owner a clean list instead of a constraint error mentioning
 * a table name they have never heard of.
 *
 * @param {string} wid
 * @param {string[]} names
 * @returns {Promise<{ok:boolean, error?:string, count?:number}>}
 */
export async function setBrands(wid, names = []) {
  if (!wid) return { ok: false, error: "No wholesaler was given." };

  const seen = new Set();
  const clean = [];
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(name);
  }

  const { data, error } = await sbCall(
    supabase.rpc("v2_set_wholesaler_brands", { p_wid: wid, p_brands: clean })
  );
  if (error) {
    return { ok: false, error: error.message || "Could not reach the server" };
  }
  // The RPC may return a row, a count, or nothing depending on how it was
  // declared. Treat "no error" as success and report the count we sent, so a
  // future change to its return shape cannot silently turn a working save
  // into a reported failure.
  const row = Array.isArray(data) ? data[0] : data;
  if (row && typeof row === "object" && row.ok === false) {
    return { ok: false, error: row.error || row.msg || "Could not save the brands" };
  }
  return { ok: true, count: clean.length };
}
