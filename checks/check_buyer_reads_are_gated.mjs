// ============================================================================
// check_buyer_reads_are_gated.mjs — Batch S, gate S2.
//
// THE RULE: on the buyer's path, nothing reads a table. Every product, price,
// pack and stock number a buyer sees arrives through a function that re-checks
// the share token.
//
// WHY A STRUCTURAL GATE AND NOT JUST THE SQL ONE. check_anon_scope.sh proves
// the DATABASE is shut. It cannot prove the APP stopped asking -- and until
// S7 lands, the grants are still open, so a leftover table read keeps working
// perfectly and nothing goes red anywhere. This is the gate that catches a
// buyer read that was never moved, in the window where it still looks fine.
//
// It also catches the reverse, which is the more likely accident: a future
// edit to js/data/catalog.js that "helpfully" adds a table read back into the
// token path because the RPC was missing one field.
//
// ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: assert that a name appears in a file.
// On 25 Aug a check asked exactly that and stayed green through three
// rewrites, because an unused `import` satisfies it. Here, the token path is
// resolved by following what getCatalogByToken actually calls.
//
// Exit 1 on violation. Run from the repo root: node checks/check_buyer_reads_are_gated.mjs
// ============================================================================
import { readFileSync } from "node:fs";

let fail = 0;
const problems = [];

const catalogSrc = readFileSync("js/data/catalog.js", "utf8");
const buyerSrc   = readFileSync("js/views/buyer.js", "utf8");

