// check_shipped_csp.mjs -- asserts the CSP the BROWSER actually gets.
//
// Why this exists, stated plainly: on 18 Aug 2026 blob: was added to
// index.html's <meta> tag and to _headers, and the commit message said the
// two "must agree". They did. The policy still forbade blob: in the browser,
// because a THIRD copy lives in worker.js and `run_worker_first = true` makes
// that copy overwrite the header on every single request. Worse, a document
// under both a header policy and a meta policy is held to the INTERSECTION of
// them -- so the strictest copy wins no matter which one was edited. Every
// check that read a file passed. The feature was broken.
//
// The lesson is not "remember the third file". It is that a check which reads
// a source file is checking the author's intent, and intent is exactly the
// thing that was never in doubt. This one asks the deployment.
//
// Usage:  node checks/check_shipped_csp.mjs [base-url]
// Requires no dependencies -- plain fetch against the live Worker.

const BASE = process.argv[2] || "https://oggi-wholesale-v2.oggi-teamz.workers.dev";

let failures = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

// Parse "default-src 'self'; img-src 'self' blob:" into a Map of directive
// name -> array of sources.
function parseCsp(text) {
  const out = new Map();
  for (const part of String(text || "").split(";")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    out.set(bits[0].toLowerCase(), bits.slice(1));
  }
  return out;
}

const res = await fetch(`${BASE}/`, { redirect: "follow" });
const html = await res.text();

const headerCsp = res.headers.get("content-security-policy");
assert("the response carries a Content-Security-Policy header", !!headerCsp);

// The attribute value contains single quotes ("'self'"), so the delimiter has
// to be captured and matched against itself -- a [^"']+ class stops dead at
// the apostrophe in 'self' and silently returns a truncated policy, which
// reads on screen as "the directive is missing" and sends you looking for a
// bug in the page instead of in the regex.
const metaMatch = html.match(
  /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*\scontent=(["'])([\s\S]*?)\1/i
);
assert("index.html carries a <meta> Content-Security-Policy", !!metaMatch);

const header = parseCsp(headerCsp);
const meta = parseCsp(metaMatch && metaMatch[2]);

// The bug: blob: present in one copy and absent from the other. Assert it of
// BOTH, separately, so the failure names which copy is wrong rather than just
// reporting that they disagree.
assert(
  "the response HEADER's img-src allows blob:",
  (header.get("img-src") || []).includes("blob:"),
  `img-src was: ${(header.get("img-src") || []).join(" ") || "(directive absent)"}`
);
assert(
  "the META tag's img-src allows blob:",
  (meta.get("img-src") || []).includes("blob:"),
  `img-src was: ${(meta.get("img-src") || []).join(" ") || "(directive absent)"}`
);

// A page under two policies gets the intersection, so a directive that differs
// between them is a policy nobody wrote and nobody is reading. Compare every
// directive the two have in common, not just img-src -- the next drift will
// not be img-src.
const shared = [...header.keys()].filter((k) => meta.has(k));
for (const dir of shared) {
  const a = [...(header.get(dir) || [])].sort().join(" ");
  const b = [...(meta.get(dir) || [])].sort().join(" ");
  assert(
    `header and meta agree on ${dir}`,
    a === b,
    a === b ? "" : `header: ${a || "(empty)"}\n        meta:   ${b || "(empty)"}`
  );
}

// frame-ancestors is header-only by design (it is ignored in a meta tag), so
// its absence from the meta copy is correct and must not be read as drift.
assert(
  "frame-ancestors is set in the header (it is ignored in a meta tag)",
  (header.get("frame-ancestors") || []).includes("'none'"),
  `frame-ancestors was: ${(header.get("frame-ancestors") || []).join(" ") || "(directive absent)"}`
);

console.log(
  failures === 0
    ? `\nAll assertions passed against ${BASE}`
    : `\n${failures} assertion(s) FAILED against ${BASE}`
);
process.exit(failures === 0 ? 0 : 1);
