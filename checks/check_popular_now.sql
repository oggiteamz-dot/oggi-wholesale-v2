-- =============================================================================
-- CHECK: popular right now   (RC-02, migration 099)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real function against a real fixture.
--
-- THE PROPERTY THIS FILE EXISTS FOR, and everything else is supporting work:
--
--     ONE SHOP'S REPEAT ORDERS NEVER REACH THE SHELF.
--     SEVERAL SHOPS' SINGLE ORDERS DO.
--
-- This is the whole feature. Production today contains a product with 37
-- orders from ONE buyer and it must NOT be called popular, next to a product
-- with three orders from three buyers that must. A ranking on order count gets
-- this exactly backwards while looking entirely reasonable, and it is the
-- version a later "simplification" will reach for. Break this assertion first
-- when red-proving the file.
--
-- ==== WHY THE FIXTURE IS BUILT THE WAY IT IS ===============================
--
-- The buyer is in TWO stores and not in a third. The third exists so that "did
-- not appear" means something: a test that only ever looks at stores the buyer
-- IS in cannot tell scoping from luck.
--
-- Inside a store the buyer IS in there is a RIVAL product bought by four other
-- shops. That is the one the shelf should lead with, and it is the row that
-- proves the function is reading OTHER people's orders rather than the
-- caller's -- which is the difference between a recommendation and a mirror.
--
-- The loyal product is bought SIX TIMES BY ONE SHOP, which out-orders and
-- out-units every rival. Any ranking that leads on orders or on quantity puts
-- it first. It must not appear at all.
--
-- ==== A NOTE ON READING THE OUTPUT =========================================
--
-- This file prints its PASS/FAIL tally unconditionally and raises on any
-- failure. If you red-prove it and see no FAIL lines AND no tally, the gate did
-- not run -- and you have proven nothing. Fix that first.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_p_alpha';   -- store the buyer is in
  wB text := 'zz_p_beta';    -- second store, same person
  wN text := 'zz_p_never';   -- store the buyer has NEVER been in
  person uuid; accA uuid;
  cliMe uuid; cliB uuid; cliN uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid;
  pLoyal uuid; pRival uuid; pThin uuid; pCancel uuid; pMine uuid; pNever uuid; pOld uuid; pBulk uuid;
  vLoyal uuid; vRival uuid; vThin uuid; vCancel uuid; vMine uuid; vNever uuid; vOld uuid; vBulk uuid;
  crowd uuid[]; c uuid; k int; n int; r record;
  locA uuid; locN uuid;
  rows_now int;
