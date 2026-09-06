-- =============================================================================
-- CHECK: the tier gate is gone, and the TENANT boundary is not (MOD-07, mig 120)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
-- SAFE TO POINT AT PRODUCTION.
--
-- WHAT THIS GUARDS
--
-- D2: "Tier two, gate. Drop it. Completely remove it." `access_tier` was
-- compared in exactly two places and both comparisons are gone, so a member of
-- a store now sees that store.
--
-- THIS FILE EXISTS FOR THE OTHER HALF OF THAT SENTENCE.
--
-- `v2_catalog_by_token` returned 'denied' from TWO adjacent blocks:
--
--     v_acct.wid is distinct from v_cat.wid   -> 'denied'    THE TENANT BOUNDARY
--     v_tier < v_cat.access_tier              -> 'denied'    the tier gate
--
-- Same string, four lines apart, one of them the only thing standing between
-- one wholesaler's private catalogue and another wholesaler's customers. A
-- careless removal takes the wrong one and the screen still says "denied"
-- often enough to look fine -- a stranger is still denied, a signed-out visitor
-- is still asked to log in, and only a buyer who happens to belong to a
-- DIFFERENT shop gets in.
--
-- So the assertions come in matched pairs. Every "the gate is gone" assertion
-- has a "and this is still shut" assertion beside it, in both directions:
-- A must not reach B, and B must not reach A. A file that only proved the gate
-- was gone would pass perfectly on a build that had deleted the tenant check
-- instead -- which is exactly what red proof B does, and it fires.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_t7_a';
  wB text := 'zz_t7_b';
  cLow  uuid := '00000000-0000-4000-8000-00000007a001';
  cHigh uuid := '00000000-0000-4000-8000-00000007a002';
  cOff  uuid := '00000000-0000-4000-8000-00000007a003';
  cPub  uuid := '00000000-0000-4000-8000-00000007a004';
  cB    uuid := '00000000-0000-4000-8000-00000007b001';
  clA uuid; clB uuid; acctA uuid; acctB uuid; pOnly uuid;
  n int; st text;
