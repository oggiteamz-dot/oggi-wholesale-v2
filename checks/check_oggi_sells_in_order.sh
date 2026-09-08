#!/usr/bin/env bash
# ============================================================================
# check_oggi_sells_in_order.sh — OWN-07, 8 Sep 2026
#
# WHAT THIS GATE IS FOR
#
# js/views/ranking-policy.js is a page every wholesaler on the platform can
# read. Until 8 Sep 2026 it said, in bold:
#
#   "OGGI does not sell any products on this platform."
#
# Hadi, 8 Sep 2026: "we do sell" -- and, separately, that this page should not
# disclose it. Both of those are his to decide, and the section was REMOVED
# rather than rewritten: the page now says nothing on the subject.
#
#   ⭐ SILENCE IS ALLOWED. THE CONTRADICTION IS NOT.
#
# A page that declines to answer a question has declined to answer it. A page
# that goes on ASSERTING that OGGI sells nothing, while a first-party store is
# selling in the ordinary results, is a false statement in writing to the
# suppliers it was written to reassure. This gate exists so the second one
# cannot come back -- by a revert, by a merge that resurrects the paragraph, or
# by somebody restoring "the old wording" a year from now without knowing what
# it now contradicts.
#
# ==== WHY THIS IS NOT A CODE CHECK AND NOT A DATABASE CHECK =================
#
# It is both, and that is the point. The page lives in the repo; the mark lives
# in the database; the thing that must never be true is a COMBINATION of the
# two. No gate that reads only one of them can see it, which is exactly how a
# contradiction like this survives -- two people each doing something
# reasonable, a week apart, neither able to see the other half.
#
# ==== IT IS MEANINGFUL BEFORE THE COLUMN EXISTS =============================
#
# Written to tolerate is_first_party being absent: no column means no marked
# store means nothing to contradict. So it is honest on any database, including
# one replayed from before migration 130 -- rather than erroring and being
# quietly excluded from the suite, which is how a gate stops being run.
#
# USAGE
#   PGHOST=/var/run/postgresql PGPORT=5432 bash checks/check_oggi_sells_in_order.sh <database>
#   bash checks/check_oggi_sells_in_order.sh --page-only     # no database needed
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGE="$ROOT/js/views/ranking-policy.js"
PGHOST="${PGHOST:-/var/run/postgresql}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
DB="${1:-}"

fail=0
say()  { printf '  %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }
good() { printf '  ✓ %s\n' "$1"; }

echo "== check_oggi_sells_in_order"

# ---------------------------------------------------------------- the page --
# Comments are stripped first. Section 4's header comment QUOTES the sentence
# the page used to carry, because the record of what changed is the most
# valuable thing in that file -- and a grep over raw source would read that
# quotation as the page still making the claim. Same trap check_join_screen.mjs
# and check_ranking_policy.mjs both hit this week; same resolution.
PROSE="$(sed -e 's://.*::' "$PAGE" | tr '\n' ' ')"

if grep -qi 'does not sell any products' <<<"$PROSE"; then
  PAGE_SAYS="denies"
elif grep -qi 'OGGI sells on this platform' <<<"$PROSE"; then
  PAGE_SAYS="admits"
else
  PAGE_SAYS="silent"
fi

case "$PAGE_SAYS" in
  silent) good "the page makes no claim about whether OGGI sells — declining to answer is a choice that is available" ;;
  admits) good "the page tells wholesalers that OGGI sells here" ;;
  denies) say  "⚠ the page asserts that OGGI sells nothing here" ;;
esac

# The other half of the old paragraph. It promised own-brand products would
# appear "never inside the ordinary results" -- which is precisely where Hadi
# has put them. Left standing it is the same false statement wearing a
# different sentence, so it is checked separately rather than assumed to have
# left with the first one.
if grep -qi 'never inside the ordinary results' <<<"$PROSE"; then
  bad "the page still promises own-brand products stay OUT of the ordinary results, which is exactly where they are going"
fi

# ------------------------------------------------------------ the database --
if [ -z "$DB" ] || [ "$DB" = "--page-only" ]; then
  say "(no database given — page half only)"
  [ "$fail" = 0 ] && { echo "  PASS"; exit 0; } || { echo "  FAIL"; exit 1; }
fi

q() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DB" -tAqc "$1" 2>/dev/null; }

if ! q "select 1" | grep -q 1; then
  # A gate that cannot reach its database is RED, never silent. That is rule 2
  # of checks/run_sql_gates.sh, learned on 7 Sep when a whole suite reported
  # green against a database that had been dropped.
  bad "could not reach database '$DB' on $PGHOST:$PGPORT — a gate that cannot ask its question has not answered it"
  echo "  FAIL"; exit 1
fi

HAS_COL="$(q "select count(*) from information_schema.columns where table_schema='wholesale_v2' and table_name='v2_wholesalers' and column_name='is_first_party'")"

if [ "${HAS_COL:-0}" = "0" ]; then
  good "no is_first_party column yet, so no store can be marked and the order cannot have been broken"
  MARKED=0; MARKED_PUBLIC=0
else
  MARKED="$(q "select count(*) from wholesale_v2.v2_wholesalers where is_first_party")"
  MARKED_PUBLIC="$(q "select count(*) from wholesale_v2.v2_products p
                       join wholesale_v2.v2_wholesalers w on w.wid = p.wid
                      where w.is_first_party and p.is_public and not p.archived")"
  say "marked first-party: ${MARKED:-?}   public products in it: ${MARKED_PUBLIC:-?}"

  # At most one. The partial unique index makes a second impossible to store;
  # asserting it here too means a database that predates the index, or one
  # somebody rebuilt by hand, still gets caught.
  if [ "${MARKED:-0}" -gt 1 ]; then
    bad "$MARKED stores are marked first-party — \"OGGI's own\" has stopped naming one thing"
  fi
fi

# ---------------------------------------------------------- ⭐ THE ORDER ----
if [ "${MARKED_PUBLIC:-0}" -gt 0 ] && [ "$PAGE_SAYS" = "denies" ]; then
  bad "⭐ THE CONTRADICTION IS LIVE: a first-party store is selling $MARKED_PUBLIC public product(s) while the ranking policy page tells every wholesaler that OGGI sells nothing here. That is a false statement in writing to your suppliers. Remove the sentence — the page is allowed to say nothing, it is not allowed to say the opposite."
elif [ "$PAGE_SAYS" = "denies" ]; then
  bad "⭐ the page asserts OGGI sells nothing. Nothing is marked yet so it is not false TODAY, but the sentence is a trap primed to go off the moment a store is marked — and whoever marks it will not be reading this file. Remove it now."
elif [ "${MARKED_PUBLIC:-0}" -gt 0 ]; then
  good "⭐ a first-party store is selling and the page does not contradict it"
else
  good "⭐ nothing is marked, and the page makes no claim that a marking would falsify"
fi

if [ "$fail" = 0 ]; then echo "  PASS"; exit 0; else echo "  FAIL"; exit 1; fi
