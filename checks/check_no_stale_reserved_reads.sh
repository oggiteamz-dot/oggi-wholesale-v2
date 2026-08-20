#!/usr/bin/env bash
# ============================================================================
# check_no_stale_reserved_reads.sh — regression guard for the 064 leak
#
# The reservation leak was not one bug in one place. It was the SAME line of
# arithmetic copied into five files:
#
#     available = qty_on_hand - qty_reserved
#
# ...where qty_reserved came from the v2_inventory_balances TABLE, whose
# counter is never filtered by expires_at. Fixing the five call sites without
# stopping the sixth from being written is not a fix, it is a delay.
#
# RULE: if a file reads qty_reserved, it must read it from
# v2_inventory_balances_live (or v2_live_holds), never from the table.
# Reading qty_on_hand from the table is fine -- on-hand is always truthful.
#
# Exit 1 on violation. Run from the repo root.
# ============================================================================
set -uo pipefail
fail=0

# Judge each query on its own line, not the whole file: a file is allowed to
# read qty_on_hand from the table in one query and use the live view in another.
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  code="${rest#*:}"
  # A query that names only qty_on_hand is fine -- on-hand is always truthful.
  # A query that names qty_reserved, or select("*") which pulls it in, is not.
  case "$code" in
    *'select("*'*|*qty_reserved*)
      echo "VIOLATION: $file:$line selects the reserved counter from the"
      echo "           v2_inventory_balances TABLE. That counter ignores"
      echo "           expires_at, so it counts abandoned carts as live holds."
      echo "           Read from v2_inventory_balances_live instead."
      echo "           $code"
      fail=1
      ;;
  esac
done < <(grep -rn 'from("v2_inventory_balances")' js/ || true)

# And nobody re-derives the subtraction by hand -- the view exposes
# qty_available precisely so that nobody has to.
if grep -rn 'qty_on_hand) *|| *0) *- *(Number(b\.qty_reserved' js/ >/dev/null 2>&1 \
   || grep -rn 'Number(b\.qty_on_hand) - Number(b\.qty_reserved)' js/ >/dev/null 2>&1; then
  echo "VIOLATION: availability is being re-derived by hand in JS."
  echo "           Read qty_available from v2_inventory_balances_live instead."
  grep -rn 'qty_on_hand.*-.*qty_reserved' js/ | sed 's/^/           /'
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "check_no_stale_reserved_reads: OK — no stale-reserved reads in js/"
fi
exit "$fail"
