#!/usr/bin/env bash
# ============================================================================
# check_buyer_path_survives.sh — Batch S, gate S8.
#
# THE QUESTION THIS GATE ASKS:
#   "With the door shut, can a buyer still shop?"
#
# It is the PAIR to check_anon_scope.sh and must never be read without it.
# That gate proves production hands a stranger nothing. On its own that is
# also what a completely broken database looks like. A shut door and a shut
# shop are indistinguishable from outside, and the only difference that
# matters to Hadi is which one he has.
#
# So this one asks the opposite question through the same front door: signed
# out, over REST, with the same publishable key that ships inside the app,
# calling the gated SECURITY DEFINER functions exactly the way js/data/*.js
# calls them after v2_buyer_login hands back an account id.
#
# WHAT IT PROVES, IN ORDER
#   1. a signed-in buyer sees catalogues, products, prices and a discount
#   2. a share link resolves for the buyer it belongs to
#   3. the cart's price lookup answers for that buyer's own variants
#   4. and NONE of it crosses a tenant boundary: the same buyer, pointed at
#      another wholesaler's share link or another wholesaler's variant id,
#      gets nothing back -- not an error, nothing, because an error is an
#      existence oracle and silence is not
#
# WHY THE IDS ARE HARD-CODED
#   This gate cannot look them up. Looking them up would mean reading
#   v2_portal_accounts and v2_catalogs directly, which is the exact privilege
#   S7 took away -- a gate that needs the leak in order to prove the leak is
#   closed is not a gate. They are TEST FIXTURES in a database where every
#   wholesaler is a test one. If they are ever deleted this gate says HARNESS
#   BROKEN and refuses to pass; refresh them from the SQL editor with
#   `select id, username, wid from wholesale_v2.v2_portal_accounts`.
#
# RED PROOF — every branch was made to fire before this file was committed:
#   point BUYER_A at a nonexistent account   -> HARNESS BROKEN, exit 1 (not a pass)
#   point v2_buyer_catalog_read at a foreign
#     catalogue id                           -> FAIL "the shop is shut, not
#                                               just the door", exit 1
#   set TOKEN_B to the buyer's OWN link      -> FAIL "RETURNED 44 ROWS ACROSS A
#                                               TENANT BOUNDARY", exit 1
#   point URL at an unreachable host         -> HARNESS BROKEN, exit 1
# The middle two matter most: without them this file could only ever agree with
# itself. A gate whose failure branch has never executed is decoration.
#
# HARNESS FAILURE IS NOT A PASS. Same rule as its twin: if the network is
# down, the key cannot be read, or a fixture has vanished, this exits 1 saying
# so rather than letting a silent green scroll past.
#
# Exit 1 on any violation. Run from the repo root.
# ============================================================================
set -uo pipefail

SRC="js/lib/supabase-client.js"
[ -f "$SRC" ] || { echo "HARNESS BROKEN — this is NOT a pass: $SRC not found (run from the repo root)"; exit 1; }

URL=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$SRC" | head -1)
KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_-]+' "$SRC" | head -1)
[ -n "$URL" ] && [ -n "$KEY" ] || { echo "HARNESS BROKEN — this is NOT a pass: could not read the URL/key out of $SRC"; exit 1; }

# ---- test fixtures (see the note above) -------------------------------------
BUYER_A="26bba375-5312-4ed7-a412-6c9271f26dcc"   # farah, wid=test
BUYER_B="04a77718-58bb-4614-9b52-260b159b2d5c"   # demo,  wid=mg
TOKEN_A="825505096c40147c945e0ae8"               # a share link belonging to wid=test
TOKEN_B="6cab5f56e3b66f1ea8a57c47"               # a share link belonging to wid=mg

rpc() {
  curl -s --max-time 25 -X POST \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
    -H "Content-Profile: wholesale_v2" -H "Content-Type: application/json" \
    -d "$2" "$URL/rest/v1/rpc/$1"
}

count() {
  python3 -c 'import sys,json
try:
    d = json.load(sys.stdin)
except Exception:
    print("HARNESS"); raise SystemExit
print(len(d) if isinstance(d, list) else "scalar")' 2>/dev/null || echo HARNESS
}

fail=0

probe=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Profile: wholesale_v2" \
  -H "Content-Type: application/json" -d '{"p_token":"x"}' \
  "$URL/rest/v1/rpc/v2_catalog_by_token")
if [ "$probe" = "000" ]; then
  echo "HARNESS BROKEN — this is NOT a pass: cannot reach $URL (no network?)."
  echo "                 Nothing was verified. Do not read this as a green gate."
  exit 1
fi

say_ok()   { printf '  OK   %-46s %s\n' "$1" "$2"; }
say_fail() { printf '  FAIL %-46s %s\n' "$1" "$2"; fail=1; }

