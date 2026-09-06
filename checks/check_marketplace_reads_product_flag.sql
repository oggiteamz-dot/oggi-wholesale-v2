-- =============================================================================
-- CHECK: the marketplace reads the PRODUCT flag (MOD-03, migration 119)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
-- SAFE TO POINT AT PRODUCTION.
--
-- WHAT THIS GUARDS
--
-- 116 put `is_public` on the product. 119 is the migration that made anything
-- READ it: v2_marketplace_feed and v2_marketplace_search stopped reaching the
-- publicness rule through `join v2_catalog_products -> join v2_catalogs ->
-- where c.is_public` and now ask `p.is_public` directly.
--
-- The assertions below are BEHAVIOURAL, not structural, because the structural
-- ones are the easy half and they are the half that lies. Grepping the body
-- for "is_public" passes on a function that reads the CATALOGUE's is_public.
-- So this file builds two products that the two rules DISAGREE about and asks
-- the live functions which one they obey:
--
--   pFlag  is_public = true,  in NO catalogue at all      -> MUST appear
--   pJoin  is_public = false, in a PUBLIC catalogue       -> MUST NOT appear
--
-- Under the old join pFlag is invisible and pJoin is in the marketplace. Under
-- the new rule it is the other way round. There is no way to pass both while
-- reading the wrong column, and no way to pass either by accident.
--
-- BOTH FUNCTIONS, IN ONE FILE, ON PURPOSE. The failure this is really written
-- against is not "the feed is wrong" -- it is the feed and the search
-- disagreeing about what public means. When they diverge the WIDER one wins
-- silently: a private line is simply in the results and nothing on any screen
-- looks broken. Assertion 8 compares the two sets directly for that reason.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
--
-- Migration 119 proved, at apply time, that the flag and the catalogue join
-- select the IDENTICAL set of products across the whole corpus -- 0 gained,
-- 0 lost. That equality is not repeated here, and the omission is deliberate.
-- It was a property of one moment: the moment the rule moved. The whole point
-- of moving it is that a wholesaler will publish a product that belongs to no
-- catalogue, and on that day corpus equality is correctly false. A gate that
-- asserted it would go red the first time the store model did the thing it
-- was built to do, and a gate that cries wolf gets ignored -- which is how
-- check_buyer_product_card sat red on main for five days.
--
-- Assertion 9 keeps the one corpus-wide property that survives catalogues:
-- the marketplace is not empty. Without it, "the two sets agree" is satisfied
-- perfectly by a marketplace that returns nothing at all.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  w      text := 'zz_m3';
  wOff   text := 'zz_m3_off';
  cat    text := 'ZZM3Cat';
  cPub uuid := '00000000-0000-4000-8000-0000000c3001';
  cPrv uuid := '00000000-0000-4000-8000-0000000c3002';
  pFlag uuid; pJoin uuid; pBoth uuid; pArch uuid; pOff uuid;
  n int; feed_ids uuid[]; srch_ids uuid[];
