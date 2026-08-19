// =============================================================================
// CHECK: the catalog billboard, and the pinned group
// =============================================================================
// Hadi: "like a billboard essentially. Like there's a main screen that is
// basically either an advertisement for a specific product, where they click on
// a button and they move to that specific item inside that specific catalog, or
// just a normal poster, and it's toggleable on and off."
// Then: "they might choose to put in a video or a GIF for the billboard."
// And on the group: "I want them to be able to highlight as many items as they
// want... no matter what order they put them in, always the highlighted items
// will be on the top... it's not a ribbon, like a header."
//
// The assertions that matter most are the ones about MEDIA and ABOUT MOTION:
//
//   A GIF must be an <img>, or it stops moving. A video must be a <video> that
//   is muted and playsinline, or it will not autoplay at all on iOS and will
//   make noise in a quiet shop everywhere else.
//
//   Someone who has asked their device for reduced motion has usually asked
//   for a reason. A billboard is the largest moving thing on the page, so it
//   is the first thing that should stop moving.
//
//   node checks/check_billboard_and_highlights.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

let reduceMotion = false;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://app.test/" });
dom.window.matchMedia = (q) => ({
  matches: /prefers-reduced-motion/.test(q) ? reduceMotion : false,
  media: q, addEventListener() {}, removeEventListener() {},
});
for (const k of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  try { globalThis[k] = dom.window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}

const { renderBillboard, sectionHeader } = await import("../js/components/billboard.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---- a still poster --------------------------------------------------------
{
  const bb = renderBillboard({ url: "https://cdn.test/poster.webp", mediaType: "image", label: "Summer 26" });
  ok(!!bb && bb.classList.contains("billboard"), "a poster renders");
  ok(!!bb.querySelector(".billboard-media img"), "as an image");
  ok(!bb.querySelector("video"), "and not a video");
  ok(!bb.querySelector(".billboard-cta"),
    "with NO button, because no product was named — that is the plain-poster case");
  ok(/Summer 26/.test(bb.getAttribute("aria-label") || ""), "and it is named for a screen reader");
}

// ---- a GIF is still an image, and that is the whole point ------------------
{
  const bb = renderBillboard({ url: "https://cdn.test/loop.gif", mediaType: "image" });
  // Null-safe on purpose. An earlier version read img.getAttribute() straight
  // off a possibly-null node, so sabotaging the component to render a <video>
  // for a GIF made this file CRASH instead of reporting a failed assertion --
  // and a crash greps the same as silence. A check should say which promise
  // broke, not die trying.
  const img = bb.querySelector("img");
  ok(!!img && (img.getAttribute("src") || "").endsWith(".gif"),
    `a GIF renders as an <img> — anything else stops it moving (got <${bb.querySelector(".billboard-media > *")?.tagName?.toLowerCase() || "nothing"}>)`);
  ok(!!img && img.getAttribute("loading") !== "lazy",
    "and is NOT lazy-loaded: it is the first thing on the page, so lazy means a blank rectangle on arrival");
}

// ---- a video ---------------------------------------------------------------
{
  reduceMotion = false;
  const bb = renderBillboard({ url: "https://cdn.test/clip.mp4", mediaType: "video" });
  const v = bb.querySelector("video");
  ok(!!v, `a clip renders as a <video> (got <${bb.querySelector(".billboard-media > *")?.tagName?.toLowerCase() || "nothing"}>)`);
  ok(!!v && v.muted === true && v.hasAttribute("muted"),
    "muted as both property and attribute — Safari reads the property when deciding whether to autoplay");
  ok(!!v && v.hasAttribute("playsinline"),
    "playsinline, or iOS takes over the whole screen with its own player");
  ok(!!v && v.loop === true, "and loops, because a billboard that plays once is a billboard for eleven seconds");
  ok(!!v && v.autoplay === true, "it autoplays when motion is welcome");
  ok(!!v && v.controls === false, "with no controls cluttering the artwork");
}

// ---- reduced motion is an instruction --------------------------------------
{
  reduceMotion = true;
  const bb = renderBillboard({ url: "https://cdn.test/clip.mp4", mediaType: "video" });
  const v = bb.querySelector("video");
  ok(!!v && v.autoplay === false,
    "with reduced motion asked for, the clip does NOT autoplay");
  ok(!!v && v.controls === true,
    "and gets controls instead, so it is still watchable by choice");
  ok(!!v && v.getAttribute("preload") === "metadata",
    "and does not download the whole clip nobody asked to play");
  reduceMotion = false;
}

// ---- the advertisement case ------------------------------------------------
{
  let went = 0;
  const bb = renderBillboard({
    url: "https://cdn.test/poster.webp", mediaType: "image",
    cta: "Shop the drop", onGo: () => { went++; },
  });
  const btn = bb.querySelector(".billboard-cta");
  ok(!!btn, "naming a product gives the billboard a button");
  ok(btn.textContent === "Shop the drop", "with the wholesaler's own words on it");
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  ok(went === 1, "and it goes somewhere");
}
{
  const bb = renderBillboard({ url: "https://cdn.test/p.webp", mediaType: "image", onGo: () => {} });
  ok(bb.querySelector(".billboard-cta").textContent.length > 0,
    "a button with no label typed still says something rather than being a blank rectangle");
}
ok(renderBillboard({ url: "", mediaType: "image" }) === null,
  "no artwork means no billboard at all — never an empty panel");

// ---- the header, not a ribbon ----------------------------------------------
{
  const h = sectionHeader("New Arrivals", 4);
  ok(h.classList.contains("cat-section-head"), "the pinned group gets a header");
  ok(/New Arrivals/.test(h.textContent), "carrying the name the wholesaler chose");
  ok(/4 items/.test(h.textContent), "and how many are in it");
  ok(/1 item\b/.test(sectionHeader("Top Selling", 1).textContent), "counted in English");
}

// ---- ordering is the database's job, and the app must not undo it ----------
const cat = readFileSync("js/data/catalogs.js", "utf8");
ok(/order\("highlighted", \{ ascending: false \}\)/.test(cat),
  "the wholesaler's own catalog list sorts highlighted first, so both sides see the same order");

const buyer = readFileSync("js/views/buyer.js", "utf8");
ok(/order\.get\(a\.id\) - order\.get\(b\.id\)/.test(buyer),
  "the link page preserves the order the database returned rather than re-sorting it");
ok(/highlightLabel/.test(buyer), "and heads the pinned group with the chosen name");
ok(/billboardEnabled/.test(buyer), "the billboard only shows when it is switched on");
ok(/targetPresent/.test(buyer),
  "a billboard pointing at a product no longer in the catalog falls back to a plain poster, not a dead button");

const card = readFileSync("js/components/product-card.js", "utf8");
ok(/dataset\.productId/.test(card),
  "product cards carry their id, or the billboard button has nothing to scroll to");

const sql = readFileSync("supabase/migrations/057_v2_catalog_billboard_and_highlights.sql", "utf8");
ok(/order by cp\.highlighted desc/.test(sql),
  "and the database is the one that decides highlighted-first");

console.log("=".repeat(64));
console.log(" CHECK — THE BILLBOARD AND THE PINNED GROUP");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
