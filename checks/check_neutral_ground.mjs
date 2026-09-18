// =============================================================================
// OGGI Wholesale v2 — GATE: THE GROUND STAYS NEUTRAL
// =============================================================================
//
// THE INSTRUCTION THIS ENFORCES
// -----------------------------
// Hadi, in his own words: NO GREEN TINGE OR COLOUR WASH ACROSS THE BACKGROUND
// -- "removed completely". The page is 80-90% white and every bit of colour in
// it comes from the small drifting accent clouds in palettes.css, never from
// the sheet itself.
//
// WHY IT NEEDS A GATE AND NOT A NOTE
// ----------------------------------
// It has already been reversed once, by someone acting in good faith. The
// correction was made on 17 Sep. On 18 Sep the v3 prototype's token file was
// ported in verbatim -- the prototype IS the approved design, so copying it
// exactly felt like the careful thing to do -- and the prototype still carries
// #F4F9F7, #EDF5F1, #E4EDE9. Eleven ground and hairline tokens went green
// again in one commit, and nothing complained, because a tinge is not an error.
// It is just a slightly wrong colour, and a slightly wrong colour is invisible
// to every other gate in this directory.
//
// The lesson generalises past this one rule: the prototype is ONE EXPRESSION
// of the art direction, not the art direction. Where a source file and a
// standing instruction disagree, the instruction wins -- and the only way a
// future session reliably knows that is if the instruction is executable.
//
// HOW IT MEASURES
// ---------------
// A colour is neutral when its R, G and B channels sit within MAX_SPREAD of
// each other. #F7F8F8 has a spread of 1 and reads as white. #F4F9F7 has a
// spread of 5 and reads as faintly green next to a white card -- which is
// exactly where it appears, since every card in this app is #FFFFFF.
//
// WHAT IS DELIBERATELY NOT CHECKED
//   - the accent TINTS (--bg-tint, --accent-tint, --accent-50/100/300): chips
//     and badges are meant to carry the brand.
//   - css/palettes.css: each alternate palette carries its own hue on purpose.
//     That is what makes burgundy burgundy. This rule is about the DEFAULT.
//   - anything that is not a ground, a surface or a hairline.
//
// RUN:  node checks/check_neutral_ground.mjs
// PROVEN TO GO RED -- run it against the 18 Sep morning tokens.css and it
// reports eleven tinted tokens, led by "--bg-page #F4F9F7 spread 5 (green)".
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SPREAD = 3;

// Every token that paints a sheet, a panel or a hairline — in both themes.
const GROUND = [
  "--bg-page", "--bg-surface", "--bg-raised", "--bg-sunken", "--bg-inset",
  "--bg-surface-2", "--surface", "--surface-2", "--surface-subtle",
  "--line-hair", "--line-soft", "--line-firm", "--line-strong",
  "--border-subtle", "--border-default", "--border-strong",
];

function channels(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** Name the cast, because "spread 8" does not tell anyone what is wrong. */
function castName(r, g, b) {
  const max = Math.max(r, g, b);
  if (g === max && g > r && g > b) return "green";
  if (r === max && r > g && r > b) return "warm / red";
  if (b === max && b > r && b > g) return "cool / blue";
  if (r === max && r === g && r > b) return "yellow";
  if (g === max && g === b && g > r) return "cyan";
  if (r === max && r === b && r > g) return "magenta";
  return "tinted";
}

function scan(file, label) {
  const css = readFileSync(join(ROOT, file), "utf8");
  const found = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    found[m[1]] = m[2];              // last definition wins, as the cascade does
  }
  const bad = [];
  let checked = 0;
  for (const tok of GROUND) {
    const hex = found[tok];
    if (!hex) continue;              // not every token exists in every theme file
    checked++;
    const [r, g, b] = channels(hex);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > MAX_SPREAD) {
      bad.push({ tok, hex, spread, cast: castName(r, g, b) });
    }
  }
  console.log(`  ${bad.length ? "✗" : "✓"} ${label.padEnd(26)} ${String(checked).padStart(2)} ground tokens` +
              (bad.length ? `, ${bad.length} TINTED` : ", all neutral"));
  bad.forEach((x) =>
    console.log(`      ${x.tok.padEnd(18)} ${x.hex}  spread ${String(x.spread).padStart(2)}  (${x.cast})`)
  );
  return bad.map((x) => `${label}: ${x.tok} is ${x.hex} — ${x.cast} cast, channel spread ${x.spread} (max ${MAX_SPREAD})`);
}

console.log("============================================================");
console.log(" GATE — THE GROUND STAYS NEUTRAL");
console.log("============================================================");
console.log(" \"No green tinge or colour wash across the background.\"");
console.log(" Colour belongs to the drifting accent clouds, not to the sheet.");
console.log("------------------------------------------------------------");

const failures = [
  ...scan("css/tokens.css", "light (the default)"),
  ...scan("css/theme-dark.css", "dark"),
];

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(" ✓ PASS — every ground, surface and hairline is neutral.");
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} token(s) carry a colour cast:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
console.log("");
console.log(" If this fired after porting a design file in: that file is one");
console.log(" EXPRESSION of the art direction, not the art direction. The");
console.log(" standing instruction wins. Neutralise the token, keep the tint");
console.log(" on chips and badges where it belongs.");
console.log("");
process.exit(1);
