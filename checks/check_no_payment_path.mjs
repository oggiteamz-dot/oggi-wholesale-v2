// =============================================================================
// CHECK: no money is ever taken through this app          (CR-0001, 24 Aug 2026)
// =============================================================================
//
// Hadi, 24 Aug 2026: "we're not going to be selling anything here. This is just
// an ordering system. No money will be paid through this app at the moment."
//
// That is not a new decision -- migration 060 already records it in his words:
// "the VAT completely because we don't do anything with money." A buyer picks
// what they want, submits an ORDER, and the wholesaler invoices however they
// already invoice.
//
// WHY A GATE FOR SOMETHING THAT IS ALREADY TRUE
// ---------------------------------------------
// Because it is true by absence, and absence is the one thing nothing in this
// repo defends. Every other rule here is enforced by code that exists; this
// one is enforced by code that does not. A payment step would arrive as an
// addition -- a "Pay now" button, a card field, an SDK -- and nothing would
// object.
//
// The VAT decision nearly eroded exactly this way: it was made, written down,
// and then columns and labels kept appearing next to it until someone checked.
//
// WHAT IS DELIBERATELY ALLOWED
// ----------------------------
// PRICES. A wholesale catalog is a price list. Hadi asked for "the price per a
// single unit" on the buyer's card in the same conversation, and a buyer must
// know what they are committing to before submitting an order. Showing 9.50 a
// piece is not selling; charging for it would be.
//
// "Payment terms" on a SUPPLIER record is also allowed: that is the
// wholesaler's own note about their own supplier, wholesaler-only (migration
// 050 closed suppliers to anon entirely), and it is a memo rather than a
// transaction.
//
//   node checks/check_no_payment_path.mjs
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const JS = fileURLToPath(new URL("../js/", import.meta.url));
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

function files(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) { if (n !== "vendor") files(f, out); }
    else if (n.endsWith(".js")) out.push(f);
  }
  return out;
}

/** Strip comments and string-free prose so this file's own explanation, and
 *  any honest note about NOT taking payment, cannot trip it. Same reasoning as
 *  check_cross_module_imports: prose must not look like a call site. */
function code(src) {
  const nl = (s) => s.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, nl).replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ");
}

// Each entry: a pattern, and what it would mean if it appeared.
const BANNED = [
  [/\bStripe\b/i,                    "a Stripe integration"],
  [/\bbraintree\b|\badyen\b|\bcheckout\.com\b/i, "a payment processor SDK"],
  [/\bpaypal\b/i,                    "a PayPal integration"],
  [/card_number|cardNumber|\bcvv\b|\bcvc\b|expiry_month|expiryMonth/i, "a card-entry field"],
  [/payment_intent|paymentIntent|\bcharge\(|createCharge/i, "a charge being created"],
  // Deliberately NOT the bare word "checkout". This codebase uses "at
  // checkout" to mean "at the moment an order is submitted" -- e.g. "Enforced
  // by the server at checkout" -- which is accurate and has nothing to do with
  // money. Banning it produced two false positives on the first run, and a
  // gate that cries wolf is a gate someone switches off. What is banned is a
  // phrase that PROMISES A PAYMENT ACTION.
  [/\b(pay now|buy now|proceed to payment|enter your card|add payment method|pay with card|complete payment)\b/i,
                                     "a label that promises a payment step"],
];

const found = [];
for (const f of files(JS)) {
  const src = code(readFileSync(f, "utf8"));
  for (const [re, what] of BANNED) {
    const m = src.match(re);
    if (m) found.push(`${relative(JS, f)} — ${what} (matched "${m[0].trim().slice(0, 40)}")`);
  }
}
ok(found.length === 0,
   found.length
     ? `a payment path has entered the app: ${found.join("; ")}`
     : "no payment processor, card field, charge or 'pay now' anywhere in js/ — this stays an ordering system");

// The buyer's final action must say what it does. "Checkout" implies money
// changing hands and would be a promise the app does not keep.
const buyer = readFileSync(new URL("../js/views/buyer.js", import.meta.url), "utf8");
ok(/submitBtn\.textContent\s*=\s*"Submit order"/.test(buyer),
   'the buyer\'s final button says "Submit order" — not "Checkout", not "Pay". It sends an order to the wholesaler, and the label should not suggest otherwise');

// Prices are REQUIRED, not banned. Asserted so that a future tidy-up of this
// gate cannot quietly turn into "remove the prices too".
ok(/per piece/.test(readFileSync(new URL("../js/components/product-card.js", import.meta.url), "utf8")),
   "the buyer still sees a price per piece — a price list is not a till, and a buyer must know what they are committing to");

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
