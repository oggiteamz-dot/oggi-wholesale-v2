-- =============================================================================
-- CHECK: the visibility mirror (SR-06, migration 094)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real functions.
--
-- 093 made wholesalers a promise: the paid shelf does not touch your ranking.
-- This file checks the thing that makes that promise VERIFIABLE BY THEM rather
-- than merely true — and checks that the mirror itself does not become a new
-- leak in the process.
--
-- TWO PROPERTIES CARRY THE FILE:
--
--   1. a wholesaler sees their OWN visibility and nobody else's
--   2. the impression log CANNOT identify who searched, because that column
--      does not exist — not because a filter excludes it
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wMine text := 'zz_m_mine'; wRival text := 'zz_m_rival';
  cli uuid; acc uuid; person uuid; pMine uuid; pRival uuid;
  n int; r record; ev uuid := gen_random_uuid(); ev2 uuid := gen_random_uuid();
  uMine uuid := gen_random_uuid(); uRival uuid := gen_random_uuid();
begin
  insert into public.wholesalers (wid,name,active) values (wMine,'Zed Mirror Co',true),(wRival,'Zed Rival Co',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wMine),(wRival);
  -- v2_my_wid() reads v2_user_profiles by auth.uid(), and auth.uid() reads
  -- `sub` from request.jwt.claims. Setting a `wid` claim directly (which an
  -- earlier version of this fixture did) resolves to NULL and every number
  -- below comes back empty -- a fixture failure that looks exactly like a
  -- broken feature.
  insert into auth.users (id, email) values (uMine,'zzmine@x.test'),(uRival,'zzrival@x.test');
  insert into wholesale_v2.v2_user_profiles (id, role, wid, wholesaler_name)
    values (uMine,'wholesaler',wMine,'Zed Mirror Co'),
           (uRival,'wholesaler',wRival,'Zed Rival Co');
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wMine,'Zed Mirror Shop','03 909 909') returning id into cli;
  insert into wholesale_v2.v2_portal_accounts (wid,client_id,role,username,password_hash,actor_label,active)
    values (wMine,cli,'buyer','zzmirrorbuyer','x','Zed Mirror',true) returning id into acc;
  perform wholesale_v2.v2_backfill_person_identity();
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wMine,'Zed Mirror Widget','Widgets',false) returning id into pMine;
  insert into wholesale_v2.v2_products (wid,name,category,archived)
    values (wRival,'Zed Rival Widget','Widgets',false) returning id into pRival;

  -- ============ THE PRIVACY RULE ==========================================
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_search_impressions'
     and (column_name ilike '%person%' or column_name ilike '%account%'
       or column_name ilike '%buyer%' or column_name ilike '%client%');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the impression log has NO column identifying the searcher -- wholesalers read this table, and not collecting beats filtering';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  % column(s) identify the searcher; a wholesaler could learn who is shopping', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_search_impressions' and grantee='anon';
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  anon holds nothing on the impression log';
  else FAIL:=FAIL+1; raise warning '  FAIL  anon holds % grant(s)', n; end if;

  if not has_function_privilege('anon','wholesale_v2.v2_search_visibility_mirror(integer)','execute') then
    PASS:=PASS+1; raise notice '  PASS  a buyer (anon) cannot read a wholesaler''s visibility report';
  else FAIL:=FAIL+1; raise warning '  FAIL  anon can execute the mirror'; end if;

  -- ============ NO CALLER MAY NAME A WHOLESALER ===========================
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2'
     and p.proname in ('v2_search_visibility_mirror','v2_search_visibility_queries')
     and pg_get_function_identity_arguments(p.oid) ilike '%wid%';
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  neither visibility function takes a wid -- one wholesaler cannot ask for another''s numbers';
  else FAIL:=FAIL+1; raise warning '  FAIL  a wid argument exists on a visibility function'; end if;

  -- ============ THE NUMBERS ===============================================
  -- One search where my product was 2nd and a RIVAL's paid placement was shown.
  insert into wholesale_v2.v2_search_impressions (event_id,q_normalised,wid,product_id,position,slot) values
    (ev,'widget',wRival,pRival,1,'promoted'),
    (ev,'widget',wRival,pRival,1,'organic'),
    (ev,'widget',wMine, pMine, 2,'organic');
  -- A second search with no paid placement at all; my product was 1st.
  insert into wholesale_v2.v2_search_impressions (event_id,q_normalised,wid,product_id,position,slot) values
    (ev2,'widget',wMine,pMine,1,'organic');

  -- Read as the wholesaler. v2_my_wid() is resolved from the session, so the
  -- fixture sets it the way the app does.
  perform set_config('request.jwt.claims', json_build_object('sub', uMine, 'role','authenticated')::text, true);

  select * into r from wholesale_v2.v2_search_visibility_mirror(30);
  if r.impressions = 2 then PASS:=PASS+1; raise notice '  PASS  impressions counts only MY rows (2), not the rival''s';
  else FAIL:=FAIL+1; raise warning '  FAIL  impressions = %, expected 2', r.impressions; end if;

  if r.searches = 2 then PASS:=PASS+1; raise notice '  PASS  searches counts distinct events (2)';
  else FAIL:=FAIL+1; raise warning '  FAIL  searches = %, expected 2', r.searches; end if;

  if r.avg_position = 1.50 then PASS:=PASS+1; raise notice '  PASS  average organic position is honest (1.50 across 1st and 2nd)';
  else FAIL:=FAIL+1; raise warning '  FAIL  avg_position = %, expected 1.50', r.avg_position; end if;

  if r.outranked_by_paid = 1 then PASS:=PASS+1;
    raise notice '  PASS  SR-06 THE NUMBER THAT MATTERS: 1 search where someone else''s PAID placement appeared alongside my product';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  outranked_by_paid = %, expected 1', r.outranked_by_paid; end if;

  if r.outranked_pct = 50.0 then PASS:=PASS+1; raise notice '  PASS  and as a percentage of my searches (50.0%%)';
  else FAIL:=FAIL+1; raise warning '  FAIL  outranked_pct = %, expected 50.0', r.outranked_pct; end if;

  -- ============ MY OWN PROMOTION IS NOT "BEING OUTRANKED" =================
  perform set_config('request.jwt.claims', json_build_object('sub', uRival, 'role','authenticated')::text, true);
  select * into r from wholesale_v2.v2_search_visibility_mirror(30);
  if r.outranked_by_paid = 0 then PASS:=PASS+1;
    raise notice '  PASS  the wholesaler who WAS promoted is not counted as outranked by it -- they were the one being promoted';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the promoted wholesaler was counted as outranked % time(s)', r.outranked_by_paid; end if;

  -- ============ CROSS-TENANT ==============================================
  if r.impressions = 1 then PASS:=PASS+1;
    raise notice '  PASS  the rival sees only their own 1 organic impression, never mine';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the rival''s mirror reports % impressions; it should see only its own', r.impressions; end if;

  -- ============ THE QUERY LIST ============================================
  perform set_config('request.jwt.claims', json_build_object('sub', uMine, 'role','authenticated')::text, true);
  select count(*) into n from wholesale_v2.v2_search_visibility_queries(30,20) where q_normalised='widget';
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  a wholesaler can see WHICH searches showed their products';
  else FAIL:=FAIL+1; raise warning '  FAIL  the query list returned % rows for "widget"', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_visibility_mirror'
     and (pg_get_function_result(p.oid) ilike '%product_name%' or pg_get_function_result(p.oid) ilike '%competitor%');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the mirror reports THAT they were outranked, never BY WHAT -- it is not a competitor feed';
  else FAIL:=FAIL+1; raise warning '  FAIL  the mirror exposes competitor product detail'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_visibility_mirror: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_visibility_mirror FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
