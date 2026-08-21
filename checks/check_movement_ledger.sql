-- ============================================================================
-- check_movement_ledger.sql — Batch 2 gate (migrations 069/070/071)
--
-- THREE DEFECTS THIS ENFORCES AGAINST, all found on 21 Aug 2026 by starting
-- Batch 2 with "what does this table's read policy actually say":
--
-- 1. THE LEDGER WAS READABLE BY ANYONE.  policy ... using (true)
--    RLS was ENABLED, which is what made it dangerous: every audit asking
--    "is RLS on?" answered yes, while the policy underneath permitted
--    everything. A gate switched on that lets everyone through.
--    Proven on production from a browser holding only the publishable key
--    that ships inside the client JavaScript:
--        236 movement rows readable anonymously
--        137 variants resolvable
--        attributable to ALL SIX wholesalers by name
--    and from SQL as the authenticated wholesaler "test": sees 236, owns 3.
--    This is the most commercially sensitive table in the system — exactly
--    what a rival received, when, how much, and the note saying why.
--
-- 2. NOBODY RECORDED WHO.  9 of 236 rows had an actor, all of them transfers.
--    Every other JS call site passed p_actor_id: null. 070 makes the RPCs
--    fall back to auth.uid(), so the answer comes from the session and a
--    caller cannot choose it.
--
-- 3. THE LEDGER HAD NO READER AT ALL. Written correctly since migration 001,
--    displayed nowhere.
--
-- THE RULE:
--   A wholesaler sees every one of their own stock movements and not one of
--   anyone else's. Both halves are asserted, because `using (false)` would
--   pass any leak test ever written while destroying the feature.
--
-- RED-PROVEN against a database replayed to migration 068 (the pre-Batch-2
-- state): assertion 1 fails with the ledger function absent, and assertion 3
-- fails with a stranger reading every row.
--
-- Run:  psql <conn> -f checks/check_movement_ledger.sql
-- Everything runs inside a transaction that is rolled back.
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  wid_a text := 'zzledger-a';
  wid_b text := 'zzledger-b';
  uid_a uuid := '11111111-1111-4111-8111-111111111111';
  uid_b uuid := '22222222-2222-4222-8222-222222222222';
  uid_o uuid := '33333333-3333-4333-8333-333333333333';
  loc_a uuid; loc_b uuid; prod_a uuid; prod_b uuid; var_a uuid; var_b uuid;
  n int; n2 int; v_actor uuid; rep text := '';
  page1 bigint[]; page2 bigint[]; overlap int;
