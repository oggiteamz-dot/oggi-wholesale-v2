// =============================================================================
// CHECK: opening stock split across several warehouses            (CR-0006)
// =============================================================================
// Hadi, 25 Aug 2026:
//   "I want the wholesaler to be able to not just click and choose what
//    location or what warehouse has these items, because there's a very high
//    chance that multiple warehouses will have the same item. So at the end,
//    when they're done, they can then log their warehouses -- basically
//    telling you that there's this many in this warehouse, this many in that
//    warehouse, per item."
//
// The database has always been multi-warehouse: v2_inventory_balances is keyed
// per (variant, location) and v2_receive_stock takes a location on every call.
// It was only ever CALLED with one, because the form had a single dropdown for
// the whole product. So this is an entry problem, not a storage one.
//
// WHAT THIS GATE IS REALLY FOR: WH-03, the arithmetic. A split is numbers typed
// into several boxes that nobody re-adds. If 60 can be split 40/30 and saved,
// twenty pieces have been invented, silently, in a system whose whole job is
// knowing how much you have. Every other assertion here matters less than that
// one, and it is red-proved.
//
//   node checks/check_multi_warehouse.mjs
// =============================================================================
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
process.on("uncaughtException", (e) => {
  console.log("\ncheck_multi_warehouse  CRASHED — no verdict given\n  ! " + e.message);
  process.exit(2);
});

const calls = [];                 // every rpc, in order
function makeClient() {
  let seq = 0;
  return {
    from(table) {
      const rec = { table, op: null, payload: null, filters: {} };
      const chain = {
        insert(p) { rec.op = "insert"; rec.payload = p; return chain; },
        update(p) { rec.op = "update"; rec.payload = p; return chain; },
        delete() { rec.op = "delete"; return chain; },
        select() { return chain; }, eq() { return chain; }, in() { return chain; },
        order() { return chain; }, single() { return chain; }, maybeSingle() { return chain; },
        then(res, rej) {
          let data = null;
          if (rec.table === "v2_products" && rec.op === "insert") data = { id: "prod-1", name: "P" };
          else if (rec.table === "v2_product_variants" && rec.op === "insert") { seq += 1; data = { id: `var-${seq}`, sku: rec.payload?.sku }; }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return chain;
    },
    rpc(name, args) { calls.push({ name, args }); return Promise.resolve({ data: null, error: null }); },
  };
}
globalThis.window = globalThis.window || {};
globalThis.window.supabase = { createClient: () => makeClient() };
globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => null, toDataURL: () => "" }) };

const mod = await import("../js/data/products-admin.js");
const uploader = async () => ({ ok: true, url: "https://cdn.test/x.webp" });

const WH_A = "loc-beirut", WH_B = "loc-tripoli";
function draft(over = {}) {
  return {
    name: "Split Check", sellingModel: "open", locationId: WH_A,
    variants: [
      { sku: "SC-RED-S", price: 10, color: "Red", size: "S", openingStock: 60 },
      { sku: "SC-RED-M", price: 10, color: "Red", size: "M", openingStock: 20 },
    ],
    ...over,
  };
}
const receives = () => calls.filter((c) => c.name === "v2_receive_stock");

// ── WH-06 / WH-02 — one receive per (variant, warehouse) ──────────────────
calls.length = 0;
const split = await mod.createProduct("wid-1", draft({
  stockSplit: [
    { sku: "SC-RED-S", allocations: [{ locationId: WH_A, qty: 40 }, { locationId: WH_B, qty: 20 }] },
    { sku: "SC-RED-M", allocations: [{ locationId: WH_B, qty: 20 }] },
  ],
}), { uploader });

// PRECONDITION. Everything below is meaningless if the save did not run.
if (!split || split.ok === false) {
  console.log("\ncheck_multi_warehouse  HARNESS/CODE BROKEN — createProduct said: " + (split?.error || "nothing"));
  process.exit(2);
}
ok(receives().length === 3, `WH-06 one receive per (variant, warehouse) — 2 for the split SKU, 1 for the other (got ${receives().length})`);
const byLoc = (loc) => receives().filter((r) => r.args.p_location_id === loc).reduce((s, r) => s + r.args.p_qty, 0);
ok(byLoc(WH_A) === 40, `WH-02 Beirut receives exactly its 40 (got ${byLoc(WH_A)})`);
ok(byLoc(WH_B) === 40, `WH-02 Tripoli receives 20 + 20 = 40 (got ${byLoc(WH_B)})`);
ok(receives().reduce((s, r) => s + r.args.p_qty, 0) === 80,
   "WH-02 nothing is invented and nothing is dropped — 80 pieces in, 80 pieces received");

// ── WH-03 — THE ONE THAT MATTERS. A split that does not add up is REFUSED ──
calls.length = 0;
const bad = await mod.createProduct("wid-1", draft({
  stockSplit: [
    // 60 pieces entered, 40 + 30 allocated. Twenty invented.
    { sku: "SC-RED-S", allocations: [{ locationId: WH_A, qty: 40 }, { locationId: WH_B, qty: 30 }] },
  ],
}), { uploader });
ok(bad && bad.ok === false, "WH-03 a split that does not add up is REFUSED, not saved");
ok(bad && /SC-RED-S/.test(String(bad.error || "")), `WH-03 the refusal NAMES the item (got "${bad?.error}")`);
ok(bad && /70|60/.test(String(bad.error || "")), "WH-03 and states both numbers, so it can be fixed without guessing");
ok(receives().length === 0, `WH-03 nothing was received before the refusal (got ${receives().length} writes)`);

// ── WH-04 / WH-05 — no split sent behaves EXACTLY as it always has ─────────
calls.length = 0;
await mod.createProduct("wid-1", draft(), { uploader });
ok(receives().length === 2, `WH-05 with no split, every variant still lands in the chosen warehouse (got ${receives().length})`);
ok(receives().every((r) => r.args.p_location_id === WH_A),
   "WH-04 a wholesaler with one warehouse is unaffected — it all goes there, as before");
ok(receives().reduce((s, r) => s + r.args.p_qty, 0) === 80, "WH-05 and the quantities are unchanged");

// ── a variant absent from the split falls back, rather than losing its stock ─
calls.length = 0;
await mod.createProduct("wid-1", draft({
  stockSplit: [{ sku: "SC-RED-S", allocations: [{ locationId: WH_B, qty: 60 }] }],
}), { uploader });
ok(receives().reduce((s, r) => s + r.args.p_qty, 0) === 80,
   `WH-05 a variant the split never mentions keeps its stock at the default warehouse (got ${receives().reduce((s, r) => s + r.args.p_qty, 0)})`);

console.log(`\ncheck_multi_warehouse  PASS ${pass.length}  FAIL ${fail.length}`);
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) process.exit(1);
