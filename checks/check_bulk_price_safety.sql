-- ============================================================================
-- check_bulk_price_safety.sql — Batch 6 gate
--
-- WHAT WAS THERE BEFORE
--   The Products screen carried "Bulk price update (all products)": one number,
--   one button, no confirmation, and this loop running in the BROWSER:
--
--       for (const u of updates) { await supabase...update({price}).eq(id) }
--
--   No record of the old price anywhere, so no undo and no way to answer "what
--   was this before". Not atomic, so closing a laptop halfway left a catalogue
--   half repriced with nothing recording which half. And no archived filter, so
--   things deliberately withdrawn from sale were repriced too. Measured on
--   production: for wid 'sq' one click rewrote 64 variants.
--
-- THE ASSERTION THAT MATTERS MOST IS 5.
--   An undo that eats deliberate work is worse than no undo, because people
--   trust it. If a wholesaler bulk-updates, then hand-corrects one product,
--   then presses undo, the hand correction must survive. Proven red against the
--   obvious implementation -- an unconditional restore -- which silently turned
--   a hand-typed 99.99 back into 42.00 and reported skipped=0 as though nothing
--   had been lost.
--
-- HOW IT AUTHENTICATES
--   These functions are all guarded by v2_can_manage_prices(), which reads
--   auth.uid(). Run as `postgres` auth.uid() is NULL and every call would raise
--   "not allowed" -- so the check would pass for the wrong reason, which is the
--   worst kind of green. It therefore impersonates real rows in
--   v2_user_profiles by setting request.jwt.claims transaction-locally, the
--   same mechanism Supabase itself uses.
--
-- Run:  psql <conn> -f checks/check_bulk_price_safety.sql
-- Everything happens inside a transaction that is ROLLED BACK. Verified after
-- the live run: log empty, no archived flags left, demo's price sum back to
-- 288.00, no 99.99 anywhere.
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $chk$
declare
  -- Real profile rows. If these ids change, this check fails loudly at
  -- assertion 1 rather than silently testing nothing.
  DEMO uuid := 'b4cb85d9-987c-47d5-9060-35ac7f8c6a29';  -- wholesaler 'demo'
  SQW  uuid := 'a315d124-1038-4a7a-a76a-6c8ada1d3594';  -- wholesaler 'sq'
  v_pre record; v_run record; v_rev record;
  v_v uuid; v_before numeric; v_after numeric; v_now numeric;
  v_logged int; v_excl int; v_incl int; v_arch uuid;
  v_log text := '';
