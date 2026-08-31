-- =============================================================================
-- 112 — THE MARKETPLACE FEED
-- =============================================================================
-- Hadi, 1 Sep 2026: "one marketplace, full-scale, imagine Amazon, with
-- different stores inside that marketplace ... the products we recommend in the
-- homepage are the products the wholesalers made public ... if a catalog is
-- made fully public, it's automatically inside the market. And if it's not
-- public, then someone needs to click on it and get access."
--
-- WHAT DECIDES WHAT IS IN HERE
-- ----------------------------
-- The WHOLESALER does, per catalogue, by setting is_public. Not the buyer's
-- memberships, and not OGGI.
--
-- That is why this is a new function rather than a widening of
-- v2_search_products. Search is scoped to "stores you belong to"; the feed is
-- scoped to "catalogues their owners published". Two different questions, and
-- they must not come to share one definition — the day they do, widening one
-- silently widens the other.
--
-- A PRIVATE CATALOGUE NEVER APPEARS HERE, FOR ANYONE, MEMBER OR NOT.
-- Atelier's tier-4 Occasion Private Edit and tier-5 Archive stay invisible even
-- to a buyer already inside Atelier; they see those in the store, where the
-- tier rules run. A feed that leaked a private line would break the promise the
-- access tiers make, and would break it silently.
--
-- WHY PRICE IS VISIBLE TO NON-MEMBERS
-- A public catalogue is ALREADY reachable with no login at all through its
-- share link, prices and all — that is what publishing one means in this
-- product today. Hiding the price here while the share link shows it would be a
-- rule that only confuses. `access` says whether you can BUY; it does not
-- pretend you cannot see.
--
-- THE PERCENTAGE MIX, AND THE RULE THAT MATTERS
-- Hadi: OG and advertising "will only become functional as a percentage of
-- what's shown when they are available. If not available, you just show the
-- wholesalers."
--
-- So the ad share is reserved against SUPPLY, never against the percentage:
--
--     ads_before    = least(total_ads, page * ad_slots)
--     ads_this_page = least(ad_slots, total_ads - ads_before)
--     org_before    = offset - ads_before        -- subtracted, not multiplied
--     org_this_page = limit - ads_this_page
--
-- Deriving the organic offset by SUBTRACTING the ads actually shown is what
-- keeps paging exact as ad supply runs out mid-feed. A fixed per-page organic
-- count silently skips or repeats rows on the page where the ads stop.
--
-- OG IS DELIBERATELY NOT IMPLEMENTED. There is no representation of
-- OGGI-owned products anywhere in this schema, and inventing one inside a feed
-- function is how a business model gets decided by accident. feed_pct_oggi
-- exists and is 0; when an OGGI tenant exists this function gains one branch.
--
-- TWO DEAD ENDS, RECORDED BECAUSE THEY WILL BE REINVENTED OTHERWISE
--   1. A per-store cap (feed_max_per_store) to stop one shop owning the page.
--      It capped GLOBALLY, so the whole feed was 24 products and page two was
--      empty. The cap is also unnecessary: the weave — numbering each store's
--      products and ordering by that number — already gives every shop an equal
--      share of every page, and lets a deeper catalogue keep contributing once
--      the small ones run out, which is correct.
--   2. Reserving the ad share against the percentage. With zero promoted
--      products every page came back 16 rows instead of 20.
--   Both were caught by asking for page TWO instead of trusting page one.
--
-- The live database records these as separate migrations (…_feed,
-- …_feed_paging, …_feed_ad_backfill, plus two restores from deliberately
-- red-proving the gate). This file is the single settled definition, so a
-- replay from scratch builds the working function once rather than replaying
-- two known-broken versions and a test scaffold.
--
-- GATE: checks/check_marketplace_feed.mjs — 14 assertions, red-proved twice.
-- Verified live: 97 distinct public products, 20-row pages, zero duplicates,
-- zero private-only products leaked to an anonymous caller OR to a member of
-- all six shops.
-- =============================================================================

insert into wholesale_v2.v2_ranking_config (key, int_value, note) values
  ('feed_pct_ads', 20,
   'MK-01. Percent of a feed page that may be paid placement. Ads take this '
   'share only when there ARE active promoted products to fill it; unused '
   'slots are backfilled with ordinary wholesaler products so a page is never '
   'short. Set 0 to turn advertising off entirely.'),
  ('feed_pct_oggi', 0,
   'MK-01. Percent of a feed page reserved for OGGI''s own products. Zero '
   'until an OGGI-owned tenant exists - there is no representation of one in '
   'this schema yet, and the feed must not pretend otherwise. Same backfill '
   'rule as ads.')
on conflict (key) do nothing;

create or replace function wholesale_v2.v2_marketplace_feed(
  p_account_id uuid default null,
  p_limit integer default 40,
  p_offset integer default 0,
  p_category text default null)
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
begin
  if p_limit is null or p_limit < 1 then p_limit := 40; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  -- Signed out is a legitimate state: the feed is the public face of the
  -- marketplace. It simply means nothing comes back marked as yours.
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

  -- How many promoted products are eligible right now. The reservation is made
  -- against THIS, not against the percentage; the percentage is only a ceiling.
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
    -- Every product in at least one PUBLIC catalogue of an ACTIVE wholesaler.
    -- distinct: a product may sit in two public catalogues (Atelier has two
    -- such products, which is why the feed is 97 rows and not 99).
    select distinct p.id, p.name, p.category, p.wid
      from wholesale_v2.v2_products p
      join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
      join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
      join public.wholesalers w on w.wid = p.wid
     where c.is_public
       and w.active
       and coalesce(p.archived, false) = false
       and (p_category is null or p.category = p_category)
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
               where op.product_id = e.id and op.active) as is_promoted
      from eligible e
      join public.wholesalers w on w.wid = e.wid
  ),
  -- THE WEAVE. Numbering within each store and ordering by that number is what
  -- makes this read as a marketplace and not as six catalogues stacked end to
  -- end. It is also the per-store fairness, with no cap needed.
  woven as (
    select s.*, row_number() over (partition by s.wid order by s.product_id) as pos
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
             a.access, a.is_promoted, 'promoted'::text as slot,
             0 as band, a.n as ord
        from ads a
       where a.n > v_ads_before and a.n <= v_ads_before + v_ads_now
      union all
      select o.product_id, o.product_name, o.category, o.wid, o.wholesaler_name,
             o.wholesaler_logo, o.image_url, o.price_from, o.currency,
             o.access, o.is_promoted, 'organic'::text as slot,
             1 as band, o.n as ord
        from organic o
       where o.n > v_org_before and o.n <= v_org_before + v_org_now
    ) f
   order by f.band, f.ord;
end;
$function$;

grant execute on function wholesale_v2.v2_marketplace_feed(uuid, integer, integer, text) to anon, authenticated;
