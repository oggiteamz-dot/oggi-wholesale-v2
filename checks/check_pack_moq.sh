#!/bin/bash
# CHECK: minimum-order-quantity cannot be disabled by the client.
#
# This is a behaviour check, not a name check. It does not care what the
# function is called or which file it lives in -- it submits real orders and
# asserts what the server does. A future rewrite that drops the pack-line
# validation fails this check even if every function name still matches.
#
# Usage: check_pack_moq.sh <psql-connection-args>
# Exit 0 = all assertions held. Exit 1 = something regressed.

PSQL="psql $* -d wtest -v ON_ERROR_STOP=0 -tA"
# Kept so the preflight can repeat them back in its "how to fix this" lines;
# $* is not in scope inside a function.
CONN_ARGS="$*"
PASS=0; FAIL=0

# ---------------------------------------------------------------------------
# PREFLIGHT — added Batch 7, 21 Aug 2026, because this file lied.
# ---------------------------------------------------------------------------
# Run with no `wtest` database, every rejected_case below printed
#
#     FAIL  ...  expected rejection, order was ACCEPTED
#
# which says the MOQ rule has been broken. It had not; there was simply no
# database to ask. psql reports a connection failure as "psql: error: ..." in
# lower case, the assertions grep for upper-case "ERROR", so no match, so the
# call looked like a success and the order looked accepted.
#
# That is a gate failing in the most dangerous direction there is: a false
# alarm on the most alarming thing in the product. It is the same shape as the
# bug this file was written to catch, and the same shape as the day this suite
# reported 7 green while the function crashed on every call.
#
# So before asserting anything, prove the thing being asserted about can be
# reached. A check that cannot tell "no database" from "the rule is broken"
# must refuse to report either.
preflight() {
  local out
  out=$($PSQL -c "select 1;" 2>&1)
  if [ $? -ne 0 ] || ! echo "$out" | grep -q "^1$"; then
    echo "  SETUP FAILED — cannot reach the 'wtest' database."
    echo "                 $(echo "$out" | head -1)"
    echo "                 This is NOT a finding about the MOQ rules. Nothing was tested."
    echo "                 Create the fixture first:  psql $CONN_ARGS -d wtest -f checks/fixture.sql"
    exit 2
  fi
  out=$($PSQL -c "select count(*) from wholesale_v2.v2_products where wid = 'WS-001';" 2>&1)
  if ! echo "$out" | grep -qE "^[0-9]+$" || [ "$out" = "0" ]; then
    echo "  SETUP FAILED — the 'wtest' database has no WS-001 fixture products."
    echo "                 $(echo "$out" | head -1)"
    echo "                 Nothing was tested. Load it:  psql $CONN_ARGS -d wtest -f checks/fixture.sql"
    exit 2
  fi
  if ! $PSQL -c "select 'wholesale_v2.v2_submit_order'::regproc;" >/dev/null 2>&1; then
    echo "  SETUP FAILED — wholesale_v2.v2_submit_order does not exist in 'wtest'."
    echo "                 Nothing was tested. Replay the migrations first:"
    echo "                 REPLAY_DB=wtest ./checks/replay_migrations.sh"
    exit 2
  fi
}
preflight

# Exit code 2 above is deliberate and distinct from 1. 1 means "the rules are
# broken"; 2 means "I could not check". A caller that treats every non-zero
# exit the same still stops, but a human reading the output is told which of
# the two very different things happened.

# submit <json-lines> -> prints "OK" if the order was accepted, else "REJECTED"
submit() {
  local out
  out=$("$@" 2>&1) # placeholder, replaced below
}

rejected_case() {
  # A rejection only counts if it happened for the RIGHT REASON.
  # Asserting "some error occurred" is how a broken function fakes a pass:
  # during development this suite reported 7 green while the function was
  # crashing on every call with "function min(uuid) does not exist".
  local name="$1" want_reason="$2" lines="$3"
  local out
  out=$($PSQL -c "select (v2_submit_order('WS-001','Check Buyer',null,'${lines}'::jsonb)).id;" 2>&1)
  if ! echo "$out" | grep -q "ERROR"; then
    printf "  FAIL  %-58s expected rejection, order was ACCEPTED\n" "$name"; FAIL=$((FAIL+1))
  elif echo "$out" | grep -qi "$want_reason"; then
    printf "  PASS  %-58s (rejected: %s)\n" "$name" "$want_reason"; PASS=$((PASS+1))
  else
    printf "  FAIL  %-58s rejected for the WRONG reason\n" "$name"; FAIL=$((FAIL+1))
    echo "        wanted /$want_reason/, server said: $(echo "$out" | grep ERROR | head -1)"
  fi
}

