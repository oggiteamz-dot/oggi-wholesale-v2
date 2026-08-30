// =============================================================================
// GATE — WHAT THE WHOLESALER SEES AFTER APPROVING       AC-01/ID-03, 30 Aug 2026
// =============================================================================
// Migration 107 gave approval two outcomes. This gate is about the screen not
// lying about which one happened.
//
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ NO EMPTY PASSWORD BOX. When the applicant already signs in to OGGI
//      there is no password, and a credentials panel showing "Username: null"
//      would send a wholesaler hunting for a string that was never minted.
//
//   2. ⭐ AND NO SILENT DROP THE OTHER WAY. When there IS a password it is the
//      only time it will ever be visible -- the database stores its hash. A
//      panel that hid it would lose a real applicant their only way in.
//
//   3. WHICH OUTCOME IS THE SERVER'S ANSWER, NOT THE BROWSER'S GUESS. The
//      browser cannot know whether the applicant had an OGGI account.
//
//   4. ONE PANEL, BOTH SCREENS. The two copies this replaces had ALREADY
//      drifted -- different wording, and one of them styled with
//      `var(--surface-sunken)`, a token that does not exist and had been
//      silently falling back to a hardcoded grey.
//
// RUN:  node checks/check_approval_grants_access_client.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>",
  { url: "https://check.local/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

const { approvalResult } = await import("../js/components/approval-result.js");

// ============================ 1. THE MEMBERSHIP OUTCOME — NOTHING TO SEND
const member = approvalResult("Noor Boutique", {
  ok: true, username: null, tempPassword: null,
  message: "They can shop your store now. There is no password to send — they already sign in to OGGI, and your store has just appeared in their app.",
}, () => {});
const mText = member.textContent;
ok(member.getAttribute("data-approval") === "membership",
   "the panel marks the outcome on the element, so a gate need not read the copy");
ok(!/null|undefined|NaN/.test(mText),
   "⭐ no 'null' or 'undefined' reaches the screen when there is no password");
ok(member.querySelector("[data-creds]") === null,
   "⭐ ...and there is no credentials box at all — not an empty one");
ok(/no password to send/i.test(mText),
   "...the wholesaler is told plainly there is nothing to relay");
ok(/Noor Boutique/.test(mText), "the shop is named");
ok(member.querySelectorAll("button").length === 1, "there is exactly one control: Done");

// A server that returns ok with no message must still produce a sentence.
const bare = approvalResult("Noor Boutique", { ok: true, username: null, tempPassword: null }, () => {});
ok(!/null|undefined/.test(bare.textContent) && bare.textContent.length > 40,
   "a missing message falls back to a real sentence rather than a blank");

// ============================ 2. THE CREDENTIALS OUTCOME — SHOWN ONCE
const creds = approvalResult("Walk In Shop", {
  ok: true, username: "walkinshop433", tempPassword: "Ab3xQ9zK1p2m", message: "",
}, () => {});
const cText = creds.textContent;
ok(creds.getAttribute("data-approval") === "credentials",
   "the credentials outcome is marked on the element too");
ok(/walkinshop433/.test(cText) && /Ab3xQ9zK1p2m/.test(cText),
   "⭐ both the username and the one-time password are actually on screen");
ok(/not be shown again/i.test(cText),
   "...and the wholesaler is warned it will not be shown again");
ok(/nothing is emailed|send them to the shop yourself/i.test(cText),
   "...and told they must relay it themselves, because no email is sent");

// ============================ 3. THE SERVER DECIDES, NOT THE BROWSER
const comp = strip(await src("../js/components/approval-result.js"));
ok(/result\.username && result\.tempPassword/.test(comp),
   "⭐ which panel to show is decided by what the SERVER returned");
ok(!/person|membership_id|hasOggiAccount|request\./i.test(comp.replace(/data-approval|"membership"/g, "")),
   "...and not inferred from anything about the request the browser can see");

// Half a response is not a credentials outcome. A username with no password is
// the shape a partial failure would take, and rendering a box with one field
// filled is worse than rendering none.
for (const half of [{ username: "x", tempPassword: null }, { username: null, tempPassword: "y" }]) {
  const p = approvalResult("Shop", { ok: true, ...half }, () => {});
  ok(p.getAttribute("data-approval") === "membership" && p.querySelector("[data-creds]") === null,
     `⭐ a half-formed credentials response (${JSON.stringify(half)}) renders no box rather than one with a gap`);
}

// ============================ 4. XSS — THE USERNAME COMES FROM A SHOP NAME
const nasty = approvalResult('<img src=x onerror="alert(1)">', {
  ok: true, username: '<script>alert(2)</script>', tempPassword: "<b>p</b>",
}, () => {});
ok(nasty.querySelectorAll("img, script, b").length === 0,
   "⭐ a shop name and its derived username cannot inject markup into the panel");
ok(/<script>alert\(2\)<\/script>/.test(nasty.textContent),
   "...they are shown as the text they are");

// ============================ 5. ONE PANEL, BOTH SCREENS
const wholesalerView = await src("../js/views/wholesaler.js");
const ownerView = await src("../js/views/owner.js");
for (const [name, text] of [["the wholesaler's queue", wholesalerView], ["the owner console", ownerView]]) {
  ok(/import \{ approvalResult \} from "\.\.\/components\/approval-result\.js"/.test(text),
     `⭐ ${name} renders the result from the shared panel`);
  ok(/approvalResult\(r\.buyer_name, result,/.test(strip(text)),
     `...and actually calls it (${name})`);
  ok(!/tempPassword\}<\/strong>|result\.tempPassword\)\}/.test(strip(text)),
     `⭐ ${name} no longer has its own hand-rolled credentials markup`);
}
ok(!/surface-sunken/.test(ownerView) && !/surface-sunken/.test(wholesalerView),
   "the `var(--surface-sunken)` in both review screens is gone — that token has never existed and was falling back to a hardcoded grey");
ok(creds.querySelector("[data-creds]") !== null,
   "...and the credentials outcome DOES carry the box, so the marker means something in both directions");

// ============================ 6. THE MESSAGE IS CARRIED THROUGH
for (const f of ["../js/data/owner.js", "../js/data/wholesaler-admin.js"]) {
  const t = strip(await src(f));
  ok(/message: row\.msg/.test(t),
     `${f.replace("../", "")} passes the server's account of what happened to the panel`);
  ok(/temp_password/.test(t),
     `...and still passes the one-time password when there is one (${f.replace("../", "")})`);
}

// ------------------------------------------------- report
console.log("\n=== check_approval_grants_access_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_approval_grants_access_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
