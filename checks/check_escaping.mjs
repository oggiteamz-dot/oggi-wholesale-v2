// CHECK: user-controlled values are escaped before reaching innerHTML.
//
// Behaviour check, not a name check. It renders real components in a real DOM
// with hostile input and asserts what ends up in the tree. A rewrite that
// renames every helper still passes; a rewrite that drops the escaping fails.
//
// Run:  node checks/check_escaping.mjs
// Exit 0 = all assertions held. Exit 1 = something regressed.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { esc, money, pageHeader } = await import("../js/lib/utils.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? "\n        " + detail : ""}`); fail++; }
};

// The payload a hostile wholesaler brand name or buyer label would carry.
const PAYLOAD = `<img src=x onerror="alert(1)">`;
const QUOTED  = `Ali"s "Store" & <Co>`;

console.log("Escaping / innerHTML integrity checks\n");

// --- esc() ---------------------------------------------------------------
ok("esc neutralises a script-injection payload",
   !esc(PAYLOAD).includes("<img") && esc(PAYLOAD).includes("&lt;img"));

ok("esc handles null and undefined without throwing",
   esc(null) === "" && esc(undefined) === "");

ok("esc escapes all five significant characters",
   esc(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;");

// --- pageHeader(): the sink that was unescaped in all 7 former copies -----
const h1 = pageHeader(PAYLOAD, "desc");
ok("pageHeader escapes the title (no element injected)",
   h1.querySelectorAll("img").length === 0,
   `injected ${h1.querySelectorAll("img").length} <img> element(s)`);

ok("pageHeader title still renders as readable text",
   h1.querySelector("h1").textContent === PAYLOAD);

const h2 = pageHeader("Catalog", `Browsing ${PAYLOAD}`);
ok("pageHeader escapes the description",
   h2.querySelectorAll("img").length === 0);

const h3 = pageHeader(QUOTED, QUOTED);
ok("pageHeader renders quotes and ampersands correctly",
   h3.querySelector("h1").textContent === QUOTED);

// --- the capability three screens used to lack ---------------------------
const h4 = pageHeader("T", "D", `<button id="act">Do</button>`);
ok("pageHeader always provides the page-actions slot",
   h4.querySelector(".page-actions") !== null);

ok("actionsHtml is intentionally NOT escaped (developer-authored markup)",
   h4.querySelector("#act") !== null);

ok("pageHeader keeps its structural classes",
   h4.className === "page-header" && h4.querySelector(".page-title-group") !== null);

// --- money(): consolidated from two copies -------------------------------
ok("money formats a number", money(12.5) === "$12.50");
ok("money distinguishes 'no price' from zero",
   money(null) === "—" && money(0) === "$0.00");
ok("money honours a custom currency symbol", money(3, "€") === "€3.00");

console.log(`\n  passed: ${pass}   failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
