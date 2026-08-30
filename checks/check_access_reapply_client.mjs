// =============================================================================
// GATE — ASKING AGAIN AFTER A DECLINE, CLIENT SIDE            AC-10, 30 Aug 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ THE BROWSER NEVER DECIDES WHETHER A SHOP MAY ASK AGAIN. Every branch
//      switches on the server's `reapply_state`. If this file ever grows its
//      own date arithmetic or its own attempt counter, there are two answers to
//      "may I ask again", and the one the buyer sees is the one that can be
//      edited with developer tools.
//
//   2. ⭐ NO DECLINED ROW IS A DEAD END. Every state a declined shop can be in
//      — may ask now, must wait until a date, asking will not help, out of
//      attempts — produces a real sentence. A decline with nothing after it is
//      the PB-01 dead end one step later.
//
//   3. ONE "ASK AGAIN" BUTTON PER WHOLESALER, on the newest attempt only. The
//      server flags every older row `superseded`; if the view ignored that, a
//      buyer would see two buttons for one relationship and one of them would
//      not work.
//
//   4. ASKING AGAIN GOES THROUGH THE SAME `requestAccess` AS A FIRST
//      APPLICATION. Migration 106 put every rule behind one database function
//      precisely so there is one door; a second client helper here would be a
//      second place for the note rules to drift.
//
//   5. THE TWO REVIEW SCREENS SHARE ONE HISTORY COMPONENT. The wholesaler's
//      queue and the owner console both review access requests. Two copies of
//      the card would drift, and the way anybody would find out is one screen
//      deciding without history the other screen shows.
//
// RUN:  node checks/check_access_reapply_client.mjs
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
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

const { devAuth } = await import("../js/lib/dev-auth.js");
const { listMyAccessRequests, reapplyStanding, formatDay } =
  await import("../js/data/access-requests.js");
const { priorApplication } = await import("../js/components/prior-application.js");

devAuth.adoptBuyerSession({
  role: "buyer", wid: "alpha", wholesalerName: "Alpha", actorId: "acc-1",
  actorLabel: "Zed", accountId: "acc-1", clientId: "cli-1", shopName: "Zed Shop", discountPct: 0,
});

const ROW = (over = {}) => ({
  request_id: "r1", wid: "beta", wholesaler_name: "Beta Supply", brand: "Beta",
  status: "rejected", requested_at: "2026-07-01T10:00:00Z", decided_at: "2026-07-02T10:00:00Z",
  reason_code: "outside_area", reason_text: null, sla_hours: 48, hours_waiting: 900,
  overdue: false, attempt: 1, superseded: false, reapply_state: null,
  can_reapply: false, reapply_at: null, reapply_note_required: false,
  reapply_advice: null, ...over,
});
const one = async (over) => {
  RPC = { v2_my_access_requests: async () => ({ data: [ROW(over)], error: null }) };
  const [r] = await listMyAccessRequests();
  return r;
};

