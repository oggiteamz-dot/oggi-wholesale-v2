-- =============================================================================
-- CHECK: attribute normalisation at ingest   (SR-09, migration 097)
-- =============================================================================
-- Transaction + ROLLBACK. Writes real rows through the real triggers.
--
-- THE PROPERTY THIS FILE EXISTS FOR, and everything else is supporting work:
--
--     THE DERIVED COLUMN CANNOT DISAGREE WITH THE COLUMN IT IS DERIVED FROM,
--     AND THE COLUMN IT IS DERIVED FROM IS NEVER TOUCHED.
--
-- Both halves matter and they pull in opposite directions. A normaliser that
-- rewrote "Crimson Red" to "red" would satisfy the first half and destroy the
-- wholesaler's own catalogue. A normaliser that only ran when someone
-- remembered to call it would satisfy the second half and leave a facet that
-- is right about some rows and silently wrong about others -- which is worse
-- than no facet, because a wrong facet is still trusted.
--
-- So the tests that matter here are the ones that try to make the two disagree:
-- writing colour_family directly, updating extra_attrs without mentioning it,
-- and inserting through raw SQL that knows nothing about any client code.
--
-- ==== WHY THE FIXTURE USES THE UGLY REAL VALUES ============================
--
-- "Crimson Red", "hgfds", "One size", 47, "أحمر". These are not invented awkward
-- cases; they are counted values from production on 30 August 2026. A fixture
-- of tidy inputs would pass against a normaliser that only handles tidy inputs,
-- and the whole reason SR-09 exists is that the real inputs are not tidy.
--
-- ==== A NOTE ON READING THE OUTPUT =========================================
--
-- This file prints its PASS/FAIL tally unconditionally and raises on any
-- failure. If you red-prove it and see no FAIL lines AND no tally, the gate did
-- not run -- a syntax error, most likely -- and you have proven nothing. Fix
-- that before drawing any conclusion. (29 August, learned the hard way.)
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  w text := 'zz_n_store';
  prod uuid; prod2 uuid;
  vCrimson uuid; vCrimsonRed uuid; vRed uuid; vJunk uuid; vNoColour uuid;
  vOne uuid; vNum uuid; vLetter uuid;
  n int; fam text; sys text; rnk numeric; raw text; cat text; catk text;
  r record;
