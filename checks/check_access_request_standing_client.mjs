// =============================================================================
// GATE — WHERE MY REQUEST STANDS, CLIENT SIDE   AC-07, AC-11, PB-01, 30 Aug 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ NO STATE IS A DEAD END. Every one of the four things a request can be
//      — waiting, waiting too long, approved, declined — produces a sentence
//      that tells the buyer what is happening and what to do. A blank row on
//      this screen is the exact complaint the feature was built from:
//      "without confirmation that suppliers have even seen the request, it
//      makes it nearly impossible to move forward with any certainty."
//
//   2. THE BUYER NEVER SEES THE INTERNAL REASON CODE, and the wording comes
//      from the one shared list — not authored a second time here.
//
//   3. THE CONFIRMATION AFTER ASKING SAYS WHAT HAPPENS NEXT AND HOW LONG, and
//      names where to look. "Waiting for them to approve you" was the dead end.
//
//   4. THE LIST RENDERS ABOVE THE GRID. A buyer who already asked came back to
//      find out what happened; making them scroll past the thing they already
//      did is the dead end again, in a different shape.
//
// RUN:  node checks/check_access_request_standing_client.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>",
  { url: "https://check.local/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CSS = dom.window.CSS || { escape: (s) => String(s) };

let RPC = {};
const CALLS = [];
dom.window.supabase = {
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async (name, args) => {
      CALLS.push({ name, args });
      const h = RPC[name];
      return typeof h === "function" ? h(args) : { data: [], error: null };
    },
    auth: { getSession: async () => ({ data: { session: null } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const settle = () => new Promise((r) => setTimeout(r, 0));
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

const { devAuth } = await import("../js/lib/dev-auth.js");
const { listMyAccessRequests, requestStanding, humanHours } =
  await import("../js/data/access-requests.js");
const dirView = await src("../js/views/directory.js");

devAuth.adoptBuyerSession({
  role: "buyer", wid: "alpha", wholesalerName: "Alpha", actorId: "acc-1",
  actorLabel: "Zed", accountId: "acc-1", clientId: "cli-1", shopName: "Zed Shop", discountPct: 0,
});

const ROW = (over = {}) => ({
  request_id: "r1", wid: "beta", wholesaler_name: "Beta Supply", brand: "Beta",
  status: "pending", requested_at: "2026-08-29T10:00:00Z", decided_at: null,
  reason_code: null, reason_text: null, sla_hours: 48, hours_waiting: 3, overdue: false,
  ...over,
});

// ================================================= 1. THE FIELD LIST IS FIXED
// WIDENED 11 -> 18 on 30 Aug 2026 by AC-10 (migration 106), which added the
// re-apply standing to the same row. The assertion below is NOT about the
// number: it is about the mapper declaring a FIXED list rather than spreading
// the row, so a column added for one screen cannot surface on another because
// nobody was looking. Widening it deliberately, with the new names written out,
// is how that property is kept -- deleting the assertion is how it is lost.
const FIELDS = ["requestId","wid","wholesalerName","brand","status","requestedAt",
                "decidedAt","slaHours","hoursWaiting","overdue","declineWording",
                "attempt","superseded","reapplyState","canReapply","reapplyAt",
                "reapplyNoteRequired","reapplyAdvice"];
RPC = { v2_my_access_requests: async () => ({ data: [ROW()], error: null }) };
let rows = await listMyAccessRequests();
ok(rows.length === 1, "a request comes through the mapper");
ok(JSON.stringify(Object.keys(rows[0])) === JSON.stringify(FIELDS),
   `the mapper returns exactly the eighteen declared fields (got: ${Object.keys(rows[0]).join(",")})`);
ok(!("reason_code" in rows[0]) && !("reasonCode" in rows[0]),
   "⭐ the internal reason CODE does not reach the view at all — only the wording does");

// ============================================ 2. NO STATE IS A DEAD END
const states = [
  ["waiting",        ROW(),                                                      /usually answer/i],
  ["waiting too long", ROW({ overdue: true, hours_waiting: 99 }),                /longer than|worth chasing/i],
  ["approved",       ROW({ status: "approved" }),                                /shop here now/i],
  ["declined",       ROW({ status: "rejected", reason_code: "outside_area" }),   /deliver to your area/i],
];
for (const [label, row, re] of states) {
  RPC = { v2_my_access_requests: async () => ({ data: [row], error: null }) };
  const [r] = await listMyAccessRequests();
  const said = requestStanding(r);
  ok(typeof said === "string" && said.trim().length > 10 && re.test(said),
     `⭐ "${label}" produces a real sentence — got "${String(said).slice(0, 78)}"`);
  ok(!/undefined|null|NaN|\[object/.test(said),
     `..."${label}" has no undefined or null leaking into the sentence`);
}

// ============================================ 3. NO INTERNAL CODE, EVER
RPC = { v2_my_access_requests: async () => ({ data: [
  ROW({ status: "rejected", reason_code: "not_a_retailer" })], error: null }) };
let [r] = await listMyAccessRequests();
ok(!requestStanding(r).includes("not_a_retailer") && !/_/.test(requestStanding(r)),
   "a declined request never shows the buyer the internal code");
RPC = { v2_my_access_requests: async () => ({ data: [
  ROW({ status: "rejected", reason_code: "a_code_the_client_has_never_heard_of" })], error: null }) };
[r] = await listMyAccessRequests();
ok(requestStanding(r).trim().length > 10 && !/a_code_the_client/.test(requestStanding(r)),
   "a reason code this build does not know still produces a sentence, not a blank and not the code");

// ============================================ 4. HOURS AS A PERSON SAYS THEM
ok(humanHours(48) === "2 days", `48 hours reads as "2 days" — got "${humanHours(48)}"`);
ok(humanHours(1) === "an hour", `1 hour is not "1 hours" — got "${humanHours(1)}"`);
ok(humanHours(24) === "a day", `24 hours reads as "a day" — got "${humanHours(24)}"`);
ok(/a short time/.test(humanHours(undefined)),
   "a missing number still produces words rather than 'undefined hours'");

// ============================================ 5. FAILURE IS SILENT, NOT FATAL
RPC = { v2_my_access_requests: async () => ({ data: null, error: { message: "boom" } }) };
let threw = false;
try { rows = await listMyAccessRequests(); } catch { threw = true; }
ok(!threw && Array.isArray(rows) && rows.length === 0,
   "an RPC error returns [] rather than throwing — this renders on the buyer's own screen");

// ============================================ 6. THE SCREEN
ok(/listMyAccessRequests/.test(dirView),
   "the directory screen asks for the buyer's own requests");
ok(dirView.indexOf('className = "dir-mine"') < dirView.indexOf('className = "dir-grid"'),
   "⭐ the standing list is built ABOVE the grid — a buyer who already asked came back for the answer, not to scroll past their own question");
ok(/if \(!rows\.length\) return;/.test(dirView),
   "and it renders nothing at all on a first visit rather than an empty box labelled 'Your requests'");
ok(/paintMine\(\)/.test(dirView.slice(dirView.indexOf("if (res.ok)"))),
   "asking for access re-paints the list, so the request appears where the confirmation just said it would");

// ============================================ 7. PB-01: THE CONFIRMATION
// Slice FORWARD from the branch, not to the file's first "} else {" — which is
// two thousand characters EARLIER and produced an empty string that failed two
// assertions about code that was perfectly correct. indexOf with no fromIndex
// searches from zero; that is the whole bug, and it is the same shape as
// grepping a file to ask a question about one function.
const okAt = dirView.indexOf("if (res.ok)");
const confirm = dirView.slice(okAt, dirView.indexOf("} else {", okAt));
ok(!/Waiting for them to approve you\./.test(confirm),
   "the old dead-end sentence is gone");
ok(/humanHours\(/.test(confirm),
   "⭐ the confirmation names how long THIS wholesaler usually takes");
ok(/check back|Your requests/i.test(confirm),
   "...and tells them where to look for the answer, which is the half that makes it not a dead end");

// ======================= 7b. PB-01: THE CARD ON THE *RETURN* VISIT
//
// THIS SECTION EXISTS BECAUSE THE GATE ABOVE PASSED WHILE THE FEATURE WAS HALF
// BUILT. There are TWO dead ends in this file, not one:
//
//   1. the confirmation, seen once in the second after pressing the button
//      (section 7) -- which was fixed, gated, and red-proved; and
//   2. THE CARD ITSELF, rendered whenever `access === "pending"`, which is what
//      the same buyer sees on every visit afterwards -- which was NOT.
//
// The second is the worse of the two, because it is the one that persists. It
// was found by grepping the LIVE, DEPLOYED file for the removed sentence and
// getting two hits back, after a 27-assertion gate had reported a clean pass.
// A gate that asks about one code path cannot speak for the other.
//
// The assertion therefore reads the file with comments stripped, so that
// quoting the old sentence in a comment -- as both code paths now do, to
// explain themselves -- cannot satisfy or break it.
const dirNoComments = dirView
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

ok(!/Waiting for them to approve you/.test(dirNoComments),
   "⭐ the dead-end sentence appears NOWHERE in live code — not on the card, not in the confirmation");

const pendAt = dirNoComments.indexOf('w.access === "pending"');
ok(pendAt !== -1, "the card still has a branch for a request already made");
const pendBranch = dirNoComments.slice(pendAt, dirNoComments.indexOf("} else {", pendAt));
ok(/humanHours\(/.test(pendBranch),
   "⭐ the card a returning buyer sees names how long THIS wholesaler usually takes, exactly as the confirmation does");
ok(/Your requests/.test(pendBranch),
   "...and points at where the answer will appear, so the return visit is not a dead end either");
ok(/w\.name/.test(pendBranch),
   "...and names the wholesaler, because a card that says only 'Asked.' is a shrug");

// ============================================ 8. THE OWNER'S ESCALATION
const ownerView = await src("../js/views/owner.js");
const ownerData = await src("../js/data/owner.js");
ok(/v2_overdue_access_requests/.test(ownerData),
   "the owner console can list requests that have aged past the wholesaler's own time");
ok(ownerView.indexOf("data-overdue-access") < ownerView.indexOf('await listSignupRequests("pending")'),
   "⭐ the overdue list renders BEFORE the queue's early return — otherwise an empty queue would hide every shop that is being kept waiting");

// ------------------------------------------------- report
console.log("\n=== check_access_request_standing_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_access_request_standing_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
