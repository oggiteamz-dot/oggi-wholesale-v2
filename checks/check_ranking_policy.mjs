// =============================================================================
// GATE — THE PUBLISHED RANKING POLICY IS TRUE                  SR-05, 30 Aug 2026
// =============================================================================
// This is not a rendering test. It is the gate that stops a page of promises
// from quietly becoming a page of false statements.
//
// THE ARGUMENT FOR IT: a stale marketing page is embarrassing. A stale RANKING
// POLICY is a written misrepresentation made to a supplier about how their
// livelihood is ordered — which the 28 August research identified as the single
// exposure that actually reaches a company this size, and it would be entirely
// self-inflicted. Every sentence on that page that makes a checkable claim is
// checked here against the code that would have to change for it to stop being
// true.
//
// THE PROPERTIES, in the order they would hurt:
//
//   1. THE NUMBERS ARE LIVE, NOT TYPED. Proven by feeding the page absurd
//      values through a stubbed RPC and asserting those exact values render.
//      A page that hardcodes "3 different shops" is wrong the first time
//      somebody changes it, and nothing else in this repo would notice.
//
//   2. "ORDINARY RESULTS ARE NEVER FOR SALE" — asserted against the actual
//      search and shelf functions, which must not so much as mention the
//      promotions table.
//
//   3. "CAPPED AT THREE" — asserted against the constant in migration 093, not
//      against the sentence. If somebody raises the cap, this fails.
//
//   4. "NEVER BY HOW MANY TIMES IT WAS BOUGHT" — asserted against the ORDER BY
//      in v2_popular_now. This is the claim a later "simplification" is most
//      likely to break while leaving the page saying otherwise.
//
//   5. IT IS FINDABLE. A published policy a supplier cannot reach has not been
//      published.
//
// RUN:  node checks/check_ranking_policy.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>", {
  url: "https://check.local/", pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CSS = dom.window.CSS || { escape: (s) => String(s) };

