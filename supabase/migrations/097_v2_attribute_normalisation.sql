-- =============================================================================
-- 097 — ATTRIBUTE NORMALISATION AT INGEST                     SR-09, 30 Aug 2026
-- =============================================================================
--
-- What production actually holds today, counted rather than assumed:
--
--   COLOUR    "Crimson Red" (37) · "Crimson" (2) · "Red" (11)
--             "Midnight Blue" (32) · "Navy" (14) · "Blue" (16) · "Royal Blue" (7) · "Sky" (12)
--             "Forest" (32) · "Green" (16) · "Olive" (12) · "Mint" (10)
--             "Sand" (34) · "Cream" (2) ... and "hgfds" (7), "kjh" (7)
--   SIZE      two systems in one column: 28–47 (numeric) and S/M/L/XL, plus "One size"
--   CATEGORY  16 of 23 live products have NONE. Of the rest: "Apparel" (6), "gfhjbk" (1)
--
-- Three wholesalers describing the same red three ways is not a data-entry
-- problem to be tidied away. It is what a marketplace looks like, and it is why
-- "best seller in this category" (RC-02) and "more like this" (RC-03) cannot be
-- built on the raw columns.
--
-- ==== THE RULE THIS MIGRATION IS BUILT AROUND ==============================
--
--     NORMALISATION ADDS A FIELD. IT NEVER OVERWRITES ONE.
--
-- Migration 090 stated the same rule about people: "normalisation may split a
-- person, it must never merge two." Here it is about words. "Crimson Red" is
-- the wholesaler's own name for their own product, it is what their buyers
-- recognise, and nothing in this migration changes it. What is added is a
-- derived FAMILY alongside it, for searching, faceting and recommending.
--
-- A buyer looking at the catalogue still reads "Crimson Red". A buyer filtering
-- by red finds it. Both are true at once, and neither costs the other anything.
--
-- ==== WHY THE TAXONOMY IS A TABLE AND NOT A CASE STATEMENT =================
--
-- Which colours count as one family, and what that family is called, is a
-- PRODUCT decision about a Lebanese wholesale market. It is not mine to bake
-- into a function where changing it needs a migration.
--
-- So the mapping lives in v2_attribute_aliases, seeded below with a starting
-- set drawn from the values actually in production, and editable afterwards by
-- anyone with database access without deploying anything. SR-07 (versioned
-- ranking config) will want exactly this shape.
--
-- An UNKNOWN value maps to NULL, not to a guess. "hgfds" is not a colour, and
-- inventing a family for it would put junk into the facet that the facet then
-- has to be trusted about.
--
-- ==== WHY A TRIGGER AND NOT THREE CLIENT FIXES =============================
--
-- SR-09 says "at ingest". There are at least three ingest paths today — the CSV
-- importer, the AI catalogue import, and the product form — and normalising in
-- each means three chances to forget, plus a fourth the day somebody adds an
-- API. The trigger below cannot be forgotten by a caller that does not know it
-- exists, which is the only version of "at ingest" that stays true.
--
-- The alias KEY is v2_search_normalise(), the same function the search uses.
-- Reusing it means "the same word" means the same thing at ingest as it does at
-- query time, including for Arabic. Two normalisers would eventually disagree,
-- and the symptom would be a product that exists and cannot be found.
-- =============================================================================

-- ------------------------------------------------------------ the taxonomy --
create table if not exists wholesale_v2.v2_attribute_aliases (
  kind       text not null check (kind in ('colour','size','category')),
  alias_key  text not null,
  canonical  text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (kind, alias_key)
);

comment on table wholesale_v2.v2_attribute_aliases is
  'SR-09. Which written-down values mean the same thing. DATA, not code: which colours form a family, and what that family is called, is a product decision about a specific market and must be changeable without a migration. alias_key is v2_search_normalise(raw), so the same word means the same thing here as it does in search. An unknown value resolves to NULL rather than to a guess.';

alter table wholesale_v2.v2_attribute_aliases enable row level security;
-- Readable by the app (the facet list is not a secret), writable by nobody
-- through the API — it is edited in the dashboard, and a buyer who could write
-- it could rename every wholesaler's colours at once.
drop policy if exists v2_attribute_aliases_read on wholesale_v2.v2_attribute_aliases;
create policy v2_attribute_aliases_read on wholesale_v2.v2_attribute_aliases
  for select using (true);
