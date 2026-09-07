#!/usr/bin/env bash
# =============================================================================
# Run every SQL behaviour gate, and be honest about the ones it cannot read.
# =============================================================================
# WHY THIS EXISTS, AND IT IS NOT A TIDY-UP.
#
# There are 47 check_*.sql files. `checks/package.json` has had a runner for the
# .mjs gates since Batch 7 (`npm test`). The SQL gates have never had one: every
# file's header says "run this and every row must read PASS", and that is how
# they have been run -- one at a time, by hand, by whoever remembered.
#
# On 7 Sep 2026 that cost a false green, and this file is the fix.
#
# checks/replay_migrations.sh DROPS its scratch database at the end unless
# KEEP_DB=1 (its own comment explains why that flag exists -- the same mistake,
# made by hand, in August). A sweep written inline that evening ran the whole
# suite against a database that had just been dropped. psql prints
#
#     psql: error: connection to server ... FATAL: database "oggi_final" does not exist
#
# and the ad-hoc detector was grepping for `ERROR:` and `|FAIL`. "FATAL" is
# neither. Every one of the 47 files produced no matching line, so every one of
# them counted as GREEN, and "47/47 SQL gates green on a clean replay" was
# reported to Hadi and written into a merged PR description.
#
# Nothing was actually broken -- re-running it properly found the suite in the
# state described below -- but the number was not measured. That is the exact
# failure mode checks/GATE-EVIDENCE.md was opened for: a check that has never
# failed will eventually lie. A detector that has never been shown a red run is
# a check that has never failed.
#
# So this runner has three rules, and the third is the point:
#
#   1. It classifies on the failure signatures the gates THEMSELVES emit,
#      catalogued by running all 47 and reading the output, not guessed.
#   2. It treats "could not connect" and "database does not exist" as RED,
#      loudly, and never as silence.
#   3. A gate that honestly reports a MISSING FIXTURE is counted separately and
#      never as green -- nine of the 47 were written against production data and
#      prove nothing on an empty replay.
#   4. **A gate it cannot classify is RED.** Not green, not skipped. If a new
#      gate speaks a dialect this file does not know, the suite goes red and
#      somebody teaches it the dialect. The alternative is what happened above.
#
#   bash checks/run_sql_gates.sh <database>             # a replay, or production
#   bash checks/run_sql_gates.sh --self-test <database>
#
# Invoked with `bash`, not `./`, because every other script in this directory is
# committed non-executable (100644) and is run that way -- replay_migrations.sh
# included. This file was written 100755 out of habit; the mismatch showed up as
# a tree hash that differed from the repo while every blob matched, which is a
# better reason to notice it than tripping over "Permission denied" later.
#
# --self-test proves the runner can see a red: it runs a gate that must pass, a
# fabricated gate that must fail, and a database that does not exist, and
# refuses to report anything unless all three are classified correctly.
# =============================================================================
set -uo pipefail

PGHOST_="${PGHOST:-/tmp}"; PGPORT_="${PGPORT:-5433}"; PGUSER_="${PGUSER:-postgres}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SELFTEST=0
if [ "${1:-}" = "--self-test" ]; then SELFTEST=1; shift; fi
DB="${1:-}"
if [ -z "$DB" ]; then echo "usage: $0 [--self-test] <database>"; exit 2; fi

run_one() { psql "postgresql://$PGUSER_@/$1?host=$PGHOST_&port=$PGPORT_" \
              -v ON_ERROR_STOP=0 -f "$2" 2>&1; }

# --- the signatures, catalogued by running all 47 against a good database ----
# FAILURE first: a file that says both is failing.
# Anchored to psql's OWN connection-failure format. The first draft matched a
# bare "does not exist" anywhere in the output, and check_approval_grants_access
# asserts "...no membership was invented for a person who does not exist" -- so a
# PASSING gate read as unreachable. A detector's false positives are as
# dangerous as its false negatives: both end in a number nobody checked.
is_unreachable() {
  grep -qE '^psql: error: (connection|could not connect)' <<<"$1" && return 0
  grep -qE '^psql:.*FATAL: +database .* does not exist' <<<"$1" && return 0
  grep -qE 'Connection refused' <<<"$1" && return 0
  return 1
}

