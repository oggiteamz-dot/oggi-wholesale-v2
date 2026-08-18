// OGGI Wholesale v2 — naming a colour from its value
//
// Hadi asked that a colour picked off a photo arrive already named, with the
// name being "the name of that colour" -- not "Colour 1". A sequential
// placeholder is the thing people forget to replace, and the catalogue then
// ships with "Colour 3" printed on it; a real name is right often enough to
// keep, and wrong in a way that is obvious and instantly editable.
//
// The list is deliberately garment-trade vocabulary rather than the CSS named
// colours. "Papaya Whip" and "Gainsboro" are real CSS names and useless on a
// line sheet; "Sand", "Charcoal" and "Midnight Blue" are what a wholesaler
// actually writes. It is intentionally small for the same reason -- a list of
// 500 shades returns hyper-specific names ("Feldgrau") that read as wrong even
// when they are technically nearest.
//
// Matching is done in CIELAB via CIE76 rather than by RGB distance. RGB
// distance is not perceptual: it will happily call a mid-green "Olive" because
// the arithmetic is closer even though nobody looking at it would agree, and
// it is worst exactly where garments live -- muted, desaturated tones. Lab is
// built so that equal distances look equally different, which is the whole
// question being asked here.

const NAMED = [
  ["Black", "#000000"], ["Charcoal", "#36454F"], ["Graphite", "#3B3C36"],
  ["Slate", "#708090"], ["Grey", "#808080"], ["Silver", "#C0C0C0"],
  ["Stone", "#928E85"], ["Ivory", "#FFFFF0"], ["Cream", "#FFFDD0"],
  ["White", "#FFFFFF"], ["Off White", "#F5F3EE"],

  ["Navy", "#000080"], ["Midnight Blue", "#191970"], ["Royal Blue", "#4169E1"],
  ["Cobalt", "#0047AB"], ["Denim", "#1560BD"], ["Sky Blue", "#87CEEB"],
  ["Powder Blue", "#B0E0E6"], ["Teal", "#008080"], ["Petrol", "#005F6A"],
  ["Turquoise", "#40E0D0"], ["Aqua", "#7FFFD4"],

  ["Forest Green", "#228B22"], ["Emerald", "#50C878"], ["Kelly Green", "#4CBB17"],
  ["Olive", "#808000"], ["Khaki", "#C3B091"], ["Sage", "#9CAF88"],
  ["Mint", "#98FF98"], ["Lime", "#BFFF00"], ["Bottle Green", "#006A4E"],

  ["Burgundy", "#800020"], ["Wine", "#722F37"], ["Maroon", "#800000"],
  ["Crimson", "#B91C1C"], ["Red", "#FF0000"], ["Cherry", "#DE3163"],
  ["Coral", "#FF7F50"], ["Salmon", "#FA8072"], ["Blush", "#DE5D83"],
  ["Rose", "#FF007F"], ["Pink", "#FFC0CB"], ["Fuchsia", "#FF00FF"],
  ["Dusty Pink", "#D8A0A6"],

  ["Orange", "#FF7F00"], ["Rust", "#B7410E"], ["Terracotta", "#E2725B"],
  ["Amber", "#FFBF00"], ["Mustard", "#FFDB58"], ["Gold", "#D4AF37"],
  ["Yellow", "#FFFF00"], ["Lemon", "#FFF700"], ["Butter", "#F3E5AB"],

  ["Purple", "#800080"], ["Plum", "#8E4585"], ["Aubergine", "#3D0734"],
  ["Lavender", "#B57EDC"], ["Lilac", "#C8A2C8"], ["Violet", "#7F00FF"],

  ["Brown", "#795548"], ["Chocolate", "#3F2A1D"], ["Tan", "#D2B48C"],
  ["Camel", "#C19A6B"], ["Beige", "#F5F5DC"], ["Sand", "#E0CDA9"],
  ["Taupe", "#8B8589"], ["Nude", "#E3BC9A"], ["Coffee", "#6F4E37"],
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB -> CIELAB (D65). The gamma step matters: skipping it (treating the
 *  0-255 value as linear light) is the usual shortcut and it distorts exactly
 *  the dark end, where most of a garment palette sits. */
function rgbToLab([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const [R, G, B] = lin;
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const NAMED_LAB = NAMED.map(([name, hex]) => ({ name, lab: rgbToLab(hexToRgb(hex)) }));

/** The trade name nearest to this colour, or null for an unreadable value.
 *  Never throws -- an unnameable colour must not stop someone picking it. */
export function nameForHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lab = rgbToLab(rgb);
  let best = null, bestD = Infinity;
  for (const entry of NAMED_LAB) {
    const d =
      (lab[0] - entry.lab[0]) ** 2 +
      (lab[1] - entry.lab[1]) ** 2 +
      (lab[2] - entry.lab[2]) ** 2;
    if (d < bestD) { bestD = d; best = entry.name; }
  }
  return best;
}

/** The same name, made unique against names already in use. Two greys really
 *  can both be nearest to "Slate", and two variants called "Slate" would be a
 *  duplicate SKU and an unanswerable question on the packing bench. */
export function uniqueNameForHex(hex, takenNames) {
  const base = nameForHex(hex);
  if (!base) return null;
  const taken = new Set((takenNames || []).map((n) => String(n || "").trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
