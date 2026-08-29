// =============================================================================
// GATE — THE MARKETPLACE CLIENT      ID-03, ID-09, MK-01, SR-11, 30 Aug 2026
// =============================================================================
// The screens for the marketplace front door, in jsdom, against a stubbed RPC.
//
// THE PROPERTIES THIS FILE EXISTS FOR, in the order they would hurt:
//
//   1. SR-11 — A SEARCH RESULT CAN BE OPENED. From the day SR-01 shipped until
//      today, `resultCard()` attached no click handler of any kind: a buyer
//      could search across every store they had and then had no way to open
//      anything they found. Every existing assertion was about what the card
//      SHOWS, and a screen can be correct in every visible detail and still be
//      a dead end. This gate asks the question none of them asked.
//
//   2. THE SWITCHER IS A SERVER ROUND TRIP. Switching store must call
//      v2_session_account — which re-checks the membership — and must NOT be a
//      local toggle, or a buyer revoked an hour ago walks back in.
//
//   3. THE SWITCHER RENDERS NOTHING when there is nothing to switch between,
//      and nothing at all for someone who came through the per-store door.
//
//   4. THE LOGIN PASSES THE SERVER'S REFUSAL THROUGH UNCHANGED. Any friendlier
//      client-side message rebuilds, in the browser, the enumeration oracle the
//      database was careful not to be.
//
// RUN:  node checks/check_marketplace_client.mjs
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
globalThis.CSS = dom.window.CSS || { escape: (s) => String(s) };

// Every RPC the marketplace makes, recorded so the gate can assert WHICH calls
// happened — the difference between a real switch and a local toggle is not
// visible in the DOM, only in whether the server was asked.
const CALLS = [];
let RPC = {};
dom.window.supabase = {
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async (name, args) => {
      CALLS.push({ name, args });
      const h = RPC[name];
      return typeof h === "function" ? h(args) : { data: [], error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url).pathname, "utf8"); } catch { return ""; } };
const MKT_KEY = "oggi-v2-marketplace";

const mkt = await import("../js/data/marketplace.js");
const { renderStoreSwitcher } = await import("../js/components/store-switcher.js");
const { devAuth } = await import("../js/lib/dev-auth.js");

const STORES = [
  { wid: "alpha", wholesaler_name: "Alpha Supply", brand: "A", logo: null, currency: "$", account_id: "acc-a", client_id: "cli-a" },
  { wid: "beta",  wholesaler_name: "Beta Supply",  brand: "B", logo: null, currency: "€", account_id: "acc-b", client_id: "cli-b" },
];

// ---------------------------------------------------- 1. the login refusal
RPC = { v2_marketplace_login: async () => ({ data: [{ ok: false, msg: "That phone or email and password do not match." }], error: null }) };
let r = await mkt.marketplaceLogin("03 111 111", "nope");
ok(r.ok === false, "a refused sign-in returns ok:false");
ok(r.error === "That phone or email and password do not match.",
   "the SERVER's single refusal is passed through verbatim — no friendlier client-side message that would tell the three failure cases apart");
ok(dom.window.localStorage.getItem(MKT_KEY) === null, "a refused sign-in stores no session");

// the login sends no wid, ever
CALLS.length = 0;
await mkt.marketplaceLogin("03 111 111", "nope");
const loginCall = CALLS.find((c) => c.name === "v2_marketplace_login");
ok(loginCall && !JSON.stringify(loginCall.args).toLowerCase().includes("wid"),
   "the sign-in call carries NO wholesaler code — scope is derived, never supplied");

// ---------------------------------------------------- 2. a successful sign-in
RPC = {
  v2_marketplace_login: async () => ({ data: [{
    ok: true, msg: null, session_id: "sess-1", session_token: "tok-secret",
    person_id: "per-1", display_name: "Zed Shop",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }], error: null }),
  v2_session_stores: async () => ({ data: STORES, error: null }),
};
r = await mkt.marketplaceLogin("03 111 111", "right");
ok(r.ok === true, "a correct sign-in succeeds");
ok(r.stores?.length === 2, `the sign-in returns both stores — got ${r.stores?.length}`);

const stored = JSON.parse(dom.window.localStorage.getItem(MKT_KEY) || "{}");
ok(stored.sessionId === "sess-1" && stored.token === "tok-secret", "the session is kept on the device");
ok(!("stores" in stored) && !("accountId" in stored),
   "the STORE LIST and the account id are NOT kept on the device — a cached copy is a way of disagreeing with a wholesaler who revoked you");

// ---------------------------------------------------- 3. entering a store
CALLS.length = 0;
RPC.v2_session_account = async (a) => ({
  data: [{ ok: true, account_id: "acc-" + a.p_wid, client_id: "cli-" + a.p_wid,
           wholesaler_name: a.p_wid === "beta" ? "Beta Supply" : "Alpha Supply",
           currency: a.p_wid === "beta" ? "€" : "$" }],
  error: null,
});
const e1 = await mkt.enterStore("alpha");
ok(e1.ok === true, "entering a store the person belongs to succeeds");
ok(CALLS.some((c) => c.name === "v2_session_account" && c.args.p_wid === "alpha"),
   "entering a store ASKS THE SERVER — it is not a local toggle");

const appSession = devAuth.getSession();
ok(appSession?.role === "buyer" && appSession?.wid === "alpha" && appSession?.accountId === "acc-alpha",
   "the ordinary buyer session is written, in the same shape used since Batch 0, so the rest of the app cannot tell which door was used");

