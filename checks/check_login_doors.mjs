// =============================================================================
// OGGI Wholesale v2 — GATE: THE LOGIN DOORS                         31 Aug 2026
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Separate links for the wholesalers, the clients and the control centre are
// links a person will paste into WhatsApp, retype by hand, and bookmark. Two
// things must therefore be true, and only one of them is obvious:
//
//   1. The right link opens the right tab.
//   2. EVERY OTHER STRING still opens the ordinary login page.
//
// (2) is the one that will break. A door table is a lookup, and the natural
// way to write a lookup is `DOORS[key]` — which, on a plain object, answers
// `constructor`, `toString` and `__proto__` with something truthy inherited
// from Object.prototype. `#/login/constructor` would then set activeTab to
// `undefined`, and the login screen would render with NO tab selected and no
// panel: a blank card, for a link that was only ever a typo. That is why
// doorFromHash uses hasOwnProperty and why assertion group 3 exists.
//
// WHAT THIS ASSERTS
//   1. Every door in DOORS resolves, and to a tab that login.js actually has.
//   2. A bare "#/login", a non-login hash, empty, null and undefined all
//      return null — meaning "behave exactly as before doors existed".
//   3. Inherited Object properties are NOT doors.
//   4. Case does not matter, because people retype these by hand.
//   5. The buyer and the control centre land on DIFFERENT tabs — the entire
//      point of the change, and the thing a careless edit to DOORS would undo
//      while every other assertion here stayed green.
//
// RUN:  node checks/check_login_doors.mjs
//
// PROVEN TO GO RED — 31 Aug 2026, see checks/GATE-EVIDENCE.md.
// =============================================================================

import { doorFromHash, DOORS } from "../js/lib/login-doors.js";

// The tabs login.js actually renders. Hard-coded on purpose: if someone
// renames a tab there and not here, that is exactly the drift worth failing on.
const REAL_TABS = new Set(["admin", "sales", "buyer"]);

let assertions = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  assertions++;
  if (!cond) failures.push(`${label}${detail ? `\n       ${detail}` : ""}`);
};

// -- 1. every door resolves, to a tab that exists -----------------------------
for (const [key, def] of Object.entries(DOORS)) {
  const got = doorFromHash(`#/login/${key}`);
  ok(`door "${key}" resolves`, got !== null);
  ok(`door "${key}" points at a real tab`, got && REAL_TABS.has(got.tab),
     `got tab ${JSON.stringify(got && got.tab)}`);
  ok(`door "${key}" label is a string or null`,
     def.label === null || typeof def.label === "string");
}

// -- 2. everything else falls back to the ordinary page -----------------------
for (const h of ["#/login", "#/login/", "#/buyer", "#/c/abc123", "", "   ", "#", null, undefined]) {
  ok(`${JSON.stringify(h)} is not a door`, doorFromHash(h) === null,
     `got ${JSON.stringify(doorFromHash(h))}`);
}
ok("an unknown suffix is not a door", doorFromHash("#/login/nonsense") === null);

// -- 3. prototype keys are not doors ------------------------------------------
// Without hasOwnProperty these return functions, and activeTab becomes
// undefined -> a login card with no tab selected and no panel at all.
for (const k of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
  ok(`"${k}" is not a door`, doorFromHash(`#/login/${k}`) === null,
     `got ${JSON.stringify(doorFromHash(`#/login/${k}`))}`);
}

// -- 4. case-insensitive, because people retype these --------------------------
ok("upper case works", doorFromHash("#/LOGIN/BUYER")?.tab === "buyer");
ok("mixed case works", doorFromHash("#/Login/Client")?.tab === "buyer");
ok("no leading hash works", doorFromHash("/login/buyer")?.tab === "buyer");

// -- 5. THE POINT: the audiences are actually separated -----------------------
const buyer = doorFromHash("#/login/client");
const control = doorFromHash("#/login/control");
const seller = doorFromHash("#/login/wholesaler");
ok("client and control centre are different tabs", buyer.tab !== control.tab,
   `both are "${buyer.tab}"`);
ok("client lands on the buyer tab", buyer.tab === "buyer");
ok("control centre lands on the admin tab", control.tab === "admin");
ok("wholesaler lands on the admin tab", seller.tab === "admin");
ok("control centre and wholesaler read differently",
   control.label !== seller.label,
   `both say "${control.label}"`);

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
