// =============================================================================
// GATE — THE WHOLESALER DIRECTORY SCREEN            DR-01..DR-05, 29 Aug 2026
// =============================================================================
// Renders js/views/directory.js in jsdom against a stubbed RPC and asserts what
// a buyer actually SEES.
//
// The assertions are on STRUCTURE, not on copy. `data-access="member"` on the
// card, not the words "You have access" — a check that greps for button text
// breaks the moment someone improves the wording, which teaches people to stop
// improving wording. The one exception is the empty state, where the words ARE
// the feature.
//
// THE ASSERTION THAT MATTERS MOST is the last family: this screen shows a buyer
// businesses that have NOT let them in, so it must be provably incapable of
// showing anything belonging to those businesses beyond a name and a category.
//
// RUN:  node checks/check_wholesaler_directory.mjs
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

// One mutable stub installed BEFORE any import — the module cache makes
// re-stubbing after the fact useless. Same reasoning as check_order_handoff.
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

// The session lives in localStorage under a key that has not changed since
// Batch 0. It is written BEFORE dev-auth is imported, because getSession()
// hydrates from storage on first read and caches in memory after that.
dom.window.localStorage.setItem("oggi-v2-dev-session", JSON.stringify({
  role: "buyer", wid: "alpha", accountId: "acc-1",
  actorId: "acc-1", actorLabel: "Test Buyer", wholesalerName: "Alpha Textiles",
}));
const { devAuth } = await import("../js/lib/dev-auth.js");
// getSession() returns a cache that only bootstrap() fills — it is null until
// then, by design (app.js awaits bootstrap before the first render). A gate
// that skipped this would render an empty screen and blame the view.
await devAuth.bootstrap();
if (!devAuth.getSession()?.accountId) {
  console.log("  !! SETUP FAILED — the stub session did not take, so nothing below tested the screen.");
  process.exit(2);
}

const { directoryView, registerDirectoryRoutes } = await import("../js/views/directory.js");

const ROWS = [
  { wid: "alpha", name: "Alpha Textiles", brand: "Alpha", logo: null,
    categories: ["Womenswear", "Denim"], access: "member" },
  { wid: "beta",  name: "Beta Trading",   brand: "Beta",  logo: null,
    categories: ["Menswear"],            access: "none"   },
  { wid: "gamma", name: "Gamma Supply",   brand: "Gamma", logo: null,
    categories: [],                      access: "pending"},
];

async function render(rows = ROWS) {
  RPC_RESULT = { data: rows, error: null };
  const outlet = document.createElement("div");
  document.body.appendChild(outlet);
  await directoryView(outlet);
  await flush();
  return outlet;
}

