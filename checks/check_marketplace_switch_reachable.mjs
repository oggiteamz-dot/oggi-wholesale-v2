// =============================================================================
// CHECK: the marketplace switch is reachable, and the link checkbox is not it
//                                                        (MOD-08, 6 Sep 2026)
// =============================================================================
//   node checks/check_marketplace_switch_reachable.mjs
//
// WHAT WENT WRONG, IN TWO STEPS
//
// 1. `v2_catalogs.is_public` was the only thing that put a product on the OGGI
//    marketplace, and its checkbox said "Open to anyone with the link. No
//    login." It never mentioned the marketplace. That was the lie MOD-08 is
//    named after, and it was true before any of this refactor started.
//
// 2. MOD-01 put the flag on the product and MOD-03 pointed the feed and the
//    search at it. That fixed the lie and replaced it with a quieter one: the
//    marketplace now read a column **no screen could write**. A wholesaler
//    could neither publish a product nor take one down, the marketplace was
//    frozen at whatever migration 116's backfill happened to set, and nothing
//    anywhere said so.
//
// THE FAILURE MODE THIS FILE EXISTS FOR IS STEP 2, NOT STEP 1.
// It is this repo's most repeated bug and it has never once been caught by a
// test: `createRatio()` is the only function that creates a size ratio and has
// had no caller since 24 August, so every wholesaler onboarded after that date
// has an empty ratio list forever. Nine of the twelve exports in that module
// are unreachable. Nothing was red, because everything that exists works.
//
// So this gate does not check that the toggle is correct. It checks that it
// can be REACHED: written by a data module, imported by a view, called from
// that view, and shown on screen so a person can tell which way it is set.
// A switch you cannot see the position of is not a switch.
// =============================================================================
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const admin  = read("js/data/products-admin.js");
const cats   = read("js/data/catalogs.js");
const view   = read("js/views/wholesaler.js");
const feedJs = read("js/data/marketplace-feed.js");

// --- 1. A WRITER EXISTS -------------------------------------------------
// The column the marketplace reads must be writable from the app at all.
ok(/\.from\("v2_products"\)[\s\S]{0,200}?is_public/.test(admin),
   "js/data/products-admin.js writes v2_products.is_public — the flag the marketplace reads is a flag the app can set");

// --- 2. IT IS EXPORTED --------------------------------------------------
ok(/export\s+async\s+function\s+setProductPublic\s*\(/.test(admin),
   "setProductPublic is exported — a writer nothing outside its own file can call is not a writer");

// --- 3. A VIEW IMPORTS IT ----------------------------------------------
ok(/import\s*\{[^}]*\bsetProductPublic\b[^}]*\}\s*from\s*"\.\.\/data\/products-admin\.js"/.test(view),
   "js/views/wholesaler.js imports setProductPublic");

// --- 4. AND CALLS IT ----------------------------------------------------
// THE createRatio ASSERTION. An import is not a caller: a name can sit in an
// import list for weeks while the button that was meant to use it never lands.
ok(/\bsetProductPublic\s*\(\s*[^)]/.test(view.replace(/import[\s\S]*?;/, "")),
   "…and calls it — this is the assertion createRatio() never had, and why the size-ratio library has been unreachable since 24 August");

// --- 5. THE BUTTON SAYS WHICH WAY IT GOES ------------------------------
ok(/Take off the marketplace/.test(view) && /Put on the marketplace/.test(view),
   'the control names the RESULT of pressing it ("Put on / Take off the marketplace"), not a state you have to work out');

// --- 6. AND THE CURRENT STATE IS VISIBLE -------------------------------
// Without this, the only way to learn whether a product is published is to
// press the button and read the toast.
ok(/On the marketplace/.test(view),
   "a published product is badged on the Products screen — a toggle whose position you cannot see is not a toggle");

// --- 7. THE TWO SWITCHES STAY SEPARATE ---------------------------------
// The whole point of MOD-01 was to stop one control doing two jobs. If the
// catalogue writer ever touches the product flag again, the lie is back.
const setCatalogPublic = cats.slice(cats.indexOf("export async function setCatalogPublic"),
                                    cats.indexOf("export async function setCatalogPublic") + 700);
ok(setCatalogPublic.includes("setCatalogPublic"), "setCatalogPublic still exists (sanity: the slice above found it)");
ok(!/v2_products/.test(setCatalogPublic),
   "setCatalogPublic touches v2_catalogs and NOT v2_products — the link switch and the marketplace switch are two switches again");

// --- 8. THE LABEL NO LONGER LEAVES THE QUESTION OPEN -------------------
// Correcting the behaviour is not enough on its own. Every wholesaler who used
// this box before today learned that it published to the marketplace, and
// nothing on the screen would tell them it had stopped.
ok(/does not put anything on the OGGI marketplace/.test(view),
   "the catalog link checkbox says in words that it does not publish to the marketplace, and where the switch that does now lives");

// --- 9. NO COMMENT IN js/ STILL NAMES THE OLD RULE ---------------------
// A comment naming the wrong column is worse than no comment: it sends the
// next person to the wrong table. marketplace-feed.js carried exactly this
// sentence, correct until migration 119 and wrong the moment it landed.
ok(!/the catalogue's own is_public/.test(feedJs),
   "js/data/marketplace-feed.js no longer says the feed's scope comes from the catalogue's is_public — migration 119 moved it to the product's");

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
