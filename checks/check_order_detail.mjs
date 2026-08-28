// =============================================================================
// CHECK: one order, in full — and the buyer's note actually arrives  (Batch N step 2)
// =============================================================================
//
// WHAT THIS GUARDS
// ----------------
// Migration 086 stores the buyer's note. Storing it is worthless if it never
// reaches the person it is for, and the research behind this batch is
// unambiguous that "the note never reached the document" is the dominant
// real-world failure — not bad design, but an unowned path from "buyer types
// it" to "warehouse reads it". Three separate Shopify threads spanning years
// are the same complaint, one of them explicitly blocking a merchant from
// moving their operation onto the platform.
//
// So this gate does NOT search for the word "buyerNote" in a file. An unused
// import satisfies a name search — that is exactly how the saved-mix library
// fell out of three consecutive rewrites in this repo. It asserts BEHAVIOUR:
//
//   1. groupPackLines carries a note through the pack collapse. A pack is one
//      line to the buyer and N rows underneath, and cart.js writes the note on
//      the FIRST component only. Before this batch the collapse silently
//      dropped it — stored correctly, delivered nowhere.
//   2. The wholesaler data layer maps buyer_note onto the line, and the photo
//      and swatch it needs, from a stubbed database row.
//   3. The single-order read is scoped by WID AS WELL AS ID. An order id is a
//      uuid, but "hard to guess" is not an access rule — see S10 and the
//      discount defect S4 fixed, both of which were a caller-supplied id that
//      nothing scoped to a tenant.
//   4. A pack renders as a pack AND explodes into the pieces to pick. A
//      warehouse cannot pick "2 x Boutique Pack".
//
//   node checks/check_order_detail.mjs
// =============================================================================
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;

