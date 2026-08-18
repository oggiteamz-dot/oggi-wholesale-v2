// check_module_syntax.mjs — parse every module the way the BROWSER parses it.
//
// This exists because `node --check` lied. It reported every file in js/ as
// syntactically fine while product-form.js was missing a closing brace, and the
// app was a blank white screen: `node --check` wraps the source in CommonJS's
// module wrapper, and an unbalanced brace inside that wrapper can still parse.
// A file can therefore pass `node --check` and be rejected outright by every
// browser, which is precisely the pair of outcomes a syntax gate exists to keep
// apart.
//
// Dynamic import is the honest test: it compiles the file as a real ES module,
// the same grammar the browser applies. Errors that are NOT syntax (a module
// touching window/document at top level, a missing browser global) are reported
// separately rather than failed on -- those are runtime facts about a browser
// module being loaded in Node, not defects.
//
// Usage:  node checks/check_module_syntax.mjs

import { globSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const files = globSync("js/**/*.js").sort();
const syntax = [];
const other = [];

for (const f of files) {
  try {
    await import(pathToFileURL(resolve(f)).href);
  } catch (err) {
    const msg = String(err?.message || err);
    if (err instanceof SyntaxError) syntax.push(`${f} :: ${msg}`);
    else other.push(`${f} :: ${err?.name || "Error"}: ${msg.slice(0, 90)}`);
  }
}

console.log(`  checked ${files.length} modules`);
if (other.length) {
  console.log(`  ${other.length} module(s) failed to EXECUTE in Node (not a syntax problem, not a failure):`);
  other.forEach((o) => console.log(`      ${o}`));
}

if (syntax.length) {
  console.log(`\n  ✗ ${syntax.length} module(s) will not PARSE in a browser:`);
  syntax.forEach((sx) => console.log(`      ${sx}`));
  console.log("\n ✗ FAIL — the app would be a blank screen.");
  process.exit(1);
}

console.log("  ✓ every module parses as a real ES module");
console.log("\n ✓ PASS");
