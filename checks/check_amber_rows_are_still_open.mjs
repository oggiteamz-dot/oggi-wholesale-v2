// =============================================================================
// CHECK: an OPEN defect in the manifest is still open          Block 8, 12 Sep
// =============================================================================
// WHAT THIS EXISTS FOR, IN ONE SENTENCE: on 12 September 2026 the two most
// alarming rows in FEATURE-MANIFEST.md were both describing defects that had
// been fixed weeks earlier, and nothing in this repository could tell.
//
// Row 465 read "⚠️ OPEN, AND IT IS MONEY -- the same buyer is charged two
// prices for the same shirt depending on which door they used", with 326
// disagreeing pairs measured on production. Migration 122 closed it on 7 Sep,
// on Hadi's own instruction, quoted in that migration's header.
//
// Row 466 read "⚠️ OPEN -- the store pricing dial is bounded by nothing",
// warning that one keypress could price every order in a store at 500%.
// Migration 123 bounded it the same day.
//
// Both were read as live. A night's work was started against row 466 before
// anybody checked production and found the constraint already there, valid,
// and doing its job.
//
// WHY check_manifest_is_honest.mjs COULD NOT SEE IT. That gate is a good gate
// and it checks three real things: every check the manifest names exists,
// every check that exists is named, and the summary counts add up. Row 466
// passed all three. It named a file that exists, was counted correctly in the
// ⚠️ tally, and the date at the top was fresh. What it got wrong was the only
// thing nobody was checking -- whether the sentence was TRUE.
//
// ⭐ THE RULE THIS FILE ENFORCES, AND WHY IT IS MECHANICAL RATHER THAN CLEVER
//
// A ⚠️ row cannot be checked by reading its prose. But this repo already has
// a convention that makes the common case decidable. When a migration closes
// a defect, the assertion that recorded the defect is INVERTED rather than
// deleted -- "turned around rather than deleted" -- and the inverted assertion
// is marked with ↺ and names the migration that did it. That convention is why
// reinstating the old behaviour turns a gate red from either direction.
//
// So:
//
//     IF a ⚠️ row cites assertion N of some gate as its evidence,
//     AND assertion N of that gate carries ↺ (it has been inverted),
//     THEN the row is citing, as proof that a defect is open, the very
//          assertion that now proves it is closed. That is a contradiction
//          the repository can detect, and this file fails on it.
//
// It catches exactly the two rows above, and it would have caught them on the
// day migration 122 landed rather than five days later.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM. It cannot verify a ⚠️ row that cites
// no gate at all -- 21 of the 23 amber rows say "*(no assertion yet)*" or
// "⚠️ none", which is what amber usually means, and an unproven feature is a
// different problem from a stale claim. This file makes no statement about
// those. It closes one hole precisely rather than pretending to close all of
// them, and says so here so the next reader does not mistake a green run for
// "every open row was re-verified".
//
//   node checks/check_amber_rows_are_still_open.mjs
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS = join(ROOT, "checks");

let PASS = 0;
const FAILURES = [];
const ok = (cond, msg) => (cond ? PASS++ : FAILURES.push(msg));

// This file is exempt from its own scan, and the reason is not politeness.
// Every paragraph above contains ↺ while explaining what ↺ means, and the
// worked examples quote row numbers 465 and 466. A gate that can be turned red
// by its own explanation is a gate whose author will eventually stop explaining
// things, which is a worse outcome than the false positive.
const SELF = "check_amber_rows_are_still_open.mjs";

// ---------------------------------------------------------------- the inputs --
const manifest = readFileSync(join(ROOT, "FEATURE-MANIFEST.md"), "utf8");

/** Every gate file, mapped to the set of assertion numbers marked inverted.
 *  An inverted assertion looks like `-- 15. ↺ THE TWO DOORS, INVERTED (122).`
 *  in SQL or `// 4. ↺ ...` in JS. A file-level ↺ banner with no assertion
 *  number is recorded separately: it means the file moved with a migration,
 *  not that one numbered row flipped, and it is too coarse to fail on. */
function invertedAssertions() {
  const out = new Map();
  for (const name of readdirSync(CHECKS)) {
    if (name === SELF) continue;
    const p = join(CHECKS, name);
    if (!statSync(p).isFile()) continue;
    let text;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    if (!text.includes("↺")) continue;

    const numbered = new Set();
    let fileLevel = false;
    for (const line of text.split("\n")) {
      if (!line.includes("↺")) continue;
      const m = line.match(/(?:--|\/\/)\s*(\d+[a-z]?)\.\s*↺/);
      if (m) numbered.add(m[1]);
      else fileLevel = true;
    }
    out.set(name, { numbered, fileLevel });
  }
  return out;
}

