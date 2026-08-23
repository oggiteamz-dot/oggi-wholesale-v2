// =============================================================================
// CHECK: nothing is used that was never declared      (Batch 8A, 23 Aug 2026)
// =============================================================================
//
// WHY THIS EXISTS — and it is worth reading, because a gate wrote it
// -----------------------------------------------------------------
// While fixing the catalog route, `router.go(...)` was added inside
// catalogsView() in js/views/wholesaler.js. That file did not import `router`.
//
// It went unnoticed because of a genuinely deceptive detail: the file DOES
// have a `router` in scope — as the PARAMETER of registerWholesalerRoutes(),
// at the very bottom:
//
//     export function registerWholesalerRoutes(router) { ... }
//
// So the name reads as familiar everywhere in the file, and it resolves for
// every use inside that one function. catalogsView() is not inside it, so at
// runtime the click handler would have thrown ReferenceError and the tab
// would simply have done nothing — the exact symptom this batch is fixing.
//
// AND check_route_state.mjs PASSED, all twenty assertions, with the code
// broken. It asked the router whether the paths resolved. They did. It never
// clicked anything. That is the "a gate that lies" failure this project keeps
// relearning, caught this time before the push instead of after.
//
// A missing import is caught by check_imports_resolve.sh. A missing import
// STATEMENT — using a name that was never imported at all — was caught by
// nothing. This file is that nothing.
//
// HOW IT WORKS
// ------------
// A real parse (acorn), a real scope walk. For every identifier that is READ,
// it asks whether any enclosing scope binds it — imports, declarations,
// function parameters, catch params, class names, labels. What is left is
// checked against an explicit list of the globals this app is allowed to use.
//
// The allowlist is EXPLICIT and deliberately not clever. A gate that guesses
// which globals are legitimate produces false alarms, and the standing lesson
// here is that a check which cries wolf gets switched off — which is worse
// than not having it. If this fails on a legitimate new global, add it to
// BROWSER_GLOBALS below, on purpose, in a commit that says so.
//
//   node checks/check_no_undeclared_identifiers.mjs
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let acorn;
try { acorn = require("acorn"); }
catch {
  console.log("✗ FAIL — acorn is not installed. Run `npm install` in checks/.");
  process.exit(1);
}

const ROOT = fileURLToPath(new URL("../js/", import.meta.url));

/** Globals this application is allowed to reach for without declaring.
 *  Standard library + the browser surface actually used. Anything not here
 *  is reported, on purpose. */
const BROWSER_GLOBALS = new Set([
  // language
  "undefined","NaN","Infinity","globalThis","Object","Array","String","Number","Boolean",
  "Symbol","BigInt","Math","JSON","Date","RegExp","Error","TypeError","RangeError",
  "SyntaxError","Promise","Map","Set","WeakMap","WeakSet","Proxy","Reflect","Intl",
  "parseInt","parseFloat","isNaN","isFinite","encodeURIComponent","decodeURIComponent",
  "encodeURI","decodeURI","structuredClone","queueMicrotask","AggregateError",
  "Uint8Array","Uint8ClampedArray","Uint16Array","Uint32Array","Int8Array","Int16Array",
  "Int32Array","Float32Array","Float64Array","ArrayBuffer","DataView",
  "CSS",
  // timers / microtasks
  "setTimeout","clearTimeout","setInterval","clearInterval","requestAnimationFrame",
  "cancelAnimationFrame","requestIdleCallback",
  // DOM + BOM
  "window","document","navigator","location","history","screen","console","alert",
  "customElements","getComputedStyle","matchMedia","scrollTo","open","close",
  "HTMLElement","HTMLInputElement","HTMLCanvasElement","HTMLImageElement","Element",
  "Node","NodeList","DocumentFragment","CustomEvent","Event","KeyboardEvent",
  "MouseEvent","PointerEvent","DragEvent","InputEvent","AbortController","AbortSignal",
  "MutationObserver","IntersectionObserver","ResizeObserver","DOMParser","XMLSerializer",
  // network / data
  "fetch","Headers","Request","Response","FormData","URL","URLSearchParams","Blob","File",
  "FileReader","Image","ImageData","OffscreenCanvas","createImageBitmap","atob","btoa",
  "TextEncoder","TextDecoder","crypto","localStorage","sessionStorage","indexedDB",
  "BarcodeDetector","MediaStream","caches","performance","Notification","Worker",
  // service worker scope (sw.js lives outside js/, but register-sw.js touches these)
  "ServiceWorker","ServiceWorkerRegistration","self",
  // third-party global, loaded from js/lib/vendor by index.html
  "supabase",
  // node, for the odd isomorphic guard
  "process",
]);

