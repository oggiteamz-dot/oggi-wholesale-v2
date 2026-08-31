// =============================================================================
// OGGI Wholesale v2 — GATE: MARKETPLACE SEARCH                  MK-04, 1 Sep 2026
// =============================================================================
//
// WHAT THIS IS FOR
// ----------------
// Hadi: "At the top, there's just going to be a search bar ... that gives them
// the ability to decide, I want a product or I want a wholesaler or a brand."
// v2_marketplace_search is the product half.
//
// THE ASSERTION THAT MATTERS IS THE SCOPE.
// A search box is the single easiest place in a marketplace to leak a private
// catalogue, because a search is written as "find anything matching" and a feed
// is written as "show what is published" — and the first sentence is one word
// away from the second. Atelier publishes three made-to-order gowns in a
// PRIVATE catalogue. Typing their exact names must return nothing, for an
// anonymous caller AND for a buyer who is already a member of Atelier, because
// "member" is the case a careless widening gets wrong.
//
// So this gate does not check that search finds things. It checks that the set
// it can find is EXACTLY the set the feed can show, by fetching the feed's
// whole universe and asserting containment.
//
// WHAT THIS ASSERTS
//   1. An empty, null or whitespace query returns NO rows — never the whole
//      marketplace. The feed is what answers "show me everything".
//   2. LIKE metacharacters are literal. A bare '%' or '_' returns nothing.
//      Before the escaping went in, '%' returned the entire marketplace.
//   3. An exact product reference comes back FIRST. "send me 12 of C-117" is
//      how a wholesale order is actually placed.
//   4. CONTAINMENT — every product search can reach is a product the feed can
//      show. Checked against the feed's full universe, not a sample.
//   5. NO PRIVATE-ONLY PRODUCT is findable by its exact name, for anon or for
//      a member of that very wholesaler.
//   6. `access` is honest: anonymous sees 'none' everywhere; the demo buyer
//      sees 'member' for the six demo shops.
//   7. commission_pct never appears in the payload.
//   8. Paging is exact — limit honoured, offset shifts, no duplicates.
//   9. Search is cross-store: a common word returns more than one wholesaler.
//  10. Case does not matter.
//
// RUN:  node checks/check_marketplace_search.mjs
//       (hits the live database read-only, like the other *_client.mjs checks)
//
// PROVEN TO GO RED — see checks/GATE-EVIDENCE.md.
// =============================================================================

const URL = "https://olaipgdckbgjediddloj.supabase.co/rest/v1/rpc/";
const KEY = "sb_publishable_GnN_sh_xneseBc9dya4Vpg_eziJoPI5";
const HEADERS = {
  apikey: KEY,
  "Content-Type": "application/json",
  "Accept-Profile": "wholesale_v2",
  "Content-Profile": "wholesale_v2",
};

// Nadia Kassab — the demo buyer, a member of all six demo wholesalers.
const MEMBER_ACCOUNT = "161de39b-82ff-439f-9ba6-662e85f1222d";
const DEMO_WIDS = new Set([
  "demo-meridian", "demo-vantage", "demo-loom",
  "demo-casasole", "demo-petitnord", "demo-atelier",
]);

// Atelier's made-to-order gowns live ONLY in a private catalogue.
const PRIVATE_ONLY = [
  "A-102 Beaded Column Gown (Made to Order)",
  "A-109 Embroidered Cape Gown (Made to Order)",
  "A-110 Hand-Beaded Archive Gown (Made to Order)",
];

let assertions = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  assertions++;
  if (!cond) failures.push(`${label}${detail ? `\n       ${detail}` : ""}`);
};

