// =============================================================================
// GATE — a first-party product never reaches a buyer unlabelled   OWN-02, 8 Sep
//        WIDENED 9 Sep 2026 (OWN-05) from two surfaces to a CENSUS
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
// ==== WHY THIS FILE WAS REWRITTEN THE DAY AFTER IT WAS WRITTEN ==============
//
// The 8 Sep version asserted the pairing across the two surfaces it knew about:
// the marketplace card and the product rail. Both were correct. It was green.
//
// On 9 Sep a census of js/data found FOUR MORE buyer-facing lists that show a
// product and a store name -- "Buy it again", "Popular now", "More like this"
// and cross-store search -- and not one of them set the flag. The first three
// render through renderProductRail, WHICH ALREADY DREW THE BADGE. The renderer
// was right. The data layer never gave it anything to draw. Every file was
// individually correct and OGGI's products would have appeared unlabelled on
// four screens.
//
// That is the /c/:token failure a third time: two halves, each fine alone.
//
// ⭐ SO THIS GATE NO LONGER CONTAINS A LIST OF SURFACES. It takes a census of
// js/data and applies a RULE, and anything it cannot classify is RED -- the
// same rule 4 that checks/run_sql_gates.sh is built on. A new rail added next
// month is covered on the day it is written, by somebody who was not thinking
// about first-party labelling at all. That is the only kind of coverage that
// survives a busy week.
//
// ==== THE RULE, STATED ONCE ================================================
//
//   Wherever a buyer sees OGGI's store ALONGSIDE other stores, it is marked.
//
// Ranked product lists, the directory, the requests list. NOT marked on a
// single-store page the buyer walked into deliberately -- there is no
// comparison there and no doubt about whose shop they are in.
//
// Every module that emits both a `wid:` and a store name must therefore either
// set `isFirstParty`, or appear in EXEMPT below with the reason written down.
// An unclassified module is red.
//
// RUN:  node checks/check_oggi_label.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile, readdir } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

// =============================================================================
// EXEMPT — modules that emit a wid and a store name and are NOT a buyer looking
// at OGGI beside somebody else. Each one is a decision with a reason, not an
// oversight. Adding a name here is the visible edit that makes it one.
// =============================================================================
const EXEMPT = {
  // --- not a buyer at all: the wholesaler's own console, or OGGI staff -------
  "catalogs.js":          "the wholesaler's own catalogue list, on their own console",
  "owner.js":             "the OGGI owner console — staff, not buyers",
  "products-admin.js":    "the wholesaler's product admin, on their own console",
  "suppliers.js":         "the wholesaler's supplier list, on their own console",
  "wholesaler-admin.js":  "the wholesaler's own settings, on their own console",
  "share-links.js":       "wholesaler admin, plus /c/:token — ONE store, reached by a link that store sent. No comparison, no doubt whose shop it is.",

  // --- a buyer, but looking at ONE store they arrived at deliberately --------
  "buyer-invites.js":     "an invitation from ONE named wholesaler to that wholesaler's store. The buyer is not choosing between shops; they were asked by name.",
  "order-handoff.js":     "the order this buyer has just placed with ONE store they were already inside. Nothing to compare it against.",

  // --- a buyer, several stores, and still exempt — the one real judgement ----
  "marketplace.js":       "the store switcher: chips for stores this buyer ALREADY JOINED, each met and marked in the directory first. The chip's own label is swapped to 'Opening…' and back while entering a store, so a child badge there would be destroyed and restored wrong — a reason to be sure before adding one, not a reason to add one badly. Revisit this the day the switcher stops rewriting its own text.",
};