/** Real globals that this app is NOT allowed to use.
 *
 *  They exist, so a scope walk would happily let them through — which is why
 *  they are named here instead. Every one of them is a native browser dialog:
 *  unstyleable, untestable by any gate, page-thread-blocking, and on a phone
 *  a grey system sheet that reads as the browser asking rather than the app.
 *  Batch 8A replaced them with real in-app dialogs; this is what stops the
 *  eighteenth one being written next month. */
const BANNED_GLOBALS = new Map([
  ["prompt",  "a native prompt() — use an in-app dialog (see js/components/receive-dialog.js for the pattern)"],
  ["confirm", "a native confirm() — use an in-app dialog with a named action button, so the button says what it does"],
  ["alert",   "a native alert() — use toast() for information, or an in-app dialog if an answer is needed"],
]);

/** Every .js file under js/, except the vendored bundle — which is minified
 *  third-party code and would produce thousands of meaningless findings. */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "vendor") continue;
      jsFiles(full, out);
    } else if (name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---------------------------------------------------------------- scoping ---
// A scope is a Set of names it binds, plus a link to its parent.
const newScope = (parent = null) => ({ names: new Set(), parent });
const bind = (scope, name) => { if (name) scope.names.add(name); };
const resolves = (scope, name) => {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return false;
};

/** Bind every name a destructuring pattern introduces. */
function bindPattern(scope, node) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":       bind(scope, node.name); break;
    case "ObjectPattern":    node.properties.forEach((p) =>
                               bindPattern(scope, p.type === "RestElement" ? p.argument : p.value)); break;
    case "ArrayPattern":     node.elements.forEach((e) => bindPattern(scope, e)); break;
    case "AssignmentPattern":bindPattern(scope, node.left); break;
    case "RestElement":      bindPattern(scope, node.argument); break;
  }
}

const FUNCTIONS = new Set(["FunctionDeclaration","FunctionExpression","ArrowFunctionExpression"]);

/** Pre-bind everything a scope declares, before walking its body — so a
 *  function called above its own declaration is not reported. */
function hoist(scope, body) {
  for (const node of body || []) {
    if (!node) continue;
    if (node.type === "FunctionDeclaration") bind(scope, node.id?.name);
    else if (node.type === "ClassDeclaration") bind(scope, node.id?.name);
    else if (node.type === "VariableDeclaration") node.declarations.forEach((d) => bindPattern(scope, d.id));
    else if (node.type === "ImportDeclaration") node.specifiers.forEach((sp) => bind(scope, sp.local?.name));
    else if (node.type === "ExportNamedDeclaration" && node.declaration) hoist(scope, [node.declaration]);
    else if (node.type === "ExportDefaultDeclaration" && node.declaration?.id) bind(scope, node.declaration.id.name);
  }
}

const found  = [];   // used but never bound  -> a ReferenceError waiting to fire
const banned = [];   // a native browser dialog -> see BANNED_GLOBALS