let RPC = {};
const CALLS = [];
dom.window.supabase = {
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async (name, args) => {
      CALLS.push({ name, args });
      const h = RPC[name];
      return typeof h === "function" ? h(args) : { data: [], error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const settle = () => new Promise((r) => setTimeout(r, 0));
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

const view = await src("../js/views/ranking-policy.js");
const search093 = await src("../supabase/migrations/093_v2_promoted_slot.sql");
const search092 = await src("../supabase/migrations/092_v2_cross_store_search.sql");
const popular099 = await src("../supabase/migrations/099_v2_popular_now.sql");
const similar100 = await src("../supabase/migrations/100_v2_similar_products.sql");
const reorder095 = await src("../supabase/migrations/095_v2_buy_it_again.sql");
const navSrc = await src("../js/lib/nav-config.js");
const wsSrc  = await src("../js/views/wholesaler.js");

// ============================================================ 1. LIVE NUMBERS
// Absurd values no human would type, so a hardcoded page cannot pass by luck.
RPC = {
  v2_ranking_parameters_published: async () => ({
    data: [
      { key: "popular_min_buyers",     int_value: 4242, text_value: null },
      { key: "popular_window_days",    int_value: 7777, text_value: null },
      { key: "similar_per_store_cap",  int_value: 9191, text_value: null },
      { key: "similar_stop_words",     int_value: null, text_value: "zzz,qqq" },
    ], error: null,
  }),
};
const { registerRankingPolicyRoute } = await import("../js/views/ranking-policy.js");
let render = null;
registerRankingPolicyRoute({ register: (p, fn) => { if (p === "/wholesaler/ranking-policy") render = fn; } });
ok(typeof render === "function", "the /wholesaler/ranking-policy route is registered");

const outlet = document.createElement("div");
document.body.appendChild(outlet);
await render(outlet);
await settle(); await settle();
const html = outlet.innerHTML;

ok(CALLS.some((c) => c.name === "v2_ranking_parameters_published"),
   "the page ASKS the database for the numbers rather than carrying its own copy");
ok(/4242/.test(html) && /7777/.test(html) && /9191/.test(html),
   "THE NUMBERS ARE LIVE — absurd values fed through the RPC render verbatim, so the page cannot be a hardcoded snapshot that goes stale the first time somebody changes one");
ok(/zzz,qqq/.test(html), "a word-list parameter renders too, not only the numeric ones");

// The internal note must never reach this page: popular_min_buyers' own note in
// the database states our buyer count.
ok(!/starting guess/i.test(html) && !/market with \d+ buyers/i.test(html),
   "the database's internal note is NOT rendered — one of those notes publishes our buyer count to every supplier");

// ================================================ 2. NOTHING ORDINARY IS SOLD
// Only the FUNCTION BODIES, not the whole migration file. The first draft of
// this grepped the file and failed on three functions that are perfectly clean
// — the matches were inside a `comment on function` string, a header paragraph
// promising the table is not read, and the migration's own self-assertion
// checking for exactly this. Grepping a file to ask a question about a function
// is the same mistake as searching for a name to ask a question about a shape.
const bodies = (sql) => sql.split("$fn$").filter((_, i) => i % 2 === 1).join("\n");
const mentionsPromo = (sql) => /v2_oggi_promoted/.test(
  bodies(sql).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"));

ok(!mentionsPromo(popular099),
   '"Popular right now" does not consult the promotions table — the page says it never does');
ok(!mentionsPromo(similar100),
   '"More like this" does not consult the promotions table');
ok(!mentionsPromo(reorder095),
   '"Buy it again" does not consult the promotions table');

// SEARCH IS THE EXCEPTION AND THE PAGE SAYS SO. v2_search_products DOES read
// the promotions table — it is the function that returns the promoted slot.
// The claim on the page is narrower and more useful: paid placement cannot move
// an ORDINARY result. Proving that needs a running database (turn a promotion
// on, confirm the organic order is byte-identical), which is what
// check_promoted_slot.sql does. Asserted here so that deleting that gate
// cannot quietly leave the page making a promise nothing checks.
const promoGate = await src("./check_promoted_slot.sql");
ok(/turning every promotion OFF must not change the organic ordering/i.test(promoGate),
   "check_promoted_slot.sql still owns the claim that paid placement cannot move an ordinary result — the page makes that promise and this is what keeps it honest");
ok(/organic order changed when a promotion was added/i.test(promoGate),
   "and that gate fails loudly rather than warning quietly if it ever stops holding");
ok(/cannot move an ordinary result|would not change its order/i.test(view),
   "the page states the narrow, true claim — that promotion cannot move an ordinary result — rather than the broad false one that search never touches promotion at all");

// ================================================= 3. THE CAP REALLY IS THREE
const capMatch = search093.match(/PROMO_CAP\s+constant\s+int\s*:=\s*(\d+)/);
ok(capMatch && capMatch[1] === "3",
   `the promoted slot's cap is genuinely 3 in migration 093 (found ${capMatch ? capMatch[1] : "no cap at all"}) — the page tells suppliers it is three`);
ok(/capped at <strong>three<\/strong>|capped at .{0,20}three/i.test(view),
   "and the page says three, so the two cannot drift apart silently");

// ========================================== 4. POPULAR COUNTS SHOPS, NOT SALES
ok(/order by\s+count\(distinct o\.client_id\) desc/i.test(popular099),
   'the popular shelf really does rank on DISTINCT BUYERS — the page\'s central claim, and the one a later "simplification" is most likely to break');
ok(!/order by[^;]*count\(distinct o\.id\)/i.test(popular099),
   "and it does not rank on order count");
ok(/never by how many times it was bought/i.test(view),
   "the page states that distinction rather than leaving a supplier to assume the obvious wrong thing");

// ================================== 5. SEARCH IS TIERED, AND THE PAGE SAYS SO
ok(/order by t\.rank, t\.product_name/i.test(search092),
   "search really does order by match tier then product name");
ok(/alphabetical/i.test(view),
   "and the page admits results are alphabetical inside a tier rather than implying a relevance score we do not have");
ok(/\bname\b[\s\S]{0,160}\bcategory\b[\s\S]{0,160}(item code|sku)/i.test(view),
   "the page names the three tiers in the order the code applies them");

// ============================================= 6. THE HONEST NEGATIVE CLAIMS
ok(/exclusivity|minimum volume|subscription tier|additional obligation/i.test(view),
   "the page answers the INDIRECT question too — what you cannot trade for position — which is the half that usually goes unanswered");
ok(/does not sell any products/i.test(view),
   "the page states plainly that OGGI sells nothing here, rather than hedging a question it can currently answer cleanly");
ok(/sales (figures|data) will not be used|never used against you|not an input/i.test(view),
   "the page commits to the data wall in writing");

// ======================================================== 7. IT IS FINDABLE
// NOT a navigation entry. The wholesaler sidebar is capped at nine, that number
// is Hadi's decision from Batch 8B, and two gates assert it — the first draft of
// this feature added a tenth and both went red within seconds, which is the
// system working. So findability is asserted where it actually lives instead,
// and more strictly than a nav entry would have been:
ok(!navSrc.includes('"/wholesaler/ranking-policy"'),
   "the policy did NOT spend the wholesaler's nine-entry navigation budget — that cap is a decision, not an accident, and check_inventory_module.mjs guards it");
// Counting href strings would be the wrong instrument and the first draft used
// it: the visibility screen's link is built by ONE helper CALLED TWICE, so the
// string appears twice in the file while the link appears in three places.
// Count what actually renders — the helper's call sites — not the text.
ok((wsSrc.match(/#\/wholesaler\/ranking-policy/g) || []).length >= 2,
   "the dashboard and the visibility screen both carry the link");
ok((wsSrc.match(/appendChild\(policyLink\(\)\)/g) || []).length >= 2,
   "and the visibility screen's link is rendered in BOTH its branches — one helper, defined once and appended in each");
ok(/outlet\.appendChild\(policyLink\(\)\);[\s\S]{0,60}return;/.test(wsSrc),
   "THE LINK RENDERS IN THE EMPTY STATE TOO — a wholesaler with no search data has nothing to check us against, so the rules are the only thing available to them, and a link that appears only once there is data is missing exactly when it is most wanted");
ok(/registerRankingPolicyRoute\(router\)/.test(wsSrc),
   "and the route is actually registered");
ok(/#\/wholesaler\/visibility/.test(view),
   "the page links to the visibility mirror, which is what makes its claims checkable BY the supplier rather than promised by us");

// ============================================ 8. FAILURE IS NOT A SILENT BLANK
RPC = { v2_ranking_parameters_published: async () => ({ data: null, error: { message: "boom" } }) };
const outlet2 = document.createElement("div");
document.body.appendChild(outlet2);
await render(outlet2);
await settle(); await settle();
ok(/could not be loaded/i.test(outlet2.innerHTML),
   'when the numbers cannot be fetched the page SAYS SO — a policy page showing blanks where numbers belong is worse than one that admits it failed');

// ==================================================================== 9. XSS
RPC = { v2_ranking_parameters_published: async () => ({
  data: [{ key: "popular_min_buyers", int_value: null, text_value: '<img src=x onerror=alert(1)>' }], error: null }) };
const outlet3 = document.createElement("div");
document.body.appendChild(outlet3);
await render(outlet3);
await settle(); await settle();
ok(!outlet3.querySelector("img"),
   "a parameter value containing markup is escaped — these values land in innerHTML");

// ------------------------------------------------- report
console.log("\n=== check_ranking_policy.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_ranking_policy.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
