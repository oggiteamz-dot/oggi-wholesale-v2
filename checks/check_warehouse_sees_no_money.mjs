// =============================================================================
// GATE — the warehouse desk never sees money            Block 7, 11 Sep 2026
// =============================================================================
// Migration 135 removes money from the warehouse functions' RETURN TABLES, and
// its own self-test reads those tables' OUT parameters and fails on any
// money-shaped name. That is the strong half and it is already done.
//
// ⭐ THIS IS THE OTHER HALF: THE SCREEN.
//
// A signature with no price is worth nothing if the view fetches the price from
// somewhere else, or renders a field it was handed by accident. So this gate
// RENDERS THE REAL VIEW -- the actual queueView and orderView out of
// js/views/warehouse.js, in jsdom -- against fixture rows that DELIBERATELY
// CARRY PRICES THE SERVER WOULD NEVER SEND:
//
//     unitPrice: 9.5, lineTotal: 95.00, subtotal: 380.00, cost: 3.25
//
// and then asserts that not one currency symbol and not one money-shaped number
// reaches the DOM. If somebody later "just adds the total to the header", this
// goes red on the rendered HTML, not on a code review.
//
// WHY IT IS WORTH THIS MUCH TROUBLE. A picker does not need a price to pick.
// What a price on a pick sheet IS, is a price on the warehouse floor -- on a
// tablet that lies on a bench all day, readable by every casual worker and by
// the driver from another company waiting for a collection. Wholesale margin is
// the most commercially sensitive number a wholesaler has, and migrations
// 031/032 already strip `cost` from every browser role for that reason.
//
//   node checks/check_warehouse_sees_no_money.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HashChangeEvent = dom.window.HashChangeEvent;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Comments are stripped before every source assertion. This file's own header
// says the word "price" eleven times, and so does the view's. A gate that goes
// red on its own explanation gets the explanation deleted -- which has happened
// in this repo three times, and is recorded in checks/check_ranking_policy.mjs.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

const viewSrc = await src("../js/views/warehouse.js");
const dataSrc = await src("../js/data/desk.js");

