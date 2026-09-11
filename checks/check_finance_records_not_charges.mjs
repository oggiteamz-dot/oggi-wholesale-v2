// =============================================================================
// GATE — the finance desk RECORDS money; it never TAKES it   Block 7, 11 Sep 2026
// =============================================================================
// HADI, 24 August 2026 (checks/check_no_payment_path.mjs):
//   "we're not going to be selling anything here. This is just an ordering
//    system. NO MONEY WILL BE PAID THROUGH THIS APP at the moment."
//
// Block 7 adds a finance desk that types in amounts. That is the closest this
// product has ever come to the line, so the line gets its own gate.
//
// ==== WHAT IS ALLOWED, AND WHY ==============================================
//
// A row in v2_money_received is A RECORD OF SOMETHING THAT ALREADY HAPPENED IN
// A BANK. The finance manager writes down that the shop transferred 4,200 on
// the 9th, after it arrived. check_no_payment_path.mjs already permits exactly
// this category -- it says "payment terms on a SUPPLIER record is also allowed:
// ... a memo rather than a transaction". This is bookkeeping, not a till.
//
// ==== ⛔ AND THE LINE, WHICH IS NOT A MATTER OF TASTE ========================
//
//   1. NO BUYER MAY EVER REACH IT. Not the table, not the function, not a
//      screen. A buyer who can record their own payment has been handed a "pay"
//      button with extra steps. This gate walks the buyer's ENTIRE import graph
//      and asserts the money path is not in it -- which is stronger than
//      grepping the buyer's own file, because reachability is what matters and
//      an import two modules deep is still reachable.
//
//   2. THE WORDS ON THE SCREEN MUST NOT PROMISE A PAYMENT. "Record money
//      received" is what it does. "Take payment" would be a promise the app
//      does not keep, and the buyer-side equivalent of that promise is the one
//      thing check_no_payment_path has banned since August.
//
//   3. A MISSING COST STAYS MISSING. Not strictly about payments, but it lives
//      on the same screen and it is the same failure: reporting a number that
//      flatters us because the honest answer was inconvenient. Null cost is
//      "we do not know", never 0.00 and never 100% margin.
//
//   node checks/check_finance_records_not_charges.mjs
// =============================================================================
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const JS = fileURLToPath(new URL("../js/", import.meta.url));
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
const read = (p) => readFileSync(p, "utf8");

// ============================== 1. ⛔ THE BUYER'S WHOLE IMPORT GRAPH =========
{
  // Every entry point a person without a staff login can reach. The public
  // routes are included deliberately: /o/:token and /c/:token render for
  // somebody with no session at all, which makes them the most exposed files
  // in the product.
  const BUYER_ENTRY = [
    "views/buyer.js", "views/marketplace.js", "views/search.js",
    "views/directory.js", "views/public-order.js", "views/join.js",
    "views/login.js",
  ];
  // ⚠️ NARROWED AFTER THE FIRST RUN, AND THE FIRST RUN WAS RIGHT TO COMPLAIN.
  //
  // data/staff-auth.js started in this list and the gate went red naming
  // js/views/login.js -- which imports staffLogin, because the login screen is
  // where a desk signs in and the login screen is reachable by everyone. That
  // is correct and must stay.
  //
  // So the claim is made precise rather than loosened: what a buyer must not be
  // able to reach is THE MONEY, and the door is not the money. staff-auth.js
  // gets its own, tighter assertion below -- that the only thing reachable from
  // a buyer entry point is the login itself, and never the hiring functions.
  const MONEY_PATH = ["data/desk.js", "data/desk-admin.js"];

  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const file = resolve(JS, rel);
    if (!existsSync(file)) return;
    const src = strip(read(file));
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = relative(JS, resolve(dirname(file), m[1]));
      walk(target.split("\\").join("/"));
    }
  };
  BUYER_ENTRY.forEach(walk);

  const reached = MONEY_PATH.filter((p) => seen.has(p));
  ok(reached.length === 0,
     `⛔ nothing a buyer can open reaches the money path — walked ${seen.size} modules from ${BUYER_ENTRY.length} entry points`
     + (reached.length ? ` — REACHED: ${reached.join(", ")}` : ""));

  // And the same for the raw RPC names, in case somebody calls one directly
  // rather than through the data layer.
  const offenders = [];
  for (const rel of seen) {
    const file = resolve(JS, rel);
    if (!existsSync(file)) continue;
    const src = strip(read(file));
    if (/v2_money_received|v2_record_money_received|v2_finance_/.test(src)) offenders.push(rel);
  }
  ok(offenders.length === 0,
     `⛔ and no buyer-reachable module names a finance RPC directly`
     + (offenders.length ? ` — ${offenders.join(", ")}` : ""));

  // ⭐ THE DOOR IS REACHABLE; WHAT IS BEHIND IT IS NOT.
  // staff-auth.js is imported by login.js on purpose. What must never be
  // reachable from anything a buyer opens is the part of it that HIRES people
  // and lists them -- those run as `authenticated` and would be refused by the
  // server anyway, but a button that always fails is still a button that should
  // not be there.
  const HIRING = ["createStaffAccount", "setStaffActive", "listStaffAccounts"];
  const hiringOffenders = [];
  for (const rel of seen) {
    const file = resolve(JS, rel);
    if (!existsSync(file)) continue;
    if (rel === "data/staff-auth.js") continue;     // it DEFINES them
    const src = strip(read(file));
    if (HIRING.some((fn) => new RegExp(`\\b${fn}\\b`).test(src))) hiringOffenders.push(rel);
  }
  ok(hiringOffenders.length === 0,
     `⛔ and nothing a buyer can open can hire, list or suspend staff`
     + (hiringOffenders.length ? ` — ${hiringOffenders.join(", ")}` : ""));

  ok(seen.has("data/staff-auth.js"),
     "the staff DOOR is reachable from the login screen, which is the point of a door");
}