grant select on wholesale_v2.v2_attribute_aliases to anon, authenticated;
revoke insert, update, delete on wholesale_v2.v2_attribute_aliases from anon, authenticated;

-- ----------------------------------------------------- the derived columns --
alter table wholesale_v2.v2_product_variants
  add column if not exists colour_family text,
  add column if not exists size_system   text,
  add column if not exists size_rank     numeric;

comment on column wholesale_v2.v2_product_variants.colour_family is
  'SR-09, DERIVED. Never shown instead of extra_attrs->>''color'' -- the wholesaler''s own word is what a buyer reads. This is for filtering and for RC-03. NULL when the value is not a colour we know.';
comment on column wholesale_v2.v2_product_variants.size_system is
  'SR-09, DERIVED. letter | numeric | one. Two systems live in one text column, so a comparison that ignores which one is being used is meaningless.';
comment on column wholesale_v2.v2_product_variants.size_rank is
  'SR-09, DERIVED. Orderable WITHIN a system. Sizes are text today, so "10" sorts before "2" and S/M/L sort as L,M,S -- alphabetically, which is not an order anybody wants.';

alter table wholesale_v2.v2_products
  add column if not exists category_key text;

comment on column wholesale_v2.v2_products.category_key is
  'SR-09, DERIVED. The normalised category, for grouping. NULL for the 16 of 23 live products that carry no category at all -- this migration does not invent one, because a guessed category is worse than a missing one for RC-02.';

create index if not exists v2_variants_colour_family_idx
  on wholesale_v2.v2_product_variants (colour_family) where colour_family is not null;
create index if not exists v2_products_category_key_idx
  on wholesale_v2.v2_products (category_key) where category_key is not null;

-- --------------------------------------------------------- the normaliser --
create or replace function wholesale_v2.v2_normalise_attribute(
  p_kind text,
  p_raw  text
)
returns text
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_key text; v_canon text;
begin
  v_key := wholesale_v2.v2_search_normalise(coalesce(p_raw, ''));
  if v_key = '' then return null; end if;

  select a.canonical into v_canon
    from wholesale_v2.v2_attribute_aliases a
   where a.kind = p_kind and a.alias_key = v_key;

  -- No entry means NO ANSWER. Not the raw value, not a guess. A facet that
  -- silently contains every typo is a facet nobody can filter by.
  return v_canon;
end;
$fn$;

revoke all on function wholesale_v2.v2_normalise_attribute(text, text) from public;
grant execute on function wholesale_v2.v2_normalise_attribute(text, text) to anon, authenticated;

-- ------------------------------------------------------------ size sorting --
create or replace function wholesale_v2.v2_size_shape(p_raw text)
returns table (system text, rank numeric)
language plpgsql
immutable
as $fn$
declare v text; n numeric;
begin
  v := lower(btrim(coalesce(p_raw, '')));
  if v = '' then return query select null::text, null::numeric; return; end if;

  -- One size is its own system. Ranking it against 38 or against L would
  -- assert an order that does not exist.
  if v in ('one size','onesize','one','os','free size','freesize','uni','unisize') then
    return query select 'one'::text, 0::numeric; return;
  end if;

  -- Pure numeric: EU/waist sizing. The number IS the rank.
  if v ~ '^[0-9]+([.,][0-9]+)?$' then
    return query select 'numeric'::text, replace(v, ',', '.')::numeric; return;
  end if;

  -- Letter sizing, including the xN forms wholesalers actually type.
  -- Spaced evenly so a new size can be inserted between two without renumbering.
  n := case v
    when 'xxxs' then 10 when '3xs' then 10
    when 'xxs'  then 20 when '2xs' then 20
    when 'xs'   then 30
    when 's'    then 40 when 'small' then 40
    when 'm'    then 50 when 'medium' then 50
    when 'l'    then 60 when 'large' then 60
    when 'xl'   then 70 when 'x large' then 70 when 'xlarge' then 70
    when 'xxl'  then 80 when '2xl' then 80 when 'xx large' then 80
    when 'xxxl' then 90 when '3xl' then 90
    when 'xxxxl' then 100 when '4xl' then 100
    else null end;

  if n is not null then return query select 'letter'::text, n; return; end if;

  -- Anything else: recognised as a size we do not understand. NOT forced into
  -- a system, because a wrong system sorts wrongly and silently.
  return query select null::text, null::numeric;
