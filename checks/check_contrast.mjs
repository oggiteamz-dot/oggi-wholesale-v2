// =============================================================================
// OGGI Wholesale v2 — GATE 4: COLOUR CONTRAST
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// OGGI's brand colour is vivid mint, #54E5A0. On white it has a contrast ratio
// of roughly 1.7 to 1. WCAG 2.2 AA requires 4.5 for normal text and 3.0 for
// interactive components and large text.
//
// So the single most obvious way to "make it look like OGGI" -- paint the
// buttons and the links mint -- produces an app that is genuinely hard to read
// in daylight, on a phone, which is where most of these users are. The brand
// PDFs never do this either: mint is used as a highlight ON DARK, not as text
// on white. Deep emerald #00845F is the colour that carries text and buttons.
//
// This gate makes that mistake impossible to ship by accident. It parses the
// real token file and checks the pairs the app actually renders.
//
// WHAT IT CHECKS
//   - body text on both page and card backgrounds
//   - secondary and tertiary text (the ones that always slip)
//   - links
//   - white text on the primary button colour
//   - the active bottom-nav tab against the bar background
//   - focus rings and borders against their surfaces (3.0 UI threshold)
//   - white and mint on the dark brand gradient's two ends
//
// THRESHOLDS (WCAG 2.2)
//   4.5 : normal text (AA, SC 1.4.3)
//   3.0 : large text (>=24px, or >=18.66px bold) and non-text UI (SC 1.4.11)
//
// RUN:  node checks/check_contrast.mjs
// PROVEN TO GO RED -- see checks/GATE-EVIDENCE.md. It was run against a
// deliberately mint-on-white button first, and reported 1.66:1.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = join(ROOT, "css/tokens.css");

// --- WCAG relative luminance and contrast ratio (per the spec, not eyeballed) -
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function ratio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// --- Read the real tokens, so this can never drift from what ships ----------
const css = readFileSync(TOKENS, "utf8");
const T = {};
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) T[m[1]] = m[2];

function tok(name) {
  if (!T[name]) { console.log(`  ✗ token ${name} not found in css/tokens.css`); process.exit(1); }
  return T[name];
}

// --- The pairs the app actually renders -------------------------------------
// Each entry: [description, foreground token, background token, threshold]
const PAIRS = [
  ["body text on page background",        "--text-primary",   "--bg-page",      4.5],
  ["body text on card",                   "--text-primary",   "--bg-surface",   4.5],
  ["secondary text on card",              "--text-secondary", "--bg-surface",   4.5],
  ["tertiary text on card",               "--text-tertiary",  "--bg-surface",   4.5],
  ["tertiary text on sunken panel",       "--text-tertiary",  "--bg-sunken",    4.5],
  ["link on card",                        "--text-link",      "--bg-surface",   4.5],
  ["white on primary button",             "--text-inverse",   "--accent-600",   4.5],
  ["accent text on card",                 "--accent-600",     "--bg-surface",   4.5],
  ["accent text on its own tint",         "--accent-700",     "--accent-50",    4.5],
  // Non-text / UI components and large text -> 3.0 threshold (SC 1.4.11)
  ["focus ring on card",                  "--accent-500",     "--bg-surface",   3.0],
  ["strong border on card",               "--border-strong",  "--bg-surface",   3.0],
  ["success text on its tint",            "--success-700",    "--success-50",   4.5],
  ["warning text on its tint",            "--warning-700",    "--warning-50",   4.5],
  ["danger text on its tint",             "--danger-700",     "--danger-50",    4.5],
  ["info text on its tint",               "--info-700",       "--info-50",      4.5],
  // The dark brand surface (topbar). Mint is legitimate HERE and only here.
  ["white on brand dark",                 "--text-inverse",   "--brand-ink",    4.5],
  ["mint on brand dark",                  "--brand-mint",     "--brand-ink",    4.5],
  ["white on brand deep",                 "--text-inverse",   "--brand-emerald", 4.5],
];

console.log("============================================================");
console.log(" GATE 4 — COLOUR CONTRAST (WCAG 2.2 AA)");
console.log("============================================================");
console.log(" Source: css/tokens.css");
console.log("------------------------------------------------------------");

const failures = [];
for (const [label, fgName, bgName, need] of PAIRS) {
  const fg = tok(fgName), bg = tok(bgName);
  const r = ratio(fg, bg);
  const ok = r >= need;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label.padEnd(34)} ${r.toFixed(2).padStart(5)}:1  ` +
    `(need ${need.toFixed(1)})  ${fg} on ${bg}`
  );
  if (!ok) failures.push(`${label}: ${r.toFixed(2)}:1, needs ${need}:1 — ${fg} on ${bg}`);
}

// ---------------------------------------------------------------------------
// THE MINT RULE.
// Mint is a highlight colour. It is allowed on dark surfaces and as a
// decorative accent. It must never be assigned to a token whose job is to
// carry text or a filled button on a light background, because it cannot
// reach 4.5:1 against white no matter how it is used.
// ---------------------------------------------------------------------------
const MINT = "#54E5A0";
const TEXT_BEARING = ["--text-primary", "--text-secondary", "--text-link", "--accent-600", "--accent-700"];
for (const name of TEXT_BEARING) {
  if ((T[name] || "").toLowerCase() === MINT.toLowerCase()) {
    failures.push(`${name} is set to mint ${MINT}. Mint is 1.66:1 on white — it can never carry text on a light surface. Use --brand-emerald #00845F for text and buttons; mint belongs on dark or as a decorative accent.`);
    console.log(`  ✗ MINT RULE: ${name} = ${MINT}`);
  }
}

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${PAIRS.length} pairs, all at or above their WCAG AA threshold.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${PAIRS.length} pairs below threshold:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("");
process.exit(1);
