-- =============================================================================
-- 039 — OWNER ANALYTICS: the wholesaler drill-down (CR-0004)
-- =============================================================================
--
-- WHAT THIS IS FOR
-- ----------------
-- Hadi asked to click any wholesaler and see their whole business: how many
-- customers, how many orders over a time frame he picks (this week, this
-- month, six months, a year, custom, lifetime), their top-performing products,
-- their highest-paying customer, and a graph of what sells over time.
--
-- WHY THIS IS SQL AND NOT JAVASCRIPT
-- ----------------------------------
-- Every one of those is an AGGREGATE over the order history. Doing it in the
-- browser means downloading every order and every order line for a wholesaler
-- and summing them client-side. That works for the 1 order in the system today
-- and collapses at a thousand: it is slow on a 43.9 Mbps Beirut connection,
-- it burns memory on the Tecno and Infinix devices that are ~13% of Lebanese
-- mobile traffic, and every screen that wants the same number has to
-- reimplement the arithmetic and can get it subtly differently.
--
-- One definition, in one place, checked once.
--
-- SECURITY
-- --------
-- Every function is SECURITY DEFINER with an EXPLICIT owner check as its first
-- statement — the same pattern v2_create_wholesaler uses. SECURITY DEFINER
-- bypasses RLS by design, so without that check any authenticated buyer could
-- call these and read another tenant's entire revenue history. The check is
-- not a formality; it IS the access control for these functions.
--
-- search_path is pinned on every one. Without it, a caller who can create a
-- schema on their own search_path could shadow a table name and have this
-- function read theirs instead.
--
-- CANCELLED ORDERS ARE EXCLUDED FROM MONEY, COUNTED IN CANCELLATION RATE.
-- Stated here because it is the single most likely thing for two screens to
-- disagree about, and a revenue figure that quietly includes cancelled orders
-- is worse than no revenue figure.
--
-- NULL DATES MEAN LIFETIME. p_from/p_to are both optional; passing neither is
-- the "lifetime" case rather than a special code path.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared guard. One place to change if the ownership rule ever changes.
-- -----------------------------------------------------------------------------
create or replace function wholesale_v2.v2_require_owner()
returns void
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
begin
  if not wholesale_v2.v2_is_owner() then
    raise exception 'Only the platform owner can read cross-wholesaler analytics'
      using errcode = '42501';
  end if;
end;
$$;

comment on function wholesale_v2.v2_require_owner() is
  'Raises unless the caller is the platform owner. Called first in every owner analytics function -- these are SECURITY DEFINER and therefore bypass RLS, so this check IS their access control.';