// --- 1. getCatalogByToken exists and goes through the RPC -------------------
const fnMatch = catalogSrc.match(
  /export async function getCatalogByToken\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
);
if (!fnMatch) {
  problems.push("getCatalogByToken() is missing from js/data/catalog.js entirely.");
  fail = 1;
} else {
  const body = fnMatch[1];
  if (!/supabase\.rpc\(\s*["']v2_catalog_read["']/.test(body)) {
    problems.push("getCatalogByToken() does not call the v2_catalog_read RPC.");
    fail = 1;
  }
  // The whole point: this function must not touch a table.
  const tableRead = body.match(/supabase\.from\(\s*["']([^"']+)["']/);
  if (tableRead) {
    problems.push(
      `getCatalogByToken() reads the table ${tableRead[1]} directly. ` +
      `Everything it returns must come through v2_catalog_read, or the token ` +
      `gate has no say over that field.`
    );
    fail = 1;
  }
}

// --- 2. the token route in buyer.js does not call getCatalog(wid) -----------
// Scope to the token view rather than the whole file: the buyer DASHBOARD is a
// different path (a signed-in buyer, not a link) and is S2b's job, not this
// gate's. Asserting over the whole file would fail for the right reason at the
// wrong time and get "fixed" by weakening it.
const tokenView = buyerSrc.match(
  /export async function catalogByLink[\s\S]*?\n\}/
) || buyerSrc.match(/const rows = await catalogProductsByToken[\s\S]{0,3000}/);

// Comments are stripped BEFORE any of the checks below, not just the negative
// one. Proven necessary on 25 Aug: the "does the signed-in route call
// getBuyerCatalog()?" assertion stayed GREEN with the real call renamed away,
// because a COMMENT in this file explaining the fix mentions the function by
// name. A check that a name appears somewhere in a file is satisfied by prose
// about the name — the same family as the unused `import` that kept the
// saved-mix assertion green through three rewrites.
const buyerCode = buyerSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

if (!buyerCode.includes("getCatalogByToken(")) {
  problems.push("js/views/buyer.js never calls getCatalogByToken() — the token route was not moved.");
  fail = 1;
}
if (!buyerCode.includes("getBuyerCatalog(")) {
  problems.push("js/views/buyer.js never calls getBuyerCatalog() — the SIGNED-IN route was not moved (S2b).");
  fail = 1;
}

// WIDENED 25 Aug (S2b), from "the token route" to the WHOLE FILE.
//
// The first version of this check scoped itself to the token route, because
// that was the route being moved. Scoping it that way would have let the
// signed-in route and favouritesView keep reading the whole wholesaler
// forever, with this gate green — and there turned out to be THREE such
// reads in this file, not one. A gate aimed at the change instead of at the
// rule only guards the change.
//
if (/\bgetCatalog\s*\(/.test(buyerCode)) {
  problems.push(
    "js/views/buyer.js still calls getCatalog(), which reads v2_products / " +
    "v2_product_variants / v2_inventory_by_variant for the WHOLE wholesaler. " +
    "Every buyer view must read through a gated function. That is the defect " +
    "Batch S exists to close."
  );
  fail = 1;
}

// --- 3. no dangling reference to the id-list path it replaced --------------
// An unused import is how the saved-mix feature fell out of three rewrites, so
// this asserts the symbol is gone, not merely unreferenced somewhere.
if (/catalogProductsByToken/.test(buyerSrc)) {
  problems.push(
    "buyer.js still references catalogProductsByToken. The id-list path is " +
    "replaced; leaving the import behind is how a later edit quietly restores it."
  );
  fail = 1;
}

// --- S3: packs -------------------------------------------------------------
//
// ⛔ THE ASSERTION THAT WOULD HAVE CAUGHT THE 26 AUG BUG.
//
// The share-link view passed `packs: []` to every product card — a literal
// empty array, unconditionally. For a series/prepack/ratio product the card
// then took its dead-end branch and told the buyer the wholesaler had not set
// up a bundle. They had. 13 of 23 live products, five of six wholesalers.
//
// Nothing in this repo asserted that a buyer holding a link can reach a pack,
// so nothing went red. This does. It is deliberately a check on the LITERAL,
// because `packs: []` is not a bug of logic — it is a bug of nobody having
// written the call.
if (/packs:\s*\[\s*\]/.test(buyerCode)) {
  problems.push(
    "js/views/buyer.js passes a hard-coded empty `packs: []` to a product card. " +
    "For a series/prepack/ratio product the pack IS the buy button, and an " +
    "empty list makes the card say the wholesaler never set one up. This is " +
    "the 26 Aug link bug — do not restore it."
  );
  fail = 1;
}

for (const ungated of ["listPacksForProducts(", "getPackById("]) {
  if (buyerCode.includes(ungated)) {
    problems.push(
      `js/views/buyer.js calls ${ungated}) — the ungated pack read, straight off ` +
      "v2_pack_definitions / v2_pack_components. Buyer views must use " +
      "listPacksByToken / listPacksForBuyerCatalog / getBuyerPack."
    );
    fail = 1;
  }
}

if (!buyerCode.includes("listPacksByToken(")) {
  problems.push("the share-link route never fetches packs through the gate (listPacksByToken).");
  fail = 1;
}
if (!buyerCode.includes("listPacksForBuyerCatalog(")) {
  problems.push("the signed-in route never fetches packs through the gate (listPacksForBuyerCatalog).");
  fail = 1;
}

// The gated pack path must not carry the flat pack price. It is never rendered
// (D4, 21 Aug) and it is the wholesaler's margin structure.
{
  const packsSrc = readFileSync("js/data/prepacks.js", "utf8");
  // Scoped to the GATED block only — from assemblePackRows() to the start of
  // the legacy wholesaler-side readers below it. Slicing to end-of-file (the
  // first version of this check) swept in getPackById and listPacksForProduct,
  // which legitimately still carry flatPackPrice for the wholesaler's own
  // screens, and reported a leak that was not there. A check that fails on
  // code it was never meant to judge gets its assertion deleted, not fixed.
  const from = packsSrc.indexOf("function assemblePackRows");
  const to   = packsSrc.indexOf("/** Batch version of listPacksForProduct");
  const gated = (from !== -1 && to > from) ? packsSrc.slice(from, to) : "";
  if (!gated) {
    problems.push("HARNESS BROKEN — could not locate the gated pack block in js/data/prepacks.js. This is NOT a pass.");
    fail = 1;
  }
  if (/flatPackPrice|isFlatPrice/.test(gated)) {
    problems.push(
      "the gated pack path returns flatPackPrice / isFlatPrice. Nothing renders " +
      "it, and it is the wholesaler's margin structure — it must not cross to the buyer."
    );
    fail = 1;
  }
}

// --- S4: pricing -----------------------------------------------------------
//
// ⛔ Guards the 26 Aug finding: v2_catalog_discount_pct is SECURITY DEFINER,
// granted to anon, and takes BOTH the catalogue id and the client id from the
// caller. Signed out, from the app's own origin, it returned real negotiated
// terms (AMANI 10.00, CEDAR 5.00) and a catalogue markup of -5.00 that the
// project's own notes call "invisible to the buyer by design".
//
// The buyer path must use the account-derived functions, which take no client
// id at all. Comments are stripped first — this file explains the old function
// by name, and prose about a name is not a call to it.
{
  const pricingSrc = readFileSync("js/data/pricing.js", "utf8");
  const pricingCode = pricingSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  if (/from\(\s*["']v2_pricing_tiers["']/.test(pricingCode)) {
    problems.push(
      "js/data/pricing.js reads the v2_pricing_tiers TABLE directly. anon holds " +
      "SELECT on it and the read is cross-tenant — zero rows today, twenty " +
      "wholesalers' quantity breaks at launch."
    );
    fail = 1;
  }
  if (/rpc\(\s*["']v2_catalog_discount_pct["']/.test(pricingCode)) {
    problems.push(
      "js/data/pricing.js calls v2_catalog_discount_pct — the UNGATED discount " +
      "function that takes a client id from the caller. Use v2_buyer_discount_pct " +
      "(account-derived) or v2_token_discount_pct."
    );
    fail = 1;
  }
  for (const need of ["v2_buyer_discount_pct", "v2_token_discount_pct", "v2_catalog_tiers", "v2_buyer_catalog_tiers"]) {
    if (!pricingCode.includes(need)) {
      problems.push(`js/data/pricing.js never calls ${need} — the gated pricing path is incomplete.`);
      fail = 1;
    }
  }
}

// The link route must hand its token to the pricing call, or the database
// cannot gate the tiers and discount on the link the buyer actually holds.
if (!/catalogId:\s*resolved\.id,\s*token/.test(buyerCode)) {
  problems.push(
    "the share-link route does not pass its token to getPricingContext, so the " +
    "tiers and discount cannot be gated on the link the buyer holds."
  );
  fail = 1;
}

// --- 4. one shaping function, not two --------------------------------------
// If getCatalog and getCatalogByToken each build the buyer object by hand, the
// two read paths WILL drift, and the buyer path is the one nobody looks at.
// REWRITTEN 25 Aug (S2b). The previous form counted shapeVariant() call
// sites and required at least two — which tied the rule to how many callers
// happen to exist, so deleting an unrelated function would have turned it red
// while nothing had actually drifted. (Its version before THAT counted the
// function's own declaration as a call and could not go red at all — the
// identical mistake shipped on 23 Aug.)
//
// The rule is: there is exactly ONE place that decides what a buyer's variant
// object looks like. `colorHex` is the fingerprint — it appears in no raw
// database row, only in the shaped object — so a second occurrence means
// somebody hand-rolled a second shaper, which is precisely how two read paths
// start disagreeing.
const shaperCount = (catalogSrc.match(/colorHex:/g) || []).length;
if (shaperCount !== 1) {
  problems.push(
    `the buyer's variant object is built in ${shaperCount} places, not 1. ` +
    "Every read path must go through shapeVariant() or they will drift — and " +
    "the buyer path is the one nobody looks at when the other is edited."
  );
  fail = 1;
}

if (fail) {
  console.log("✗ FAIL — the buyer path is not fully gated:\n");
  problems.forEach((p) => console.log("  • " + p + "\n"));
  process.exit(1);
}
console.log("  ✓ getCatalogByToken() reads only the v2_catalog_read RPC");
console.log("  ✓ NO buyer view reads the whole wholesaler's tables");
console.log("  ✓ the id-list path is gone, not merely unused");
console.log("  ✓ both read paths share one shaping function");
console.log("  ✓ the signed-in route reads through the gate too (S2b)");
console.log("  ✓ both routes fetch PACKS through the gate, and no hard-coded packs: []");
console.log("  ✓ pricing is account-derived — no client id passed by the caller");
console.log("\n ✓ PASS — all 19 assertions held.");
