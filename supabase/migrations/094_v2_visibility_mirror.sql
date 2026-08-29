-- =============================================================================
-- 094 — THE VISIBILITY MIRROR                                SR-06, 29 Aug 2026
-- =============================================================================
--
-- Migration 093 made a promise to wholesalers: OGGI's paid shelf does not touch
-- your ranking. That promise is currently true, and gated, and completely
-- unverifiable by the person it was made to.
--
-- SR-06 is what turns it into something a wholesaler can check: their own
-- impressions, their positions, and specifically HOW OFTEN A PAID PLACEMENT
-- APPEARED ABOVE ONE OF THEIR PRODUCTS. That last number is the one that
-- matters. A marketplace that publishes it is making a commitment it can be
-- held to; one that does not is asking to be trusted.
--
-- ==== WHAT IS DELIBERATELY NOT COLLECTED ===================================
--
-- No person_id. No account id. Nothing identifying WHO searched.
--
-- This table is read by wholesalers. If it carried the searcher's identity,
-- then either it leaks which of their competitors' buyers are shopping — or it
-- does not leak because a filter is correct today and one careless join from
-- being wrong tomorrow. NOT COLLECTING IS A STRONGER GUARANTEE THAN NOT
-- EXPOSING, and it costs nothing: no question SR-06 asks needs to know who.
--
-- The query text IS kept, normalised, because "what were people looking for
-- when they saw my product" is the whole value of the mirror, and a normalised
-- query is about the market rather than about a person.
--
-- ==== WHY IMPRESSIONS ARE CAPPED PER SEARCH ================================
--
-- Only the first 20 results of a search are logged. A buyer does not see row
-- 47, so recording it as an "impression" would be a lie in the wholesaler's
-- favour on the count and against them on the average position. Capping keeps
-- the number honest and bounds the write cost at the same time.
-- =============================================================================

create table if not exists wholesale_v2.v2_search_impressions (
  id           bigserial primary key,
  event_id     uuid not null,
  q_normalised text not null,
  wid          text not null,
  product_id   uuid,
  position     integer not null,
  slot         text not null check (slot in ('promoted','organic')),
  created_at   timestamptz not null default now()
);

create index if not exists v2_search_impressions_wid_idx
  on wholesale_v2.v2_search_impressions (wid, created_at desc);
create index if not exists v2_search_impressions_event_idx
  on wholesale_v2.v2_search_impressions (event_id);

comment on table wholesale_v2.v2_search_impressions is
  'SR-06. What was shown, where, and in which slot. Deliberately carries NO person_id and no account id: this table is read by wholesalers, and not collecting the searcher''s identity is a stronger guarantee than collecting it behind a filter that is correct today. event_id groups the rows from one search so "a paid placement appeared above my product" is answerable.';
comment on column wholesale_v2.v2_search_impressions.position is
  'Rank within its own slot, 1-based. Only the first 20 organic rows are logged: a buyer does not see row 47, and counting it would flatter the impression total while damaging the average position.';

alter table wholesale_v2.v2_search_impressions enable row level security;
drop policy if exists v2_search_impressions_scoped on wholesale_v2.v2_search_impressions;
-- A wholesaler sees their OWN rows. Not the promoted rows that beat them --
-- those are reached only through the aggregate function below, which returns
-- counts and never names a competitor's product.
create policy v2_search_impressions_scoped on wholesale_v2.v2_search_impressions for all
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid())
  with check (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());
grant select on wholesale_v2.v2_search_impressions to authenticated;

-- ============================================================ the logging ===
-- Return type is unchanged from 093, so `create or replace` is enough here.
create or replace function wholesale_v2.v2_search_products(
  p_account_id uuid,
  p_q          text,
  p_limit      integer default 30,
  p_offset     integer default 0
)
returns table (
  product_id       uuid,
  product_name     text,
  category         text,
  wid              text,
  wholesaler_name  text,
  image_url        text,
  price_from       numeric,
  currency         text,
  is_promoted      boolean,
  slot             text
)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wids   text[];
  v_norm   text;
  v_found  int;
  v_event  uuid := gen_random_uuid();
  PROMO_CAP constant int := 3;
  LOG_CAP   constant int := 20;   -- see the header: row 47 was never seen
