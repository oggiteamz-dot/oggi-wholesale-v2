-- =============================================================================
-- CHECK: the store pricing dial (MOD-05, migration 117)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
--
-- WHAT THIS GUARDS
-- The dial decides what a buyer is CHARGED. v2_effective_unit_price prices
-- every line through a discount function, and v2_submit_order re-prices every
-- invoice line at submission. A silent change here is money, and it shows up
-- as a delivery dispute weeks later rather than as anything red.
--
-- THE ASSERTION THAT MATTERS MOST is PARITY (13): for every store x every
-- client, the store dial must return exactly what that store's DEFAULT
-- catalogue returns. That is the whole safety argument for MOD-04 -- it is
-- what makes "merge the catalogues into one store" provably not a price change.
--
-- NOTE ON MIGRATION 117'S OWN ASSERTION: it compares the same two functions,
-- but on a fresh replay into an empty database there are no wholesalers and no
-- clients, so it passes over ZERO pairs. That is correct for replay and
-- useless as evidence. This file is where the parity claim is actually earned,
-- because it brings its own corpus -- including non-zero discounts on both
-- sides, so parity cannot hold merely because everything is zero.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  w    text := 'zz_dial';
  wNeg text := 'zz_dial_up';
  cDef uuid := '00000000-0000-4000-8000-0000000c1001';
  cDefNeg uuid := '00000000-0000-4000-8000-0000000c1002';
  cliZero uuid; cliFive uuid;
  n numeric; m int;
begin
  ------------------------------------------------------------------ fixture
  insert into wholesale_v2.v2_wholesalers (wid) values (w), (wNeg);
  insert into wholesale_v2.v2_clients (wid) values (w) returning id into cliZero;
  update wholesale_v2.v2_clients set discount_pct = 0 where id = cliZero;
  insert into wholesale_v2.v2_clients (wid) values (w) returning id into cliFive;
  update wholesale_v2.v2_clients set discount_pct = 5 where id = cliFive;

  insert into wholesale_v2.v2_catalogs (id, wid, name, is_default, discount_pct, discount_mode)
  values (cDef,    w,    'ZZ Default', true, 10, 'combine'),
         (cDefNeg, wNeg, 'ZZ Markup',  true, -8, 'combine');

  update wholesale_v2.v2_wholesalers set discount_pct = 10, discount_mode = 'combine' where wid = w;
  update wholesale_v2.v2_wholesalers set discount_pct = -8, discount_mode = 'combine' where wid = wNeg;

  ------------------------------------------------------- 1. columns are real
  select count(*) into m from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_wholesalers'
     and column_name in ('discount_pct','discount_mode') and is_nullable='NO';
  if m = 2 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1: dial columns missing or nullable (found %)', m; end if;

  ------------------------------------------- 2. a new store starts at ZERO
  -- A store defaulting to a non-zero dial would reprice every product of every
  -- wholesaler created from that day on, with nothing on screen looking wrong.
  insert into wholesale_v2.v2_wholesalers (wid) values ('zz_dial_fresh');
  select discount_pct into n from wholesale_v2.v2_wholesalers where wid='zz_dial_fresh';
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 2: a new store did not default to 0%%, got %', n; end if;

  ------------------------------------------- 3. the mode is constrained
  begin
    update wholesale_v2.v2_wholesalers set discount_mode = 'whatever' where wid='zz_dial_fresh';
    FAIL := FAIL+1; raise warning 'FAIL 3: discount_mode accepted an unknown value';
  exception when check_violation then PASS := PASS+1;
  end;

  ------------------------------------------- 4. combine = store + customer
  n := wholesale_v2.v2_store_discount_pct(w, cliFive);
  if n = 15 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4: combine gave %, expected 15', n; end if;

  ------------------------------------------- 5. combine, customer on zero
  n := wholesale_v2.v2_store_discount_pct(w, cliZero);
  if n = 10 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 5: combine with a 0%% customer gave %, expected 10', n; end if;

  ------------------------------------------- 6. catalog_only ignores the customer
  update wholesale_v2.v2_wholesalers set discount_mode='catalog_only' where wid=w;
  n := wholesale_v2.v2_store_discount_pct(w, cliFive);
  if n = 10 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 6: catalog_only gave %, expected 10 (customer must be ignored)', n; end if;

  ------------------------------------------- 7. customer_only, customer wins
  update wholesale_v2.v2_wholesalers set discount_mode='customer_only' where wid=w;
  n := wholesale_v2.v2_store_discount_pct(w, cliFive);
  if n = 5 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 7: customer_only gave %, expected 5', n; end if;

  ------------------------------------------- 8. THE QUIRK: 0%% customer falls back
  -- Documented behaviour since migration 053: a customer_only store with a
  -- customer on 0%% falls back to the STORE rate rather than charging list.
  -- Removing this quietly reprices every such client to full price.
  n := wholesale_v2.v2_store_discount_pct(w, cliZero);
  if n = 10 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8: customer_only + 0%% customer gave %, expected the 10%% store fallback', n; end if;
  update wholesale_v2.v2_wholesalers set discount_mode='combine' where wid=w;

  ------------------------------------------- 9. a NEGATIVE dial sells ABOVE list
  n := wholesale_v2.v2_store_discount_pct(wNeg, null);
  if n = -8 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 9: a markup store gave %, expected -8', n; end if;

  ------------------------------------------- 10. no client -> store rate only
  n := wholesale_v2.v2_store_discount_pct(w, null);
  if n = 10 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 10: a null client gave %, expected 10', n; end if;

  ------------------------------------------- 11. an unknown store is 0, not null
  n := wholesale_v2.v2_store_discount_pct('zz_no_such_store', null);
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 11: an unknown wid gave %, expected 0', n; end if;

  ------------------------------------------- 12. EXACTLY ONE overload
  -- Migration 113 added a defaulted argument to v2_marketplace_feed, which
  -- created a second overload instead of replacing it. PostgREST then refused
  -- BOTH with PGRST203 and the live feed broke until 114 dropped the old one.
  select count(*) into m from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_store_discount_pct';
  if m = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 12: % overloads of v2_store_discount_pct -- PostgREST will refuse all of them', m; end if;

  ------------------------------------------- 13. PARITY over the whole corpus
  -- The safety argument for MOD-04, in one assertion.
  select count(*) filter (
           where wholesale_v2.v2_store_discount_pct(x.wid, x.cid)
              is distinct from
                 wholesale_v2.v2_catalog_discount_pct(x.did, x.cid))
    into m
    from (select ww.wid, dc.id did, cl.id cid
            from wholesale_v2.v2_wholesalers ww
            join wholesale_v2.v2_catalogs dc on dc.wid = ww.wid and dc.is_default
            cross join wholesale_v2.v2_clients cl) x;
  if m = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 13: % (store, client) pairs would be repriced by the switch-over', m; end if;

  ------------------------------------------- 14. parity is not vacuous
  -- Without this, assertion 13 passes perfectly on a corpus where every dial
  -- and every customer discount is zero -- which proves nothing at all.
  select count(*) into m
    from wholesale_v2.v2_wholesalers ww
    cross join wholesale_v2.v2_clients cl
   where wholesale_v2.v2_store_discount_pct(ww.wid, cl.id) <> 0;
  if m > 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 14: every pair resolves to 0%% -- assertion 13 proved nothing'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_store_pricing_dial: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_store_pricing_dial FAILED (% of % assertions)', FAIL, PASS+FAIL;
  end if;
end $$;

rollback;