// ============================ DOES IT SHOW THE RIGHT THING ==================
{
  const o = await render();
  const cards = o.querySelectorAll(".dir-card");
  ok(cards.length === 3, "DR-01 every wholesaler in the answer gets a card");

  const byWid = (w) => o.querySelector(`.dir-card[data-wid="${w}"]`);
  ok(!!byWid("alpha") && !!byWid("beta") && !!byWid("gamma"),
     "each card is identifiable by the wholesaler it represents");

  ok(byWid("alpha")?.getAttribute("data-access") === "member",
     "a store the buyer is in is marked member");
  ok(byWid("beta")?.getAttribute("data-access") === "none",
     "a store they have not asked about is marked none");
  ok(byWid("gamma")?.getAttribute("data-access") === "pending",
     "a store they have asked is marked pending");

  ok(/Alpha Textiles/.test(byWid("alpha")?.querySelector(".dir-name")?.textContent || ""),
     "DR-01 the wholesaler's NAME is shown — the decision that makes a marketplace possible");

  const cats = [...(byWid("alpha")?.querySelectorAll(".dir-cats li") || [])].map((li) => li.textContent);
  ok(cats.includes("Womenswear") && cats.includes("Denim"),
     "DR-02 the categories they sell are shown");

  // A wholesaler who has declared nothing must not render a blank card.
  const none = byWid("gamma")?.querySelector(".dir-cat-none");
  ok(!!none && none.textContent.trim().length > 0,
     "a wholesaler with no categories says so, rather than rendering an empty card");

  // The control must match the state. Three states, three different controls.
  ok(!!byWid("alpha")?.querySelector(".dir-open"),
     "a member gets a way INTO the catalogue");
  ok(!!byWid("beta")?.querySelector(".dir-ask"),
     "a non-member gets a way to ASK");
  ok(!byWid("gamma")?.querySelector(".dir-ask"),
     "someone who has already asked is NOT offered the button again — a button that re-sends a request the wholesaler already has is a lie about what pressing it does");
  ok(!byWid("alpha")?.querySelector(".dir-ask"),
     "and neither is a member");

  // DR-03
  const form = o.querySelector(".dir-search");
  ok(!!form && form.getAttribute("role") === "search", "DR-03 there is a search");
  const input = form?.querySelector('[name="q"]');
  ok(!!input && input.getAttribute("autocapitalize") === "none",
     "the search box does not autocapitalise — a phone keyboard capitalising the first letter of a wholesaler search is a wrong result on a phone");
  ok(!!o.querySelector('label[for="dir-q"]'),
     "the search input has a label, so it is reachable by a screen reader");
}

// ============================ DOES IT WITHHOLD THE REST =====================
// ⚠️ THE FIRST VERSION OF THIS BLOCK WAS VACUOUS AND IS WORTH RECORDING.
//
// It rendered a row polluted with `price`, `productName` and `productCount`
// and asserted none of it reached the page. Those three assertions PASSED even
// when the view was deliberately rewritten to print the entire row object into
// every category chip — because listDirectory() maps the server row onto a
// fixed six-field shape, so the pollution never survived as far as the view.
// The assertions were testing the mapper while claiming to test the screen,
// and could not fail. That is worse than no assertion: it reads as coverage.
//
// So DR-05 is now asserted AT THE LAYER WHERE THE PROPERTY LIVES — the mapper —
// and the test is falsifiable: changing it to spread the row makes it fail.
{
  const { listDirectory } = await import("../js/data/directory.js");

  RPC_RESULT = { data: [{
    wid: "leak", name: "Leak Co", brand: "Leak", logo: null,
    categories: ["Shirts"], access: "none",
    // Everything a future server change might start returning by accident.
    price: 99.5, unit_price: 99.5, product_name: "SENTINEL-PRODUCT-42",
    products: [{ name: "SENTINEL-PRODUCT-42", price: 99.5 }],
    product_count: 4000, owner_phone: "SENTINEL-PHONE-9",
  }], error: null };

  const rows = await listDirectory({});
  const keys = Object.keys(rows[0] || {}).sort();
  // SEVEN since 30 Aug 2026: AC-11 added `accessSlaHours`, how long this
  // wholesaler says they take to answer an access request. It is a promise
  // about response TIME, not about the catalogue, so it does not weaken DR-05 —
  // and the list stays an EXACT set precisely so that adding it could not be
  // used as cover for a price or a product count slipping in beside it.
  const expected = ["access", "accessSlaHours", "brand", "categories", "logo", "name", "wid"].sort();
  ok(JSON.stringify(keys) === JSON.stringify(expected),
     `DR-05 the mapper keeps exactly the seven directory fields and drops everything else (got: ${keys.join(",")})`);
  ok(!keys.some((k) => /price|product|stock|count|phone/i.test(k)),
     "DR-05 and specifically: nothing about prices, products, stock or contact details survived the mapper");

  const blob = JSON.stringify(rows);
  ok(!/SENTINEL-PRODUCT-42/.test(blob),
     "DR-05 a product name the server sent by accident does not survive the mapper");
  ok(!/99\.5/.test(blob),
     "DR-05 a price does not survive the mapper");
  ok(!/4000/.test(blob),
     "DR-05 a product COUNT does not survive — a directory entry is not consent to publish the size of your catalogue");
  ok(!/SENTINEL-PHONE-9/.test(blob),
     "DR-05 the wholesaler's phone does not survive — migration 042 closed that column and a mapper is not the place to reopen it");

  // And the call itself carries nothing the caller could forge a store out of.
  ok(LAST_RPC?.name === "v2_directory_list", "it calls v2_directory_list");
  const argKeys = Object.keys(LAST_RPC?.args || {}).sort();
  ok(!argKeys.includes("p_wid"),
     "and passes no wid — the caller does not get to say which store's data to read; the function resolves that from the account itself");

  // Downstream net: the page, too. Kept deliberately AFTER the mapper
  // assertions and labelled as a regression net rather than the DR-05 proof,
  // because on its own it cannot fail while the mapper stands.
  RPC_RESULT = { data: [{ wid: "leak", name: "Leak Co", brand: "Leak", logo: null,
                          categories: ["Shirts"], access: "none" }], error: null };
  const o2 = document.createElement("div");
  document.body.appendChild(o2);
  await directoryView(o2);
  await flush();
  ok(/Leak Co/.test(o2.textContent) && !/SENTINEL/.test(o2.innerHTML),
     "the rendered page shows the name and carries no sentinel (regression net, not the DR-05 proof)");
}

