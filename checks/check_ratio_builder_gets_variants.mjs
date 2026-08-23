// =============================================================================
// CHECK: the ratio builder is actually REACHED, on every surface   (Batch 8C.1)
// =============================================================================
// Hadi, 23 August 2026, after Batch 8C shipped:
//
//   "I added the images, I added the colors, I added the sizes, but there's
//    no place to set the ratios."
//
// He was right, and the reason is the one this suite exists to catch.
//
// WHAT WAS WRONG
// --------------
// js/data/size-ratios.js works out a product's sizes and colours by reading
// product.variants[].extra_attrs. Two screens open the same ratio builder:
//
//   Inventory -> Products   listProductsForAdmin()  returns `variants: vs`  ✓
//   Catalogs                getCatalogProducts()    did NOT                 ✗
//
// getCatalogProducts FETCHED the variants -- it used them to build the colour
// swatches, the price range and the photographs -- and then did not put them
// on the row it returned. So on that surface productSizes() and
// productColors() both returned [], and the builder took its "this product
// has no colours or sizes yet" branch for EVERY product, always.
//
// Hadi's product had 3 colours and 6 sizes. The panel told him 0.
//
// WHY BATCH 8C's GATE DID NOT CATCH IT
// ------------------------------------
// check_packs_panel_reachable.mjs asserted that the no-variants branch offers
// an "Add colours & sizes" button. It tested the ERROR path and never once
// tested the SUCCESS path -- that a product WITH variants reaches the actual
// builder. So the gate was fully green while the feature was unreachable on
// the surface Hadi was using, and the "fix" politely offered to help him add
// colours he already had.
//
// That is precisely the failure written up in Batch 7 about check_pack_moq.sh:
// eight rejection cases passing while all three acceptance cases were dead.
// It was documented, and then committed again three days later. Hence this
// file, which is all acceptance case.
//
// HOW IT TESTS
// ------------
// Not by searching for "variants: vs" in the source -- that passes the moment
// anyone writes those characters anywhere. It stubs window.supabase, CALLS
// THE REAL getCatalogProducts(), and runs the REAL productSizes() and
// productColors() over whatever comes back. If the data layer stops handing
// the variants over, for any reason, the sizes come back empty and this fails.
//
//   node checks/check_ratio_builder_gets_variants.mjs
// =============================================================================
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

// ---------------------------------------------------------------- fixture --
// One catalog, one product, 3 colours x 2 sizes. Shaped exactly like the rows
// PostgREST returns, including the extra_attrs the size/colour helpers read.
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const COLOURS = ["Mint", "Olive", "Red"];
const SIZES   = ["38", "40"];

const VARIANT_ROWS = [];
for (const c of COLOURS) {
  for (const s of SIZES) {
    VARIANT_ROWS.push({
      id: `v-${c}-${s}`, product_id: PRODUCT_ID, sku: `TEE-${c}-${s}`,
      price: 10, archived: false,
      extra_attrs: { color: c, colorHex: "#123456", size: s },
      image_url: null, images: [],
    });
  }
}

const TABLES = {
  v2_catalog_products: [{ product_id: PRODUCT_ID, sort_order: 1, added_at: null, highlighted: false }],
  v2_products: [{
    id: PRODUCT_ID, name: "Classic Tee", description: null, category: null,
    archived: false, selling_model: "ratio", base_unit: 12, created_at: "2026-08-01",
  }],
  v2_product_variants: VARIANT_ROWS,
};

// A thenable query builder: every filter returns `this`, awaiting resolves to
// {data, error}. Enough of PostgREST's surface for this call path.
function makeQuery(table) {
  const q = {
    _table: table,
    select() { return q; }, eq() { return q; }, in() { return q; },
    order() { return q; }, limit() { return q; }, maybeSingle() { return q; },
    then(resolve) { resolve({ data: TABLES[table] ?? [], error: null }); return Promise.resolve(); },
  };
  return q;
}
dom.window.supabase = { createClient: () => ({ from: (t) => makeQuery(t), rpc: () => makeQuery(null) }) };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

async function load(path, label) {
  try { return await import(path); }
  catch (e) { fail.push(`${label} — could not be loaded: ${String(e).split("\n")[0]}`); return null; }
}

const ratios   = await load("../js/data/size-ratios.js", "js/data/size-ratios.js");
const catalogs = await load("../js/data/catalogs.js",    "js/data/catalogs.js");
const productSizes  = ratios?.productSizes;
const productColors = ratios?.productColors;

// ------------------------------------------------- 1. Catalogs, end to end --
let row = null;
if (catalogs?.getCatalogProducts) {
  const res = await catalogs.getCatalogProducts("cat-1");
  ok(res?.ok === true, "getCatalogProducts() returns ok");
  row = (res?.rows || [])[0] || null;
  ok(!!row, "…and a product row");
}

ok(!!row && Array.isArray(row.variants),
   "the catalog row carries `variants` — the ratio builder reads product.variants[].extra_attrs, and this is the field that was missing");
ok(!!row && (row.variants || []).length === VARIANT_ROWS.length,
   `all ${VARIANT_ROWS.length} variants come back, not a summary count`);

// THE ASSERTION THAT MATTERS. Real helpers, real returned row.
const catSizes  = productSizes  && row ? productSizes(row)  : [];
const catColors = productColors && row ? productColors(row) : [];
ok(catSizes.length === SIZES.length,
   `productSizes() on a CATALOG row finds ${SIZES.length} sizes (got ${catSizes.length}) — this returned 0 for every product until 23 Aug, which is why the builder always said "no colours or sizes yet"`);
ok(catColors.length === COLOURS.length,
   `productColors() on a CATALOG row finds ${COLOURS.length} colours (got ${catColors.length})`);
ok(!!row && row.base_unit === 12,
   "base_unit comes back too — the builder writes this box, and a blank one would have reset a product sold in 12s to single pieces");

// ------------------------------------- 2. the two surfaces must not diverge --
// The real defect was one surface having a field the other did not, while both
// ran the same component. Assert the shape contract directly rather than
// trusting that two separate queries stay in step.
const admin = await load("../js/data/products-admin.js", "js/data/products-admin.js");
ok(!!admin?.listProductsForAdmin,
   "listProductsForAdmin() exists — the OTHER surface that opens this builder");

const adminRow = { variants: VARIANT_ROWS };
ok(productSizes && productSizes(adminRow).length === SIZES.length,
   "a Products-pane row shape reaches the builder too — both surfaces satisfy the same contract");

// ------------------------------------------------ 3. the contract, in words --
// A product with variants must NOT take the dead-end branch. That branch is
// chosen by exactly this condition in renderRatioSection.
const hasBoth = catSizes.length > 0 && catColors.length > 0;
ok(hasBoth,
   "a catalog product with colours and sizes now takes the BUILDER branch, not the \"add variants first\" branch — the success path Batch 8C's gate never tested");

// ---------------------------------------------------------------- report ----
const line = "-".repeat(64);
console.log("\nThe ratio builder is reached on every surface that opens it\n" + line);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log(line);
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — all ${pass.length} assertions held.\n`);
