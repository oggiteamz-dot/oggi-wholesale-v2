/* check_os_namespace.mjs — the pack builder and the buyer's order sheet must
   never share a class name again.
 
   1 Sep 2026. Hadi reported the wholesaler's pack-builder steppers overlapping,
   worse the more sizes a product has. Cause: css/components.css defined the
   `.os-*` family TWICE — once for the pack builder (js/components/order-setup.js,
   where `.os-step` is a WRAPPER holding [-][n][+]) and again, appended later, for
   the buyer's order sheet (js/components/product-card.js, where `.os-step` is a
   46x42 BUTTON). The later block won, every stepper was crushed to 46px, and its
   contents spilled 8.7px into the neighbouring cell — eight cells out of eight.
 
   The buyer sheet's four colliding names were renamed to `.bs-*`. This gate is
   what stops the next person appending into the same namespace, which this repo
   has now done twice (see the CR-0004 and CV-01 comments in the stylesheet).
 
   Asserts by BEHAVIOUR, not by name: (A) the two blocks' selector sets are
   disjoint, and (B) in a real browser, no stepper's content is wider than the
   box it is given.
 
   RED-PROVED three ways — see GATE-EVIDENCE.md.
*/
import fs from "node:fs";
import { chromium } from "playwright";

const CSS = fs.readFileSync(new URL("../css/components.css", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✓ " + m); pass++; };
const bad = (m) => { console.log("  ✗ " + m); fail++; };

/* ---- A. the two blocks own disjoint selector sets ---- */
const lines = CSS.split("\n");
const startOf = (needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`marker not found: ${needle}`);
  return i;
};
const packStart  = startOf("CR-0004: which photographs belong to a colour");
const buyerStart = startOf("CV-01: the buyer's order sheet");
const buyerEnd   = startOf("CR-0006: where is this stock?");
if (!(packStart < buyerStart && buyerStart < buyerEnd)) throw new Error("block markers out of order");

const classesIn = (from, to) =>
  new Set((lines.slice(from, to).join("\n").match(/\.[a-z][a-z0-9-]*/g) || []).map((s) => s.slice(1)));

const packNames  = classesIn(0, buyerStart);          // everything the pack builder can see
const buyerNames = classesIn(buyerStart, buyerEnd);   // the buyer's order sheet only
const shared = [...buyerNames].filter((n) => packNames.has(n) && /^(os|bs)-/.test(n));

shared.length === 0
  ? ok(`the buyer's order sheet shares no os-/bs- selector with anything defined above it (checked ${buyerNames.size} names)`)
  : bad(`SHARED SELECTORS — the collision is back: ${shared.join(", ")}`);

/* ---- B. in a real browser, a stepper's content fits the box it is given ---- */
const TOKENS = `:root{--text-tertiary:#61727C;--accent-500:#00A576;--border-default:#c9d3cf;
  --bg-sunken:#f2f5f4;--bg-surface:#fff;--border-subtle:#e3e9e6;--text-primary:#10201b;
  --text-secondary:#41524b;--bg-surface-2:#f7faf9;--accent-50:#EFFBF5;--radius-md:8px;
  --space-3:10px;--warning-700:#8A5210;--accent-700:#00543a;--accent-100:#cfeee1;--warning-500:#b8791f;}`;
const SIZES = ["36","37","38","39","40","41","42","43","44","45"];   // 10 — the case Hadi named
const page_html = `<style>${TOKENS}\n${CSS}</style><div class="os-steprow">` +
  SIZES.map((s) => `<div class="os-stepcell"><div class="os-steplbl">${s}</div>` +
    `<div class="os-step"><button>−</button><span class="os-stepn">4</span><button>+</button></div></div>`).join("") +
  `</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.setContent(page_html);
const spill = await page.evaluate(() => {
  const R = (e) => e.getBoundingClientRect();
  return [...document.querySelectorAll(".os-step")].map((s) => {
    const kids = [...s.children].map(R);
    return +(Math.max(...kids.map((k) => k.right)) - R(s).right).toFixed(1);
  });
});
await browser.close();

const spilling = spill.filter((v) => v > 0.5);
spilling.length === 0
  ? ok(`all ${SIZES.length} steppers contain their own contents (worst overhang ${Math.max(...spill).toFixed(1)}px)`)
  : bad(`${spilling.length}/${SIZES.length} steppers spill past their own box — worst ${Math.max(...spilling)}px. This is the overlap Hadi reported.`);

console.log("-".repeat(64));
console.log(fail === 0 ? ` ✓ PASS — all ${pass} assertions held.` : ` ✗ FAIL — ${fail} of ${pass + fail} assertions broke.`);
process.exit(fail === 0 ? 1 - 1 : 1);
