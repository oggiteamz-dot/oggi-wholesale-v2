// check_barcode_decode.mjs — proves the bundled decoder actually decodes.
//
// The decoder in js/lib/barcode-decode.js exists because two of Hadi's three
// target platforms (Safari iOS and Chrome iOS, which share WebKit) have no
// native BarcodeDetector, and neither does desktop Chrome. So on most of his
// customers' devices THIS code is the scanner. A hand-written decoder that has
// only been eyeballed is not something to put in front of a warehouse.
//
// The generator below renders EAN-13 the same way a label printer does, from
// the symbology tables, INDEPENDENTLY of the decoder's own tables — it builds
// bars from the published patterns and the decoder reads pixels back. If both
// shared one table a transposed row would cancel out and every test would pass
// against a barcode no real scanner could read.
//
// Cases are chosen to be adversarial, not convenient:
//   - all six parity patterns for the implicit first digit
//   - UPC-A, which must come back 12 digits and not 13
//   - upside down, since half of all scans of a hanging tag are inverted
//   - a bad check digit, which MUST be refused: a misread is far worse than a
//     failure to read, because it silently attaches a wrong code to a garment
//   - noise and low contrast, the conditions a phone camera actually produces
//
// Usage:  node checks/check_barcode_decode.mjs

import { decodeImageData, checkDigitOk } from "../js/lib/barcode-decode.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };

const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const PAR = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function ean13Check(twelve) {
  let sum = 0;
  twelve.split("").reverse().forEach((c, i) => { sum += Number(c) * (i % 2 === 0 ? 3 : 1); });
  return String((10 - (sum % 10)) % 10);
}

/** Build the 95-module bit string for a full EAN-13. */
function modulesFor(code13) {
  const first = Number(code13[0]);
  const leftDigits = code13.slice(1, 7).split("").map(Number);
  const rightDigits = code13.slice(7).split("").map(Number);
  const parity = PAR[first];
  let bits = "101";
  leftDigits.forEach((d, i) => { bits += parity[i] === "L" ? L[d] : G[d]; });
  bits += "01010";
  rightDigits.forEach((d) => { bits += R[d]; });
  bits += "101";
  return bits;
}

/** Render modules to ImageData-like pixels, with options a camera would impose. */
function render(bits, { scale = 3, height = 60, quiet = 12, invert = false, noise = 0, contrast = 1 } = {}) {
  const width = (bits.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mod = Math.floor(x / scale) - quiet;
      let bar = mod >= 0 && mod < bits.length ? bits[mod] === "1" : false;
      if (invert) bar = !bar;
      let v = bar ? 0 : 255;
      if (contrast < 1) {
        const midpoint = 128;
        v = midpoint + (v - midpoint) * contrast;
      }
      if (noise) v += (((x * 7 + y * 13) % 17) - 8) * noise;
      v = Math.max(0, Math.min(255, v));
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

console.log("================================================================");
console.log(" CHECK — the bundled barcode decoder");
console.log("================================================================");

// --- every parity family, so the implicit first digit is exercised ---------
for (let firstDigit = 0; firstDigit <= 9; firstDigit++) {
  const body = String(firstDigit) + "12345" + "67890";       // 11 digits after first
  const twelve = (String(firstDigit) + "1234567890").slice(0, 12).padEnd(12, "0");
  const code = twelve + ean13Check(twelve);
  const got = decodeImageData(render(modulesFor(code)));
  const expected = code[0] === "0" ? code.slice(1) : code;
  ok(got === expected, `EAN-13 starting ${firstDigit} decodes (${expected} -> ${got})`);
}

// --- UPC-A must come back as printed: 12 digits, no leading zero ----------
const upcTwelve = "03600029145";
const upc = ("0" + upcTwelve).slice(0, 12);
const upc13 = upc + ean13Check(upc);
const upcGot = decodeImageData(render(modulesFor(upc13)));
ok(upcGot === upc13.slice(1),
  `UPC-A reads back as the 12 digits printed on the product, not 13 (${upc13.slice(1)} -> ${upcGot})`);

// --- upside down ----------------------------------------------------------
const t = "5901234123457";
const flipped = render(modulesFor(t));
// Reverse the pixel rows horizontally to simulate a rotated label.
const rev = { width: flipped.width, height: flipped.height, data: new Uint8ClampedArray(flipped.data.length) };
for (let y = 0; y < flipped.height; y++) {
  for (let x = 0; x < flipped.width; x++) {
    const from = (y * flipped.width + (flipped.width - 1 - x)) * 4;
    const to = (y * flipped.width + x) * 4;
    rev.data[to] = flipped.data[from];
    rev.data[to + 1] = flipped.data[from + 1];
    rev.data[to + 2] = flipped.data[from + 2];
    rev.data[to + 3] = 255;
  }
}
ok(decodeImageData(rev) === t, `an upside-down barcode still decodes (${t})`);

// --- camera-like degradation ---------------------------------------------
ok(decodeImageData(render(modulesFor(t), { noise: 3 })) === t, "decodes through sensor noise");
ok(decodeImageData(render(modulesFor(t), { contrast: 0.45 })) === t, "decodes at 45% contrast (dim shelf lighting)");
ok(decodeImageData(render(modulesFor(t), { scale: 1 })) === t, "decodes at 1 pixel per module (far from the label)");

// --- THE ONE THAT MATTERS MOST: a bad check digit must be REFUSED ---------
// A misread is worse than a failure. A failure asks the person to scan again;
// a misread silently attaches the wrong code to a garment.
const goodTwelve = "590123412345";
const badCode = goodTwelve + String((Number(ean13Check(goodTwelve)) + 1) % 10);
ok(!checkDigitOk(badCode), `a wrong check digit is rejected by the checksum (${badCode})`);
const badRead = decodeImageData(render(modulesFor(badCode)));
ok(badRead === null, `and a barcode carrying it decodes to nothing rather than to a wrong code (got ${badRead})`);

// --- a blank frame is not a barcode ---------------------------------------
const blank = { width: 200, height: 60, data: new Uint8ClampedArray(200 * 60 * 4).fill(255) };
for (let i = 3; i < blank.data.length; i += 4) blank.data[i] = 255;
ok(decodeImageData(blank) === null, "a blank frame decodes to nothing");

console.log("----------------------------------------------------------------");
console.log(fail === 0 ? ` ✓ PASS — ${pass} assertions.` : ` ✗ FAIL — ${fail} of ${pass + fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
