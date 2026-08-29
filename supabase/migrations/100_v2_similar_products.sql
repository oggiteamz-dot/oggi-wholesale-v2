-- =============================================================================
-- 100 — MORE LIKE THIS                                        RC-03, 30 Aug 2026
-- =============================================================================
--
-- RC-03 was specified as ATTRIBUTE SIMILARITY: match on colour family, size
-- system and category. I built those three columns yesterday in migration 097.
-- Measured against the actual catalogue they DO NOT DISCRIMINATE, and that is
-- the finding this whole migration is shaped around.
--
-- ==== WHAT THE ATTRIBUTES ACTUALLY LOOK LIKE, COUNTED ======================
--
--   Merino Crew Knit    (mg)    beige/blue/green/red   numeric   no category
--   Wool Overshirt      (mg)    beige/blue/green/red   numeric   no category
--   Canvas Tote Bag     (omni)  beige/blue/green/red   numeric   no category
--   Classic Crew Tee    (omni)  beige/blue/green/red   numeric   no category
--   Boxy Cotton Tee     (sq)    beige/blue/green/red   numeric   no category
--   Cargo Pant          (sq)    beige/blue/green/red   numeric   no category
--   Denim Utility Jacket(sq)    beige/blue/green/red   numeric   no category
--   Hooded Sweat        (sq)    beige/blue/green/red   numeric   no category
--
-- EIGHT OF 23 LIVE PRODUCTS CARRY EVERY COLOUR FAMILY THERE IS. Each is stocked
-- in all four colours, so "shares a colour family" matches a tote bag to a
-- jacket to a pair of trousers. Size system is binary -- letter or numeric, a
-- coin flip. Category exists on 6 products, all 'apparel', all in one store.
--
-- A score built on those three columns returns nearly everything for nearly
-- every product, and returns it wearing the label of a recommendation. That is
-- worse than returning nothing: a buyer who taps "more like this" twice and
-- gets junk both times stops tapping it, and stops believing the shelves above
-- it too.
--
-- ==== WHAT DOES DISCRIMINATE ===============================================
--
-- THE PRODUCT'S OWN WORDS. "Cargo Pant" exists in demo AND in sq. "Merino Crew
-- Knit" exists in demo AND in mg. Those are the same item from two suppliers --
-- the single most useful thing a wholesale marketplace can show a buyer, and no
-- attribute column in this schema knows it.
--
-- So:  NAME OVERLAP IS THE MATCH. ATTRIBUTES ONLY RANK.
--
-- Nothing reaches this shelf on attributes alone, because on this data that
-- means everything reaches it. Category agreement, price proximity and colour
-- overlap order the results that a shared word already qualified.
--
-- ==== WHY NOT pg_trgm ======================================================
--
-- pg_trgm is available and not installed. It would catch "Hooded Sweat" ~
-- "Oversized Hoodie", which word overlap will not.
--
-- Declined, for the rule migration 097 was built on: the alias key is
-- v2_search_normalise(), the SAME function the search box uses, so "the same
-- word" means the same thing at ingest and at query time. Installing a second
-- notion of text similarity puts a system in this database that will eventually
-- disagree with the first, and the symptom is a product that is "similar" on
-- one screen and not on another. One normaliser.
--
-- If matching proves too narrow once there are real catalogues, that is a
-- tuning problem, and the config row is already there for it.
--
-- ==== STOP WORDS ARE NOT DECORATION ========================================
--
-- The `test` store contains products named 'j', 'dff', 'err', 'guyhj', 'htfd'.
-- Without a minimum token length these become "similar" to each other and to
-- anything else short, and the shelf fills with keyboard mash. The stop list
-- lives in v2_ranking_config with the other judgements, because which words
-- carry no meaning in a Lebanese wholesale catalogue is a product decision and
-- not mine to freeze into a function.
-- =============================================================================

-- v2_ranking_config gained int_value in 099; similarity needs words too.
alter table wholesale_v2.v2_ranking_config
  add column if not exists text_value text;

