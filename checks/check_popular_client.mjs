// =============================================================================
// GATE — THE POPULAR SHELF, CLIENT SIDE                        RC-02, 30 Aug 2026
// =============================================================================
// The mapper and the rail heading, in jsdom, against a stubbed RPC.
//
// THE PROPERTIES THIS FILE EXISTS FOR, in the order they would hurt:
//
//   1. THE HEADING COMES FROM THE ANSWER, NEVER FROM THE QUESTION. Ask for
//      "tops" and get a widened list back, and the rail must NOT say "Popular
//      in Tops". A heading that describes a narrowing the database declined to
//      make is a small lie told confidently, and it is the kind a screenshot
//      never catches because the list underneath looks fine.
//
//   2. THE FIELD LIST IS EXACTLY TEN. No row spread. A column added to
//      v2_popular_now for one screen must not appear on another because nobody
//      was looking — the DR-05 class of leak.
//
//   3. NO wid IS EVER SENT. Scope is derived in the database. If the client can
//      name a store, the client can name a store it was never given.
//
//   4. AN EMPTY ANSWER RENDERS NOTHING AT ALL. Not "nothing is popular yet".
//      On today's production data this is the shipping case.
//
// RUN:  node checks/check_popular_client.mjs
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

const { devAuth } = await import("../js/lib/dev-auth.js");
const { listPopularNow, POPULAR_FIELDS, popularTitle, popularSubtitle } =
  await import("../js/data/popular.js");
const { renderProductRail } = await import("../js/components/product-rail.js");

devAuth.adoptBuyerSession({
  role: "buyer", wid: "alpha", wholesalerName: "Alpha",
  actorId: "acc-1", actorLabel: "Zed", accountId: "acc-1",
  clientId: "cli-1", shopName: "Zed Shop", discountPct: 0,
});

const ROW = (over = {}) => ({
  product_id: "p1", product_name: "Rival Tee", wid: "alpha",
  wholesaler_name: "Alpha Supply", image_url: null, price_from: "11.50",
  currency: "$", buyer_count: "4", category_key: "tops", narrowed: true,
  ...over,
});

// ------------------------------------------------- 1. the field list is fixed
RPC = { v2_popular_now: async () => ({ data: [ROW()], error: null }) };
let rows = await listPopularNow({ limit: 12 });
ok(rows.length === 1, "a row comes through the mapper");
const keys = Object.keys(rows[0]);
ok(keys.length === POPULAR_FIELDS.length && POPULAR_FIELDS.every((k, i) => keys[i] === k),
   `the mapper returns EXACTLY the ten declared fields, in order — got [${keys.join(", ")}]`);

// the extra column that must not appear
RPC = { v2_popular_now: async () => ({ data: [ROW({ internal_margin_pct: 42 })], error: null }) };
rows = await listPopularNow({});
ok(!("internal_margin_pct" in rows[0]) && !("internalMarginPct" in rows[0]),
   "a column added to the function for some other screen does NOT reach the tile — no row spread, which is how DR-05-class leaks happen");

// ------------------------------------------------- 2. types are converted once
RPC = { v2_popular_now: async () => ({ data: [ROW()], error: null }) };
rows = await listPopularNow({});
ok(rows[0].buyerCount === 4, `buyer_count arrives as a bigint STRING over PostgREST and is converted once, here — got ${JSON.stringify(rows[0].buyerCount)}`);
ok(rows[0].priceFrom === 11.5, "price is a number");

RPC = { v2_popular_now: async () => ({ data: [ROW({ price_from: null })], error: null }) };
rows = await listPopularNow({});
ok(rows[0].priceFrom === null,
   "an unknown price stays NULL rather than becoming 0 — Number(null) is 0, and 'from $0.00' is a different claim from 'we do not know'");

// ------------------------------------------------- 3. no wid, ever
CALLS.length = 0;
RPC = { v2_popular_now: async () => ({ data: [], error: null }) };
await listPopularNow({ categoryKey: "tops" });
const call = CALLS.find((c) => c.name === "v2_popular_now");
ok(call && !JSON.stringify(call.args).toLowerCase().includes("wid"),
   "the call carries NO wholesaler code — scope is derived inside the database and there is nothing here for a caller to claim");
ok(call && call.args.p_category_key === "tops", "the category asked for is passed through");

// ------------------------------------------------- 4. THE HEADING
ok(popularTitle([{ narrowed: true, categoryKey: "tops" }]) === "Popular in Tops",
   "a genuinely narrowed rail names its category");
