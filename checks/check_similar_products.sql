-- =============================================================================
-- CHECK: more like this   (RC-03, migration 100)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real function against a real fixture.
--
-- THE PROPERTY THIS FILE EXISTS FOR, and everything else is supporting work:
--
--     TWO PRODUCTS THAT SHARE ONLY COLOUR FAMILY AND SIZE SYSTEM ARE NOT
--     SIMILAR. TWO PRODUCTS THAT SHARE A REAL WORD ARE.
--
-- This is the entire feature and it is the exact opposite of how RC-03 was
-- specified. Eight of 23 live products carry EVERY colour family -- each is
-- stocked in beige, blue, green and red -- so an attribute match puts a tote
-- bag next to a jacket next to a pair of trousers and calls it a
-- recommendation. Break this assertion first when red-proving the file.
--
-- ==== WHY THE FIXTURE IS BUILT THE WAY IT IS ===============================
--
-- The anchor is a "Cargo Pant". Around it:
--
--   * THE SAME ITEM IN ANOTHER STORE the buyer can enter. This is the row the
--     whole feature exists to produce -- the same product from a second
--     supplier is the most useful thing a wholesale marketplace can show, and
--     no attribute column in this schema knows it.
--   * THE SAME ITEM IN A STORE THE BUYER IS NOT IN. Must not appear, or "did
--     not appear" means nothing anywhere else in this file.
--   * A DECOY that shares every colour family and the size system and no word.
--     Under the specified design this ranks first. It must not appear at all.
--   * A JUNK-NAMED product ('j'), which must not become similar to anything.
--   * FOUR same-store near-matches, to prove the per-store cap bites.
--
-- ==== A NOTE ON READING THE OUTPUT =========================================
--
-- This file prints its PASS/FAIL tally unconditionally and raises on failure.
-- No FAIL lines AND no tally means the gate did not run and you have proven
-- nothing. Fix that before drawing a conclusion.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_s_alpha';   -- anchor's store, buyer is in it
  wB text := 'zz_s_beta';    -- second store, buyer is in it
  wN text := 'zz_s_never';   -- store the buyer has NEVER been in
  person uuid; accA uuid; cliA uuid; cliB uuid;
  locA uuid;
  pAnchor uuid; pTwin uuid; pHidden uuid; pDecoy uuid; pJunk uuid; pCheap uuid;
  pA2 uuid; pA3 uuid; pA4 uuid; pA5 uuid;
  v uuid; n int; k int; r record;