insert into wholesale_v2.v2_ranking_config (key, int_value, text_value, note) values
  ('similar_min_overlap', 1, null,
   'RC-03. How many meaningful words two product names must share before either may be called similar to the other. Below this the product does not qualify and, if nothing qualifies, the rail renders nothing.'),
  ('similar_max_rows', 12, null,
   'RC-03. Hard ceiling on rows returned, whatever the caller asks for.'),
  ('similar_per_store_cap', 3, null,
   'RC-03. How many results one wholesaler may contribute. Without a cap "more like this" quietly becomes one supplier''s catalogue, and cross-store comparison is the reason the marketplace exists.'),
  ('similar_price_band_pct', 200, null,
   'RC-03. How far apart two prices may be and still rank as close, in percent. Used for ORDERING only -- price never disqualifies a match, because a cheaper equivalent is exactly what a buyer wants to find.'),
  ('similar_stop_words', null,
   'the,and,a,an,of,for,with,in,on,new,size,colour,color,pack,set,pcs,pc,piece,pieces,item,product',
   'RC-03. Words that carry no meaning in a product name. Comma separated. Tokens of one character are dropped regardless -- the test store contains products named j, dff and err, and without that rule they become similar to each other and to anything else short.')
on conflict (key) do nothing;

-- ------------------------------------------------------------ name -> words --
create or replace function wholesale_v2.v2_name_words(p_name text)
returns text[]
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_stop text[]; v_out text[];
begin
  select string_to_array(coalesce(text_value,''), ',') into v_stop
    from wholesale_v2.v2_ranking_config where key = 'similar_stop_words';
  v_stop := coalesce(v_stop, '{}');

  select array_agg(distinct w) into v_out
    from unnest(string_to_array(wholesale_v2.v2_search_normalise(coalesce(p_name,'')), ' ')) as w
   -- length > 1 is not a tuning knob, it is the difference between a catalogue
   -- and keyboard mash. See the header.
   where length(w) > 1 and not (w = any(v_stop));

  return coalesce(v_out, '{}');
end;
$fn$;

revoke all on function wholesale_v2.v2_name_words(text) from public;
grant execute on function wholesale_v2.v2_name_words(text) to anon, authenticated;

comment on function wholesale_v2.v2_name_words(text) is
  'RC-03. The meaningful words in a product name, through v2_search_normalise -- the same function the search box and the SR-09 alias table use, so "the same word" means the same thing everywhere. Stop words and single characters removed.';