-- =============================================================================
-- 1. HEADLINE SUMMARY for one wholesaler over a window
-- =============================================================================
create or replace function wholesale_v2.v2_owner_wholesaler_summary(
  p_wid   text,
  p_from  timestamptz default null,
  p_to    timestamptz default null
)
returns table (
  orders_count        bigint,
  revenue             numeric,
  avg_order_value     numeric,
  median_order_value  numeric,
  units_sold          bigint,
  cancelled_count     bigint,
  cancellation_rate   numeric,
  clients_total       bigint,
  clients_ordered     bigint,
  clients_never       bigint,
  clients_new         bigint,
  products_total      bigint,
  products_sold       bigint,
  first_order_at      timestamptz,
  last_order_at       timestamptz
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
begin
  perform wholesale_v2.v2_require_owner();

  return query
  with win as (
    select o.*
    from wholesale_v2.v2_orders o
    where o.wid = p_wid
      and (p_from is null or o.created_at >= p_from)
      and (p_to   is null or o.created_at <  p_to)
  ),
  -- Money and averages ignore cancelled orders. The cancellation RATE needs
  -- them, so they are kept in `win` and filtered per-metric rather than
  -- dropped up front.
  live as (select * from win where status is distinct from 'cancelled'),
  items as (
    select oi.qty, oi.line_total
    from wholesale_v2.v2_order_items oi
    join live l on l.id = oi.order_id
  )
  select
    (select count(*) from live)::bigint,
    coalesce((select sum(subtotal) from live), 0)::numeric,
    -- AOV and median are both reported because they disagree, and the
    -- disagreement is the useful part: one whale drags the mean and leaves
    -- the median alone.
    coalesce((select avg(subtotal) from live), 0)::numeric,
    coalesce((select percentile_cont(0.5) within group (order by subtotal) from live), 0)::numeric,
    coalesce((select sum(qty) from items), 0)::bigint,
    (select count(*) from win where status = 'cancelled')::bigint,
    case when (select count(*) from win) = 0 then 0
         else round((select count(*) from win where status = 'cancelled')::numeric
                    / (select count(*) from win)::numeric * 100, 1)
    end,
    (select count(*) from wholesale_v2.v2_clients c where c.wid = p_wid)::bigint,
    (select count(distinct client_id) from live where client_id is not null)::bigint,
    (select count(*) from wholesale_v2.v2_clients c
      where c.wid = p_wid
        and not exists (select 1 from live l where l.client_id = c.id))::bigint,
    (select count(*) from wholesale_v2.v2_clients c
      where c.wid = p_wid
        and (p_from is null or c.created_at >= p_from)
        and (p_to   is null or c.created_at <  p_to))::bigint,
    (select count(*) from wholesale_v2.v2_products p
      where p.wid = p_wid and coalesce(p.archived, false) = false)::bigint,
    (select count(distinct pr.id)
       from wholesale_v2.v2_order_items oi
       join live l on l.id = oi.order_id
       join wholesale_v2.v2_product_variants v on v.id = oi.variant_id
       join wholesale_v2.v2_products pr on pr.id = v.product_id)::bigint,
    (select min(created_at) from live),
    (select max(created_at) from live);
end;
$$;

comment on function wholesale_v2.v2_owner_wholesaler_summary(text, timestamptz, timestamptz) is
  'Headline figures for one wholesaler over an optional window. NULL dates = lifetime. Cancelled orders are excluded from money and units, included in cancellation_rate.';


-- =============================================================================
-- 2. TOP PRODUCTS — by revenue AND by units, because they disagree
-- =============================================================================
create or replace function wholesale_v2.v2_owner_top_products(
  p_wid   text,
  p_from  timestamptz default null,
  p_to    timestamptz default null,
  p_limit int default 10
)
returns table (
  product_id    uuid,
  product_name  text,
  units         bigint,
  revenue       numeric,
  order_count   bigint,
  pct_of_revenue numeric
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_total numeric;
begin
  perform wholesale_v2.v2_require_owner();

  select coalesce(sum(o.subtotal), 0) into v_total
  from wholesale_v2.v2_orders o
  where o.wid = p_wid
    and o.status is distinct from 'cancelled'
    and (p_from is null or o.created_at >= p_from)
    and (p_to   is null or o.created_at <  p_to);

  return query
  select
    pr.id,
    pr.name,
    sum(oi.qty)::bigint,
    sum(oi.line_total)::numeric,
    count(distinct o.id)::bigint,
    -- Share of revenue, so "top" is readable without doing mental arithmetic
    -- against the headline number.
    case when v_total = 0 then 0
         else round(sum(oi.line_total) / v_total * 100, 1) end
  from wholesale_v2.v2_order_items oi
  join wholesale_v2.v2_orders o           on o.id = oi.order_id
  join wholesale_v2.v2_product_variants v on v.id = oi.variant_id
  join wholesale_v2.v2_products pr        on pr.id = v.product_id
  where o.wid = p_wid
    and o.status is distinct from 'cancelled'
    and (p_from is null or o.created_at >= p_from)
    and (p_to   is null or o.created_at <  p_to)
  group by pr.id, pr.name
  order by sum(oi.line_total) desc, sum(oi.qty) desc
  limit greatest(p_limit, 1);
end;
$$;

comment on function wholesale_v2.v2_owner_top_products(text, timestamptz, timestamptz, int) is
  'Top products for one wholesaler in a window, with each one''s share of revenue. Ordered by revenue; units returned too because the two rankings disagree and both matter.';


-- =============================================================================
-- 3. TOP CLIENTS — who actually pays this wholesaler
-- =============================================================================
create or replace function wholesale_v2.v2_owner_top_clients(
  p_wid   text,
  p_from  timestamptz default null,
  p_to    timestamptz default null,
  p_limit int default 10
)
returns table (
  client_id      uuid,
  shop_name      text,
  phone          text,
  order_count    bigint,
  revenue        numeric,
  avg_order      numeric,
  last_order_at  timestamptz,
  pct_of_revenue numeric
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_total numeric;
begin
  perform wholesale_v2.v2_require_owner();

  select coalesce(sum(o.subtotal), 0) into v_total
  from wholesale_v2.v2_orders o
  where o.wid = p_wid
    and o.status is distinct from 'cancelled'
    and (p_from is null or o.created_at >= p_from)
    and (p_to   is null or o.created_at <  p_to);

  return query
  select
    c.id, c.shop_name, c.phone,
    count(o.id)::bigint,
    coalesce(sum(o.subtotal), 0)::numeric,
    coalesce(avg(o.subtotal), 0)::numeric,
    max(o.created_at),
    -- Concentration: one client at >25% of a wholesaler's revenue is a real
    -- risk signal, and it is invisible without this column.
    case when v_total = 0 then 0
         else round(coalesce(sum(o.subtotal), 0) / v_total * 100, 1) end
  -- NOTE: joined on client_id, never on buyer_label. buyer_label is a PERSON'S
  -- display name and shop_name is a BUSINESS name; matching them is the exact
  -- bug that made every dashboard read 0 orders / never ordered until 17 Aug.
  from wholesale_v2.v2_clients c
  left join wholesale_v2.v2_orders o
         on o.client_id = c.id
        and o.status is distinct from 'cancelled'
        and (p_from is null or o.created_at >= p_from)
        and (p_to   is null or o.created_at <  p_to)
  where c.wid = p_wid
  group by c.id, c.shop_name, c.phone
  order by coalesce(sum(o.subtotal), 0) desc, count(o.id) desc
  limit greatest(p_limit, 1);
end;
$$;

comment on function wholesale_v2.v2_owner_top_clients(text, timestamptz, timestamptz, int) is
  'Clients of one wholesaler ranked by spend in a window, with each one''s share of that wholesaler''s revenue. LEFT JOIN so never-ordered clients still appear, at zero.';


-- =============================================================================
-- 4. SALES OVER TIME — the graph
-- =============================================================================
create or replace function wholesale_v2.v2_owner_sales_series(
  p_wid    text,
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_bucket text default 'day'
)
returns table (
  bucket_start timestamptz,
  order_count  bigint,
  revenue      numeric,
  units        bigint
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_bucket text;
  v_from   timestamptz;
  v_to     timestamptz;
begin
  perform wholesale_v2.v2_require_owner();

  -- Allow-list, not interpolation. p_bucket reaches date_trunc, and accepting
  -- arbitrary text there is a SQL injection surface even inside a function.
  v_bucket := case lower(coalesce(p_bucket, 'day'))
                when 'hour'  then 'hour'
                when 'day'   then 'day'
                when 'week'  then 'week'
                when 'month' then 'month'
                else 'day'
              end;

  -- A chart with gaps where nothing sold is misleading -- it reads as "no
  -- data" rather than "no sales". generate_series fills every bucket so a
  -- quiet week is drawn as a zero, which is what actually happened.
  select coalesce(p_from, min(o.created_at)), coalesce(p_to, now())
    into v_from, v_to
  from wholesale_v2.v2_orders o
  where o.wid = p_wid and o.status is distinct from 'cancelled';

  if v_from is null then
    return; -- no orders at all; an empty result, not a row of zeros
  end if;

  return query
  with buckets as (
    select generate_series(
             date_trunc(v_bucket, v_from),
             date_trunc(v_bucket, v_to),
             ('1 ' || v_bucket)::interval
           ) as b
  ),
  agg as (
    select date_trunc(v_bucket, o.created_at) as b,
           count(*)::bigint                    as n,
           sum(o.subtotal)::numeric            as rev,
           coalesce(sum(oi.q), 0)::bigint      as u
    from wholesale_v2.v2_orders o
    left join lateral (
      select sum(qty) as q from wholesale_v2.v2_order_items where order_id = o.id
    ) oi on true
    where o.wid = p_wid
      and o.status is distinct from 'cancelled'
      and o.created_at >= v_from
      and o.created_at <  v_to + ('1 ' || v_bucket)::interval
    group by 1
  )
  select b.b,
         coalesce(agg.n, 0)::bigint,
         coalesce(agg.rev, 0)::numeric,
         coalesce(agg.u, 0)::bigint
  from buckets b
  left join agg on agg.b = b.b
  order by b.b;
end;
$$;

comment on function wholesale_v2.v2_owner_sales_series(text, timestamptz, timestamptz, text) is
  'Orders, revenue and units per time bucket for one wholesaler. Buckets with no sales are returned as zeros rather than omitted -- a gap in a chart reads as missing data, not as a quiet week.';


-- =============================================================================
-- 5. PRODUCT SALES OVER TIME — "what products sell, how much, in what window"
-- =============================================================================
create or replace function wholesale_v2.v2_owner_product_series(
  p_wid        text,
  p_product_ids uuid[] default null,
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_bucket     text default 'week'
)
returns table (
  bucket_start timestamptz,
  product_id   uuid,
  product_name text,
  units        bigint,
  revenue      numeric
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_bucket text;
begin
  perform wholesale_v2.v2_require_owner();

  v_bucket := case lower(coalesce(p_bucket, 'week'))
                when 'hour'  then 'hour'
                when 'day'   then 'day'
                when 'week'  then 'week'
                when 'month' then 'month'
                else 'week'
              end;

  return query
  select
    date_trunc(v_bucket, o.created_at),
    pr.id,
    pr.name,
    sum(oi.qty)::bigint,
    sum(oi.line_total)::numeric
  from wholesale_v2.v2_order_items oi
  join wholesale_v2.v2_orders o           on o.id = oi.order_id
  join wholesale_v2.v2_product_variants v on v.id = oi.variant_id
  join wholesale_v2.v2_products pr        on pr.id = v.product_id
  where o.wid = p_wid
    and o.status is distinct from 'cancelled'
    and (p_from is null or o.created_at >= p_from)
    and (p_to   is null or o.created_at <  p_to)
    -- NULL means "every product". An empty array would mean "none", which is
    -- a different instruction and is honoured as such.
    and (p_product_ids is null or pr.id = any(p_product_ids))
  group by 1, pr.id, pr.name
  order by 1, sum(oi.line_total) desc;
end;
$$;

comment on function wholesale_v2.v2_owner_product_series(text, uuid[], timestamptz, timestamptz, text) is
  'Units and revenue per product per time bucket. p_product_ids NULL = all products; an empty array means none, which is a different instruction and is honoured.';


-- =============================================================================
-- 6. CLIENT LIST — "see their individual customers in a database"
-- =============================================================================
create or replace function wholesale_v2.v2_owner_client_list(
  p_wid  text,
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  client_id     uuid,
  shop_name     text,
  phone         text,
  discount_pct  numeric,
  active        boolean,
  created_at    timestamptz,
  order_count   bigint,
  revenue       numeric,
  last_order_at timestamptz,
  units         bigint
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
begin
  perform wholesale_v2.v2_require_owner();

  return query
  select
    c.id, c.shop_name, c.phone, c.discount_pct, c.active, c.created_at,
    count(distinct o.id)::bigint,
    coalesce(sum(o.subtotal), 0)::numeric,
    max(o.created_at),
    coalesce((
      select sum(oi.qty)
      from wholesale_v2.v2_order_items oi
      join wholesale_v2.v2_orders o2 on o2.id = oi.order_id
      where o2.client_id = c.id
        and o2.status is distinct from 'cancelled'
        and (p_from is null or o2.created_at >= p_from)
        and (p_to   is null or o2.created_at <  p_to)
    ), 0)::bigint
  from wholesale_v2.v2_clients c
  left join wholesale_v2.v2_orders o
         on o.client_id = c.id
        and o.status is distinct from 'cancelled'
        and (p_from is null or o.created_at >= p_from)
        and (p_to   is null or o.created_at <  p_to)
  where c.wid = p_wid
  group by c.id, c.shop_name, c.phone, c.discount_pct, c.active, c.created_at
  order by coalesce(sum(o.subtotal), 0) desc, c.shop_name;
end;
$$;

comment on function wholesale_v2.v2_owner_client_list(text, timestamptz, timestamptz) is
  'Every client of one wholesaler with their stats in the window. LEFT JOIN so a client who has never ordered still appears -- those are the ones worth chasing, and omitting them would hide the whole point.';


-- =============================================================================
-- GRANTS
-- Execute is granted to authenticated only. anon has no business calling
-- these, and each function re-checks ownership internally anyway -- but a
-- function anon cannot invoke is one fewer surface to reason about.
-- =============================================================================
revoke all on function wholesale_v2.v2_require_owner()                                                    from public, anon;
revoke all on function wholesale_v2.v2_owner_wholesaler_summary(text, timestamptz, timestamptz)           from public, anon;
revoke all on function wholesale_v2.v2_owner_top_products(text, timestamptz, timestamptz, int)            from public, anon;
revoke all on function wholesale_v2.v2_owner_top_clients(text, timestamptz, timestamptz, int)             from public, anon;
revoke all on function wholesale_v2.v2_owner_sales_series(text, timestamptz, timestamptz, text)           from public, anon;
revoke all on function wholesale_v2.v2_owner_product_series(text, uuid[], timestamptz, timestamptz, text)  from public, anon;
revoke all on function wholesale_v2.v2_owner_client_list(text, timestamptz, timestamptz)                  from public, anon;

grant execute on function wholesale_v2.v2_owner_wholesaler_summary(text, timestamptz, timestamptz)          to authenticated;
grant execute on function wholesale_v2.v2_owner_top_products(text, timestamptz, timestamptz, int)           to authenticated;
grant execute on function wholesale_v2.v2_owner_top_clients(text, timestamptz, timestamptz, int)            to authenticated;
grant execute on function wholesale_v2.v2_owner_sales_series(text, timestamptz, timestamptz, text)          to authenticated;
grant execute on function wholesale_v2.v2_owner_product_series(text, uuid[], timestamptz, timestamptz, text) to authenticated;
grant execute on function wholesale_v2.v2_owner_client_list(text, timestamptz, timestamptz)                 to authenticated;

-- -----------------------------------------------------------------------------
-- Indexes. Every function above filters orders by (wid, created_at) and joins
-- items by order_id. Without these, each drill-down is a sequential scan of the
-- whole orders table -- fine at 1 order, not at 100,000.
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- a migration executes in, and these tables are small enough today that a brief
-- lock is irrelevant. Revisit if this is ever applied to a large live table.
-- -----------------------------------------------------------------------------
create index if not exists v2_orders_wid_created_idx
  on wholesale_v2.v2_orders (wid, created_at desc);

create index if not exists v2_orders_client_created_idx
  on wholesale_v2.v2_orders (client_id, created_at desc)
  where client_id is not null;

create index if not exists v2_order_items_order_idx
  on wholesale_v2.v2_order_items (order_id);

create index if not exists v2_order_items_variant_idx
  on wholesale_v2.v2_order_items (variant_id);
