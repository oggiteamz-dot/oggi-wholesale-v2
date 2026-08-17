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
for (const file of readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"))) {
  const css = readFileSync(join(CSS_DIR, file), "utf8");
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?:,|\))/g)) {
    const name = m[1];
    if (!defined.has(name)) {
      if (!dangling.has(name)) dangling.set(name, new Set());
      dangling.get(name).add(file);
    }
  }
}
if (dangling.size) {
  console.log(`\n  ✗ ${dangling.size} token(s) USED but never defined:\n`);
  for (const [name, files] of dangling) {
    console.log(`      ${name}  — used in ${[...files].join(", ")}`);
  }
  failures.push(`${dangling.size} undefined token(s) referenced: ${[...dangling.keys()].join(", ")}`);
} else {
  console.log("  ✓ every var(--token) in css/ resolves to a defined token");
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
