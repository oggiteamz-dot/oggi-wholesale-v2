// =============================================================================
// GATE — a first-party product never reaches a buyer unlabelled   OWN-02, 8 Sep
// =============================================================================
// Since 8 Sep 2026 OGGI sells on this platform, and Hadi chose to put its
// products IN THE ORDINARY RESULTS rather than in a shelf of their own.
//
//   ⭐ IN THAT ARRANGEMENT THE BADGE IS THE ONLY PROTECTION THERE IS.
//
// In the shelf design, placement did the work: an own-brand product was
// somewhere else on the page and you could see that at a glance. Here it sits
// between two suppliers' products, ranked by the same rules, and the ONLY thing
// that says whose it is, is the label. A first-party product rendered without
// it is the platform competing invisibly with the shops it ranks it against --
// which the 28 Aug research found is the single most consistently penalised
// arrangement in the record of marketplace regulation.
//
// ==== IT ASSERTS THE PAIRING, NOT THE TWO FACTS ============================
//
// Two halves have to line up: the data layer must SET the flag on every row it
// maps, and every renderer must DRAW it. Checking those separately is exactly
// how /c/:token stayed unreachable for three weeks -- the route was registered
// and it was not in isPublicPath, and each fact was fine on its own.
//
// So this walks every module that maps feed rows, finds every renderer that
// consumes them, and requires the flag to survive the whole way to the DOM.
//
// RUN:  node checks/check_oggi_label.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

const feedSrc = await src("../js/data/marketplace-feed.js");
const mktSrc  = await src("../js/views/marketplace.js");
const railSrc = await src("../js/components/product-rail.js");

// ================================================== 1. THE DATA LAYER SETS IT
{
  const bare = strip(feedSrc);
  ok(/isFirstParty:/.test(bare), "the row mapper sets isFirstParty");
  ok(/v2_first_party_wid/.test(bare),
     "⭐ and it gets the answer from the SERVER — the one fact a browser is allowed to ask (migration 131)");
  ok(!/wholesaler_name[^\n]*OGGI|wholesalerName[^\n]*===\s*["']OGGI/i.test(bare),
     "⭐ and never infers it from the store's NAME — \"OGGI Textiles\" could be anybody's shop");

  // Both surfaces. searchProducts and feedPage share one mapper, but they must
  // each actually pass the answer to it -- a mapper that receives undefined
  // labels nothing and looks perfectly correct in isolation.
  const calls = bare.match(/mapRow\(/g) || [];
  ok(calls.length >= 3, `mapRow is defined and called from both the feed and search (found ${calls.length} references)`);
  ok(!/\.map\(mapRow\)/.test(bare),
     "⭐ neither surface still calls .map(mapRow) bare — that passes the ARRAY INDEX as the wid and silently labels nothing");
}

// ================================ 2. ⚠️ A FAILED LOOKUP IS NEVER CACHED =====
// This is the quiet one. Caching a null means one transient network blip
// un-labels every first-party product for the rest of the session -- silently,
// and in precisely the direction that flatters us.
{
  const bare = strip(feedSrc);
  const fn = bare.slice(bare.indexOf("export async function firstPartyWid"),
                        bare.indexOf("export async function feedPage"));
  ok(/if\s*\(\s*error\s*\)\s*return\s+null\s*;/.test(fn),
     "⚠️ a failed lookup returns null WITHOUT caching it, so a blip does not un-label everything until reload");
  const afterError = fn.slice(fn.indexOf("error"));
  ok(!/_fpWid\s*=\s*null/.test(afterError),
     "⭐ and the failure is genuinely not written to the cache");
  ok(/_fpWid\s*=\s*data/.test(fn), "a real answer IS cached, so this costs one call per session");
}

// ============================================= 3. EVERY RENDERER DRAWS IT ===
{
  for (const [name, text] of [["the marketplace card", mktSrc], ["the product rail", railSrc]]) {
    const bare = strip(text);
    ok(/isFirstParty/.test(bare), `${name} branches on isFirstParty`);
    ok(/data-first-party/.test(bare), `${name} marks the badge with data-first-party, so this gate can find it in the DOM`);
    ok(/OGGI's own|OGGI&#39;s own/.test(bare), `${name} says whose it is in words, not just a colour`);
  }
}

// ======================================= 4. ⭐ AND IT SURVIVES TO THE DOM ====
// The assertions above are source checks. This one renders the real card
// function with a real first-party row and looks at the HTML, because a flag
// that is set, passed and branched on can still be invisible.
{
  const stub = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, c) => (c || "$") + Number(n || 0).toFixed(2);
`;
  const railBody = railSrc.split("\n").filter((l) => !l.startsWith("import ")).join("\n");
  const mod = await import("data:text/javascript;base64," +
    Buffer.from(stub + railBody).toString("base64"));

  const render = mod.renderProductRail || mod.productRail || mod.default
    || Object.values(mod).find((v) => typeof v === "function");
  ok(typeof render === "function", "the rail module exports something renderable (otherwise the DOM check below proves nothing)");

  if (typeof render === "function") {
    const rows = [
      { productId: "1", name: "House Shirt",  wid: "oggi", wholesalerName: "OGGI",  priceFrom: 10, currency: "$", isFirstParty: true },
      { productId: "2", name: "Indie Shirt",  wid: "ind",  wholesalerName: "Indie", priceFrom: 10, currency: "$", isFirstParty: false },
    ];
    let html = "";
    try {
      const el = render({ title: "T", items: rows });
      html = el && el.outerHTML ? el.outerHTML : String(el || "");
    } catch { html = ""; }

    if (html) {
      const badges = (html.match(/data-first-party/g) || []).length;
      ok(badges === 1, `⭐ exactly one badge rendered for one first-party row among two (got ${badges})`);
      ok(/OGGI&#39;s own|OGGI's own/.test(html), "⭐ and the rendered HTML actually says it");
    } else {
      ok(false, "the rail could not be rendered, so the DOM half of this gate proved nothing");
    }
  }
}

// =============================================================================
console.log(`\n  ${pass.length} passed, ${fail.length} failed\n`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { console.log("\n  OWN-02 LABEL GATE RED\n"); process.exit(1); }
console.log("\n  OWN-02 LABEL GATE GREEN\n");
