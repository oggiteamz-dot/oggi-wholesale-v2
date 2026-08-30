// =============================================================================
// OGGI Wholesale v2 — GATE 5: DESIGN TOKEN COMPLETENESS
// =============================================================================
//
// WHY THIS EXISTS — a real failure, not a hypothetical
// ---------------------------------------------------
// On 17 Aug 2026, during the OGGI brand pass, css/tokens.css was rewritten to
// carry the "Eyes Everywhere" palette. The rewrite reproduced the parts of the
// file its author was thinking about -- colours, radius, type, motion -- and
// silently dropped the entire spacing scale, --space-1 through --space-16.
//
// Nothing errored. CSS does not warn about an undefined custom property; it
// just resolves to nothing. Every `padding: var(--space-5)` in the app
// collapsed to zero and the whole UI went edge-to-edge.
//
// It was caught by looking at a screenshot. That is too thin a thread.
//
// This is the SAME failure mode as the 2.0 rewrite dropping the size axis, and
// the same one that cost Sonos "at least $100 million" in 2024: a rewrite
// reproduces what the author remembered and drops the rest. Gate 1
// (check_no_feature_loss.sh) exists for exactly this, but it protects js/ --
// features live there. It has no opinion about css/, because the mobile-first
// pass needs to edit CSS freely.
//
// So this gate is Gate 1's counterpart for the stylesheet: it does not care
// what a token's VALUE is (the brand pass changes every colour on purpose),
// only that no token DISAPPEARS.
//
// HOW IT WORKS
//   - checks/token-manifest.json lists every custom property that must exist.
//   - This gate reads css/tokens.css and fails if any is missing.
//   - Adding a token is always fine. Removing one requires editing the
//     manifest, which is a visible, reviewable decision rather than an
//     accident.
//   - It also scans the OTHER stylesheets for var(--x) references and fails
//     if any of them points at a token that does not exist. That catches the
//     inverse mistake: a rule referring to a token nobody ever defined.
//
// REGENERATE THE MANIFEST (only when deliberately removing a token):
//   node checks/check_token_completeness.mjs --write
//
// RUN:  node checks/check_token_completeness.mjs
// PROVEN TO GO RED — it was written against the broken file and reported all
// 11 missing --space-* tokens by name. See checks/GATE-EVIDENCE.md.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_FILE = join(ROOT, "css/tokens.css");
const MANIFEST = join(ROOT, "checks/token-manifest.json");
const CSS_DIR = join(ROOT, "css");

const write = process.argv.includes("--write");

// --- Which tokens does tokens.css actually define right now? ----------------
const tokensCss = readFileSync(TOKENS_FILE, "utf8");
const defined = new Set(
  [...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
);

console.log("============================================================");
console.log(" GATE 5 — DESIGN TOKEN COMPLETENESS");
console.log("============================================================");
console.log(` css/tokens.css defines ${defined.size} tokens`);

if (write) {
  const list = [...defined].sort();
  writeFileSync(MANIFEST, JSON.stringify({ tokens: list }, null, 2) + "\n");
  console.log(` ✓ Wrote checks/token-manifest.json with ${list.length} tokens.`);
  console.log("   Commit this deliberately — it is the record of what must not vanish.");
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.log("\n  ✗ checks/token-manifest.json does not exist.");
  console.log("    Create it once from a known-good tokens.css:");
  console.log("      node checks/check_token_completeness.mjs --write");
  process.exit(1);
}

const required = JSON.parse(readFileSync(MANIFEST, "utf8")).tokens;
const failures = [];

// --- CHECK 1: nothing from the manifest has gone missing --------------------
const missing = required.filter((t) => !defined.has(t));
console.log("------------------------------------------------------------");
if (missing.length) {
  // Group by prefix, because a dropped SECTION is the real failure mode and
  // reads much more clearly than 11 unrelated-looking names.
  const groups = {};
  for (const t of missing) {
    const key = t.replace(/^--/, "").split("-")[0];
    (groups[key] ||= []).push(t);
  }
  console.log(`  ✗ ${missing.length} token(s) MISSING from css/tokens.css:\n`);
  for (const [g, list] of Object.entries(groups)) {
    console.log(`      --${g}-*  (${list.length}):  ${list.join(", ")}`);
  }
  failures.push(`${missing.length} token(s) removed from tokens.css: ${missing.join(", ")}`);
} else {
  console.log(`  ✓ all ${required.length} required tokens still defined`);
}

const added = [...defined].filter((t) => !required.includes(t));
if (added.length) {
  console.log(`  + ${added.length} new token(s): ${added.join(", ")}`);
  console.log(`    (additions are fine — run with --write to record them)`);
}

// --- CHECK 2: no stylesheet references a token that does not exist ----------
// The inverse mistake: a rule using var(--brand-ink) when nobody defined it.
const dangling = new Map();
// A token named inside a /* comment */ is NOT a usage. The browser never
// resolves it, so it cannot collapse a padding or lose a colour -- and this
// gate exists to catch things that break the rendered page, not things that
// appear in prose. This matters because the honest way to record a token
// decision is to write down the wrong version next to the right one
// ("this said var(--danger, #b42318); --danger has never existed here"), and
// a scanner that reads comments punishes exactly that documentation. Stripping
// comments first costs the gate nothing: CHECK 2 below still sees every live
// var() reference, as the red proof in checks/GATE-EVIDENCE.md shows.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");

// ==== AND THE STYLESHEETS ARE NOT WHERE ALL THE TOKENS ARE ==================
//
// WIDENED 30 Aug 2026, because this gate had a blind spot the width of the
// application. It read css/ only, and this app writes a great deal of style
// inline from JavaScript -- `style.cssText`, and style="" inside template
// literals. `--surface-sunken` was referenced in FIVE such places across four
// view files, has NEVER been defined in tokens.css, and had been quietly
// falling back to a hardcoded `#f7f7f5` while the rest of the app used
// `--bg-sunken` for the same surface. Nothing said a word, for weeks, because
// the gate was looking at the wrong files.
//
// It was found while replacing two hand-rolled approval panels with one shared
// component -- the two copies had drifted, and this was HOW they had drifted.
//
// The js/ scan is deliberately the same regex on the same stripped text. A
// second, cleverer matcher for "the same question, over there" is how two
// answers to one question start.
//
// ==== WHAT THE WIDENING FOUND, AND WHY THERE IS AN ALLOWLIST ===============
//
// Turning the scan on js/ did not find one stray token. It found ELEVEN,
// referenced from more than twenty files, every one of them with a hardcoded
// fallback doing the actual work:
//
//     --danger --danger-600 --danger-bg --success --success-600
//     --warning --warning-600 --info-600 --surface --surface-2 --surface-subtle
//
// tokens.css defines --danger-700, --success-700, --bg-surface-2 and so on. The
// inline styles reach for names from an older palette that this repo has never
// had, and CSS answers an undefined custom property with silence, so the
// fallback renders and nothing is ever wrong out loud.
//
// THEY ARE NOT FIXED HERE, AND THEY ARE NOT HIDDEN EITHER. Rewriting eleven
// colours across twenty files is a visual change to most of the application,
// made in one night, that nobody can review until morning -- and this gate's
// whole purpose is to stop colour changes nobody decided. So they are named
// below, with the date, and the gate is GREEN on exactly these and RED on a
// twelfth. Same posture as check_single_low_stock_threshold.sh, which
// allowlists its one known duplicate rather than pretending it is not there.
//
// THE LIST CANNOT ROT. An entry that is no longer used anywhere fails the gate
// too, so the allowlist shrinks as the tokens get fixed and cannot quietly
// become a graveyard. `--surface-sunken` was on this list when it was written
// and came straight off it, because all five of its uses were repointed at
// `--bg-sunken` in the same change.
const LEGACY_INLINE_TOKENS = new Set([
  "--danger", "--danger-600", "--danger-bg",
  "--success", "--success-600",
  "--warning", "--warning-600",
  "--info-600",
  "--surface", "--surface-2", "--surface-subtle",
]);

const JS_DIR = join(ROOT, "js");
const jsFiles = [];
(function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), rel + e.name + "/");
    else if (e.name.endsWith(".js")) jsFiles.push([rel + e.name, join(dir, e.name)]);
  }
})(JS_DIR, "js/");