// ============================ THE EMPTY AND ERROR PATHS =====================
{
  const o = await render([]);
  ok(o.querySelectorAll(".dir-card").length === 0, "an empty answer renders no cards");
  ok(/No wholesalers yet/i.test(o.textContent),
     "and says so, rather than showing a blank screen that reads as broken");
}
{
  RPC_RESULT = { data: null, error: { message: "boom" } };
  const outlet = document.createElement("div");
  document.body.appendChild(outlet);
  let threw = false;
  try { await directoryView(outlet); await flush(); } catch { threw = true; }
  ok(!threw, "a failing request does not throw — a directory that throws is a blank screen");
  ok(outlet.textContent.trim().length > 0, "and still renders something");
}

// ============================ WIRING ========================================
{
  const routes = [];
  registerDirectoryRoutes({ register: (p) => routes.push(p) });
  ok(routes.includes("/buyer/wholesalers"), "the directory has a route");

  const nav = read("js/lib/nav-config.js");
  ok(/\/buyer\/wholesalers/.test(nav), "and a navigation entry, so a buyer can find it");

  // The nine-entry cap is Hadi's requirement and is not raised for this.
  const buyerBlock = nav.slice(nav.indexOf("buyer: ["), nav.indexOf("]", nav.indexOf("buyer: [")));
  const entries = (buyerBlock.match(/path:/g) || []).length;
  ok(entries <= 9, `the buyer navigation stays within the nine-entry cap (${entries})`);

  const buyer = read("js/views/buyer.js");
  ok(/directoryView\(outlet\)/.test(buyer),
     "the old /buyer/suppliers route renders the REAL directory — an installed PWA with the stale tab cached must not land on a placeholder saying the feature is coming");
  ok(!/Browsing products across multiple suppliers is coming/.test(buyer),
     "and the promise that it is 'coming' is gone, because it arrived");

  // The stale decision must be recorded, not silently contradicted.
  ok(/reversed it on 28 Aug 2026|Hadi reversed/i.test(nav),
     "nav-config records that the no-names decision was REVERSED and by whom — the previous note said the replacement would show no wholesaler names anywhere, and a comment that contradicts the code is how a false claim survives three rewrites");
}

// ---------------------------------------------------------------- report --
console.log("=".repeat(64));
console.log(" GATE — WHOLESALER DIRECTORY (DR-01..DR-05)");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — ${pass.length} assertions.\n`);
