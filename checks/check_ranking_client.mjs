// =============================================================================
// GATE — THE RANKING SETTINGS SCREEN, CLIENT SIDE              SR-07, 30 Aug 2026
// =============================================================================
// The mapper and the owner screen, in jsdom, against a stubbed RPC.
//
// THE PROPERTIES THIS FILE EXISTS FOR, in the order they would hurt:
//
//   1. A CHANGE CANNOT BE SAVED WITHOUT A REASON, AND CANCELLING THE REASON
//      WRITES NOTHING. The value dialog and the reason dialog are two separate
//      steps, and the obvious implementation — save on the first, ask for the
//      reason afterwards — would write a reasonless change and then decorate
//      it. The database refuses that anyway; this asserts the client never
//      even tries, because a refusal the user has to discover is a bad screen.
//
//   2. THE EXPLANATION IS RENDERED. `popular_min_buyers = 3` means nothing on
//      its own. A screen that shows the number and hides the note is a screen
//      that invites a wrong edit.
//
//   3. THE INTEGRITY LINE IS SHOWN WHETHER OR NOT ANYTHING IS WRONG. A tamper
//      check you only ever see when it fails is one nobody knows exists, and
//      its silence cannot be told from it never having run.
//
//   4. THE FIELD LIST IS FIXED. No row spread — the DR-05 class of leak.
//
// RUN:  node checks/check_ranking_client.mjs
// =============================================================================
import { JSDOM } from "jsdom";

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

const CALLS = [];
let RPC = {};
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

const {
  listRankingConfig, listRankingHistory, rankingConfigAsOf,
  setRankingNumber, verifyRankingHistory,
} = await import("../js/data/ranking-config.js");

const CFG = (over = {}) => ({
  key: "popular_min_buyers", int_value: 3, text_value: null,
  note: "How many DIFFERENT shops must have bought a product before it may be called popular.",
  updated_at: "2026-08-29T22:17:43Z", last_reason: null, last_actor: "postgres",
  last_source: "database", change_count: 0, ...over,
});

// ------------------------------------------------ 1. the field list is fixed
const FIELDS = ["key","intValue","textValue","note","updatedAt","lastReason","lastActor","lastSource","changeCount"];
RPC = { v2_ranking_config_list: async () => ({ data: [CFG()], error: null }) };
let rows = await listRankingConfig();
ok(rows.length === 1, "a settings row comes through the mapper");
ok(Object.keys(rows[0]).length === FIELDS.length && FIELDS.every((k, i) => Object.keys(rows[0])[i] === k),
   `the mapper returns EXACTLY the nine declared fields, in order — got [${Object.keys(rows[0]).join(", ")}]`);

RPC = { v2_ranking_config_list: async () => ({ data: [CFG({ internal_cost_basis: 9 })], error: null }) };
rows = await listRankingConfig();
ok(!("internal_cost_basis" in rows[0]) && !("internalCostBasis" in rows[0]),
   "a column added to the function for some other screen does NOT reach the view — no row spread");

// ------------------------------------------------ 2. a reason is required
CALLS.length = 0;
RPC = { v2_ranking_config_set: async () => ({ data: [{ ok: true, message: "saved" }], error: null }) };
let res = await setRankingNumber({ key: "popular_min_buyers", intValue: 4, reason: "" });
ok(res.ok === false, "a change with an empty reason is refused");
ok(!CALLS.some((c) => c.name === "v2_ranking_config_set"),
   "and the refusal happens BEFORE the round trip — no write was even attempted");

res = await setRankingNumber({ key: "popular_min_buyers", intValue: 4, reason: "ok" });
ok(res.ok === false, "a two-character reason is refused too — the rule is a real reason, not a keystroke");

CALLS.length = 0;
res = await setRankingNumber({ key: "popular_min_buyers", intValue: 4, reason: "three is too low now there are twelve shops" });
const setCall = CALLS.find((c) => c.name === "v2_ranking_config_set");
ok(res.ok === true && setCall, "a real reason goes through");
ok(setCall && setCall.args.p_reason === "three is too low now there are twelve shops",
   "and the reason reaches the database verbatim — it is the thing a wholesaler will one day be shown");

// ------------------------------------------------ 3. errors are not silent lies
RPC = { v2_ranking_config_set: async () => ({ data: null, error: { message: "boom" } }) };
res = await setRankingNumber({ key: "popular_min_buyers", intValue: 4, reason: "a good reason here" });
ok(res.ok === false, "an RPC error reports NOT saved rather than reporting success");

// ------------------------------------------------ 4. the verifier's three answers
RPC = { v2_ranking_history_verify: async () => ({ data: [], error: null }) };
ok(Array.isArray(await verifyRankingHistory()) && (await verifyRankingHistory()).length === 0,
   "an intact record verifies to an empty list");
