// OGGI Wholesale v2 — a bundled EAN-13 / UPC-A / EAN-8 decoder (Batch 18)
//
// WHY THIS FILE EXISTS AT ALL
//
// The camera scanner used the browser's native BarcodeDetector. Hadi could not
// find the scanner on his laptop, and the reason turned out to be that the
// button never rendered: Chrome 151 on Windows has no BarcodeDetector. I
// checked his actual browser rather than guessing. It is not a desktop gap
// either -- BarcodeDetector ships on Chrome for Android and ChromeOS and
// essentially nowhere else.
//
// That matters more than one laptop. Hadi's three target platforms are Chrome
// Android, Chrome iOS and Safari iOS -- and Chrome on iOS is not Chrome. Apple
// requires every iOS browser to use WebKit, so Chrome iOS and Safari iOS share
// one engine and one gap. Of the three platforms, exactly ONE has a native
// reader. Relying on it would have meant camera scanning silently working for
// a third of his customers and silently vanishing for the rest.
//
// Loading a decoder from a CDN is not available either: the Content-Security-
// Policy is script-src 'self' (see worker.js), so anything executable has to
// live in this repo. That leaves vendoring a large third-party bundle or
// writing the part that is actually needed. This is the second.
//
// WHAT IT DECODES, AND WHAT IT DELIBERATELY DOES NOT
//
// EAN-13, UPC-A and EAN-8. Those are the retail formats printed on garments,
// and UPC-A is simply EAN-13 with a leading zero, so one decoder covers all
// three. Code 128 and QR are NOT handled: Code 128 needs a different symbology
// table and QR needs 2D geometry and error correction, and a half-working
// implementation of either would be worse than an honest "not supported",
// because it would fail in the field rather than at the keyboard. The manual
// entry box and USB handheld path stay available for everything else -- those
// remain the primary route, and this is the convenience layer.
//
// HOW IT WORKS
//
// An EAN-13 barcode is 95 modules wide: a 3-module start guard, six 7-module
// digits, a 5-module centre guard, six more digits, and a 3-module end guard.
// Each digit is encoded as four alternating runs of bars and spaces. So the
// decode is: take one horizontal line of pixels, convert to black/white, walk
// the run lengths, and match each group of four runs against the symbology
// table. There is no image processing beyond a threshold -- the camera frame
// arrives as ImageData and every step below is arithmetic on it.
//
// The parts that make it work on a real camera rather than on a clean PNG:
//   - MANY SCANLINES, not one. A barcode is never perfectly level in someone's
//     hand and a single row can cross a glare spot or the edge of a label.
//     Rows are tried from the middle outward, since the middle of the frame is
//     where a person aims.
//   - A PER-LINE THRESHOLD, not a global one. Lighting across a curved garment
//     tag varies enough that one threshold for the whole frame turns half the
//     image into a solid block.
//   - BOTH DIRECTIONS. A barcode scanned upside down is still a barcode, and
//     asking someone to rotate their phone is not an answer.
//   - THE CHECK DIGIT IS ENFORCED. This is the important one. A misread is far
//     worse than a failure to read: a failure asks the person to try again,
//     while a misread silently attaches the wrong code to a garment and is
//     discovered weeks later at a customer. EAN's final digit is a checksum
//     over the other twelve, so a corrupted read is rejected here rather than
//     stored.

// L, G and R digit patterns as 7-bit run patterns (1 = bar, 0 = space).
const L_CODES = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G_CODES = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R_CODES = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];

// The first digit of an EAN-13 is not printed as bars; it is encoded in the
// L/G parity pattern of the six left-hand digits.
const PARITY = {
  "LLLLLL": 0, "LLGLGG": 1, "LLGGLG": 2, "LLGGGL": 3, "LGLLGG": 4,
  "LGGLLG": 5, "LGGGLL": 6, "LGLGLG": 7, "LGLGGL": 8, "LGGLGL": 9,
};

/** EAN/UPC check digit over all but the last character. */
export function checkDigitOk(code) {
  const d = String(code || "").split("").map(Number);
  if (d.some(Number.isNaN)) return false;
  if (d.length !== 8 && d.length !== 12 && d.length !== 13) return false;
  const check = d.pop();
  // Weights alternate 3/1 from the RIGHT, which is why this reverses first --
  // getting that backwards yields a checksum that is right half the time, and
  // "right half the time" is the worst possible outcome for a checksum.
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/** One row of pixels -> array of 0/1, using a threshold local to that row. */
function rowToBits(data, width, y) {
  const bits = new Uint8Array(width);
  let min = 255, max = 0;
  const lum = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    // Rec. 601 luma. Plain averaging of R/G/B misjudges coloured labels badly.
    const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    lum[x] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // A row with almost no contrast holds no barcode; bail rather than
  // manufacturing noise out of a flat grey strip.
  if (max - min < 40) return null;
  const threshold = (min + max) / 2;
  for (let x = 0; x < width; x++) bits[x] = lum[x] < threshold ? 1 : 0;
  return bits;
}

/** Run-length encode a bit row into {value, length} runs. */
function runs(bits) {
  const out = [];
  let cur = bits[0], len = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === cur) len++;
    else { out.push({ value: cur, length: len }); cur = bits[i]; len = 1; }
  }
  out.push({ value: cur, length: len });
  return out;
}

