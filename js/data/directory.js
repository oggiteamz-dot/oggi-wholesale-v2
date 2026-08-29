// =============================================================================
// OGGI Wholesale v2 — THE WHOLESALER DIRECTORY          DR-01..DR-05, 29 Aug 2026
// =============================================================================
// "Browse our wholesalers." Every active wholesaler on OGGI, by name, with the
// categories they sell and whether THIS person is already in, has asked, or
// has not.
//
// ⚠️ THIS SCREEN EXISTED ONCE AND WAS DELETED ON PURPOSE.
//
// js/lib/nav-config.js still carries the note: "Suppliers" was removed on
// 18 Aug 2026 because it led to a grid of every wholesaler on the platform --
// "OGGI's entire client list, shown to every buyer" -- and the planned
// replacement was a marketplace with NO wholesaler names anywhere.
//
// Hadi reversed that on 28 Aug: buyers see wholesalers by name, can search for
// one, and can ask for access. That decision is what makes a marketplace
// possible at all -- an anonymous grid of products cannot answer "who am I
// buying this from", which is the first question a shop asks.
//
// The original objection was real and is answered by DR-05 rather than
// dismissed: a name and a category are visible; PRODUCTS AND PRICES ARE NOT,
// and neither is a product count. Migration 091's own assertions enforce that
// there is nowhere in the answer to put one.
//
// Everything goes through v2_directory_list, a SECURITY DEFINER function that
// re-checks the account id INSIDE itself and returns zero rows -- not an
// error -- for an account it cannot verify. `anon` holds no table privilege
// anywhere near this data (085).
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** Every active wholesaler, with this person's access state for each.
 *  Returns [] when there is no session — never throws at a render path. */
export async function listDirectory({ search = "", limit = 50, offset = 0 } = {}) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return [];
  const { data, error } = await sbCall(
    supabase.rpc("v2_directory_list", {
      p_account_id: accountId,
      p_search: search || null,
      p_limit: limit,
      p_offset: offset,
    })
  );
  if (error) return [];
  return (data || []).map((r) => ({
    wid: r.wid,
    name: r.name,
    brand: r.brand,
    logo: r.logo,
    // Defensive: the function returns text[], but a null here would blow up
    // every .map() downstream, and a directory that throws is a blank screen.
    categories: Array.isArray(r.categories) ? r.categories : [],
    access: r.access || "none",
  }));
}

/** Ask a wholesaler for access (DR-04).
 *  Lands in v2_signup_requests — the SAME queue the wholesaler already
 *  reviews on their Clients screen, not a second one. */
export async function requestAccess(wid, note = null) {
  const accountId = devAuth.getSession()?.accountId;
  if (!accountId) return { ok: false, msg: "Please sign in again." };
  const { data, error } = await sbCall(
    supabase.rpc("v2_directory_request_access", {
      p_account_id: String(accountId),
      p_wid: wid,
      p_note: note,
    })
  );
  if (error) return { ok: false, msg: "Could not send that just now. Try again." };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, msg: row?.msg || "" };
}
