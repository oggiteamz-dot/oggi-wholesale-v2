// =============================================================================
// OGGI Wholesale v2 — LOCATIONS (data layer)
// =============================================================================
//
// A location is a physical place stock sits: a warehouse, a shop, a container.
// v2_inventory_balances has been keyed on (variant_id, location_id) since
// migration 001, so stock has ALWAYS been per-location in the data. What was
// missing until 18 Aug 2026 is that nothing could create a second one, and
// nothing could move stock between two -- the regression ledger's item #17
// put it exactly right: "the only transfer tokens in the entire repo are the
// enum values on one line. An enum value is not a feature."
//
// EVERY WRITE GOES THROUGH AN RPC, AND THAT IS THE POINT
// -----------------------------------------------------
// Migration 047 revoked INSERT/UPDATE/DELETE on v2_locations from both browser
// roles. Not tidiness -- the rules below have to hold no matter which screen is
// calling:
//
//   * a wholesaler must always have at least one active location (migration
//     043 exists because one did not, and could not receive a single unit)
//   * exactly one default, enforced by a partial unique index
//   * stock never moves out of a location that does not have it AVAILABLE
//
// Enforcing that in JavaScript means enforcing it once per screen and hoping.
// So this file cannot write the table even if it wanted to.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Turns a Postgres error into a sentence an operator can act on. */
function readable(error, fallback) {
  const msg = error?.message || "";
  if (/different wholesaler/i.test(msg)) {
    return "That belongs to a different wholesaler. Sign out and back in if this is your own.";
  }
  if (/fetch|network/i.test(msg)) return "Could not reach the server. Check your connection.";
  return msg || fallback;
}

/** One row per RPC that returns `table(ok, error, ...)`. */
function unwrap(data) {
  return (Array.isArray(data) ? data[0] : data) || {};
}

export async function listLocations(wid, { includeArchived = false } = {}) {
  let q = supabase.from("v2_locations")
    .select("id, wid, name, is_default, archived, created_at")
    .eq("wid", wid)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  if (!includeArchived) q = q.eq("archived", false);

  const { data, error } = await sbCall(q);
  if (error) return { ok: false, error: readable(error, "Could not load your locations."), rows: [] };
  return {
    ok: true,
    rows: (data || []).map((l) => ({
      id: l.id, wid: l.wid, name: l.name,
      isDefault: !!l.is_default, archived: !!l.archived, createdAt: l.created_at,
    })),
  };
}

/** How many units sit at each location, so the screen can show it and so
 *  "you can't archive this, it still holds stock" is visible BEFORE the
 *  operator tries. Refusing at the moment of the click is correct but late. */
export async function locationStockTotals(wid) {
  const { data: products } = await sbCall(
    supabase.from("v2_products").select("id").eq("wid", wid)
  );
  const ids = (products || []).map((p) => p.id);
  if (!ids.length) return new Map();

  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("id").in("product_id", ids)
  );
  const vids = (variants || []).map((v) => v.id);
  if (!vids.length) return new Map();

  const { data: balances } = await sbCall(
    // Live view, not the table -- its qty_reserved ignores expires_at, so the
    // per-location "reserved" figure counted abandoned carts forever (064).
    supabase.from("v2_inventory_balances_live").select("location_id, qty_on_hand, qty_reserved").in("variant_id", vids)
  );
  const byLocation = new Map();
  (balances || []).forEach((b) => {
    const cur = byLocation.get(b.location_id) || { onHand: 0, reserved: 0, variants: 0 };
    cur.onHand += Number(b.qty_on_hand || 0);
    cur.reserved += Number(b.qty_reserved || 0);
    if (Number(b.qty_on_hand || 0) > 0) cur.variants += 1;
    byLocation.set(b.location_id, cur);
  });
  return byLocation;
}

export async function createLocation(wid, name) {
  const { data, error } = await sbCall(supabase.rpc("v2_create_location", { p_wid: wid, p_name: name }));
  if (error) return { ok: false, error: readable(error, "Could not create the location.") };
  const r = unwrap(data);
  return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error || "Could not create the location." };
}

export async function renameLocation(locationId, name) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_rename_location", { p_location_id: locationId, p_name: name })
  );
  if (error) return { ok: false, error: readable(error, "Could not rename the location.") };
  const r = unwrap(data);
  return r.ok ? { ok: true } : { ok: false, error: r.error || "Could not rename the location." };
}

export async function setDefaultLocation(locationId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_default_location", { p_location_id: locationId })
  );
  if (error) return { ok: false, error: readable(error, "Could not set the default.") };
  const r = unwrap(data);
  return r.ok ? { ok: true } : { ok: false, error: r.error || "Could not set the default." };
}

export async function archiveLocation(locationId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_archive_location", { p_location_id: locationId })
  );
  if (error) return { ok: false, error: readable(error, "Could not archive the location.") };
  const r = unwrap(data);
  return r.ok ? { ok: true } : { ok: false, error: r.error || "Could not archive the location." };
}

/**
 * Moves stock between two of this wholesaler's locations.
 *
 * The database checks AVAILABLE (on hand minus reserved), not on hand --
 * reserved units are promised to a buyer with an open cart, and moving them
 * would leave that promise pointing at an empty shelf. When it refuses it says
 * how many are actually movable and why, so the message is passed through
 * unchanged rather than replaced with something vaguer.
 */
export async function transferStock({ variantId, fromLocationId, toLocationId, qty, note = null }) {
  const { data, error } = await sbCall(supabase.rpc("v2_transfer_stock", {
    p_variant_id: variantId,
    p_from_location: fromLocationId,
    p_to_location: toLocationId,
    p_qty: Number(qty) || 0,
    p_note: note,
  }));
  if (error) return { ok: false, error: readable(error, "The transfer did not go through.") };
  const r = unwrap(data);
  if (!r.ok) return { ok: false, error: r.error || "The transfer did not go through." };
  return { ok: true, fromOnHand: Number(r.from_on_hand ?? 0), toOnHand: Number(r.to_on_hand ?? 0) };
}
