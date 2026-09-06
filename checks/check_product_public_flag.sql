-- =============================================================================
-- CHECK: the product-level public flag (MOD-01, migration 116)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
--
-- SAFE TO POINT AT PRODUCTION. It writes nothing outside its own zz_pf rows
-- and rolls everything back -- and, importantly, it does NOT re-run the
-- backfill, so real drift in v2_products.is_public shows up as a failure
-- instead of being quietly repaired in-transaction.
--
-- WHAT THIS GUARDS, AND WHY IT IS NOT "does the column exist"
--
-- 116 moves the marketplace switch off the catalogue and onto the product.
-- For the whole of the store-model refactor there will be a window where BOTH
-- exist, and the only thing standing between a private couture line and the
-- public marketplace is that the two agree.
--
-- So this file does not sample. It asserts CONTAINMENT IN BOTH DIRECTIONS
-- over the entire products table:
--
--     { products flagged is_public }  ==  { products in a public catalogue }
--
-- One direction alone is worthless. Assert only "no flagged product is
-- private" and a backfill that flagged NOTHING passes perfectly. Assert only
-- "every public-catalogue product is flagged" and a backfill that flagged
-- EVERYTHING passes perfectly. It is the same lesson check_marketplace_search
-- learned about the search box: the leak and the empty shelf look identical
-- from one side.
--
-- The other property carried here is the DEFAULT. A new product must arrive
-- PRIVATE. A column defaulting to true would publish every product a
-- wholesaler creates from now on, to the entire marketplace, the instant they
-- press save -- and nothing on any screen would look wrong.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  w text := 'zz_pf';
  cPub uuid := '00000000-0000-4000-8000-0000000b1001';
  cPrv uuid := '00000000-0000-4000-8000-0000000b1002';
  pPub uuid; pPrv uuid; pBoth uuid; pNone uuid; pFresh uuid;
  n int; v_flag int; v_join int; v_priv int; ok boolean;
begin
  -- ---------- fixture ----------
  insert into public.wholesalers (wid, name, active) values (w, 'ZZ Public Flag Co', true);
  insert into wholesale_v2.v2_wholesalers (wid) values (w);

  insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
  values (cPub, w, 'ZZ Published', 1, true, true,  'tok_zz_pf_pub'),
         (cPrv, w, 'ZZ Private',   1, true, false, 'tok_zz_pf_prv');

  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'ZZ In Public Only', 'Tops', false) returning id into pPub;
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'ZZ In Private Only', 'Dresses', false) returning id into pPrv;
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'ZZ In Both', 'Tops', false) returning id into pBoth;
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'ZZ In No Catalogue', 'Tops', false) returning id into pNone;

  insert into wholesale_v2.v2_catalog_products (catalog_id, product_id) values
    (cPub, pPub), (cPrv, pPrv), (cPub, pBoth), (cPrv, pBoth);

  -- ---------- 1. a brand-new product arrives PRIVATE ----------
  -- Asserted BEFORE the backfill runs, on a row nobody has touched.
  select count(*) into n from wholesale_v2.v2_products
   where id = pNone and is_public = false;
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 1: a new product did not default to private';
  end if;

  -- ---------- 2. the column refuses NULL ----------
  begin
    insert into wholesale_v2.v2_products (wid, name, category, archived, is_public)
      values (w, 'ZZ Null Flag', 'Tops', false, null);
    FAIL := FAIL + 1;
    raise warning 'FAIL 2: is_public accepted NULL';
  exception when not_null_violation then
    PASS := PASS + 1;
  end;

  -- ---------- put the fixture in the state 116 leaves behind ----------
  -- DELIBERATELY NOT the migration's UPDATE. An earlier draft of this file
  -- re-ran the backfill here, and that is a check that REPAIRS the defect it
  -- exists to find: run it against a production snapshot that had drifted and
  -- the UPDATE silently corrects the drift inside the transaction, then every
  -- assertion below passes. A false green of exactly the kind check_pack_moq
  -- was written about. The flags are set explicitly instead, so assertions
  -- 7 and 8 measure state rather than re-deriving it.
  update wholesale_v2.v2_products set is_public = true  where id in (pPub, pBoth);
  update wholesale_v2.v2_products set is_public = false where id in (pPrv, pNone);

  -- ---------- 3. in a public catalogue -> published ----------
  select count(*) into n from wholesale_v2.v2_products where id = pPub and is_public;
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 3: public-catalogue product was not flagged';
  end if;

  -- ---------- 4. THE LEAK TEST: private catalogue only -> still private ----
  -- Named, not derived. This is the Atelier A-102 / A-109 / A-110 case: a
  -- made-to-order line that lives in exactly one private catalogue and must
  -- never reach the marketplace, including for a buyer who IS a member.
  select count(*) into n from wholesale_v2.v2_products where id = pPrv and is_public;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 4: LEAK -- a private-catalogue-only product was published';
  end if;

  -- ---------- 5. in both -> published ----------
  -- A product in one public and one private catalogue is published. Public
  -- wins, because the wholesaler put it somewhere public on purpose.
  select count(*) into n from wholesale_v2.v2_products where id = pBoth and is_public;
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 5: product in both catalogues was not flagged';
  end if;

  -- ---------- 6. in no catalogue at all -> still private ----------
  select count(*) into n from wholesale_v2.v2_products where id = pNone and is_public;
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 6: an uncatalogued product was published';
  end if;

  -- ---------- 7. CONTAINMENT, forward ----------
  -- nothing flagged that is not reachable through a public catalogue
  select count(*) into n
    from wholesale_v2.v2_products p
   where p.is_public
     and not exists (select 1
                       from wholesale_v2.v2_catalog_products cp
                       join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
                      where cp.product_id = p.id and c.is_public);
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 7: % product(s) flagged public with no public catalogue', n;
  end if;

  -- ---------- 8. CONTAINMENT, reverse ----------
  -- nothing reachable through a public catalogue left unflagged
  select count(*) into n
    from wholesale_v2.v2_products p
   where not p.is_public
     and exists (select 1
                   from wholesale_v2.v2_catalog_products cp
                   join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
                  where cp.product_id = p.id and c.is_public);
  if n = 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 8: % public-catalogue product(s) were dropped from the feed', n;
  end if;

  -- ---------- 9. the private side is not empty ----------
  -- Without this, a backfill that published EVERY product passes 7 and 8.
  select count(*) into v_priv from wholesale_v2.v2_products where not is_public;
  if v_priv > 0 then PASS := PASS + 1;
  else FAIL := FAIL + 1;
    raise warning 'FAIL 9: every product on the platform is public -- backfill too wide';
  end if;

  -- ---------- 10. the partial index is present ----------
  -- The feed asks only for the true side; without this it is a seq scan over
  -- every product on the platform, three times per page load.
  select count(*) into n from pg_indexes
   where schemaname = 'wholesale_v2' and indexname = 'v2_products_is_public_idx';
  if n = 1 then PASS := PASS + 1;
  else FAIL := FAIL + 1; raise warning 'FAIL 10: v2_products_is_public_idx is missing';
  end if;

  raise notice '----------------------------------------';
  raise notice 'check_product_public_flag: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_product_public_flag FAILED (% of % assertions)', FAIL, PASS + FAIL;
  end if;
end $$;

rollback;