end;
$fn$;

revoke all on function wholesale_v2.v2_size_shape(text) from public;
grant execute on function wholesale_v2.v2_size_shape(text) to anon, authenticated;

-- ---------------------------------------------------------- the triggers ---
create or replace function wholesale_v2.v2_variant_normalise_tg()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare s record;
begin
  new.colour_family := wholesale_v2.v2_normalise_attribute('colour', new.extra_attrs->>'color');
  select * into s from wholesale_v2.v2_size_shape(new.extra_attrs->>'size');
  new.size_system := s.system;
  new.size_rank   := s.rank;
  return new;
end;
$fn$;

-- ON EVERY UPDATE, NOT ONLY ON UPDATE OF extra_attrs.
--
-- The narrower form was the first draft, and it left a door open: a direct
--     update v2_product_variants set colour_family = 'purple' where ...
-- does not touch extra_attrs, so the narrow trigger would not fire and the lie
-- would stick -- a derived column disagreeing with the column it is derived
-- from, which is worse than not having the column. The whole claim of SR-09 is
-- that this CANNOT be forgotten; a trigger with a bypass has not made that
-- claim, it has made a narrower one and used the same words.
--
-- The cost is two cheap function calls on every variant write. That is the
-- correct price for the column never being able to lie.
drop trigger if exists v2_variant_normalise on wholesale_v2.v2_product_variants;
create trigger v2_variant_normalise
  before insert or update on wholesale_v2.v2_product_variants
  for each row execute function wholesale_v2.v2_variant_normalise_tg();

create or replace function wholesale_v2.v2_product_normalise_tg()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  new.category_key := wholesale_v2.v2_normalise_attribute('category', new.category);
  return new;
end;
$fn$;

drop trigger if exists v2_product_normalise on wholesale_v2.v2_products;
create trigger v2_product_normalise
  before insert or update on wholesale_v2.v2_products   -- see the note above
  for each row execute function wholesale_v2.v2_product_normalise_tg();

