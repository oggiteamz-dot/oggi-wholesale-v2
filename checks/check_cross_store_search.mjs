// =============================================================================
// GATE — THE SEARCH SCREEN                              SR-01, SR-10, 29 Aug 2026
// =============================================================================
// The database half is gated by check_cross_store_search.sql. This one asserts
// what the SCREEN does with the answer.
//
// The load-bearing assertions here are about PROVENANCE and PROMISES:
//   * every result says which wholesaler it came from — a buyer comparing two
//     prices is deciding who to buy from, and a card that hides the seller
//     makes that decision impossible
//   * the price is labelled "from" — the exact price depends on the buyer's
//     client record in that store, and a search result that quotes a price the
//     order does not honour is a complaint, not a rounding error
//   * the mapper drops anything the server did not promise (the lesson of the
//     directory's vacuous DR-05 block — see check_wholesaler_directory.mjs)
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
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
if (!dom.window.crypto?.randomUUID) dom.window.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };

let RPC_RESULT = { data: null, error: null };
let LAST_RPC = null;
dom.window.supabase = {
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async (name, args) => { LAST_RPC = { name, args }; return RPC_RESULT; },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const flush = () => new Promise((r) => setTimeout(r, 0));

dom.window.localStorage.setItem("oggi-v2-dev-session", JSON.stringify({
  role: "buyer", wid: "alpha", accountId: "acc-1",
  actorId: "acc-1", actorLabel: "Test Buyer",
}));
const { devAuth } = await import("../js/lib/dev-auth.js");
await devAuth.bootstrap();
if (!devAuth.getSession()?.accountId) {
  console.log("  !! SETUP FAILED — the stub session did not take; nothing below tested the screen.");
  process.exit(2);
}

const { searchView, registerSearchRoutes } = await import("../js/views/search.js");

const ROWS = [
  { product_id: "p1", product_name: "Blue Denim Jacket", category: "Outerwear",
    wid: "alpha", wholesaler_name: "Alpha Textiles", image_url: null,
    price_from: 19.5, currency: "$" },
  { product_id: "p2", product_name: "Blue Denim Shirt", category: "Shirts",
    wid: "beta", wholesaler_name: "Beta Trading", image_url: null,
    price_from: 30, currency: "$" },
];

async function render(rows, query = "denim") {
  RPC_RESULT = { data: rows, error: null };
  const outlet = document.createElement("div");
  document.body.appendChild(outlet);
  await searchView(outlet);
  await flush();
  const form = outlet.querySelector(".sr-form");
  form.querySelector('[name="q"]').value = query;
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush(); await flush();
  return outlet;
}

// ============================ PROVENANCE ====================================
{
  const o = await render(ROWS);
  const cards = o.querySelectorAll(".sr-card");
  ok(cards.length === 2, "every result in the answer gets a card");

  const a = o.querySelector('.sr-card[data-wid="alpha"]');
  const b = o.querySelector('.sr-card[data-wid="beta"]');
  ok(!!a && !!b, "SR-01 results from DIFFERENT wholesalers appear together — this is the cross-store feature");

  ok(/Alpha Textiles/.test(a?.querySelector(".sr-from")?.textContent || ""),
     "each card names the wholesaler it came from");
  ok(/Beta Trading/.test(b?.querySelector(".sr-from")?.textContent || ""),
     "and so does the one from the other store — a buyer comparing prices is deciding WHO to buy from");

  ok(/2 results from 2 wholesalers/.test(o.textContent),
     "the count says how many STORES the results span, not just how many products");
}

// ============================ PROMISES ======================================
{
  const o = await render(ROWS);
  const price = o.querySelector('.sr-card[data-wid="alpha"] .sr-price')?.textContent || "";
  ok(/19\.50/.test(price), "the price is shown");
  ok(/^from /i.test(price.trim()),
     "and is labelled 'from' — the exact price depends on the buyer's client record in that store, and quoting a price the order does not honour is a complaint");
}

// ============================ THE PROMOTED SHELF (SR-02, SR-03) =============
// The disclosure IS the feature. A shelf a buyer cannot tell apart from the
// results is the thing several marketplaces have been fined for.
{
  const rows = [
    { product_id: "x1", product_name: "Promoted Widget", category: "W", wid: "alpha",
      wholesaler_name: "Alpha Textiles", image_url: null, price_from: 9, currency: "$",
      is_promoted: true, slot: "promoted" },
    { product_id: "x1", product_name: "Promoted Widget", category: "W", wid: "alpha",
      wholesaler_name: "Alpha Textiles", image_url: null, price_from: 9, currency: "$",
      is_promoted: true, slot: "organic" },
    { product_id: "x2", product_name: "Ordinary Widget", category: "W", wid: "beta",
      wholesaler_name: "Beta Trading", image_url: null, price_from: 8, currency: "$",
      is_promoted: false, slot: "organic" },
  ];
  const o = await render(rows, "widget");

  const shelf = o.querySelector('[data-slot="promoted"]');
  ok(!!shelf, "promoted results are rendered in a SEPARATE block, not mixed into the results");

  const label = shelf?.querySelector(".sr-promoted-label")?.textContent || "";
  ok(label.trim().length > 0, "the shelf carries a label");
  ok(/commission/i.test(label),
     "and the label says we earn a COMMISSION — 'Featured' alone is a euphemism, and a buyer is entitled to know a placement was paid for");

  ok(shelf?.querySelectorAll(".sr-card").length === 1, "the shelf holds only the promoted rows");
  ok(!!shelf?.querySelector('[data-promoted="true"]'),
     "and each is marked, so the flag is checkable and not merely visual");

  const organic = o.querySelector('[data-slot="organic"]');
  ok(!!organic && organic.querySelectorAll(".sr-card").length === 2,
     "the organic list holds ALL results including the promoted one in its honest position — the shelf adds, it does not replace");

  ok(/2 results from 2 wholesalers/.test(o.textContent),
     "the count describes the ORGANIC results only — counting the shelf too would inflate what the buyer thinks they found, since the same product is in both");

  const blob = o.innerHTML;
  ok(!/commission_pct/.test(blob) && !/12\.5/.test(blob),
     "the commission RATE never reaches the page — the label discloses that a placement is paid, not what OGGI earns");
}

// ============================ THE MAPPER ====================================
{
  const { searchProducts } = await import("../js/data/search.js");
  RPC_RESULT = { data: [{
    product_id: "p9", product_name: "Leak Test", category: "X", wid: "w",
    wholesaler_name: "W", image_url: null, price_from: 5, currency: "$",
    cost: 1.11, supplier_id: "SENTINEL-SUPPLIER", fulfil_note: "SENTINEL-NOTE",
    owner_phone: "SENTINEL-PHONE",
  }], error: null };
  const rows = await searchProducts("x");
  const keys = Object.keys(rows[0] || {}).sort();
  // Ten named fields since 093 added isPromoted and slot (SR-03). Still an
  // EXACT list rather than a minimum: a field the server starts returning
  // by accident must fail here, and adding one deliberately must be a
  // visible edit to this line.
  const expected = ["category","currency","imageUrl","isPromoted","name","priceFrom","productId","slot","wholesalerName","wid"].sort();
  ok(JSON.stringify(keys) === JSON.stringify(expected),
     `the mapper keeps exactly the eight search fields and drops everything else (got: ${keys.join(",")})`);
  const blob = JSON.stringify(rows);
  ok(!/SENTINEL-SUPPLIER/.test(blob) && !/SENTINEL-NOTE/.test(blob) && !/SENTINEL-PHONE/.test(blob),
     "cost, supplier, the wholesaler's internal note and phone do not survive the mapper even if the server sends them");
  ok(!/1\.11/.test(blob), "and neither does cost price — the thing a wholesaler would least like a buyer to see");
}

// ============================ SCOPE CANNOT BE NAMED =========================
{
  await render(ROWS);
  ok(LAST_RPC?.name === "v2_search_products", "it calls v2_search_products");
  const argKeys = Object.keys(LAST_RPC?.args || {});
  ok(!argKeys.includes("p_wid") && !argKeys.some((k) => /wid/i.test(k)),
     "and passes NO wid — the client cannot name a store to search, which is the whole security property");

  const data = read("js/data/search.js");
  ok(!/p_wid/.test(data),
     "the module contains no wid parameter at all, so it cannot grow one by accident");
}

// ============================ THE EMPTY PATH ================================
{
  const o = await render([], "nothing-matches");
  ok(o.querySelectorAll(".sr-card").length === 0, "an empty answer renders no cards");
  ok(/Nothing found/i.test(o.textContent), "and says so");
  ok(/access/i.test(o.textContent),
     "and explains that the search was SCOPED — a buyer who does not know that reads an empty result as 'OGGI has nothing'");
}
{
  const o = await render(ROWS, "a");
  ok(o.querySelectorAll(".sr-card").length === 0, "a one-character query is not searched");
  ok(/at least two characters/i.test(o.textContent), "and the screen says why rather than looking broken");
}
{
  RPC_RESULT = { data: null, error: { message: "boom" } };
  const outlet = document.createElement("div");
  document.body.appendChild(outlet);
  let threw = false;
  try { await searchView(outlet); await flush(); } catch { threw = true; }
  ok(!threw, "a failing request does not throw");
}

// ============================ WIRING ========================================
{
  const routes = [];
  registerSearchRoutes({ register: (p) => routes.push(p) });
  ok(routes.includes("/buyer/search"), "search has a route");

  const nav = read("js/lib/nav-config.js");
  ok(/\/buyer\/search/.test(nav), "and a navigation entry");
  const buyerBlock = nav.slice(nav.indexOf("buyer: ["), nav.indexOf("]", nav.indexOf("buyer: [")));
  const entries = (buyerBlock.match(/path:/g) || []).length;
  ok(entries <= 9, `the buyer navigation stays within the nine-entry cap (${entries})`);

  const buyer = read("js/views/buyer.js");
  ok(/registerSearchRoutes\(router\)/.test(buyer), "and the route is actually registered");

  const form = document.querySelector(".sr-form");
  ok(!!document.querySelector('label[for="sr-q"]'), "the search input has a label for screen readers");
  ok(document.querySelector("#sr-q")?.getAttribute("autocapitalize") === "none",
     "and does not autocapitalise — a phone capitalising the first letter of a product search is a wrong result on a phone");
}

console.log("=".repeat(64));
console.log(" GATE — CROSS-STORE SEARCH SCREEN (SR-01, SR-10)");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — ${pass.length} assertions.\n`);
