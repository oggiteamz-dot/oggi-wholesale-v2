-- =============================================================================
-- CHECK: the buyer sees the whole store (MOD-04, migration 118)
-- =============================================================================
-- Transaction + ROLLBACK. Uses checks/fixture_store_read.sql, which stubs the
-- two functions v2_buyer_store_read delegates to, so the REAL body of
-- v2_buyer_store_read is what runs here.
--
-- THE ASSERTION THAT MATTERS is 6: if the gate returns nothing, the store read
-- must return nothing. v2_buyer_store_read deliberately does NOT re-derive
-- "which catalogues may this account see" -- it calls v2_buyer_catalogs. If a
-- future edit ever inlines that logic to "make it faster", the two answers can
-- drift, and the day they do the WIDER one wins silently and a buyer sees a
-- catalogue nobody granted them. This asserts the delegation, not the wording.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  acc uuid := '00000000-0000-4000-8000-0000000e0001';
  other uuid := '00000000-0000-4000-8000-0000000e0002';
  cDef uuid := '00000000-0000-4000-8000-0000000e1001';
  cTwo uuid := '00000000-0000-4000-8000-0000000e1002';
  pA uuid := '00000000-0000-4000-8000-0000000e2001';  -- default only
  pB uuid := '00000000-0000-4000-8000-0000000e2002';  -- second only
  pBoth uuid := '00000000-0000-4000-8000-0000000e2003';
  vA uuid := '00000000-0000-4000-8000-0000000e3001';
  vB uuid := '00000000-0000-4000-8000-0000000e3002';
  vBoth uuid := '00000000-0000-4000-8000-0000000e3003';
  n int; s int; nm text;
begin
  insert into zz_visible values (acc, cDef, 1), (acc, cTwo, 2);

  insert into zz_rows values
    (cDef, pA,    'ZZ Default Only', 10, vA,    'sku-a', 10, false),
    (cTwo, pB,    'ZZ Second Only',  20, vB,    'sku-b', 20, false),
    -- the same product+variant in BOTH, with different merchandising
    (cDef, pBoth, 'ZZ In Both',       1, vBoth, 'sku-both', 30, true),
    (cTwo, pBoth, 'ZZ In Both',      99, vBoth, 'sku-both', 30, false);

  -- 1. everything visible today is still visible
  select count(*) into n from wholesale_v2.v2_buyer_store_read(acc) s
   where s.product_id in (pA, pBoth);
  if n = 2 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1: the default catalogue lost rows (got %)', n; end if;

  -- 2. THE POINT: a product only in the SECOND catalogue is now reachable
  select count(*) into n from wholesale_v2.v2_buyer_store_read(acc) s
   where s.product_id = pB;
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 2: a product in a non-default catalogue is still invisible'; end if;

  -- 3. a product in TWO catalogues appears exactly ONCE
  select count(*) into n from wholesale_v2.v2_buyer_store_read(acc) s
   where s.product_id = pBoth;
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 3: a product in two catalogues appeared % times', n; end if;

  -- 4. and it is the DEFAULT catalogue's row that survives
  -- sort_order and `highlighted` are the wholesaler's merchandising on their
  -- MAIN shelf; a secondary catalogue must not silently overwrite it.
  select s.sort_order into n from wholesale_v2.v2_buyer_store_read(acc) s
   where s.product_id = pBoth;
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4: the SECOND catalogue won the dedupe (sort_order %, expected 1)', n; end if;

  -- 5. no (product, variant) is duplicated anywhere
  select count(*) into n from (
    select s.product_id, s.variant_id from wholesale_v2.v2_buyer_store_read(acc) s
     group by s.product_id, s.variant_id having count(*) > 1) z;
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 5: % duplicated (product, variant) rows', n; end if;

  -- 6. THE GATE. An account the gate does not know returns NOTHING.
  select count(*) into n from wholesale_v2.v2_buyer_store_read(other);
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 6: an ungranted account read % rows -- the gate is bypassed', n; end if;

  -- 7. a null account returns nothing rather than raising
  begin
    select count(*) into n from wholesale_v2.v2_buyer_store_read(null);
    if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
      raise warning 'FAIL 7: a null account read % rows', n; end if;
  exception when others then
    FAIL := FAIL+1; raise warning 'FAIL 7: a null account RAISED instead of returning nothing';
  end;

  -- 8. the default catalogue's products come first
  select s.product_name into nm from wholesale_v2.v2_buyer_store_read(acc) s limit 1;
  if nm = 'ZZ In Both' then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8: ordering does not put the default catalogue first (got %)', nm; end if;

  -- 9. EXACTLY ONE overload (the PGRST203 trap -- 113/114)
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_buyer_store_read';
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 9: % overloads -- PostgREST will refuse all of them', n; end if;

  -- 10. the store read is a strict SUPERSET of the default catalogue read
  -- Stated as containment rather than as a count, because a count can match
  -- while the CONTENTS differ -- the lesson check_marketplace_search learned.
  select count(*) into n
    from wholesale_v2.v2__catalog_rows(cDef) t
   where not exists (select 1 from wholesale_v2.v2_buyer_store_read(acc) s
                      where s.product_id = t.product_id and s.variant_id = t.variant_id);
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 10: % rows of the default catalogue are missing from the store', n; end if;

  raise notice '----------------------------------------';
  raise notice 'check_buyer_store_read: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_buyer_store_read FAILED (% of % assertions)', FAIL, PASS+FAIL;
  end if;
end $$;

rollback;
