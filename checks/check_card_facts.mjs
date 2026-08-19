// =============================================================================
// CHECK: the wholesaler chooses what a product card shows
// =============================================================================
// Hadi: "other than the price, I don't want colours and sizes. Instead, I want
// the ability for the wholesaler to pick the two to three pieces of
// information that he wants... this is an inventory setting where the
// wholesaler can click on what he wants to see."
//
// Two properties matter more than the list of available facts, and both are
// the kind that decay quietly:
//
//   1. THREE IS A HARD CAP. The whole point of the card layout is that the
//      photo is the biggest thing on it; every extra fact takes space from the
//      photo, and past three the card is the text block the cards replaced.
//      A cap enforced only by the interface is one screen away from being
//      bypassed, so normaliseFacts() enforces it on the way in as well.
//
//   2. AN UNKNOWN NUMBER IS NOT ZERO. If a screen has not been given sales
//      figures, the card must show an em dash, not "0 sold". They look
//      identical and mean opposite things to someone deciding what to reorder.
//
//   node checks/check_card_facts.mjs
// =============================================================================
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://app.test/" });
for (const k of ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "Event", "MouseEvent"]) {
  try { globalThis[k] = dom.window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}

const { CARD_FACTS, factsFor, normaliseFacts, locationFacts, locationFactKey, LOCATION_ALL, MAX_FACTS, DEFAULT_FACTS }
  = await import("../js/lib/card-facts.js");
const { renderCardFactsPicker } = await import("../js/components/card-facts-picker.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---- everything Hadi asked to be able to toggle is on offer ----------------
const keys = CARD_FACTS.map((f) => f.key);
[["price", "price"], ["colours & sizes", "variantCount"], ["supplier", "supplier"],
 ["category", "category"], ["units sold", "unitsSold"], ["orders", "orderCount"],
 ["cost", "cost"], ["margin", "margin"]].forEach(([name, key]) => {
  ok(keys.includes(key), `“${name}” can be toggled on`);
});
ok(!DEFAULT_FACTS.includes("variantCount"),
  "colours & sizes is NOT on by default — it was explicitly asked to come off");
ok(DEFAULT_FACTS.includes("price"), "price IS on by default — it was explicitly asked for");

// ---- the cap ---------------------------------------------------------------
ok(MAX_FACTS === 3, `the cap is three (${MAX_FACTS})`);
ok(normaliseFacts(["price", "available", "onHand", "cost", "margin"]).length === 3,
  "five chosen keys are trimmed to three on the way in, not just in the interface");
ok(normaliseFacts(["price", "price", "available"]).length === 2, "duplicates are dropped");
ok(normaliseFacts(["nonsense", "alsoFake"]).join() === DEFAULT_FACTS.join(),
  "unknown keys fall back to the default rather than producing a blank card");
ok(normaliseFacts([]).length === 3, "an empty choice falls back — a card with no facts is a photo with a name");
ok(normaliseFacts(["margin", "price"]).join() === "margin,price",
  "the chosen ORDER is kept: the first line of a card is the one people read");

// ---- an unknown number is not zero -----------------------------------------
{
  const p = { priceRange: [10, 10], available: 4, onHand: 4 };   // no sales data
  const facts = factsFor(p, ["unitsSold", "price", "available"]);
  const sold = facts.find((f) => f.label === "Units sold");
  ok(sold && sold.value === "—",
    `a screen with no sales figures shows an em dash, not “0 sold” (got “${sold?.value}”)`);
}
{
  const p = { priceRange: [10, 10], unitsSold: 0, orderCount: 0, lastSold: null };
  const facts = factsFor(p, ["unitsSold", "lastSold"]);
  ok(facts[0].value === "0", "a product genuinely sold zero times says 0");
  ok(facts[1].value === "never", "and “never” rather than a dash, because that is a real answer");
}

// ---- tone: a negative margin must be impossible to scan past ----------------
{
  const bad = factsFor({ marginPct: -12 }, ["margin"])[0];
  ok(bad.value === "-12%" && bad.tone === "danger", `a negative margin is toned as a problem (${JSON.stringify(bad)})`);
  const good = factsFor({ marginPct: 42 }, ["margin"])[0];
  ok(good.tone === "", "a healthy margin is not");
}
{
  const out = factsFor({ available: 0 }, ["available"])[0];
  ok(out.tone === "danger", "zero available is toned as a problem");
}

// ---- warehouses ------------------------------------------------------------
const locs = [{ id: "l1", name: "Main Warehouse" }, { id: "l2", name: "Showroom" }];
ok(locationFacts([{ id: "l1", name: "Only One" }]).length === 0,
  "a wholesaler with one warehouse is offered no per-warehouse facts — “at Main” IS “available”");
ok(locationFacts(locs).length === 3, "with two warehouses: a breakdown, plus one option per warehouse");

{
  const p = { byLocation: [
    { locationId: "l1", locationName: "Main Warehouse", available: 34, onHand: 40 },
    { locationId: "l2", locationName: "Showroom", available: 5, onHand: 5 },
  ] };
  const all = factsFor(p, [LOCATION_ALL], { locations: locs });
  ok(all.length === 2 && all[0].label === "Main Warehouse" && all[0].value === "34",
    `the breakdown lists each warehouse (${JSON.stringify(all)})`);

  const one = factsFor(p, [locationFactKey("l2")], { locations: locs });
  ok(one[0].label === "Showroom" && one[0].value === "5", "and one warehouse can be singled out");

  const missing = factsFor({ byLocation: [] }, [locationFactKey("l2")], { locations: locs });
  ok(missing[0].value === "0" && missing[0].tone === "danger",
    "a product held in neither warehouse reads 0, toned — not a silently missing row");
}

// ---- the control -----------------------------------------------------------
let saved = null;
const picker = renderCardFactsPicker({
  selected: ["price", "available"],
  locations: locs,
  onSave: async (k) => { saved = k; return { ok: true }; },
});
document.body.appendChild(picker.el);
const el = picker.el;

el.querySelector(".facts-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const boxes = () => [...el.querySelectorAll(".facts-body input[type=checkbox]")];
ok(boxes().length >= CARD_FACTS.length, "every fact is offered as a toggle");
ok(boxes().filter((b) => b.checked).length === 2, "the current choice is ticked");
ok(boxes().every((b) => !b.disabled), "with room left, nothing is disabled");

function toggle(key) {
  const b = boxes().find((x) => x.dataset.factKey === key);
  b.checked = !b.checked;
  b.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

toggle("margin");
ok(picker.current().length === 3, "a third can be added");
ok(boxes().filter((b) => b.disabled).length > 0,
  "and now the rest are disabled rather than letting a fourth be ticked and then vanish");
ok(/turn one off/i.test(el.textContent), "with the reason written down, not left as a mystery");

toggle("available");
ok(picker.current().length === 2 && !picker.current().includes("available"), "turning one off frees a slot");
ok(boxes().every((b) => !b.disabled), "and re-enables the rest");

toggle("supplier");
el.querySelector(".facts-save").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
ok(saved && saved.length === 3, `saving hands over the three chosen keys (${JSON.stringify(saved)})`);
ok(saved.join() === "price,margin,supplier", "in the order they were ticked");

console.log("=".repeat(64));
console.log(" CHECK — WHAT A PRODUCT CARD SHOWS");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
