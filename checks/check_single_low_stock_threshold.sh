#!/usr/bin/env bash
# ============================================================================
# check_single_low_stock_threshold.sh — regression guard for Batch 1
#
# "Low stock" was not one rule in one place. It was the SAME magic number
# copied into SIX call sites across four files:
#
#     js/views/wholesaler.js:215      the dashboard count
#     js/views/wholesaler.js:1183     the inventory row badge
#     js/data/inventory-admin.js:281  the per-product lowCount
#     js/data/catalog.js:13           the buyer catalogue badge
#     js/lib/card-facts.js:42         the product card tone
#     js/lib/card-facts.js:144        the per-warehouse card tone
#
# Two of those six were only found on the SECOND sweep, because the first
# grep looked for the words "low" and "stock" and card-facts.js writes the
# comparison without either word. That is the same failure that lost the size
# axis in the 2.0 rewrite: searching for a NAME and missing a SHAPE.
#
# Fixing six call sites without stopping the seventh from being written is
# not a fix, it is a delay.
#
# THE RULE:
#   The threshold has exactly one definition, js/lib/inventory-defaults.js,
#   and per-SKU "low" is decided by DAYS OF COVER in
#   js/data/inventory-signals.js -- because a flat unit count means six
#   months of cover for a slow mover and a week for a fast one.
#   No other file may compare an availability against a numeric literal.
#
# Exit 1 on violation. Run from the repo root.
# ============================================================================
set -uo pipefail
fail=0

ALLOWED_DEFN="js/lib/inventory-defaults.js"

# 1. Nobody compares an available/on-hand quantity against a bare number.
#    Zero is exempt: "<= 0" is the definition of empty, not a threshold.
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"; line="${rest%%:*}"; code="${rest#*:}"
  [ "$file" = "$ALLOWED_DEFN" ] && continue
  # strip comment lines -- this file's own prose quotes the old code
  case "$(printf '%s' "$code" | sed 's/^[[:space:]]*//')" in
    //*|\**|/\**) continue ;;
  esac
  echo "VIOLATION: $file:$line compares availability to a hardcoded number."
  echo "           $(printf '%s' "$code" | sed 's/^[[:space:]]*//')"
  echo "           Use the status from js/data/inventory-signals.js, or"
  echo "           INVENTORY_SETTING_DEFAULTS.lowStockThreshold from"
  echo "           $ALLOWED_DEFN for a display-only tone."
  fail=1
done < <(grep -rnE '\b(available|onHand|qty_on_hand|qty_available)\b *<=? *[1-9][0-9]*' js/ --include='*.js' || true)

# 2. The single definition still exists and is still a single definition.
count=$(grep -rn 'lowStockThreshold: *[0-9]' js/ --include='*.js' | wc -l | tr -d ' ')
if [ "$count" -ne 1 ]; then
  echo "VIOLATION: expected exactly ONE numeric definition of lowStockThreshold, found $count."
  grep -rn 'lowStockThreshold: *[0-9]' js/ --include='*.js' | sed 's/^/           /'
  fail=1
fi

# 3. The defaults module stays pure. A constant must not drag a network
#    client in behind it -- that inversion broke two jsdom checks the first
#    time it was written, because js/lib/ is loaded without a Supabase global.
if grep -qE '^import .*(supabase-client|/data/)' "$ALLOWED_DEFN" 2>/dev/null; then
  echo "VIOLATION: $ALLOWED_DEFN imports I/O. It must stay a pure constants module."
  grep -nE '^import' "$ALLOWED_DEFN" | sed 's/^/           /'
  fail=1
fi


# 4. Nobody declares their own private threshold constant either. A named
#    constant is the same duplication wearing a hat -- js/data/catalog.js had
#    `const LOW_STOCK_THRESHOLD = 15` and rule 1 could never see it, because
#    rule 1 looks for a literal in a comparison and this one hides behind a
#    name. That is the NAME-versus-SHAPE miss again, so it gets its own rule.
#
#    ONE exemption, deliberately narrow and dated:
#      js/data/catalog.js — the BUYER-facing "Low stock" badge. Moving it onto
#      the wholesaler's setting needs the value to reach an anonymous buyer,
#      which means changing the buyer catalogue read path. That is Batch 5
#      (per-unit pricing and the model-aware buyer UI), where that path is
#      being opened anyway. Recorded here rather than left silent so the debt
#      is visible in code, is bounded to one file, and cannot spread: if a
#      SECOND file takes this exemption, this gate fails.
EXEMPT_CONST="js/data/catalog.js"

const_hits=$(grep -rlnE '^const [A-Z_]*(LOW_STOCK|STOCK_LOW)[A-Z_]* *= *[0-9]+' js/ --include='*.js' || true)
for f in $const_hits; do
  if [ "$f" != "$EXEMPT_CONST" ]; then
    echo "VIOLATION: $f declares its own low-stock threshold constant."
    grep -nE '^const [A-Z_]*(LOW_STOCK|STOCK_LOW)[A-Z_]* *= *[0-9]+' "$f" | sed 's/^/           /'
    echo "           There is one definition, in $ALLOWED_DEFN."
    fail=1
  fi
done

# And the exemption must still be a single file, not a growing list.
n_exempt=$(printf '%s\n' $const_hits | grep -c . || true)
if [ "$n_exempt" -gt 1 ]; then
  echo "VIOLATION: the buyer-side threshold exemption has spread to $n_exempt files."
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "check_single_low_stock_threshold: OK — one definition, no hardcoded copies in js/"
fi
exit "$fail"
