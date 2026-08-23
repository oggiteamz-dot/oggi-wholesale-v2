// =============================================================================
// CHECK: every CSS rule we wrote is a rule the browser actually has  (Batch 8F)
// =============================================================================
// Hadi sent a screenshot on 23 August: the packs drawer floating in the middle
// of the page, unpinned, with the backdrop covering only part of the screen.
//
// The cause was ONE CHARACTER.
//
// css/components.css carried a stray `}` after @keyframes oggi-glow. It had
// been there harmlessly for as long as it was the LAST thing in the file --
// there was nothing after it to damage. Then Batch 8C appended the drawer
// rules, and CSS error recovery did what the spec says it must: on an
// unexpected `}` the parser discards the construct it is in and resumes at the
// next one. The construct it discarded was
//
//     .pdrawer-root { position: fixed; inset: 0; z-index: 1200; }
//
// Exactly one rule. `.pdrawer-backdrop` and everything after it parsed
// perfectly, so the drawer LOOKED built -- it simply had no element pinned to
// the viewport to live inside, and fell back into normal document flow.
//
// WHY NOTHING CAUGHT IT
// ---------------------
//   * The file is valid enough to serve: 200 OK, right bytes, right length.
//   * check_token_completeness.mjs reads every var(--token) and was green --
//     it checks tokens, not structure.
//   * The rule is present in the FILE. Any check that greps the source finds
//     it and passes. Only the browser's own parser knows it was thrown away.
//   * No console error. No warning. CSS never reports this.
//
// I lost roughly an hour to caching theories -- service worker, Cloudflare,
// stale-while-revalidate -- because a stale stylesheet and a silently dropped
// rule look identical from the outside. They are not the same thing, and this
// file exists so the difference is one command instead of an hour.
//
// WHAT IT ASSERTS
// ---------------
//   1. Brace balance, per file. Cheap, exact, and would have caught this on
//      the day the stray `}` was introduced rather than months later.
//   2. THE REAL PARSER. Every stylesheet is loaded in real Chromium and the
//      count of rules the browser kept is compared against the count we wrote.
//      A rule that is in the file and not in document.styleSheets is a rule
//      that was eaten, whatever the reason -- this does not depend on knowing
//      that braces were the cause.
//   3. Named load-bearing selectors must survive. A drawer that is not
//      position:fixed is not a drawer.
//
//   node checks/check_css_parses.mjs
// =============================================================================
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const CSS_DIR = join(process.cwd(), "css");
const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort();
ok(files.length > 0, `found ${files.length} stylesheets in css/`);

// ------------------------------------------------------- 1. brace balance --
const stripped = new Map();
for (const f of files) {
  const raw = readFileSync(join(CSS_DIR, f), "utf8");
  // Comments only. Braces inside string literals are not a thing this codebase
  // does, and pretending to tokenise CSS properly here would be its own bug.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  stripped.set(f, src);

  let depth = 0, wentNegative = false, negAt = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0 && !wentNegative) { wentNegative = true; negAt = i; }
    }
  }
  ok(!wentNegative,
     wentNegative
       ? `${f} has a stray "}" (first unmatched at character ${negAt}) — CSS error recovery will silently discard the rule that follows it`
       : `${f} braces balance, so no rule can be swallowed by recovery`);
  ok(depth === 0,
     depth === 0 ? `${f} closes every block it opens`
                 : `${f} ends ${depth > 0 ? depth + " block(s) OPEN" : "over-closed"} — everything after the imbalance is at risk`);
}

// ------------------------------------------- 2. what the browser KEPT -------
// The only authority on whether a rule exists is the engine that parsed it.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");