# THE GATE RAN AND HONESTLY SAID IT HAS NOTHING TO STAND ON.
# Nine of the 47 were written against PRODUCTION data -- they want wholesaler
# 'sq', or a product called "Boxy Cotton Tee", or simply "an active wholesaler
# to hang a fixture on". checks/seed.sql does not provide it (that seed is the
# WS-001 / Classic Tee fixture for the MOQ gate and nothing else). On an empty
# replay they refuse, by design and out loud.
#
# That is neither green nor red and must not be counted as either. Nothing was
# proven, so it cannot be green; nothing is broken, so calling it red would
# train people to ignore the red list -- which is how a suite stops being read.
# It is reported as its own category, with the names, every run.
is_needs_seed() {
  grep -qE 'SETUP:' <<<"$1" && return 0
  grep -qE 'fixture .*is missing' <<<"$1" && return 0
  grep -qE 'is not present in table' <<<"$1" && return 0
  grep -qE 'ERROR: +relation "[a-z_0-9]+" does not exist' <<<"$1" && return 0
  grep -qE 'no active wholesaler|no fixture|needs the fixture' <<<"$1" && return 0
  # ⚠ THE GRANT DRIFT, expressing itself as a gate that cannot run.
  # Two gates `set role authenticated` and then read a table directly. On
  # PRODUCTION that works, because `authenticated` holds SELECT on nearly every
  # table in wholesale_v2 -- a blanket grant that is in no migration in this
  # repo. On a replay it is absent, so the gate stops with "permission denied".
  # That is not the gate failing and it is not seed data: it is the repo being
  # unable to reproduce production's privileges, which is recorded in
  # GATE-EVIDENCE.md as an open finding. Counted here, never as green, so the
  # number of gates a replay can actually prove stays honest.
  grep -qE 'ERROR: +permission denied for (table|view|relation)' <<<"$1" && return 0
  # A function that falls over on an empty corpus rather than saying so.
  grep -qE 'invalid input syntax for type json' <<<"$1" && return 0
  return 1
}
is_failing() {
  grep -qE '\| FAIL$|\|FAIL$' <<<"$1" && return 0        # verdict-table style
  grep -qE 'WARNING: +FAIL'   <<<"$1" && return 0        # raise-warning style
  grep -qE 'FAILED \(|FAILED with' <<<"$1" && return 0   # summary-exception style
  grep -qE 'failed: *[1-9]'   <<<"$1" && return 0        # "passed: 12  failed: 3"
  return 1
}
is_passing() {
  grep -qE '\| PASS$|\|PASS$'        <<<"$1" && return 0
  grep -qiE 'ALL ASSERTIONS HELD'    <<<"$1" && return 0
  grep -qE '[0-9]+ passed, 0 failed' <<<"$1" && return 0
  grep -qE 'failed: *0( |$)'         <<<"$1" && return 0
  grep -qE '[0-9]+/[0-9]+( [A-Z]+)* PASSED' <<<"$1" && return 0   # "4/4 PASSED", "11/11 ASSERTIONS PASSED"
  grep -qE 'NOTICE: +[a-z_0-9]+ ok:' <<<"$1" && return 0
  return 1
}

# Gates that say NOTHING on success -- they raise on failure and are otherwise
# silent. Each name is typed here on purpose: a new silent gate is RED until
# somebody adds it, which is the same allow-list discipline migration 124 uses
# for the anon grants. Verified silent on 7 Sep 2026 by reading their output.
SILENT_OK="
check_anon_grants.sql
check_attribute_normalisation.sql
"
is_known_silent() { grep -qx "  *$1" <<<"$(sed 's/^/  /' <<<"$SILENT_OK")" \
                 || grep -qx "$1" <<<"$SILENT_OK"; }

