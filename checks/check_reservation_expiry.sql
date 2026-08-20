-- ============================================================================
-- check_reservation_expiry.sql — Batch 0 gate
--
-- THE BUG (found 20 Aug 2026, live in production):
--   v2_release_expired_reservations() has existed since 001 with its own
--   comment saying "call from pg_cron every 1-5 min". Nothing ever called it.
--   And `available` is computed as qty_on_hand - qty_reserved, where
--   qty_reserved is a plain counter that is NEVER filtered by expires_at.
--   So every abandoned cart suppresses real stock forever, silently.
--
-- THE RULE THIS FILE ENFORCES:
--   Availability must be correct WITHOUT any sweeper ever having run.
--   A scheduler is a tidiness mechanism, not a correctness mechanism —
--   if cron dies, stock must still be sellable.
--
-- Run:  psql <conn> -f checks/check_reservation_expiry.sql
-- Everything happens inside a transaction that is rolled back.
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_variant  uuid;
  v_location uuid;
  v_on_hand  int;
  v_res      v2_stock_reservations;
  v_avail    int;
  v_baseline int;
begin
  -- Pick any variant that actually has stock to play with.
  select b.variant_id, b.location_id, b.qty_on_hand
    into v_variant, v_location, v_on_hand
    from v2_inventory_balances b
   where b.qty_on_hand >= 3
   order by b.qty_on_hand desc
   limit 1;

  if v_variant is null then
    raise exception 'SETUP: no variant with >= 3 on hand; cannot run this check';
  end if;

  -- Neutralise any pre-existing holds on this row so the arithmetic below is
  -- about THIS test only. (Rolled back at the end.)
  update v2_stock_reservations set status = 'released'
   where variant_id = v_variant and location_id = v_location and status = 'active';
  update v2_inventory_balances set qty_reserved = 0
   where variant_id = v_variant and location_id = v_location;

  select total_available into v_baseline
    from v2_inventory_by_variant where variant_id = v_variant;

  -- 1. A live reservation must reduce availability.
  v_res := v2_reserve_stock(v_variant, v_location, 2, gen_random_uuid(), null, 15);
  if v_res is null then
    raise exception 'ASSERT 1 FAILED: could not reserve 2 units of a variant with % on hand', v_on_hand;
  end if;

  select total_available into v_avail
    from v2_inventory_by_variant where variant_id = v_variant;
  if v_avail <> v_baseline - 2 then
    raise exception 'ASSERT 2 FAILED: live hold did not reduce availability (% -> %, expected %)',
      v_baseline, v_avail, v_baseline - 2;
  end if;

  -- 2. THE ONE THAT MATTERS. Expire the hold. Do NOT run any sweep.
  --    Availability must recover on its own, at read time.
  update v2_stock_reservations
     set expires_at = now() - interval '1 hour'
   where id = v_res.id;

  select total_available into v_avail
    from v2_inventory_by_variant where variant_id = v_variant;
  if v_avail <> v_baseline then
    raise exception
      'ASSERT 3 FAILED (the reservation leak): an EXPIRED hold is still suppressing stock. available=% expected=% . No sweeper had run — and availability must not depend on one.',
      v_avail, v_baseline;
  end if;

  -- 3. An expired hold must not block a fresh reservation either.
  if v2_reserve_stock(v_variant, v_location, v_on_hand, gen_random_uuid(), null, 15) is null then
    raise exception 'ASSERT 4 FAILED: expired hold blocked a new reservation for the full on-hand qty (%)', v_on_hand;
  end if;

  -- 4. The sweeper still works, and is idempotent (tidies the counter).
  perform v2_release_expired_reservations();
  if exists (select 1 from v2_stock_reservations
              where status = 'active' and expires_at < now()) then
    raise exception 'ASSERT 5 FAILED: sweep left active-but-expired reservations behind';
  end if;

  -- 5. qty_reserved must never go negative, whatever order things run in.
  if exists (select 1 from v2_inventory_balances where qty_reserved < 0) then
    raise exception 'ASSERT 6 FAILED: qty_reserved went negative';
  end if;

  raise notice 'check_reservation_expiry: ALL 6 ASSERTIONS PASSED';
end
$check$;

rollback;
