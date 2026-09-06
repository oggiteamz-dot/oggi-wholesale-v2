-- 119 — MOD-03: the feed and the search read the PRODUCT flag
--
-- Completes MOD-01. 116 put `is_public` on the product and was deliberately
-- inert; this is the migration that makes anything read it. A flag nothing
-- reads is the dead-machinery pattern this repo already has too much of --
-- v2_size_ratios has 9 exported functions with no caller for the same reason.
--
-- WHAT CHANGES: six lines. Both functions stop reaching the publicness rule
-- THROUGH the catalog join and read `p.is_public` directly.
--
--   -  join v2_catalog_products cp on cp.product_id = p.id
--   -  join v2_catalogs c on c.id = cp.catalog_id
--   -  where c.is_public and w.active ...
--   +  where p.is_public and w.active ...
--
-- BOTH, IN ONE MIGRATION, ON PURPOSE. Changing one and not the other leaves
-- the feed and the search disagreeing about what "public" means. That is
-- exactly the drift check_marketplace_search was written about: the day the
-- two definitions diverge, the WIDER one wins silently and a private line is
-- simply in the results, with nothing on screen looking broken.
--
-- NO SIGNATURE CHANGES, so create-or-replace genuinely replaces. Migration 113
-- added a DEFAULTED argument to the feed, which created a SECOND overload
-- instead, and PostgREST refused every existing call with PGRST203 until 114
-- dropped the old signature. Nothing here adds, removes or reorders a
-- parameter; asserted at the bottom.
--
-- WHY THIS IS NOT A VISIBLE CHANGE
-- 116 backfilled `is_public` from this exact join, and the two were compared
-- in BOTH directions: 101 flagged, 101 reachable, 0 leaked, 0 dropped. So the
-- eligible set is identical by construction. The assertion at the bottom
-- re-proves it against the live data rather than trusting that reasoning.
--
-- `w.active` and `p.archived` stay as runtime filters in both functions --
-- they are states that change on their own and were deliberately never folded
-- into the flag (see 116).