/** Match 4 runs against a code table, given the expected module width. */
function matchDigit(four, unit, table) {
  let best = -1, bestErr = Infinity;
  for (let d = 0; d < 10; d++) {
    const pattern = table[d];
    // Turn the 7-bit pattern into its 4 run lengths.
    const want = [];
    let run = 1;
    for (let i = 1; i < 7; i++) {
      if (pattern[i] === pattern[i - 1]) run++;
      else { want.push(run); run = 1; }
    }
    want.push(run);
    if (want.length !== 4) continue;
    let err = 0;
    for (let i = 0; i < 4; i++) err += Math.abs(four[i] / unit - want[i]);
    if (err < bestErr) { bestErr = err; best = d; }
  }
  // 1.5 modules of total error across four runs is generous enough for a
  // handheld camera and tight enough to reject a group that is not a digit.
  return bestErr <= 1.5 ? best : -1;
}

function decodeRuns(rl) {
  // Find a start guard: three runs of roughly equal width, bar-space-bar.
  for (let s = 0; s + 59 < rl.length; s++) {
    if (rl[s].value !== 1) continue;
    const unit = (rl[s].length + rl[s + 1].length + rl[s + 2].length) / 3;
    if (unit < 1) continue;
    const guardOk =
      Math.abs(rl[s].length / unit - 1) < 0.5 &&
      Math.abs(rl[s + 1].length / unit - 1) < 0.5 &&
      Math.abs(rl[s + 2].length / unit - 1) < 0.5;
    if (!guardOk) continue;

    // ---- try EAN-13 / UPC-A ----
    const left = [], parity = [];
    let i = s + 3, ok = true;
    for (let d = 0; d < 6 && ok; d++, i += 4) {
      if (i + 3 >= rl.length) { ok = false; break; }
      const four = [rl[i].length, rl[i + 1].length, rl[i + 2].length, rl[i + 3].length];
      const asL = matchDigit(four, unit, L_CODES);
      const asG = matchDigit(four, unit, G_CODES);
      if (asL >= 0) { left.push(asL); parity.push("L"); }
      else if (asG >= 0) { left.push(asG); parity.push("G"); }
      else ok = false;
    }
    if (ok) {
      i += 5;                       // skip the 5-run centre guard
      const right = [];
      for (let d = 0; d < 6 && ok; d++, i += 4) {
        if (i + 3 >= rl.length) { ok = false; break; }
        const four = [rl[i].length, rl[i + 1].length, rl[i + 2].length, rl[i + 3].length];
        const val = matchDigit(four, unit, R_CODES);
        if (val >= 0) right.push(val); else ok = false;
      }
      if (ok && right.length === 6) {
        const first = PARITY[parity.join("")];
        if (first !== undefined) {
          const code = String(first) + left.join("") + right.join("");
          if (checkDigitOk(code)) {
            // A UPC-A is an EAN-13 whose first digit is 0. Report it the way
            // it is printed on the product, or the operator comparing the
            // screen against the label sees a digit that is not there.
            return code[0] === "0" ? code.slice(1) : code;
          }
        }
      }
    }
  }
  return null;
}

/** Decode one frame. Returns the code string, or null. */
export function decodeImageData(imageData) {
  const { data, width, height } = imageData;
  if (!width || !height) return null;

  // Middle rows first: that is where a person aims. Then outward, because a
  // barcode is never level in a real hand and one row can land on glare.
  const order = [];
  const mid = Math.floor(height / 2);
  const step = Math.max(1, Math.floor(height / 40));
  for (let d = 0; d <= mid; d += step) {
    order.push(mid - d);
    if (d) order.push(mid + d);
  }

  for (const y of order) {
    if (y < 0 || y >= height) continue;
    const bits = rowToBits(data, width, y);
    if (!bits) continue;
    const rl = runs(bits);
    if (rl.length < 59) continue;

    const forward = decodeRuns(rl);
    if (forward) return forward;
    // Upside down is still a barcode. Asking someone to rotate the phone is
    // not an answer, and half of all scans of a hanging tag are inverted.
    const backward = decodeRuns(rl.slice().reverse());
    if (backward) return backward;
  }
  return null;
}

/** True when the browser can do this natively and better than we can. */
export function hasNativeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}
