#!/usr/bin/env bash
# ============================================================================
# check_link_cap_under_concurrency.sh — LINK-07, migration 128
# ============================================================================
# THE QUESTION THIS GATE ASKS, and the reason it cannot be a .sql file:
#
#   "Hadi set the link to five. Six people finish signing up at the same
#    instant. Do exactly five get in?"
#
# Every other gate in checks/ runs in ONE connection, so every statement is
# already serialised and a missing `for update` looks perfect. A cap is only a
# cap under a race, and a race needs real concurrent sessions. This file opens
# them.
#
# HADI'S WORDS, which are precise about which moment counts:
#   "let's say they set it at five and six people click on the link, only the
#    first five that COMPLETE THE SIGN IN actually get the auto access. If the
#    sixth person logs in, they just log into the marketplace itself, and they
#    send a request for access for that wholesaler instead."
#
# WHAT IT PROVES
#   1. exactly `max_uses` redeemers come back 'joined'
#   2. every other redeemer comes back 'requested' -- NOBODY errors, nobody is
#      turned away, and nobody is left half-created
#   3. uses_count lands on exactly max_uses
#   4. every racer, winner or not, ends with a live marketplace session
#
# THE RED PROOF IS BUILT IN. Run with SABOTAGE=1 and the gate replaces
# v2_redeem_share_link's `select ... for update` with a plain `select` in a
# THROWAWAY COPY of the database, and runs the identical race. Without the
# lock, more redeemers than the cap allows read the same uses_count and are let
# in. If SABOTAGE=1 does NOT overshoot, this gate is not measuring anything and
# says so instead of passing.
#
# USAGE
#   PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres \
#     bash checks/check_link_cap_under_concurrency.sh <database>
# ============================================================================
set -uo pipefail

PGHOST="${PGHOST:-/tmp}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
DB="${1:-${PGDATABASE:-}}"
CAP=3
RACERS=8

if [ -z "$DB" ]; then
  echo "  SETUP FAILED — no database named."
  echo "                 usage: bash checks/check_link_cap_under_concurrency.sh <database>"
  echo "                 This is NOT a finding about the cap. Nothing was tested."
  exit 2
fi

psqlq() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -q "$@"; }

if ! psqlq -d "$DB" -Atc "select 1" >/dev/null 2>&1; then
  echo "  SETUP FAILED — cannot reach database '$DB' on $PGHOST:$PGPORT."
  echo "                 This is NOT a finding about the cap. Nothing was tested."
  exit 2
fi
if ! psqlq -d "$DB" -Atc "select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='wholesale_v2' and p.proname='v2_redeem_share_link'" \
     2>/dev/null | grep -q 1; then
  echo "  SETUP FAILED — v2_redeem_share_link is not in '$DB' (migration 128 not applied)."
  echo "                 This is NOT a finding about the cap. Nothing was tested."
  exit 2
fi