begin
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  v_norm := wholesale_v2.v2_search_normalise(p_q);
  if length(v_norm) < 2 then
    return;
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  select array_agg(distinct x) into v_wids from (
    select m.wid as x
      from wholesale_v2.v2_person_memberships m
     where v_person is not null and m.person_id = v_person and m.active
    union
    select a.wid from wholesale_v2.v2_portal_accounts a where a.id = p_account_id
  ) s;

  if v_wids is null or array_length(v_wids, 1) is null then
    return;
  end if;

  if p_limit is null or p_limit < 1 then p_limit := 30; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  create temporary table if not exists tmp_search_hits (
    product_id uuid, product_name text, category text, wid text,
    wholesaler_name text, image_url text, price_from numeric, currency text,
    rank int
  ) on commit drop;
  delete from tmp_search_hits;

  insert into tmp_search_hits
  select
    p.id, p.name, p.category, p.wid,
    coalesce(nullif(btrim(w.name), ''), w.brand, p.wid),
    (select coalesce(v.image_url, v.images->>0)
       from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and coalesce(v.image_url, v.images->>0) is not null
      limit 1),
    (select min(v.price) from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and v.price is not null),
    coalesce(w.currency, '$'),
    case
      when wholesale_v2.v2_search_normalise(p.name) like '%' || v_norm || '%' then 0
      when wholesale_v2.v2_search_normalise(coalesce(p.category,'')) like '%' || v_norm || '%' then 1
      else 2
    end
  from wholesale_v2.v2_products p
  join public.wholesalers w on w.wid = p.wid
  where p.wid = any(v_wids)
    and coalesce(p.archived, false) = false
    and w.active
    and (
         wholesale_v2.v2_search_normalise(p.name) like '%' || v_norm || '%'
      or wholesale_v2.v2_search_normalise(coalesce(p.category, '')) like '%' || v_norm || '%'
      or exists (
           select 1 from wholesale_v2.v2_product_variants v
            where v.product_id = p.id
              and wholesale_v2.v2_search_normalise(coalesce(v.sku, '')) like '%' || v_norm || '%'
         )
    );

  select count(*) into v_found from tmp_search_hits;

  if v_found = 0 then
    insert into wholesale_v2.v2_search_misses (person_id, q_raw, q_normalised, wids)
    values (v_person, left(coalesce(p_q, ''), 200), v_norm, v_wids);
    return;
  end if;

  -- ---- log what this search SHOWED, both slots, one event -----------------
  insert into wholesale_v2.v2_search_impressions (event_id, q_normalised, wid, product_id, position, slot)
  select v_event, v_norm, q.wid, q.product_id, q.pos, 'promoted'
    from (select t.wid, t.product_id,
                 row_number() over (order by t.rank, t.product_name) as pos
            from tmp_search_hits t
            join wholesale_v2.v2_oggi_promoted op
              on op.product_id = t.product_id and op.active) q
   where q.pos <= PROMO_CAP;

  insert into wholesale_v2.v2_search_impressions (event_id, q_normalised, wid, product_id, position, slot)
  select v_event, v_norm, q.wid, q.product_id, q.pos, 'organic'
    from (select t.wid, t.product_id,
                 row_number() over (order by t.rank, t.product_name, t.wholesaler_name) as pos
            from tmp_search_hits t) q
   where q.pos <= LOG_CAP;

  return query
  select t.product_id, t.product_name, t.category, t.wid, t.wholesaler_name,
         t.image_url, t.price_from, t.currency,
         true as is_promoted, 'promoted'::text as slot
    from tmp_search_hits t
    join wholesale_v2.v2_oggi_promoted op
      on op.product_id = t.product_id and op.active
   order by t.rank, t.product_name
   limit PROMO_CAP;

  return query
  select t.product_id, t.product_name, t.category, t.wid, t.wholesaler_name,
         t.image_url, t.price_from, t.currency,
         exists (select 1 from wholesale_v2.v2_oggi_promoted op2
                  where op2.product_id = t.product_id and op2.active) as is_promoted,
         'organic'::text as slot
    from tmp_search_hits t
   order by t.rank, t.product_name, t.wholesaler_name
   limit p_limit offset p_offset;
end;
$fn$;

revoke all on function wholesale_v2.v2_search_products(uuid, text, integer, integer) from public;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to anon;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to authenticated;

