-- =============================================================================
-- CHECK: search across the stores a buyer actually has  (SR-01, SR-10, mig 092)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real function.
--
-- ONE ASSERTION MATTERS MORE THAN ALL THE OTHERS COMBINED:
--
--   a product belonging to a store this buyer cannot enter must NEVER appear,
--   no matter how perfectly it matches the query.
--
-- Everything else here is a convenience feature. That one is the difference
-- between a marketplace and a data leak, so the fixture plants a product in a
-- forbidden store with a name ENGINEERED to be the single best match for the
-- query, and asserts it is absent.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wMine text := 'zz_s_mine'; wAlso text := 'zz_s_also'; wForbid text := 'zz_s_forbid';
  cli uuid; acc uuid; person uuid; pMine uuid; pAlso uuid; pForbid uuid;
  n int; v_name text; v_price numeric;
begin
  -- ---------------------------------------------------------------- fixture --
  insert into public.wholesalers (wid, name, active) values
    (wMine,'Zed Mine Co',true),(wAlso,'Zed Also Co',true),(wForbid,'Zed Forbidden Co',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wMine),(wAlso),(wForbid);

  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wMine,'Zed Search Shop','03 777 888') returning id into cli;
  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active)
    values (wMine, cli, 'buyer','zzsearchbuyer','x','Zed Searcher',true) returning id into acc;
  perform wholesale_v2.v2_backfill_person_identity();
  select person_id into person from wholesale_v2.v2_portal_accounts where id = acc;

  -- The buyer is ALSO a member of a second store. Cross-store is the feature.
  insert into wholesale_v2.v2_person_memberships (person_id, wid, role, active)
    values (person, wAlso, 'buyer', true);

  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wMine,'Zed Blue Denim Jacket','Outerwear',false) returning id into pMine;
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wAlso,'Zed Blue Denim Shirt','Shirts',false) returning id into pAlso;
  -- The trap: the BEST possible match, in a store they cannot enter.
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wForbid,'Zed Blue Denim','Denim',false) returning id into pForbid;
  -- And an archived one in a store they CAN enter.
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wMine,'Zed Blue Denim Retired','Outerwear',true);

  insert into wholesale_v2.v2_product_variants (product_id, sku, price) values
    (pMine,'ZED-M-1', 25.00), (pMine,'ZED-M-2', 19.50),
    (pAlso,'ZED-A-1', 30.00),
    (pForbid,'ZED-F-1', 1.00);

  -- ==================== THE ASSERTION THAT MATTERS ========================
  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Blue Denim',50,0)
   where wid = wForbid;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a product in a store this buyer CANNOT enter never appears -- even as the best match';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  LEAK: % product(s) from a forbidden store were returned', n; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Blue Denim',50,0);
  if n = 2 then PASS:=PASS+1;
    raise notice '  PASS  SR-01 both stores the buyer IS in are searched (2 results)';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  expected 2 results across the two member stores, got %', n; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Blue Denim',50,0)
   where wid = wAlso;
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  a store joined only by MEMBERSHIP (not the login''s own wid) is searched';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the second membership store contributed % rows', n; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'Retired',50,0);
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  archived products are not searchable';
  else FAIL:=FAIL+1; raise warning '  FAIL  an archived product was returned'; end if;

  -- ==================== SCOPE CANNOT BE WIDENED ===========================
  select count(*) into n from wholesale_v2.v2_search_products(
    '00000000-0000-0000-0000-000000000000'::uuid,'Zed Blue Denim',50,0);
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  an unverifiable account searches nothing';
  else FAIL:=FAIL+1; raise warning '  FAIL  an unknown account got % rows', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and pg_get_function_identity_arguments(p.oid) ilike '%wid%';
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the function takes no wid -- there is nothing a caller can claim';
  else FAIL:=FAIL+1; raise warning '  FAIL  a wid argument exists'; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'z',50,0);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a one-character query returns nothing rather than the whole catalogue';
  else FAIL:=FAIL+1; raise warning '  FAIL  a single character matched % products', n; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed',100000,0);
  if n <= 100 then PASS:=PASS+1; raise notice '  PASS  an absurd page size is clamped';
  else FAIL:=FAIL+1; raise warning '  FAIL  page size not clamped: %', n; end if;

  -- ==================== WHAT IT RETURNS ===================================
  select price_from into v_price from wholesale_v2.v2_search_products(acc,'Denim Jacket',50,0)
   where wid = wMine;
  if v_price = 19.50 then PASS:=PASS+1;
    raise notice '  PASS  price_from is the LOWEST listed price, not an arbitrary one';
  else FAIL:=FAIL+1; raise warning '  FAIL  price_from was %, expected 19.50', v_price; end if;

  select wholesaler_name into v_name from wholesale_v2.v2_search_products(acc,'Denim Jacket',50,0)
   where wid = wMine;
  if v_name = 'Zed Mine Co' then PASS:=PASS+1;
    raise notice '  PASS  every result says WHICH wholesaler it came from';
  else FAIL:=FAIL+1; raise warning '  FAIL  wholesaler name was "%"', v_name; end if;

  -- name match must outrank a category-only match
  select product_id into pMine from wholesale_v2.v2_search_products(acc,'Denim',50,0) limit 1;
  if pMine is not null then PASS:=PASS+1; raise notice '  PASS  results come back ranked, name matches first';
  else FAIL:=FAIL+1; raise warning '  FAIL  ranking returned nothing'; end if;

  -- ==================== SR-08 SUBSET: ARABIC ==============================
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wMine, E'قَمِيص أَزْرَق', 'Shirts', false);
  select count(*) into n from wholesale_v2.v2_search_products(acc, E'قميص', 50, 0);
  if n >= 1 then PASS:=PASS+1;
    raise notice '  PASS  a buyer typing Arabic WITHOUT diacritics finds a product stored WITH them';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  plain "قميص" did not match "قَمِيص" -- the commonest Arabic search failure there is'; end if;

  -- ⚠️ THIS ASSERTION EXISTS BECAUSE THE LOCAL REPLAY WAS BLIND TO A REAL BUG.
  -- The first version of v2_search_normalise stripped diacritics using the
  -- range [U+0610-U+0670], which SPANS the Arabic-Indic digits at
  -- U+0660-U+0669. A query of ٣ was deleted before it could become 3.
  -- Production's own migration assertion caught it and refused to land; this
  -- gate, running on PostgreSQL 16 locally, had passed it. A gate that cannot
  -- reproduce the environment it protects is a gate with a blind spot, so the
  -- case is asserted here too -- on the FUNCTION, end to end, not on a regex.
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (wMine, E'Zed Pack of ٣', 'Packs', false);
  select count(*) into n from wholesale_v2.v2_search_products(acc, 'Pack of 3', 50, 0);
  if n >= 1 then PASS:=PASS+1;
    raise notice '  PASS  a buyer typing ASCII "3" finds a product listed with Arabic ٣';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  Arabic-Indic digits are not folded end to end -- "3" did not find "٣"'; end if;

  if wholesale_v2.v2_search_normalise(E'٣') = '3' then PASS:=PASS+1;
    raise notice '  PASS  and the normaliser itself folds ٣ to 3 rather than deleting it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the normaliser returned "%" for ٣ -- the digit was eaten, not converted', wholesale_v2.v2_search_normalise(E'٣'); end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc, E'ازرق', 50, 0);
  if n >= 1 then PASS:=PASS+1; raise notice '  PASS  alef folding works (ازرق finds أَزْرَق)';
  else FAIL:=FAIL+1; raise warning '  FAIL  alef forms are not folded in a real search'; end if;

  -- ==================== SR-10: THE MISS LOG ===============================
  select count(*) into n from wholesale_v2.v2_search_misses;
  perform wholesale_v2.v2_search_products(acc,'zzz-nothing-matches-this',50,0);
  select count(*) into n from wholesale_v2.v2_search_misses where q_normalised like '%zzz nothing matches this%';
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  SR-10 a search that found nothing is logged -- buyers telling you what you do not stock';
  else FAIL:=FAIL+1; raise warning '  FAIL  the zero-result query was not logged (found %)', n; end if;

  select count(*) into n from wholesale_v2.v2_search_misses where q_raw = 'zzz-nothing-matches-this';
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  the RAW query is kept too -- the only way to tell a bad normalisation rule from an absent product';
  else FAIL:=FAIL+1; raise warning '  FAIL  the raw query text was not kept'; end if;

  select count(*) into n from wholesale_v2.v2_search_misses
   where q_normalised like '%zzz nothing%' and wForbid = any(wids);
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  the miss log records only the stores actually searched';
  else FAIL:=FAIL+1; raise warning '  FAIL  the miss log names a store the buyer cannot enter'; end if;

  -- a SUCCESSFUL search must not be logged as a miss
  select count(*) into n from wholesale_v2.v2_search_misses where q_normalised like '%denim jacket%';
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  a search that DID find something is not logged as a miss';
  else FAIL:=FAIL+1; raise warning '  FAIL  a successful search was recorded as a miss'; end if;

  -- ==================== NO LEAK THROUGH THE LOG ===========================
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_search_misses' and grantee='anon';
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  anon holds nothing on the miss log';
  else FAIL:=FAIL+1; raise warning '  FAIL  anon holds % grant(s) on the miss log', n; end if;

  raise notice '----------------------------------------';
  raise notice 'check_cross_store_search: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_cross_store_search FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
