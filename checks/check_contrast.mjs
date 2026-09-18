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
  // CORRECTED 18 Sep 2026: was --text-inverse. That token means "text on a dark
  // brand surface" (its four uses are all on brand-ink or the gradient band) and
  // in dark mode it has to be white, which then measured 2.8:1 on the dark
  // accent. The button's foreground is --accent-fg and always was.
  ["text on primary button",              "--accent-fg",      "--accent-600",   4.5],
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


// =============================================================================
// EVERY OTHER THEME — added 18 Sep 2026
// =============================================================================
//
// WHY. Until today this gate checked ONE palette: the house emerald, in light.
// The v3 art direction ships a dark theme and THIRTEEN alternate palettes, and
// not one of their ~180 colour pairs had ever been measured. On the Awda build
// the same omission produced SIX failing palettes out of seventeen, and every
// single failure was a light one -- which is exactly the case a designer's eye
// forgives and a phone in Beirut daylight does not.
//
// A contrast floor has to be MEASURED, not asserted. So the same pairs run
// again for every theme, with each theme's own values layered over the house
// defaults, and one bad pair in one palette nobody has selected yet fails the
// whole build.
//
// TWO PARSING DETAILS THAT MATTER
// 1. Dark mode writes its secondary and tertiary ink as rgba() over the
//    surface, not as hex. A hex-only regex silently falls back to the LIGHT
//    value and then reports "#3C4D58 on #0C1A17 — 2.04:1", a failure that does
//    not exist. rgba is parsed and composited against its own background.
// 2. theme-dark.css defines the same block twice on purpose (a media query for
//    system-dark, an attribute selector for the toggle). Only the explicit
//    :root[data-theme="dark"] block is read, or every token would be counted
//    twice and the second copy would win regardless of which is correct.
// =============================================================================

function parseColours(text) {
  const out = {};
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))\s*;/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Flatten an rgba() over an opaque background so it can be measured.
 *  A translucent ink is not a colour until you know what is behind it. */
function flatten(value, bgHex) {
  if (!value) return null;
  if (value.startsWith("#")) return value;
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  const b = bgHex.replace("#", "");
  const full = b.length === 3 ? b.split("").map((x) => x + x).join("") : b;
  const br = parseInt(full.slice(0, 2), 16), bg = parseInt(full.slice(2, 4), 16), bb = parseInt(full.slice(4, 6), 16);
  const mix = (f, bk) => Math.round(a * parseFloat(f) + (1 - a) * bk);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return "#" + hex(mix(m[1], br)) + hex(mix(m[2], bg)) + hex(mix(m[3], bb));
}

// The same questions as above, but asked against tokens every theme actually
// overrides. --brand-ink is NOT used here: a palette moves --bg-chrome, so
// asking about --brand-ink would measure this palette's mint on the house's
// ink -- a pair that is never rendered.
const THEME_PAIRS = [
  ["body text on page",        "--text-primary",   "--bg-page",     4.5],
  ["body text on card",        "--text-primary",   "--bg-surface",  4.5],
  ["secondary text on card",   "--text-secondary", "--bg-surface",  4.5],
  ["tertiary text on card",    "--text-tertiary",  "--bg-surface",  4.5],
  ["tertiary on sunken",       "--text-tertiary",  "--bg-sunken",   4.5],
  ["link on card",             "--text-link",      "--bg-surface",  4.5],
  ["text on primary button",   "--accent-fg",      "--accent-600",  4.5],
  ["accent text on card",      "--accent-600",     "--bg-surface",  4.5],
  ["accent text on its tint",  "--accent-700",     "--accent-50",   4.5],
  ["focus ring on card",       "--accent-500",     "--bg-surface",  3.0],
  ["strong border on card",    "--border-strong",  "--bg-surface",  3.0],
  ["ink-band text on chrome",  "--text-inverse",   "--bg-chrome",   4.5],
  ["highlight on chrome",      "--accent-300",     "--bg-chrome",   3.0],
];

function checkTheme(label, overrides) {
  const V = { ...T, ...overrides };
  let bad = 0, run = 0;
  for (const [what, fgName, bgName, need] of THEME_PAIRS) {
    const bgRaw = V[bgName];
    if (!bgRaw) continue;                       // theme does not use this surface
    const bg = flatten(bgRaw, "#FFFFFF");
    const fg = flatten(V[fgName], bg);
    if (!fg || !bg) continue;
    run++;
    const r = ratio(fg, bg);
    if (r < need) {
      bad++;
      failures.push(`${label} — ${what}: ${r.toFixed(2)}:1, needs ${need}:1 (${fg} on ${bg})`);
    }
  }
  console.log(`  ${bad ? "✗" : "✓"} ${label.padEnd(28)} ${String(run).padStart(2)} pairs` +
              (bad ? `, ${bad} BELOW THRESHOLD` : ", all pass"));
  return run;
}

console.log("------------------------------------------------------------");
console.log(" DARK THEME AND THE THIRTEEN PALETTES");
console.log("------------------------------------------------------------");

let themePairs = 0, themeCount = 0;

// --- dark: read ONLY the explicit toggle block, never the media query copy ---
const darkFile = readFileSync(join(ROOT, "css/theme-dark.css"), "utf8");
const darkBlock = darkFile.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
if (!darkBlock) {
  failures.push("css/theme-dark.css has no :root[data-theme=\"dark\"] block — the toggle would do nothing.");
  console.log("  ✗ dark theme                  NOT FOUND");
} else {
  themePairs += checkTheme("dark", parseColours(darkBlock[1]));
  themeCount++;
}

// --- the palettes ------------------------------------------------------------
const palFile = readFileSync(join(ROOT, "css/palettes.css"), "utf8");
const palBlocks = [...palFile.matchAll(/\[data-palette="([a-z0-9-]+)"\]\s*\{([\s\S]*?)\n\}/g)];
if (palBlocks.length === 0) {
  failures.push("css/palettes.css defines no palettes — the switcher has nothing to switch to.");
}
for (const [, name, body] of palBlocks) {
  themePairs += checkTheme(`palette · ${name}`, parseColours(body));
  themeCount++;
}
console.log(`------------------------------------------------------------`);
console.log(` ${themeCount} extra themes, ${themePairs} extra pairs measured.`);

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${PAIRS.length + themePairs} pairs across ${themeCount + 1} themes, all at or above their WCAG AA threshold.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} problem(s) across ${PAIRS.length + themePairs} pairs in ${themeCount + 1} themes:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("");
process.exit(1);
