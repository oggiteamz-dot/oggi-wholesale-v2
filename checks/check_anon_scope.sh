#!/usr/bin/env bash
# ============================================================================
# check_anon_scope.sh — Batch S, gate S0.
#
# THE QUESTION THIS GATE ASKS:
#   "With nothing but the key that ships inside the app, what will production
#    hand a total stranger?"
#
# It is not a code check. Every other gate in this folder reads the repo; this
# one asks the live database, signed out, exactly the way anyone with browser
# dev tools can. A grant is a property of the database, not of the source, so
# only the database can answer.
#
# THE ANSWER ON 25 AUG 2026, BEFORE ANY FIX EXISTED (the red proof):
#   v2_products                 23 rows   across 6 DIFFERENT WHOLESALERS
#   v2_product_variants        264 rows   every price, sku, colour, size
#   v2_pack_definitions         22 rows   including pack_price
#   v2_pack_components          all       joined through to variant prices
#   v2_inventory_by_variant     all       every stock level
#   v2_inventory_balances      143 rows   stock per warehouse
#   v2_inventory_balances_live 143 rows   same, live
#
# After Batch S every one of those must be zero rows or an outright denial,
# while the token path keeps working (that is check_buyer_path_survives.mjs,
# gate S8 -- this gate only proves the door is shut, never that the shop is
# open, and the two must always be run as a pair).
#
# WHY THE KEY IS READ OUT OF THE SOURCE AND NOT PASTED HERE:
#   so that this gate always tests the key that actually ships. Rotate the key
#   in supabase-client.js and this follows it. A hard-coded copy would quietly
#   start testing a key nobody uses.
#
# HARNESS FAILURE IS NOT A PASS. If the network is unreachable, or the key
# cannot be parsed, this exits 1 saying so -- it never stays silent and lets a
# green scroll past. That lesson cost half of 25 Aug: a gate whose own fixture
# failed to apply reported five passes, three of which were false.
#
# Exit 1 on any violation. Run from the repo root.
# ============================================================================
set -uo pipefail

SRC="js/lib/supabase-client.js"
[ -f "$SRC" ] || { echo "HARNESS BROKEN — this is NOT a pass: $SRC not found (run from the repo root)"; exit 1; }

URL=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$SRC" | head -1)
KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_-]+' "$SRC" | head -1)
[ -n "$URL" ] && [ -n "$KEY" ] || { echo "HARNESS BROKEN — this is NOT a pass: could not read the URL/key out of $SRC"; exit 1; }

REST="$URL/rest/v1"

# Reachability first. A gate that cannot reach the database has not proved the
# database is shut -- it has proved nothing, and must say so.
probe=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Accept-Profile: wholesale_v2" \
  "$REST/v2_categories?select=id&limit=1")
if [ "$probe" = "000" ]; then
  echo "HARNESS BROKEN — this is NOT a pass: cannot reach $URL (no network?)."
  echo "                 Nothing was verified. Do not read this as a green gate."
  exit 1
fi

fail=0

# The buyer-safe column list, copied from js/data/catalog.js on purpose.
# Testing v2_product_variants with select=* is the trap that fooled the 23 Aug
# research for ten minutes: `*` is denied because ONE column (cost) is revoked,
# which reads like a closed table and is not one. Ask for what the app asks for.
VARIANT_COLS="id,product_id,sku,price,compare_at_price,retail_price,extra_attrs,moq_qty,barcode,image_url,images,archived"

assert_shut() {
  local tbl="$1" cols="$2"
  local body code n
  body=$(curl -s --max-time 20 -w $'\n%{http_code}' \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Accept-Profile: wholesale_v2" \
    "$REST/$tbl?select=$cols&limit=200")
  code=$(printf '%s' "$body" | tail -1)
  body=$(printf '%s' "$body" | sed '$d')

  case "$code" in
    401|403)
      # The grant is gone. This is the strongest possible answer.
      printf '  OK   %-30s denied outright (HTTP %s)\n' "$tbl" "$code"
      return 0 ;;
    200|206)
      n=$(printf '%s' "$body" | grep -o '"' | wc -l)
      if [ "$body" = "[]" ]; then
        printf '  OK   %-30s readable, but returns no rows\n' "$tbl"
        return 0
      fi
      printf '  FAIL %-30s HANDED DATA TO A STRANGER (HTTP %s)\n' "$tbl" "$code"
      # tr first: PostgREST pretty-prints, so `cut` alone would print 120
      # characters of EVERY line and turn one finding into 90KB of scrollback.
      printf '       %s...\n' "$(printf '%s' "$body" | tr -d '\n' | head -c 120)"
      fail=1
      return 1 ;;
    *)
      echo "HARNESS BROKEN — this is NOT a pass: $tbl answered HTTP $code, which this gate does not know how to judge."
      exit 1 ;;
  esac
}

echo "Asking $URL as a signed-out stranger, with the app's own shipped key."
echo

assert_shut v2_products                 "*"
assert_shut v2_product_variants         "$VARIANT_COLS"
assert_shut v2_pack_definitions         "*"
assert_shut v2_pack_components          "*"
assert_shut v2_inventory_by_variant     "*"
assert_shut v2_inventory_balances       "*"
assert_shut v2_inventory_balances_live  "*"

# The cross-tenant question, asked separately because it is the one that makes
# this worth doing at all. One wholesaler's catalogue leaking to their own
# buyers is a design choice; six wholesalers leaking to each other is the
# product being unshippable at twenty.
echo
wids=$(curl -s --max-time 20 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Accept-Profile: wholesale_v2" \
  "$REST/v2_products?select=wid" 2>/dev/null \
  | grep -oE '"wid":"[^"]*"' | sort -u | wc -l | tr -d ' ')
if [ "${wids:-0}" -gt 0 ]; then
  echo "  FAIL cross-tenant: a stranger can see products from $wids DIFFERENT wholesalers"
  fail=1
else
  echo "  OK   cross-tenant: a stranger can enumerate no wholesaler's products"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "GATE RED — the anon role is not scoped. This is the state Batch S exists to change."
  exit 1
fi
echo "GATE GREEN — no direct table access for anon on any buyer-facing table."
echo "NOTE: run check_buyer_path_survives.mjs too. This gate cannot tell a shut door from a shut shop."
exit 0