ok(popularTitle([{ narrowed: false, categoryKey: "tops" }]) === "Popular right now",
   "A RAIL THAT WIDENED DOES NOT CLAIM THE CATEGORY. The database said it could not answer inside 'tops'; a heading that says otherwise is a lie the list underneath will not contradict");
ok(popularTitle([]) === "Popular right now", "an empty list has a neutral heading");
ok(popularSubtitle([]) === null, "and no subtitle");
ok(/several different shops/i.test(popularSubtitle([{}]) || ""),
   "the subtitle says what the number MEANS — 'several different shops' is a claim a buyer can weigh; 'popular' alone is one they must take on trust while spending money");

// the heading is built from the ROWS, not from what was asked for
RPC = { v2_popular_now: async () => ({ data: [ROW({ narrowed: false, category_key: "bottoms" })], error: null }) };
rows = await listPopularNow({ categoryKey: "tops" });
ok(popularTitle(rows) === "Popular right now",
   "asking for 'tops' and receiving a widened list produces a NEUTRAL heading — the title is derived from the answer and never from the question");

// ------------------------------------------------- 5. failure is silence
RPC = { v2_popular_now: async () => ({ data: null, error: { message: "boom" } }) };
// Wrapped, because a mapper that THROWS would otherwise take this gate down
// with it and exit non-zero with no FAIL line — which looks like a pass that
// crashed and proves nothing. Red proof C5 made exactly that happen.
try {
  rows = await listPopularNow({});
  ok(Array.isArray(rows) && rows.length === 0,
     "an RPC error returns [] rather than throwing — this runs in a render path, and a shelf that throws takes the buyer's home screen down with it");
} catch (e) {
  ok(false, `an RPC error THREW out of the mapper (${e.message}) — this runs in a render path, and a shelf that throws takes the buyer's home screen down with it`);
}

devAuth.logout?.();
const noSession = await (async () => {
  const saved = devAuth.getSession;
  devAuth.getSession = () => null;
  const r = await listPopularNow({});
  devAuth.getSession = saved;
  return r;
})();
ok(noSession.length === 0, "no session means no call and no rows");

// ------------------------------------------------- 6. empty renders NOTHING
ok(renderProductRail({ title: "Popular right now", items: [], testId: "popular" }) === null,
   "AN EMPTY SHELF IS NO SHELF. Not 'nothing is popular yet' — on today's production data almost nothing clears the minimum-buyer floor, so this is the shipping case, and a permanently empty strip would take the best space on the screen to say 'no'");

// ------------------------------------------------- 7. it is not a paid rail
const rail = renderProductRail({
  title: "Popular right now", items: [{
    productId: "p1", productName: "Rival Tee", wid: "alpha", wholesalerName: "Alpha Supply",
    imageUrl: null, priceFrom: 11.5, currency: "$", buyerCount: 4,
  }], testId: "popular",
});
ok(rail !== null, "a non-empty shelf renders");
ok(!/sponsored|promoted|paid|ad\b/i.test(rail.textContent),
   "the popular rail carries NO paid disclosure, because it is NOT paid — 099 is asserted never to read v2_oggi_promoted, and the day a paid rail ships it passes paidLabel and says so in the title row");
ok(rail.querySelector('[data-tile]')?.getAttribute("data-wid") === "alpha",
   "every tile names the store it is from — this rail is cross-store and 'who am I buying from' must be answerable without a tap");

// ------------------------------------------------- 8. mounted, and not awaited
const { readFileSync } = await import("node:fs");
const buyerSrc = readFileSync(new URL("../js/views/buyer.js", import.meta.url).pathname, "utf8");
// NOT just "is there a .then" — `await listPopularNow(...).then(...)` has one
// too, and blocks the catalogue exactly the same. Red proof C6 slipped straight
// past the first version of this assertion, which is what a regex written to
// confirm the happy path does. The `await` is the thing being forbidden, so the
// `await` is what the assertion has to look for.
ok(/listPopularNow\(\s*\{[^}]*\}\s*\)\.then\(/.test(buyerSrc),
   "the shelf is fetched and handled with .then");
ok(!/await\s+listPopularNow\(/.test(buyerSrc),
   "and it is NOT awaited — a convenience shelf that blocks the catalogue has taken the screen the buyer actually came for hostage to a ranking query");
ok(/title:\s*popularTitle\(items\)/.test(buyerSrc),
   "the view uses popularTitle(items) rather than hardcoding a heading — the one place the narrowing claim is decided");
ok(buyerSrc.indexOf("popularSlot") > buyerSrc.indexOf("reorderSlot"),
   "and it sits BELOW the reorder shelf, which is the shelf it must never repeat");

// ------------------------------------------------- report
console.log("\n=== check_popular_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_popular_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