RPC = { v2_ranking_history_verify: async () => ({ data: null, error: { message: "x" } }) };
ok((await verifyRankingHistory()) === null,
   "a verifier that could not RUN returns null, not [] — 'we could not check' and 'nothing is wrong' must not be the same value");

// ------------------------------------------------ 5. as-of passes a real instant
CALLS.length = 0;
RPC = { v2_ranking_config_as_of: async () => ({ data: [], error: null }) };
await rankingConfigAsOf(new Date("2026-03-04T12:00:00Z"));
const asOfCall = CALLS.find((c) => c.name === "v2_ranking_config_as_of");
ok(asOfCall && asOfCall.args.p_when === "2026-03-04T12:00:00.000Z",
   "as-of sends an ISO instant, not a bare date string the database has to guess a timezone for");

// ------------------------------------------------ 6. THE SCREEN RENDERS
RPC = {
  v2_ranking_config_list: async () => ({ data: [
    CFG(),
    CFG({ key: "similar_stop_words", int_value: null, text_value: "the,and,a", note: "Words that carry no meaning in a product name.", last_source: "app", last_actor: "Hadi", last_reason: "dropped 'premium'", change_count: 2 }),
  ], error: null }),
  v2_ranking_history_list: async () => ({ data: [
    { id: 2, key: "similar_stop_words", op: "update", old_value: "the,and", new_value: "the,and,a",
      reason: "dropped 'premium'", actor: "Hadi", actor_source: "app", changed_at: "2026-08-30T01:00:00Z" },
    { id: 1, key: "popular_min_buyers", op: "baseline", old_value: null, new_value: "3",
      reason: "Recorded at install", actor: "postgres", actor_source: "database", changed_at: "2026-08-29T22:17:43Z" },
  ], error: null }),
  v2_ranking_history_verify: async () => ({ data: [], error: null }),
};
const { registerOwnerRankingRoute } = await import("../js/views/owner-ranking.js");
let view = null;
registerOwnerRankingRoute({ register: (path, fn) => { if (path === "/owner/ranking") view = fn; } });
ok(typeof view === "function", "the /owner/ranking route is registered");

const outlet = document.createElement("div");
document.body.appendChild(outlet);
await view(outlet);
await settle(); await settle();
const html = outlet.innerHTML;

ok(/popular_min_buyers/.test(html), "the setting's name is on the screen");
ok(/How many DIFFERENT shops/.test(html),
   "THE EXPLANATION IS RENDERED, not hidden behind an icon — a bare '3' is a number nobody can safely change");
ok(/Record integrity: intact/.test(html),
   "the integrity line is shown even when nothing is wrong — a check you only see on failure is one nobody knows exists");
ok(/database/.test(html) && /in the app/.test(html),
   "a change made against the database is labelled differently from one made in the app");
ok(/dropped &#x27;premium&#x27;|dropped 'premium'/.test(html), "the reason given for a past change is displayed");
ok(/What were the rules on/.test(html), "the as-of question is on the screen");
ok(/started at/.test(html), "a baseline entry reads as a starting point, not as a change from nothing");
ok(/never changed since the record began/.test(html),
   "a setting nobody has touched says so, rather than showing a blank where a history would be");

// ------------------------------------------------ 7. XSS, because notes and
// reasons are free text typed by a person and rendered into innerHTML.
RPC.v2_ranking_config_list = async () => ({ data: [CFG({ note: '<img src=x onerror=alert(1)>', last_reason: '<script>bad()</script>' })], error: null });
const outlet2 = document.createElement("div");
document.body.appendChild(outlet2);
await view(outlet2);
await settle(); await settle();
ok(!outlet2.querySelector("img") && !outlet2.querySelector("script"),
   "a note or reason containing markup is ESCAPED — these are free text and they land in innerHTML");

// ------------------------------------------------ 8. the empty answer
RPC.v2_ranking_config_list = async () => ({ data: [], error: null });
const outlet3 = document.createElement("div");
document.body.appendChild(outlet3);
await view(outlet3);
await settle(); await settle();
ok(/owner-only|not been installed/i.test(outlet3.innerHTML),
   "a non-owner (or a database without the settings) gets an explanation, not a blank screen");

// ------------------------------------------------ 9. it is reachable
const navSrc = await (await import("node:fs/promises")).readFile(new URL("../js/lib/nav-config.js", import.meta.url), "utf8");
ok(navSrc.includes('"/owner/ranking"'),
   "the screen is in the owner's navigation — a route nobody can reach is a route that does not exist");
const ownerSrc = await (await import("node:fs/promises")).readFile(new URL("../js/views/owner.js", import.meta.url), "utf8");
ok(/registerOwnerRankingRoute\(router\)/.test(ownerSrc),
   "and owner.js actually registers it");

// ------------------------------------------------ report
console.log("\n=== check_ranking_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_ranking_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
