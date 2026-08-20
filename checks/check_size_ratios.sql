-- =====================================================================
-- check_size_ratios.sql — does "write the ratio once" actually work?
--
-- RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f checks/check_size_ratios.sql
-- PASS: exit 0.  FAIL: raises, non-zero exit, names the assertion.
--
-- WHY
-- ---------------------------------------------------------------------
-- v2_products.ratio_curve shipped in migration 030 and was never read by
-- anything. It looked like a feature for five months. The lesson is that
-- a column existing proves nothing, so every assertion below is about a
-- CONSEQUENCE the wholesaler could see:
--   not "does v2_size_ratios exist"  but  "does applying it build packs"
--   not "is ratio_id populated"      but  "does re-applying spare a
--                                          handmade pack"
--   not "is the curve stored"        but  "do the packs add up to 12"
--
-- PROVEN RED 20 Aug 2026: assertion [2a] was run with the ratio applied
-- to a single colour while still asserting four, and fired with
-- "expected 4 packs (4 colours), got 0". A check that has never failed
-- has never been tested.
--
-- Creates its own data under names starting 'ZZ ' and deletes all of it,
-- including audit rows, and restores the product's original ratio_curve.
-- Safe against production.
-- =====================================================================
do $proof$
declare
  -- Runs AS a wholesaler: v2_apply_ratio checks ownership, so running as
  -- a superuser would prove something nobody can actually do.
  SQ constant uuid := 'a315d124-1038-4a7a-a76a-6c8ada1d3594';
  v_pid uuid; v_ratio uuid; v_hand uuid; r record; n int; fails text := '';
  v_curve jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', SQ::text)::text, false);

  select id, ratio_curve into v_pid, v_curve from wholesale_v2.v2_products
   where wid='sq' and name='Boxy Cotton Tee' limit 1;
  if v_pid is null then
    raise exception 'check_size_ratios: fixture product "Boxy Cotton Tee" (wid sq) is missing';
  end if;

  -- A pack built BY HAND. Assertion 7 is the whole reason it exists.
  insert into wholesale_v2.v2_pack_definitions (product_id, wid, name, color, source)
  values (v_pid, 'sq', 'ZZ Handmade', 'ZZTestColour', 'manual') returning id into v_hand;

  -- Deliberately includes size 44, which this product does NOT have, and a
  -- zero weight on it -- both edge cases are asserted below.
  insert into wholesale_v2.v2_size_ratios (wid, name, sizes, weights, note)
  values ('sq','ZZ Boutique 12', array['36','38','40','42','44'], array[2,3,5,2,0], 'proof run')
  returning id into v_ratio;

  -- [2] One call, every colour. This is the feature.
  select * into r from wholesale_v2.v2_apply_ratio(v_ratio, v_pid, null, 1, null);
  if not r.ok then fails := fails||E'\n  [2] apply failed: '||r.msg; end if;
  if r.packs_created <> 4 then fails := fails||E'\n  [2a] expected 4 packs (4 colours), got '||r.packs_created; end if;
  if r.pieces_per_pack <> 12 then fails := fails||E'\n  [2b] 2+3+5+2+0 should be 12 pieces, got '||r.pieces_per_pack; end if;

  -- [3] A size the product lacks must be REPORTED, never silently dropped.
  if r.sizes_unmatched is null or not ('44' = any(r.sizes_unmatched)) then
    fails := fails||E'\n  [3] size 44 is absent from the product and must be reported as unmatched';
  end if;

  -- [4] A zero weight writes no component at all.
  select count(*) into n from wholesale_v2.v2_pack_components c
    join wholesale_v2.v2_pack_definitions d on d.id=c.pack_id
    join wholesale_v2.v2_product_variants v on v.id=c.variant_id
   where d.ratio_id=v_ratio and v.extra_attrs->>'size'='42' and c.qty_per_pack=2;
  if n <> 4 then fails := fails||E'\n  [4] each of 4 colours should carry 2x size 42, found '||n; end if;

  -- [5] The arithmetic the buyer will be charged on.
  select count(*) into n from (
    select d.id from wholesale_v2.v2_pack_definitions d
      join wholesale_v2.v2_pack_components c on c.pack_id=d.id
     where d.ratio_id=v_ratio and not d.archived
     group by d.id having sum(c.qty_per_pack)=12) t;
  if n <> 4 then fails := fails||E'\n  [5] only '||n||' of 4 packs sum to 12 pieces'; end if;

  -- [6] Re-applying replaces its own work rather than duplicating it.
  select * into r from wholesale_v2.v2_apply_ratio(v_ratio, v_pid, null, 2, null);
  if r.pieces_per_pack <> 24 then fails := fails||E'\n  [6a] multiplier 2 should give 24 pieces, got '||r.pieces_per_pack; end if;
  select count(*) into n from wholesale_v2.v2_pack_definitions where ratio_id=v_ratio and not archived;
  if n <> 4 then fails := fails||E'\n  [6b] re-apply should leave 4 live packs, found '||n||' (duplicated)'; end if;

  -- [7] THE ONE THAT PROTECTS THE WHOLESALER'S OWN WORK.
  select count(*) into n from wholesale_v2.v2_pack_definitions where id=v_hand and not archived;
  if n <> 1 then fails := fails||E'\n  [7] re-applying a ratio CLOBBERED a handmade pack'; end if;

  -- [8] The formerly-dead column is kept in step, not left as a second truth.
  select ratio_curve into r from wholesale_v2.v2_products where id=v_pid;
  if coalesce((r.ratio_curve->>'40')::int,0) <> 10 then
    fails := fails||E'\n  [8] ratio_curve not synced: size 40 should be 5x2=10, got '||coalesce(r.ratio_curve->>'40','null');
  end if;

  -- [9] A pack containing nothing must be impossible.
  begin
    insert into wholesale_v2.v2_size_ratios (wid,name,sizes,weights)
    values ('sq','ZZ Empty', array['36','38'], array[0,0]);
    fails := fails||E'\n  [9] a zero-sum ratio was accepted';
  exception when others then null;
  end;

  -- [10] A ratio whose numbers do not line up with its sizes is unreadable.
  begin
    insert into wholesale_v2.v2_size_ratios (wid,name,sizes,weights)
    values ('sq','ZZ Ragged', array['36','38','40'], array[1,2]);
    fails := fails||E'\n  [10] a ragged ratio (3 sizes, 2 weights) was accepted';
  exception when others then null;
  end;

  delete from wholesale_v2.v2_pack_components where pack_id in
    (select id from wholesale_v2.v2_pack_definitions where ratio_id=v_ratio or id=v_hand);
  delete from wholesale_v2.v2_pack_definitions where ratio_id=v_ratio or id=v_hand;
  delete from wholesale_v2.v2_size_ratios where wid='sq' and name like 'ZZ %';
  delete from wholesale_v2.v2_audit_log where action='ratio_applied' and target_id=v_pid::text;
  update wholesale_v2.v2_products set ratio_curve=v_curve where id=v_pid;
  perform set_config('request.jwt.claims', null, false);

  if fails <> '' then raise exception 'SIZE RATIO CHECK FAILED:%', fails; end if;
  raise notice 'check_size_ratios: PASS (10 assertions)';
end
$proof$;
