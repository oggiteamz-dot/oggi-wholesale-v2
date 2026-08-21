// OGGI Wholesale v2 — inventory settings (Batch 1, migration 066)
//
// The tuning knobs behind Inventory Intelligence: how far back to measure
// demand, how long a restock takes, how much cover to hold, and how loud the
// breakout alert should be.
//
// THE CONTRACT THAT MATTERS: a wholesaler with NO settings row gets exactly
// the same answers as one with a row of defaults. The server coalesces to
// these same numbers (v2_inventory_signals_for), so this file never has to
// create a row just to make a screen work. Configuration tunes the signal;
// it is never required to create one.
//
// The defaults are duplicated here ONLY so the settings form can show the
// value that is actually in force before the wholesaler has saved anything.
// They are not the source of truth -- the database is. If the two ever
// disagree, the database wins and the form is wrong, which is why
// checks/check_intelligence_zero_setup.sql asserts against the database and
// not against this object.

import { supabase, sbCall } from "../lib/supabase-client.js";
import { INVENTORY_SETTING_DEFAULTS, INVENTORY_SETTING_HELP, INVENTORY_SETTING_BOUNDS } from "../lib/inventory-defaults.js";

// Re-exported so callers that already import these from this module keep
// working; they are defined in js/lib/inventory-defaults.js because a pure
// constant must not pull the Supabase client in behind it.
export { INVENTORY_SETTING_DEFAULTS, INVENTORY_SETTING_HELP, INVENTORY_SETTING_BOUNDS };

const COLUMN_BY_KEY = {
  velocityWindowDays: "velocity_window_days",
  leadTimeDays: "lead_time_days",
  coverTargetDays: "cover_target_days",
  safetyDays: "safety_days",
  lowStockThreshold: "low_stock_threshold",
  breakoutMultiple: "breakout_multiple",
  breakoutMinSiblings: "breakout_min_siblings",
  breakoutMinUnits: "breakout_min_units",
};

/**
 * The settings actually in force for this wholesaler.
 * Returns `{ settings, isDefault }`. `isDefault` is true when no row exists,
 * so the screen can say "these are the defaults" rather than implying the
 * wholesaler chose them.
 */
export async function getInventorySettings(wid) {
  const { data, error } = await sbCall(
    supabase.from("v2_inventory_settings").select("*").eq("wid", wid).maybeSingle()
  );
  if (error || !data) {
    return { settings: { ...INVENTORY_SETTING_DEFAULTS }, isDefault: true, error: error || null };
  }
  const settings = {};
  Object.entries(COLUMN_BY_KEY).forEach(([key, column]) => {
    settings[key] = Number(data[column]);
  });
  return { settings, isDefault: false, error: null };
}

/** Validates one value against the same bounds the database enforces.
 *  Returns null when fine, or a plain-English message. */
export function validateInventorySetting(key, value) {
  const bounds = INVENTORY_SETTING_BOUNDS[key];
  if (!bounds) return `Unknown setting "${key}"`;
  if (value == null || Number.isNaN(Number(value))) return "Enter a number";
  const n = Number(value);
  if (n < bounds[0] || n > bounds[1]) return `Must be between ${bounds[0]} and ${bounds[1]}`;
  return null;
}

/**
 * Saves settings. Upserts, so the first save creates the row and later ones
 * update it -- the wholesaler never has to know a row did or did not exist.
 * Only keys present in `partial` are written, so one form field cannot
 * silently reset the others.
 */
export async function saveInventorySettings(wid, partial) {
  const row = { wid, updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(partial)) {
    const column = COLUMN_BY_KEY[key];
    if (!column) continue;
    const problem = validateInventorySetting(key, value);
    if (problem) return { error: new Error(`${key}: ${problem}`) };
    row[column] = Number(value);
  }
  const { error } = await sbCall(
    supabase.from("v2_inventory_settings").upsert(row, { onConflict: "wid" })
  );
  return { error };
}

/**
 * Restores defaults by deleting the row rather than writing the default
 * values into it. Deleting means "I have no opinion", so this wholesaler
 * keeps tracking any future change to the platform defaults. Writing the
 * numbers in would freeze today's defaults forever under the appearance of
 * having reset them.
 */
export async function resetInventorySettings(wid) {
  const { error } = await sbCall(
    supabase.from("v2_inventory_settings").delete().eq("wid", wid)
  );
  return { error };
}
