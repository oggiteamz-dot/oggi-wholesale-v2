// =============================================================================
// GATE — THE SIMILAR SHELF, CLIENT SIDE                        RC-03, 30 Aug 2026
// =============================================================================
// The mapper, the subtitle and the mount point, in jsdom against a stubbed RPC.
//
// THE PROPERTIES THIS FILE EXISTS FOR:
//
//   1. THE RAIL IS MOUNTED ONLY WHERE "THIS" HAS A REFERENT. A "more like this"
//      shelf on the plain catalogue is a rail about nothing. It belongs inside
//      the pending-product-focus branch and nowhere else.
//
//   2. THE SUBTITLE COUNTS OTHER SUPPLIERS, AND CLAIMS NOTHING WHEN THERE ARE
//      NONE. Reaching another store is the whole value of the marketplace and
//      it is invisible from the tiles unless a buyer reads every store name.
//      Claiming it when it did not happen is the same lie in reverse.
//
//   3. TEN FIELDS, NO ROW SPREAD.
//
//   4. NO wid IS EVER SENT, AND THE ANCHOR ID IS.
//
// RUN:  node checks/check_similar_client.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

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
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url).pathname, "utf8"); } catch { return ""; } };

const { devAuth } = await import("../js/lib/dev-auth.js");
const { listSimilarProducts, SIMILAR_FIELDS, similarSubtitle } = await import("../js/data/similar.js");
const { renderProductRail } = await import("../js/components/product-rail.js");

devAuth.adoptBuyerSession({
  role: "buyer", wid: "alpha", wholesalerName: "Alpha",
  actorId: "acc-1", actorLabel: "Zed", accountId: "acc-1",
  clientId: "cli-1", shopName: "Zed Shop", discountPct: 0,
});

const ROW = (over = {}) => ({
  product_id: "p2", product_name: "Cargo Pant", wid: "beta",
  wholesaler_name: "Beta Supply", image_url: null, price_from: "19.00",
  currency: "$", shared_words: "2", same_category: true, cross_store: true,
  ...over,
});

// -------------------------------------------------- 1. the field list is fixed
RPC = { v2_similar_products: async () => ({ data: [ROW()], error: null }) };
let rows = await listSimilarProducts({ productId: "p1" });
ok(rows.length === 1, "a row comes through the mapper");
const keys = Object.keys(rows[0]);
ok(keys.length === SIMILAR_FIELDS.length && SIMILAR_FIELDS.every((k, i) => keys[i] === k),
   `the mapper returns EXACTLY the ten declared fields, in order — got [${keys.join(", ")}]`);

RPC = { v2_similar_products: async () => ({ data: [ROW({ supplier_cost: 4.10 })], error: null }) };
rows = await listSimilarProducts({ productId: "p1" });
ok(!("supplier_cost" in rows[0]) && !("supplierCost" in rows[0]),
   "a column added to the function for another screen does NOT reach the tile — no row spread, which is how DR-05-class leaks happen");

// -------------------------------------------------- 2. types converted once
RPC = { v2_similar_products: async () => ({ data: [ROW()], error: null }) };
rows = await listSimilarProducts({ productId: "p1" });
ok(rows[0].sharedWords === 2, `shared_words is converted to a number once, here — got ${JSON.stringify(rows[0].sharedWords)}`);
ok(rows[0].priceFrom === 19, "price is a number");
ok(rows[0].crossStore === true && rows[0].sameCategory === true, "the booleans survive");

RPC = { v2_similar_products: async () => ({ data: [ROW({ price_from: null })], error: null }) };
rows = await listSimilarProducts({ productId: "p1" });
ok(rows[0].priceFrom === null,
   "an unknown price stays NULL rather than becoming 0 — 'from $0.00' is a different claim from 'we do not know'");

// -------------------------------------------------- 3. what is sent
CALLS.length = 0;
RPC = { v2_similar_products: async () => ({ data: [], error: null }) };
await listSimilarProducts({ productId: "p1" });
const call = CALLS.find((c) => c.name === "v2_similar_products");
ok(call && !JSON.stringify(call.args).toLowerCase().includes("wid"),
   "the call carries NO wholesaler code — scope is derived in the database and there is nothing for a caller to claim");
ok(call && call.args.p_product_id === "p1", "the anchor product id IS sent — it is the whole question");