-- =============================================================================
-- THE SEED. Drawn from the values actually in production, plus the obvious
-- neighbours a wholesaler will type next. Deliberately conservative: every row
-- here is a claim that two words mean the same thing, and a wrong claim merges
-- two colours that a buyer can tell apart.
-- =============================================================================
insert into wholesale_v2.v2_attribute_aliases (kind, alias_key, canonical, note) values
  -- red
  ('colour','red','red',null), ('colour','crimson','red',null), ('colour','crimson red','red','in production, 37 variants'),
  ('colour','burgundy','red',null), ('colour','maroon','red',null), ('colour','wine','red',null), ('colour','cherry','red',null),
  ('colour','احمر','red',null),
  -- blue. Sky and navy are both blue and are NOT interchangeable; the family is
  -- a browse facet, and the exact word still matches in search.
  ('colour','blue','blue',null), ('colour','navy','blue','in production, 14'),
  ('colour','midnight blue','blue','in production, 32'), ('colour','royal blue','blue','in production, 7'),
  ('colour','sky','blue','in production, 12'), ('colour','sky blue','blue',null),
  ('colour','denim','blue',null), ('colour','teal','blue',null), ('colour','turquoise','blue',null),
  ('colour','ازرق','blue',null),
  -- green
  ('colour','green','green',null), ('colour','forest','green','in production, 32'),
  ('colour','olive','green','in production, 12'), ('colour','mint','green','in production, 10'),
  ('colour','sage','green',null), ('colour','emerald','green',null), ('colour','اخضر','green',null),
  -- neutral / beige
  ('colour','sand','beige','in production, 34'), ('colour','cream','beige','in production, 2'),
  ('colour','beige','beige',null), ('colour','ivory','beige',null), ('colour','nude','beige',null),
  ('colour','taupe','beige',null), ('colour','off white','beige',null),
  -- black / white / grey
  ('colour','black','black',null), ('colour','اسود','black',null),
  ('colour','white','white',null), ('colour','ابيض','white',null),
  ('colour','grey','grey',null), ('colour','gray','grey',null), ('colour','charcoal','grey',null),
  ('colour','silver','grey',null), ('colour','رمادي','grey',null),
  -- brown
  ('colour','brown','brown',null), ('colour','tan','brown',null), ('colour','camel','brown',null),
  ('colour','chocolate','brown',null), ('colour','khaki','brown',null), ('colour','بني','brown',null),
  -- the rest
  ('colour','pink','pink',null), ('colour','rose','pink',null), ('colour','fuchsia','pink',null),
  ('colour','purple','purple',null), ('colour','lilac','purple',null), ('colour','lavender','purple',null),
  ('colour','yellow','yellow',null), ('colour','mustard','yellow',null), ('colour','gold','yellow',null),
  ('colour','orange','orange',null), ('colour','rust','orange',null), ('colour','coral','orange',null),
  ('colour','multicolour','multi',null), ('colour','multicolor','multi',null), ('colour','multi','multi',null),
  ('colour','printed','multi',null), ('colour','print','multi',null),
  -- categories seen in production, plus the ones this market will use next
  ('category','apparel','apparel','in production, 6 products'),
  ('category','clothing','apparel',null), ('category','clothes','apparel',null), ('category','ملابس','apparel',null),
  ('category','tops','tops',null), ('category','top','tops',null), ('category','shirts','tops',null),
  ('category','t shirts','tops',null), ('category','tshirts','tops',null), ('category','blouses','tops',null),
  ('category','bottoms','bottoms',null), ('category','pants','bottoms',null), ('category','trousers','bottoms',null),
  ('category','jeans','bottoms',null), ('category','skirts','bottoms',null), ('category','shorts','bottoms',null),
  ('category','outerwear','outerwear',null), ('category','outer','outerwear',null), ('category','jackets','outerwear',null),
  ('category','coats','outerwear',null),
  ('category','dresses','dresses',null), ('category','dress','dresses',null),
  ('category','knitwear','knitwear',null), ('category','sweaters','knitwear',null), ('category','hoodies','knitwear',null),
  ('category','footwear','footwear',null), ('category','shoes','footwear',null), ('category','احذيه','footwear',null),
  ('category','accessories','accessories',null), ('category','bags','accessories',null), ('category','hats','accessories',null),
  ('category','underwear','underwear',null), ('category','lingerie','underwear',null),
  ('category','kids','kids',null), ('category','children','kids',null), ('category','اطفال','kids',null)
on conflict (kind, alias_key) do nothing;

-- =============================================================================
-- BACK-FILL. The trigger only fires on future writes; 264 variants and 23
-- products already exist, and a facet that only knows about tomorrow's data is
-- not a facet.
-- =============================================================================
-- NOTE: the LATERAL cannot reference the UPDATE target directly -- Postgres
-- does not put the target row in scope for the FROM list. So the shape is
-- computed once per row in a subquery and joined back on the primary key,
-- which also means v2_size_shape() is evaluated once and not twice.
update wholesale_v2.v2_product_variants v
   set colour_family = src.fam,
       size_system   = src.sys,
       size_rank     = src.rnk
  from (
    select pv.id,
           wholesale_v2.v2_normalise_attribute('colour', pv.extra_attrs->>'color') as fam,
           s.system as sys,
           s.rank   as rnk
      from wholesale_v2.v2_product_variants pv,
           lateral wholesale_v2.v2_size_shape(pv.extra_attrs->>'size') s
  ) src
 where src.id = v.id;

update wholesale_v2.v2_products p
   set category_key = wholesale_v2.v2_normalise_attribute('category', p.category);

-- =============================================================================
-- SELF-ASSERTING.
-- =============================================================================
do $$
declare
  n int; n2 int; v_raw text; v_fam text; s record;