begin
  -- ------------------------------------------------------------- fixture
  insert into public.wholesalers (wid) values (wid_a), (wid_b);
  insert into v2_wholesalers (wid, name) values (wid_a,'Ledger A'), (wid_b,'Ledger B');
  insert into auth.users (id) values (uid_a), (uid_b), (uid_o);
  insert into v2_user_profiles (id, role, wid, actor_label) values
    (uid_a,'wholesaler',wid_a,'Amal at A'),
    (uid_b,'wholesaler',wid_b,'Bilal at B'),
    (uid_o,'owner',null,'OGGI owner');

  insert into v2_locations (wid,name) values (wid_a,'A Main') returning id into loc_a;
  insert into v2_locations (wid,name) values (wid_b,'B Main') returning id into loc_b;
  insert into v2_products (wid,name) values (wid_a,'A Jacket') returning id into prod_a;
  insert into v2_products (wid,name) values (wid_b,'B Jacket') returning id into prod_b;
  insert into v2_product_variants (product_id,sku,extra_attrs)
    values (prod_a,'A-RED-M','{"color":"Red","size":"M"}'::jsonb) returning id into var_a;
  insert into v2_product_variants (product_id,sku,extra_attrs)
    values (prod_b,'B-BLU-M','{"color":"Blue","size":"M"}'::jsonb) returning id into var_b;

  -- A's history. Several rows share ONE timestamp on purpose: that is what a
  -- multi-line receipt looks like, and it is what breaks naive paging.
  insert into v2_inventory_movements (variant_id,location_id,movement_type,qty_delta,reference_type,note,created_at)
  select var_a, loc_a, 'receive', 10, 'manual_receive', 'A receipt line '||g,
         timestamptz '2026-08-01 10:00:00+00'
    from generate_series(1,6) g;
  insert into v2_inventory_movements (variant_id,location_id,movement_type,qty_delta,reference_type,note,created_at)
  select var_a, loc_a, 'sale', -2, 'order', 'A sale '||g,
         timestamptz '2026-08-02 10:00:00+00' + (g||' minutes')::interval
    from generate_series(1,4) g;
  -- B's history, which A must never see.
  insert into v2_inventory_movements (variant_id,location_id,movement_type,qty_delta,reference_type,note)
  select var_b, loc_b, 'receive', 99, 'manual_receive', 'B SECRET receipt '||g from generate_series(1,5) g;

  -- ---------------------------------------------------------- ASSERT 1
  -- The reader exists and returns A's rows, resolved into words.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select count(*) into n from v2_movement_ledger();
  perform set_config('role','postgres',true);
  if n <> 10 then
    raise exception 'ASSERT 1 FAILED: wholesaler A sees % ledger rows, expected their own 10', n;
  end if;
  rep := rep || format(E'\n 1  ok   ledger reader returns A''s own %s movements', n);

  -- ---------------------------------------------------------- ASSERT 2
  -- Rows are readable as SENTENCES, not as uuids. A ledger that says
  -- "a3f2... -2" answers nothing.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select count(*) into n from v2_movement_ledger()
   where product_name is not null and sku is not null and location_name is not null;
  perform set_config('role','postgres',true);
  if n <> 10 then
    raise exception 'ASSERT 2 FAILED: only % of 10 rows resolved product/sku/location names', n;
  end if;
  rep := rep || E'\n 2  ok   every row resolves product, SKU and warehouse names';

  -- ---------------------------------------------------------- ASSERT 3
  -- THE LEAK. A must not see B's movements by ANY route: not through the
  -- reader, and not by reading the table directly.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select count(*) into n  from v2_movement_ledger() where product_name = 'B Jacket';
  -- 3b reads the TABLE RAW, filtered by B's variant id captured in the
  -- fixture. An earlier draft of this assertion joined through v2_products
  -- to find B's rows -- and passed against the leak, because migration 031
  -- already scopes products. It was measuring the wrong table. Reading the
  -- movements row directly is the only honest test of the movements policy.
  select count(*) into n2 from v2_inventory_movements m where m.variant_id = var_b;
  perform set_config('role','postgres',true);
  if n <> 0 then raise exception 'ASSERT 3a FAILED: A sees % of B''s rows through the ledger reader', n; end if;
  if n2 <> 0 then raise exception 'ASSERT 3b FAILED: A reads % of B''s rows straight off the table (the using(true) leak)', n2; end if;
  rep := rep || E'\n 3  ok   wholesaler A sees ZERO of B''s movements, by either route';

  -- ---------------------------------------------------------- ASSERT 4
  -- The other direction. using(false) would pass everything above.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_b), true);
  select count(*) into n from v2_movement_ledger();
  perform set_config('role','postgres',true);
  if n <> 5 then
    raise exception 'ASSERT 4 FAILED: wholesaler B sees % of their own 5 rows - the ledger is broken, not secured', n;
  end if;
  rep := rep || E'\n 4  ok   wholesaler B still sees all 5 of their own - not merely locked out';

  -- ---------------------------------------------------------- ASSERT 5
  -- Filtering happens server-side and actually filters.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select count(*) into n from v2_movement_ledger(null,null,null,array['sale']);
  perform set_config('role','postgres',true);
  if n <> 4 then raise exception 'ASSERT 5 FAILED: type filter returned % rows, expected 4 sales', n; end if;
  rep := rep || E'\n 5  ok   type filter is applied by the database, not the browser';

  -- ---------------------------------------------------------- ASSERT 6
  -- STABLE PAGING. Six of A's rows share one timestamp. Ordering by
  -- created_at alone lets page 2 repeat or skip rows page 1 already showed,
  -- and the wholesaler silently never sees one of their own movements.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select array_agg(id order by id) into page1 from (select id from v2_movement_ledger(null,null,null,null,null,5,0)) a;
  select array_agg(id order by id) into page2 from (select id from v2_movement_ledger(null,null,null,null,null,5,5)) b;
  perform set_config('role','postgres',true);
  select count(*) into overlap from (select unnest(page1) intersect select unnest(page2)) x;
  if overlap <> 0 then
    raise exception 'ASSERT 6 FAILED: pages 1 and 2 share % row(s) - paging repeats rows and hides others', overlap;
  end if;
  if array_length(page1,1) + array_length(page2,1) <> 10 then
    raise exception 'ASSERT 6 FAILED: two pages of 5 returned % rows, not 10', array_length(page1,1)+array_length(page2,1);
  end if;
  rep := rep || E'\n 6  ok   paging is stable across rows sharing one timestamp (no repeats, none lost)';

  -- ---------------------------------------------------------- ASSERT 7
  -- WHO. A movement written by a logged-in user records that user, without
  -- the caller passing anything -- so it cannot be spoofed.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  perform v2_receive_stock(var_a, loc_a, 3, 'gate_actor', null, null, 'who test');
  perform set_config('role','postgres',true);
  select actor_id into v_actor from v2_inventory_movements
   where reference_type='gate_actor' order by created_at desc limit 1;
  if v_actor is null then
    raise exception 'ASSERT 7 FAILED: actor_id still null - the ledger cannot say who moved the stock';
  end if;
  if v_actor <> uid_a then raise exception 'ASSERT 7 FAILED: actor % is not the session user %', v_actor, uid_a; end if;
  rep := rep || E'\n 7  ok   a movement records WHO, taken from the session, not from the caller';

  -- ---------------------------------------------------------- ASSERT 8
  -- The owner console still sees everything.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_o), true);
  select count(*) into n from v2_movement_ledger(null,null,null,null,null,500,0,wid_b);
  perform set_config('role','postgres',true);
  if n <> 5 then raise exception 'ASSERT 8 FAILED: owner sees % of B''s 5 rows', n; end if;
  rep := rep || E'\n 8  ok   an owner can still read a named wholesaler''s ledger';

  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_movement_ledger: 8/8 PASSED (0 rows written) ---', rep;
end
$check$;

rollback;
