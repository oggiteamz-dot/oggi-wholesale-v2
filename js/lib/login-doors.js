// =============================================================================
// OGGI Wholesale v2 — ONE LOGIN SCREEN, FOUR FRONT DOORS            31 Aug 2026
// =============================================================================
// Hadi asked for separate links for the wholesalers, the clients and the
// control centre. Everyone was sent to `#/login`, which opens on the
// "Owner / Wholesaler" tab — so a BUYER given that link lands on a form asking
// for an email and password they have never had, and the first thing the
// product teaches them is that they are in the wrong place.
//
// The three audiences are still ONE screen with the same three tabs. What a
// door changes is which tab is already selected on arrival, and a line naming
// where you are. NOTHING IS HIDDEN — every tab stays one click away, because a
// buyer who arrives on the wholesaler link must be able to get out of it.
//
//   #/login                 the admin tab, exactly as before
//   #/login/control         the control centre (owner)
//   #/login/wholesaler      a wholesaler signing in to their own shop
//   #/login/client, /buyer  a shop buying from a wholesaler
//   #/login/sales           a rep
//
// WHY THIS IS ITS OWN MODULE, and not ten lines inside login.js:
// login.js imports dev-auth -> supabase-client, which touches `window` at
// module load. A Node gate cannot import it, so anything defined in there can
// only be tested by grepping the source, which tests the spelling of the code
// rather than its behaviour. This file imports nothing, so
// checks/check_login_doors.mjs runs the REAL function.
// =============================================================================

/** tab: which of login.js's TABS to select. label: the line shown above the
 *  tabs, or null to leave the screen exactly as it was before doors existed. */
export const DOORS = {
  control:    { tab: "admin", label: "Control centre" },
  owner:      { tab: "admin", label: "Control centre" },
  admin:      { tab: "admin", label: null },
  wholesaler: { tab: "admin", label: "Wholesaler sign-in" },
  seller:     { tab: "admin", label: "Wholesaler sign-in" },
  sales:      { tab: "sales", label: "Sales team sign-in" },
  buyer:      { tab: "buyer", label: "Buyer sign-in" },
  client:     { tab: "buyer", label: "Buyer sign-in" },
};

/**
 * Which door a hash names.
 *
 * Returns null for a bare `#/login`, for an unrecognised suffix, and for
 * anything that is not a login URL at all. Null means "behave exactly as this
 * screen behaved before doors existed" — so a typo'd or stale link degrades to
 * the ordinary login page rather than to an error, which matters because these
 * links get pasted into WhatsApp and retyped by hand.
 *
 * @param {string} hash  e.g. "#/login/buyer"
 * @returns {{tab: string, label: string|null}|null}
 */
export function doorFromHash(hash) {
  const m = /^#?\/?login\/([a-z-]+)/i.exec(String(hash == null ? "" : hash).trim());
  if (!m) return null;
  return Object.prototype.hasOwnProperty.call(DOORS, m[1].toLowerCase())
    ? DOORS[m[1].toLowerCase()]
    : null;
}
