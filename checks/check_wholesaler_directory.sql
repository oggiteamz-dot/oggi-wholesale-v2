-- =============================================================================
-- CHECK: the wholesaler directory (DR-01..DR-05, migration 091)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the REAL functions, never a copy of them.
--
-- The directory is the first screen that shows a buyer something belonging to
-- a business that has not let them in. So the assertions come in two families,
-- and the second matters more:
--
--   DOES IT SHOW THE RIGHT THING   -- every active wholesaler, their
--                                     categories, and whether I am already in
--   DOES IT WITHHOLD THE REST      -- no products, no prices, nothing about an
--                                     inactive business, and nothing at all to
--                                     a caller whose account cannot be verified
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_dir_a'; wB text := 'zz_dir_b'; wOff text := 'zz_dir_off';
  cli uuid; acc uuid; person uuid; catid uuid; prod uuid;
  n int; r record; v_msg text; okflag boolean;
begin
  -- ---------------------------------------------------------------- fixture --
  insert into public.wholesalers (wid, name, brand, active) values
    (wA,'Zed Alpha Textiles','Zed Alpha',true),
    (wB,'Zed Beta Trading','Zed Beta',true),
    (wOff,'Zed Closed Co','Zed Closed',false);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wOff);

  -- A buyer who belongs to A and not to B.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wA,'Zed Buyer Shop','03 111 222') returning id into cli;
  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active)
    values (wA, cli, 'buyer','zzdirbuyer','x','Zed Buyer',true) returning id into acc;
  perform wholesale_v2.v2_backfill_person_identity();
  select person_id into person from wholesale_v2.v2_portal_accounts where id = acc;

  -- A DECLARED category on A, and a DERIVED one on B (from a live product).
  insert into wholesale_v2.v2_categories (name, sort_order, active)
    values ('ZedDeclaredCat', 1, true) returning id into catid;
  insert into wholesale_v2.v2_wholesaler_categories (wid, category_id) values (wA, catid);
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wB, 'Zed Secret Product', 'ZedDerivedCat', false) returning id into prod;
  -- An ARCHIVED product must not speak for a business.
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wB, 'Zed Old Product', 'ZedArchivedCat', true);

  -- ===================== FAMILY 1: DOES IT SHOW THE RIGHT THING ============
  select count(*) into n from wholesale_v2.v2_directory_list(acc, null, 100, 0)
   where wid in (wA, wB);
  if n = 2 then PASS:=PASS+1; raise notice '  PASS  DR-01 both active wholesalers are listed';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-01 expected 2 active wholesalers, got %', n; end if;

  select access into v_msg from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wA;
  if v_msg = 'member' then PASS:=PASS+1; raise notice '  PASS  the store this buyer belongs to reads as "member"';
  else FAIL:=FAIL+1; raise warning '  FAIL  own store read as "%" instead of member', msg; end if;

  select access into v_msg from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wB;
  if v_msg = 'none' then PASS:=PASS+1; raise notice '  PASS  a store they have never asked about reads as "none"';
  else FAIL:=FAIL+1; raise warning '  FAIL  unknown store read as "%" instead of none', msg; end if;

  select categories into r from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wA;
  if 'ZedDeclaredCat' = any(r.categories) then PASS:=PASS+1; raise notice '  PASS  DR-02 a DECLARED category is shown';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-02 declared category missing: %', r.categories; end if;

  select categories into r from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wB;
  if 'ZedDerivedCat' = any(r.categories) then PASS:=PASS+1; raise notice '  PASS  DR-02 a category DERIVED from live products is shown';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-02 derived category missing: %', r.categories; end if;

  if not ('ZedArchivedCat' = any(r.categories)) then PASS:=PASS+1; raise notice '  PASS  an ARCHIVED product does not speak for the business';
  else FAIL:=FAIL+1; raise warning '  FAIL  an archived product contributed a category'; end if;

  select count(*) into n from wholesale_v2.v2_directory_list(acc, 'Zed Beta', 100, 0);
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  DR-03 search by name narrows to one';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-03 search returned % rows, expected 1', n; end if;

  select count(*) into n from wholesale_v2.v2_directory_list(acc, 'zed beta', 100, 0);
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  DR-03 search is case-insensitive';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-03 lowercase search returned %', n; end if;

  -- ===================== FAMILY 2: DOES IT WITHHOLD THE REST ===============
  select count(*) into n from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wOff;
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  an INACTIVE wholesaler is not in the directory at all';
  else FAIL:=FAIL+1; raise warning '  FAIL  a deactivated business is still listed'; end if;

  -- DR-05, stated as a fact about the shape of the answer rather than about
  -- one row: there is nowhere in the return type to PUT a price.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_directory_list'
     and (pg_get_function_result(p.oid) ilike '%price%'
       or pg_get_function_result(p.oid) ilike '%product%'
       or pg_get_function_result(p.oid) ilike '%sku%'
       or pg_get_function_result(p.oid) ilike '%count%');
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  DR-05 no price, product or count anywhere in the projection';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-05 the directory projection can carry a product, price or count'; end if;

  -- The product name planted on B must not appear anywhere in what A''s buyer
  -- can read, including inside the category array.
  select count(*) into n from wholesale_v2.v2_directory_list(acc, null, 100, 0) d
   where array_to_string(d.categories, ' ') ilike '%Zed Secret Product%';
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  a product NAME from a store they cannot enter never appears';
  else FAIL:=FAIL+1; raise warning '  FAIL  a product name leaked through the category array'; end if;

  select count(*) into n from wholesale_v2.v2_directory_list(
    '00000000-0000-0000-0000-000000000000'::uuid, null, 100, 0);
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  an unverifiable account gets NOTHING (not an error, not everything)';
  else FAIL:=FAIL+1; raise warning '  FAIL  an unknown account id read % directory rows', n; end if;

  -- A caller-supplied limit is clamped, not obeyed. 100000 is a scrape.
  select count(*) into n from wholesale_v2.v2_directory_list(acc, null, 100000, 0);
  if n <= 100 then PASS:=PASS+1; raise notice '  PASS  an absurd page size is clamped to 100';
  else FAIL:=FAIL+1; raise warning '  FAIL  page size was not clamped: % rows', n; end if;

  -- ===================== FAMILY 3: DR-04, ASKING FOR ACCESS ================
  select d.ok, d.msg into okflag, v_msg from wholesale_v2.v2_directory_request_access(acc::text, wB, 'please') d;
  if okflag then PASS:=PASS+1; raise notice '  PASS  DR-04 a buyer can ask a wholesaler for access';
  else FAIL:=FAIL+1; raise warning '  FAIL  DR-04 request refused: %', msg; end if;

  select count(*) into n from wholesale_v2.v2_signup_requests
   where wid = wB and person_id = person and status = 'pending';
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  it lands in v2_signup_requests -- the SAME queue Door B reviews';
  else FAIL:=FAIL+1; raise warning '  FAIL  expected 1 pending request attributed to the person, found %', n; end if;

  select access into v_msg from wholesale_v2.v2_directory_list(acc, null, 100, 0) where wid = wB;
  if v_msg = 'pending' then PASS:=PASS+1; raise notice '  PASS  the directory now shows that store as "pending"';
  else FAIL:=FAIL+1; raise warning '  FAIL  after asking, the store reads as "%"', msg; end if;

  select d.ok into okflag from wholesale_v2.v2_directory_request_access(acc::text, wB, 'again') d;
  if not okflag then PASS:=PASS+1; raise notice '  PASS  asking twice is refused rather than queued twice';
  else FAIL:=FAIL+1; raise warning '  FAIL  a second request was accepted -- the wholesaler now reviews it twice'; end if;

  select d.ok into okflag from wholesale_v2.v2_directory_request_access(acc::text, wA, null) d;
  if not okflag then PASS:=PASS+1; raise notice '  PASS  asking a store you are already in is refused';
  else FAIL:=FAIL+1; raise warning '  FAIL  a member was allowed to request access to their own store'; end if;

  select d.ok into okflag from wholesale_v2.v2_directory_request_access(acc::text, wOff, null) d;
  if not okflag then PASS:=PASS+1; raise notice '  PASS  you cannot ask an inactive wholesaler for access';
  else FAIL:=FAIL+1; raise warning '  FAIL  a request was accepted for a deactivated business'; end if;

  select d.ok into okflag from wholesale_v2.v2_directory_request_access('not-a-uuid', wB, null) d;
  if not okflag then PASS:=PASS+1; raise notice '  PASS  a malformed account id is refused, not crashed on';
  else FAIL:=FAIL+1; raise warning '  FAIL  a malformed account id was accepted'; end if;

  select d.ok into okflag from wholesale_v2.v2_directory_request_access(
    '00000000-0000-0000-0000-000000000000', wB, null) d;
  if not okflag then PASS:=PASS+1; raise notice '  PASS  an unknown account cannot mint requests in someone else''s name';
  else FAIL:=FAIL+1; raise warning '  FAIL  an unverified account created a signup request'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_wholesaler_directory: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_wholesaler_directory FAILED with % problem(s)', FAIL;
  end if;
end $$;

rollback;