// ================================ 2. THE WORDS ON THE FINANCE SCREEN ========
{
  const fin = strip(read(resolve(JS, "views/finance.js")));

  ok(/Record money received/.test(fin),
     'the button says "Record money received" — what it does');
  ok(!/\b(take payment|pay now|charge (the )?(card|customer)|collect payment|process payment)\b/i.test(fin),
     "⛔ and nothing on the finance screen promises a payment action");
  // The same bans check_no_payment_path applies to all of js/, asserted again
  // here so this file fails on its own terms rather than only in the suite.
  for (const [re, what] of [
    [/\bStripe\b|\bbraintree\b|\badyen\b|\bpaypal\b/i, "a payment processor"],
    [/card_number|cardNumber|\bcvv\b|\bcvc\b|expiry_month/i, "a card-entry field"],
    [/payment_intent|paymentIntent|createCharge/i, "a charge being created"],
  ]) ok(!re.test(fin), `⛔ no ${what} on the finance screen`);

  ok(/does not take payments|OGGI does not take payments/i.test(fin),
     "⭐ and the screen SAYS SO to the person using it, rather than only to whoever reads the source");
}

// ====================== 3. A MISSING COST IS NOT A FLATTERING ZERO ==========
{
  const fin = strip(read(resolve(JS, "views/finance.js")));
  const desk = strip(read(resolve(JS, "data/desk.js")));

  ok(/lineCost == null \? "—"/.test(fin),
     '⭐ a line with no cost shows an em dash, not 0.00 — "we do not know what this cost" is not "it was free"');
  ok(/lineMargin == null \? "—"/.test(fin),
     "and so does its margin");
  ok(/linesCosted < head\.linesTotal/.test(fin),
     "⭐ a PARTLY costed order says so on the screen rather than showing a margin that covers only some of it");
  ok(/head\.linesCosted === 0/.test(fin),
     "and an order with no costs at all shows no margin rather than a confident zero");

  // The data layer must not coerce the nulls away before the view ever sees them.
  ok(!/unitCost: Number\(r\.unit_cost\) \|\| 0/.test(desk) && !/lineCost: Number\(r\.line_cost\) \|\| 0/.test(desk),
     "⭐ and the data layer does not `|| 0` the nulls away before the screen can tell the difference");
}

// =============================================================================
console.log(`\n  ${pass.length} passed, ${fail.length} failed\n`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { console.log("\n  FINANCE LINE RED\n"); process.exit(1); }
console.log("\n  FINANCE LINE GREEN\n");