CALLS.length = 0;
rows = await listSimilarProducts({ productId: null });
ok(rows.length === 0 && CALLS.length === 0,
   "no anchor means no call at all — 'more like this' with no 'this' is not a question worth asking the server");

// -------------------------------------------------- 4. THE SUBTITLE
ok(similarSubtitle([]) === null, "an empty shelf claims nothing");
ok(similarSubtitle([{ crossStore: false, wid: "alpha" }]) === null,
   "a shelf that reached NO other supplier claims no other supplier — the marketplace value is only worth stating when it actually happened");
ok(similarSubtitle([{ crossStore: true, wid: "beta" }]) === "Including one other supplier you buy from",
   "one other supplier is named as one");
ok(/2 other suppliers/.test(similarSubtitle([
     { crossStore: true, wid: "beta" }, { crossStore: true, wid: "gamma" },
     { crossStore: true, wid: "beta" }, { crossStore: false, wid: "alpha" },
   ]) || ""),
   "and suppliers are counted DISTINCTLY — two stores across four tiles is two, not three");

// -------------------------------------------------- 5. failure is silence
RPC = { v2_similar_products: async () => ({ data: null, error: { message: "boom" } }) };
try {
  rows = await listSimilarProducts({ productId: "p1" });
  ok(Array.isArray(rows) && rows.length === 0,
     "an RPC error returns [] rather than throwing — this runs in a render path");
} catch (e) {
  ok(false, `an RPC error THREW out of the mapper (${e.message}) — this runs in a render path and would take the screen down`);
}

const noSession = await (async () => {
  const saved = devAuth.getSession;
  devAuth.getSession = () => null;
  const r = await listSimilarProducts({ productId: "p1" });
  devAuth.getSession = saved;
  return r;
})();
ok(noSession.length === 0, "no session means no rows");

// -------------------------------------------------- 6. empty renders NOTHING
ok(renderProductRail({ title: "More like this", items: [], testId: "similar" }) === null,
   "AN EMPTY SHELF IS NO SHELF — a product whose name shares no meaningful word with anything in the buyer's stores has no honest neighbours, and says so by being absent");

// -------------------------------------------------- 7. not a paid rail
const rail = renderProductRail({
  title: "More like this", items: [{
    productId: "p2", productName: "Cargo Pant", wid: "beta", wholesalerName: "Beta Supply",
    imageUrl: null, priceFrom: 19, currency: "$",
  }], testId: "similar",
});
ok(rail !== null, "a non-empty shelf renders");
ok(!/sponsored|promoted|paid/i.test(rail.textContent),
   "the similar rail carries NO paid disclosure because it is not paid — 100 is asserted never to read v2_oggi_promoted");
ok(rail.querySelector("[data-tile]")?.getAttribute("data-wid") === "beta",
   "every tile names its store — this rail is cross-store and that is the point of it");

// -------------------------------------------------- 8. WHERE it is mounted
const buyerSrc = read("../js/views/buyer.js");
ok(/listSimilarProducts\(/.test(buyerSrc), "the view calls listSimilarProducts");
ok(!/await\s+listSimilarProducts\(/.test(buyerSrc),
   "and does NOT await it — a convenience shelf must never hold up the catalogue the buyer came for");

// The mount must sit INSIDE the pending-product-focus branch. Checked by
// position, because a rail mounted on the plain catalogue is a rail about
// nothing and looks identical in a screenshot.
const focusAt = buyerSrc.indexOf("if (pendingProductFocus)");
const similarAt = buyerSrc.indexOf("listSimilarProducts(");
const orderBarAt = buyerSrc.indexOf("GAP-4");
ok(focusAt > -1 && similarAt > focusAt && (orderBarAt === -1 || similarAt < orderBarAt),
   "the rail is mounted INSIDE the pending-product-focus branch — 'more like this' is only a question when there is a 'this', and on the plain catalogue it would be a rail about nothing");
ok(/listSimilarProducts\(\{\s*productId:\s*target/.test(buyerSrc),
   "and it is anchored to the product the buyer was actually pointed at, not to something re-derived");
ok(/subtitle:\s*similarSubtitle\(items\)/.test(buyerSrc),
   "the subtitle is computed from the results rather than hardcoded");

// -------------------------------------------------- report
console.log("\n=== check_similar_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_similar_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