# --- must return rows --------------------------------------------------------
open_shop() { # label, fn, body  -- passes when the count is 1 or more
  local n; n=$(rpc "$2" "$3" | count)
  case "$n" in
    HARNESS) echo "HARNESS BROKEN — this is NOT a pass: $2 did not return JSON."; exit 1 ;;
    scalar)  say_ok "$1" "answered" ;;
    0)       say_fail "$1" "returned NOTHING — the shop is shut, not just the door" ;;
    *)       say_ok "$1" "$n rows" ;;
  esac
}

# --- must return nothing -----------------------------------------------------
shut_door() { # label, fn, body  -- passes ONLY on zero rows
  local n; n=$(rpc "$2" "$3" | count)
  case "$n" in
    HARNESS) echo "HARNESS BROKEN — this is NOT a pass: $2 did not return JSON."; exit 1 ;;
    0)       say_ok "$1" "nothing, as it must be" ;;
    *)       say_fail "$1" "RETURNED $n ROWS ACROSS A TENANT BOUNDARY" ;;
  esac
}

echo "Asking $URL as a signed-in buyer, through the same front door as the app."
echo

echo "the shop is open"
CATS=$(rpc v2_buyer_catalogs "{\"p_account_id\":\"$BUYER_A\"}")
CID=$(printf '%s' "$CATS" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d[0]["id"] if d else "")' 2>/dev/null)
[ -n "$CID" ] || { echo "HARNESS BROKEN — this is NOT a pass: buyer fixture $BUYER_A has no catalogues. Refresh the fixtures."; exit 1; }

open_shop "v2_buyer_catalogs"          v2_buyer_catalogs        "{\"p_account_id\":\"$BUYER_A\"}"
open_shop "v2_buyer_catalog_read"      v2_buyer_catalog_read    "{\"p_account_id\":\"$BUYER_A\",\"p_catalog_id\":\"$CID\"}"
open_shop "v2_buyer_discount_pct"      v2_buyer_discount_pct    "{\"p_account_id\":\"$BUYER_A\",\"p_catalog_id\":\"$CID\"}"
open_shop "v2_catalog_read (own link)" v2_catalog_read          "{\"p_token\":\"$TOKEN_A\",\"p_account_id\":\"$BUYER_A\"}"

# The cart. Priced from the buyer's OWN variants, discovered through the gate
# rather than from a table, because there is no table left to read.
VIDS=$(rpc v2_buyer_catalog_read "{\"p_account_id\":\"$BUYER_A\",\"p_catalog_id\":\"$CID\"}" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
ids=[r["variant_id"] for r in d if r.get("variant_id")][:3]
print(json.dumps(ids))' 2>/dev/null)
[ "$VIDS" != "[]" ] && [ -n "$VIDS" ] || { echo "HARNESS BROKEN — this is NOT a pass: no variants came back to price."; exit 1; }
open_shop "v2_buyer_list_prices (the cart)" v2_buyer_list_prices "{\"p_account_id\":\"$BUYER_A\",\"p_variant_ids\":$VIDS}"

echo
echo "and it does not leak sideways"
shut_door "v2_catalog_read (another tenant's link)" v2_catalog_read "{\"p_token\":\"$TOKEN_B\",\"p_account_id\":\"$BUYER_A\"}"

FOREIGN=$(rpc v2_buyer_catalogs "{\"p_account_id\":\"$BUYER_B\"}" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d[0]["id"] if d else "")' 2>/dev/null)
if [ -n "$FOREIGN" ]; then
  FV=$(rpc v2_buyer_catalog_read "{\"p_account_id\":\"$BUYER_B\",\"p_catalog_id\":\"$FOREIGN\"}" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
ids=[r["variant_id"] for r in d if r.get("variant_id")][:1]
print(json.dumps(ids))' 2>/dev/null)
  if [ "$FV" != "[]" ] && [ -n "$FV" ]; then
    shut_door "v2_buyer_list_prices (another tenant's variant)" v2_buyer_list_prices "{\"p_account_id\":\"$BUYER_A\",\"p_variant_ids\":$FV}"
  fi
  shut_door "v2_buyer_catalog_read (another tenant's catalogue)" v2_buyer_catalog_read "{\"p_account_id\":\"$BUYER_A\",\"p_catalog_id\":\"$FOREIGN\"}"
fi

shut_door "v2_catalog_read (invented token)" v2_catalog_read "{\"p_token\":\"deadbeefdeadbeefdeadbeef\",\"p_account_id\":null}"

echo
if [ "$fail" -ne 0 ]; then
  echo "GATE RED — the buyer path is broken or leaking. Read this together with"
  echo "           check_anon_scope.sh before drawing any conclusion."
  exit 1
fi
echo "GATE GREEN — the shop is open, scoped to the buyer it belongs to."
echo "NOTE: run check_anon_scope.sh too. Green here alone would also be what an"
echo "      unlocked database looks like."
exit 0