classify() { # $1 = output, $2 = basename ; echoes GREEN|SEED|RED:<why>
  local out="$1" base="$2"
  if is_unreachable "$out"; then echo "RED:cannot-run"; return; fi
  if is_failing    "$out"; then echo "RED:assertions-failed"; return; fi
  if is_passing    "$out"; then echo "GREEN"; return; fi
  if is_needs_seed "$out"; then echo "SEED"; return; fi
  if is_known_silent "$base" && ! grep -qE '^psql:.*: ERROR:' <<<"$out"; then
    echo "GREEN"; return; fi
  echo "RED:unclassified"
}

# ------------------------------------------------------------------ self-test
if [ "$SELFTEST" = "1" ]; then
  echo "== self-test: the runner must see a red before it may report a green"
  fails=0

  # (1) a gate that passes must classify GREEN
  probe="$ROOT/checks/check_movement_partitions.sql"
  v=$(classify "$(run_one "$DB" "$probe")" "check_movement_partitions.sql")
  [ "$v" = "GREEN" ] && echo "  ok  a passing gate reads GREEN" \
                     || { echo "  ✗  a passing gate read $v"; fails=$((fails+1)); }

  # (2) a gate that fails must classify RED -- fabricated, not a real one
  tmpf="$(mktemp /tmp/failing_gate_XXXX.sql)"
  cat > "$tmpf" <<'BAD'
begin;
do $$ begin raise exception 'check_fabricated FAILED (1 of 1 assertions)'; end $$;
rollback;
BAD
  v=$(classify "$(run_one "$DB" "$tmpf")" "$(basename "$tmpf")")
  [ "${v%%:*}" = "RED" ] && echo "  ok  a failing gate reads $v" \
                         || { echo "  ✗  a FAILING gate read $v"; fails=$((fails+1)); }
  rm -f "$tmpf"

  # (3) ⭐ THE ONE THAT WAS MISSED. A database that is not there must read RED.
  v=$(classify "$(run_one "oggi_no_such_database_$$" "$probe")" "check_movement_partitions.sql")
  [ "$v" = "RED:cannot-run" ] && echo "  ok  a missing database reads RED:cannot-run" \
     || { echo "  ✗  a MISSING DATABASE read $v -- this is the 7 Sep false green"; fails=$((fails+1)); }

  # (4) a dialect it does not know must read RED, never green
  tmpf="$(mktemp /tmp/silent_gate_XXXX.sql)"
  echo "select 1;" > "$tmpf"
  v=$(classify "$(run_one "$DB" "$tmpf")" "$(basename "$tmpf")")
  [ "$v" = "RED:unclassified" ] && echo "  ok  an unrecognised gate reads RED:unclassified" \
     || { echo "  ✗  an unrecognised gate read $v"; fails=$((fails+1)); }
  rm -f "$tmpf"

  if [ "$fails" -gt 0 ]; then
    echo "== SELF-TEST FAILED ($fails). The runner cannot be trusted; not running the suite."
    exit 2
  fi
  echo "== self-test passed -- the runner can see all four outcomes"
  echo
fi

# ----------------------------------------------------------------- the suite
green=0; redlist=""; seedlist=""
for f in "$ROOT"/checks/check_*.sql; do
  base="$(basename "$f")"
  v=$(classify "$(run_one "$DB" "$f")" "$base")
  case "$v" in
    GREEN) green=$((green+1)) ;;
    SEED)  seedlist="$seedlist $base" ;;
    *)     redlist="$redlist $base=${v#RED:}" ;;
  esac
done

total=$(ls "$ROOT"/checks/check_*.sql | wc -l | tr -d ' ')
nseed=$(wc -w <<<"$seedlist" | tr -d ' ')
red=$((total - green - nseed))
echo "== SQL gates on $DB"
echo "   $green proved, $red red, $nseed could not run for want of seed data, of $total"
for r in $redlist;  do echo "   RED   ${r%%=*}  (${r#*=})"; done
for s in $seedlist; do echo "   SEED  $s"; done
[ "$nseed" -eq 0 ] || echo "   (SEED = the gate ran and honestly said it has no fixture, or needs a grant"
[ "$nseed" -eq 0 ] || echo "    this repo cannot reproduce. Nothing was proven and nothing is broken.)"
[ "$red" -eq 0 ] || exit 1