begin
  -- ---------- fixture ----------
  insert into public.wholesalers (wid, name, active) values
    (w,    'ZZ MOD-03 Co',      true),
    (wOff, 'ZZ MOD-03 Off Co',  false);
  insert into wholesale_v2.v2_wholesalers (wid) values (w), (wOff);

  insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
  values (cPub, w, 'ZZ M3 Published', 1, true, true,  'tok_zz_m3_pub'),
         (cPrv, w, 'ZZ M3 Private',   1, true, false, 'tok_zz_m3_prv');

  -- The disagreement. Every product carries ZZM3TOKEN in its name so the
  -- search has one query that reaches all of them and nothing else.
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (w, 'ZZM3TOKEN flagged, uncatalogued', cat, false, true)
    returning id into pFlag;
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (w, 'ZZM3TOKEN unflagged, in a public catalogue', cat, false, false)
    returning id into pJoin;
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (w, 'ZZM3TOKEN flagged, in a public catalogue', cat, false, true)
    returning id into pBoth;
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (w, 'ZZM3TOKEN flagged but archived', cat, true, true)
    returning id into pArch;
  insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
    values (wOff, 'ZZM3TOKEN flagged, shop switched off', cat, false, true)
    returning id into pOff;

  insert into wholesale_v2.v2_catalog_products (catalog_id, product_id) values
    (cPub, pJoin), (cPub, pBoth), (cPrv, pFlag);

  select array_agg(f.product_id order by f.product_id) into feed_ids
    from wholesale_v2.v2_marketplace_feed(null, 100, 0, cat, 'woven') f;
  select array_agg(s.product_id order by s.product_id) into srch_ids
    from wholesale_v2.v2_marketplace_search(null, 'ZZM3TOKEN', 100, 0) s;

  -- ---------- 1. THE FLAG ADMITS, with no catalogue anywhere ----------
  -- pFlag belongs to one PRIVATE catalogue and no public one. Under the join
  -- it is invisible. It must be in the feed.
  if pFlag = any(coalesce(feed_ids, '{}')) then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 1: the feed does not show a product flagged public -- it is still reading the catalogue join';
  end if;

  -- ---------- 2. THE LEAK TEST: the catalogue no longer admits ----------
  -- pJoin sits in a PUBLIC catalogue with is_public = false. Under the join it
  -- is in the marketplace. This is the assertion that a half-done MOD-03 fails.
  if not (pJoin = any(coalesce(feed_ids, '{}'))) then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 2: LEAK -- an unpublished product reached the feed through its catalogue';
  end if;

  -- ---------- 3. the ordinary case still works ----------
  if pBoth = any(coalesce(feed_ids, '{}')) then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 3: a flagged, catalogued product is missing from the feed';
  end if;

  -- ---------- 4. archived still filters AT RUNTIME ----------
  -- Deliberately never folded into the flag (see 116): archived is a state
  -- that changes on its own, and a flag cannot follow it.
  if not (pArch = any(coalesce(feed_ids, '{}'))) then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 4: an archived product is in the feed';
  end if;

  -- ---------- 5. an inactive shop still filters AT RUNTIME ----------
  if not (pOff = any(coalesce(feed_ids, '{}'))) then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 5: a switched-off shop is selling in the feed';
  end if;

  -- ---------- 6. the SEARCH obeys the flag too ----------
  if pFlag = any(coalesce(srch_ids, '{}')) then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 6: the search does not show a product flagged public -- it is still reading the catalogue join';
  end if;

  -- ---------- 7. THE LEAK TEST, in the search ----------
  if not (pJoin = any(coalesce(srch_ids, '{}'))) then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 7: LEAK -- an unpublished product reached the search through its catalogue';
  end if;

  -- ---------- 8. NO DRIFT: the feed and the search agree ----------
  -- The same fixture, reached two ways, must give the same set. This is the
  -- assertion the other seven exist to make meaningful: any future edit that
  -- changes the rule in one function and not the other lands here.
  if coalesce(feed_ids, '{}') = coalesce(srch_ids, '{}') then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 8: DRIFT -- feed returned %, search returned %', feed_ids, srch_ids;
  end if;

  -- ---------- 9. the marketplace is not empty ----------
  -- The converse guard. Assertions 2, 4, 5, 7 are all satisfied perfectly by a
  -- marketplace that shows nothing to anyone.
  select count(*) into n from wholesale_v2.v2_marketplace_feed(null, 100, 0, null, 'woven');
  if n > 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 9: the marketplace feed is empty';
  end if;

  -- ---------- 10. unflagging removes it, live ----------
  -- Same transaction, one column, both functions. Proves the flag is READ on
  -- every call rather than baked into something that was true when we looked.
  update wholesale_v2.v2_products set is_public = false where id = pFlag;
  select count(*) into n from wholesale_v2.v2_marketplace_feed(null, 100, 0, cat, 'woven') f
   where f.product_id = pFlag;
  select n + count(*) into n from wholesale_v2.v2_marketplace_search(null, 'ZZM3TOKEN', 100, 0) s
   where s.product_id = pFlag;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 10: unpublishing a product did not remove it from the marketplace';
  end if;
  update wholesale_v2.v2_products set is_public = true where id = pFlag;

  -- ---------- 11. no catalogue join is left in either body ----------
  -- Structural, and last on purpose: it is the weakest assertion here. It
  -- catches the edit that adds the join back for some new reason without
  -- anyone noticing the rule came back with it.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_marketplace_feed', 'v2_marketplace_search')
     and pg_get_functiondef(p.oid) like '%v2_catalog_products%';
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 11: % marketplace function(s) still join the catalogue tables', n;
  end if;

  -- ---------- 12. exactly one overload of each ----------
  -- Migration 113 added a DEFAULTED argument to the feed and created a SECOND
  -- overload instead of replacing it; PostgREST answered PGRST203 to every
  -- call and the live marketplace was blank until 114 dropped the old one.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_marketplace_feed', 'v2_marketplace_search');
  if n = 2 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 12: expected 2 marketplace functions, found % -- PostgREST will answer PGRST203', n;
  end if;

  raise notice '----------------------------------------';
  raise notice 'check_marketplace_reads_product_flag: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_marketplace_reads_product_flag FAILED (% of % assertions)', FAIL, PASS + FAIL;
  end if;
end $$;

rollback;
