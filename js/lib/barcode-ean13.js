// OGGI Wholesale v2 — EAN-13 label rendering (Batch 4, migration 076)
//
// The other half of js/lib/barcode-decode.js. That file reads barcodes off a
// camera; this one draws them. Measured on production before it was written:
// 0 of 191 variants carried a barcode, so the scanner had nothing to scan.
//
// WHY EAN-13 AND NOT CODE 128, WHICH IS WHAT v1 PRINTED
// -----------------------------------------------------------------------
// v1 generated Code 128-B. v1 had no camera decoder, so nothing in v1 ever
// had to read its own labels. v2 does have one, and barcode-decode.js reads
// EAN-13 / UPC-A / EAN-8 and explicitly NOT Code 128.
//
// Copying v1 would therefore have printed labels this app cannot scan. The
// symptom would have been a wholesaler in a warehouse pointing a phone at a
// label the same phone printed an hour earlier. Generate → print → scan →
// resolve is the entire feature; that loop has to close.
//
// EAN-13 prefixes 20-29 are reserved by GS1 for restricted circulation inside
// a company, which is exactly this use, and guarantees no collision with a
// real manufacturer's GTIN.
//
// This module is PURE: no imports, no I/O, no DOM. It returns SVG as a string.
// SVG rather than canvas because a barcode is line art -- a canvas bitmap
// scaled to a label printer's DPI produces soft edges, and soft edges are
// exactly what makes a scanner fail on the tenth attempt rather than the
// first, which is the worst way for this to break.

// The three digit alphabets, as 7-module patterns (1 = bar, 0 = space).
// These are byte-identical to the tables in js/lib/barcode-decode.js on
// purpose: this file must be that file's exact inverse, and the gate
// (checks/check_barcode_roundtrip.mjs) proves it by decoding what it draws.
const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];

// The first digit is never drawn. It is carried by the L/G parity pattern of
// the six left-hand digits -- which is why an EAN-13 has 12 visible digit
// positions and 13 digits.
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

/** EAN check digit over the first 12 digits. */
export function ean13CheckDigit(first12) {
  const s = String(first12 || "");
  if (!/^\d{12}$/.test(s)) return null;
  let sum = 0;
  // Weights alternate 3/1 from the RIGHT. Reversed, this is right half the
  // time -- and a checksum that is right half the time is worse than none,
  // because it earns trust it has not got.
  for (let i = 1; i <= 12; i++) {
    sum += Number(s[12 - i]) * (i % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code) {
  const s = String(code || "");
  if (!/^\d{13}$/.test(s)) return false;
  return ean13CheckDigit(s.slice(0, 12)) === Number(s[12]);
}

/** True for a code this system minted itself (GS1 restricted circulation). */
export function isInternalBarcode(code) {
  return /^2\d{12}$/.test(String(code || ""));
}

/**
 * The 95 modules of an EAN-13, as a string of "1" and "0".
 *   start guard (101) + 6 left digits + centre guard (01010)
 *   + 6 right digits + end guard (101)
 */
export function ean13Modules(code) {
  const s = String(code || "");
  if (!isValidEan13(s)) return null;
  const first = Number(s[0]);
  const parity = PARITY[first];
  let out = "101";
  for (let i = 0; i < 6; i++) {
    const d = Number(s[1 + i]);
    out += parity[i] === "L" ? L[d] : G[d];
  }
  out += "01010";
  for (let i = 0; i < 6; i++) out += R[Number(s[7 + i])];
  out += "101";
  return out;
}

/**
 * An EAN-13 as standalone SVG.
 *
 * The quiet zones are not decoration. A scanner needs clear space either side
 * to find the start guard at all, and a barcode printed hard against a border
 * is the classic "it scans on some labels and not others" fault. GS1 specifies
 * 11 modules leading and 7 trailing; both are included and neither is
 * negotiable, which is why they are not options.
 */
export function renderEan13Svg(code, {
  moduleWidth = 2,      // px per module; 2 is ~0.66mm at 96dpi, comfortably scannable
  height = 60,          // bar height, excluding the text line
  showText = true,
  quietLeft = 11,
  quietRight = 7,
} = {}) {
  const modules = ean13Modules(code);
  if (!modules) return null;
  const s = String(code);
  const textH = showText ? 14 : 0;
  // Guard bars run longer than digit bars -- that is what lets a scanner find
  // the frame, and it is why the guards get their own height here.
  const guardExtra = showText ? 8 : 0;
  const totalModules = quietLeft + modules.length + quietRight;
  const w = totalModules * moduleWidth;
  const h = height + textH;

  const isGuard = (i) =>
    (i >= 0 && i < 3) || (i >= 45 && i < 50) || (i >= 92 && i < 95);

  let bars = "";
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== "1") continue;
    const x = (quietLeft + i) * moduleWidth;
    const barH = height + (isGuard(i) ? guardExtra : 0);
    bars += `<rect x="${x}" y="0" width="${moduleWidth}" height="${barH}" fill="#000"/>`;
  }

  let text = "";
  if (showText) {
    const fs = Math.max(9, moduleWidth * 5);
    const y = h - 1;
    // Digit 1 sits in the left quiet zone, then 6 and 6 either side of the
    // centre guard -- the standard human-readable layout, which is also how a
    // person reads a code aloud when a scanner will not cooperate.
    text =
      `<text x="0" y="${y}" font-family="monospace" font-size="${fs}">${s[0]}</text>` +
      `<text x="${(quietLeft + 3) * moduleWidth}" y="${y}" font-family="monospace" font-size="${fs}">${s.slice(1, 7)}</text>` +
      `<text x="${(quietLeft + 50) * moduleWidth}" y="${y}" font-family="monospace" font-size="${fs}">${s.slice(7)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Barcode ${s}">` +
         `<rect width="${w}" height="${h}" fill="#fff"/>${bars}${text}</svg>`;
}
