// =============================================================================
// GATE — INVITING A LIST, CLIENT SIDE                        AC-05, 30 Aug 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ EVERY PASTED LINE IS SHOWN BACK, including the ones that failed and
//      the ones that already had a link. A bulk screen listing only successes
//      is a wholesaler believing they invited forty shops when they invited
//      thirty-eight, and never finding out which two.
//
//   2. ⭐ THE RESULTS ARE NOT DESTROYED TO REFRESH A LIST. Repainting the card
//      would rebuild its innerHTML and take the forty links with it. The links
//      are the deliverable; the list underneath is a convenience.
//
//   3. THE LINE PARSER FINDS THE NUMBER AT THE END, not by splitting on the
//      comma — a shop name may contain one ("Rita, Beirut") and a phone number
//      may not. Splitting on the comma puts half the shop name in the phone.
//
//   4. THE CSV IS QUOTED. A shop name with a comma would otherwise shift every
//      column after it, and the wrong shop gets the wrong link.
//
//   5. THE BROWSER DOES NOT DECIDE WHAT A DUPLICATE IS. Migration 109 does,
//      on the normaliser the whole schema shares.
//
// RUN:  node checks/check_bulk_invite_client.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

// The module imports the supabase client, which this gate has no business
// booting. The three functions under test are pure, so they are loaded from
// source with the imports stripped and inviteLink stubbed -- the same trick, and
// the same reason, as testing a formatter without a network.
let modSrc = (await src("../js/data/buyer-invites.js"))
  .split("\n").filter((l) => !l.startsWith("import ")).join("\n")
  .replace(/export function inviteLink[\s\S]*?\n}/,
           'export function inviteLink(t){return "https://check.local/#/i/"+t;}');
const mod = await import("data:text/javascript;base64," + Buffer.from(modSrc).toString("base64"));
const { parseInviteLines, invitesCsv } = mod;

// ============================ 1. THE PARSER
const cases = [
  ["Maison Rita, 03 456 789",        "Maison Rita",  "03 456 789"],
  ["Noor Boutique 71 333 444",       "Noor Boutique","71 333 444"],
  ["Rita, Beirut, 03 111 222",       "Rita, Beirut", "03 111 222"],
  ["  Souk Shop ;  +961 3 222 111 ", "Souk Shop",    "+961 3 222 111"],
  ["Cedar Kids",                     "Cedar Kids",   null],
  ["03 999 000",                     null,           "03 999 000"],
];
for (const [line, shop, phone] of cases) {
  const [r] = parseInviteLines(line);
  ok(r && r.shopName === shop && r.phone === phone,
     `parses ${JSON.stringify(line)} — got ${JSON.stringify(r)}`);
}
ok(parseInviteLines("A, 03 111 222\n\n  \nB, 03 222 333").length === 2,
   "blank lines in a paste are dropped rather than becoming shops with no name");
ok(parseInviteLines("").length === 0 && parseInviteLines(null).length === 0,
   "an empty box parses to nothing rather than throwing");
ok(parseInviteLines(cases[2][0])[0].shopName === "Rita, Beirut",
   "⭐ a shop name containing a comma survives — the number is found at the END of the line, not by splitting");

// ============================ 2. THE CSV
const csv = invitesCsv([
  { shopName: 'Rita, Beirut', phone: "03 111 222", token: "abc", expiresAt: "2026-09-29T00:00:00Z", outcome: "invited" },
  { shopName: 'He said "hi"', phone: null, token: "def", expiresAt: null, outcome: "existing" },
  { shopName: "No token", phone: "03 000 000", token: null, outcome: "skipped" },
]);
const lines = csv.split("\r\n");
ok(lines.length === 3, `the CSV has a header and one line per issued link (got ${lines.length})`);
ok(lines[0] === '"Shop","Phone","Link","Expires","Status"', "the header names the columns");
ok(lines[1].startsWith('"Rita, Beirut",'),
   "⭐ a shop name with a comma is quoted, so it cannot shift every column after it");
ok(lines[2].includes('"He said ""hi"""'),
   "⭐ an embedded quote is doubled, which is the only correct way out of it");
ok(!csv.includes("No token"),
   "a row that produced no link is not given a CSV line with an empty link in it");
ok(lines[1].includes("https://check.local/#/i/abc"), "the link is the real one");
ok(lines[2].includes("Already invited"),
   "a row that came back as an existing invitation says so, rather than reading as a fresh one");

// ============================ 3. THE SCREEN
const view = await src("../js/views/wholesaler.js");
const viewStripped = strip(view);
ok(/data-f="bulk"/.test(view), "the screen has a box to paste a list into");
ok(/parseInviteLines\(/.test(viewStripped) && /issueInvitesBulk\(/.test(viewStripped),
   "...which is parsed and sent through the shared functions, not re-implemented here");
ok(/res\.rows\.forEach/.test(viewStripped),
   "⭐ EVERY returned row is rendered — not just the ones that produced a link");
ok(/skipped/.test(view) && /Same link/.test(view),
   "...and the three outcomes are told apart on screen");
ok(/data-outcome/.test(view),
   "the outcome is on the element, so a gate need not read the copy");
ok(/invitesCsv\(/.test(viewStripped),
   "there is a way to copy every link out at once");

// ⭐ THE ONE THAT WOULD SILENTLY LOSE THE WORK
const bulkHandler = viewStripped.slice(viewStripped.indexOf('data-a="bulk"'));
const handlerBody = bulkHandler.slice(0, bulkHandler.indexOf("\n    invites.querySelector('[data-a=\"new\"]')"));
ok(!/await paintInvites\(\)/.test(handlerBody),
   "⭐ the bulk handler does NOT repaint the card — that would rebuild its innerHTML and destroy every link it just produced");
ok(/DELIBERATELY NO paintInvites/.test(view),
   "...and the reason is written down, so the next person does not helpfully add it back");

// The single form finally collects a phone. It always could; nothing ever did,
// so every invitation ever issued has phone = null.
ok(/data-f="phone"/.test(view), "the single-invite form asks for the shop's number");
ok(/issueInvite\(\{ shopName: shop \|\| null, phone: phone \|\| null \}\)/.test(viewStripped),
   "...and passes it, rather than collecting it and dropping it");

// ============================ 4. THE BROWSER DOES NOT DECIDE
const dataStripped = strip(await src("../js/data/buyer-invites.js"));
ok(!/existing/.test(dataStripped.replace(/outcome/g, "")) || !/r\.phone\s*===/.test(dataStripped),
   "the client does not compare phone numbers to decide what a duplicate is");
ok(!/normalise|normalize/i.test(dataStripped),
   "⭐ ...and holds no phone normaliser of its own — migration 109 decides, on the one the schema shares");

// ------------------------------------------------- report
console.log("\n=== check_bulk_invite_client.mjs ===");
for (const m of pass) console.log("  PASS  " + m);
for (const m of fail) console.log("  FAIL  " + m);
console.log("----------------------------------------");
console.log(`check_bulk_invite_client.mjs: passed: ${pass.length}   failed: ${fail.length}`);
console.log("----------------------------------------");
if (fail.length) process.exit(1);