async function rpc(fn, body) {
  const res = await fetch(URL + fn, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${await res.text()}`);
  return res.json();
}
const search = (q, extra = {}) =>
  rpc("v2_marketplace_search", { p_account_id: null, p_query: q, p_limit: 100, p_offset: 0, ...extra });

// -- the feed's whole universe, for the containment assertion ---------------
const universe = new Map();
for (let off = 0; off < 400; off += 100) {
  const page = await rpc("v2_marketplace_feed", {
    p_account_id: null, p_limit: 100, p_offset: off, p_category: null, p_sort: "woven",
  });
  page.forEach((r) => universe.set(r.product_id, r.product_name));
  if (page.length < 100) break;
}
ok("the feed universe is non-trivial", universe.size > 50, `got ${universe.size}`);

// -- 1. an empty query is not a browse --------------------------------------
for (const q of ["", "   ", null]) {
  const rows = await search(q);
  ok(`empty query ${JSON.stringify(q)} returns nothing`, rows.length === 0, `got ${rows.length}`);
}

// -- 2. LIKE metacharacters are literal --------------------------------------
for (const q of ["%", "_", "%%", "__"]) {
  const rows = await search(q);
  ok(`${JSON.stringify(q)} is a literal, not a wildcard`, rows.length === 0, `got ${rows.length}`);
}

// -- 3. an exact reference wins ---------------------------------------------
{
  const rows = await search("C-117");
  ok("C-117 finds something", rows.length >= 1, `got ${rows.length}`);
  ok("C-117 is the FIRST result", (rows[0]?.product_name || "").startsWith("C-117"),
     `first was ${JSON.stringify(rows[0]?.product_name)}`);
  const lower = await search("c-117");
  ok("case does not matter for a reference",
     lower[0]?.product_id === rows[0]?.product_id);
}

// -- 4. CONTAINMENT — search can reach nothing the feed cannot show ----------
const TERMS = ["a", "e", "o", "tee", "jean", "boot", "gown", "kids", "denim", "bag", "set", "shirt"];
let checked = 0;
for (const t of TERMS) {
  const rows = await search(t);
  checked += rows.length;
  const strays = rows.filter((r) => !universe.has(r.product_id));
  ok(`"${t}" returns nothing outside the published universe`, strays.length === 0,
     strays.slice(0, 3).map((s) => s.product_name).join(", "));
}
ok("the containment check actually looked at products", checked > 100, `only ${checked} rows seen`);

// -- 5. private-only products are unfindable, member or not ------------------
for (const name of PRIVATE_ONLY) {
  for (const [who, account] of [["anonymous", null], ["a member of Atelier", MEMBER_ACCOUNT]]) {
    const rows = await search(name, { p_account_id: account });
    ok(`${who} cannot find ${JSON.stringify(name.slice(0, 24))}…`, rows.length === 0,
       `got ${rows.length}`);
  }
  // And by its reference, which is the other way anyone would look for it.
  const byRef = await search(name.split(" ")[0], { p_account_id: MEMBER_ACCOUNT });
  ok(`nor by its reference ${name.split(" ")[0]}`,
     !byRef.some((r) => r.product_name === name), `got ${byRef.length} rows`);
}

// -- 6. access is honest -----------------------------------------------------
{
  const anon = await search("tee");
  ok("anonymous is a member of nothing", anon.every((r) => r.access === "none"),
     anon.filter((r) => r.access !== "none").slice(0, 2).map((r) => r.product_name).join(", "));
  const mine = await search("tee", { p_account_id: MEMBER_ACCOUNT });
  ok("the demo buyer is a member of the demo shops",
     mine.filter((r) => DEMO_WIDS.has(r.wid)).every((r) => r.access === "member"),
     mine.filter((r) => DEMO_WIDS.has(r.wid) && r.access !== "member").slice(0, 2)
         .map((r) => `${r.wid}/${r.access}`).join(", "));
  ok("…and of nothing else",
     mine.filter((r) => !DEMO_WIDS.has(r.wid)).every((r) => r.access === "none"));
}

// -- 7. commission never leaves the server -----------------------------------
{
  const rows = await search("tee");
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  ok("no commission column in the payload",
     ![...keys].some((k) => /commission|revenue|margin|cost/i.test(k)),
     [...keys].join(", "));
}

// -- 8. paging is exact ------------------------------------------------------
{
  const all = await search("a", { p_limit: 24, p_offset: 0 });
  const two = await search("a", { p_limit: 12, p_offset: 0 });
  const three = await search("a", { p_limit: 12, p_offset: 12 });
  ok("limit is honoured", two.length <= 12 && all.length <= 24, `${two.length}/${all.length}`);
  const joined = [...two, ...three].map((r) => r.product_id);
  ok("no duplicate across two pages", new Set(joined).size === joined.length);
  ok("two pages of 12 equal one page of 24",
     JSON.stringify(joined) === JSON.stringify(all.map((r) => r.product_id)),
     `${joined.length} vs ${all.length}`);
}

// -- 9. it reaches across stores --------------------------------------------
{
  const rows = await search("e");
  const shops = new Set(rows.map((r) => r.wid));
  ok("a search spans more than one wholesaler", shops.size > 1, [...shops].join(", "));
}

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