begin
  -- 1. THE RULE. Nothing the wholesaler typed was changed.
  select count(*) into n from wholesale_v2.v2_product_variants
   where extra_attrs->>'color' is not null and btrim(extra_attrs->>'color') = '';
  if n <> 0 then raise exception 'ASSERT 1 FAILED: a colour was blanked'; end if;

  select count(*) into n from wholesale_v2.v2_product_variants
   where colour_family is not null and lower(colour_family) = lower(extra_attrs->>'color')
     and lower(extra_attrs->>'color') not in (select canonical from wholesale_v2.v2_attribute_aliases where kind='colour');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: the family replaced the wholesaler''s own word'; end if;

  -- 2. Several different words reach ONE family, and families that must stay
  --    apart are not merged.
  --
  --    Asserted against the FUNCTION first, and only then against the rows.
  --    The first draft of this assertion counted distinct red words in
  --    v2_product_variants -- and stopped the replay dead, because an empty
  --    database has no reds in it. An assertion that only holds where the data
  --    happens to be is not a guarantee this migration can make: it would have
  --    failed on every fresh Supabase project, which is exactly the thing the
  --    replay exists to catch.
  if wholesale_v2.v2_normalise_attribute('colour','Crimson Red') is distinct from 'red'
     or wholesale_v2.v2_normalise_attribute('colour','Crimson') is distinct from 'red'
     or wholesale_v2.v2_normalise_attribute('colour','Red') is distinct from 'red' then
    raise exception 'ASSERT 2 FAILED: the three reds production actually holds do not share one family (% / % / %)',
      coalesce(wholesale_v2.v2_normalise_attribute('colour','Crimson Red'),'NULL'),
      coalesce(wholesale_v2.v2_normalise_attribute('colour','Crimson'),'NULL'),
      coalesce(wholesale_v2.v2_normalise_attribute('colour','Red'),'NULL');
  end if;
  if wholesale_v2.v2_normalise_attribute('colour','Navy')
     = wholesale_v2.v2_normalise_attribute('colour','Forest') then
    raise exception 'ASSERT 2 FAILED: navy and forest were folded into one family'; end if;

  --    And where rows DO exist, the same property is visible in them.
  select count(*) into n2 from wholesale_v2.v2_product_variants where colour_family is not null;
  if n2 > 0 then
    select count(distinct extra_attrs->>'color') into n
      from wholesale_v2.v2_product_variants where colour_family = 'red';
    if n < 2 then
      raise exception 'ASSERT 2 FAILED: % variants carry a family, but the reds did not collapse (% distinct words)', n2, n;
    end if;
  end if;

  -- 3. An unknown value gets NO family rather than a guess.
  if wholesale_v2.v2_normalise_attribute('colour', 'hgfds') is not null then
    raise exception 'ASSERT 3 FAILED: a junk value was given a colour family'; end if;
  if wholesale_v2.v2_normalise_attribute('colour', '') is not null then
    raise exception 'ASSERT 3 FAILED: an empty value was given a colour family'; end if;

  -- 4. Arabic and Latin reach the same family, through the SAME normaliser the
  --    search uses. Two normalisers would eventually disagree, and the symptom
  --    would be a product that exists and cannot be found.
  if wholesale_v2.v2_normalise_attribute('colour', 'أحمر') is distinct from 'red' then
    raise exception 'ASSERT 4 FAILED: the Arabic for red did not resolve (got %)',
      coalesce(wholesale_v2.v2_normalise_attribute('colour','أحمر'),'NULL'); end if;
  if wholesale_v2.v2_normalise_attribute('colour', '  CRIMSON   RED ') is distinct from 'red' then
    raise exception 'ASSERT 4 FAILED: casing and spacing were not folded'; end if;

  -- 5. Sizes sort within a system and are never compared across one.
  select * into s from wholesale_v2.v2_size_shape('M');
  if s.system <> 'letter' then raise exception 'ASSERT 5 FAILED: M is not a letter size'; end if;
  select * into s from wholesale_v2.v2_size_shape('38');
  if s.system <> 'numeric' or s.rank <> 38 then raise exception 'ASSERT 5 FAILED: 38 did not read as numeric 38'; end if;
  select * into s from wholesale_v2.v2_size_shape('One size');
  if s.system <> 'one' then raise exception 'ASSERT 5 FAILED: "One size" is not its own system'; end if;

  -- The ordering bug this fixes: as text, "10" < "2" and L < M < S.
  if (select rank from wholesale_v2.v2_size_shape('S')) >= (select rank from wholesale_v2.v2_size_shape('M'))
    then raise exception 'ASSERT 5 FAILED: S does not rank before M'; end if;
  if (select rank from wholesale_v2.v2_size_shape('M')) >= (select rank from wholesale_v2.v2_size_shape('XL'))
    then raise exception 'ASSERT 5 FAILED: M does not rank before XL'; end if;

  -- 6. The trigger fires on ingest, which is the whole point of SR-09.
  --    Checked by CREATING a row, because a trigger that exists and does not
  --    fire looks identical from the catalogue.
  declare
    v_wid text := 'zz97_store'; v_prod uuid; v_var uuid; fam text; sys text;
  begin
    insert into public.wholesalers (wid,name,active) values (v_wid,'Zed 97',true);
    insert into wholesale_v2.v2_wholesalers (wid) values (v_wid);
    insert into wholesale_v2.v2_products (wid,name,category,archived)
      values (v_wid,'Zed 97 Product','T-Shirts',false) returning id into v_prod;
    insert into wholesale_v2.v2_product_variants (product_id,sku,price,extra_attrs)
      values (v_prod,'ZZ97-1',10, '{"color":"Midnight Blue","size":"XL"}'::jsonb) returning id into v_var;

    select colour_family, size_system into fam, sys
      from wholesale_v2.v2_product_variants where id = v_var;
    if fam is distinct from 'blue' then
      raise exception 'ASSERT 6 FAILED: the trigger did not set colour_family on insert (got %)', coalesce(fam,'NULL'); end if;
    if sys is distinct from 'letter' then
      raise exception 'ASSERT 6 FAILED: the trigger did not set size_system on insert'; end if;
    if (select category_key from wholesale_v2.v2_products where id = v_prod) is distinct from 'tops' then
      raise exception 'ASSERT 6 FAILED: the product trigger did not set category_key on insert'; end if;

    -- and on UPDATE, not only on insert
    update wholesale_v2.v2_product_variants
       set extra_attrs = '{"color":"Forest","size":"40"}'::jsonb where id = v_var;
    select colour_family, size_system into fam, sys
      from wholesale_v2.v2_product_variants where id = v_var;
    if fam is distinct from 'green' or sys is distinct from 'numeric' then
      raise exception 'ASSERT 6 FAILED: the trigger did not re-run on update (got %, %)', coalesce(fam,'NULL'), coalesce(sys,'NULL'); end if;

    -- and a DIRECT write to the derived column cannot make it lie, because the
    -- trigger fires on every update rather than only on extra_attrs.
    update wholesale_v2.v2_product_variants set colour_family = 'purple' where id = v_var;
    select colour_family into fam from wholesale_v2.v2_product_variants where id = v_var;
    if fam is distinct from 'green' then
      raise exception 'ASSERT 6 FAILED: colour_family could be written directly to a value its extra_attrs does not support (got %)', coalesce(fam,'NULL'); end if;

    -- Clean up after itself. A do-block does NOT roll back when it succeeds --
    -- the lesson from 096, applied without having to learn it twice.
    delete from wholesale_v2.v2_product_variants where id = v_var;
    delete from wholesale_v2.v2_products where id = v_prod;
    delete from wholesale_v2.v2_wholesalers where wid = v_wid;
    delete from public.wholesalers where wid = v_wid;
  end;

  select count(*) into n from public.wholesalers where wid = 'zz97_store';
  if n <> 0 then raise exception 'ASSERT 7 FAILED: the assertion fixture was left behind in the database'; end if;

  -- 8. The taxonomy is readable by the app and writable by nobody through it.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_attribute_aliases'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');
  if n <> 0 then raise exception 'ASSERT 8 FAILED: the browser roles can WRITE the taxonomy -- one buyer could rename every wholesaler''s colours at once'; end if;

  select count(*) into n from wholesale_v2.v2_product_variants where colour_family is not null;
  raise notice '097 OK: % variants carry a colour family, the raw words are untouched, and the trigger fires on both insert and update.', n;
end $$;
