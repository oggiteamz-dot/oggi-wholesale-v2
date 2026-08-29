-- =============================================================================
-- 095 — BUY IT AGAIN                                          RC-01, 29 Aug 2026
-- =============================================================================
--
-- The single highest-intent thing a shop does is order the same box again. Every
-- other recommendation in phase 4 is a guess; this one is a fact the buyer
-- already told us by paying for it.
--
-- ==== THIS IS A LIVE OFFER, NOT A RECEIPT ==================================
--
-- The set is recomputed from ACTIVE memberships on every single call. It is
-- never stored, never cached, never materialised.
--
-- That is the whole design. A stored "your reorder list" would be a snapshot of
-- who a buyer WAS a customer of, and the moment a wholesaler revokes access the
-- snapshot becomes a shelf of products the buyer can see, wants, and cannot buy
-- — from a shop that has decided it does not want them. Recomputation makes the
-- revocation instant by construction rather than by remembering to invalidate
-- something. AC-13 says revoking is `active = false`; this function reads
-- `m.active` on the way in, so the two cannot drift apart.
--
-- ==== WHY IT CROSSES STORES ================================================
--
-- It reads every store the person can still enter, not just the one they happen
-- to be looking at. ID-01 made one person able to hold many memberships; this
-- is the first screen that pays that off. A buyer with three wholesalers has one
-- reordering rhythm, not three.
--
-- Two consequences that are deliberate:
--   • The caller passes NO wid. There is nothing here for a caller to claim —
--     the same rule as SR-01. Scope is derived, never supplied.
--   • `wholesaler_name` is returned on every row, because a cross-store shelf
--     must be able to answer "who am I buying this from" without a tap. Same
--     reasoning as DR-05, opposite direction: names are the buyer's business,
--     prices in a store they cannot enter are not.
--
-- ==== WHAT THIS MUST NEVER BECOME ==========================================
--
-- It must never read a promotion table. "Buy it again" is the buyer's own
-- history read back to them; the day a paid placement can enter it, the label
-- is a lie and the shelf is an advert wearing the buyer's own receipts. The
-- assertions below check that against the function's own source, so a future
-- edit that joins v2_oggi_promoted fails the migration rather than shipping.
--
-- It must never read v2_search_impressions either — SR-04's data wall runs in
-- this direction too.
--
-- ==== THE LEGACY PATH ======================================================
--
-- v2_portal_accounts.person_id is nullable on purpose (090): accounts created
-- before the person layer have no person. Those accounts fall back to their own
-- store's history rather than getting an empty shelf, because an account that
-- has been ordering for months and suddenly sees nothing looks broken, and the
-- honest answer for them is "your store", not "nothing".
-- =============================================================================

