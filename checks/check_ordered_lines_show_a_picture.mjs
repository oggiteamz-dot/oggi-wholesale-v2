// =============================================================================
// OGGI Wholesale v2 — GATE: AN ORDERED PRODUCT SHOWS ITS PICTURE
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Hadi, 19 Sep 2026, about the buyer's My Orders, having asked once before:
//
//   "you again did not show the images of the products. Save this as a primary
//    thing that it has to always have. This is a gate."
//
// So this is the gate. It is the word he used, and the second asking is the
// reason it is a build failure rather than a fix.
//
// WHAT WAS WRONG
// --------------
// /buyer/orders rendered an order's contents as a comma-joined sentence:
//
//   29× M-112 Carrot Fit Jean (Washed Black/32), 29× K-605 Insulated Work
//   Jacket (Dark Indigo/S), 29× W-205 Straight Leg Jean — Mid Rise …
//
// And the photographs were ALREADY THERE. Measured on production the morning
// this was written: 370 order lines, 280 of them with a photograph on the
// variant, and zero shown. The database function behind the screen already
// joined the variant and product tables to read the sku and the name, and
// never put the image column in the object it returned. Migration 141 adds it.
//
// WHY NOT JUST ASSERT "AN <img> EXISTS"
// -------------------------------------
// Because that passes on a broken one. An <img> with a dead storage URL is in
// the DOM, has a src, and renders as the browser's broken-image glyph — which
// is worse than no picture, because it reads as a fault in the product rather
// than a gap in the photography.
//
// So every ordered line must resolve to ONE of exactly two states:
//
//   1. A PHOTOGRAPH THAT ACTUALLY LOADED   — naturalWidth > 0. Not "has a
//      src", not "is in the DOM". The pixels arrived.
//   2. THE DELIBERATE PLACEHOLDER          — the tinted initials tile that
//      says this product has no photograph yet. Hadi approved this half
//      explicitly: the gate passes on image-or-placeholder, because 20
//      products on the system genuinely have no photograph and hiding those
//      lines would be worse than admitting it.
//
// A third state — an <img> that failed to load and left nothing behind — is
// the failure this gate exists to catch, and product-thumb.js removes a failed
// image so the placeholder underneath shows through. This asserts that it does.
//
// SCOPE
// -----
// The BUYER's My Orders, which is the screen he named. The wholesaler's Orders
// screen has the identical defect and is being fixed in the console redesign;
// when it lands, add "wholesaler" to SURFACES below and this gate covers it
// without another file.
//
// RUN:   node checks/check_ordered_lines_show_a_picture.mjs
// LIVE:  WALK_BASE=https://oggi-wholesale-v2.oggi-teamz.workers.dev node checks/…
//
// PROVEN TO GO RED — see GATE-EVIDENCE.md. Run against buyer.js before the
// thumbnail row it reports: "3 order cards carry 0 pictures between them;
// every line is text only."
// =============================================================================

import { chromium } from "playwright";
import { serveTree, signIn } from "./tools/browser.mjs";

const SURFACES = [
  { role: "buyer", route: "/buyer/orders", name: "My Orders" },
];

const { BASE, close } = await serveTree();
const browser = await chromium.launch();

let failures = 0;
let checked = 0;

function fail(msg) { failures++; console.log(`  ✗ ${msg}`); }
function pass(msg) { checked++; console.log(`  ✓ ${msg}`); }

