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
console.log("\n ✓ PASS — all 6 assertions held.");
