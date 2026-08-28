// =============================================================================
// CHECK: the wholesaler's own access-request queue          AC-01, 28 Aug 2026
// =============================================================================
// THE GAP THIS CLOSES.
//
// A buyer asking a wholesaler for access has worked, end to end, since Batch 14:
//   * v2_signup_requests                      (007) — the table
//   * v2_submit_signup_request                (024) — anon, rate-limited 30/hr
//   * v2_approve_signup_request               (024) — provisions the CRM row AND
//                                                     a working login, in ONE
//                                                     transaction
// and that approve function has ALWAYS authorised the wholesaler:
//     if not (v2_is_owner() or v2_my_wid() = v_req.wid) then ...
//
// The wholesaler simply had no screen to press it on. The only review UI was in
// the OWNER console, so in practice OGGI had to approve every buyer for every
// wholesaler by hand. The server was ready and the door had no handle.
//
// WHAT THIS GATE ASSERTS, and why each one is here:
//   1. the route and the navigation entry exist together — a screen with no
//      way to reach it is the "stranded screen" this project has shipped twice;
//   2. the data layer filters by wid IN THE QUERY as well as relying on RLS.
//      Belt and braces: `listSignupRequests` in owner.js selects with no wid
//      filter at all and trusts the policy. That is correct today, and it is
//      one dropped policy away from being a cross-tenant list;
//   3. approval routes through the RPC, never a bare status flip — a status
//      flip would mark someone approved while creating no login at all, which
//      is worse than refusing them;
//   4. the one-time password is rendered where it cannot be missed, because
//      there is still no email anywhere in this system and that string is
//      never recoverable;
//   5. rejecting asks first and does not delete the record.
//
//   node checks/check_wholesaler_onboarding.mjs
// =============================================================================
import { readFileSync } from "node:fs";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const view = read("js/views/wholesaler.js");
const data = read("js/data/wholesaler-admin.js");
const nav  = read("js/lib/nav-config.js");

// -------------------------------------------------- reachable, not stranded --
ok(/router\.register\(\s*["']\/wholesaler\/requests["']/.test(view),
   "the request queue has a route of its own");
{
  // CORRECTED 28 Aug 2026, and worth reading before changing it back.
  //
  // The first version of this assertion demanded a NAVIGATION ENTRY. That was
  // me encoding my own implementation, not the requirement -- and
  // check_inventory_module.mjs immediately failed, because the wholesaler
  // sidebar is capped at NINE entries on Hadi's instruction ("fifteen was two
  // screens' worth of scrolling"). Raising his cap to fit my screen is exactly
  // the 25 Aug mistake: writing a gate to match my design instead of his
  // requirement.
  //
  // The real requirement is REACHABILITY -- no stranded screens. So the queue
  // is reached from the Clients screen, which is where it belongs anyway
  // (approving a request IS creating a client), and this asserts that.
  const clients = (view.match(/async function clientsView[\s\S]*?\n}\n/) || [""])[0];
  ok(clients.length > 0 && /\/wholesaler\/requests/.test(clients),
     "and the Clients screen is a way in to it — a screen you cannot reach is a screen that does not exist");
  ok(clients.length > 0 && /countMyPendingRequests/.test(clients),
     "and it shows how many are waiting, so a request cannot sit unseen for a week");
  const navEntries = (nav.match(/wholesaler:\s*\[([\s\S]*?)\n\s*\]/) || [])[1] || "";
  const paths = (navEntries.match(/path:\s*"/g) || []).length;
  ok(paths === 9,
     `and the wholesaler sidebar is still nine entries (got ${paths}) — this screen did NOT buy itself a tenth`);
}

// ------------------------------------------------------ scoped in the QUERY --
ok(/listMySignupRequests/.test(data),
   "the wholesaler has its own request-listing function rather than borrowing the owner console's");
{
  const fn = (data.match(/export async function listMySignupRequests[\s\S]*?\n}/) || [""])[0];
  ok(/\.eq\(\s*["']wid["']/.test(fn),
     "and it filters by wid IN THE QUERY, not only through RLS — one dropped policy must not turn this into a cross-tenant list");
  ok(/\.eq\(\s*["']status["']/.test(fn),
     "and by status, so a handled request does not reappear in the queue");
}

// --------------------------------------- approval provisions, never a flip --
{
  const fn = (data.match(/export async function approveMySignupRequest[\s\S]*?\n}/) || [""])[0];
  ok(/rpc\(\s*["']v2_approve_signup_request["']/.test(fn),
     "approving calls v2_approve_signup_request, which creates the client AND the login in one transaction");
  // `fn` is "" until the function exists, and !/x/.test("") is TRUE — so this
  // negative assertion would go GREEN on a file that has nothing in it at all.
  // Every negative below is anchored on the thing existing first. Same trap that
  // was caught in check_buyer_product_card.mjs this morning.
  ok(fn.length > 0 && !/\.update\(\s*\{[^}]*status/.test(fn),
     "and never writes status directly — a bare flip would mark someone approved with no login to show for it");
}

// ------------------------------------------- the password is shown, not toasted --
{
  const v = (view.match(/async function requestsView[\s\S]*?\n}\n/) || [""])[0];
  ok(v.length > 400, "the screen itself exists");
  ok(/tempPassword/.test(v),
     "the one-time password is rendered on the screen");
  ok(v.length > 400 && !/toast\(\s*[`"'][^`"']*\$\{?\s*(result\.)?tempPassword/.test(v),
     "and NOT inside a toast — a toast auto-dismisses, and this string is never recoverable");
  ok(/not be shown again|only time|never be shown/i.test(v),
     "and the screen says out loud that it will not be shown again");
  ok(/confirmAction|ask\(/.test(v),
     "rejecting asks for confirmation first");
  ok(v.length > 400 && !/\.delete\(\)/.test(v),
     "and nothing on this screen deletes a request — reject is a STATE, so the person can apply again and we can see they were here before");
}

// ------------------------------------------------ the requester is told --
ok(/reviewed_by|reviewerLabel/.test(data),
   "who handled a request is recorded, for the moment a wholesaler asks who let this shop in");

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
