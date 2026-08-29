-- =============================================================================
-- CHECK: the promoted slot (SR-02, SR-03, migration 093)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real function.
--
-- THE ASSERTION THIS FILE EXISTS FOR:
--
--   turning every promotion OFF must not change the organic ordering AT ALL.
--
-- That is what "a fixed, labelled, bounded slot -- never boosted inside organic
-- relevance" means, expressed as something a machine can check. Every
-- marketplace later fined for self-preferencing could have written this
-- assertion and chose not to. It is cheap: capture the organic order with
-- promotions live, switch them off, capture it again, compare.
--
-- If someone later "optimises" the function by folding promotion into the
-- rank -- which is the natural thing to do and completely invisible from the
-- outside -- this goes red.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wid1 text := 'zz_p_one'; cli uuid; acc uuid; person uuid;
  pA uuid; pB uuid; pC uuid; pD uuid;
  n int; before_order text; after_order text; v_slot text; v_bool boolean;
begin
  insert into public.wholesalers (wid, name, active) values (wid1,'Zed Promo Co',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wid1);
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wid1,'Zed Promo Shop','03 222 111') returning id into cli;
  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active)
    values (wid1, cli,'buyer','zzpromobuyer','x','Zed Promo',true) returning id into acc;
  perform wholesale_v2.v2_backfill_person_identity();
  select person_id into person from wholesale_v2.v2_portal_accounts where id = acc;

  -- Four matching products. Names chosen so alphabetical order is knowable.
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wid1,'Zed Widget Alpha','Widgets',false) returning id into pA;
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wid1,'Zed Widget Bravo','Widgets',false) returning id into pB;
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wid1,'Zed Widget Charlie','Widgets',false) returning id into pC;
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wid1,'Zed Widget Delta','Widgets',false) returning id into pD;

  -- ============ THE FAIRNESS PROPERTY =====================================
  -- Organic order with NO promotions at all.
  select string_agg(product_name, '|' order by ord) into before_order from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
     where slot = 'organic') q;

  -- Now promote the LAST one alphabetically. If promotion leaks into ranking,
  -- Delta moves, and it moves in the most tempting direction: to the top.
  insert into wholesale_v2.v2_oggi_promoted (product_id, commission_pct, active)
    values (pD, 12.5, true);

  select string_agg(product_name, '|' order by ord) into after_order from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
     where slot = 'organic') q;

  if before_order = after_order then PASS:=PASS+1;
    raise notice '  PASS  SR-03 promoting a product does NOT change the organic ordering';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  SELF-PREFERENCING: organic order changed when a promotion was added';
    raise warning '        before: %', before_order;
    raise warning '        after : %', after_order;
  end if;

  -- ...and switching it off again must restore nothing, because nothing moved.
  update wholesale_v2.v2_oggi_promoted set active = false where product_id = pD;
  select string_agg(product_name, '|' order by ord) into after_order from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
     where slot = 'organic') q;
  if before_order = after_order then PASS:=PASS+1;
    raise notice '  PASS  and turning it off changes nothing either -- the two are independent';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  organic order differs with promotion disabled'; end if;
  update wholesale_v2.v2_oggi_promoted set active = true where product_id = pD;

  -- ============ THE SLOT ITSELF ===========================================
  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where slot = 'promoted';
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  SR-02 the promoted product appears in its own slot';
  else FAIL:=FAIL+1; raise warning '  FAIL  expected 1 promoted row, got %', n; end if;

  select is_promoted into v_bool from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where slot = 'promoted' limit 1;
  if v_bool then PASS:=PASS+1;
    raise notice '  PASS  it is FLAGGED, so a screen cannot present it as an ordinary result by accident';
  else FAIL:=FAIL+1; raise warning '  FAIL  the promoted row is not flagged'; end if;

  -- A promoted product must ALSO still appear organically, in its honest place.
  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where slot='organic' and product_name = 'Zed Widget Delta';
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  a promoted product still appears organically in its honest position -- the shelf ADDS to the results, it does not replace them';
  else FAIL:=FAIL+1; raise warning '  FAIL  the promoted product vanished from the organic list'; end if;

  -- ============ BOUNDED ===================================================
  insert into wholesale_v2.v2_oggi_promoted (product_id, active) values
    (pA,true),(pB,true),(pC,true);
  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where slot='promoted';
  if n = 3 then PASS:=PASS+1;
    raise notice '  PASS  SR-03 the slot is CAPPED at 3 even with 4 promoted -- a shelf, not a takeover';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the promoted slot returned % rows; the cap is 3', n; end if;

  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where slot='organic';
  if n = 4 then PASS:=PASS+1;
    raise notice '  PASS  and the organic list still holds all 4 -- capping the shelf did not hide anything';
  else FAIL:=FAIL+1; raise warning '  FAIL  organic list has % rows, expected 4', n; end if;

  -- ============ THE COMMISSION IS NOT THE BUYER'S BUSINESS ================
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and (pg_get_function_result(p.oid) ilike '%commission%' or p.prosrc ilike '%commission_pct%');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the commission rate is never returned or even referenced by search';
  else FAIL:=FAIL+1; raise warning '  FAIL  search touches commission_pct'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_oggi_promoted' and grantee='anon';
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  anon cannot read the promotion arrangement';
  else FAIL:=FAIL+1; raise warning '  FAIL  anon holds % grant(s) on v2_oggi_promoted', n; end if;

  -- ============ SR-04, THE DATA WALL ======================================
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products' and p.prosrc ilike '%v2_orders%';
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  SR-04 search never reads v2_orders -- no wholesaler sales data informs what OGGI promotes';
  else FAIL:=FAIL+1; raise warning '  FAIL  search reads v2_orders'; end if;

  -- ============ PROMOTION CANNOT CROSS THE ACCESS BOUNDARY ================
  -- A promoted product in a store this buyer cannot enter is still invisible.
  insert into public.wholesalers (wid,name,active) values ('zz_p_far','Zed Far Co',true);
  insert into wholesale_v2.v2_wholesalers (wid) values ('zz_p_far');
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values ('zz_p_far','Zed Widget Echo','Widgets',false) returning id into pA;
  insert into wholesale_v2.v2_oggi_promoted (product_id, active) values (pA, true);
  select count(*) into n from wholesale_v2.v2_search_products(acc,'Zed Widget',50,0)
   where product_name = 'Zed Widget Echo';
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  promoting a product does NOT let it cross into a buyer who has no access to that store';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  LEAK: a promoted product from a forbidden store reached the buyer'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_promoted_slot: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_promoted_slot FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