begin
  -- ---- 0. With no session, every entry point refuses ----------------------
  perform set_config('request.jwt.claims', '', true);
  begin
    perform * from v2_bulk_price_preview('demo', 10, false);
    raise exception 'ASSERT 0 FAILED: preview ran with no authenticated user';
  exception when others then
    if position('not allowed' in SQLERRM) = 0 then raise; end if;
  end;
  v_log := v_log || 'A0 unauthenticated refused; ';

  perform set_config('request.jwt.claims', json_build_object('sub', DEMO, 'role', 'authenticated')::text, true);

  -- ---- 1. The preview counts this wid's priced, non-archived variants -----
  select * into v_pre from v2_bulk_price_preview('demo', 10, false);
  if v_pre.variant_count <> 12 then
    raise exception 'ASSERT 1 FAILED: preview says %, expected 12', v_pre.variant_count;
  end if;
  v_log := v_log || format('A1 preview=%s (%s..%s -> %s..%s); ',
    v_pre.variant_count, v_pre.min_before, v_pre.max_before, v_pre.min_after, v_pre.max_after);

  -- ---- 2. A 0% change is refused, not logged as a run that did nothing ----
  begin
    select * into v_run from v2_bulk_update_prices('demo', 0, false);
    raise exception 'ASSERT 2 FAILED: a 0%% change was accepted';
  exception when others then
    if position('would do nothing' in SQLERRM) = 0 then raise; end if;
  end;
  v_log := v_log || 'A2 zero-pct refused; ';

  -- ---- 3. Apply: preview and apply agree, and every row is logged ---------
  select v.id, v.price into v_v, v_before
    from v2_product_variants v join v2_products p on p.id = v.product_id
   where p.wid='demo' and not p.archived and not v.archived and v.price is not null
   order by v.price desc limit 1;

  select * into v_run from v2_bulk_update_prices('demo', 10, false);
  if v_run.variant_count <> v_pre.variant_count then
    raise exception 'ASSERT 3 FAILED: preview said % but apply changed %', v_pre.variant_count, v_run.variant_count;
  end if;
  select count(*) into v_logged from v2_price_changes where batch_id = v_run.batch_id;
  if v_logged <> v_run.variant_count then
    raise exception 'ASSERT 3b FAILED: % changed, % logged', v_run.variant_count, v_logged;
  end if;
  select price into v_after from v2_product_variants where id = v_v;
  if v_after <> round(v_before * 1.10, 2) then
    raise exception 'ASSERT 3c FAILED: % -> %, expected %', v_before, v_after, round(v_before*1.10,2);
  end if;
  v_log := v_log || format('A3 applied+logged %s rows, %s->%s; ', v_logged, v_before, v_after);

  -- ---- 4. Another wholesaler cannot revert this batch ---------------------
  perform set_config('request.jwt.claims', json_build_object('sub', SQW, 'role', 'authenticated')::text, true);
  begin
    select * into v_rev from v2_revert_price_batch(v_run.batch_id);
    raise exception 'ASSERT 4 FAILED: wholesaler sq reverted demo''s price batch';
  exception when others then
    if position('not allowed' in SQLERRM) = 0 then raise; end if;
  end;
  v_log := v_log || 'A4 cross-tenant revert refused; ';
  perform set_config('request.jwt.claims', json_build_object('sub', DEMO, 'role', 'authenticated')::text, true);

  -- ---- 5. A HAND EDIT MADE AFTER THE BATCH SURVIVES THE UNDO -------------
  update v2_product_variants set price = 99.99 where id = v_v;

  select * into v_rev from v2_revert_price_batch(v_run.batch_id);
  select price into v_now from v2_product_variants where id = v_v;
  if v_now <> 99.99 then
    raise exception 'ASSERT 5 FAILED: the hand edit 99.99 was clobbered back to %', v_now;
  end if;
  if v_rev.skipped <> 1 then
    raise exception 'ASSERT 5b FAILED: skipped=%, expected 1 (the hand-edited row)', v_rev.skipped;
  end if;
  if v_rev.restored <> v_logged - 1 then
    raise exception 'ASSERT 5c FAILED: restored=%, expected %', v_rev.restored, v_logged - 1;
  end if;
  v_log := v_log || format('A5 restored=%s skipped=%s, hand edit SURVIVED; ', v_rev.restored, v_rev.skipped);

  -- ---- 6. Everything the undo claims to have restored really is back -----
  if exists (
    select 1 from v2_price_changes pc join v2_product_variants v on v.id = pc.variant_id
     where pc.batch_id = v_run.batch_id and pc.reverted_at is not null and v.price <> pc.old_price
  ) then
    raise exception 'ASSERT 6 FAILED: a row marked reverted does not hold its old price';
  end if;
  v_log := v_log || 'A6 reverted rows hold their old price; ';

  -- ---- 7. A large negative floors at zero, never negative ----------------
  select * into v_run from v2_bulk_update_prices('demo', -150, false);
  if exists (select 1 from v2_product_variants v join v2_products p on p.id=v.product_id
              where p.wid='demo' and v.price < 0) then
    raise exception 'ASSERT 7 FAILED: -150%% produced a negative price';
  end if;
  v_log := v_log || 'A7 -150pct floors at zero; ';

  -- ---- 8. Archived rows are excluded unless asked for --------------------
  -- The condition is BUILT here rather than hoped for. No wholesaler on
  -- production has a priced ARCHIVED variant, so an earlier version of this
  -- assertion compared 18 to 18 and would have reported PASS against a build
  -- that ignored the archived flag completely.
  select v.id into v_arch from v2_product_variants v join v2_products p on p.id=v.product_id
   where p.wid='demo' and v.price is not null limit 1;
  update v2_product_variants set archived = true where id = v_arch;
  select variant_count into v_excl from v2_bulk_price_preview('demo', 5, false);
  select variant_count into v_incl from v2_bulk_price_preview('demo', 5, true);
  if v_incl <> v_excl + 1 then
    raise exception 'ASSERT 8 FAILED: excluding=% including=%, expected exactly one more', v_excl, v_incl;
  end if;
  v_log := v_log || format('A8 archived excluded by default (%s vs %s); ', v_excl, v_incl);

  raise notice 'check_bulk_price_safety: all 9 assertions passed -- %', v_log;
end;
$chk$;

rollback;
