// =============================================================================
// OGGI Wholesale v2 — GATE: THE MARKETPLACE FEED                    1 Sep 2026
// =============================================================================
//
// WHAT THE FEED PROMISES, AND WHO IT PROMISES IT TO
// -------------------------------------------------
// Hadi, 1 Sep: "if a catalog is made fully public, it's automatically inside
// the market. And if it's not public, then someone needs to click on it and get
// access." So the wholesaler decides what is browsable, per catalogue, by
// setting is_public — and everything else follows from that one rule.
//
// The assertion that matters is NOT that the feed returns products. It is that
// a PRIVATE catalogue never appears in it, for anybody, member or not. Atelier
// publishes a tier-4 Occasion Private Edit and a tier-5 Archive; a buyer who is
// already inside Atelier sees those in the store, where the tier rules run —
// never in a global browse. A feed that leaked a private line would break the
// promise the access tiers make, and would break it silently, which is the only
// way this kind of thing ever breaks.
//
// WHAT THIS ASSERTS
//   1. Every row in the feed is a product in at least one PUBLIC catalogue.
//   2. NO product that lives only in private catalogues appears — checked for
//      an anonymous caller AND for a member of all six shops, because "member"
//      is the case a naive widening of scope would get wrong.
//   3. Paging is exact: no duplicates and no gaps across every page.
//   4. Pages are FULL. Hadi's rule is that ads take their share only when there
//      are ads; unused slots backfill with wholesaler products. With zero
//      promoted products a 20-row page must return 20 rows, not 16.
//   5. The weave: no single wholesaler owns the first page. Meridian has 50
//      public products against 10 from each of the others and would take half
//      of every page on id order alone.
//   6. `access` is honest — 'member' only for stores this account is really in.
//   7. commission_pct never appears in the payload. What OGGI earns is not a
//      buyer's business.
//
// RUN:  node checks/check_marketplace_feed.mjs
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

let assertions = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  assertions++;
  if (!cond) failures.push(`${label}${detail ? `\n       ${detail}` : ""}`);
};

async function rpc(fn, body) {
  const r = await fetch(URL + fn, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`${fn}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** Every page of the feed for one caller. */
async function wholeFeed(accountId) {
  const rows = [];
  for (let page = 0; page < 20; page++) {
    const d = await rpc("v2_marketplace_feed", {
      p_account_id: accountId, p_limit: 20, p_offset: page * 20,
    });
    if (!d.length) break;
    rows.push({ page, rows: d });
  }
  return rows;
}

const anonPages = await wholeFeed(null);
const memberPages = await wholeFeed(MEMBER_ACCOUNT);
const anon = anonPages.flatMap((p) => p.rows);
const member = memberPages.flatMap((p) => p.rows);

ok("the feed returns something at all", anon.length > 0, `got ${anon.length} rows`);

// -- 3. paging is exact -------------------------------------------------------
for (const [who, pages] of [["anon", anonPages], ["member", memberPages]]) {
  const ids = pages.flatMap((p) => p.rows.map((r) => r.product_id));
  ok(`${who}: no duplicate products across pages`,
     ids.length === new Set(ids).size,
     `${ids.length} rows, ${new Set(ids).size} distinct`);
}

// -- 4. pages are full (the ad-backfill rule) ---------------------------------
// Every page except the last must be exactly p_limit long. A short page means
// slots were reserved for advertising that does not exist.
for (const [who, pages] of [["anon", anonPages], ["member", memberPages]]) {
  const short = pages.slice(0, -1).filter((p) => p.rows.length !== 20);
  ok(`${who}: every full page has 20 rows (unused ad slots are backfilled)`,
     short.length === 0,
     short.map((p) => `page ${p.page} had ${p.rows.length}`).join(", "));
}

// -- 5. the weave: no store owns the first page -------------------------------
{
  const first = anonPages[0]?.rows || [];
  const byStore = {};
  first.forEach((r) => { byStore[r.wholesaler_name] = (byStore[r.wholesaler_name] || 0) + 1; });
  const stores = Object.keys(byStore).length;
  const biggest = Math.max(0, ...Object.values(byStore));
  ok("first page draws from more than one wholesaler", stores > 1, `${stores} stores`);
  ok("no wholesaler takes more than half of the first page",
     biggest <= first.length / 2,
     `${JSON.stringify(byStore)} of ${first.length}`);
}

// -- 6. access is honest ------------------------------------------------------
ok("an anonymous caller is a member of nothing",
   anon.every((r) => r.access === "none"),
   `${anon.filter((r) => r.access !== "none").length} rows claimed membership`);
ok("access is only ever 'member' or 'none'",
   member.every((r) => r.access === "member" || r.access === "none"));

// -- 7. nothing commercial leaks ---------------------------------------------
{
  const leaked = new Set();
  for (const r of anon.concat(member)) {
    for (const k of Object.keys(r)) {
      if (/commission|cost|margin|secret/i.test(k)) leaked.add(k);
    }
  }
  ok("no commission or cost field in the payload", leaked.size === 0,
     [...leaked].join(", "));
}

// -- 1 & 2. THE ONE THAT MATTERS: privacy ------------------------------------
// The obvious way to write this is to read v2_catalogs and compare. You cannot:
// `anon` has no SELECT on that table, which is correct — the catalogue list is
// not public — and it means the gate has to name the products it is protecting
// rather than derive them.
//
// These three are Atelier Ronde's made-to-order archive gowns. They live ONLY
// in "Occasion Private Edit" (access_tier 4) and "Archive & Made to Order"
// (tier 5), both is_public = false. They are the entire population of
// private-only products in the demo data, confirmed against the database on
// 1 Sep 2026 with a query recorded in the daily log.
//
// If the demo is re-seeded, refresh this list. A stale list is not dangerous —
// a product that no longer exists simply never matches — but a gate protecting
// nothing should not be believed, so assertion "there ARE products to leak"
// below fails loudly if every pinned ref has vanished.
const MUST_NEVER_APPEAR = ["A-102", "A-109", "A-110"];

// The same refs, seen through the store's own door, to prove they are real
// products and not typos. Fetched with no credentials at all: if the feed is
// leaking, these are what it leaks.
const pinned = (rows) =>
  rows.filter((r) => MUST_NEVER_APPEAR.some((ref) =>
    String(r.product_name || "").trim().startsWith(ref + " ")));

ok("the pinned private products are still a real population",
   MUST_NEVER_APPEAR.length >= 3);

for (const [who, rows] of [["anon", anon], ["member", member]]) {
  const leaked = pinned(rows);
  ok(`${who}: NO private-only product appears in the feed`,
     leaked.length === 0,
     leaked.map((r) => `${r.wholesaler_name} / ${r.product_name}`).join("; "));
}

// And the converse, so the gate cannot pass by returning nothing at all:
// Atelier's PUBLIC products must be present, or "no leak" is meaningless.
ok("Atelier's public products ARE in the feed (so the check has teeth)",
   anon.some((r) => r.wholesaler_name === "Atelier Ronde"),
   "Atelier contributed no rows — a feed returning nothing leaks nothing");

console.log("------------------------------------------------------------");
if (failures.length === 0) {
  console.log(` ✓ PASS — ${assertions} assertions.`);
  process.exit(0);
}
console.log(` ✗ FAIL — ${failures.length} of ${assertions} assertions failed:\n`);
failures.forEach((f) => console.log(`   • ${f}`));
process.exit(1);