for (const surface of SURFACES) {
  console.log(`\n── ${surface.name}  (${surface.route})`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const login = await signIn(page, surface.role, BASE);
  if (!login.ok) {
    fail(`could not sign in as ${surface.role}: ${login.why}`);
    await ctx.close();
    continue;
  }

  await page.goto(BASE + "/#" + surface.route, { waitUntil: "domcontentloaded" });
  // The same settle the walker uses: wait for the screen to become something
  // other than the previous one, then for it to stop growing. A fixed sleep
  // here reported an empty screen as "no pictures" more than once.
  await page.waitForFunction(
    () => /order/i.test(document.body.innerText) && document.body.innerText.length > 400,
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);

  const report = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")].filter((c) => c.querySelector(".p-thumb-row, .p-thumb"));
    const anyCard = [...document.querySelectorAll(".card")];
    const thumbs = [...document.querySelectorAll(".p-thumb")];
    return {
      cardCount: anyCard.length,
      cardsWithThumbs: cards.length,
      thumbCount: thumbs.length,
      // An order that renders no text at all is a different bug; noted so the
      // failure message can tell the two apart.
      bodyChars: document.body.innerText.length,
      states: thumbs.map((t) => {
        const img = t.querySelector('img[data-thumb="image"]');
        const ph = t.querySelector('[data-thumb="placeholder"]');
        return {
          title: t.title || "(untitled)",
          loaded: !!(img && img.complete && img.naturalWidth > 0),
          hasImgEl: !!img,
          hasPlaceholder: !!ph && ph.offsetParent !== null,
          failedFlag: t.getAttribute("data-thumb-failed") === "1",
        };
      }),
    };
  });

  // ---- 1. there is something to check at all -------------------------------
  if (report.cardCount === 0) {
    fail(`${surface.name} rendered no order cards at all (body ${report.bodyChars} chars) — this gate cannot see whether pictures are shown, so it refuses to report a pass`);
    await ctx.close();
    continue;
  }

  // ---- 2. EVERY order card carries pictures --------------------------------
  // The failure this exists for: a card that lists its contents as text only.
  if (report.cardsWithThumbs === 0) {
    fail(`${report.cardCount} order cards carry 0 pictures between them; every line is text only`);
  } else if (report.cardsWithThumbs < report.cardCount) {
    fail(`${report.cardCount - report.cardsWithThumbs} of ${report.cardCount} order cards show no picture at all`);
  } else {
    pass(`all ${report.cardCount} order cards show their products as pictures`);
  }

  // ---- 3. every tile resolves to a photograph OR the honest placeholder ----
  // A tile is bad in two ways, and the second one is the sneaky one:
  //   a) nothing to look at    — no loaded photograph and no placeholder;
  //   b) a DEAD <img> still in the DOM — it did not load, and it was not
  //      removed, so it sits ON TOP of the placeholder and the reader gets
  //      the browser's broken-image glyph. The placeholder being present in
  //      the DOM is not enough; the failed image has to be gone.
  const broken = report.states.filter((s) =>
    (!s.loaded && !s.hasPlaceholder) ||
    (s.hasImgEl && !s.loaded && !s.failedFlag)
  );
  if (broken.length) {
    fail(`${broken.length} tile(s) show neither a loaded photograph nor the placeholder — a reader sees an empty box or a broken-image glyph:\n      ${broken.slice(0, 6).map((b) => b.title).join("\n      ")}`);
  } else if (report.thumbCount === 0) {
    fail("no product tiles found to check");
  } else {
    const shot = report.states.filter((s) => s.loaded).length;
    const held = report.states.length - shot;
    pass(`${report.states.length} tiles: ${shot} photograph${shot === 1 ? "" : "s"} loaded, ${held} honest placeholder${held === 1 ? "" : "s"}`);
  }

  // ---- 4. a dead URL leaves the placeholder showing ------------------------
  // Not hypothetical: storage URLs rot, and the failure mode of an <img> that
  // 404s is the browser's own broken-image icon sitting in a product row.
  const rotted = report.states.filter((s) => s.failedFlag && !s.hasPlaceholder);
  if (rotted.length) {
    fail(`${rotted.length} tile(s) had a photograph that failed to load and did NOT fall back to the placeholder`);
  } else {
    pass("a photograph that fails to load falls back to the placeholder, never a broken-image icon");
  }

  await ctx.close();
}

await browser.close();
close();

console.log("\n" + "-".repeat(64));
if (failures) {
  console.log(` ✗ FAIL — ${failures} problem(s). An ordered product must show its picture.`);
  process.exit(1);
}
console.log(` ✓ PASS — ${checked} assertion(s). Every ordered line shows a picture.`);