-- =============================================================== the mirror ==
create or replace function wholesale_v2.v2_search_visibility_mirror(p_days integer default 30)
returns table (
  impressions            bigint,
  searches               bigint,
  avg_position           numeric,
  outranked_by_paid      bigint,
  outranked_pct          numeric
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
  v_since timestamptz;
begin
  -- Resolved inside, never taken from the caller. A wid argument here would
  -- let one wholesaler read another's visibility, which is the single worst
  -- thing this table could be made to do.
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then return; end if;

  if p_days is null or p_days < 1 then p_days := 30; end if;
  if p_days > 365 then p_days := 365; end if;
  v_since := now() - make_interval(days => p_days);

  return query
  with mine as (
    select i.event_id, i.position
      from wholesale_v2.v2_search_impressions i
     where i.wid = v_wid and i.slot = 'organic' and i.created_at >= v_since
  ),
  beaten as (
    -- An event where a PAID placement belonging to SOMEONE ELSE was shown
    -- alongside one of my products. If the promoted product is mine, I was
    -- not outranked -- I was the one being promoted.
    select distinct m.event_id
      from mine m
      join wholesale_v2.v2_search_impressions p
        on p.event_id = m.event_id and p.slot = 'promoted' and p.wid <> v_wid
  )
  select
    (select count(*) from mine)::bigint,
    (select count(distinct m.event_id) from mine m)::bigint,
    (select round(avg(m.position), 2) from mine m),
    (select count(*) from beaten)::bigint,
    case when (select count(distinct m.event_id) from mine m) = 0 then 0
         else round(100.0 * (select count(*) from beaten)
                    / (select count(distinct m.event_id) from mine m), 1)
    end;
end;
$fn$;

revoke all on function wholesale_v2.v2_search_visibility_mirror(integer) from public;
grant execute on function wholesale_v2.v2_search_visibility_mirror(integer) to authenticated;
-- anon is NOT granted: this is a wholesaler-facing report and buyers are anon.

comment on function wholesale_v2.v2_search_visibility_mirror(integer) is
  'SR-06. A wholesaler''s own visibility: impressions, distinct searches, average organic position, and HOW OFTEN A PAID PLACEMENT BELONGING TO SOMEONE ELSE APPEARED ALONGSIDE THEIR PRODUCT. Takes no wid -- it resolves the caller with v2_my_wid(), because a wid argument would let one wholesaler read another''s visibility. Returns counts only: it never names a competitor''s product.';

-- ---- their own top queries, same rules ------------------------------------
create or replace function wholesale_v2.v2_search_visibility_queries(p_days integer default 30, p_limit integer default 20)
returns table (q_normalised text, impressions bigint, best_position integer)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_since timestamptz;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then return; end if;
  if p_days is null or p_days < 1 then p_days := 30; end if;
  if p_days > 365 then p_days := 365; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then p_limit := 20; end if;
  v_since := now() - make_interval(days => p_days);

  return query
  select i.q_normalised, count(*)::bigint, min(i.position)::integer
    from wholesale_v2.v2_search_impressions i
   where i.wid = v_wid and i.slot = 'organic' and i.created_at >= v_since
   group by i.q_normalised
   order by count(*) desc, i.q_normalised
   limit p_limit;
end;
$fn$;

revoke all on function wholesale_v2.v2_search_visibility_queries(integer, integer) from public;
grant execute on function wholesale_v2.v2_search_visibility_queries(integer, integer) to authenticated;

-- =============================================================================
-- SELF-ASSERTING.
-- =============================================================================
do $$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema='wholesale_v2' and table_name='v2_search_impressions';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: v2_search_impressions was not created'; end if;

  -- THE PRIVACY RULE. Not collected, not merely not exposed.
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_search_impressions'
     and (column_name ilike '%person%' or column_name ilike '%account%'
       or column_name ilike '%buyer%' or column_name ilike '%client%');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: the impression log has a column identifying the searcher -- wholesalers read this table, and not collecting is a stronger guarantee than filtering'; end if;

  -- Neither mirror may take a wid from its caller.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2'
     and p.proname in ('v2_search_visibility_mirror','v2_search_visibility_queries')
     and pg_get_function_identity_arguments(p.oid) ilike '%wid%';
  if n <> 0 then raise exception 'ASSERT 3 FAILED: a visibility function takes a wid -- one wholesaler could then read another''s numbers'; end if;

  -- Buyers are anon. This is not for them.
  if has_function_privilege('anon','wholesale_v2.v2_search_visibility_mirror(integer)','execute')
    then raise exception 'ASSERT 4 FAILED: anon can read the visibility mirror'; end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_search_impressions' and grantee='anon';
  if n <> 0 then raise exception 'ASSERT 5 FAILED: anon holds % grant(s) on the impression log', n; end if;

  -- The mirror reports counts, never a competitor's product.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_visibility_mirror'
     and (pg_get_function_result(p.oid) ilike '%product_name%'
       or pg_get_function_result(p.oid) ilike '%competitor%');
  if n <> 0 then raise exception 'ASSERT 6 FAILED: the mirror returns product detail -- it must report that they were outranked, not by what'; end if;

  raise notice '094 OK: impressions logged with no searcher identity; the mirror resolves the wholesaler itself and reports counts only.';
end $$;