const sources = [
  ...readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"))
      .map((f) => ["css/" + f, join(CSS_DIR, f)]),
  ...jsFiles,
];

for (const [label, path] of sources) {
  // JS carries `//` comments as well as `/* */`, and the same reasoning applies:
  // writing down the wrong token beside the right one must not fail the gate.
  const text = stripComments(readFileSync(path, "utf8"))
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?:,|\))/g)) {
    const name = m[1];
    if (!defined.has(name)) {
      if (!dangling.has(name)) dangling.set(name, new Set());
      dangling.get(name).add(label);
    }
  }
}
// An allowlisted token is tolerated ONLY in inline styles inside js/. If one
// ever appears in a stylesheet, that is a new decision in the place where
// colour decisions belong and it goes through the front door.
const real = new Map();
for (const [name, files] of dangling) {
  const inCss = [...files].filter((f) => f.startsWith("css/"));
  if (!LEGACY_INLINE_TOKENS.has(name)) real.set(name, files);
  else if (inCss.length) real.set(name, new Set(inCss));
}

if (real.size) {
  console.log(`\n  ✗ ${real.size} token(s) USED but never defined:\n`);
  for (const [name, files] of real) {
    console.log(`      ${name}  — used in ${[...files].join(", ")}`);
  }
  failures.push(`${real.size} undefined token(s) referenced: ${[...real.keys()].join(", ")}`);
} else {
  console.log(`  ✓ every var(--token) in css/ AND js/ resolves to a defined token`);
  console.log(`    (${sources.length} files; ${LEGACY_INLINE_TOKENS.size} known inline legacy tokens allowlisted by name)`);
}

// The allowlist must describe reality in BOTH directions. An entry nobody uses
// any more is a line that stops being true, and a list that is allowed to stop
// being true is the thing this file exists to prevent one level down.
const unusedLegacy = [...LEGACY_INLINE_TOKENS].filter((t) => !dangling.has(t));
if (unusedLegacy.length) {
  console.log(`\n  ✗ ${unusedLegacy.length} allowlisted token(s) are no longer used anywhere — delete them from LEGACY_INLINE_TOKENS:\n`);
  console.log(`      ${unusedLegacy.join(", ")}`);
  failures.push(`the legacy-token allowlist has ${unusedLegacy.length} stale entr(ies): ${unusedLegacy.join(", ")}`);
} else {
  console.log("  ✓ ...and every allowlisted legacy token is still genuinely in use");
}

console.log("------------------------------------------------------------");
if (!failures.length) {
  console.log(" ✓ PASS — no token was lost.");
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} problem(s):\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("\n   CSS does not warn about an undefined custom property. It");
console.log("   resolves to nothing, so a dropped spacing token silently");
console.log("   collapses every padding in the app to zero. That is why this");
console.log("   is a build gate and not a code review item.\n");
process.exit(1);