// =============================================== 0. ⭐ THE CENSUS ============
// Every js/data module that maps a row carrying BOTH a store id and a store
// name is a candidate. It either labels, or it is exempt with a reason.
{
  const dir = new URL("../js/data/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".js")).sort();
  const unclassified = [], labelled = [], exempt = [];

  // ⭐ THE NET IS DELIBERATELY WIDE: a module is a candidate if it puts a store
  // IDENTITY in front of anybody at all -- a wid, or a wholesaler's name.
  //
  // It was narrower for about ten minutes, requiring BOTH, and that version
  // missed four modules including js/data/directory.js -- the very screen
  // OWN-05 was written for, which names its store key `name` rather than
  // `wholesalerName`. A census that decides what to look at by a naming
  // convention is a census that stops seeing anything renamed. So: wide net,
  // and every catch is classified by hand exactly once.
  for (const f of files) {
    const bare = strip(await src("../js/data/" + f));
    const bearsStore = /^\s+wid:/m.test(bare) || /^\s+wholesalerName:/m.test(bare);
    if (!bearsStore) continue;
    // ⚠️ A KEY EMITTED BY THE MAPPER, not the word appearing anywhere.
    // The first version of this line tested /isFirstParty/ and counted
    // js/data/popular.js as labelled on the strength of "isFirstParty" sitting
    // in its exported POPULAR_FIELDS list -- with the mapper setting nothing.
    // A declaration is not a value.
    if (/^\s+isFirstParty:/m.test(bare)) labelled.push(f);
    else if (EXEMPT[f]) exempt.push(f);
    else unclassified.push(f);
  }

  ok(unclassified.length === 0,
     `⭐ every js/data module that carries a store identity either labels it or is exempt with a written reason`
     + (unclassified.length ? ` — UNCLASSIFIED: ${unclassified.join(", ")}` : ""));
  ok(labelled.length === 7,
     `and seven modules label — the feed, search, the directory, the requests list and the three rails (${labelled.length}: ${labelled.join(", ")})`);
  const stale = Object.keys(EXEMPT).filter((f) => !exempt.includes(f));
  ok(stale.length === 0,
     `no exemption is stale — every name in EXEMPT is a module the census actually reaches`
     + (stale.length ? ` — STALE: ${stale.join(", ")}` : ""));
  ok(Object.values(EXEMPT).every((r) => r.length > 40),
     "⭐ every exemption carries a real reason — a name with a word beside it is how a list like this rots");
}

// ============================================ 0b. AND THE SERVER FACT ONLY ===
// Six modules now ask the same question. They must all ask the SAME cached
// helper: two caches can disagree, and a second copy of the lookup is a second
// place for the never-cache-a-failure rule to be forgotten.
{
  const dir = new URL("../js/data/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
  const askers = [];
  for (const f of files) {
    const bare = strip(await src("../js/data/" + f));
    if (/v2_first_party_wid/.test(bare)) askers.push(f);
  }
  ok(askers.length === 1 && askers[0] === "marketplace-feed.js",
     `⭐ exactly ONE module asks the server which store is ours — everything else imports it (asked by: ${askers.join(", ") || "nobody"})`);
}

const feedSrc = await src("../js/data/marketplace-feed.js");
const mktSrc  = await src("../js/views/marketplace.js");
const railSrc = await src("../js/components/product-rail.js");
const srchSrc = await src("../js/views/search.js");
const dirSrc  = await src("../js/views/directory.js");

// ================================================== 1. THE DATA LAYER SETS IT
{
  const bare = strip(feedSrc);
  ok(/isFirstParty:/.test(bare), "the row mapper sets isFirstParty");
  ok(/v2_first_party_wid/.test(bare),
     "⭐ and it gets the answer from the SERVER — the one fact a browser is allowed to ask (migration 131)");
  ok(!/wholesaler_name[^\n]*OGGI|wholesalerName[^\n]*===\s*["']OGGI/i.test(bare),
     "⭐ and never infers it from the store's NAME — \"OGGI Textiles\" could be anybody's shop");

  const calls = bare.match(/mapRow\(/g) || [];
  ok(calls.length >= 3, `mapRow is defined and called from both the feed and search (found ${calls.length} references)`);
  ok(!/\.map\(mapRow\)/.test(bare),
     "⭐ neither surface still calls .map(mapRow) bare — that passes the ARRAY INDEX as the wid and silently labels nothing");
}

// ============ 1b. ⭐ AND SO DOES EVERY OTHER MODULE, THE SAME WAY ============
// Not "mentions isFirstParty" — compares against the server's answer. A module
// that wrote `isFirstParty: false` would satisfy a looser check and label
// nothing, forever, in the direction that flatters us.
{
  for (const f of ["similar.js", "popular.js", "reorder.js", "search.js", "directory.js", "access-requests.js"]) {
    const bare = strip(await src("../js/data/" + f));
    ok(/isFirstParty:\s*!!fp\s*&&\s*r\.wid\s*===\s*fp/.test(bare),
       `${f} sets isFirstParty by comparing the row's wid to the server's answer`);
    ok(/import\s*\{[^}]*firstPartyWid[^}]*\}\s*from\s*["']\.\/marketplace-feed\.js["']/.test(bare),
       `${f} imports the ONE cached lookup rather than opening a second one`);
    ok(/const fp = await firstPartyWid\(\);[\s\S]{0,400}?return \(data/.test(bare)
       || /const fp = await firstPartyWid\(\);[\s\S]{0,400}?return data\.map/.test(bare),
       `${f} awaits the answer BEFORE mapping, so the flag is never undefined for every row`);
  }
}

// ================================ 2. ⚠️ A FAILED LOOKUP IS NEVER CACHED =====
// This is the quiet one. Caching a null means one transient network blip
// un-labels every first-party product for the rest of the session -- silently,
// and in precisely the direction that flatters us. It matters six times more
// now than it did on 8 Sep, because six surfaces share this one cache.
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
  // The two oldest renderers draw the badge inline, and are asserted as they
  // were written. The two added on 9 Sep draw it through the shared helper --
  // which is asserted differently and more strongly, below and by render.
  for (const [name, text] of [["the marketplace card", mktSrc],
                              ["the product rail", railSrc]]) {
    const bare = strip(text);
    ok(/isFirstParty/.test(bare), `${name} branches on isFirstParty`);
    ok(/data-first-party/.test(bare), `${name} marks the badge with data-first-party, so this gate can find it in the DOM`);
    ok(/OGGI's own|OGGI&#39;s own/.test(bare), `${name} says whose it is in words, not just a colour`);
  }
  for (const [name, text] of [["the search result", srchSrc], ["the directory", dirSrc]]) {
    ok(/import\s*\{[^}]*firstPartyBadge[^}]*\}\s*from\s*["']\.\.\/components\/first-party-badge\.js["']/.test(strip(text)),
       `${name} draws the mark through the ONE shared helper rather than a copy of it`);
  }
  // The directory draws it TWICE -- the card and the "Your requests" list a few
  // hundred pixels below it, on the same screen. One marked and one not would
  // teach a buyer that the badge is decorative.
  //
  // ⚠️ THIS USED TO COUNT `data-first-party` IN THE SOURCE, and on 9 Sep a
  // sabotage that changed `if (r.isFirstParty)` to `if (false && r.isFirstParty)`
  // left the gate green: the markup was all still there and none of it could
  // ever run. Counting markup measures presence; it does not measure reach.
  //
  // So both sites now go through firstPartyBadge(), and what is asserted is
  // that each is handed THE ROW'S OWN FLAG. `firstPartyBadge(false)` is then a
  // visible edit rather than an invisible one, and the helper itself is
  // RENDERED below rather than read.
  const dirBare = strip(dirSrc);
  ok(/firstPartyBadge\(w\.isFirstParty/.test(dirBare),
     "⭐ the directory CARD passes the store's own flag to the badge helper");
  ok(/firstPartyBadge\(r\.isFirstParty/.test(dirBare),
     "⭐ and the REQUESTS ROW passes its own row's flag — one screen cannot disagree with itself");
  ok(/firstPartyBadge\(r\.isFirstParty/.test(strip(srchSrc)),
     "⭐ and the search result passes the result's own flag");
  ok(!/firstPartyBadge\(\s*(true|false)\s*[,)]/.test(dirBare + strip(srchSrc)),
     "⭐ and nobody calls the helper with a constant, which would label everything or nothing");
}

// ======================================= 4. ⭐ AND IT SURVIVES TO THE DOM ====
// The assertions above are source checks. These render the real functions with
// a real first-party row and look at the HTML, because a flag that is set,
// passed and branched on can still be invisible.
const stub = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, c) => (c || "$") + Number(n || 0).toFixed(2);
`;
const loadBody = async (text) => {
  const body = text.split("\n").filter((l) => !l.startsWith("import ")).join("\n");
  return import("data:text/javascript;base64," + Buffer.from(stub + body).toString("base64"));
};

// ---- ⭐ the shared helper, rendered
// The strongest assertion in this file, because it measures BEHAVIOUR: an
// element for a first-party store, nothing at all for anybody else. Every
// source-shaped assertion above is a proxy for this one.
{
  const mod = await import(new URL("../js/components/first-party-badge.js", import.meta.url).href);
  const on  = mod.firstPartyBadge(true);
  const off = mod.firstPartyBadge(false);
  ok(off === null, "⭐ the badge helper returns NOTHING for an ordinary store — a label on everything labels nothing");
  ok(on && on.getAttribute("data-first-party") === "1",
     "⭐ and a real element, carrying the hook, for OGGI's own");
  ok(on && /OGGI's own/.test(on.textContent),
     "⭐ which says whose it is in words, so it survives a restyle and reaches a screen reader");
  for (const falsy of [undefined, null, 0, ""]) {
    ok(mod.firstPartyBadge(falsy) === null,
       `and a missing flag (${JSON.stringify(falsy)}) draws nothing rather than throwing on a render path`);
  }
}

// ---- the rail
{
  const mod = await loadBody(railSrc);
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

// ---- the directory card
// Rendered for real, because "Buy it again" proved on 9 Sep that a renderer can
// be perfectly correct and still draw nothing.
{
  const m = dirSrc.match(/function card\(w, onRequest\) \{[\s\S]*?\n\}\n/);
  ok(!!m, "the directory's card() can be isolated for a real render");
  if (m) {
    // The REAL helper source is compiled in beside card(), not a stand-in:
    // a stub here would let card() pass while the helper it actually calls in
    // the browser was broken, which is the entire failure this file is about.
    const badgeSrc = (await src("../js/components/first-party-badge.js"))
      .split("\n").filter((l) => !l.startsWith("import ")).join("\n")
      .replace(/^export function/m, "function");
    const mod = await import("data:text/javascript;base64," +
      Buffer.from(stub + badgeSrc + "\nexport " + m[0]).toString("base64"));
    const mk = (wid, name, fp) => ({
      wid, name, brand: null, logo: null, categories: ["Tops"],
      access: "none", accessSlaHours: 48, isFirstParty: fp,
    });
    let html = "";
    try {
      html = mod.card(mk("oggi", "OGGI", true), () => {}).outerHTML
           + mod.card(mk("ind", "Indie Textiles", false), () => {}).outerHTML;
    } catch (e) { html = ""; }
    if (html) {
      const badges = (html.match(/data-first-party/g) || []).length;
      ok(badges === 1, `⭐ the directory draws exactly one badge across a first-party card and an ordinary one (got ${badges})`);
      ok(/OGGI&#39;s own|OGGI's own/.test(html), "⭐ and the rendered directory card says it in words");
      ok(!/OGGI&#39;s own|OGGI's own/.test(html.slice(html.indexOf('data-wid="ind"'))),
         "⭐ and the ORDINARY store's card carries no badge — a label on everything labels nothing");
    } else {
      ok(false, "the directory card could not be rendered, so this half proved nothing");
    }
  }
}

// =============================================================================
console.log(`\n  ${pass.length} passed, ${fail.length} failed\n`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { console.log("\n  OWN-02 LABEL GATE RED\n"); process.exit(1); }
console.log("\n  OWN-02 LABEL GATE GREEN\n");