// ---------------------------------------------------- 4. a refused store
RPC.v2_session_account = async () => ({ data: [{ ok: false, account_id: null, client_id: null }], error: null });
const e2 = await mkt.enterStore("gamma");
ok(e2.ok === false, "a store the person has no membership in is refused");
ok(devAuth.getSession()?.wid === "alpha",
   "a REFUSED store leaves the previous session untouched — a failed switch must not strand the buyer nowhere");

// ---------------------------------------------------- 5. the switcher
RPC.v2_session_account = async (a) => ({
  data: [{ ok: true, account_id: "acc-" + a.p_wid, client_id: "cli-" + a.p_wid, wholesaler_name: "X", currency: "$" }],
  error: null,
});
let sw = await renderStoreSwitcher({ activeWid: "alpha", onSwitch: () => {} });
ok(sw !== null, "the switcher renders when there are two stores");
const chips = [...sw.querySelectorAll("[data-store-chip]")];
ok(chips.length === 2, `one chip per store — got ${chips.length}`);
ok(chips.find((c) => c.getAttribute("data-store-chip") === "alpha")?.getAttribute("aria-current") === "true",
   "the store currently open is marked as current");

// one store -> nothing at all
RPC.v2_session_stores = async () => ({ data: [STORES[0]], error: null });
ok(await renderStoreSwitcher({ activeWid: "alpha" }) === null,
   "a buyer with ONE store gets no switcher — a control with nothing to switch to is a permanent question about a decision that does not exist");
RPC.v2_session_stores = async () => ({ data: STORES, error: null });

// per-store door -> nothing at all
dom.window.localStorage.removeItem(MKT_KEY);
ok(await renderStoreSwitcher({ activeWid: "alpha" }) === null,
   "someone who signed in through the per-store door gets no switcher");
dom.window.localStorage.setItem(MKT_KEY, JSON.stringify(stored));

// ---------------------------------------------------- 6. switching calls the server
CALLS.length = 0;
let switched = null;
sw = await renderStoreSwitcher({ activeWid: "alpha", onSwitch: (w) => { switched = w; } });
dom.window.document.getElementById("app-root").appendChild(sw);
sw.querySelector('[data-store-chip="beta"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 10));
ok(CALLS.some((c) => c.name === "v2_session_account" && c.args.p_wid === "beta"),
   "tapping another store calls v2_session_account — the membership is re-checked on every switch");
ok(switched === "beta", "the caller is told which store was opened, so it can re-render");

// a switch that the server refuses
RPC.v2_session_account = async () => ({ data: [{ ok: false }], error: null });
switched = null;
const sw2 = await renderStoreSwitcher({ activeWid: "alpha", onSwitch: (w) => { switched = w; } });
dom.window.document.getElementById("app-root").appendChild(sw2);
sw2.querySelector('[data-store-chip="beta"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 10));
ok(switched === null, "a REFUSED switch does not report success");
ok(/do not have access|access/i.test(sw2.textContent),
   "a refused switch SAYS SO rather than doing nothing — almost always a revoke, and silence looks like a broken button");

// ---------------------------------------------------- 7. logout revokes
CALLS.length = 0;
RPC.v2_session_logout = async () => ({ data: true, error: null });
await mkt.marketplaceLogout();
ok(CALLS.some((c) => c.name === "v2_session_logout"),
   "signing out REVOKES the session on the server — clearing the phone would leave a token valid for another 30 days");
ok(dom.window.localStorage.getItem(MKT_KEY) === null, "and clears it from the device");

// ---------------------------------------------------- 8. SR-11, by source
// resultCard is not exported, so this is asserted against the file. Stated
// plainly rather than dressed up as a behavioural check: what it proves is that
// a handler and a keyboard path exist and point at the MK-01 route.
const searchSrc = read("../js/views/search.js");
const cardFn = searchSrc.slice(searchSrc.indexOf("function resultCard"), searchSrc.indexOf("\nfunction ", searchSrc.indexOf("function resultCard") + 10));
ok(/addEventListener\("click"/.test(cardFn),
   "SR-11: a search result has a click handler — it had NONE from the day SR-01 shipped until today");
ok(/addEventListener\("keydown"/.test(cardFn),
   "a search result is reachable by keyboard too — a div made clickable and not focusable is a control only mouse users have");
ok(/tabindex/.test(cardFn) && /role", "button/.test(cardFn),
   "and it is announced as a button rather than looking like one");
ok(/#\/buyer\/s\/\$\{encodeURIComponent\(r\.wid\)\}\/p\//.test(cardFn),
   "the tap goes to the MK-01 route, carrying BOTH the product and ITS store");

// ---------------------------------------------------- 9. MK-01 route exists
const buyerSrc = read("../js/views/buyer.js");
ok(/router\.register\("\/buyer\/s\/:wid\/p\/:productId"/.test(buyerSrc),
   "MK-01: the cross-store product route is registered");
ok(/await enterStore\(params\.wid\)/.test(buyerSrc),
   "the route enters the store through the SERVER — it cannot be used to walk into a store by typing its id into the address bar");
ok(/marketplaceSession\(\)/.test(buyerSrc),
   "and a buyer on the per-store door is told the product is in another store rather than failing blankly");

// ---------------------------------------------------- report
console.log("\n=== check_marketplace_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_marketplace_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