# --------------------------------------------------------------- the race ---
# $1 = database to race in. Echoes "<joined> <requested> <errors> <uses_count> <sessions>".
race() {
  local db="$1" w tok i pid
  w="zzc$$"
  psqlq -d "$db" >/dev/null 2>&1 <<SQL
insert into public.wholesalers (wid, name, active) values ('$w', 'Race Co', true);
insert into wholesale_v2.v2_wholesalers (wid, name) values ('$w', 'Race Co');
insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values ('$w', 'capped', $CAP);
SQL
  tok=$(psqlq -d "$db" -Atc "select token from wholesale_v2.v2_share_links where wid = '$w'")
  [ -z "$tok" ] && { echo "0 0 0 0 0"; return; }

  local out="$(mktemp -d)"

  # ⚠ A STARTING GUN, AND THE GATE WAS WORTHLESS WITHOUT IT.
  #
  # The first version of this file just launched $RACERS background psql
  # processes and hoped. It didn't race: process spawn, connect and parse take
  # tens of milliseconds each and the redemption transaction takes about one, so
  # the eight ran effectively one after another. Proof that this mattered: with
  # the row lock REMOVED the race still let in exactly the cap. A negative test
  # that passes on sabotaged code is not a negative test, and the green beside
  # it was meaningless.
  #
  # So every racer now connects FIRST, then sleeps until one shared wall-clock
  # instant, then calls. Connection and parse costs are paid before the gun.
  local gun
  gun=$(psqlq -d "$db" -Atc "select (clock_timestamp() + interval '3 seconds')::text")
  for i in $(seq 1 $RACERS); do
    (
      psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -Atc \
        "select pg_sleep(greatest(0, extract(epoch from (timestamptz '$gun' - clock_timestamp()))));
         select coalesce(outcome,'ERROR') || ' ' || (session_token is not null)::text
           from wholesale_v2.v2_redeem_share_link(
             '$tok', '03 90$i 00$i', 'Racer $i', 'Racer Shop $i', 'racer${i}x$$', 'hunter2secret')" \
        2>"$out/$i.err" | tail -1 > "$out/$i"
    ) &
  done
  wait

  local joined=0 requested=0 errors=0 sessions=0
  for i in $(seq 1 $RACERS); do
    local line; line="$(cat "$out/$i" 2>/dev/null)"
    case "$line" in
      joined*)    joined=$((joined+1)) ;;
      requested*) requested=$((requested+1)) ;;
      *)          errors=$((errors+1)) ;;
    esac
    case "$line" in *" true") sessions=$((sessions+1)) ;; esac
  done
  local uses; uses=$(psqlq -d "$db" -Atc "select uses_count from wholesale_v2.v2_share_links where wid = '$w'")

  psqlq -d "$db" >/dev/null 2>&1 <<SQL
delete from wholesale_v2.v2_signup_requests where wid = '$w';
delete from wholesale_v2.v2_wholesalers where wid = '$w';
delete from public.wholesalers where wid = '$w';
SQL
  rm -rf "$out"
  echo "$joined $requested $errors ${uses:-0} $sessions"
}

fails=0

echo "== $RACERS people finish at once on a link capped at $CAP"
read -r joined requested errors uses sessions <<<"$(race "$DB")"
echo "   joined=$joined requested=$requested errors=$errors uses_count=$uses sessions=$sessions"

[ "$joined" = "$CAP" ] \
  && echo "  ok   exactly $CAP got the automatic access" \
  || { echo "  FAIL $joined got in, the link allows $CAP"; fails=$((fails+1)); }

[ "$requested" = "$((RACERS - CAP))" ] \
  && echo "  ok   the other $((RACERS - CAP)) were asked to wait for approval" \
  || { echo "  FAIL $requested asked for approval, expected $((RACERS - CAP))"; fails=$((fails+1)); }

[ "$errors" = "0" ] \
  && echo "  ok   nobody hit an error — a race is not an excuse for a stack trace" \
  || { echo "  FAIL $errors racer(s) got an error instead of an answer"; fails=$((fails+1)); }

[ "$uses" = "$CAP" ] \
  && echo "  ok   uses_count landed on exactly $CAP" \
  || { echo "  FAIL uses_count is $uses, expected $CAP"; fails=$((fails+1)); }

# The sentence that never bends, under a race as much as anywhere else.
[ "$sessions" = "$RACERS" ] \
  && echo "  ok   ⭐ all $RACERS are signed up to OGGI, winners and losers alike" \
  || { echo "  FAIL only $sessions of $RACERS came away signed in"; fails=$((fails+1)); }