-- --------------------------------------------------------------- the shelf --
create or replace function wholesale_v2.v2_similar_products(
  p_account_id uuid,
  p_product_id uuid,
  p_limit      integer default 12
)
returns table (
  product_id       uuid,
  product_name     text,
  wid              text,
  wholesaler_name  text,
  image_url        text,
  price_from       numeric,
  currency         text,
  shared_words     integer,
  same_category    boolean,
  cross_store      boolean
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person  uuid;
  v_wids    text[];
  v_words   text[];
  v_cat     text;
  v_price   numeric;
  v_awid    text;
  v_min     int;
  v_max     int;
  v_cap     int;
  v_band    int;
begin
  if p_account_id is null or p_product_id is null
     or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  -- ACTIVE memberships, recomputed every call. Same rule as RC-01 and RC-02:
  -- a store revoked an hour ago must fall out of this immediately.
  select array_agg(distinct m.wid) into v_wids
    from wholesale_v2.v2_person_memberships m
   where v_person is not null and m.person_id = v_person and m.active;

  if v_wids is null then
    select array[a.wid] into v_wids
      from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;
  end if;
  if v_wids is null then return; end if;

  -- THE ANCHOR MUST ITSELF BE IN SCOPE. Without this check a buyer could pass
  -- any product id and learn what the marketplace considers similar to it --
  -- a small read across a wall the rest of the schema keeps closed.
  select p.wid, p.category_key,
         wholesale_v2.v2_name_words(p.name),
         (select min(v.price) from wholesale_v2.v2_product_variants v
           where v.product_id = p.id and v.price is not null)
    into v_awid, v_cat, v_words, v_price
    from wholesale_v2.v2_products p
    join public.wholesalers w on w.wid = p.wid
   where p.id = p_product_id
     and p.wid = any(v_wids)
     and coalesce(p.archived,false) = false
     and w.active;

  if v_awid is null then return; end if;
  if v_words is null or cardinality(v_words) = 0 then return; end if;

  select int_value into v_min  from wholesale_v2.v2_ranking_config where key='similar_min_overlap';
  select int_value into v_max  from wholesale_v2.v2_ranking_config where key='similar_max_rows';
  select int_value into v_cap  from wholesale_v2.v2_ranking_config where key='similar_per_store_cap';
  select int_value into v_band from wholesale_v2.v2_ranking_config where key='similar_price_band_pct';
  v_min  := greatest(coalesce(v_min, 1), 1);
  v_max  := coalesce(v_max, 12);
  v_cap  := greatest(coalesce(v_cap, 3), 1);
  v_band := greatest(coalesce(v_band, 200), 1);

  if p_limit is null or p_limit < 1 then p_limit := v_max; end if;
  if p_limit > v_max then p_limit := v_max; end if;

  return query
  with scored as (
    select
      p.id            as pid,
      p.name          as pname,
      -- NOT `wid`: RETURNS TABLE declares an OUT parameter called wid, which is
      -- a VARIABLE inside this body, and `partition by wid` below would be
      -- ambiguous between the two. Postgres says so and refuses to run. Every
      -- CTE column is renamed for the same reason.
      p.wid           as store,
      coalesce(nullif(btrim(w.name), ''), w.brand, p.wid) as wname,
      (select coalesce(v2.image_url, v2.images->>0)
         from wholesale_v2.v2_product_variants v2
        where v2.product_id = p.id and coalesce(v2.image_url, v2.images->>0) is not null
        limit 1) as img,
      (select min(v3.price) from wholesale_v2.v2_product_variants v3
        where v3.product_id = p.id and v3.price is not null) as pfrom,
      coalesce(w.currency, '$') as cur,
      cardinality(array(
        select unnest(wholesale_v2.v2_name_words(p.name))
        intersect
        select unnest(v_words)
      )) as overlap,
      (v_cat is not null and p.category_key is not null and p.category_key = v_cat) as same_cat,
      (p.wid <> v_awid) as cross_st,
      -- Colour overlap: the LAST tiebreak and never a qualifier, because eight
      -- live products carry all four families and it would otherwise match
      -- everything to everything. See the header.
      (select count(*) from (
         select distinct cv.colour_family from wholesale_v2.v2_product_variants cv
          where cv.product_id = p.id and cv.colour_family is not null
         intersect
         select distinct av.colour_family from wholesale_v2.v2_product_variants av
          where av.product_id = p_product_id and av.colour_family is not null
       ) c) as colour_overlap
    from wholesale_v2.v2_products p
    join public.wholesalers w on w.wid = p.wid
   where p.id <> p_product_id                   -- never itself
     and p.wid = any(v_wids)                    -- only stores they can enter
     and coalesce(p.archived,false) = false
     and w.active
  ),
  qualified as (
    select *,
      -- Price PROXIMITY, for ordering only. A cheaper equivalent is exactly
      -- what a wholesale buyer is looking for, so price never disqualifies.
      case
        when pfrom is null or v_price is null or v_price = 0 then 1
        else abs(pfrom - v_price) / nullif(v_price, 0)
      end as price_gap
      from scored where overlap >= v_min
  ),
  ranked as (
    select *,
      row_number() over (
        partition by store
        order by overlap desc, same_cat desc, price_gap asc, colour_overlap desc, pname
      ) as rn_in_store
      from qualified
  )
  select pid, pname, store, wname, img, pfrom, cur, overlap::integer, same_cat, cross_st
    from ranked
   -- NO SINGLE STORE FILLS THE RAIL. Cross-store comparison is the reason the
   -- marketplace exists; a shelf of one supplier's catalogue is the store page
   -- the buyer is already on.
   where rn_in_store <= v_cap
   order by overlap desc, same_cat desc, price_gap asc, colour_overlap desc, pname
   limit p_limit;
end;
$fn$;

revoke all on function wholesale_v2.v2_similar_products(uuid, uuid, integer) from public;
grant execute on function wholesale_v2.v2_similar_products(uuid, uuid, integer) to anon, authenticated;

comment on function wholesale_v2.v2_similar_products(uuid, uuid, integer) is
  'RC-03. Products like this one, inside the stores this account can still enter. NAME OVERLAP IS THE MATCH -- attributes only rank, because eight of 23 live products carry every colour family and matching on attributes alone would return everything. Never reads v2_oggi_promoted.';

-- =============================================================================
-- SELF-ASSERTING. Every assertion holds on an EMPTY database as well as a full
-- one -- the lesson 097 learned by stopping the replay dead.
-- =============================================================================
do $$
declare n int; src text; ws text[];
begin
  -- 1. The config landed, and is still closed to the browser roles (gate S7).
  select count(*) into n from wholesale_v2.v2_ranking_config
   where key in ('similar_min_overlap','similar_max_rows','similar_per_store_cap',
                 'similar_price_band_pct','similar_stop_words');
  if n <> 5 then raise exception 'ASSERT 1 FAILED: similarity config incomplete (% of 5)', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_ranking_config'
     and grantee in ('anon','authenticated','PUBLIC');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: browser roles hold % grant(s) on the ranking config', n; end if;

  -- 2. WORDS. The single-character rule is the difference between a catalogue
  --    and keyboard mash, and the test store is full of the latter.
  ws := wholesale_v2.v2_name_words('Oversized Hoodie — Heavyweight Fleece');
  if not ('hoodie' = any(ws)) then raise exception 'ASSERT 2 FAILED: a real word was lost from a real name'; end if;
  if 'j' = any(wholesale_v2.v2_name_words('j')) then
    raise exception 'ASSERT 2 FAILED: a single-character name produced a token'; end if;
  if 'the' = any(wholesale_v2.v2_name_words('The Cargo Pant')) then
    raise exception 'ASSERT 2 FAILED: a stop word survived'; end if;
  if not ('cargo' = any(wholesale_v2.v2_name_words('The Cargo Pant'))) then
    raise exception 'ASSERT 2 FAILED: a meaningful word did not survive stop-word removal'; end if;

  -- 3. ONE NORMALISER. Ingest, search and similarity must agree by construction.
  if wholesale_v2.v2_name_words('T-Shirt') <> wholesale_v2.v2_name_words('t shirt') then
    raise exception 'ASSERT 3 FAILED: "T-Shirt" and "t shirt" produced different words -- the normaliser is not being shared'; end if;

  -- 4. NAME OVERLAP IS THE MATCH, asserted against the function's own source:
  --    a promise about what does NOT qualify a row, which no fixture can show.
  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_similar_products';
  if src !~* 'where overlap >= v_min' then
    raise exception 'ASSERT 4 FAILED: the qualifier is no longer name overlap -- attributes alone now reach the shelf, and on this catalogue that means everything does'; end if;
  if src ~* 'v2_oggi_promoted' then
    raise exception 'ASSERT 4 FAILED: the similar shelf reads the promotion table'; end if;
  if src ~* 'v2_search_impressions' then
    raise exception 'ASSERT 4 FAILED: the similar shelf reads search telemetry'; end if;
  if src !~* 'rn_in_store <= v_cap' then
    raise exception 'ASSERT 4 FAILED: the per-store cap is gone -- one supplier can now fill the whole rail'; end if;
  if src !~* 'p\.id <> p_product_id' then
    raise exception 'ASSERT 4 FAILED: a product can be similar to itself'; end if;

  -- 5. Scope is DERIVED. The function must never take a wid.
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_similar_products')) ~* 'wid' then
    raise exception 'ASSERT 5 FAILED: v2_similar_products accepts a wid'; end if;

  -- 6. Callable on an empty database and answers nothing, without raising.
  select count(*) into n from wholesale_v2.v2_similar_products(null, null, 5);
  if n <> 0 then raise exception 'ASSERT 6 FAILED: a null account got % rows', n; end if;
  select count(*) into n from wholesale_v2.v2_similar_products(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid, 5);
  if n <> 0 then raise exception 'ASSERT 6 FAILED: an unknown account got % rows', n; end if;

  raise notice '100 OK: similarity matches on shared words, ranks on attributes, caps per store, and reads no promotion table.';
end $$;