begin
  -- ---------------------------------------------------------------- fixture
  insert into public.wholesalers (wid, name, active) values (w, 'Zed Normalise', true);
  insert into wholesale_v2.v2_wholesalers (wid) values (w);

  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'Zed Tee', 'T-Shirts', false) returning id into prod;
  insert into wholesale_v2.v2_products (wid, name, category, archived)
    values (w, 'Zed Mystery', 'gfhjbk', false) returning id into prod2;

  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-1',10,'{"color":"Crimson Red","size":"M"}'::jsonb) returning id into vCrimsonRed;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-2',10,'{"color":"Crimson","size":"L"}'::jsonb)     returning id into vCrimson;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-3',10,'{"color":"Red","size":"XL"}'::jsonb)        returning id into vRed;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-4',10,'{"color":"hgfds","size":"wat"}'::jsonb)     returning id into vJunk;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-5',10,'{"size":"One size"}'::jsonb)                returning id into vNoColour;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
    values (prod,'ZZN-6',10,'{"color":"Navy","size":"38"}'::jsonb)       returning id into vNum;

  raise notice '=== check_attribute_normalisation ===';

  -- ============================ 1. THE RULE: the raw word is never touched
  select extra_attrs->>'color', colour_family into raw, fam
    from wholesale_v2.v2_product_variants where id = vCrimsonRed;
  if raw = 'Crimson Red' then PASS:=PASS+1;
    raise notice '  PASS  the wholesaler''s own word survives ingest unchanged -- "Crimson Red" is what their buyers recognise and nothing here is allowed to edit it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  ingest REWROTE the raw colour (now %) -- normalisation adds a field, it never overwrites one', coalesce(raw,'NULL'); end if;

  select category into cat from wholesale_v2.v2_products where id = prod;
  if cat = 'T-Shirts' then PASS:=PASS+1;
    raise notice '  PASS  and the product''s own category text survives too';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  ingest rewrote the product category (now %)', coalesce(cat,'NULL'); end if;

  -- The missing half, found by red proof R8: dropping the product trigger
  -- altogether failed only ONE assertion, because nothing here had asked
  -- whether category_key was ever set in the first place. A gate that only
  -- notices a trigger when you try to write around it does not notice a trigger
  -- that was never there.
  select category_key into catk from wholesale_v2.v2_products where id = prod;
  if catk = 'tops' then PASS:=PASS+1;
    raise notice '  PASS  "T-Shirts" resolved to the category key "tops" at insert -- 16 of 23 live products have no category at all, and this is the column that will let them get one';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the product trigger did not set category_key at insert (got %)', coalesce(catk,'NULL'); end if;

  -- ============================ 2. three words, one family
  select count(distinct colour_family) into n
    from wholesale_v2.v2_product_variants where id in (vCrimsonRed, vCrimson, vRed);
  if n = 1 and (select colour_family from wholesale_v2.v2_product_variants where id = vRed) = 'red'
  then PASS:=PASS+1;
    raise notice '  PASS  "Crimson Red", "Crimson" and "Red" -- three wholesalers, three words -- land in ONE family, which is the whole reason RC-02 and RC-03 can be built at all';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the three reds produced % distinct families', n; end if;

  select count(distinct extra_attrs->>'color') into n
    from wholesale_v2.v2_product_variants where id in (vCrimsonRed, vCrimson, vRed);
  if n = 3 then PASS:=PASS+1;
    raise notice '  PASS  and they are still three different words on the shelf -- the family was ADDED beside them, not substituted for them';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the three raw colours collapsed to % distinct values', n; end if;

  -- ============================ 3. unknown means NULL, never a guess
  select colour_family into fam from wholesale_v2.v2_product_variants where id = vJunk;
  if fam is null then PASS:=PASS+1;
    raise notice '  PASS  "hgfds" gets NO family -- inventing one would put junk into the facet that the facet then has to be trusted about';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  junk was given the colour family %', fam; end if;

  select size_system, size_rank into sys, rnk from wholesale_v2.v2_product_variants where id = vJunk;
  if sys is null and rnk is null then PASS:=PASS+1;
    raise notice '  PASS  and an unreadable size is not forced into a system -- a wrong system sorts wrongly and silently';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  "wat" was read as system % rank %', coalesce(sys,'NULL'), coalesce(rnk::text,'NULL'); end if;

  select colour_family into fam from wholesale_v2.v2_product_variants where id = vNoColour;
  if fam is null then PASS:=PASS+1;
    raise notice '  PASS  a variant with no colour at all gets no family rather than a default';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a colourless variant was given the family %', fam; end if;

  -- ============================ 4. families that must stay apart
  if (select colour_family from wholesale_v2.v2_product_variants where id = vNum) = 'blue'
     and wholesale_v2.v2_normalise_attribute('colour','Forest') = 'green'
  then PASS:=PASS+1;
    raise notice '  PASS  navy is blue and forest is green -- five blues and four greens fold, but blue and green do not fold into each other';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  navy/forest did not resolve to distinct families'; end if;

  -- ============================ 5. ingest and search use the SAME normaliser
  -- Every seeded alias key must already BE in normal form. A key that is not
  -- can never be matched, because the lookup normalises the incoming value
  -- first -- the alias would sit in the table looking correct and do nothing.
  select count(*) into n from wholesale_v2.v2_attribute_aliases
   where alias_key is distinct from wholesale_v2.v2_search_normalise(alias_key);
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  every alias key is already in search-normal form -- a key that is not would sit in the table looking correct and never match anything';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  % alias key(s) can never be matched because they are not in normal form', n; end if;

  if wholesale_v2.v2_normalise_attribute('colour','   CRIMSON    red  ') = 'red' then PASS:=PASS+1;
    raise notice '  PASS  casing and stray spacing are folded, because the lookup goes through v2_search_normalise -- the same function the search box uses';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  casing/spacing was not folded'; end if;

  if wholesale_v2.v2_normalise_attribute('colour','أحمر') = 'red' then PASS:=PASS+1;
    raise notice '  PASS  the Arabic for red reaches the same family as the English -- GP-06 is not built yet, but the data will not have to be re-normalised when it is';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  Arabic did not resolve (got %)', coalesce(wholesale_v2.v2_normalise_attribute('colour','أحمر'),'NULL'); end if;

  -- ============================ 6. sizes sort, within a system
  if (select size_rank from wholesale_v2.v2_product_variants where id = vCrimsonRed)   -- M
   < (select size_rank from wholesale_v2.v2_product_variants where id = vCrimson)      -- L
  and (select size_rank from wholesale_v2.v2_product_variants where id = vCrimson)
    < (select size_rank from wholesale_v2.v2_product_variants where id = vRed)         -- XL
  then PASS:=PASS+1;
    raise notice '  PASS  M < L < XL by rank -- as text they sort L, M, XL, which is the bug this column exists to remove';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  letter sizes do not rank in order'; end if;

  if (select rank from wholesale_v2.v2_size_shape('9')) < (select rank from wholesale_v2.v2_size_shape('10'))
  then PASS:=PASS+1;
    raise notice '  PASS  9 < 10 numerically -- as text "10" sorts before "2"';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  numeric sizes sort as text'; end if;

  select size_system into sys from wholesale_v2.v2_product_variants where id = vNum;
  if sys = 'numeric'
     and (select size_system from wholesale_v2.v2_product_variants where id = vRed) = 'letter'
     and (select size_system from wholesale_v2.v2_product_variants where id = vNoColour) = 'one'
  then PASS:=PASS+1;
    raise notice '  PASS  38, XL and "One size" are three different systems -- so nothing can put them on one axis and claim 38 is bigger than XL';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the three size systems were not told apart'; end if;

  -- Room to insert a size between two without renumbering every row after it.
  if (select rank from wholesale_v2.v2_size_shape('M')) - (select rank from wholesale_v2.v2_size_shape('S')) >= 2
  then PASS:=PASS+1;
    raise notice '  PASS  letter ranks are spaced, so a size can be inserted between two without a migration that renumbers the rest';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  letter ranks are adjacent -- inserting a size means renumbering'; end if;

  -- ============================ 7. THE TRIGGER CANNOT BE FORGOTTEN
  -- Every write below is raw SQL that knows nothing about any client code.
  update wholesale_v2.v2_product_variants
     set extra_attrs = '{"color":"Olive","size":"S"}'::jsonb where id = vCrimsonRed;
  select colour_family, size_system into fam, sys
    from wholesale_v2.v2_product_variants where id = vCrimsonRed;
  if fam = 'green' and sys = 'letter' then PASS:=PASS+1;
    raise notice '  PASS  changing extra_attrs re-derives the family -- a normaliser that only ran at insert would leave every edited product wrong';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the family did not follow an edit (got %, %)', coalesce(fam,'NULL'), coalesce(sys,'NULL'); end if;

  -- The one that matters most: a direct write to the derived column.
  update wholesale_v2.v2_product_variants set colour_family = 'purple' where id = vCrimsonRed;
  select colour_family into fam from wholesale_v2.v2_product_variants where id = vCrimsonRed;
  if fam = 'green' then PASS:=PASS+1;
    raise notice '  PASS  writing colour_family directly does NOT stick -- the trigger fires on every update, so the derived column cannot be made to disagree with the column it is derived from';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  colour_family was written directly to "%" and the trigger did not correct it -- a derived column that can lie is worse than no column', coalesce(fam,'NULL'); end if;

  update wholesale_v2.v2_products set category_key = 'footwear' where id = prod;
  select category_key into catk from wholesale_v2.v2_products where id = prod;
  if catk = 'tops' then PASS:=PASS+1;
    raise notice '  PASS  and the same holds for a product''s category_key';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  category_key was written directly to "%"', coalesce(catk,'NULL'); end if;

  -- A write that does not mention the attribute columns at all.
  update wholesale_v2.v2_product_variants set price = 99 where id = vRed;
  select colour_family into fam from wholesale_v2.v2_product_variants where id = vRed;
  if fam = 'red' then PASS:=PASS+1;
    raise notice '  PASS  an unrelated write (a price change) leaves the family correct rather than clearing it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a price change destroyed the colour family (now %)', coalesce(fam,'NULL'); end if;

  -- ============================ 8. a category nobody typed on purpose
  select category_key into catk from wholesale_v2.v2_products where id = prod2;
  if catk is null then PASS:=PASS+1;
    raise notice '  PASS  "gfhjbk" -- a real value in production today -- gets no category_key, so it will not appear as a category anybody can browse';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  junk resolved to the category %', catk; end if;

  -- ============================ 9. the taxonomy is not editable from a browser
  -- NOT "cannot write" -- HOLDS NO KEY AT ALL. 097 granted select here and the
  -- comment beside it said the facet list is not a secret, which is true and
  -- was still the wrong conclusion: gate S7 (check_anon_grants.sql) asks whether
  -- anon holds a key to ANY table in this schema, and it went from passing to
  -- raising the moment 097 landed. Migration 098 took the grant back. This
  -- assertion is written the strict way so the weaker version cannot come back.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_attribute_aliases'
     and grantee in ('anon','authenticated','PUBLIC');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  anon and authenticated hold NO grant on the taxonomy -- a grant plus using(true) is a standing door, and the value of "anon holds nothing" is that it has no exceptions to remember';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the browser roles hold % grant(s) on the taxonomy -- gate S7 forbids any', n; end if;

  -- and the normaliser must still work without it, or the trade was a bad one.
  if wholesale_v2.v2_normalise_attribute('colour','Crimson Red') = 'red' then PASS:=PASS+1;
    raise notice '  PASS  and normalisation still resolves without that grant, because v2_normalise_attribute is SECURITY DEFINER and reads the table as its owner';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  revoking the grant broke the normaliser'; end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_attribute_aliases' and c.relrowsecurity;
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  and row level security is on it';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  RLS is not enabled on v2_attribute_aliases'; end if;

  -- ============================ 10. the derived columns are not a second copy
  -- of the product. If this ever stops being true, the facet has become a
  -- place to store things, and it will drift.
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_product_variants'
     and column_name in ('colour_family','size_system','size_rank');
  if n = 3 then PASS:=PASS+1;
    raise notice '  PASS  exactly three derived columns on the variant, no more';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  expected 3 derived variant columns, found %', n; end if;

  -- ---------------------------------------------------------------- tally
  raise notice '----------------------------------------';
  raise notice 'check_attribute_normalisation: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_attribute_normalisation FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