create or replace function wholesale_v2.v2_buy_it_again(
  p_account_id uuid,
  p_limit      integer default 12
)
returns table (
  product_id      uuid,
  product_name    text,
  wid             text,
  wholesaler_name text,
  image_url       text,
  price_from      numeric,
  currency        text,
  times_ordered   bigint,
  last_ordered_at timestamptz
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wids   text[];
  v_clients uuid[];
begin
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  -- ACTIVE memberships only, recomputed every call. See the header: this is a
  -- live offer, not a receipt, and a revoked store must fall out of it at once.
  select array_agg(distinct m.wid), array_agg(distinct m.client_id)
    into v_wids, v_clients
    from wholesale_v2.v2_person_memberships m
   where v_person is not null and m.person_id = v_person and m.active
     and m.client_id is not null;

  -- An account that predates the person layer still sees its own store's
  -- history. person_id is nullable on purpose (090).
  if v_wids is null then
    select array[a.wid], array[a.client_id] into v_wids, v_clients
      from wholesale_v2.v2_portal_accounts a
     where a.id = p_account_id and a.client_id is not null;
  end if;

  if v_wids is null or v_clients is null then return; end if;

  if p_limit is null or p_limit < 1 then p_limit := 12; end if;
  if p_limit > 50 then p_limit := 50; end if;

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
    count(distinct o.id)::bigint,
    max(o.created_at)
  from wholesale_v2.v2_orders o
  join wholesale_v2.v2_order_items i on i.order_id = o.id
  join wholesale_v2.v2_product_variants v on v.id = i.variant_id
  join wholesale_v2.v2_products p on p.id = v.product_id
  join public.wholesalers w on w.wid = p.wid
  where o.client_id = any(v_clients)     -- their own orders, by their own clients
    and o.wid = any(v_wids)              -- ...in a store they can STILL enter
    and p.wid = any(v_wids)
    and coalesce(p.archived, false) = false
    and w.active
  group by p.id, p.name, p.wid, w.name, w.brand, w.currency
  -- Most recent first: a shop's rhythm matters more than its all-time totals.
  order by max(o.created_at) desc, count(distinct o.id) desc, p.name
  limit p_limit;
end;
$fn$;

comment on function wholesale_v2.v2_buy_it_again(uuid, integer) is
  'RC-01. Products this person has ordered before, across every store they can STILL enter. Recomputed from active memberships on every call -- never stored, so a revoked store falls out at once. Takes no wid: scope is derived, never supplied.';

revoke all on function wholesale_v2.v2_buy_it_again(uuid, integer) from public;
grant execute on function wholesale_v2.v2_buy_it_again(uuid, integer) to anon, authenticated;

-- =============================================================================
-- SELF-ASSERTING. If any guarantee above is not true of what was just created,
-- this raises and the whole migration rolls back.
-- =============================================================================
do $$
declare
  n   int;
  src text;
  r   int;
begin
  -- 1. It exists, with exactly the shape the client mapper is written against.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_buy_it_again';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: expected exactly one v2_buy_it_again, found %', n; end if;

  select pg_get_function_result(p.oid) into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_buy_it_again';
  if src not ilike '%product_id%'      then raise exception 'ASSERT 2 FAILED: result is missing product_id'; end if;
  if src not ilike '%wholesaler_name%' then raise exception 'ASSERT 2 FAILED: result is missing wholesaler_name -- a cross-store shelf that cannot say which store is worse than no shelf'; end if;
  if src not ilike '%times_ordered%'   then raise exception 'ASSERT 2 FAILED: result is missing times_ordered'; end if;
  if src not ilike '%last_ordered_at%' then raise exception 'ASSERT 2 FAILED: result is missing last_ordered_at'; end if;

  -- 3. Buyers are anon; they authenticate outside Supabase Auth. Without this
  --    grant the shelf is silently empty for every real buyer.
  if not has_function_privilege('anon', 'wholesale_v2.v2_buy_it_again(uuid, integer)', 'execute')
    then raise exception 'ASSERT 3 FAILED: anon cannot execute v2_buy_it_again -- every buyer would see an empty shelf with no error'; end if;
  if not has_function_privilege('authenticated', 'wholesale_v2.v2_buy_it_again(uuid, integer)', 'execute')
    then raise exception 'ASSERT 3 FAILED: authenticated cannot execute v2_buy_it_again'; end if;
  if has_function_privilege('public', 'wholesale_v2.v2_buy_it_again(uuid, integer)', 'execute')
    then raise exception 'ASSERT 3 FAILED: PUBLIC still holds execute -- the revoke did not take'; end if;

  -- 4. SECURITY DEFINER with a pinned search_path. Without the pin, a definer
  --    function is a privilege-escalation hole waiting for a schema on the path.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_buy_it_again'
     and p.prosecdef and p.provolatile = 's'
     and array_to_string(p.proconfig, ',') ilike '%search_path%';
  if n <> 1 then raise exception 'ASSERT 4 FAILED: v2_buy_it_again is not STABLE SECURITY DEFINER with a pinned search_path'; end if;

  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_buy_it_again';

  -- 5. THE REVOCATION GUARANTEE, checked at the source. Membership activity must
  --    be consulted. An edit that drops it would leave a revoked buyer being
  --    offered that store's products, and no count would notice.
  if src !~* 'm\.active' then raise exception 'ASSERT 5 FAILED: the body no longer consults m.active -- a revoked store would keep appearing on the shelf'; end if;

  -- 6. Scope is derived, never supplied. No wid parameter, ever.
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'wholesale_v2' and p.proname = 'v2_buy_it_again')
     ) ilike '%wid%'
    then raise exception 'ASSERT 6 FAILED: v2_buy_it_again takes a wid -- a caller could then claim a store'; end if;

  -- 7. It is the buyer's own history, not a paid surface and not search telemetry.
  if src ~* 'v2_oggi_promoted'      then raise exception 'ASSERT 7 FAILED: the reorder shelf reads the promotion table -- this shelf is the buyer''s own receipts and must never become an advert'; end if;
  if src ~* 'v2_search_impressions' then raise exception 'ASSERT 7 FAILED: the reorder shelf reads search telemetry -- SR-04''s data wall runs in this direction too'; end if;

  -- 8. An account it cannot verify gets zero rows, not an exception. A render
  --    path that throws is a blank screen; a render path that returns nothing
  --    is an empty shelf, which is the honest answer.
  select count(*) into r from wholesale_v2.v2_buy_it_again('00000000-0000-0000-0000-000000000000'::uuid, 5);
  if r <> 0 then raise exception 'ASSERT 8 FAILED: an unverifiable account id returned % row(s)', r; end if;
  select count(*) into r from wholesale_v2.v2_buy_it_again(null, 5);
  if r <> 0 then raise exception 'ASSERT 8 FAILED: a null account id returned % row(s)', r; end if;

  raise notice '095 OK: reorder scope is derived from active memberships, anon can execute, and the shelf cannot read promotion or search telemetry.';
end $$;