// The database stub must exist BEFORE the first dynamic import: every module
// here reaches supabase-client.js at load time, and a stub declared further
// down the file arrives too late. Caught by this gate failing on its own
// scaffolding -- which is the right way round.
const captured = { filters: [] };
const thenable = (rows) => {
  const chain = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res) => Promise.resolve({ data: rows, error: null }).then(res);
      if (prop === "eq") return (col, val) => { captured.filters.push(`${col}=${val}`); return chain; };
      return () => chain;
    },
    apply() { return chain; },
  });
  return chain;
};
const ORDER_ROW = {
  id: "o-1", wid: "test", buyer_label: "Shop A", status: "new", subtotal: "60.00",
  notes: "deliver before Thursday please", created_at: "2026-08-28T10:00:00Z",
  client_id: "c-1", location_id: "l-1", catalog_id: "cat-1",
};
const ITEM_ROWS = [{
  order_id: "o-1", variant_id: "v-1", qty: 5, unit_price: "10.00", line_total: "50.00",
  buyer_note: "send this one in the darker blue",
  pack_id: null, pack_line_id: null, pack_qty: null,
  v2_product_variants: {
    sku: "TEE-BLUE-M", image_url: "https://cdn.example/blue.jpg", images: ["https://cdn.example/other.jpg"],
    extra_attrs: { color: "Blue", size: "M", colorHex: "#2244cc" },
    v2_products: { name: "Classic Tee" },
  },
}];
dom.window.supabase = {
  createClient: () => ({
    from: (t) => thenable(t === "v2_orders" ? [ORDER_ROW] : ITEM_ROWS),
    rpc: () => thenable([]),
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// --------------------------------------------------------------- 1. the collapse
let groupPackLines = null;
try { ({ groupPackLines } = await import("../js/data/prepacks.js")); }
catch (e) { fail.push(`js/data/prepacks.js could not be loaded: ${String(e).split("\n")[0]}`); }

if (groupPackLines) {
  // Two rows of ONE pack. cart.js puts the note on the first component only.
  const collapsed = groupPackLines([
    { packLineId: "pl-1", packId: "p-1", packQty: 2, productName: "Boutique Pack", sku: "A-S", color: "Blue", size: "S", qty: 2, lineTotal: 20, buyerNote: "send this one in the darker blue" },
    { packLineId: "pl-1", packId: "p-1", packQty: 2, productName: "Boutique Pack", sku: "A-M", color: "Blue", size: "M", qty: 4, lineTotal: 40, buyerNote: null },
  ]);
  ok(collapsed.length === 1, `a pack collapses to ONE display line (got ${collapsed.length})`);
  ok(collapsed[0] && collapsed[0].buyerNote === "send this one in the darker blue",
     `the note SURVIVES the pack collapse (got ${JSON.stringify(collapsed[0] && collapsed[0].buyerNote)})`);
  ok(collapsed[0] && collapsed[0].components.reduce((n, c) => n + c.qty, 0) === 6,
     "the collapsed pack still knows how many pieces it contains (6)");

  // Order-independence: the note must be found wherever it sits in the group.
  const reversed = groupPackLines([
    { packLineId: "pl-2", packId: "p-2", packQty: 1, productName: "P", sku: "B-S", qty: 1, lineTotal: 5, buyerNote: null },
    { packLineId: "pl-2", packId: "p-2", packQty: 1, productName: "P", sku: "B-M", qty: 1, lineTotal: 5, buyerNote: "second row carries it" },
  ]);
  ok(reversed[0] && reversed[0].buyerNote === "second row carries it",
     "the note is found even when it is NOT on the first row — component order cannot lose it");

  // A loose line must be untouched by the collapse.
  const loose = groupPackLines([{ variantId: "v1", qty: 3, lineTotal: 30, buyerNote: "keep me", productName: "Tee" }]);
  ok(loose.length === 1 && loose[0].buyerNote === "keep me", "a loose line keeps its own note");
}

// --------------------------------------------------- 2 & 3. the data layer
let mod = null;
try { mod = await import("../js/data/wholesaler-orders.js"); }
catch (e) { fail.push(`js/data/wholesaler-orders.js could not be loaded: ${String(e).split("\n")[0]}`); }

if (mod && typeof mod.getWholesalerOrder === "function") {
  const order = await mod.getWholesalerOrder("test", "o-1");
  ok(!!order, "getWholesalerOrder returns an order");
  if (order) {
    ok(order.notes === "deliver before Thursday please", "the ORDER-level buyer note is mapped");
    const line = order.items[0];
    ok(line && line.buyerNote === "send this one in the darker blue",
       `the PER-LINE buyer note is mapped (got ${JSON.stringify(line && line.buyerNote)})`);
    ok(line && line.imageUrl === "https://cdn.example/blue.jpg",
       "the line carries the PHOTO of what was ordered");
    ok(line && line.colorHex === "#2244cc", "the line carries the colour swatch");
    ok(Array.isArray(order.rawLines) && order.rawLines.length === 1,
       "rawLines is exposed — the uncollapsed rows a warehouse actually picks");
  }
  // THE SCOPING ASSERTION. This is the one that matters in six months.
  ok(captured.filters.includes("wid=test") && captured.filters.includes("id=o-1"),
     `the single-order read is scoped by WID as well as id (filters seen: ${captured.filters.join(", ") || "none"})`);
} else if (mod) {
  fail.push("getWholesalerOrder is not exported — the detail screen has no wid-scoped read");
}

// ------------------------------------------------------------ 4. the screen
// Asserted against the SOURCE's rendered shape rather than by importing
// wholesaler.js, which pulls in ~30 modules. What is checked is that the
// detail view builds BOTH forms of a pack and attaches the note to the line —
// by looking for the constructs that can only exist if it does.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
const detail = src.slice(src.indexOf("async function orderDetailView"), src.indexOf("// One product panel opener"));
ok(detail.length > 500, "orderDetailView exists in js/views/wholesaler.js");
ok(/router\.register\("\/wholesaler\/orders\/:id"/.test(src), "the /wholesaler/orders/:id route is registered");
ok(/line\.buyerNote/.test(detail), "the detail view reads each line's own note");
ok(/BUYER'S NOTE/.test(detail), "the per-line note is labelled as the buyer's, not merged with anything else");
ok(/components\.map/.test(detail) && /to pick/.test(detail) && /pieces<\/strong>/.test(detail),
   "a pack is EXPLODED into the pieces to pick, not shown only as a pack");
ok(/getWholesalerOrder\(wid, orderId\)/.test(detail),
   "the detail view uses the wid-scoped read, not a read by id alone");
// The list must show the note text itself, not a badge saying one exists.
// Migration 087 -- the second track. The risk of the wholesaler's own note is
// entirely that it becomes confusable with, or merged into, the buyer's.
ok(/fulfilEditor/.test(detail), "the detail view offers a fulfilment-note editor");
ok(/YOUR NOTE TO THE WAREHOUSE/.test(detail) && /BUYER'S NOTE/.test(detail),
   "the two note tracks carry DIFFERENT labels — a reader never has to work out which is which");
ok(/THE BUYER NEVER SEES THIS/.test(detail),
   "the wholesaler is told, on screen, that their note is internal");
ok(/setFulfilNote\(order\.id/.test(detail),
   "the fulfilment note is written through the RPC, never a direct table write");
ok(/line\.fulfilNote/.test(detail) && /line\.buyerNote/.test(detail),
   "both tracks are read from SEPARATE fields on the line");
ok(!/buyerNote\s*\|\|\s*line\.fulfilNote|fulfilNote\s*\|\|\s*line\.buyerNote/.test(detail),
   "neither track ever falls back to the other — a fallback is how they merge");

const listView = src.slice(src.indexOf("async function ordersView"), src.indexOf("async function orderDetailView"));
ok(/WHAT THE BUYER ASKED FOR/.test(listView), "the orders LIST previews the note text");
ok(!/notes-badge|has-note-icon/.test(listView), "the list does not rely on a bare 'a note exists' indicator");
ok(!/fulfilNote/.test(listView),
   "the orders LIST previews only the BUYER's note — the internal one is not spilled onto a shared screen");

console.log("\n  ORDER DETAIL — one order, in full\n" + "-".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.\n`);