# ------------------------------------------------------------- the red proof
#
# WHAT THE FIRST TWO ATTEMPTS AT THIS PROOF TAUGHT, both kept because each
# corrected a claim this file would otherwise have made falsely.
#
# ATTEMPT 1 removed `for update` and the race still let in exactly the cap.
# The reason was not the code: the eight psql processes were not overlapping at
# all -- spawn, connect and parse cost tens of milliseconds each while the
# redemption takes about one. Hence the starting gun in race() above.
#
# ATTEMPT 2, with the gun, ALSO let in exactly the cap. That one is not a
# scheduling artefact. It is a real and hidden dependency: the rate limiter is
# keyed on the TOKEN, and since migration 128 made it an atomic upsert, that
# upsert takes a row lock on one key which every redeemer of one link contends
# for. Redemptions of a single link are therefore already serialised by the
# rate limiter, several statements before the link row is ever read.
#
#   That is a coincidence of two unrelated keys agreeing, not a design. Change
#   the rate-limit key -- to include a phone, an IP, anything -- and the
#   serialisation silently disappears while every gate stays green. The
#   `for update` stays because it is the guard a person can READ, and this note
#   stays so nobody removes it later on the evidence of a green race.
#
# So the sabotage removes BOTH: the lock, and the accidental mutex.
#
# AND WHAT HAPPENS THEN IS NOT AN OVERSHOOT, WHICH IS THE THIRD THING LEARNED.
# The cap still holds -- migration 127's `v2_share_links_uses_within_cap` CHECK
# refuses the row -- but the refusal arrives as a raw check violation:
#
#   joined=3  requested=0  errors=5  sessions=3   (of 8)
#
# Five people out of eight get a Postgres error instead of an answer and are
# turned away from OGGI entirely, which is the one thing this whole feature is
# built never to do. The constraint is the backstop; the lock is the difference
# between "please wait for approval" and a stack trace.
if [ "${SABOTAGE:-0}" = "1" ]; then
  echo
  echo "== SABOTAGE: the row lock removed, AND the rate limiter's accidental mutex with it"
  SAB="${DB}_nolock_$$"
  psqlq -c "drop database if exists $SAB" -c "create database $SAB template $DB" >/dev/null 2>&1 || {
    echo "  SABOTAGE SETUP FAILED -- could not copy $DB. The red proof did not run."; exit 3; }

  # Rewritten from the function's OWN source in the database, so the sabotage is
  # the shipped body with two edits and cannot drift away from it.
  psqlq -d "$SAB" >/dev/null 2>&1 <<'SQL'
do $$
declare src text;
begin
  select p.prosrc into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link';
  src := replace(src, 'where l.token = p_token for update', 'where l.token = p_token');
  src := replace(src, '''link|'' || coalesce(p_token, '''')',
                      '''link|'' || coalesce(p_token, '''') || coalesce(p_phone, '''')');
  execute format($f$
    create or replace function wholesale_v2.v2_redeem_share_link(
      p_token text, p_phone text, p_name text, p_shop_name text,
      p_username text, p_password text, p_answers jsonb default null)
    returns table (ok boolean, msg text, outcome text, wid text, wholesaler_name text,
                   client_id uuid, account_id uuid, session_id uuid, session_token text,
                   person_id uuid, expires_at timestamptz)
    language plpgsql volatile security definer
    set search_path = wholesale_v2, public, extensions
    as %L $f$, src);
end $$;
SQL
  sab_body=$(psqlq -d "$SAB" -Atc "select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link'" 2>/dev/null)
  if grep -q 'for update' <<<"$sab_body" || ! grep -q 'coalesce(p_phone' <<<"$sab_body"; then
    echo "  SABOTAGE DID NOT APPLY -- the body still has the lock, or lost the key change."
    echo "                           Red proof VOID; the green above is unproven."
    fails=$((fails+1))
  else
    read -r sjoined srequested serrors suses ssessions <<<"$(race "$SAB")"
    echo "   joined=$sjoined requested=$srequested errors=$serrors uses_count=$suses sessions=$ssessions"
    # The gate is proved by the sabotaged run BREAKING it -- by any of the three
    # ways it can break. Demanding one specific number would be a guess about
    # which way Postgres loses the race on the night.
    if [ "$sjoined" -gt "$CAP" ] || [ "$serrors" -gt 0 ] || [ "$ssessions" -lt "$RACERS" ]; then
      echo "  ok   without the lock the gate turns RED: $sjoined in, $serrors error(s), $ssessions of $RACERS signed up"
    else
      echo "  INCONCLUSIVE: the sabotaged race behaved correctly."
      echo "    That does NOT prove the lock is unnecessary -- it proves this run did not"
      echo "    overlap. Raise RACERS or re-run. Until the sabotage goes red once, the"
      echo "    green above is unproven, and this file says so rather than passing."
      fails=$((fails+1))
    fi
  fi
  psqlq -c "drop database if exists $SAB" >/dev/null 2>&1
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "check_link_cap_under_concurrency FAILED ($fails)"
  exit 1
fi
echo "check_link_cap_under_concurrency: ALL ASSERTIONS HELD"