for (const f of files) {
  const raw = readFileSync(join(CSS_DIR, f), "utf8");
  const kept = await page.evaluate(async (text) => {
    const el = document.createElement("style");
    el.textContent = text;
    document.head.appendChild(el);
    const sheet = el.sheet;
    const sels = [];
    // selectorText FIRST, then recurse. CSS Nesting means a plain CSSStyleRule
    // now HAS a (usually empty) .cssRules, so an `if (r.cssRules) recurse;
    // continue;` walker skips every real rule and silently collects nothing --
    // which is what the first version of this file did, reporting "0 survived"
    // for all eight stylesheets. A checker that returns zero for everything is
    // not a finding, it is a broken checker.
    const walk = (list) => { for (const r of list) {
      if (r.selectorText) sels.push(r.selectorText);
      if (r.cssRules && r.cssRules.length) walk(r.cssRules);
    } };
    walk(sheet.cssRules);
    const n = sheet.cssRules.length;
    el.remove();
    return { top: n, selectors: sels };
  }, raw);

  // Count the selectors we WROTE: a line starting a block that is not an
  // at-rule. `}` is excluded from the first character on purpose -- without
  // that, this matched a closing brace and ran on to the next "{", so
  // fonts.css (two @font-face blocks and no style rules at all) was counted as
  // having two style rules and reported as losing both. An at-rule is not a
  // CSSStyleRule and correctly has no selectorText.
  const authored = (stripped.get(f).match(/^[^@}\s][^{}]*\{/gm) || []).length;
  const keptSel = kept.selectors.length;
  ok(keptSel >= authored,
     keptSel >= authored
       ? `${f}: the browser kept ${keptSel} style rules, at least the ${authored} written at top level`
       : `${f}: ${authored} style rules written, only ${keptSel} survived parsing — ${authored - keptSel} were silently discarded`);
}

// --------------------------------------- 3. the rules that must survive -----
// Named because losing any one of them breaks a screen in a way that looks
// like a layout bug rather than a missing rule.
const MUST = [
  [".pdrawer-root",     "the drawer's viewport anchor — without it the drawer falls into normal document flow, which is exactly what happened"],
  [".pdrawer",          "the drawer panel itself"],
  [".pdrawer-backdrop", "the dimmed backdrop"],
  [".pdrawer-body",     "the drawer's internal scroller"],
  [".pf-selling-setup", "the Set ratios / Set prepacks panel at the foot of the product form"],
  [".pf-setup-warn",    "the warning that says buyers cannot order the product yet"],
];
const allKept = await page.evaluate(async (texts) => {
  const el = document.createElement("style");
  el.textContent = texts.join("\n");
  document.head.appendChild(el);
  const sels = [];
  const walk = (list) => { for (const r of list) {
    if (r.selectorText) sels.push(r.selectorText);
    if (r.cssRules && r.cssRules.length) walk(r.cssRules);
  } };
  walk(el.sheet.cssRules);
  el.remove();
  return sels;
}, files.map((f) => readFileSync(join(CSS_DIR, f), "utf8")));

for (const [sel, why] of MUST) {
  ok(allKept.some((s) => s.split(",").map((x) => x.trim()).includes(sel)),
     `${sel} survives parsing — ${why}`);
}

// And the property that matters, not merely the selector's existence.
const drawerFixed = await page.evaluate(async (texts) => {
  const el = document.createElement("style");
  el.textContent = texts.join("\n");
  document.head.appendChild(el);
  const d = document.createElement("div");
  d.className = "pdrawer-root";
  document.body.appendChild(d);
  const pos = getComputedStyle(d).position;
  d.remove(); el.remove();
  return pos;
}, files.map((f) => readFileSync(join(CSS_DIR, f), "utf8")));
ok(drawerFixed === "fixed",
   `an element with class "pdrawer-root" actually computes to position:fixed (got "${drawerFixed}") — the assertion the screenshot would have failed`);

await browser.close();

// ---------------------------------------------------------------- report ----
const line = "-".repeat(64);
console.log("\nEvery CSS rule we wrote is a rule the browser actually has\n" + line);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log(line);
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — all ${pass.length} assertions held.\n`);
