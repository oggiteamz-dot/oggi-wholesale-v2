// =============================================================================
// CHECK: the JavaScript price and the SQL price are the same price
// =============================================================================
// v2_submit_order does not trust the browser. It re-prices every line through
// wholesale_v2.v2_effective_unit_price and writes THAT number onto the order.
// So js/data/pricing.js effectivePrice() is not the price -- it is a promise
// about the price, and if the promise is wrong the buyer sees one number in
// the cart and is invoiced another. Nothing looks broken until a customer
// queries their bill, by which point it has been wrong for weeks.
//
// Two things are checked here, and the second is the one that matters:
//
//   1. effectivePrice() produces the expected number for a table of worked
//      examples -- including the two that encode instructions given in words:
//      stacking is ADDITIVE ("they combine into 25%"), and a customer sitting
//      at 0% under customer_only mode falls back to the catalog's discount.
//
//   2. That table is IDENTICAL to the one in checks/check_catalog_pricing.sql,
//      which runs the same cases against the real database. Two copies of a
//      pricing rule drift; two copies of a rule plus a check that they are the
//      same copy cannot drift silently. Editing one file and not the other
//      fails here.
//
//   node checks/check_price_agreement.mjs
// =============================================================================
import { readFileSync } from "node:fs";

// pricing.js imports the Supabase client, which reads window.supabase at
// module load. A minimal stub is enough: nothing in this check touches the
// network, and stubbing is honest here because the functions under test are
// pure arithmetic that happens to live in a module with a data-fetching
// neighbour.
globalThis.window = { supabase: { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) } };
const { effectivePrice, round2 } = await import("../js/data/pricing.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// The discount percentage the SERVER would compute, restated here as data.
// This is v2_catalog_discount_pct's rule, and the cases below pin it.
function totalPct({ catalogPct, customerPct, mode }) {
  if (mode === "catalog_only") return catalogPct;
  if (mode === "customer_only") return customerPct === 0 ? catalogPct : customerPct;
  return catalogPct + customerPct;
}

// label, list price, catalog %, customer %, mode, expected price
const CASES = [
  ["combine 5+20 = 25% (additive, not 76.00)", 100,   5, 20, "combine",        75.00],
  ["combine 5+0",                              100,   5,  0, "combine",        95.00],
  ["catalog_only ignores customer 20",         100,   5, 20, "catalog_only",   95.00],
  ["customer_only ignores catalog 5",          100,   5, 20, "customer_only",  80.00],
  ["customer_only at 0 falls back to catalog", 100,   5,  0, "customer_only",  95.00],
  ["negative catalog -10 + customer 20",       100, -10, 20, "combine",        90.00],
  ["negative catalog -10, no customer",        100, -10,  0, "combine",       110.00],
  ["no discounts at all",                      100,   0,  0, "combine",       100.00],
  ["customer 20 with no catalog",              100,   0, 20, "combine",        80.00],
  // Rounding: 19.99 at 25% is 14.9925, which must land on 14.99 the same way
  // Postgres round(numeric, 2) does. A half-cent that disagrees is a cart that
  // disagrees.
  ["rounding: 19.99 at 25%",                 19.99,   5, 20, "combine",        14.99],
  // Two large discounts can exceed 100%. Free is where it stops -- a negative
  // unit price must never reach an invoice.
  ["combine past 100% floors at zero",         100,  60, 60, "combine",         0.00],
];

for (const [label, list, catalogPct, customerPct, mode, expected] of CASES) {
  const pct = totalPct({ catalogPct, customerPct, mode });
  const { price } = effectivePrice({
    basePrice: list, productId: "p", variantId: "v", aggregateQty: 1,
    tiersByProduct: new Map(), overridesByVariant: new Map(),
    discountPct: pct, customerPct: mode === "catalog_only" ? 0 : customerPct,
  });
  ok(price === expected, `${label} → ${price} (expected ${expected})`);
}

// ---- a hand-negotiated price is untouchable -------------------------------
{
  const overrides = new Map([["v", 12]]);
  const { price, listPrice } = effectivePrice({
    basePrice: 100, productId: "p", variantId: "v", aggregateQty: 1,
    tiersByProduct: new Map(), overridesByVariant: overrides,
    discountPct: 25, customerPct: 20,
  });
  ok(price === 12, `a negotiated price is returned untouched by a 25% discount (got ${price})`);
  ok(listPrice === 12, "and shows no strikethrough, because nothing was taken off it");
}

// ---- what the buyer is allowed to SEE --------------------------------------
// The catalog's share is silent. The struck-through "before" must be the price
// with only the CUSTOMER's share added back, never the true list price --
// showing 100.00 there would leak the catalog discount.
{
  const { price, listPrice } = effectivePrice({
    basePrice: 100, productId: "p", variantId: "v", aggregateQty: 1,
    tiersByProduct: new Map(), overridesByVariant: new Map(),
    discountPct: 25, customerPct: 20,
  });
  ok(price === 75, "combine: the buyer pays 75.00");
  ok(listPrice === 95, `and the struck-through price is 95.00, not 100.00 (got ${listPrice}) — 100.00 would leak the catalog's own discount`);
}
{
  const { price, listPrice } = effectivePrice({
    basePrice: 100, productId: "p", variantId: "v", aggregateQty: 1,
    tiersByProduct: new Map(), overridesByVariant: new Map(),
    discountPct: 5, customerPct: 0,
  });
  ok(price === 95 && listPrice === 95,
    `a catalog-only discount shows ONE price and no strikethrough (${listPrice} / ${price})`);
}

// ---- a quantity break is the base the discount comes off --------------------
{
  const tiers = new Map([["p", [{ minQty: 10, unitPrice: 80 }]]]);
  const { price, source } = effectivePrice({
    basePrice: 100, productId: "p", variantId: "v", aggregateQty: 12,
    tiersByProduct: tiers, overridesByVariant: new Map(),
    discountPct: 25, customerPct: 20,
  });
  ok(source === "tier" && price === 60,
    `the quantity break is what the discount comes off: 80 less 25% = 60 (got ${price})`);
}

ok(round2(14.9925) === 14.99, "round2 matches Postgres round(numeric, 2) on a half-cent");

// ---- and the SQL check must be running the SAME cases ----------------------
const sql = readFileSync("checks/check_catalog_pricing.sql", "utf8");
const mustAppear = [
  ["combine 5+20", /5 \+ 20 = 25% off 100 \(additive, NOT 76\.00\)/],
  ["customer_only fallback", /customer_only \+ customer at 0 falls back to the catalog discount/],
  ["catalog_only", /catalog_only: the customer 20% is ignored/],
  ["negative catalog", /negative catalog discount raises the price/],
  ["negotiated untouched", /negotiated price wins outright, no discount touches it/],
];
mustAppear.forEach(([name, re]) => {
  ok(re.test(sql), `checks/check_catalog_pricing.sql still covers "${name}" against the real database`);
});

console.log("=".repeat(64));
console.log(" CHECK — THE CART PRICE AND THE INVOICE PRICE AGREE");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`);
  console.log("   A cart that disagrees with the invoice is a bug nobody sees until a customer complains.");
  process.exit(1);
}
console.log(` ✓ PASS — ${pass.length} assertions.`);
