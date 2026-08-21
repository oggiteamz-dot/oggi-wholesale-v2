// check_barcode_roundtrip.mjs — Batch 4 gate
//
// THE RULE: a barcode this app PRINTS must be one this app can READ.
//
// That sounds obvious and is exactly what nearly went wrong. v1 printed
// Code 128-B, so copying v1 was the tempting move -- but v2's decoder
// (js/lib/barcode-decode.js) reads EAN-13 / UPC-A / EAN-8 and explicitly does
// NOT read Code 128. Following v1 would have produced labels this app's own
// camera cannot scan, and the symptom would have appeared in a warehouse:
// a phone failing to read a label the same phone printed an hour earlier.
//
// So this gate does not check the encoder against a table of expected bars.
// It renders a code, turns those modules into a real greyscale image, and
// feeds it to the ACTUAL decoder the camera uses. Encoder and decoder are
// written from the same L/G/R tables; this proves they are genuine inverses
// rather than two files that merely look alike.
//
// Usage:  node checks/check_barcode_roundtrip.mjs

import { ean13CheckDigit, isValidEan13, ean13Modules, renderEan13Svg, isInternalBarcode }
  from "../js/lib/barcode-ean13.js";
import { checkDigitOk, decodeImageData } from "../js/lib/barcode-decode.js";

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log("  PASS  " + m); };
const bad = (m) => { fail++; console.log("  FAIL  " + m); };

/** Turn a module string into ImageData, as a camera would see it printed. */
function rasterise(modules, { scale = 3, height = 40, quiet = 11 } = {}) {
  const width = (quiet * 2 + modules.length) * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== "1") continue;
    for (let s = 0; s < scale; s++) {
      const x = (quiet + i) * scale + s;
      for (let y = 0; y < height; y++) {
        const p = (y * width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
        data[p + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

// A full 12-digit body -> a valid EAN-13, the way migration 076 mints them.
const mint = (body12) => body12 + String(ean13CheckDigit(body12));

/**
 * An EAN-13 whose first digit is 0 IS a UPC-A, and barcode-decode.js returns
 * it in that 12-digit form -- deliberately, and its header says so. That is a
 * true fact about the symbology, not a defect, so the comparison has to know
 * it. (Migration 076 mints codes with prefix "20", so this never arises in
 * real use; the gate covers it because a gate that asserts something false is
 * worse than no gate.)
 */
const sameCode = (want, got) =>
  got === want || (want.startsWith("0") && got === want.slice(1));

// ---------------------------------------------------------------- 1
// Every first digit 0-9, so all ten L/G parity patterns are exercised. A
// parity table that is wrong in ONE row produces a barcode that scans
// correctly nine times out of ten -- the hardest kind of fault to trace.
let parityFails = [];
for (let d = 0; d <= 9; d++) {
  const code = mint(String(d) + "01234567890".slice(0, 11));
  const got = decodeImageData(rasterise(ean13Modules(code)));
  if (!sameCode(code, got)) parityFails.push(`${code} -> ${got}`);
}
if (parityFails.length) bad(`parity patterns: ${parityFails.length}/10 first digits failed to round-trip (${parityFails[0]})`);
else ok("all ten L/G parity patterns round-trip through the real decoder (0-prefixed codes correctly read back as UPC-A)");

// ---------------------------------------------------------------- 2
// Edge bodies: all zeros, all nines, alternating.
const edges = ["000000000000", "999999999999", "010101010101", "200000000000"].map((b) => mint(b));
let edgeFails = [];
for (const code of edges) {
  const got = decodeImageData(rasterise(ean13Modules(code)));
  if (!sameCode(code, got)) edgeFails.push(`${code} -> ${got}`);
}
if (edgeFails.length) bad(`edge codes failed: ${edgeFails.join(", ")}`);
else ok("all-zero, all-nine, alternating and internal-prefix codes all round-trip");

// ---------------------------------------------------------------- 3
// A spread of internal codes in the shape migration 076 actually mints:
// prefix "20" + a 10-digit serial.
let mintFails = 0;
for (let n = 1; n <= 60; n++) {
  const code = mint("20" + String(n).padStart(10, "0"));
  if (!sameCode(code, decodeImageData(rasterise(ean13Modules(code))))) mintFails++;
}
if (mintFails) bad(`${mintFails} of 60 minted internal barcodes did not round-trip`);
else ok("60 consecutive minted internal barcodes all round-trip");

// ---------------------------------------------------------------- 4
// The two check-digit implementations must agree. One lives in this repo's
// decoder, the other in the encoder and in SQL (migration 076). Three copies
// of one rule is exactly where drift hides.
let cdFails = 0;
for (let n = 0; n < 200; n++) {
  const body = String(n * 7919).padStart(12, "0").slice(-12);
  const code = mint(body);
  if (!checkDigitOk(code)) cdFails++;
  if (!isValidEan13(code)) cdFails++;
}
if (cdFails) bad(`${cdFails} check-digit disagreements between encoder and decoder`);
else ok("encoder and decoder agree on the check digit across 200 codes");

// ---------------------------------------------------------------- 5
// A wrong check digit must be REJECTED, or the checksum is decoration.
const good = mint("2000000000042");
const wrong = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
if (isValidEan13(wrong)) bad("a code with a deliberately wrong check digit was accepted");
else ok("a wrong check digit is rejected (the checksum actually checks)");

// ---------------------------------------------------------------- 6
// The SVG must carry its quiet zones. A barcode printed hard against a
// border is the classic "scans on some labels and not others" fault.
const svg = renderEan13Svg(mint("200000000123"), { moduleWidth: 2 });
const widthAttr = Number((svg.match(/width="(\d+)"/) || [])[1]);
const expected = (11 + 95 + 7) * 2;
if (widthAttr !== expected) bad(`SVG width ${widthAttr}, expected ${expected} -- quiet zones missing or wrong`);
else ok(`SVG includes both quiet zones (11 leading, 7 trailing modules)`);

// ---------------------------------------------------------------- 7
// Guard bars must extend below the digit bars, which is how a scanner finds
// the frame at an angle.
const heights = [...svg.matchAll(/height="(\d+)"/g)].map((m) => Number(m[1]));
if (new Set(heights).size < 3) bad("guard bars are not drawn longer than digit bars");
else ok("guard bars run longer than digit bars");

// ---------------------------------------------------------------- 8
// Refuse to draw nonsense rather than drawing something unscannable.
if (renderEan13Svg("123") !== null || ean13Modules("not-a-code") !== null) {
  bad("an invalid code produced output instead of null");
} else ok("an invalid code renders nothing at all, rather than an unscannable label");

// ---------------------------------------------------------------- 9
if (!isInternalBarcode(mint("200000000999")) || isInternalBarcode(mint("500000000999"))) {
  bad("internal-range detection is wrong");
} else ok("internal (GS1 restricted-circulation) codes are told apart from real GTINs");

console.log("\n" + (fail ? ` ✗ FAIL — ${fail} failed, ${pass} passed` : ` ✓ PASS — ${pass} assertions.`));
process.exit(fail ? 1 : 0);
