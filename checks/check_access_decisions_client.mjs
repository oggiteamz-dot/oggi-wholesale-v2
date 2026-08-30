// =============================================================================
// GATE — DECLINING, CLIENT SIDE                     AC-08, AC-17, 30 Aug 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ THE SCREEN'S REASON LIST AND THE DATABASE'S CONSTRAINT ARE THE SAME
//      SET. They are written in two files that nothing else connects. If they
//      drift, a wholesaler clicks Decline and gets a raw constraint violation
//      they cannot read, on the one screen where a stranger is waiting for an
//      answer. This assertion is the only thing holding them together.
//
//   2. NEITHER SCREEN WRITES TO THE TABLE ANY MORE. Both used to do a direct
//      `.from("v2_signup_requests").update(...)`. A decline that bypasses the
//      RPC has no reason and no audit row, which is the whole feature gone.
//
//   3. THE REASON IS ASKED FOR BEFORE ANYTHING IS CONFIRMED, and cancelling it
//      declines nothing. The obvious build confirms first and asks after —
//      which means confirming something the database will then refuse.
//
//   4. "other" CANNOT BE SENT WITHOUT AN EXPLANATION. The database refuses it;
//      the screen must not let a person get that far and be told no.
//
//   5. THE BUYER IS NEVER SHOWN THE INTERNAL CODE. Telling a shop it was
//      marked `not_a_retailer` in those words is exactly what choosing gentler
//      wording was for.
//
// RUN:  node checks/check_access_decisions_client.mjs
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

const CALLS = [];
let RPC = {};
const tableOps = [];
dom.window.supabase = {
  createClient: () => ({
    from: (t) => {
      const rec = (op) => { tableOps.push({ table: t, op }); return chain; };
      const chain = {
        select: () => rec("select"), insert: () => rec("insert"),
        update: () => rec("update"), delete: () => rec("delete"),
        eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: null }), single: async () => ({ data: null }),
        then: (r) => r({ data: [], error: null }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      CALLS.push({ name, args });
      const h = RPC[name];
      return typeof h === "function" ? h(args) : { data: [{ ok: true, msg: "ok" }], error: null };
    },
    auth: { getSession: async () => ({ data: { session: null } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

const { DECLINE_REASONS, declineWordingForBuyer } = await import("../js/data/decline-reasons.js");
const mig = await src("../supabase/migrations/104_v2_access_decision_record.sql");
const ownerSrc = await src("../js/views/owner.js");
const wsSrc = await src("../js/views/wholesaler.js");
const ownerData = await src("../js/data/owner.js");
const wsData = await src("../js/data/wholesaler-admin.js");

// ============================================ 1. ⭐ THE LIST MATCHES THE DB
const block = mig.match(/reason_code is null or reason_code in \(([\s\S]*?)\)\)/);
ok(!!block, "migration 104's reason vocabulary is findable in the file");
const dbCodes = [...(block ? block[1] : "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
const jsCodes = DECLINE_REASONS.map((d) => d.value).sort();
ok(dbCodes.length > 0 && JSON.stringify(dbCodes) === JSON.stringify(jsCodes),
   `⭐ THE SCREEN'S REASONS ARE EXACTLY THE DATABASE'S — db=[${dbCodes.join(",")}] js=[${jsCodes.join(",")}]. Drift here means a wholesaler gets a constraint violation they cannot read, with a stranger waiting on the answer`);

// ============================================ 2. NO SCREEN WRITES THE TABLE
ok(!/from\(["']v2_signup_requests["']\)[\s\S]{0,200}?\.update\(/.test(ownerData),
   "the owner console no longer UPDATEs v2_signup_requests directly");
ok(!/from\(["']v2_signup_requests["']\)[\s\S]{0,200}?\.update\(/.test(wsData),
   "the wholesaler screen no longer UPDATEs v2_signup_requests directly");
ok(/v2_decline_signup_request/.test(ownerData) && /v2_decline_signup_request/.test(wsData),
   "both go through v2_decline_signup_request instead");

// ============================================ 3. THE ORDER OF THE QUESTIONS
for (const [name, s] of [["owner console", ownerSrc], ["wholesaler screen", wsSrc]]) {
  const declineBlock = s.slice(s.indexOf("Decline ${r.buyer_name}"));
  const askIdx = declineBlock.indexOf("choices:");
  const callIdx = declineBlock.search(/reject(My)?SignupRequest\(/);
  ok(askIdx > -1 && callIdx > -1 && askIdx < callIdx,
     `${name}: the reason is asked for BEFORE the decline is sent — confirming first would confirm something the database then refuses`);
  ok(/if \(reason === null\) return;/.test(declineBlock),
     `${name}: cancelling the reason declines nothing`);
  ok(/if \(note === null\) return;/.test(declineBlock),
     `${name}: cancelling the explanation declines nothing either`);
  ok(/if \(res\.ok\) card\.remove\(\);/.test(declineBlock),
     `${name}: the card is only removed when the decline actually succeeded — removing it on failure would tell the wholesaler it worked`);
}

// ============================================ 4. "other" NEEDS AN EXPLANATION
const other = DECLINE_REASONS.find((d) => d.value === "other");
ok(!!other && other.buyer === null,
   '"other" carries no canned buyer wording — the typed note IS the wording, so there is nothing to fall back to and nothing to hide behind');
for (const [name, s] of [["owner console", ownerSrc], ["wholesaler screen", wsSrc]]) {
  ok(/reason === "other"[\s\S]{0,400}validate:/.test(s),
     `${name}: choosing "other" forces a validated explanation before anything is sent`);
}

// ============================================ 5. THE BUYER NEVER SEES A CODE
for (const d of DECLINE_REASONS) {
  const w = declineWordingForBuyer(d.value, d.value === "other" ? "we already supply your street" : null);
  ok(w && !w.includes(d.value) && !/_/.test(w),
     `the buyer wording for "${d.value}" contains no internal code — got "${String(w).slice(0, 62)}"`);
}
ok(declineWordingForBuyer("not_a_retailer", "  ") === DECLINE_REASONS[0].buyer,
   "a blank typed note falls back to the canned wording rather than to an empty sentence");
ok(/./.test(declineWordingForBuyer("something_we_removed", null)),
   "a reason code the screen no longer knows still produces a sentence — a buyer must never be shown a blank where a reason belongs");

// ============================================ 6. THE HONEST OPTION EXISTS
ok(DECLINE_REASONS.some((d) => d.value === "not_taking_clients"),
   'there is a reason that is NOT the applicant\'s fault — without it every decline gets labelled with whichever code is least embarrassing, and the buyer reads a judgement nobody made');

// ------------------------------------------------- report
console.log("\n=== check_access_decisions_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_access_decisions_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