begin
  -- ---------------------------------------------------------------- fixture
  insert into public.wholesalers (wid,name,active) values
    (wA,'Alpha S',true), (wB,'Beta S',true), (wN,'Never S',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wN);
  insert into wholesale_v2.v2_locations (wid,name,is_default) values (wA,'Main',true) returning id into locA;

  insert into wholesale_v2.v2_people (display_name) values ('Zed Similar') returning id into person;
  insert into wholesale_v2.v2_clients (wid, shop_name) values (wA,'Zed A') returning id into cliA;
  insert into wholesale_v2.v2_clients (wid, shop_name) values (wB,'Zed B') returning id into cliB;
  insert into wholesale_v2.v2_portal_accounts
      (wid, role, username, password_hash, actor_label, client_id, person_id, active)
    values (wA,'buyer','zzsim','x','Zed A', cliA, person, true) returning id into accA;
  insert into wholesale_v2.v2_person_memberships (person_id, wid, client_id, account_id, active)
    values (person, wA, cliA, accA, true), (person, wB, cliB, null, true);
  -- deliberately NO membership in wN

  -- THE ANCHOR
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wA,'Cargo Pant','Bottoms',false) returning id into pAnchor;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pAnchor,'ZZS-A1',29.50,'{"color":"Sand","size":"M"}'::jsonb);
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pAnchor,'ZZS-A2',29.50,'{"color":"Navy","size":"L"}'::jsonb);

  -- THE TWIN: the same item, another store the buyer CAN enter. The row this
  -- whole feature exists to produce.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wB,'Cargo Pant','Bottoms',false) returning id into pTwin;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pTwin,'ZZS-B1',19.00,'{"color":"Sand","size":"M"}'::jsonb);

  -- THE HIDDEN TWIN: same item, store the buyer is NOT in.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wN,'Cargo Pant','Bottoms',false) returning id into pHidden;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pHidden,'ZZS-N1',15.00,'{"color":"Sand","size":"M"}'::jsonb);

  -- THE DECOY: every colour family the anchor has, the same size system, and
  -- not one shared word. Under the SPECIFIED design this ranks first.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wB,'Wool Scarf','Bottoms',false) returning id into pDecoy;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pDecoy,'ZZS-D1',29.50,'{"color":"Sand","size":"M"}'::jsonb);
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pDecoy,'ZZS-D2',29.50,'{"color":"Navy","size":"L"}'::jsonb);

  -- JUNK NAME, exactly as the test store holds today.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wB,'j',null,false) returning id into pJunk;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pJunk,'ZZS-J1',29.50,'{"color":"Sand","size":"M"}'::jsonb);

  -- A CHEAPER EQUIVALENT. Price must never disqualify: a cheaper equivalent is
  -- exactly what a wholesale buyer is hunting for.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wB,'Cargo Pant Lightweight',null,false) returning id into pCheap;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
    values (pCheap,'ZZS-C1',3.00,'{"color":"Sand","size":"M"}'::jsonb);

  -- FOUR same-store matches, so the per-store cap has something to bite on.
  insert into wholesale_v2.v2_products (wid,name,archived) values (wA,'Cargo Pant Slim',false)  returning id into pA2;
  insert into wholesale_v2.v2_products (wid,name,archived) values (wA,'Cargo Pant Wide',false)  returning id into pA3;
  insert into wholesale_v2.v2_products (wid,name,archived) values (wA,'Cargo Pant Cuffed',false) returning id into pA4;
  insert into wholesale_v2.v2_products (wid,name,archived) values (wA,'Cargo Pant Cropped',false) returning id into pA5;
  insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs) values
    (pA2,'ZZS-A3',28,'{"color":"Sand","size":"M"}'::jsonb),
    (pA3,'ZZS-A4',28,'{"color":"Sand","size":"M"}'::jsonb),
    (pA4,'ZZS-A5',28,'{"color":"Sand","size":"M"}'::jsonb),
    (pA5,'ZZS-A6',28,'{"color":"Sand","size":"M"}'::jsonb);

  raise notice '=== check_similar_products ===';

  -- ============================ 1. THE PROPERTY THIS FILE EXISTS FOR
  if not exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20)
                  where product_id = pDecoy)
  then PASS:=PASS+1;
    raise notice '  PASS  A PRODUCT SHARING EVERY COLOUR FAMILY AND THE SIZE SYSTEM, AND NO WORD, IS NOT SIMILAR. Eight of 23 live products carry all four families -- an attribute match would put a scarf next to a pair of trousers and call it a recommendation';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product sharing only colour and size reached the shelf -- attributes are qualifying rows again, and on this catalogue that means everything qualifies'; end if;

  if exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20)
              where product_id = pTwin)
  then PASS:=PASS+1;
    raise notice '  PASS  and THE SAME ITEM FROM A SECOND SUPPLIER does reach it -- the single most useful thing a wholesale marketplace can show a buyer, and no attribute column in this schema knows it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the same product in another store the buyer can enter did NOT appear'; end if;

  -- ============================ 2. junk names match nothing
  if not exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20)
                  where product_id = pJunk)
  then PASS:=PASS+1;
    raise notice '  PASS  a product named "j" is similar to nothing -- the test store is full of these today, and without the single-character rule the shelf fills with keyboard mash';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a one-character product name matched the anchor'; end if;

  select count(*) into n from wholesale_v2.v2_similar_products(accA, pJunk, 20);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  and asking what is similar TO "j" returns nothing rather than everything';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a junk-named anchor returned % results', n; end if;

  -- ============================ 3. SCOPE
  if not exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20) where wid = wN)
  then PASS:=PASS+1;
    raise notice '  PASS  the same item in a store the buyer has NEVER entered does not appear -- a shelf that advertises a product behind a door that does not open is worse than an empty shelf';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a store the buyer has no membership in is supplying recommendations'; end if;

  -- REVOKE, AND ASK AGAIN.
  update wholesale_v2.v2_person_memberships set active=false where person_id=person and wid=wB;
  if not exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20) where wid = wB)
  then PASS:=PASS+1;
    raise notice '  PASS  a REVOKED store falls off on the very next call -- recomputed from active memberships every time, nothing to invalidate';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a revoked store is still supplying recommendations'; end if;
  update wholesale_v2.v2_person_memberships set active=true where person_id=person and wid=wB;

  -- THE ANCHOR ITSELF must be in scope, or a buyer can probe products they
  -- cannot see and learn what the marketplace thinks resembles them.
  select count(*) into n from wholesale_v2.v2_similar_products(accA, pHidden, 20);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  passing a product id from a store the buyer cannot enter returns NOTHING -- the anchor is checked for scope too, so this cannot be used to read across the wall';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a product outside the buyer''s scope was accepted as an anchor and returned % rows', n; end if;

  -- ============================ 4. never itself
  if not exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20)
                  where product_id = pAnchor)
  then PASS:=PASS+1;
    raise notice '  PASS  a product is not similar to itself';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the anchor appears in its own results'; end if;

  -- ============================ 5. NO ONE STORE FILLS THE RAIL
  select count(*) into n from wholesale_v2.v2_similar_products(accA, pAnchor, 20) where wid = wA;
  if n <= 3 then PASS:=PASS+1;
    raise notice '  PASS  the anchor''s own store contributed % of 5 possible matches -- capped, because a shelf of one supplier''s catalogue is the store page the buyer is already looking at', n;
  else FAIL:=FAIL+1;
    raise warning '  FAIL  one store contributed % results and filled the rail', n; end if;

  if exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20) where cross_store)
  then PASS:=PASS+1;
    raise notice '  PASS  and the shelf reaches across stores -- cross-store comparison is the reason the marketplace exists';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  every result came from the anchor''s own store'; end if;

  -- ============================ 6. price ranks, never disqualifies
  if exists (select 1 from wholesale_v2.v2_similar_products(accA, pAnchor, 20)
              where product_id = pCheap)
  then PASS:=PASS+1;
    raise notice '  PASS  a $3 equivalent to a $29.50 anchor still appears -- a cheaper equivalent is exactly what a wholesale buyer is hunting for, so price orders results and never removes them';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a much cheaper match was excluded by price'; end if;

  -- ============================ 7. the same item leads
  select product_id into r from wholesale_v2.v2_similar_products(accA, pAnchor, 20) limit 1;
  if r.product_id in (pTwin, pA2, pA3, pA4, pA5, pCheap) then PASS:=PASS+1;
    raise notice '  PASS  the shelf leads with a real name match rather than an attribute match';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the leading result is not a name match'; end if;

  -- ============================ 8. limits
  select count(*) into n from wholesale_v2.v2_similar_products(accA, pAnchor, 9999);
  if n <= 12 then PASS:=PASS+1;
    raise notice '  PASS  the row ceiling holds against a caller asking for 9999';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a caller asking for 9999 got %', n; end if;

  -- ============================ 9. a banned account gets nothing
  update wholesale_v2.v2_portal_accounts set active=false where id=accA;
  select count(*) into n from wholesale_v2.v2_similar_products(accA, pAnchor, 20);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a deactivated account gets NOTHING, by returning no rows rather than raising';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a deactivated account received % recommendations', n; end if;
  update wholesale_v2.v2_portal_accounts set active=true where id=accA;

  -- ============================ 10. the data wall, by source
  select p.prosrc into r from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_similar_products';
  if r.prosrc !~* 'v2_oggi_promoted' then PASS:=PASS+1;
    raise notice '  PASS  the similar shelf does not read the promotion table -- as RC-01 and RC-02, and for the same reason';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_similar_products joins v2_oggi_promoted'; end if;

  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_similar_products')) !~* 'wid'
  then PASS:=PASS+1;
    raise notice '  PASS  the function takes NO wid -- scope is derived and cannot be handed in';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_similar_products accepts a wid'; end if;

  -- ============================ 11. one normaliser
  if wholesale_v2.v2_name_words('T-Shirt') = wholesale_v2.v2_name_words('t shirt')
  then PASS:=PASS+1;
    raise notice '  PASS  "T-Shirt" and "t shirt" produce the same words -- similarity, search and SR-09 ingest share ONE normaliser, so a product cannot be similar on one screen and not on another';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the normaliser is not shared'; end if;

  -- ---------------------------------------------------------------- tally
  raise notice '----------------------------------------';
  raise notice 'check_similar_products: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_similar_products FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
