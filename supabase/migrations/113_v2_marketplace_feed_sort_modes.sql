-- =============================================================================
-- 113 — sort modes for the feed, so the home page can be RAILS
-- =============================================================================
-- The MyStories Moow reference does not use one long grid. It uses named
-- horizontal rails — Best Sellers, New Arrivals, On Sale — and that is better
-- here for a reason particular to this product: a rail has a NAME, and a name
-- is somewhere honest to put a rule. Sponsored placement inside a rail whose
-- heading says what it is beats the same placement sprinkled invisibly through
-- one endless grid.
--
-- WHY THIS EXTENDS THE FEED INSTEAD OF REUSING v2_popular_now
-- -----------------------------------------------------------
-- v2_popular_now already ranks by distinct buyers and already reads RC-02's
-- config. Reusing it for a marketplace rail looks obviously right and is wrong
-- in two ways that both matter:
--
--   1. IT HAS NO is_public CHECK. It is scoped by MEMBERSHIP
--      (p.wid = any(v_wids)) because it was built as a shelf INSIDE a store the
--      buyer is already in, where every product is legitimately visible.
--      Pointed at a marketplace home page it would rank a product out of a
--      private tier-4 catalogue for any buyer who is a member of that store —
--      exactly the leak 112 exists to prevent, re-entering by another door.
--
--   2. IT DELIBERATELY EXCLUDES WHAT YOU ALREADY BUY. Correct for a discovery
--      shelf sitting above a reorder shelf; wrong for a rail headed "Best
--      Sellers", because a best seller does not stop being one when you buy it.
--
-- So SCOPE stays in the one function that knows the publicness rule, and only
-- the DEFINITION of popular is shared: this reads the same popular_min_buyers
-- and popular_window_days rows RC-02 reads, so the two surfaces cannot drift
-- into disagreeing about what popular means.
--
-- p_sort:
--   'woven'   (default) each store in rotation — the marketplace browse
--   'new'     newest first by product created_at
--   'popular' most distinct buying shops first inside the RC-02 window, and
--             only products clearing popular_min_buyers. An empty rail is the
--             honest answer when nothing has sold; the UI hides it.
--   anything else falls back to 'woven' rather than erroring — a typo in a rail
--   definition should show the ordinary browse, not a blank page.
--
-- The publicness rule, the ad share reserved against supply and exact paging
-- are unchanged and apply in every mode.
--
-- ⚠️ SEE 114. Adding a DEFAULTED argument to a PostgREST-exposed function is
-- not additive: `create or replace` creates a second overload rather than
-- replacing, and every existing 4-argument caller then fails with PGRST203.
-- The drop belongs in the same migration as the addition.
-- =============================================================================

create or replace function wholesale_v2.v2_marketplace_feed(
  p_account_id uuid default null,
  p_limit integer default 40,
  p_offset integer default 0,
  p_category text default null,
  p_sort text default 'woven')
returns table(
  product_id uuid, product_name text, category text,
  wid text, wholesaler_name text, wholesaler_logo text,
  image_url text, price_from numeric, currency text,
  access text, is_promoted boolean, slot text)
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
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
            join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
            join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
            join public.wholesalers w on w.wid = p.wid
            join wholesale_v2.v2_oggi_promoted op on op.product_id = p.id and op.active
           where c.is_public and w.active and coalesce(p.archived, false) = false
             and (p_category is null or p.category = p_category)) z;

  v_ads_before := least(v_ad_total, v_page * v_ad_slots);
  v_ads_now    := greatest(least(v_ad_slots, v_ad_total - v_ads_before), 0);
  v_org_before := greatest(p_offset - v_ads_before, 0);
  v_org_now    := greatest(p_limit - v_ads_now, 0);

  return query
  with eligible as (
    -- THE PUBLICNESS RULE, unchanged and still the only one. A private
    -- catalogue never appears here, in any sort mode, for anyone.
    select distinct p.id, p.name, p.category, p.wid, p.created_at
      from wholesale_v2.v2_products p
      join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
      join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
      join public.wholesalers w on w.wid = p.wid
     where c.is_public
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
$function$;

grant execute on function wholesale_v2.v2_marketplace_feed(uuid, integer, integer, text, text) to anon, authenticated;