CREATE OR REPLACE FUNCTION wholesale_v2.v2_marketplace_search(p_account_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0)
 RETURNS TABLE(product_id uuid, product_name text, category text, wid text, wholesaler_name text, wholesaler_logo text, image_url text, price_from numeric, currency text, access text, is_promoted boolean, slot text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'wholesale_v2', 'public'
AS $function$
declare
  v_person uuid;
  v_mine   text[] := '{}';
  v_q      text;
  v_like   text;
begin
  if p_limit is null or p_limit < 1 then p_limit := 40; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  v_q := btrim(coalesce(p_query, ''));
  -- An empty query returns NO ROWS rather than the whole marketplace. The feed
  -- is what answers "show me everything"; a search box that silently becomes a
  -- browse when you clear it makes the two indistinguishable on screen.
  if v_q = '' then return; end if;

  -- LIKE metacharacters are escaped rather than passed through. A buyer typing
  -- "50% cotton" means the three characters, not "match anything"; unescaped,
  -- a lone % returned the entire marketplace and a lone _ matched every
  -- one-character difference. Nothing crosses a privacy boundary either way --
  -- the scope is the public feed's scope -- but a search box whose results do
  -- not correspond to what was typed is a search box nobody trusts twice.
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  -- Signed out is a legitimate state here, exactly as in the feed.
  if p_account_id is not null then
    select a.person_id into v_person
      from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;
    select coalesce(array_agg(distinct x), '{}') into v_mine
      from (select m.wid as x
              from wholesale_v2.v2_person_memberships m
             where v_person is not null and m.person_id = v_person and m.active
            union
            select a.wid from wholesale_v2.v2_portal_accounts a where a.id = p_account_id) s;
  end if;

  return query
  with eligible as (
    select distinct p.id, p.name, p.category, p.wid, p.source_ref
      from wholesale_v2.v2_products p
      join public.wholesalers w on w.wid = p.wid
     -- MOD-03: the publicness rule now lives on the PRODUCT. Scope is
     -- unchanged -- 116 backfilled this flag from the catalog join it replaces
     -- and the two sets were compared in both directions.
     where p.is_public
       and w.active
       and coalesce(p.archived, false) = false
       and (
            upper(btrim(coalesce(p.source_ref, ''))) = upper(v_q)
         or p.name     ilike '%' || v_like || '%'
         or p.category ilike '%' || v_like || '%'
         or coalesce(p.source_ref, '') ilike '%' || v_like || '%'
       )
  ),
  shaped as (
    select
      e.id as product_id, e.name as product_name, e.category, e.wid,
      coalesce(nullif(btrim(w.name), ''), w.brand, e.wid) as wholesaler_name,
      w.logo as wholesaler_logo,
      (select coalesce(v.image_url, v.images->>0)
         from wholesale_v2.v2_product_variants v
        where v.product_id = e.id
          and coalesce(v.image_url, v.images->>0) is not null
        limit 1) as image_url,
      (select min(v.price) from wholesale_v2.v2_product_variants v
        where v.product_id = e.id and v.price is not null) as price_from,
      coalesce(w.currency, '$') as currency,
      case when e.wid = any(v_mine) then 'member' else 'none' end as access,
      exists (select 1 from wholesale_v2.v2_oggi_promoted op
               where op.product_id = e.id and op.active) as is_promoted,
      case
        when upper(btrim(coalesce(e.source_ref, ''))) = upper(v_q) then 0
        when e.name ilike v_like || '%'                            then 1
        when e.name ilike '%' || v_like || '%'                     then 2
        else 3
      end as band
      from eligible e
      join public.wholesalers w on w.wid = e.wid
  )
  select s.product_id, s.product_name, s.category, s.wid, s.wholesaler_name,
         s.wholesaler_logo, s.image_url, s.price_from, s.currency,
         s.access, s.is_promoted, 'organic'::text as slot
    from shaped s
   order by s.band, s.wholesaler_name, s.product_name, s.product_id
   limit p_limit offset p_offset;
end;
$function$
;

CREATE OR REPLACE FUNCTION wholesale_v2.v2_marketplace_feed(p_account_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0, p_category text DEFAULT NULL::text, p_sort text DEFAULT 'woven'::text)
 RETURNS TABLE(product_id uuid, product_name text, category text, wid text, wholesaler_name text, wholesaler_logo text, image_url text, price_from numeric, currency text, access text, is_promoted boolean, slot text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'wholesale_v2', 'public'
AS $function$
declare
  v_person     uuid;
  v_mine       text[] := '{}';
  v_ads_pct    int;
  v_ad_slots   int;
  v_ad_total   int;
  v_ads_before int;
  v_ads_now    int;
  v_org_before int;
  v_org_now    int;
  v_page       int;
  v_sort       text;
  v_min_buyers int;
  v_days       int;
begin
  if p_limit is null or p_limit < 1 then p_limit := 40; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  -- An unknown sort behaves exactly like the default rather than erroring: a
  -- typo in a rail definition should show the ordinary browse, not a blank page.
  v_sort := lower(coalesce(p_sort, 'woven'));
  if v_sort not in ('woven', 'new', 'popular') then v_sort := 'woven'; end if;

  if p_account_id is not null then
    select a.person_id into v_person
      from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;
    select coalesce(array_agg(distinct x), '{}') into v_mine
      from (select m.wid as x
              from wholesale_v2.v2_person_memberships m
             where v_person is not null and m.person_id = v_person and m.active
            union
            select a.wid from wholesale_v2.v2_portal_accounts a where a.id = p_account_id) s;
  end if;

  select coalesce(int_value, 20) into v_ads_pct
    from wholesale_v2.v2_ranking_config where key = 'feed_pct_ads';
  v_ads_pct  := least(greatest(coalesce(v_ads_pct, 20), 0), 100);
  v_ad_slots := floor(p_limit * v_ads_pct / 100.0);
  v_page     := floor(p_offset::numeric / p_limit);

  -- The SAME two rows RC-02 reads, so "popular" means one thing in this product.
  select coalesce(int_value, 3)  into v_min_buyers
    from wholesale_v2.v2_ranking_config where key = 'popular_min_buyers';
  select coalesce(int_value, 90) into v_days
    from wholesale_v2.v2_ranking_config where key = 'popular_window_days';
  v_min_buyers := coalesce(v_min_buyers, 3);
  v_days       := coalesce(v_days, 90);

  select count(*) into v_ad_total
    from (select distinct p.id
            from wholesale_v2.v2_products p
            join public.wholesalers w on w.wid = p.wid
            join wholesale_v2.v2_oggi_promoted op on op.product_id = p.id and op.active
           where p.is_public and w.active and coalesce(p.archived, false) = false
             and (p_category is null or p.category = p_category)) z;

  v_ads_before := least(v_ad_total, v_page * v_ad_slots);
  v_ads_now    := greatest(least(v_ad_slots, v_ad_total - v_ads_before), 0);
  v_org_before := greatest(p_offset - v_ads_before, 0);
  v_org_now    := greatest(p_limit - v_ads_now, 0);

  return query
  with eligible as (
    -- THE PUBLICNESS RULE, and still the only one. It now lives on the
    -- PRODUCT (MOD-03) rather than being reached through the catalog join.
    -- A product the wholesaler has not published never appears here, in any
    -- sort mode, for anyone. Scope is unchanged: 116 backfilled this flag
    -- from the join it replaces, and the two sets were compared in BOTH
    -- directions before either was trusted.
    select distinct p.id, p.name, p.category, p.wid, p.created_at
      from wholesale_v2.v2_products p
      join public.wholesalers w on w.wid = p.wid
     where p.is_public
       and w.active
       and coalesce(p.archived, false) = false
       and (p_category is null or p.category = p_category)
  ),
  scored as (
    select e.*,
           (select count(distinct o.client_id)
              from wholesale_v2.v2_orders o
              join wholesale_v2.v2_order_items i on i.order_id = o.id
              join wholesale_v2.v2_product_variants v on v.id = i.variant_id
             where v.product_id = e.id
               and o.status <> 'cancelled'
               and o.created_at > now() - make_interval(days => v_days)
           )::int as buyers
      from eligible e
  ),
  filtered as (
    select * from scored
     where v_sort <> 'popular' or buyers >= v_min_buyers
  ),
  shaped as (
    select
      f.id as product_id, f.name as product_name, f.category, f.wid, f.created_at, f.buyers,
      coalesce(nullif(btrim(w.name), ''), w.brand, f.wid) as wholesaler_name,
      w.logo as wholesaler_logo,
      (select coalesce(v.image_url, v.images->>0)
         from wholesale_v2.v2_product_variants v
        where v.product_id = f.id
          and coalesce(v.image_url, v.images->>0) is not null
        limit 1) as image_url,
      (select min(v.price) from wholesale_v2.v2_product_variants v
        where v.product_id = f.id and v.price is not null) as price_from,
      coalesce(w.currency, '$') as currency,
      case when f.wid = any(v_mine) then 'member' else 'none' end as access,
      exists (select 1 from wholesale_v2.v2_oggi_promoted op
               where op.product_id = f.id and op.active) as is_promoted
      from filtered f
      join public.wholesalers w on w.wid = f.wid
  ),
  woven as (
    select s.*,
           case v_sort
             when 'new'     then row_number() over (order by s.created_at desc, s.product_id)
             when 'popular' then row_number() over (order by s.buyers desc, s.created_at desc, s.product_id)
             -- THE WEAVE, for the browse: each store in rotation, so the page
             -- reads as a marketplace and no shop owns it.
             else row_number() over (partition by s.wid order by s.product_id)
           end as pos
      from shaped s
  ),
  ads as (
    select w2.*, row_number() over (order by w2.pos, w2.wholesaler_name, w2.product_id) as n
      from woven w2 where w2.is_promoted
  ),
  organic as (
    select w3.*, row_number() over (order by w3.pos, w3.wholesaler_name, w3.product_id) as n
      from woven w3 where not w3.is_promoted
  )
  select f.product_id, f.product_name, f.category, f.wid, f.wholesaler_name,
         f.wholesaler_logo, f.image_url, f.price_from, f.currency,
         f.access, f.is_promoted, f.slot
    from (
      select a.product_id, a.product_name, a.category, a.wid, a.wholesaler_name,
             a.wholesaler_logo, a.image_url, a.price_from, a.currency,
             a.access, a.is_promoted, 'promoted'::text as slot, 0 as band, a.n as ord
        from ads a
       where a.n > v_ads_before and a.n <= v_ads_before + v_ads_now
      union all
      select o.product_id, o.product_name, o.category, o.wid, o.wholesaler_name,
             o.wholesaler_logo, o.image_url, o.price_from, o.currency,
             o.access, o.is_promoted, 'organic'::text as slot, 1 as band, o.n as ord
        from organic o
       where o.n > v_org_before and o.n <= v_org_before + v_org_now
    ) f
   order by f.band, f.ord;
end;
$function$
;

-- THE PROOF. The eligible set must be IDENTICAL to the catalog join it
-- replaces -- not similar, identical -- in both directions. If a single
-- product differs, refuse to commit rather than change what the marketplace
-- shows without anyone measuring it.
do $$
declare
  v_gained int;
  v_lost   int;
  v_public int;
begin
  select count(*) into v_gained
    from wholesale_v2.v2_products p
    join public.wholesalers w on w.wid = p.wid
   where p.is_public and w.active and coalesce(p.archived,false) = false
     and not exists (
       select 1 from wholesale_v2.v2_catalog_products cp
         join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
        where cp.product_id = p.id and c.is_public);

  select count(*) into v_lost
    from (select distinct p.id
            from wholesale_v2.v2_products p
            join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
            join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
            join public.wholesalers w on w.wid = p.wid
           where c.is_public and w.active and coalesce(p.archived,false) = false) old
   where not exists (
     select 1 from wholesale_v2.v2_products p2
       join public.wholesalers w2 on w2.wid = p2.wid
      where p2.id = old.id and p2.is_public and w2.active
        and coalesce(p2.archived,false) = false);

  if v_gained > 0 or v_lost > 0 then
    raise exception
      'MOD-03: the marketplace would GAIN % and LOSE % products. Refusing.',
      v_gained, v_lost;
  end if;

  -- THE CONVERSE GUARD IS NOT HERE, AND THAT IS THE SECOND TIME.
  -- A draft of this block also refused when NO product was public -- the
  -- converse check, because "0 gained, 0 lost" is satisfied perfectly by two
  -- rules that both return nothing. It is a real property and it is worth
  -- asserting. It is just not a property of a MIGRATION.
  --
  -- Migration 116 was corrected yesterday for exactly this: an assertion about
  -- what the CORPUS contains, placed inside a migration, refuses to apply on a
  -- fresh replay into an empty database -- and then the repo can no longer
  -- rebuild production, which is the one job the migration set has. This one
  -- stopped replay_migrations.sh at file 121 of 121 the first time it ran.
  --
  -- A migration may assert things about the CHANGE IT MAKES. It may not assert
  -- things about the data it happens to find. The converse lives in
  -- check_marketplace_reads_product_flag assertion 9, which brings its own
  -- fixture and therefore its own corpus.
  --
  -- The comparison above stays: on an empty database it is trivially true and
  -- refuses nothing, and on real data it is the brake that matters.
  select count(*) into v_public from wholesale_v2.v2_products where is_public;
  raise notice 'MOD-03 ok: 0 gained, 0 lost, % public product(s) present', v_public;
end $$;
