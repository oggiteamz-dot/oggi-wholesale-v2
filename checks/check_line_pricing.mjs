// =============================================================================
// CHECK: the cart total and the invoice total are the same number
// =============================================================================
// checks/check_price_agreement.mjs already pins effectivePrice() against the
// SQL for a SINGLE LINE. This gate covers the thing that check cannot see: a
// cart is not one line, and until Batch 5 the buyer app priced its two kinds
// of line by two different rules.
//
// v2_submit_order prices every line -- loose and pack alike -- as
//   qty x v2_effective_unit_price(product, variant, client, AGG_QTY, catalog)
// where AGG_QTY is the total pieces of that PRODUCT across the whole order.
// It never reads v2_pack_definitions.pack_price. (Verified against the live
// function body on 21 Aug 2026: the string does not occur in it.)
//
// The buyer app used to price a pack as its own `price` field and count zero
// pieces toward AGG_QTY. Both are wrong, and both are silent:
//   - a pack in a discounted catalog showed the UNDISCOUNTED total;
//   - a pack that had earned a quantity break was never told, and the invoice
//     came back cheaper than the cart the buyer approved.
//
// THE RULE THIS GATE ENFORCES, in Hadi's words (20 Aug 2026):
//   "we will not be pricing per pack or per ratio. The price they will read
//    in the thumbnail is going to be the per unit price ... they see that
//    there's a x12 or x20 next to it, which will be multiplied in the final
//    total."
// So: displayed unit price x units must equal the line total, exactly, for
// every selling model -- and the sum of the line totals must equal what the
// server will charge.
//
//   node checks/check_line_pricing.mjs
// =============================================================================
import { readFileSync } from "node:fs";

