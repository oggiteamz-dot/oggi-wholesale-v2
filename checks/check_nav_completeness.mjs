// =============================================================================
// OGGI Wholesale v2 — GATE 2: NAVIGATION COMPLETENESS
// =============================================================================
//
// WHAT THIS IS FOR, IN PLAIN ENGLISH
// ----------------------------------
// Right now, on a phone, this app has NO navigation. `css/layout.css` hides
// the sidebar below 880px and nothing replaces it, so every screen except the
// one you happen to be on is unreachable by tapping. All four roles. That is
// 28 destinations that exist, work, and cannot be opened.
//
// The fix is a bottom bar plus a "More" hub. The DANGER in that fix is
// obvious once you say it out loud: a bottom bar holds about five things, and
// the wholesaler role has twelve. The tempting shortcut is to hand-pick "the
// important five" and quietly leave seven screens with no way in. That would
// not delete a single line of code -- Gate 1 would stay green -- and seven
// features would still be gone from mobile.
//
// This gate exists to make that specific mistake impossible.
//
// WHAT IT ASSERTS
// ---------------
//   1. splitNav() exists and is pure (no DOM), so it can be tested at all.
//   2. For EVERY role: bar ∪ more === the full nav list. Exactly. No item
//      omitted, no item invented, no duplicates.
//   3. The bar never exceeds MAX_BAR_ITEMS (a bar that overflows is a bar
//      whose last items are unreachable on a narrow screen).
//   4. Every role with more items than fit gets a "More" entry -- otherwise
//      the overflow has no door.
//   5. The bottom-nav COMPONENT contains no hard-coded route strings. If it
//      hard-codes paths, it has stopped deriving from nav-config.js and this
//      gate would be checking a config the UI no longer obeys.
//
// Point 5 is the one that matters most in six months. A gate that validates
// a config the UI has quietly stopped reading is worse than no gate, because
// it reports green while the app is broken. That is the same class of failure
// as `check_pack_moq.sh` reporting 7 green while the database function
// crashed on every call.
//
// HOW TO RUN
//   node checks/check_nav_completeness.mjs
//
// Exit 0 = pass. Exit 1 = a screen is unreachable on mobile.
//
// PROVEN TO GO RED — see checks/GATE-EVIDENCE.md.
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENT_PATH = join(ROOT, "js/components/bottomnav.js");

let failures = [];
let checksRun = 0;

function assert(condition, message) {
  checksRun++;
  if (!condition) failures.push(message);
}

console.log("============================================================");
console.log(" GATE 2 — NAVIGATION COMPLETENESS");
console.log("============================================================");

// ---------------------------------------------------------------------------
// Load the single source of truth. Deliberately imported, not regex-parsed:
// if nav-config.js is broken JavaScript, this gate should fail loudly rather
// than silently match zero things and report success.
// ---------------------------------------------------------------------------
let NAV_BY_ROLE, splitNav, MAX_BAR_ITEMS;
try {
  const mod = await import(join(ROOT, "js/lib/nav-config.js"));
  NAV_BY_ROLE = mod.NAV_BY_ROLE;
  splitNav = mod.splitNav;
  MAX_BAR_ITEMS = mod.MAX_BAR_ITEMS;
} catch (err) {
  console.log(`\n  ✗ Could not import js/lib/nav-config.js\n    ${err.message}`);
  process.exit(1);
}

if (typeof splitNav !== "function") {
  console.log("\n  ✗ splitNav() is not exported from js/lib/nav-config.js.");
  console.log("    The mobile nav must derive its contents from the same");
  console.log("    config the desktop sidebar reads. Without a shared, pure");
  console.log("    split function there is nothing to verify, and the bottom");
  console.log("    bar will drift from the sidebar the first time either changes.");
  process.exit(1);
}
if (!Number.isInteger(MAX_BAR_ITEMS)) {
  console.log("\n  ✗ MAX_BAR_ITEMS is not exported as an integer from nav-config.js.");
  process.exit(1);
}

console.log(` Roles found: ${Object.keys(NAV_BY_ROLE).join(", ")}`);
console.log(` MAX_BAR_ITEMS: ${MAX_BAR_ITEMS}`);
console.log("------------------------------------------------------------");

