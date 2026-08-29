-- =============================================================================
-- CHECK: buy it again (RC-01, migration 095)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real function against a real fixture.
--
-- THE PROPERTY THIS FILE EXISTS FOR, and everything else is supporting work:
--
--     A REVOKED STORE FALLS OFF THE SHELF ON THE VERY NEXT CALL.
--
-- Not on the next login, not on the next cache expiry, not when something
-- remembers to invalidate. The set is recomputed from active memberships every
-- call, so the test can revoke inside the transaction, call again, and require
-- the products to be gone. That is the assertion the whole design exists to
-- make possible, and it is the one to break first when red-proving this file.
--
-- ==== WHY THE FIXTURE IS BUILT THE WAY IT IS ===============================
--
-- Two stores, one person, memberships in both. A single-store fixture would
-- pass against a function that ignores memberships entirely and just reads the
-- account's own wid — which is exactly the bug this feature could regress into,
-- and it would be invisible.
--
-- The third store (zz_r_never) exists so "did not appear" means something. A
-- test that only ever checks stores the buyer IS in cannot tell scoping from
-- luck.
--
-- ==== A NOTE ON READING THE OUTPUT =========================================
--
-- On 29 August a red proof produced ZERO failures and was briefly read as "the
-- gate is blind". It was not: the deliberate breakage was a syntax error, the
-- block never ran, and nothing printed. So this file prints its PASS/FAIL
-- tally unconditionally and raises on any failure. If you red-prove it and see
-- no FAIL lines AND no tally, the gate did not run — fix that before drawing
-- any conclusion about the gate.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_r_alpha';      -- store the buyer is in
  wB text := 'zz_r_beta';       -- second store, same person (cross-store)
  wN text := 'zz_r_never';      -- store the buyer has NEVER been in
  cliA uuid; cliB uuid; cliN uuid;
  accA uuid; person uuid;
  locA uuid; locB uuid; locN uuid;
  pA1 uuid; pA2 uuid; pArch uuid; pB1 uuid; pN1 uuid;
  vA1 uuid; vA1b uuid; vA2 uuid; vArch uuid; vB1 uuid; vN1 uuid;
  oA1 uuid; oA2 uuid; oB1 uuid; oN1 uuid;
  n int; r record; rows_before int; rows_after int;
  k int; pBulk uuid; vBulk uuid; oBulk uuid;
  cliRival uuid; pRival uuid; vRival uuid; oRival uuid;
