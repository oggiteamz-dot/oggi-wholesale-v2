-- =============================================================================
-- 099 — POPULAR RIGHT NOW                                     RC-02, 30 Aug 2026
-- =============================================================================
--
-- RC-02 was written down as "best seller in this category". It cannot be built
-- as written, and the reason is worth stating before the code rather than
-- discovering later.
--
-- ==== WHAT PRODUCTION ACTUALLY HOLDS, COUNTED ==============================
--
--   45 orders, 90 lines, across 2 of 7 stores (demo 44, mg 1)
--   7 distinct products ever ordered
--   3 distinct buyers behind all of it -- and one order with no buyer at all
--   1 category in the entire marketplace: 'apparel', on 6 of 23 live products
--
-- Ranked the obvious way, by order count, the "best sellers" are:
--
--   Merino Crew Knit    37 orders   3 distinct buyers   438 units
--   Oversized Hoodie     8 orders   1 distinct buyer    144 units
--   Cargo Pant           8 orders   1 distinct buyer     96 units
--   Wool Scarf           7 orders   1 distinct buyer     78 units
--   Ribbed Tank          6 orders   1 distinct buyer    120 units
--   Leather Belt         6 orders   1 distinct buyer     96 units
--
-- READ THE MIDDLE COLUMN. Five of those six are ONE SHOP ordering the same
-- thing over and over. That is a loyal customer, not a trend, and RC-01 already
-- has a shelf for precisely that. A rail built on order counts would show a
-- buyer their own habits back and label them the market's opinion.
--
-- ==== THE RULE THIS MIGRATION IS BUILT AROUND ==============================
--
--     POPULAR MEANS "MANY SHOPS BOUGHT IT", NOT "IT WAS BOUGHT MANY TIMES".
--
-- One shop reordering weekly is loyalty. Fifty shops each ordering once is a
-- trend. Only the second belongs under a heading that says "popular", and the
-- distinction is not cosmetic: ranking on order count makes the loudest single
-- customer the editor of everyone else's shelf.
--
-- So the rank is COUNT(DISTINCT buyer). Units and recency break ties and never
-- lead, because a large order is one shop's decision however large it is.
--
-- ==== AND A FLOOR UNDER IT =================================================
--
-- Below v2_popular_min_buyers distinct buyers, a product does not qualify. If
-- nothing qualifies the function returns NOTHING and the rail renders nothing
-- -- the same rule as the reorder shelf and the store switcher.
--
-- "Popular" backed by one buyer is a false claim wearing a confident label. A
-- shelf that lies once is not trusted again, and this one is asking a buyer to
-- spend money on the strength of it. An empty rail costs a strip of screen; a
-- dishonest one costs the shelf.
--
-- On today's data this floor means the rail is empty for almost everyone. That
-- is the correct output for a marketplace with three buyers in it, and it is
-- the whole point: the rail turns itself on when it has something true to say.
--
-- ==== WHAT IS DELIBERATELY EXCLUDED, AND WHY ===============================
--
-- CANCELLED ORDERS. They are in the data today (2 of them). An order that was
-- called off is evidence in the other direction, and counting it means the
-- shelf can be filled by orders nobody ever paid for.
--
-- THE CALLER'S OWN ORDERS. Otherwise "popular" is "buy it again" wearing a
-- different hat: the buyer's own repeat purchases would make a product look
-- popular TO THEM specifically, which is a mirror, not a recommendation.
--
-- WHAT THEY ALREADY BUY. A product the caller has ordered inside the window is
-- already on the reorder shelf directly above this one. Two shelves showing the
-- same thing is one wasted shelf.
--
-- STORES THEY CANNOT ENTER. Scope is derived from ACTIVE memberships on every
-- call and never supplied by the caller -- the rule from SR-01, RC-01 and
-- ID-09. A rail advertising a product behind a door that no longer opens is
-- worse than an empty rail, because the buyer can see it and cannot have it.
--
-- THE PROMOTION TABLE. v2_oggi_promoted and v2_search_impressions are not read
-- here, exactly as in RC-01. Paid placement is a separate and LABELLED thing.
-- The moment "popular" can be bought, the word stops meaning anything and every
-- other shelf in the app inherits the doubt.
--
-- ==== WHY THE CATEGORY IS A NARROWING AND NOT A REQUIREMENT ================
--
-- There is one category in production. Requiring one would make this function
-- return nothing for 17 of 23 products forever, waiting on a data-entry job
-- that has not happened. So p_category_key NARROWS the result when it is given
-- and something qualifies inside it, and otherwise the function answers the
-- wider question across the buyer's own stores. The rail says which question it
-- answered; it does not silently widen and keep the narrow label.
--
-- ==== THE THRESHOLDS ARE CONFIGURATION, NOT CONSTANTS ======================
--
-- The floor and the window live in v2_ranking_config, for the same reason the
-- colour families in 097 live in a table: "how many shops make a trend" is a
-- product judgement about a Lebanese wholesale market that will be wrong the
-- first time and needs to change without a migration. SR-07 (versioned ranking
-- config) will take ownership of this table; it is created here in the shape
-- SR-07 wants rather than as two magic numbers to be dug out later.
-- =============================================================================