// ---------------------------------------------------------------------------
// CHECK 1-4 — per role, the split must be lossless.
// ---------------------------------------------------------------------------
for (const [role, items] of Object.entries(NAV_BY_ROLE)) {
  const { bar, more } = splitNav(items);
  const allPaths = items.map((i) => i.path);
  // The "More" button itself is a bar entry with no path, so filter nulls.
  const barPaths = bar.filter((i) => i.path).map((i) => i.path);
  const morePaths = more.map((i) => i.path);
  const reachable = [...barPaths, ...morePaths];

  const missing = allPaths.filter((p) => !reachable.includes(p));
  const invented = reachable.filter((p) => !allPaths.includes(p));
  const dupes = reachable.filter((p, i) => reachable.indexOf(p) !== i);

  const ok = !missing.length && !invented.length && !dupes.length
    && bar.length <= MAX_BAR_ITEMS;

  console.log(
    `  ${ok ? "✓" : "✗"} ${role.padEnd(11)} ` +
    `${String(items.length).padStart(2)} items → ` +
    `bar ${barPaths.length} + more ${morePaths.length} = ${reachable.length}`
  );

  assert(missing.length === 0,
    `${role}: ${missing.length} destination(s) UNREACHABLE on mobile — ${missing.join(", ")}`);
  assert(invented.length === 0,
    `${role}: nav contains path(s) not in NAV_BY_ROLE — ${invented.join(", ")}`);
  assert(dupes.length === 0,
    `${role}: duplicate destination(s) — ${[...new Set(dupes)].join(", ")}`);
  assert(bar.length <= MAX_BAR_ITEMS,
    `${role}: bottom bar holds ${bar.length} items, max is ${MAX_BAR_ITEMS} — the last ones will not fit on a 360px screen`);

  // If anything overflowed, there must be a door to it.
  if (more.length > 0) {
    const hasMoreButton = bar.some((i) => i.isMore === true);
    assert(hasMoreButton,
      `${role}: ${more.length} item(s) overflow but the bar has no "More" entry — the overflow has no door`);
  }
}

// ---------------------------------------------------------------------------
// CHECK 5 — the component must not hard-code routes.
// This is the check that keeps the other four honest over time.
// ---------------------------------------------------------------------------
console.log("------------------------------------------------------------");
if (!existsSync(COMPONENT_PATH)) {
  assert(false, "js/components/bottomnav.js does not exist — there is no mobile navigation to verify");
  console.log("  ✗ bottomnav.js not found");
} else {
  const src = readFileSync(COMPONENT_PATH, "utf8");
  // Strip comments first, or a path mentioned in an explanatory comment
  // would be reported as a hard-coded route. (A gate that cries wolf gets
  // switched off -- so it must not fire on prose.)
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const hardcoded = [...code.matchAll(/["'`](\/(?:owner|wholesaler|sales|buyer)(?:\/[a-z-]+)?)["'`]/g)]
    .map((m) => m[1]);
  const unique = [...new Set(hardcoded)];
  assert(unique.length === 0,
    `bottomnav.js hard-codes ${unique.length} route(s) — ${unique.join(", ")}. It must derive every destination from NAV_BY_ROLE, or this gate is validating a config the UI no longer obeys.`);
  console.log(`  ${unique.length === 0 ? "✓" : "✗"} bottomnav.js derives routes from config (${unique.length} hard-coded found)`);

  // It must actually import the config, not reimplement it.
  const importsConfig = /from\s+["'][^"']*nav-config\.js["']/.test(code);
  assert(importsConfig, "bottomnav.js does not import nav-config.js — it is not reading the single source of truth");
  console.log(`  ${importsConfig ? "✓" : "✗"} bottomnav.js imports nav-config.js`);
}

// ---------------------------------------------------------------------------
// VERDICT
// ---------------------------------------------------------------------------
console.log("------------------------------------------------------------");
if (failures.length === 0) {
  const total = Object.values(NAV_BY_ROLE).reduce((n, a) => n + a.length, 0);
  console.log(` ✓ PASS — ${checksRun} assertions.`);
  console.log(`   All ${total} destinations across ${Object.keys(NAV_BY_ROLE).length} roles are reachable on mobile.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${checksRun} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("");
process.exit(1);
