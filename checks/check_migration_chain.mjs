// =============================================================================
// CHECK: this repo can still rebuild the database                  (Batch 7)
// =============================================================================
// The standing complaint, written down since 11 Aug and repeated in
// FEATURE-MANIFEST.md: "the repo cannot currently rebuild the product."
// On 21 Aug it was measured rather than repeated. Replaying every migration
// into an empty Postgres 16 stopped FIVE separate times, each for a different
// reason, and none of them would have shown up in any other check:
//
//   1. THREE MIGRATION FILES DID NOT EXIST. 035, 036 and 038 were applied on
//      17 Aug and never committed. The manifest had already flagged the same
//      class of drift for 028/030/031/032 and asked for a back-fill; that
//      back-fill happened and these three were missed, so the gap persisted
//      with nothing saying so. Recovered verbatim from
//      supabase_migrations.schema_migrations.
//
//   2. v2 REACHES INTO v1 AND NO v2 MIGRATION SAYS SO. Ten foreign keys point
//      at public.wholesalers; migration 002 reads public.wholesale_state,
//      clients and reps. None of those are created anywhere in this repo,
//      because on the real database v1 got there first. Added as
//      000_v1_prerequisites.sql -- the minimum shape, `if not exists`, a no-op
//      on the real database.
//
//   3. THIRTEEN `comment on function NAME is` STATEMENTS HAD NO ARGUMENT LIST.
//      That only works while the name is unique. During a replay
//      v2_submit_order transiently has two overloads (migration 025 exists to
//      drop a stale one), so the chain aborted on a COMMENT.
//
//   4. UNQUALIFIED TYPE REFERENCES AFTER MIGRATION 026. A return type resolves
//      against the SESSION search_path at creation time, not the function's
//      own. 026 moved every v2 object into `wholesale_v2`; the Supabase SQL
//      editor has it on the path and `psql -f` does not, so 028 and 064 failed
//      with `type "v2_orders" does not exist`. The identical references in
//      001-024 are CORRECT unqualified -- they run before the move.
//
//   5. `create extension pg_cron` UNGUARDED. Migration 065's own header says
//      "if this file fails to apply, NOTHING breaks" -- and yet under
//      ON_ERROR_STOP it took every later migration down with it.
//
// After all five: 80 migrations applied clean, and the result matched
// production exactly -- tables 89, views 4, functions 91, policies 89.
//
// This file is the part of that which can be checked with no database at all,
// so it runs everywhere and every time. The full replay lives in
// checks/replay_migrations.sh, which needs a Postgres.
//
//   node checks/check_migration_chain.mjs
// =============================================================================
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../supabase/migrations/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// Strip comments so prose about a rule cannot be mistaken for the rule.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--[^\n]*$/gm, "");

const numOf = (f) => {
  const m = /^(\d+)/.exec(f);
  return m ? parseInt(m[1], 10) : null;
};

// ---------------------------------------------------------------- 1. gaps --
{
  const nums = [...new Set(files.map(numOf).filter((n) => n !== null))].sort((a, b) => a - b);
  const top = Math.max(...nums);
  const missing = [];
  for (let n = 1; n <= top; n++) if (!nums.includes(n)) missing.push(n);
  ok(missing.length === 0,
     missing.length
       ? `migration numbers ${missing.join(", ")} have no file — they are applied to the database and the repo cannot rebuild it without them`
       : `no gaps in the migration numbering (001–${String(top).padStart(3, "0")}, ${files.length} files)`);

  ok(files.some((f) => f.startsWith("000_")),
     "000_v1_prerequisites.sql exists — v2's ten foreign keys into v1's schema have somewhere to point on an empty database");
}

// ------------------------------------------- 2. unambiguous function comments --
{
  const offenders = [];
  for (const f of files) {
    const src = strip(readFileSync(new URL(f, DIR), "utf8"));
    // A real statement starts a line. Anything inside format('...') is a string.
    const re = /^\s*comment on function\s+([^\s(]+)\s+is\b/gim;
    let m;
    while ((m = re.exec(src))) offenders.push(`${f}: ${m[1]}`);
  }
  ok(offenders.length === 0,
     offenders.length
       ? `comment on function without an argument list, which aborts a replay the moment the name is overloaded: ${offenders.join("; ")}`
       : "every `comment on function` names its arguments, or resolves the oid at run time");
}

// --------------------------------------- 3. types qualified after migration 026 --
{
  // 026 moved every v2 object from `public` into `wholesale_v2`. Before it,
  // unqualified is right; after it, unqualified only works by luck of the
  // caller's search_path.
  const offenders = [];
  for (const f of files) {
    const n = numOf(f);
    if (n === null || n < 26) continue;
    const src = strip(readFileSync(new URL(f, DIR), "utf8"));
    // ONLY the two constructs that resolve at CREATION time. An unqualified
    // table name inside a function BODY is fine -- plpgsql resolves it when the
    // function runs, against the function's own `set search_path`. An earlier
    // draft of this check also matched those and reported six offenders while
    // the actual replay ran clean, which is the check lying, not the code.
    const re = /\breturns\s+(?:setof\s+)?(v2_\w+)\b|^\s*\w+\s+(v2_\w+)%rowtype/gim;
    let m;
    while ((m = re.exec(src))) offenders.push(`${f}: ${m[1] || m[2]}`);
  }
  ok(offenders.length === 0,
     offenders.length
       ? `unqualified v2 type reference in a migration after 026, which resolves against the RUNNER's search_path: ${offenders.slice(0, 6).join("; ")}`
       : "every type reference after migration 026 is schema-qualified, so the chain does not depend on who runs it");
}

// ------------------------------- 4. managed extensions cannot abort the chain --
{
  // pg_cron, pg_net and friends exist on Supabase and not in a plain Postgres.
  // A bare CREATE EXTENSION for one of them stops every later migration.
  const MANAGED = ["pg_cron", "pg_net", "pgsodium", "vault"];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, DIR), "utf8");
    const stripped = strip(src);
    for (const ext of MANAGED) {
      const re = new RegExp(`^\\s*create extension[^;]*\\b${ext}\\b`, "im");
      if (!re.test(stripped)) continue;
      // Guarded if it sits inside a DO block with its own exception handler.
      const guarded = /do \$[\w]*\$[\s\S]*?exception when others then[\s\S]*?\$[\w]*\$/i.test(stripped);
      if (!guarded) offenders.push(`${f}: ${ext}`);
    }
  }
  ok(offenders.length === 0,
     offenders.length
       ? `an unguarded CREATE EXTENSION for a Supabase-managed extension, which takes every later migration down with it: ${offenders.join("; ")}`
       : "every CREATE EXTENSION for a managed extension is guarded, so an environment without it degrades instead of stopping");
}

// ------------------------------------------- 5. the replay script still exists --
{
  const checks = readdirSync(new URL("./", import.meta.url));
  ok(checks.includes("replay_migrations.sh"),
     "checks/replay_migrations.sh exists — the offline rules above are necessary, not sufficient, and the real proof is an actual replay");
}

console.log(pass.map((m) => `  ✓ ${m}`).join("\n"));
if (fail.length) console.log(fail.map((m) => `  ✗ ${m}`).join("\n"));
console.log("----------------------------------------------------------------");
console.log(fail.length ? ` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.` : ` ✓ PASS — ${pass.length} assertions.`);
process.exit(fail.length ? 1 : 0);