/** The numbered rows of the manifest table, with their verdict. */
function manifestRows() {
  return [...manifest.matchAll(/^\|\s*(\d+)\s*\|(.*)\|\s*(✅|⚠️|❌)\s*\|\s*$/gm)]
    .map((m) => ({ num: m[1], body: m[2], verdict: m[3] }));
}

// ============================================================== THE ASSERTIONS ==
const inverted = invertedAssertions();
const rows = manifestRows();
const amber = rows.filter((r) => r.verdict === "⚠️");

// --- 1. the convention this whole file rests on still exists -------------------
// If somebody stops marking inversions with ↺, every assertion below silently
// starts passing for the wrong reason -- the exact failure mode this repo's
// README describes (seven green while the function crashed on every call). So
// the first thing asserted is that the marker is still in use at all.
ok(inverted.size > 0,
   "no gate in checks/ carries a ↺ inversion marker any more — either the " +
   "convention was abandoned or the markers were stripped, and if so every " +
   "assertion in this file is now green for no reason");

// --- 2. there are amber rows to check ------------------------------------------
// A manifest with no ⚠️ rows would make this file vacuously green. That is a
// legitimate state one day, but it should be a visible one, not a silent one.
ok(amber.length > 0,
   "FEATURE-MANIFEST.md has no ⚠️ rows at all — this check is now vacuous and " +
   "should be read, not trusted");

// --- 3. ⭐ THE RULE --------------------------------------------------------------
// No open row may rest on an assertion that has been turned around.
for (const row of amber) {
  for (const [gate, { numbered }] of inverted) {
    if (!row.body.includes(gate)) continue;
    if (numbered.size === 0) continue;

    // Which assertions does the row lean on? Written in the manifest as
    // "assertions 15 and 15b" or "assertion 17".
    const cited = new Set();
    for (const m of row.body.matchAll(/assertions?\s+([0-9a-z]+(?:\s*(?:,|and)\s*[0-9a-z]+)*)/gi)) {
      for (const piece of m[1].split(/\s*(?:,|and)\s*/)) {
        if (/^\d+[a-z]?$/.test(piece)) cited.add(piece);
      }
    }

    // A cited assertion counts as inverted if it, or the numbered assertion it
    // hangs off (15b hangs off 15), has been turned around.
    const clash = [...cited].filter(
      (c) => numbered.has(c) || numbered.has(c.replace(/[a-z]$/, ""))
    );

    ok(clash.length === 0,
       `manifest row ${row.num} is still marked ⚠️ OPEN and cites ` +
       `${gate} assertion${clash.length > 1 ? "s" : ""} ${clash.join(", ")} as its evidence — ` +
       `but ${clash.length > 1 ? "those assertions have" : "that assertion has"} been INVERTED (↺), ` +
       `which means ${clash.length > 1 ? "they now prove" : "it now proves"} the defect is CLOSED. ` +
       `Either the row should be resolved, or the ↺ is wrong. It cannot be both.`);
  }
}

// --- 4. the reverse direction, so this cannot be satisfied by deleting rows -----
// The cheapest way to make assertion 3 pass forever is to stop citing gates in
// amber rows at all. That would be a regression dressed as a fix: the citation
// is what makes a claim checkable. So at least one amber row must still name a
// real gate file — and when none do, that is worth seeing rather than passing.
const amberCiting = amber.filter((r) => /check_[a-z0-9_]+\.(sql|mjs|sh)/.test(r.body));
ok(amberCiting.length > 0 || amber.length === 0,
   `${amber.length} amber rows and not one of them cites a gate file — the ` +
   "citations that make an open claim checkable have been removed, which " +
   "makes assertion 3 above unfalsifiable");

// ==================================================================== report ==
const width = 78;
console.log("=".repeat(width));
console.log("an OPEN defect in the manifest is still open");
console.log("=".repeat(width));
console.log(`  gates carrying ↺ : ${[...inverted.keys()].join(", ") || "(none)"}`);
console.log(`  ⚠️ rows examined : ${amber.length} (${amberCiting.length} cite a gate)`);
console.log("-".repeat(width));
for (const f of FAILURES) console.log("  FAIL  " + f);
console.log("-".repeat(width));
console.log(`  ${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) process.exit(1);
console.log("  OK — no open row rests on an assertion that says it is closed.");