-- --------------------------------------------------------- the config table --
create table if not exists wholesale_v2.v2_ranking_config (
  key         text primary key,
  int_value   integer,
  note        text not null,
  updated_at  timestamptz not null default now()
);

comment on table wholesale_v2.v2_ranking_config is
  'RC-02 / SR-07. Numbers that decide what gets recommended. DATA, not code: every value here is a product judgement about a specific market, will be wrong the first time, and must be changeable without a migration. Closed to anon and authenticated -- the functions that read it are SECURITY DEFINER and read it as owner.';

alter table wholesale_v2.v2_ranking_config enable row level security;
-- No grant and no policy. Gate S7: anon holds no key to any table in this
-- schema, and 098 is the migration that had to learn it the hard way.
revoke all on wholesale_v2.v2_ranking_config from anon, authenticated;

insert into wholesale_v2.v2_ranking_config (key, int_value, note) values
  ('popular_min_buyers', 3,
   'RC-02. How many DIFFERENT shops must have bought a product before it may be called popular. Below this it does not qualify and, if nothing qualifies, the rail renders nothing. 3 is a starting guess for a market with 3 buyers in it and is expected to rise.'),
  ('popular_window_days', 90,
   'RC-02. How far back the ranking looks. All-time totals ossify: whatever sold in the first month wins forever and nothing new can reach the shelf.'),
  ('popular_max_rows', 12,
   'RC-02. Hard ceiling on rows returned, whatever the caller asks for.')
on conflict (key) do nothing;