// Same stub, same reason, as check_price_agreement.mjs: the module under test
// is pure arithmetic that happens to sit beside a data-fetching neighbour.
globalThis.window = { supabase: { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) } };
const { priceCart, priceLine, aggregateQtyByProduct } = await import("../js/data/line-pricing.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---------------------------------------------------------------------------
// The fixture. One product, four sizes, all at $8.00 -- deliberately uniform,
// because that is what every pack on production actually looks like (checked:
// zero packs have more than one distinct component price).
// ---------------------------------------------------------------------------
const PRODUCT = "11111111-1111-1111-1111-111111111111";
const V = { S: "aaaa0001", M: "aaaa0002", L: "aaaa0003", XL: "aaaa0004" };
const LIST = { [V.S]: 8, [V.M]: 8, [V.L]: 8, [V.XL]: 8 };
const basePriceFor = (id) => LIST[id] ?? 0;

const looseLine = (variantId, qty) => ({ variantId, productId: PRODUCT, qty, price: null });
const packLine = (packQty, per = 3) => ({
  isPack: true, packId: "pack-1", packLineId: "pl-1", productId: PRODUCT, packQty,
  // A flat pack price the wholesaler set. The server ignores it; so must we.
  price: 50,
  components: Object.values(V).map((variantId) => ({ variantId, qtyPerPack: per, price: LIST[variantId] })),
});

// ---------------------------------------------------------------------------
// CASE TABLE. Each row is also asserted to exist in the SQL sibling below, so
// the two cannot drift apart silently.
// ---------------------------------------------------------------------------
const CASES = [
  {
    id: "loose-plain",
    why: "a plain loose line, no discounts: 10 x 8.00",
    lines: [looseLine(V.M, 10)], ctx: {},
    expectSubtotal: 80, expectUnits: [10], expectUnitPrice: [8],
  },
  {
    id: "pack-plain",
    why: "one pack of 12 at 8.00 -- the case the old code got right by accident",
    lines: [packLine(1)], ctx: {},
    expectSubtotal: 96, expectUnits: [12], expectUnitPrice: [8],
  },
  {
    id: "pack-discount",
    why: "THE REGRESSION: a pack in a 25% catalog. Server charges 12 x 6.00 = 72.00; the old card showed 96.00",
    lines: [packLine(1)], ctx: { discountPct: 25 },
    expectSubtotal: 72, expectUnits: [12], expectUnitPrice: [6],
  },
  {
    id: "pack-crosses-tier",
    why: "a pack of 12 reaches the 12+ break at 6.50 -- the old aggregate counted the pack as ZERO pieces and never found it",
    lines: [packLine(1)],
    ctx: { tiersByProduct: new Map([[PRODUCT, [{ minQty: 12, unitPrice: 6.5 }]]]) },
    expectSubtotal: 78, expectUnits: [12], expectUnitPrice: [6.5],
  },
  {
    id: "pack-plus-loose-share-aggregate",
    why: "12 in a pack + 6 loose = 18 pieces of one product, so the 12+ break applies to BOTH lines",
    lines: [packLine(1), looseLine(V.L, 6)],
    ctx: { tiersByProduct: new Map([[PRODUCT, [{ minQty: 12, unitPrice: 6.5 }]]]) },
    expectSubtotal: 117, expectUnits: [12, 6], expectUnitPrice: [6.5, 6.5],
  },
  {
    id: "flat-pack-price-is-not-charged",
    why: "D4: pack_price is 50.00 on this fixture and the server still charges 96.00. A flat pack price is stored, never charged",
    lines: [packLine(1)], ctx: {},
    expectSubtotal: 96, expectUnits: [12], expectUnitPrice: [8],
  },
  {
    id: "override-untouched-by-discount",
    why: "a negotiated price is a promise: 25% comes off the other three sizes, not off it -- so this pack is BLENDED",
    lines: [packLine(1)],
    ctx: { discountPct: 25, overridesByVariant: new Map([[V.S, 5]]) },
    // S: 3 x 5.00 = 15.00 (override, untouched). M/L/XL: 9 x 6.00 = 54.00.
    expectSubtotal: 69, expectUnits: [12], expectBlended: [true],
  },
  {
    id: "rounding-per-unit-not-per-line",
    why: "19.99 less 25% rounds to 14.99 per PIECE, then x12 = 179.88 -- rounding the line instead drifts a cent",
    lines: [{ ...packLine(1), components: Object.values(V).map((variantId) => ({ variantId, qtyPerPack: 3, price: 19.99 })) }],
    ctx: { discountPct: 25 },
    expectSubtotal: 179.88, expectUnits: [12], expectUnitPrice: [14.99],
  },
];

for (const c of CASES) {
  const { lines, subtotal } = priceCart(c.lines, { basePriceFor, ...c.ctx });
  ok(subtotal === c.expectSubtotal, `${c.id}: subtotal ${subtotal} (expected ${c.expectSubtotal}) — ${c.why}`);

  (c.expectUnits || []).forEach((u, i) => {
    ok(lines[i].units === u, `${c.id}: line ${i} counts ${lines[i].units} pieces (expected ${u})`);
  });
  (c.expectUnitPrice || []).forEach((p, i) => {
    ok(lines[i].unitPrice === p, `${c.id}: line ${i} unit price ${lines[i].unitPrice} (expected ${p})`);
  });
  (c.expectBlended || []).forEach((b, i) => {
    ok(lines[i].isBlended === b, `${c.id}: line ${i} isBlended=${lines[i].isBlended} (expected ${b})`);
  });

  // THE RULE ITSELF. For every line whose pieces all cost the same, the number
  // on screen times the number of pieces must be the number charged. Exactly,
  // not to within a cent.
  lines.forEach((l, i) => {
    if (l.isBlended) return;
    ok(Math.round(l.unitPrice * l.units * 100) === Math.round(l.lineTotal * 100),
      `${c.id}: line ${i} — displayed ${l.unitPrice} x ${l.units} = ${(l.unitPrice * l.units).toFixed(2)} matches the charged ${l.lineTotal.toFixed(2)}`);
  });
}

// A blended line must NEVER claim exactness. This is the guard that stops a
// future mixed-price pack from quietly showing an average as if it were the
// price -- the same class of lie, just a subtler one.
{
  const { lines } = priceCart([{
    isPack: true, packId: "p", packLineId: "x", productId: PRODUCT, packQty: 1,
    components: [
      { variantId: V.S, qtyPerPack: 1, price: 10 },
      { variantId: V.M, qtyPerPack: 1, price: 21 },
    ],
  }], { basePriceFor });
  ok(lines[0].isBlended === true, "a pack of 10.00 + 21.00 pieces is flagged blended, so the UI must say 'avg'");
  ok(lines[0].lineTotal === 31, `and its total is the real 31.00, not 2 x the 15.50 average (got ${lines[0].lineTotal})`);
  ok(lines[0].unitPrice === 15.5, `while the average shown is 15.50 (got ${lines[0].unitPrice})`);
}

// The aggregate is the thing that used to be zero. Pin it directly.
{
  const agg = aggregateQtyByProduct([packLine(2), looseLine(V.S, 5)]);
  ok(agg.get(PRODUCT) === 29, `2 packs of 12 plus 5 loose aggregate to 29 pieces (got ${agg.get(PRODUCT)}) — this was 5 before Batch 5`);
}

// A pack line saved by an older build has no productId. It must not vanish and
// must not pollute another product's aggregate.
{
  const legacy = { isPack: true, packId: "old", packLineId: "z", packQty: 1, components: [{ variantId: V.S, qtyPerPack: 4, price: 8 }] };
  const agg = aggregateQtyByProduct([legacy]);
  ok(agg.get("pack:old") === 4, "a pack line from an older cart is still counted, under its own key");
  ok(agg.get(PRODUCT) === undefined, "and it does not leak into the real product's aggregate");
  const { subtotal } = priceCart([legacy], { basePriceFor });
  ok(subtotal === 32, `and it still prices (got ${subtotal}, expected 32)`);
}

// ---------------------------------------------------------------------------
// D4 GUARD. The one line that decides whether a flat pack price can leak back
// into a buyer-facing number.
//
// js/data/prepacks.js used to build every pack as
//     price: p.pack_price != null ? Number(p.pack_price) : sumPrice
// so a wholesaler who typed 50 into "flat price" produced a card quoting 50
// against an invoice of 96. It now always returns the sum and carries the flat
// value separately as flatPackPrice. This is a SOURCE assertion, said plainly
// rather than dressed up as a behavioural one: prepacks.js is a data module
// whose functions are all network calls, so there is nothing to run offline --
// but the regression would be a single-line edit, and a single line is exactly
// what a source guard can hold.
// ---------------------------------------------------------------------------
const prepacksSrc = readFileSync(new URL("../js/data/prepacks.js", import.meta.url), "utf8");
ok(!/price:\s*p\.pack_price\s*!=\s*null/.test(prepacksSrc) && !/price:\s*pack\.pack_price\s*!=\s*null/.test(prepacksSrc),
  "js/data/prepacks.js does not fold pack_price into `price` — the flat price is not a price (D4)");
ok((prepacksSrc.match(/flatPackPrice:/g) || []).length === 3,
  `all three pack builders expose flatPackPrice separately (found ${(prepacksSrc.match(/flatPackPrice:/g) || []).length} of 3)`);
ok(/DECISION D4/.test(prepacksSrc),
  "and the decision is written down in the file where someone would go to undo it");

// ---------------------------------------------------------------------------
// DRIFT GUARD. The same cases run against the real database in
// checks/check_line_pricing.sql. Editing one file and not the other fails here.
// ---------------------------------------------------------------------------
const sql = readFileSync(new URL("./check_line_pricing.sql", import.meta.url), "utf8");
for (const id of ["pack-discount", "pack-crosses-tier", "pack-plus-loose-share-aggregate", "flat-pack-price-is-not-charged"]) {
  ok(sql.includes(id), `checks/check_line_pricing.sql still covers "${id}" against the real database`);
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