begin
  -- ---------------------------------------------------------------- fixture
  insert into public.wholesalers (wid,name,active) values
    (wA,'Alpha P',true), (wB,'Beta P',true), (wN,'Never P',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wN);
  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wA,'Main',true) returning id into locA;
  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wN,'Main',true) returning id into locN;

  insert into wholesale_v2.v2_people (display_name) values ('Zed Popular') returning id into person;

  -- the caller's own client rows, one per store they are in
  insert into wholesale_v2.v2_clients (wid, shop_name) values (wA,'Zed Shop A') returning id into cliMe;
  insert into wholesale_v2.v2_clients (wid, shop_name) values (wB,'Zed Shop B') returning id into cliB;
  insert into wholesale_v2.v2_clients (wid, shop_name) values (wN,'Zed Shop N') returning id into cliN;

  insert into wholesale_v2.v2_portal_accounts
      (wid, role, username, password_hash, actor_label, client_id, person_id, active)
    values (wA, 'buyer', 'zzpop', 'x', 'Zed Shop A', cliMe, person, true)
    returning id into accA;

  insert into wholesale_v2.v2_person_memberships (person_id, wid, client_id, account_id, active)
    values (person, wA, cliMe, accA, true), (person, wB, cliB, null, true);
  -- deliberately NO membership in wN

  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Loyal Knit','Tops',false)   returning id into pLoyal;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Rival Tee','Tops',false)    returning id into pRival;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Thin Tee','Tops',false)     returning id into pThin;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Cancelled Tee','Tops',false) returning id into pCancel;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Already Mine','Tops',false) returning id into pMine;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Stale Tee','Tops',false)    returning id into pOld;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wN,'Never Tee','Tops',false)    returning id into pNever;
  -- THREE shops, but each buying 500. Out-units the four-shop rival 375 to 1.
  -- Exists so "ranked by buyers" is a claim the fixture can actually falsify.
  insert into wholesale_v2.v2_products (wid,name,category,archived) values
    (wA,'Bulk Tee','Tops',false)     returning id into pBulk;

  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pLoyal ,'ZZP-L',10,'{"color":"Red","size":"M"}'::jsonb) returning id into vLoyal;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pRival ,'ZZP-R',11,'{"color":"Blue","size":"M"}'::jsonb) returning id into vRival;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pThin  ,'ZZP-T',12,'{"color":"Green","size":"M"}'::jsonb) returning id into vThin;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pCancel,'ZZP-C',13,'{"color":"Black","size":"M"}'::jsonb) returning id into vCancel;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pMine  ,'ZZP-M',14,'{"color":"White","size":"M"}'::jsonb) returning id into vMine;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pOld   ,'ZZP-O',15,'{"color":"Grey","size":"M"}'::jsonb) returning id into vOld;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pNever ,'ZZP-N',16,'{"color":"Navy","size":"M"}'::jsonb) returning id into vNever;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pBulk  ,'ZZP-B',17,'{"color":"Olive","size":"M"}'::jsonb) returning id into vBulk;

  -- FOUR OTHER SHOPS inside store A. These are the crowd whose single orders
  -- are the only thing that should ever fill this shelf.
  for k in 1..4 loop
    insert into wholesale_v2.v2_clients (wid, shop_name) values (wA, 'Crowd '||k) returning id into c;
    crowd := coalesce(crowd, '{}') || c;

    -- the rival: one order each, from four different shops
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, c, 'Crowd '||k, 'confirmed', 11) returning id into o1;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o1, vRival, 1, 11, 11);

    -- the cancelled one: four shops, every order cancelled
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, c, 'Crowd '||k, 'cancelled', 13) returning id into o2;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o2, vCancel, 50, 13, 650);

    -- the stale one: four shops, but a year ago
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal, created_at)
      values (wA, locA, c, 'Crowd '||k, 'confirmed', 15, now() - interval '400 days') returning id into o3;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o3, vOld, 5, 15, 75);

    -- "already mine": four other shops bought it too, but so did the caller,
    -- so it belongs on the reorder shelf and not here
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, c, 'Crowd '||k, 'confirmed', 14) returning id into o4;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o4, vMine, 1, 14, 14);

    -- in a store the buyer is NOT in
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wN, locN, c, 'Crowd '||k, 'confirmed', 16) returning id into o1;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o1, vNever, 1, 16, 16);
  end loop;

  -- THE LOYAL PRODUCT: one shop, six orders, 600 units. Out-orders and
  -- out-units everything above. Must never appear.
  for k in 1..6 loop
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, crowd[1], 'Crowd 1', 'confirmed', 100) returning id into o1;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o1, vLoyal, 100, 10, 1000);
  end loop;

  -- THIN: two shops only. Under the floor of three.
  for k in 1..2 loop
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, crowd[k], 'Crowd '||k, 'confirmed', 12) returning id into o1;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o1, vThin, 1, 12, 12);
  end loop;

  -- BULK: three shops, 500 units each.
  for k in 1..3 loop
    insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
      values (wA, locA, crowd[k], 'Crowd '||k, 'confirmed', 8500) returning id into o1;
    insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
      values (o1, vBulk, 500, 17, 8500);
  end loop;

  -- the caller's OWN order of "Already Mine"
  insert into wholesale_v2.v2_orders (wid, location_id, client_id, buyer_label, status, subtotal)
    values (wA, locA, cliMe, 'Zed Shop A', 'confirmed', 14) returning id into o1;
  insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
    values (o1, vMine, 1, 14, 14);

  raise notice '=== check_popular_now ===';

  -- ============================ 1. THE PROPERTY THIS FILE EXISTS FOR
  select count(*) into rows_now from wholesale_v2.v2_popular_now(accA, null, 20);

  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pLoyal)
  then PASS:=PASS+1;
    raise notice '  PASS  ONE SHOP''S REPEAT ORDERS DO NOT REACH THE SHELF -- 6 orders and 600 units from a single buyer, out-ordering and out-unitting every rival, and it is correctly absent. That shop is a loyal customer and RC-01 already has a shelf for it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product bought six times by ONE shop is being called popular -- the loudest single customer is now editing everyone else''s shelf'; end if;

  if exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pRival)
  then PASS:=PASS+1;
    raise notice '  PASS  and FOUR shops each ordering ONCE does reach it -- that is what popular means, and it is the row that proves the function reads OTHER people''s orders rather than the caller''s';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product bought once each by four different shops did NOT reach the shelf'; end if;

  select buyer_count into n from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pRival;
  if n = 4 then PASS:=PASS+1;
    raise notice '  PASS  the count shown is BUYERS (4), not orders -- the number the buyer reads is the number the claim rests on';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  buyer_count is % for a product bought by exactly 4 shops', coalesce(n,-1); end if;

  -- THE RANK ITSELF, not just membership of the list. Bulk Tee has 3 buyers
  -- and 1500 units; Rival Tee has 4 buyers and 4 units -- 375 times fewer.
  -- Rival must lead. Any ranking that reaches for quantity first gets this
  -- backwards, and quantity is the most natural thing in the world to reach for.
  select product_id into r from wholesale_v2.v2_popular_now(accA, null, 20) limit 1;
  if r.product_id = pRival then PASS:=PASS+1;
    raise notice '  PASS  4 shops x 1 unit OUTRANKS 3 shops x 500 units -- a large order is one shop''s decision however large it is, so units break ties and never lead';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the shelf leads with something other than the most widely bought product -- units or orders have taken over the ranking'; end if;

  -- ============================ 2. the floor
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pThin)
  then PASS:=PASS+1;
    raise notice '  PASS  two buyers is under the floor and does not qualify -- "popular" backed by two shops is a claim the shelf cannot support';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product with two buyers cleared a floor of three'; end if;

  -- ============================ 3. cancelled orders
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pCancel)
  then PASS:=PASS+1;
    raise notice '  PASS  four shops CANCELLED it and it is not popular -- an order called off is evidence in the other direction, and production holds two of them today';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  cancelled orders are being counted as popularity'; end if;

  -- ============================ 4. the window
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pOld)
  then PASS:=PASS+1;
    raise notice '  PASS  four buyers 400 days ago is not "popular right now" -- without a window, whatever sold in the first month wins forever and nothing new can reach the shelf';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product last bought 400 days ago is on a shelf headed "right now"'; end if;

  -- ============================ 5. not a mirror
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where product_id = pMine)
  then PASS:=PASS+1;
    raise notice '  PASS  something the caller ALREADY buys is left off -- it is on the reorder shelf directly above, and two shelves showing one product is one wasted shelf';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product the caller already orders is being recommended back to them'; end if;

  -- ============================ 6. SCOPE. A store they were never in.
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where wid = wN)
  then PASS:=PASS+1;
    raise notice '  PASS  a store the buyer has NEVER been in contributes nothing -- a rail advertising a product behind a door that does not open is worse than an empty rail';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  products from a store the buyer has no membership in are on the shelf'; end if;

  -- REVOKE, AND ASK AGAIN. The assertion the whole design exists to allow.
  update wholesale_v2.v2_person_memberships set active = false
   where person_id = person and wid = wA;
  if not exists (select 1 from wholesale_v2.v2_popular_now(accA, null, 20) where wid = wA)
  then PASS:=PASS+1;
    raise notice '  PASS  a REVOKED store falls off the shelf on the very next call -- not at the next login, not at a cache expiry. The set is recomputed from active memberships every time';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a revoked store is still supplying recommendations'; end if;
  update wholesale_v2.v2_person_memberships set active = true
   where person_id = person and wid = wA;

  -- ============================ 7. the category is a narrowing, and says so
  select narrowed into r from wholesale_v2.v2_popular_now(accA, 'tops', 20) limit 1;
  if r.narrowed is true then PASS:=PASS+1;
    raise notice '  PASS  asking inside a category that HAS an answer reports narrowed=true';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a category with qualifying products did not report as narrowed'; end if;

  select count(*) into n from wholesale_v2.v2_popular_now(accA, 'no_such_category', 20);
  if n = rows_now then PASS:=PASS+1;
    raise notice '  PASS  a category with NO answer falls back to the wider question rather than returning nothing -- 17 of 23 live products have no category, and waiting on that data-entry job would leave the rail dark for months';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  an empty category returned % rows against % unnarrowed', n, rows_now; end if;

  select narrowed into r from wholesale_v2.v2_popular_now(accA, 'no_such_category', 20) limit 1;
  if r.narrowed is false then PASS:=PASS+1;
    raise notice '  PASS  and it SAYS it widened -- a rail headed "Popular in Tops" showing trousers is a small lie told confidently';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the function widened silently and still claims to be narrowed'; end if;

  -- narrowed=true must MEAN there are rows. The probe and the query it
  -- predicts are two separate SQL statements, and two statements that are
  -- supposed to agree are exactly the pair that quietly stops agreeing.
  for r in select narrowed, count(*) over () as c
             from wholesale_v2.v2_popular_now(accA, 'tops', 20) limit 1 loop
    if r.narrowed and r.c > 0 then PASS:=PASS+1;
      raise notice '  PASS  narrowed=true comes with actual rows -- the probe and the query it predicts carry the same exclusions, so the header can never promise a category the list does not deliver';
    else FAIL:=FAIL+1;
      raise warning '  FAIL  narrowed=% with % rows -- the probe disagrees with the query', r.narrowed, r.c; end if;
  end loop;

  -- And the reverse: a category whose ONLY qualifying product is one the caller
  -- already buys must NOT report as narrowed. This is the case that caught the
  -- looser probe, and it is invisible unless it is asked for directly.
  select count(*) into n from wholesale_v2.v2_popular_now(accA, 'tops', 20)
   where product_id = pMine;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a category narrowing never smuggles back in a product the wider query excluded';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  narrowing by category re-admitted a product the caller already buys'; end if;

  -- ============================ 8. a banned account gets nothing
  update wholesale_v2.v2_portal_accounts set active = false where id = accA;
  select count(*) into n from wholesale_v2.v2_popular_now(accA, null, 20);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a deactivated account gets NOTHING, and gets it by returning no rows rather than raising';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a deactivated account received % recommendations', n; end if;
  update wholesale_v2.v2_portal_accounts set active = true where id = accA;

  -- ============================ 9. the limit is clamped
  select count(*) into n from wholesale_v2.v2_popular_now(accA, null, 9999);
  if n <= 12 then PASS:=PASS+1;
    raise notice '  PASS  the row ceiling holds against a caller asking for 9999';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a caller asking for 9999 rows got %', n; end if;

  -- ============================ 10. the data wall, by source
  select p.prosrc into r from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_popular_now';
  if r.prosrc !~* 'v2_oggi_promoted' then PASS:=PASS+1;
    raise notice '  PASS  the popular shelf does not read the promotion table -- the moment "popular" can be bought, the word stops meaning anything and every other shelf inherits the doubt';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_popular_now joins v2_oggi_promoted -- a paid placement can now enter a shelf that claims to be earned'; end if;

  if r.prosrc !~* 'v2_search_impressions' then PASS:=PASS+1;
    raise notice '  PASS  and it does not read search telemetry -- SR-04''s data wall holds in this direction too';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_popular_now reads v2_search_impressions'; end if;

  -- ============================ 11. scope cannot be supplied
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_popular_now')) !~* 'wid'
  then PASS:=PASS+1;
    raise notice '  PASS  the function takes NO wid -- scope is derived from memberships and can never be handed in by a caller';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_popular_now accepts a wid'; end if;

  -- ============================ 12. the config is closed to the browser
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_ranking_config'
     and grantee in ('anon','authenticated','PUBLIC');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the ranking config holds no grant for the browser roles -- gate S7, and 098 is the migration that had to learn it the hard way';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the browser roles hold % grant(s) on v2_ranking_config', n; end if;

  -- ---------------------------------------------------------------- tally
  raise notice '----------------------------------------';
  raise notice 'check_popular_now: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_popular_now FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