begin
  -- ---------- fixture: two shops, and a buyer in each at the LOWEST tier ------
  insert into public.wholesalers (wid, name, active) values
    (wA, 'ZZ Tier Gate A', true), (wB, 'ZZ Tier Gate B', true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA), (wB);

  insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
  values (cLow,  wA, 'ZZ A Open Shelf',      1, true,  false, 'tok_zz_t7_low'),
         (cHigh, wA, 'ZZ A Tier Five Only',  5, true,  false, 'tok_zz_t7_high'),
         (cOff,  wA, 'ZZ A Switched Off',    1, false, false, 'tok_zz_t7_off'),
         (cPub,  wA, 'ZZ A Public',          5, true,  true,  'tok_zz_t7_pub'),
         (cB,    wB, 'ZZ B Private',         1, true,  false, 'tok_zz_t7_b');

  -- A product that lives ONLY behind the old tier-5 gate. On production no such
  -- product exists, which is why removing the gate moved nothing; the fixture
  -- brings one so the assertion measures the RULE rather than today's data.
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (wA, 'ZZ T7 Behind The Gate', 'Tops', false, false) returning id into pOnly;
  insert into wholesale_v2.v2_catalog_products (catalog_id, product_id) values (cHigh, pOnly);

  insert into wholesale_v2.v2_clients (wid, shop_name, access_tier)
    values (wA, 'ZZ A Buyer Shop', 1) returning id into clA;
  insert into wholesale_v2.v2_clients (wid, shop_name, access_tier)
    values (wB, 'ZZ B Buyer Shop', 1) returning id into clB;

  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
    values (wA, 'buyer', 'zz_t7_a_buyer', 'x', clA, 'ZZ A Buyer') returning id into acctA;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
    values (wB, 'buyer', 'zz_t7_b_buyer', 'x', clB, 'ZZ B Buyer') returning id into acctB;

  -- ---------- 1. THE GATE IS GONE: tier 1 buyer sees the tier 5 catalogue -----
  select count(*) into n from wholesale_v2.v2_buyer_catalogs(acctA) c where c.id = cHigh;
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 1: a tier-1 buyer still cannot see a tier-5 catalogue in their own store';
  end if;

  -- ---------- 2. the ordinary catalogue is still there ------------------------
  select count(*) into n from wholesale_v2.v2_buyer_catalogs(acctA) c where c.id = cLow;
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 2: the buyer lost their open-shelf catalogue';
  end if;

  -- ---------- 3. TENANT BOUNDARY in the LIST ----------------------------------
  -- Store A's buyer must not enumerate store B's catalogue. This is the
  -- assertion that a build which deleted `c.wid = v_acct.wid` instead of the
  -- tier comparison fails.
  select count(*) into n from wholesale_v2.v2_buyer_catalogs(acctA) c where c.id = cB;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 3: CROSS-TENANT -- store A buyer can enumerate store B catalogue';
  end if;

  -- ---------- 4. and in the other direction -----------------------------------
  select count(*) into n from wholesale_v2.v2_buyer_catalogs(acctB) c
   where c.id in (cLow, cHigh, cPub);
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 4: CROSS-TENANT -- store B buyer can enumerate % of store A catalogues', n;
  end if;

  -- ---------- 5. an inactive catalogue is still hidden ------------------------
  select count(*) into n from wholesale_v2.v2_buyer_catalogs(acctA) c where c.id = cOff;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 5: a switched-off catalogue is being listed';
  end if;

  -- ---------- 6. the PRODUCT behind the old gate is now orderable -------------
  -- The list widening is only worth anything if the store read follows it.
  select count(*) into n from wholesale_v2.v2_buyer_store_read(acctA) r where r.product_id = pOnly;
  if n > 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 6: the product behind the old tier gate is still unreachable';
  end if;

  -- ---------- 7. and store B still cannot reach it ----------------------------
  select count(*) into n from wholesale_v2.v2_buyer_store_read(acctB) r where r.product_id = pOnly;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 7: CROSS-TENANT -- store B buyer can order store A product';
  end if;

  -- ---------- 8. THE GATE IS GONE on the share link ---------------------------
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_high', acctA);
  if st = 'ok' then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 8: the tier-5 link still answers % to a tier-1 buyer of that store', st;
  end if;

  -- ---------- 9. TENANT BOUNDARY on the share link ----------------------------
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_b', acctA);
  if st = 'denied' then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 9: CROSS-TENANT -- store A buyer opened store B private link (%)', st;
  end if;

  -- ---------- 10. and in the other direction ----------------------------------
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_high', acctB);
  if st = 'denied' then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 10: CROSS-TENANT -- store B buyer opened store A private link (%)', st;
  end if;

  -- ---------- 11. a signed-out visitor is still asked to log in ---------------
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_high', null);
  if st = 'login_required' then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 11: signed-out visitor got % on a private link', st;
  end if;

  -- ---------- 12. a public catalogue still opens for a stranger ---------------
  -- The is_public short-circuit sits ABOVE the deleted block and must survive.
  -- Note this one is tier 5: proof the short-circuit never consulted the tier.
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_pub', null);
  if st = 'ok' then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 12: a public link stopped opening (%)', st;
  end if;

  -- ---------- 13. a switched-off catalogue's link is not found ----------------
  select status into st from wholesale_v2.v2_catalog_by_token('tok_zz_t7_off', acctA);
  if st = 'not_found' then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 13: a switched-off catalogue answered % by token', st;
  end if;

  -- ---------- 14. no tier comparison is left in either body -------------------
  -- Structural, and last on purpose: it is the weakest assertion here, and it
  -- cannot tell the tier gate from the tenant check. 1-13 are what do that.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_buyer_catalogs', 'v2_catalog_by_token')
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') like '%v_tier%';
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 14: % function(s) still carry a tier comparison', n;
  end if;

  -- ---------- 15. exactly one overload of each --------------------------------
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_buyer_catalogs', 'v2_catalog_by_token');
  if n = 2 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 15: expected 2 functions, found % -- PostgREST will answer PGRST203', n;
  end if;

  raise notice '----------------------------------------';
  raise notice 'check_tier_gate_removed: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_tier_gate_removed FAILED (% of % assertions)', FAIL, PASS + FAIL;
  end if;
end $$;

rollback;
