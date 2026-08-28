// =============================================================================
// CHECK: the order sheet, and the link that reaches it   Batch N step 4, 28 Aug
// =============================================================================
// The SQL half of this feature is proven by checks/check_order_handoff.sql,
// which writes a real fulfilment note and asserts the link's own read path
// cannot see it. This is the other half: the page a warehouse actually opens,
// and the routing that lets them open it at all.
//
// THE ROUTING ASSERTION IS THE IMPORTANT ONE. js/app.js rendered the login
// screen and RETURNED before registering a single route, so every public link
// in this app was unreachable while signed out -- including /c/:token, the
// entire delivery mechanism for a catalogue, broken that way since 19 August
// and never noticed. An order link has the same requirement and a wider
// audience: a driver, a picker, an accountant, none of whom have accounts.
//
//   node checks/check_order_handoff.mjs
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
// node 22 exposes globalThis.navigator as a getter-only property, same shape
// as the crypto note in check_buyer_product_card.mjs. The copy handler reads
// navigator.clipboard from the jsdom window, so it goes there instead.
if (!dom.window.navigator.clipboard) {
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async () => {} }, configurable: true,
  });
}
if (!dom.window.crypto?.randomUUID) dom.window.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };
// ONE mutable stub, installed BEFORE any import.
//
// js/lib/supabase-client.js captures window.supabase.createClient at module
// load, and ES modules are cached per specifier -- so re-stubbing after the
// first import has no effect, and a cache-busting query string on the VIEW
// does not help because the client module underneath it is already resolved.
// The first version of this gate did exactly that and reported thirteen
// failures against working code. The stub therefore reads a variable that
// each test sets.
let RPC_RESULT = { data: null, error: null };
dom.window.supabase = {
  createClient: () => ({
    from: () => ({}),
    rpc: async () => RPC_RESULT,
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const text = (el) => (el && el.textContent != null ? el.textContent : "");
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const { orderSheetView, registerPublicRoutes, isPublicPath } = await import("../js/views/public-order.js");
const { orderLink, whatsappHref } = await import("../js/data/order-handoff.js");

// ------------------------------------------------- a link opens signed out --
{
  const app = read("js/app.js");
  const pub = read("js/views/public-order.js");

  ok(/isPublicPath/.test(app),
     "js/app.js asks whether the path is a public link");

  // The order matters and is the whole bug: the check must come BEFORE the
  // early return that renders the login screen.
  const iPublic = app.indexOf("isPublicPath(path)");
  const iGate = app.indexOf("if (!session || !session.role)");
  ok(iPublic > -1 && iGate > -1 && iPublic < iGate,
     "and it asks BEFORE the login gate — asking after it is the bug that made every share link unreachable while signed out");

  // Scoped to the PUBLIC BRANCH ONLY. The first version of this sliced from
  // the public check to the login gate + 2000 chars, which swept in the main
  // registration block further down -- so deleting registerBuyerRoutes from
  // the public branch left the gate GREEN. Red-proving caught it; the slice
  // was lying, not the code.
  const branchStart = app.indexOf("if (isPublicPath(path)) {");
  const branchEnd = app.indexOf("router.init(outlet);", branchStart);
  const branch = branchStart > -1 && branchEnd > branchStart ? app.slice(branchStart, branchEnd) : "";
  ok(branch.length > 0 && /registerPublicRoutes\(router\)/.test(branch),
     "public routes are registered inside that branch");
  ok(branch.length > 0 && /registerBuyerRoutes\(router\)/.test(branch),
     "and the buyer routes come too, because /c/:token lives there — this fixes the catalogue link as well as the order link");
  ok(branch.length > 0 && /return;/.test(app.slice(branchEnd, branchEnd + 200)),
     "and the branch RETURNS, so a public link never falls through to the app shell");

  ok(isPublicPath("/o/abc123") === true, "an order link is a public path");
  ok(isPublicPath("/c/abc123") === true, "a catalogue link is a public path");
  ok(isPublicPath("/wholesaler/orders") === false, "a wholesaler screen is not");
  ok(isPublicPath("/o/") === false, "and a token-less /o/ is not, so it cannot open an empty sheet");
  ok(/router\.register\(\s*["']\/o\/:token["']/.test(pub), "the route itself is /o/:token");
}

// ---------------------------------------------------------- the link shape --
{
  const l = orderLink("deadbeefdeadbeefdeadbeef");
  ok(l.endsWith("/#/o/deadbeefdeadbeefdeadbeef"), `the link points at the sheet (got ${l})`);
  ok(l.startsWith("https://check.local"), "and is built from the live origin, not a stored base URL that goes stale when the app moves");

  const w = whatsappHref("tok123", { orderRef: "ABCD1234", wholesalerName: "SQUARE Denim" });
  ok(w.startsWith("https://wa.me/?text="), "WhatsApp gets a wa.me link");
  const decoded = decodeURIComponent(w.split("text=")[1]);
  ok(/SQUARE Denim/.test(decoded), "with the wholesaler's name, so it reads as a sentence and not as spam");
  ok(/ABCD1234/.test(decoded), "and the order reference");
  ok(/\/#\/o\/tok123/.test(decoded), "and the link itself");
  ok(!/blob:|data:|attachment/i.test(w),
     "and NO attachment — wa.me cannot carry a file, and file sharing is absent on most of the budget Android this app runs on");
}

// ------------------------------------------------------------- the sheet ----
const setRpc = (rows) => { RPC_RESULT = { data: rows, error: null }; };

const ITEMS = [
  { qty: 3, unitPrice: 12.5, lineTotal: 37.5, sku: "SKU-M", productName: "Slim Jean 402",
    color: "Indigo", colorHex: "#2C4A6E", size: "M", imageUrl: null,
    packId: null, packQty: null, buyerNote: "the darker indigo please" },
  { qty: 6, unitPrice: 12.5, lineTotal: 75, sku: "SKU-L", productName: "Slim Jean 402",
    color: "Indigo", colorHex: "#2C4A6E", size: "L", imageUrl: null,
    packId: "pk-1", packQty: 2, buyerNote: null },
];

// ------------------------------------------------------------- the sheet ----
{
  setRpc([{
    status: "ok",
    order_id: "11111111-2222-3333-4444-555555555555",
    order_status: "new",
    buyer_label: "Maison Rita",
    subtotal: 112.5,
    currency: "$",
    buyer_order_note: "deliver before Thursday",
    created_at: new Date().toISOString(),
    wholesaler_name: "SQUARE Denim",
    items: ITEMS,
  }]);

  const outlet = document.createElement("div");
  document.body.appendChild(outlet);
  await orderSheetView(outlet, { token: "tok123" });

  const t = text(outlet);
  ok(/Slim Jean 402/.test(t), "the sheet names what was ordered");
  ok(/Maison Rita/.test(t), "and who ordered it");
  ok(/SQUARE Denim/.test(t), "and who it is from");
  // Asserted on the ELEMENT, not on a regex over the whole page. The first
  // version used /\b9\b/ against textContent and failed on working code,
  // because the markup renders "9" and "pieces" as adjacent nodes and there
  // is no word boundary between "9" and "p". Guessing at strings is how a
  // check lies in both directions.
  const tally = outlet.querySelector(".po-tally strong");
  ok(!!tally && tally.textContent.trim() === "9",
     `and totals the pieces across every line, 3 + 6 (got ${tally ? tally.textContent.trim() : "no tally"})`);
  ok(!!outlet.querySelector(".po-tally") &&
     /9\s+pieces/.test(outlet.querySelector(".po-tally").textContent.replace(/\s+/g, " ").trim()),
     "and a screen reader hears '9 pieces', not '9pieces'");
  ok(/darker indigo/.test(t), "the BUYER's own words about a line travel with it");
  ok(/deliver before Thursday/.test(t), "and their note on the whole order");
  const lines = outlet.querySelectorAll(".po-line");
  ok(lines.length === 2, `every line is rendered (got ${lines.length})`);
  ok(!!outlet.querySelector(".po-pack"),
     "a pack is shown AS a pack — a warehouse cannot pick '2 x box' without being told what is inside");
  ok(/pieces inside/.test(t),
     "and exploded into the pieces to pick, which is the half that gets the order right");
  ok(!!outlet.querySelector('[data-a="print"]'), "there is a Print / Save as PDF control");
  ok(!!outlet.querySelector('[data-a="wa"]'), "and a WhatsApp control");
  ok(!!outlet.querySelector('[data-a="copy"]'), "and a copy-link control");
  ok(/Nothing is paid here/i.test(t),
     "and it says plainly that nothing is paid — Hadi, 24 Aug: 'no money will be paid through this app'");

  // Anchored on the page having rendered: !/x/.test("") is TRUE, so an empty
  // outlet would pass every negative below and the gate would go green
  // precisely when the sheet was most broken.
  ok(t.length > 100 && !/pay now|checkout|card number|billing/i.test(t),
     "with no payment language anywhere");
  ok(t.length > 100 && !/back stock|warehouse:/i.test(t),
     "and no warehouse instruction can appear, because 088 never returns one");
}

// ---------------------------------------------------- a dead link is honest --
{
  setRpc([{ status: "not_found" }]);
  const outlet = document.createElement("div");
  await orderSheetView(outlet, { token: "nope" });
  const t = text(outlet);
  ok(/doesn't work any more|does not work/i.test(t),
     "a dead link says so in words");
  ok(t.length > 40 && !/not found|404|error/i.test(t),
     "without the words 'not found' — a dead link and an invented one must read identically, or the page tells a stranger whether an order exists");
  ok(/ask whoever sent it/i.test(t),
     "and tells the reader what to do about it, which is the only useful thing an error can do");
}

// ------------------------------------------------------------- print rules --
{
  const css = read("css/components.css");
  ok(/@media print/.test(css), "there are print rules");
  const printBlock = css.slice(css.indexOf("@media print"));
  ok(/\.po-line[^{]*\{[^}]*break-inside:\s*avoid/.test(printBlock.replace(/\n/g, " ")) || /break-inside:\s*avoid/.test(printBlock),
     "and a line is row-atomic — a picking sheet that splits a size from its quantity across a page break gets picked wrong");
  ok(/\.po-actions\s*\{\s*display:\s*none|\.no-print,\s*\.po-actions\s*\{\s*display:\s*none/.test(printBlock.replace(/\n/g, " ")),
     "and the buttons do not print");
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
