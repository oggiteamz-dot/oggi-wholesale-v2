-- =============================================================================
-- 111 — cross-store search threw on every real query
-- =============================================================================
-- Found 1 Sep 2026 while checking whether the pieces for a real marketplace
-- browse already existed. They do. This one was on fire.
--
-- v2_search_products clears its scratch table with
--
--     delete from tmp_search_hits;
--
-- and this project has the `safeupdate` guard on, which refuses any DELETE or
-- UPDATE without a WHERE. So every search with an actual term came back
--
--     21000: DELETE requires a WHERE clause
--
-- Not "no results" — an error. Cross-store search (SR-01), the feature that
-- answers "find me black denim across every wholesaler I can buy from", has
-- been broken in production since the day it shipped.
--
-- WHY NOTHING CAUGHT IT. An empty query returns early — v_norm must be 2+
-- characters — and never reaches the delete. The one input that works is the
-- one nobody searches with, and it is the one a smoke test uses.
--
-- TRUNCATE is the right statement anyway: the table is `on commit drop`
-- scratch, and truncate says "empty this" rather than "delete every row",
-- which is the distinction the guard exists to make you state out loud.
--
-- Verified after applying, as the demo buyer: "boot" returns 5 products across
-- TWO wholesalers (Casa Sole 3, Meridian 2) in one list.
--
-- Body is otherwise identical to 0xx. Only the delete changed.

create or replace function wholesale_v2.v2_search_products(
  p_account_id uuid, p_q text, p_limit integer default 30, p_offset integer default 0)
returns table(product_id uuid, product_name text, category text, wid text,
              wholesaler_name text, image_url text, price_from numeric,
              currency text, is_promoted boolean, slot text)
language plpgsql
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_person uuid;
  v_wids   text[];
  v_norm   text;
  v_found  int;
  v_event  uuid := gen_random_uuid();
  PROMO_CAP constant int := 3;
  LOG_CAP   constant int := 20;   -- a buyer does not see row 47
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
  -- THE FIX. Was `delete from tmp_search_hits;`, which safeupdate refuses.
  truncate tmp_search_hits;

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
$function$;