// ============================ 1. NO DECLINED STATE IS A DEAD END
const states = [
  ["may ask now",        { reapply_state: "ok", can_reapply: true },                        /ask (this store|again)/i],
  ["may ask, with a note", { reapply_state: "ok", can_reapply: true, reapply_note_required: true,
                             reapply_advice: "Send them your registration number." },       /registration number/i],
  ["must wait",          { reapply_state: "wait", reapply_at: "2026-11-01T00:00:00Z" },     /ask again on/i],
  ["will not help",      { reapply_state: "blocked",
                           reapply_advice: "Your shop already has an account with them." }, /already has an account/i],
  ["out of attempts",    { reapply_state: "exhausted" },                                    /directly/i],
];
for (const [label, over, re] of states) {
  const said = reapplyStanding(await one(over));
  ok(typeof said === "string" && said.trim().length > 10 && re.test(said),
     `⭐ "${label}" produces a real sentence — got "${String(said).slice(0, 76)}"`);
  ok(!/undefined|null|NaN|\[object|Invalid Date/.test(String(said)),
     `..."${label}" has nothing leaking into the sentence`);
}

// ============================ 2. AND NOTHING IS SAID WHERE THERE IS NOTHING TO SAY
ok(reapplyStanding(await one({ status: "pending", reapply_state: "pending" })) === null,
   "a request still being considered gets no re-apply sentence — it is not a decline");
ok(reapplyStanding(await one({ status: "approved", reapply_state: "member" })) === null,
   "an approved request gets none either");
ok(reapplyStanding(await one({ superseded: true, reapply_state: "ok" })) === null,
   "⭐ an OLDER attempt gets none — it is history, and a second live sentence per wholesaler is one that lies");
ok(reapplyStanding(null) === null && reapplyStanding(undefined) === null,
   "and a missing row does not throw at a render path");

// ============================ 3. THE BROWSER DOES NOT DECIDE
const dataSrc = strip(await src("../js/data/access-requests.js"));
const viewSrc = strip(await src("../js/views/directory.js"));
for (const [file, text] of [["js/data/access-requests.js", dataSrc], ["js/views/directory.js", viewSrc]]) {
  // BOTH OPERAND ORDERS. The first draft only caught `new Date() < x` and a red
  // proof written as `new Date(r.reapplyAt) < new Date()` walked straight past
  // it — the comparison was there, just with the bare Date on the right. A
  // regex that asks about one side of an operator is the same mistake as a gate
  // that asks about one code path (GATE-EVIDENCE.md §7b).
  //
  // AND THE SECOND DRAFT WENT RED ON CORRECT CODE. Widening `[<>]` to `[<>=]`
  // made `const d = new Date(iso);` inside formatDay match on the ASSIGNMENT.
  // It is relational operators that mean "deciding a cooldown"; `=` means
  // "parsing a date to print it", which this file is allowed to do.
  ok(!/Date\.now\(\)|new Date\([^)]*\)\s*[<>]|[<>]\s*=?\s*new Date\(|getTime\(\)\s*[<>+-]/.test(text),
     `⭐ ${file} does no date arithmetic of its own — the cooldown is the server's answer, not a second one`);
  ok(!/cooldown|COOLDOWN|max_?attempts|maxAttempts/i.test(text),
     `...and ${file} holds no cooldown or attempt-cap constant`);
}
ok(/r\.reapplyState|reapplyState/.test(dataSrc),
   "the sentence is chosen by switching on the server's state");

// formatDay is presentation only, and must not invent a date.
ok(formatDay(null) === "" && formatDay("not-a-date") === "",
   "a missing or unparseable date renders as nothing, never as 'Invalid Date'");

// ============================ 4. ONE DOOR, AND ONE BUTTON
ok(/requestAccess\(r\.wid, note\)/.test(viewSrc),
   "⭐ asking again calls the SAME requestAccess as a first application — one door, as migration 106 built it");
ok(!/v2_reapply|reapplyForAccess|rpc\(\s*["'`]v2_/.test(viewSrc),
   "...and the view invents no second RPC of its own");
ok(/rows\.filter\(\(r\) => !r\.superseded\)/.test(viewSrc),
   "⭐ only the newest attempt per wholesaler is rendered as a live row");
ok(/if \(r\.canReapply\)/.test(viewSrc),
   "the Ask again button appears only where the SERVER said it may");
const againAt = viewSrc.indexOf("canReapply");
const olderAt = viewSrc.indexOf("older.length");
ok(againAt !== -1 && olderAt !== -1 && againAt < olderAt,
   "the live rows are built before the folded history, so the answer is above the archive");
ok(/details/.test(viewSrc) && /earlier attempt/i.test(viewSrc),
   "earlier attempts are kept and foldable rather than deleted — 'have I asked before' is the buyer's question to answer");

// The server's sentence is what the buyer is shown after asking again, in BOTH
// directions. A cheerful message written here could contradict a refusal.
const againFn = viewSrc.slice(viewSrc.indexOf("async function onAskAgain"));
ok(/res\.msg/.test(againFn.slice(0, 1400)),
   "⭐ the result of asking again is the SERVER's sentence, not one written in the browser");

// ============================ 5. THE PREVIOUS APPLICATION, ATTACHED
const first = priorApplication({ attempt: 1, prior_count: 0 });
ok(first === null,
   "⭐ a first application renders NO history block at all — not an empty one");

const box = priorApplication({
  attempt: 2, prior_count: 1, prior_id: "p1", prior_reason_code: "cannot_verify",
  prior_reason_text: "no address given", prior_decided_at: "2026-08-01T09:00:00Z",
  prior_note: "We are a childrenswear shop in Tripoli.", prior_by: "Beta Supply",
});
ok(box && box.getAttribute("data-attempt") === "2",
   "a re-application carries the attempt number on the element, so a gate need not read the copy");
const t = box.textContent;
ok(/Application 2/.test(t), "the wholesaler is told which attempt this is");
ok(/We could not verify the shop/.test(t),
   "⭐ ...and WHAT THEY DECIDED LAST TIME, in the words they picked from");
ok(!/cannot_verify/.test(t),
   "...never the internal code");
ok(/no address given/.test(t), "the note they typed then is shown back to them");
ok(/childrenswear shop in Tripoli/.test(t),
   "⭐ and what the SHOP said then, so a re-application can be compared with what it replaces");
ok(!/could not confirm the details of your shop/i.test(t),
   "the BUYER's wording is not used here — the wholesaler is reading their own note back");

const unlinked = priorApplication({ attempt: 1, prior_count: 2, prior_id: null });
ok(unlinked && /not linked/.test(unlinked.textContent),
   "an earlier request with no link says so plainly rather than implying we know what happened");

// XSS: the note is buyer-typed and lands on a wholesaler's screen.
const nasty = priorApplication({
  attempt: 2, prior_count: 1, prior_id: "p1", prior_reason_code: "other",
  prior_note: '<img src=x onerror="alert(1)">', prior_decided_at: null, prior_by: null,
});
ok(nasty.querySelectorAll("img").length === 0 && /<img/.test(nasty.textContent),
   "⭐ a buyer-typed note cannot inject markup into the wholesaler's queue");

// ============================ 6. ONE COMPONENT, BOTH SCREENS
const wholesalerView = await src("../js/views/wholesaler.js");
const ownerView = await src("../js/views/owner.js");
for (const [name, text] of [["the wholesaler's queue", wholesalerView], ["the owner console", ownerView]]) {
  ok(/import \{ priorApplication \} from "\.\.\/components\/prior-application\.js"/.test(text),
     `⭐ ${name} renders history from the shared component, not its own copy`);
  ok(/priorApplication\(r\)/.test(strip(text)),
     `...and actually calls it on the request being reviewed (${name})`);
}
// The history must be in the DOM before the buttons: a decision reached by
// thumb should meet the context on the way, not after it.
for (const [name, text] of [["the wholesaler's queue", strip(wholesalerView)], ["the owner console", strip(ownerView)]]) {
  ok(/insertBefore\(prior/.test(text),
     `⭐ ${name} puts the previous application BEFORE the approve/decline buttons`);
}

// ============================ 7. THE QUEUE IS THE RPC, NOT A RAW SELECT
const wsData = strip(await src("../js/data/wholesaler-admin.js"));
const ownerData = strip(await src("../js/data/owner.js"));
for (const [name, text] of [["js/data/wholesaler-admin.js", wsData], ["js/data/owner.js", ownerData]]) {
  ok(/v2_pending_access_requests/.test(text),
     `⭐ ${name} reads the pending queue through the RPC that carries the history`);
}
ok(/status === "pending"/.test(wsData) && /status === "pending"/.test(ownerData),
   "...and the other statuses still read the table, so nothing that used to answer now returns [] silently");

// ============================ 8. THE REQUEST CAN BE ANSWERED (migration 108)
//
// Until 30 Aug the public request form collected NO contact detail at all, so a
// wholesaler could approve somebody and then had nobody to send the password
// to. There is no email in this build; the number is the whole channel.
const loginView = strip(await src("../js/views/login.js"));
const devAuthSrc = strip(await src("../js/lib/dev-auth.js"));
ok(/id="req-phone"/.test(loginView),
   "⭐ the public request form asks for a phone number");
ok(/type="tel"/.test(loginView) && /inputmode="tel"/.test(loginView),
   "...with a telephone keypad, because it is filled in on a phone");
ok(/if \(!phone\)/.test(loginView),
   "...and the form refuses to send without one");
ok(/p_phone: phone/.test(devAuthSrc),
   "the number reaches the server rather than being collected and dropped");

// The wholesaler and the owner must both be able to SEE it. A number recorded
// and not shown is the same as no number.
//
// ⚠️ THE FIRST VERSION OF THIS WAS BLIND AND A RED PROOF CAUGHT IT. It read
// `/r\.phone/` against the whole file, which still matches the line that
// COMPUTES the number — so deleting the line that RENDERS it changed nothing.
// Computing a value and putting it on the screen are different claims, and a
// gate that cannot tell them apart is asserting the easier one.
//
// Each screen is now asserted against the thing it actually interpolates into
// the card, which differs between the two files, so they are named separately
// rather than swept into one loop with one loose regex.
ok(/\$\{phoneHtml\}/.test(wholesalerView),
   "⭐ the wholesaler's queue RENDERS the number into the card, not merely computes it");
ok(/\$\{r\.phone\s*$|r\.phone\s*\n\s*\? `<a href="tel:/m.test(ownerView) || /r\.phone\s*\n\s*\? `<a href="tel:/.test(ownerView),
   "⭐ the owner console RENDERS the number into the card");
for (const [name, text] of [["the wholesaler's queue", wholesalerView], ["the owner console", ownerView]]) {
  ok(/href="tel:/.test(text),
     `...as something you can press to call (${name})`);
  ok(/asked before we collected one/.test(text),
     `...and a request made before 108 says why it has none, rather than rendering a blank (${name})`);
}
// The tel: href is built from a buyer-typed string. Strip everything but digits
// and a leading plus, or a typed quote closes the attribute.
for (const [name, text] of [["wholesaler.js", wholesalerView], ["owner.js", ownerView]]) {
  ok(/replace\(\/\[\^0-9\+\]\/g, ""\)/.test(text),
     `⭐ ${name} strips the buyer-typed number before putting it in a tel: href`);
}

// ------------------------------------------------- report
console.log("\n=== check_access_reapply_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_access_reapply_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