function walk(node, scope, file, parentKey = null) {
  if (!node || typeof node.type !== "string") return;

  if (FUNCTIONS.has(node.type)) {
    const inner = newScope(scope);
    if (node.id?.name) bind(inner, node.id.name);
    node.params.forEach((p) => bindPattern(inner, p));
    bind(inner, "arguments");
    if (node.body.type === "BlockStatement") hoist(inner, node.body.body);
    walk(node.body, inner, file);
    return;
  }
  if (node.type === "BlockStatement") {
    const inner = newScope(scope);
    hoist(inner, node.body);
    node.body.forEach((n) => walk(n, inner, file));
    return;
  }
  if (node.type === "CatchClause") {
    const inner = newScope(scope);
    bindPattern(inner, node.param);
    hoist(inner, node.body.body);
    node.body.body.forEach((n) => walk(n, inner, file));
    return;
  }
  if (node.type === "ForStatement" || node.type === "ForOfStatement" || node.type === "ForInStatement") {
    const inner = newScope(scope);
    const init = node.init || node.left;
    if (init?.type === "VariableDeclaration") init.declarations.forEach((d) => bindPattern(inner, d.id));
    for (const k of ["init","left","test","update","right","body"]) if (node[k]) walk(node[k], inner, file);
    return;
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    const inner = newScope(scope);
    if (node.id?.name) bind(inner, node.id.name);
    walk(node.body, inner, file);
    return;
  }

  // `export { a, b } from "./x.js"` binds nothing locally and reads nothing
  // locally — the names are the OTHER module's exports. Walking into it
  // reported four perfectly correct re-exports in
  // js/data/inventory-intelligence.js as undeclared reads. A gate that cries
  // wolf gets switched off, so this is not a detail.
  if (node.type === "ExportNamedDeclaration" && node.source) return;
  if (node.type === "ExportAllDeclaration") return;
  if (node.type === "ImportDeclaration") return;

  if (node.type === "Identifier") {
    // Only READS count. A property name, a key, a label or a declaration site
    // is not a read of a variable.
    if (parentKey === "property" || parentKey === "key" || parentKey === "label") return;
    if (BANNED_GLOBALS.has(node.name) && !resolves(scope, node.name)) {
      banned.push({ file, name: node.name, line: node.loc?.start?.line });
      return;
    }
    if (!resolves(scope, node.name) && !BROWSER_GLOBALS.has(node.name)) {
      found.push({ file, name: node.name, line: node.loc?.start?.line });
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const val = node[key];
    // A non-computed member expression's `.property` is a name, not a variable.
    if (key === "property" && node.type === "MemberExpression" && !node.computed) continue;
    if (key === "key" && !node.computed) continue;
    if (Array.isArray(val)) val.forEach((v) => walk(v, scope, file, key));
    else if (val && typeof val.type === "string") walk(val, scope, file, key);
  }
}

// ------------------------------------------------------------------- run ----
const files = jsFiles(ROOT).sort();
ok(files.length > 50, `${files.length} source files parsed (a sudden drop here means the walk stopped finding them, not that the app shrank)`);

for (const file of files) {
  const src = readFileSync(file, "utf8");
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: "module", locations: true });
  } catch (e) {
    fail.push(`${relative(ROOT, file)} does not parse: ${e.message}`);
    continue;
  }
  const top = newScope(null);
  hoist(top, ast.body);
  ast.body.forEach((n) => walk(n, top, relative(ROOT, file)));
}

if (found.length === 0) {
  pass.push(`every identifier read in js/ resolves to an import, a declaration or a known global (${files.length} files) — a name used without being imported is a ReferenceError that only fires when someone clicks the thing`);
} else {
  const byFile = new Map();
  for (const f of found) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(`${f.name} (line ${f.line})`);
  }
  for (const [f, names] of byFile) {
    fail.push(`${f} reads names that are never bound: ${[...new Set(names)].join(", ")} — either the import is missing, or the name belongs in BROWSER_GLOBALS in this file`);
  }
}

if (banned.length === 0) {
  pass.push("no native prompt(), confirm() or alert() anywhere in js/ — every question the app asks is asked in the app's own dialog, which means it can be styled, used on a phone, and tested");
} else {
  const byFile = new Map();
  for (const b of banned) {
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file).push(`line ${b.line}: ${BANNED_GLOBALS.get(b.name)}`);
  }
  for (const [f, hits] of byFile) fail.push(`${f} still uses a native browser dialog — ${hits.join("; ")}`);
}

const line = "-".repeat(64);
console.log(line);
for (const p of pass) console.log(`  ✓ ${p}`);
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(line);
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`); process.exit(1); }
console.log(` ✓ PASS — all ${pass.length} assertions held.`);