begin
  -- ---------------------------------------------------------------- fixture
  insert into public.wholesalers (wid,name,brand,currency,active) values
    (wA,'Zed Alpha Supply','Alpha','$',true),
    (wB,'Zed Beta Supply','Beta','€',true),
    (wN,'Zed Never Supply','Never','$',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wN);

  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wA,'Main',true) returning id into locA;
  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wB,'Main',true) returning id into locB;
  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wN,'Main',true) returning id into locN;

  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wA,'Zed Reorder Shop','03 111 111') returning id into cliA;
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wB,'Zed Reorder Shop','03 111 111') returning id into cliB;
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wN,'Someone Else','03 222 222') returning id into cliN;

  insert into wholesale_v2.v2_portal_accounts (wid,client_id,role,username,password_hash,actor_label,active)
    values (wA,cliA,'buyer','zzreorder','x','Zed Reorder',true) returning id into accA;

  -- The person layer. v2_backfill_person_identity() is how 090 links an account
  -- to a person; calling it here rather than inserting a person by hand means
  -- this fixture exercises the real linking path.
  perform wholesale_v2.v2_backfill_person_identity();
  select a.person_id into person from wholesale_v2.v2_portal_accounts a where a.id = accA;

  -- Same person, second store. This is the cross-store half of RC-01.
  insert into wholesale_v2.v2_person_memberships (person_id,wid,client_id,role,active)
    values (person,wB,cliB,'buyer',true);

  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wA,'Zed Alpha Shirt','Tops',false)  returning id into pA1;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wA,'Zed Alpha Pant','Bottoms',false) returning id into pA2;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wA,'Zed Alpha Gone','Tops',true)     returning id into pArch;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wB,'Zed Beta Jacket','Outer',false)  returning id into pB1;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wN,'Zed Never Cap','Hats',false)     returning id into pN1;

  -- Two variants on pA1 at different prices: price_from must be the MINIMUM,
  -- and image_url must fall back to images->>0 when the column is null.
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,image_url,images) values (pA1,'ZA1-S',30.00,null,'["https://img.test/a1.jpg"]'::jsonb) returning id into vA1;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,image_url) values (pA1,'ZA1-M',24.50,null) returning id into vA1b;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,image_url) values (pA2,'ZA2-S',18.00,'https://img.test/a2.jpg') returning id into vA2;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price) values (pArch,'ZAR-S',9.00)  returning id into vArch;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price) values (pB1,'ZB1-S',55.00)   returning id into vB1;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price) values (pN1,'ZN1-S',7.00)    returning id into vN1;

  -- Orders. pA1 appears on TWO separate orders with TWO lines on one of them,
  -- so times_ordered can tell "distinct orders" from "line items".
  insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
    values (wA,'Zed Reorder',locA,cliA,'confirmed', now() - interval '10 days') returning id into oA1;
  insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
    values (wA,'Zed Reorder',locA,cliA,'confirmed', now() - interval '3 days') returning id into oA2;
  insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
    values (wB,'Zed Reorder',locB,cliB,'confirmed', now() - interval '1 day') returning id into oB1;
  insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
    values (wN,'Someone Else',locN,cliN,'confirmed', now() - interval '2 days') returning id into oN1;

  -- A DIFFERENT SHOP, INSIDE A STORE THIS BUYER IS IN.
  --
  -- ⚠️ ADDED AFTER A RED PROOF CAME BACK CLEAN. Without this, removing the
  -- client-scope filter entirely produced ZERO failures: every out-of-scope row
  -- in the fixture was ALSO out of scope by wid, so the two filters covered for
  -- each other and neither could be shown to be load-bearing. This row is in
  -- scope by wid and out of scope by client, which makes the client filter
  -- independently necessary -- and the leak it guards is the worse of the two:
  -- one shop reading what a rival shop reorders from the same wholesaler.
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wA,'Zed Rival Shop','03 333 333') returning id into cliRival;
  insert into wholesale_v2.v2_products (wid,name,category,archived) values (wA,'Zed Rival Only','Tops',false) returning id into pRival;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price) values (pRival,'ZRV-S',44.00) returning id into vRival;
  insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
    values (wA,'Zed Rival',locA,cliRival,'confirmed', now() - interval '5 hours') returning id into oRival;
  insert into wholesale_v2.v2_order_items (order_id,variant_id,qty) values (oRival, vRival, 30);

  insert into wholesale_v2.v2_order_items (order_id,variant_id,qty) values
    (oA1, vA1,  12),          -- order 1, line 1  : pA1
    (oA1, vA1b, 12),          -- order 1, line 2  : pA1 AGAIN (same product)
    (oA1, vArch, 6),          -- an archived product, ordered before it was archived
    (oA2, vA1,  12),          -- order 2          : pA1 -> 2 distinct orders
    (oA2, vA2,  24),          -- order 2          : pA2 -> 1 distinct order
    (oB1, vB1,   6),          -- the second store
    (oN1, vN1,  99);          -- somebody else entirely

  -- ================================================================ 1. scope
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50);
  rows_before := n;
  if n > 0 then PASS:=PASS+1; raise notice '  PASS  the shelf returns % row(s) for a buyer who has ordered', n;
  else FAIL:=FAIL+1; raise warning '  FAIL  the shelf is empty for a buyer with 3 orders -- nothing below this line means anything'; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wA;
  if n = 2 then PASS:=PASS+1; raise notice '  PASS  both non-archived products from their own store are offered';
  else FAIL:=FAIL+1; raise warning '  FAIL  own store returned % product(s), expected 2', n; end if;

  -- ========================================================== 2. cross-store
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wB;
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  a product from the SECOND store they belong to is offered -- the shelf crosses stores';
  else FAIL:=FAIL+1; raise warning '  FAIL  the second store returned % product(s), expected 1 -- the shelf is not reading memberships', n; end if;

  -- ====================================================== 3. THE LEAK CHECK
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wN;
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  nothing from a store this buyer has never been in';
  else FAIL:=FAIL+1; raise warning '  LEAK: % product(s) from a store this buyer has never entered', n; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pRival;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  nothing another shop ordered from the SAME wholesaler -- store scope alone is not enough, the client must match too';
  else FAIL:=FAIL+1;
    raise warning '  LEAK: a rival shop''s order at the same wholesaler is on this buyer''s shelf -- their buying history is readable'; end if;

  -- ==================================== 4. THE REVOCATION GUARANTEE (RC-01)
  update wholesale_v2.v2_person_memberships
     set active = false, revoked_at = now()
   where person_id = person and wid = wB;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wB;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  REVOKED STORE IS GONE ON THE NEXT CALL -- no cache to invalidate, no login required';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a REVOKED store still offers % product(s) -- the buyer is being sold a shop that threw them out', n; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wA;
  if n = 2 then PASS:=PASS+1; raise notice '  PASS  revoking one store did not disturb the other';
  else FAIL:=FAIL+1; raise warning '  FAIL  revoking store B changed store A to % product(s)', n; end if;

  -- restore, so the assertions below run against the full picture
  update wholesale_v2.v2_person_memberships
     set active = true, revoked_at = null
   where person_id = person and wid = wB;

  -- ====================================================== 5. archived hidden
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pArch;
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  an archived product is not offered for reorder';
  else FAIL:=FAIL+1; raise warning '  FAIL  an archived product is on the shelf -- the buyer would tap through to nothing'; end if;

  -- ================================================ 6. inactive wholesaler
  update public.wholesalers set active = false where wid = wB;
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wB;
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  a deactivated wholesaler drops off the shelf';
  else FAIL:=FAIL+1; raise warning '  FAIL  a deactivated wholesaler still offers % product(s)', n; end if;
  update public.wholesalers set active = true where wid = wB;

  -- ============================================ 7. orders, not line items
  select b.times_ordered into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pA1;
  if n = 2 then PASS:=PASS+1;
    raise notice '  PASS  times_ordered counts DISTINCT ORDERS (2), not line items (3)';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  times_ordered = % for a product on 2 orders across 3 lines -- expected 2', n; end if;

  select b.times_ordered into n from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pA2;
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  a product ordered once reports 1';
  else FAIL:=FAIL+1; raise warning '  FAIL  a product ordered once reports %', n; end if;

  -- ================================================= 8. most recent first
  select b.product_id into r from wholesale_v2.v2_buy_it_again(accA, 50) b limit 1;
  if r.product_id = pB1 then PASS:=PASS+1;
    raise notice '  PASS  the most recently ordered product leads the shelf -- a shop''s rhythm over its all-time totals';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the shelf does not lead with the most recent order'; end if;

  -- ======================================================= 9. price_from
  select b.price_from into r from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pA1;
  if r.price_from = 24.50 then PASS:=PASS+1; raise notice '  PASS  price_from is the CHEAPEST variant (24.50), not the first one found';
  else FAIL:=FAIL+1; raise warning '  FAIL  price_from = % for variants at 30.00 and 24.50 -- expected 24.50', r.price_from; end if;

  -- ============================================ 10. image falls back to images[0]
  select b.image_url into r from wholesale_v2.v2_buy_it_again(accA, 50) b where b.product_id = pA1;
  if r.image_url = 'https://img.test/a1.jpg' then PASS:=PASS+1;
    raise notice '  PASS  image_url falls back to images->>0 when the column is null -- a tile with no photo is a tile nobody taps';
  else FAIL:=FAIL+1; raise warning '  FAIL  image_url came back as % ', coalesce(r.image_url,'NULL'); end if;

  -- ================================== 11. the wholesaler is named, per row
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 50) b
   where b.wholesaler_name is null or btrim(b.wholesaler_name) = '';
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  every row names its wholesaler -- a cross-store shelf must answer "from whom" without a tap';
  else FAIL:=FAIL+1; raise warning '  FAIL  % row(s) have no wholesaler name', n; end if;

  select b.currency into r from wholesale_v2.v2_buy_it_again(accA, 50) b where b.wid = wB;
  if r.currency = '€' then PASS:=PASS+1; raise notice '  PASS  each row carries ITS OWN store''s currency -- a cross-store shelf cannot assume one';
  else FAIL:=FAIL+1; raise warning '  FAIL  the second store''s row reports currency %, expected the euro', r.currency; end if;

  -- ============================================== 12. the limit is clamped
  --
  -- ⚠️ THIS SECTION WAS VACUOUS AND WAS REWRITTEN. The first version asserted
  -- that limit 9999 "returns the real set" against a three-product fixture --
  -- which is true whether or not the clamp exists, so removing the clamp
  -- entirely produced ZERO failures. It was testing arithmetic that could not
  -- come out any other way. Same class of defect as row 204 of the manifest.
  --
  -- The clamp only means anything above 50 rows, so the fixture now builds 55
  -- more reorderable products. That costs a second and makes the assertion able
  -- to fail, which is the only thing that makes it worth having.
  for k in 1..55 loop
    insert into wholesale_v2.v2_products (wid,name,category,archived)
      values (wA, 'Zed Bulk ' || lpad(k::text,2,'0'), 'Bulk', false) returning id into pBulk;
    insert into wholesale_v2.v2_product_variants (product_id,sku,price)
      values (pBulk, 'ZBK-' || k, 10.00 + k) returning id into vBulk;
    insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,client_id,status,created_at)
      values (wA,'Zed Reorder',locA,cliA,'confirmed', now() - interval '20 days') returning id into oBulk;
    insert into wholesale_v2.v2_order_items (order_id,variant_id,qty) values (oBulk, vBulk, 6);
  end loop;

  select count(*) into rows_after from wholesale_v2.v2_buy_it_again(accA, 50);
  if rows_after = 50 then PASS:=PASS+1; raise notice '  PASS  an explicit limit of 50 returns exactly 50 of the 58 available';
  else FAIL:=FAIL+1; raise warning '  FAIL  limit 50 returned % rows against 58 available', rows_after; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 1);
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  an explicit limit of 1 is honoured';
  else FAIL:=FAIL+1; raise warning '  FAIL  limit 1 returned % rows', n; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 0);
  if n = 12 then PASS:=PASS+1; raise notice '  PASS  a nonsense limit (0) falls back to the DEFAULT OF 12, not to everything and not to nothing';
  else FAIL:=FAIL+1; raise warning '  FAIL  limit 0 returned % rows, expected the default of 12', n; end if;

  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, null);
  if n = 12 then PASS:=PASS+1; raise notice '  PASS  a null limit falls back to the default of 12';
  else FAIL:=FAIL+1; raise warning '  FAIL  a null limit returned % rows, expected 12', n; end if;

  -- Wrapped: without the fallback, `limit -5` reaches Postgres and RAISES,
  -- which would abort the whole gate mid-run and print no tally. A broken
  -- function must produce a named FAIL, not a crash that looks like a blind gate.
  begin
    select count(*) into n from wholesale_v2.v2_buy_it_again(accA, -5);
    if n = 12 then PASS:=PASS+1; raise notice '  PASS  a negative limit falls back to the default of 12';
    else FAIL:=FAIL+1; raise warning '  FAIL  a negative limit returned % rows, expected 12', n; end if;
  exception when others then
    FAIL:=FAIL+1; raise warning '  FAIL  a negative limit RAISED (%) -- the default-limit fallback is gone', SQLERRM;
  end;

  -- THE ONE THAT THE OLD VERSION COULD NOT MAKE FAIL.
  select count(*) into n from wholesale_v2.v2_buy_it_again(accA, 9999);
  if n = 50 then PASS:=PASS+1;
    raise notice '  PASS  an absurd limit (9999) is CLAMPED TO 50 against 58 available rows -- one buyer cannot ask the shelf to return everything';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  limit 9999 returned % rows against 58 available -- the 50-row clamp is not enforced', n; end if;

  -- ================================= 13. a stranger gets nothing, quietly
  begin
    select count(*) into n from wholesale_v2.v2_buy_it_again('00000000-0000-0000-0000-000000000000'::uuid, 12);
    if n = 0 then PASS:=PASS+1; raise notice '  PASS  an unverifiable account gets an empty shelf, not an exception';
    else FAIL:=FAIL+1; raise warning '  FAIL  an unverifiable account got % row(s)', n; end if;
  exception when others then
    FAIL:=FAIL+1;
    raise warning '  FAIL  an unverifiable account RAISED (%) -- a render path that throws is a blank screen', SQLERRM;
  end;

  begin
    select count(*) into n from wholesale_v2.v2_buy_it_again(null, 12);
    if n = 0 then PASS:=PASS+1; raise notice '  PASS  a null account id gets an empty shelf, not an exception';
    else FAIL:=FAIL+1; raise warning '  FAIL  a null account id got % row(s)', n; end if;
  exception when others then
    FAIL:=FAIL+1; raise warning '  FAIL  a null account id RAISED (%)', SQLERRM;
  end;

  -- ============================ 14. it is history, never a paid placement
  select p.prosrc into r from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_buy_it_again';
  if r.prosrc !~* 'v2_oggi_promoted' then PASS:=PASS+1;
    raise notice '  PASS  the reorder shelf does not read the promotion table -- these are the buyer''s own receipts, not an advert';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the reorder shelf joins v2_oggi_promoted -- a paid placement can now enter the buyer''s own history'; end if;

  if r.prosrc !~* 'v2_search_impressions' then PASS:=PASS+1;
    raise notice '  PASS  the reorder shelf does not read search telemetry -- SR-04''s data wall holds in this direction too';
  else FAIL:=FAIL+1; raise warning '  FAIL  the reorder shelf reads v2_search_impressions'; end if;

  -- The tally prints whether or not anything failed, so a gate that CRASHED is
  -- distinguishable from a gate that ran and found nothing. See the header.
  raise notice '----------------------------------------';
  raise notice 'check_buy_it_again: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_buy_it_again FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