-- ------------------------------------------------------------- the function --
create or replace function wholesale_v2.v2_popular_now(
  p_account_id  uuid,
  p_category_key text default null,
  p_limit       integer default 12
)
returns table (
  product_id      uuid,
  product_name    text,
  wid             text,
  wholesaler_name text,
  image_url       text,
  price_from      numeric,
  currency        text,
  buyer_count     bigint,
  category_key    text,
  narrowed        boolean
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person   uuid;
  v_wids     text[];
  v_clients  uuid[];
  v_min      int;
  v_days     int;
  v_max      int;
  v_narrow   boolean := false;
  v_hits     int := 0;
begin
  -- Same front door as RC-01: a banned or inactive account gets nothing, and
  -- gets it by returning no rows rather than by raising, so a shelf that must
  -- not appear simply does not appear.
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  -- ACTIVE memberships, recomputed every call. A store revoked an hour ago
  -- must fall out of this immediately, not at the end of a session.
  select array_agg(distinct m.wid), array_agg(distinct m.client_id)
    into v_wids, v_clients
    from wholesale_v2.v2_person_memberships m
   where v_person is not null and m.person_id = v_person and m.active
     and m.client_id is not null;

  -- An account predating the person layer still sees its own store (090).
  if v_wids is null then
    select array[a.wid], array[a.client_id] into v_wids, v_clients
      from wholesale_v2.v2_portal_accounts a
     where a.id = p_account_id and a.client_id is not null;
  end if;

  if v_wids is null then return; end if;
  -- v_clients may legitimately be null for a scope with no client rows; the
  -- exclusions below are written to survive that rather than to assume it.

  select int_value into v_min  from wholesale_v2.v2_ranking_config where key='popular_min_buyers';
  select int_value into v_days from wholesale_v2.v2_ranking_config where key='popular_window_days';
  select int_value into v_max  from wholesale_v2.v2_ranking_config where key='popular_max_rows';
  v_min  := coalesce(v_min, 3);
  v_days := coalesce(v_days, 90);
  v_max  := coalesce(v_max, 12);

  if p_limit is null or p_limit < 1 then p_limit := v_max; end if;
  if p_limit > v_max then p_limit := v_max; end if;

  -- Does the NARROW question have an answer? Asked first and separately,
  -- because the alternative -- one query that quietly widens on empty -- cannot
  -- tell the caller which question it ended up answering, and a rail headed
  -- "Popular in Tops" showing trousers is a small lie told confidently.
  if p_category_key is not null then
    select count(*) into v_hits from (
      select 1
        from wholesale_v2.v2_orders o
        join wholesale_v2.v2_order_items i on i.order_id = o.id
        join wholesale_v2.v2_product_variants v on v.id = i.variant_id
        join wholesale_v2.v2_products p on p.id = v.product_id
        join public.wholesalers w on w.wid = p.wid
       where p.wid = any(v_wids) and o.wid = any(v_wids)
         and p.category_key = p_category_key
         and o.status <> 'cancelled'
         and o.created_at > now() - make_interval(days => v_days)
         and coalesce(p.archived,false) = false and w.active
         -- The probe carries the SAME exclusions as the query it is predicting.
         -- A probe with a looser WHERE clause is not a probe, it is a different
         -- question that happens to run first: it would report narrowed=true on
         -- a category whose only qualifying products are ones the caller
         -- already buys, and the rail would then head itself "Popular in Tops"
         -- over an empty list, or over the widened one.
         and (v_clients is null or not exists (
               select 1 from wholesale_v2.v2_orders mo
               join wholesale_v2.v2_order_items mi on mi.order_id = mo.id
               join wholesale_v2.v2_product_variants mv on mv.id = mi.variant_id
              where mv.product_id = p.id
                and mo.client_id = any(v_clients)
                and mo.status <> 'cancelled'
                and mo.created_at > now() - make_interval(days => v_days)))
       group by p.id
      having count(distinct o.client_id) >= v_min
    ) q;
    v_narrow := v_hits > 0;
  end if;

  return query
  select
    p.id,
    p.name,
    p.wid,
    coalesce(nullif(btrim(w.name), ''), w.brand, p.wid),
    (select coalesce(v2.image_url, v2.images->>0)
       from wholesale_v2.v2_product_variants v2
      where v2.product_id = p.id and coalesce(v2.image_url, v2.images->>0) is not null
      limit 1),
    (select min(v3.price) from wholesale_v2.v2_product_variants v3
      where v3.product_id = p.id and v3.price is not null),
    coalesce(w.currency, '$'),
    count(distinct o.client_id)::bigint,
    p.category_key,
    v_narrow
  from wholesale_v2.v2_orders o
  join wholesale_v2.v2_order_items i on i.order_id = o.id
  join wholesale_v2.v2_product_variants v on v.id = i.variant_id
  join wholesale_v2.v2_products p on p.id = v.product_id
  join public.wholesalers w on w.wid = p.wid
  where p.wid = any(v_wids)
    and o.wid = any(v_wids)
    and (not v_narrow or p.category_key = p_category_key)
    -- A cancelled order is evidence in the other direction.
    and o.status <> 'cancelled'
    and o.created_at > now() - make_interval(days => v_days)
    and coalesce(p.archived, false) = false
    and w.active
    -- NOT WHAT THEY ALREADY BUY. Anything the caller ordered inside the window
    -- is already on the reorder shelf directly above this one, and two shelves
    -- showing the same product is one wasted shelf. It is also what stops this
    -- being a mirror: the caller's own orders can never contribute to a shown
    -- product's buyer count, because a product they ordered is not shown.
    --
    -- THERE WAS A SECOND FILTER HERE and it has been deleted. It excluded the
    -- caller's own ORDER ROWS from the count, alongside this one, and it read
    -- like careful defence in depth. Red proof R5 removed it and produced ZERO
    -- failures -- which under the standing rule proves nothing, so it was worth
    -- asking why. The answer: every row it removed belonged to a product this
    -- filter had already excluded, so it could never fire. A dead filter in a
    -- position that looks like protection is worse than no filter, because the
    -- next reader counts it as one of two guarantees when there is only ever
    -- one. One filter, load-bearing, and a red proof that fails when it goes.
    and (v_clients is null or not exists (
          select 1 from wholesale_v2.v2_orders mo
          join wholesale_v2.v2_order_items mi on mi.order_id = mo.id
          join wholesale_v2.v2_product_variants mv on mv.id = mi.variant_id
         where mv.product_id = p.id
           and mo.client_id = any(v_clients)
           and mo.status <> 'cancelled'
           and mo.created_at > now() - make_interval(days => v_days)))
  group by p.id, p.name, p.wid, w.name, w.brand, w.currency, p.category_key
  -- DISTINCT BUYERS LEADS. Units and recency break ties and never lead: a
  -- large order is one shop's decision however large it is.
  having count(distinct o.client_id) >= v_min
  order by count(distinct o.client_id) desc,
           sum(i.qty) desc,
           max(o.created_at) desc,
           p.name
  limit p_limit;
end;
$fn$;

revoke all on function wholesale_v2.v2_popular_now(uuid, text, integer) from public;
grant execute on function wholesale_v2.v2_popular_now(uuid, text, integer) to anon, authenticated;

comment on function wholesale_v2.v2_popular_now(uuid, text, integer) is
  'RC-02. Products many DIFFERENT shops bought recently, inside the stores this account can still enter. Ranked by distinct buyers, never by order count -- one shop reordering weekly is loyalty, not a trend. Returns nothing when nothing clears the floor in v2_ranking_config. Never reads v2_oggi_promoted.';

-- =============================================================================
-- SELF-ASSERTING. Every assertion below holds on an EMPTY database as well as
-- a full one -- the lesson 097 learned by stopping the replay dead.
-- =============================================================================
do $$
declare n int; src text;
begin
  -- 1. The config exists and is closed to the browser roles (gate S7, 098).
  select count(*) into n from wholesale_v2.v2_ranking_config
   where key in ('popular_min_buyers','popular_window_days','popular_max_rows');
  if n <> 3 then raise exception 'ASSERT 1 FAILED: the ranking config is incomplete (% of 3)', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_ranking_config'
     and grantee in ('anon','authenticated','PUBLIC');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: the browser roles hold % grant(s) on the ranking config', n; end if;

  -- 2. THE DATA WALL. Asserted against the function's own source, because this
  --    is a promise about what it does NOT do and no fixture can demonstrate
  --    the absence of a join.
  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_popular_now';
  if src ~* 'v2_oggi_promoted' then
    raise exception 'ASSERT 2 FAILED: the popular shelf reads the promotion table -- paid placement has entered a shelf that claims to be earned'; end if;
  if src ~* 'v2_search_impressions' then
    raise exception 'ASSERT 2 FAILED: the popular shelf reads search telemetry -- SR-04''s data wall must hold in this direction too'; end if;

  -- 3. RANK BY BUYERS, NOT BY ORDERS. The single most important property in
  --    this file, and the one a later edit is most likely to "simplify" away.
  if src !~* 'count\(distinct o\.client_id\) desc' then
    raise exception 'ASSERT 3 FAILED: the ranking no longer leads on distinct buyers -- one loud customer is now editing everyone''s shelf'; end if;
  if src ~* 'order by[^;]*count\(distinct o\.id\)' then
    raise exception 'ASSERT 3 FAILED: the ranking counts orders'; end if;

  -- 4. Cancelled orders are excluded.
  if src !~* 'o\.status <> ''cancelled''' then
    raise exception 'ASSERT 4 FAILED: cancelled orders count toward popularity'; end if;

  -- 5. Scope is DERIVED. The function must never take a wid.
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_popular_now')) ~* 'wid' then
    raise exception 'ASSERT 5 FAILED: v2_popular_now accepts a wid -- scope must be derived from memberships, never supplied'; end if;

  -- 6. A null account gets nothing and does not raise. Callable on an empty
  --    database, which is the point: it must not need data to be correct.
  select count(*) into n from wholesale_v2.v2_popular_now(null, null, 5);
  if n <> 0 then raise exception 'ASSERT 6 FAILED: a null account got % rows', n; end if;

  select count(*) into n from wholesale_v2.v2_popular_now(
    '00000000-0000-0000-0000-000000000000'::uuid, null, 5);
  if n <> 0 then raise exception 'ASSERT 6 FAILED: an unknown account got % rows', n; end if;

  -- 7. The floor is a real number and not zero. A floor of zero is no floor,
  --    and the whole claim of this shelf rests on there being one.
  select int_value into n from wholesale_v2.v2_ranking_config where key='popular_min_buyers';
  if n is null or n < 2 then
    raise exception 'ASSERT 7 FAILED: the minimum-buyer floor is % -- below 2, "popular" can be one shop', coalesce(n,-1); end if;

  raise notice '099 OK: popular ranks on distinct buyers, excludes cancellations and the caller''s own orders, and reads no promotion table.';
end $$;