accepted_case() {
  local name="$1" lines="$2"
  local out
  out=$($PSQL -c "select (v2_submit_order('WS-001','Check Buyer',null,'${lines}'::jsonb)).id;" 2>&1)
  if echo "$out" | grep -q "ERROR"; then
    printf "  FAIL  %-58s expected ACCEPTED\n" "$name"; FAIL=$((FAIL+1))
    echo "        server said: $(echo "$out" | grep ERROR | head -1)"
  else
    printf "  PASS  %-58s (accepted)\n" "$name"; PASS=$((PASS+1))
  fi
}

S=22222222-2222-2222-2222-222222222201   # TEE-BLUE-S, per-SKU minimum 12
M=22222222-2222-2222-2222-222222222202   # TEE-BLUE-M, per-SKU minimum 12
L=22222222-2222-2222-2222-222222222203   # TEE-BLUE-L, per-SKU minimum 12
PACK=33333333-3333-3333-3333-333333333333  # Boutique Pack = 1xS, 2xM, 2xL
LINE=44444444-4444-4444-4444-444444444444  # an arbitrary per-order pack line id

echo "MOQ / pack-line integrity checks"
echo

rejected_case "honest order below the SKU minimum" "requires a minimum of 12 units per order" \
  "[{\"variant_id\":\"$S\",\"qty\":1}]"

rejected_case "fabricated pack line cannot unlock the minimum" "do not match the composition" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

rejected_case "pack_line_id with no pack_id" "must both be supplied" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_line_id\":\"$LINE\"}]"

rejected_case "nonexistent pack id" "does not exist for this wholesaler" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"99999999-9999-9999-9999-999999999999\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

rejected_case "partial pack (missing components)" "do not match the composition" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1},
    {\"variant_id\":\"$M\",\"qty\":2,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

rejected_case "tampered quantity inside a real pack" "do not match the composition" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1},
    {\"variant_id\":\"$M\",\"qty\":2,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1},
    {\"variant_id\":\"$L\",\"qty\":99,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

rejected_case "pack_qty of zero" "must be 1 or more" \
  "[{\"variant_id\":\"$S\",\"qty\":0,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":0},
    {\"variant_id\":\"$M\",\"qty\":0,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":0},
    {\"variant_id\":\"$L\",\"qty\":0,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":0}]"

rejected_case "borrowing another wholesaler's pack" "does not exist for this wholesaler" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"66666666-6666-6666-6666-666666666666\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

accepted_case "a genuine pack IS accepted below per-SKU minimums" \
  "[{\"variant_id\":\"$S\",\"qty\":1,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1},
    {\"variant_id\":\"$M\",\"qty\":2,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1},
    {\"variant_id\":\"$L\",\"qty\":2,\"pack_id\":\"$PACK\",\"pack_line_id\":\"$LINE\",\"pack_qty\":1}]"

accepted_case "3 genuine packs (quantities scale correctly)" \
  "[{\"variant_id\":\"$S\",\"qty\":3,\"pack_id\":\"$PACK\",\"pack_line_id\":\"55555555-5555-5555-5555-555555555555\",\"pack_qty\":3},
    {\"variant_id\":\"$M\",\"qty\":6,\"pack_id\":\"$PACK\",\"pack_line_id\":\"55555555-5555-5555-5555-555555555555\",\"pack_qty\":3},
    {\"variant_id\":\"$L\",\"qty\":6,\"pack_id\":\"$PACK\",\"pack_line_id\":\"55555555-5555-5555-5555-555555555555\",\"pack_qty\":3}]"

accepted_case "ordinary order meeting the minimum" \
  "[{\"variant_id\":\"$S\",\"qty\":12}]"

echo
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