// ================================================= 1. THE SOURCE, STRIPPED ===
{
  const bare = strip(viewSrc);
  ok(!/\bmoney\s*\(/.test(bare),
     "⭐ the warehouse view never calls money() — the helper that formats a currency is not even reachable from here");
  // ⚠️ The first version of this line looked for `money` AFTER the `from`,
  // which is the wrong half of the statement -- in
  //     import { esc, pageHeader, money } from "../lib/utils.js";
  // the name is in the braces, before `from`. The sabotage run caught it:
  // importing money() without calling it kept the gate green. Now the braces
  // themselves are read.
  const imports = [...bare.matchAll(/import\s*\{([^}]*)\}\s*from/g)].map((m) => m[1]).join(",");
  ok(!/\bmoney\b/.test(imports),
     "⭐ and money() is not even IMPORTED — the formatter is not in reach of this file at all");
  ok(!/[$€£¥]/.test(bare.replace(/\$\{/g, "")),
     "⭐ no currency symbol appears anywhere in the warehouse view (template placeholders excluded)");
  ok(!/\b(unitPrice|lineTotal|subtotal|unitCost|lineCost|lineMargin|outstanding)\b/.test(bare),
     "⭐ and it never reads a money field off a row, even one handed to it by accident");

  const bareData = strip(dataSrc);
  const wh = bareData.slice(bareData.indexOf("export async function warehouseQueue"),
                            bareData.indexOf("export async function financeQueue"));
  ok(!/\b(unitPrice|lineTotal|subtotal|unitCost|price|cost)\b/.test(wh),
     "⭐ the warehouse half of the data layer maps no money field either");
}

// ============================================ 2. ⭐ AND THE RENDERED DOM =====
// The real view functions, compiled with stubbed imports so they can run in
// Node, and fed fixture rows carrying prices the server would never send.
{
  const FIXTURE_QUEUE = [{
    orderId: "o-1", reference: "ABCD1234", buyerLabel: "Probe Shop",
    placedAt: new Date().toISOString(), state: "sent", sentAt: new Date().toISOString(),
    lineCount: 2, unitCount: 12, pickedCount: 4,
    hasFulfilNote: true, hasBuyerNote: true, locationName: "Main dock",
    // ⭐ money the server would never send. If the view renders it, this gate fails.
    subtotal: 380.00, outstanding: 95.00, currency: "$",
  }];
  const FIXTURE_HEAD = {
    orderId: "o-1", reference: "ABCD1234", buyerLabel: "Probe Shop",
    placedAt: new Date().toISOString(), state: "accepted",
    orderNote: "please send the darker blue", fulfilNote: "pack the two shirts together",
    locationName: "Main dock", returnReason: null,
    subtotal: 380.00, currency: "$",
  };
  const FIXTURE_LINES = [{
    orderItemId: 1, variantId: "v-1", productName: "Probe Shirt", sku: "PS-1",
    colour: "Blue", colourHex: "#2244aa", size: "M", qty: 6, pickedQty: 2,
    packId: null, packQty: null, buyerNote: null, fulfilNote: null,
    imageUrl: null, qtyOnHand: 40, barcode: "5901234123457",
    // ⭐ and again, on the line
    unitPrice: 9.5, lineTotal: 57.00, unitCost: 3.25,
  }];

  const stub = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pageHeader = (t, d) => { const e = document.createElement("div"); e.textContent = String(t) + " " + String(d ?? ""); return e; };
const emptyState = ({ title, body }) => { const e = document.createElement("div"); e.textContent = String(title) + " " + String(body ?? ""); return e; };
const toast = () => {};
const ask = async () => null;
const confirmAction = async () => false;
const readDeskSession = () => ({ role: "warehouse", desk: "warehouse", staffId: "s-1", wid: "zz", wholesalerName: "Probe Store" });
const warehouseQueue = async () => (${JSON.stringify(FIXTURE_QUEUE)});
const warehouseOrderHead = async () => (${JSON.stringify(FIXTURE_HEAD)});
const warehouseOrderLines = async () => (${JSON.stringify(FIXTURE_LINES)});
const pickLine = async () => ({ ok: true, pickedQty: 3 });
const deskAccept = async () => ({ ok: true });
const deskComplete = async () => ({ ok: true });
const deskReturn = async () => ({ ok: true });
const deskNote = async () => ({ ok: true });
`;
  // Strip WHOLE import statements, including the multi-line ones. Filtering on
  // "starts with import" removed only the first line of
  //     import {
  //       warehouseQueue, ...
  //     } from "../data/desk.js";
  // and left a dangling `} from "..."` that will not parse. Worth writing down:
  // this is the second gate in this repo to trip over the same thing.
  const dropImports = (text) => {
    const out = [];
    let inImport = false;
    for (const line of text.split("\n")) {
      if (!inImport && /^import[\s{]/.test(line)) {
        if (/\bfrom\s+["']/.test(line) || /^import\s+["']/.test(line)) continue;  // whole statement on one line
        inImport = true; continue;
      }
      if (inImport) { if (/\bfrom\s+["'][^"']+["'];?\s*$/.test(line)) inImport = false; continue; }
      out.push(line);
    }
    return out.join("\n");
  };
  const body = dropImports(viewSrc);
  // queueView/orderView are module-private, so reach them the way the router
  // does: through the registered routes.
  const mod = await import("data:text/javascript;base64,"
    + Buffer.from(stub + body).toString("base64"));

  const routes = {};
  mod.registerWarehouseRoutes({ register: (path, fn) => { routes[path] = fn; } });
  ok(typeof routes["/warehouse"] === "function" && typeof routes["/warehouse/order/:id"] === "function",
     "both warehouse routes are registered (otherwise the DOM checks below prove nothing)");

  const MONEY_SYMBOL = /[$€£¥₪₺]/;
  // A money-shaped number: digits, optional thousands, exactly two decimals.
  // Written to NOT match "0.2s" or "1.5" so it does not cry wolf on CSS.
  const MONEY_NUMBER = /\b\d[\d,]*\.\d{2}\b/;

  for (const [name, path, arg] of [["the queue", "/warehouse", undefined],
                                   ["one order", "/warehouse/order/:id", { id: "o-1" }]]) {
    const outlet = document.createElement("div");
    let html = "";
    try {
      await routes[path](outlet, arg);
      html = outlet.innerHTML;
    } catch (e) {
      html = "";
      ok(false, `${name} could not be rendered (${e.message}) — the DOM half of this gate proved nothing`);
    }
    if (html) {
      ok(html.length > 200, `${name} rendered something substantial (${html.length} chars)`);
      const sym = html.match(MONEY_SYMBOL);
      ok(!sym, `⭐ ${name}: not one currency symbol reached the screen${sym ? ` — found "${sym[0]}"` : ""}`);
      // ⚠️ Test the TEXT, not the CSS. The first run of this gate went red on
      // `line-height:1.45` inside a style attribute, which is not a price and
      // never will be. A gate that cries wolf is a gate somebody switches off
      // (checks/check_no_payment_path.mjs says exactly this, having been
      // narrowed for the same reason). So style attributes and colour hexes are
      // removed first, and the claim itself is not weakened.
      const text = html.replace(/style="[^"]*"/g, "").replace(/#[0-9a-f]{3,8}/gi, "");
      const num = text.match(MONEY_NUMBER);
      ok(!num, `⭐ ${name}: not one money-shaped number reached the screen${num ? ` — found "${num[0]}"` : ""}`);
      ok(!/\b(9\.5|57\.00|380|3\.25|95\.00)\b/.test(text),
         `⭐ ${name}: none of the prices planted in the fixture appear anywhere in the DOM`);
    }
  }

  // And the thing it MUST show: 087's column, which had no reader until now.
  const outlet = document.createElement("div");
  await routes["/warehouse/order/:id"](outlet, { id: "o-1" });
  ok(/pack the two shirts together/.test(outlet.innerHTML),
     "⭐ the office's fulfil_note IS on the screen — migration 087 wrote it on 28 Aug and nothing has ever read it");
  ok(/darker blue/.test(outlet.innerHTML),
     "and the shop's own note is there too, in its own block");
  ok(/data-note-from="office"/.test(outlet.innerHTML) && /data-note-from="buyer"/.test(outlet.innerHTML),
     "⭐ and the two notes are marked with different authors — 087 exists because one shared field put an internal note on a customer's label");
}

// =============================================================================
console.log(`\n  ${pass.length} passed, ${fail.length} failed\n`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { console.log("\n  WAREHOUSE MONEY WALL RED\n"); process.exit(1); }
console.log("\n  WAREHOUSE MONEY WALL GREEN\n");
