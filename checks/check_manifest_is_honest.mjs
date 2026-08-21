// =============================================================================
// CHECK: FEATURE-MANIFEST.md still describes this repository      (Batch 7)
// =============================================================================
// FEATURE-MANIFEST.md is the answer to "how do we never lose a feature again".
// On 21 August 2026 it was six days and seven batches out of date: it said
// "Last reconciled: 15 August", listed 32 features when there were 60, called
// stock transfers unproven when check_locations_transfer.mjs had existed for
// three days, and carried an action item about missing migration files that had
// been half-done and left.
//
// The reason is not carelessness. It is that NOTHING FAILED WHEN IT WENT STALE.
// Every other promise in this project is held by a check that goes red; this
// one was held by remembering. docs/OUTSTANDING.md drifted the same way, and its
// own opening line had already diagnosed it: "a thing agreed in conversation and
// not written down is a thing that quietly does not happen." A thing written
// down and never checked is the same thing one step later.
//
// So this file checks the document in BOTH directions:
//
//   * every check the manifest names must exist -- otherwise a row claims
//     proof that cannot be run;
//   * every check that exists must be named -- otherwise work has been done
//     that the manifest does not know about, which is exactly the state it was
//     found in;
//   * the reconciliation table must match the rows above it -- a summary that
//     disagrees with its own detail is worse than no summary.
//
//   node checks/check_manifest_is_honest.mjs
// =============================================================================
import { readdirSync, readFileSync } from "node:fs";

const manifest = readFileSync(new URL("../FEATURE-MANIFEST.md", import.meta.url), "utf8");
const checkFiles = readdirSync(new URL("./", import.meta.url))
  .filter((f) => /^check_/.test(f))
  .sort();

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ------------------------------------------------- 1. named -> must exist ----
const named = [...new Set(
  [...manifest.matchAll(/\bcheck_[a-z0-9_]+\.(?:mjs|sql|sh)\b/g)].map((m) => m[0])
)].sort();

ok(named.length > 0, `the manifest names ${named.length} distinct checks`);

const missing = named.filter((n) => !checkFiles.includes(n));
ok(missing.length === 0,
   missing.length
     ? `the manifest names checks that do not exist, so those rows claim proof nobody can run: ${missing.join(", ")}`
     : "every check the manifest names exists in checks/");

// ------------------------------------------------- 2. exists -> must be named --
// A check that exists and is not named is work the manifest does not know
// about. Two kinds are exempt, and being explicit about which is the point:
//   - this file, which checks the manifest rather than the product;
//   - preview/harness scripts, which render something for a human to look at
//     and assert nothing.
const EXEMPT = new Set(["check_manifest_is_honest.mjs"]);
const unnamed = checkFiles.filter((f) => !EXEMPT.has(f) && !named.includes(f));
ok(unnamed.length === 0,
   unnamed.length
     ? `checks exist that the manifest does not mention — add a row, or say in the manifest why not: ${unnamed.join(", ")}`
     : `every one of the ${checkFiles.length} checks in checks/ is accounted for in the manifest`);

// ------------------------------------------------ 3. the summary adds up ------
{
  // Feature rows are the numbered table rows: | 12 | Name | file | proof | ✅ |
  const rows = [...manifest.matchAll(/^\|\s*(\d+)\s*\|.*\|\s*(✅|⚠️|❌)\s*\|\s*$/gm)];
  const ids = rows.map((r) => parseInt(r[1], 10));
  const green = rows.filter((r) => r[2] === "✅").length;
  const amber = rows.filter((r) => r[2] === "⚠️").length;
  const red   = rows.filter((r) => r[2] === "❌").length;

  ok(rows.length > 0, `the manifest has ${rows.length} feature rows`);

  // Numbering must be 1..N with no repeats: a duplicated number is how two
  // features quietly become one when somebody counts.
  const expected = Array.from({ length: rows.length }, (_, i) => i + 1);
  ok(JSON.stringify(ids) === JSON.stringify(expected),
     JSON.stringify(ids) === JSON.stringify(expected)
       ? `feature rows are numbered 1–${rows.length} with no gaps or repeats`
       : `feature numbering is not 1–${rows.length}: got ${ids.join(",")}`);

  const stated = (label) => {
    const m = new RegExp(`\\|\\s*${label}[^|]*\\|\\s*\\*\\*(\\d+)\\*\\*\\s*\\|`).exec(manifest);
    return m ? parseInt(m[1], 10) : null;
  };
  const sTotal = stated("Features listed");
  const sGreen = stated("Enforced and proven");
  const sAmber = stated("Present but unproven");
  const sRed   = stated("Not built");

  ok(sTotal === rows.length, `the reconciliation says ${sTotal} features and the table has ${rows.length}`);
  ok(sGreen === green,       `it says ${sGreen} are gated and ${green} rows are ✅`);
  ok(sAmber === amber,       `it says ${sAmber} are ungated and ${amber} rows are ⚠️`);
  ok(sRed === red,           `it says ${sRed} are unbuilt and ${red} rows are ❌`);
  ok(green + amber + red === rows.length, "and every row carries exactly one status");
}

// ------------------------------------------------------ 4. it has a date ------
{
  const m = /\*\*Last reconciled:\s*([^*]+?)\*\*/.exec(manifest);
  ok(!!m, m ? `it records when it was last reconciled: ${m[1].trim()}` : "the manifest has no 'Last reconciled' line, so nobody can tell how old it is");
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
