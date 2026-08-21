// OGGI Wholesale v2 — inventory defaults (Batch 1, migration 066)
//
// Pure constants. This module imports NOTHING, deliberately.
//
// WHY IT EXISTS AS ITS OWN FILE. These numbers are needed by both
// js/data/inventory-settings.js (which reads and writes the wholesaler's
// saved row) and js/lib/card-facts.js (which colours a product card). Putting
// them in the data module made a js/lib/ file import the Supabase client
// transitively, which inverted the layering -- js/lib/ is pure presentation
// and helpers, js/data/ is I/O -- and immediately broke two checks that load
// card-facts.js in jsdom with no Supabase global. A constant is not I/O and
// should never drag a network client behind it.
//
// These mirror the column DEFAULTs in migration 066 and exist so a form can
// show the value actually in force before anything has been saved. They are
// NOT the source of truth: the database is. If the two ever disagree, the
// database wins and this file is wrong -- which is why
// checks/check_intelligence_zero_setup.sql asserts against the database and
// never against this object.

/** Mirrors the column defaults in migration 066. Display only. */
export const INVENTORY_SETTING_DEFAULTS = Object.freeze({
  velocityWindowDays: 90,   // = the window that used to be hardcoded in the client
  leadTimeDays: 14,         // fallback when a variant has no lead time of its own
  coverTargetDays: 30,      // days of stock to hold after a delivery lands
  safetyDays: 7,            // buffer on top of lead-time demand
  lowStockThreshold: 15,    // = the flat threshold that used to be hardcoded
  breakoutMultiple: 1.5,    // v1's value: outsell the sibling median by this much
  breakoutMinSiblings: 3,   // never call a trend from fewer comparisons than this
  breakoutMinUnits: 5,      // never call a trend from a handful of units
});

/** Human-readable explanation of each knob, shown next to its input. A
 *  setting whose effect the wholesaler cannot predict is a setting they will
 *  not touch, and an untouched setting may as well be hardcoded. */
export const INVENTORY_SETTING_HELP = Object.freeze({
  velocityWindowDays: "How many days of sales history to average when working out how fast something sells. Shorter reacts quicker to a trend; longer is steadier across a quiet week.",
  leadTimeDays: "How long a restock normally takes to arrive. Used only for SKUs that don't have their own lead time set.",
  coverTargetDays: "How many days of stock you want on the shelf once a delivery lands. This is what 'Low' now means: fewer days than this.",
  safetyDays: "Extra buffer on top of the lead time, to absorb a busier-than-usual week.",
  lowStockThreshold: "Flat unit count, used only where there's no sales history to work out days of cover from. Also drives the 'Low stock' badge buyers see.",
  breakoutMultiple: "How far ahead of its other colourways a colour must sell before it's flagged as a breakout. 1.5 = selling half again as fast as the middle colour.",
  breakoutMinSiblings: "Minimum number of other colourways to compare against before calling anything a breakout.",
  breakoutMinUnits: "Minimum units sold before a colour can be called a breakout, so a couple of orders can't look like a trend.",
});

/** Bounds mirroring the CHECK constraints in 066. Enforced here too so the
 *  wholesaler gets a sentence instead of a Postgres error string -- the
 *  server remains the real boundary. */
export const INVENTORY_SETTING_BOUNDS = Object.freeze({
  velocityWindowDays: [7, 730],
  leadTimeDays: [0, 365],
  coverTargetDays: [1, 730],
  safetyDays: [0, 365],
  lowStockThreshold: [0, 100000],
  breakoutMultiple: [1, 100],
  breakoutMinSiblings: [1, 100],
  breakoutMinUnits: [1, 100000],
});
