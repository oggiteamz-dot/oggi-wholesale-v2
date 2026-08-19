// check_cross_module_imports.mjs — catch a symbol USED from a sibling module
// but never IMPORTED.
//
// This exists because js/views/wholesaler.js called getProductForEdit() and
// updateProduct() while importing neither. Every other gate passed:
//   - `node --check` passes (it is not even a real ES-module parse).
//   - check_module_syntax.mjs passes, and is RIGHT to pass -- a free identifier
//     is not a syntax error and not a link error. ESM only rejects a named
//     import that the target does not export; it says nothing about a name you
//     forgot to import at all. That is a ReferenceError, and a ReferenceError
//     only exists at the instant the line runs -- i.e. when the user clicks the
//     button, in production, having shipped clean.
//
// So this gate closes the gap from the other side: it knows every name the
// project exports, and flags a call to one of those names from a file that
// neither imports nor declares it. Scoped to project-owned exports on purpose,
// so it cannot fire on globals, DOM APIs, or anything it does not own.
//
// Usage:  node checks/check_cross_module_imports.mjs

import { globSync, readFileSync } from "node:fs";

const files = globSync("js/**/*.js").sort();

// Strip comments and quoted strings so prose cannot look like a call site.
// Template literals are LEFT IN: `${fn(x)}` is real executable code.
function strip(src) {
  // Newlines are preserved through every replacement so reported line numbers
  // still point at the real line in the real file.
  const keepNl = (s) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepNl)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

// 1. What does the project export, and from where?
const exportedBy = new Map(); // name -> [file]
for (const f of files) {
  const src = strip(readFileSync(f, "utf8"));
  const re = /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    if (!exportedBy.has(m[1])) exportedBy.set(m[1], []);
    exportedBy.get(m[1]).push(f);
  }
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      if (!exportedBy.has(name)) exportedBy.set(name, []);
      exportedBy.get(name).push(f);
    }
  }
}

const problems = [];
let callSitesChecked = 0;

for (const f of files) {
  const src = strip(readFileSync(f, "utf8"));

  // 2. What does this file import?
  const imported = new Set();
  const imp = /import\s+([^;]*?)\s+from\s*["'][^"']*["']/g;
  let m;
  while ((m = imp.exec(src))) {
    const clause = m[1];
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) imported.add(name);
      }
    }
    const dflt = clause.replace(/\{[\s\S]*?\}/, "").replace(/^\s*,|,\s*$/g, "").trim();
    if (dflt && /^[A-Za-z_$][\w$]*$/.test(dflt)) imported.add(dflt);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) imported.add(ns[1]);
  }

  // 3. What does this file declare itself? (over-broad on purpose -- a name
  //    bound ANYWHERE in the file is treated as available, so this gate can
  //    only ever under-report, never invent a failure.)
  const declared = new Set();
  const decl = /(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(src))) declared.add(m[1]);
  // destructuring + params + assignment targets
  const loose = /(?:\{|\(|,|^)\s*([A-Za-z_$][\w$]*)\s*(?:[,}=)]|:)/gm;
  while ((m = loose.exec(src))) declared.add(m[1]);

  // 4. Every call site of a name this project exports from SOMEWHERE ELSE.
  const call = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const flagged = new Set();
  while ((m = call.exec(src))) {
    const name = m[1];
    if (!exportedBy.has(name)) continue;
    const owners = exportedBy.get(name).filter((o) => o !== f);
    if (!owners.length) continue;          // exported by this very file
    callSitesChecked++;
    if (imported.has(name) || declared.has(name)) continue;
    // a method call (obj.name(...)) is not a free identifier
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    if (/[.?]$/.test(before.trim())) continue;
    if (flagged.has(name)) continue;
    flagged.add(name);
    const line = src.slice(0, m.index).split("\n").length;
    problems.push(`${f}:${line} calls ${name}() — exported by ${owners.join(", ")} — never imported here`);
  }
}

console.log(`  ${files.length} modules, ${exportedBy.size} project exports, ${callSitesChecked} cross-module call sites checked`);

if (problems.length) {
  console.log(`\n  ✗ ${problems.length} call(s) to a project export that is not in scope:`);
  problems.forEach((p) => console.log(`      ${p}`));
  console.log("\n ✗ FAIL — this throws ReferenceError the moment the user clicks it.");
  process.exit(1);
}

console.log("  ✓ every cross-module call has a matching import");
console.log("\n ✓ PASS");
