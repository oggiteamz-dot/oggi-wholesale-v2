// =============================================================================
// GATE — THE REORDER RAIL                                      RC-01, 30 Aug 2026
// =============================================================================
// Renders js/components/product-rail.js in jsdom and asserts what a buyer SEES,
// plus the shape js/data/reorder.js is allowed to hand it.
//
// THE THREE PROPERTIES THIS FILE EXISTS FOR:
//
//   1. NOTHING is rendered when there is nothing to reorder. As of 30 Aug this
//      is the ONLY state on production — no account that can log in has ever
//      placed an order — so the empty case is the shipping case, not an edge.
//   2. The order the database chose is the order rendered. 095 ranks by
//      most-recent-then-frequency and a gate proves that ranking; a second
//      opinion in the browser would make that proof describe nothing anybody
//      sees.
//   3. Every tile names its store. The rail is cross-store, so "who am I buying
//      this from" must be answerable without a tap.
//
// Assertions are on STRUCTURE (data-tile, data-store, data-paid), not on copy,
// so improving the wording does not break the gate. The exception is the paid
// disclosure, where the words ARE the feature.
//
// RUN:  node checks/check_buy_it_again.mjs
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

// The mapper imports the Supabase client, which reads window.supabase at module
// load. Stubbed BEFORE the import below — the module cache makes stubbing after
// the fact useless. Same reasoning as check_wholesaler_directory.
dom.window.supabase = {
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async () => ({ data: [], error: null }),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const { renderProductRail } = await import("../js/components/product-rail.js");
const { REORDER_FIELDS } = await import("../js/data/reorder.js");

// Deliberately out of alphabetical and out of price order, so "rendered in the
// order given" is distinguishable from "rendered in some order that happens to
// look right".
const ITEMS = [
  { productId: "p-zeta",  productName: "Zeta Jacket",  wid: "beta",  wholesalerName: "Beta Supply",  imageUrl: "https://img.test/z.jpg", priceFrom: 55,   currency: "€", timesOrdered: 1, lastOrderedAt: "2026-08-29T10:00:00Z" },
  { productId: "p-alpha", productName: "Alpha Shirt",  wid: "alpha", wholesalerName: "Alpha Supply", imageUrl: null,                    priceFrom: 24.5, currency: "$", timesOrdered: 2, lastOrderedAt: "2026-08-26T10:00:00Z" },
  { productId: "p-mid",   productName: "Mid Pant",     wid: "alpha", wholesalerName: "Alpha Supply", imageUrl: "https://img.test/m.jpg", priceFrom: 18,   currency: "$", timesOrdered: 1, lastOrderedAt: "2026-08-20T10:00:00Z" },
];

// ---------------------------------------------------- 1. the empty case
for (const empty of [[], null, undefined]) {
  const el = renderProductRail({ title: "Buy it again", items: empty, testId: "reorder" });
  ok(el === null, `an empty rail (${JSON.stringify(empty)}) renders NOTHING — not an empty card, not "you haven't ordered yet"`);
}

// ---------------------------------------------------- 2. the populated case
const rail = renderProductRail({ title: "Buy it again", items: ITEMS, testId: "reorder" });
ok(rail instanceof dom.window.HTMLElement, "a populated rail renders an element");
dom.window.document.getElementById("app-root").appendChild(rail);

const tiles = [...rail.querySelectorAll("[data-tile]")];
ok(tiles.length === 3, `one tile per item — rendered ${tiles.length}, expected 3`);

ok(rail.textContent.includes("Buy it again"), "the rail carries its title");

// ---------------------------------------------------- 3. order is preserved
const renderedIds = tiles.map((t) => t.getAttribute("data-product-id"));
ok(
  JSON.stringify(renderedIds) === JSON.stringify(ITEMS.map((i) => i.productId)),
  `tiles render in the order the database gave them — got ${renderedIds.join(",")}`
);

// ---------------------------------------------------- 4. every tile names its store
const named = tiles.filter((t) => (t.querySelector("[data-store]")?.textContent || "").trim().length > 0);
ok(named.length === 3, `all 3 tiles name their wholesaler — ${named.length} did`);
ok(
  tiles[0].querySelector("[data-store]").textContent.trim() === "Beta Supply",
  "the store name on a tile is THAT tile's store, not the buyer's current one"
);

// ---------------------------------------------------- 5. price and frequency
ok(rail.textContent.includes("€55.00"), "a price is rendered in ITS OWN store's currency, to two decimals");
ok(rail.textContent.includes("$24.50"), "a second store's row uses that store's currency");
ok(/2.\s*ordered/.test(rail.textContent), "how many times it was ordered is shown");

// A product with no known price must not be rendered as free.
const noPrice = renderProductRail({
  title: "x", testId: "np",
  items: [{ ...ITEMS[0], priceFrom: null }],
});
ok(!noPrice.textContent.includes("0.00"), 'a product with an unknown price does not render as "0.00" — "we do not know" is not "free"');

// ---------------------------------------------------- 6. missing image
const noImg = tiles[1].querySelector("img");
ok(noImg === null, "a product with no photo renders no <img> at all rather than a broken one");
ok(tiles[0].querySelector("img")?.getAttribute("src") === "https://img.test/z.jpg", "a product with a photo renders it");

// ---------------------------------------------------- 7. ESCAPING
// Product names arrive from wholesaler CSV imports. That is untrusted input.
const nasty = renderProductRail({
  title: "Buy it again", testId: "esc",
  items: [{
    ...ITEMS[0],
    productName: '<img src=x onerror="window.__pwned=1">',
    wholesalerName: '</div><script>window.__pwned2=1</script>',
  }],
});
dom.window.document.getElementById("app-root").appendChild(nasty);
ok(dom.window.__pwned === undefined && dom.window.__pwned2 === undefined, "injected markup in a product or store name does not execute");
ok(nasty.querySelectorAll("script").length === 0, "an injected <script> tag is not created as an element");
const injectedImgs = [...nasty.querySelectorAll("img")].filter((i) => i.getAttribute("src") === "x");
ok(injectedImgs.length === 0, "an injected <img onerror> is not created as an element");
ok(nasty.textContent.includes("onerror"), "the injected text is still SHOWN to the buyer, as text — escaped, not silently dropped");

// ---------------------------------------------------- 8. the paid disclosure
const organic = renderProductRail({ title: "Buy it again", items: ITEMS, testId: "o" });
ok(organic.querySelector("[data-paid]") === null, "an organic rail carries no paid label");

const paid = renderProductRail({
  title: "Featured by OGGI", items: ITEMS, testId: "p",
  paidLabel: "We earn a commission on these",
});
ok(paid.querySelector("[data-paid]") !== null, "a paid rail renders its disclosure");
ok(
  /commission/i.test(paid.querySelector("[data-paid]").textContent),
  'the paid disclosure says COMMISSION — "Featured" alone is a euphemism, and a buyer is entitled to know a placement was bought'
);

// ---------------------------------------------------- 9. the tap
let opened = null;
const clickable = renderProductRail({ title: "t", items: ITEMS, testId: "c", onOpen: (it) => { opened = it; } });
dom.window.document.getElementById("app-root").appendChild(clickable);
clickable.querySelector("[data-tile]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
ok(opened !== null, "tapping a tile does something");
ok(opened?.productId === "p-zeta" && opened?.wid === "beta",
   "the tap carries BOTH the product and ITS store — a cross-store rail cannot assume the current one");

// ---------------------------------------------------- 10. THE FIELD LIST
// The mapper's contract, asserted against its own exported list rather than a
// copy of it: a duplicated expectation drifts, and then the check passes while
// agreeing with itself about the wrong thing.
ok(REORDER_FIELDS.length === 9, `the mapper returns exactly 9 fields — it declares ${REORDER_FIELDS.length}`);
const src = read(new URL("../js/data/reorder.js", import.meta.url).pathname);
const mapBody = src.slice(src.indexOf("return (data || []).map"), src.indexOf("export const REORDER_FIELDS"));
const emitted = [...mapBody.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]);
ok(
  JSON.stringify(emitted) === JSON.stringify([...REORDER_FIELDS]),
  `the mapper emits exactly the declared fields — emits [${emitted.join(",")}]`
);
ok(!/\.\.\.r\b/.test(mapBody), "the mapper does not spread the database row — a column added for another screen must not appear here by accident");

// ---------------------------------------------------- report
console.log("\n=== check_buy_it_again.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_buy_it_again.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
