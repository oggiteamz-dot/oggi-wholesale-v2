-- =============================================================================
-- 105 — THE BUYER CAN SEE WHERE THEIR REQUEST STANDS   AC-07, AC-11, PB-01, 30 Aug
-- =============================================================================
--
-- A shop asks a wholesaler for access. Today that request goes into a table,
-- the wholesaler eventually approves or declines it, and **the buyer is never
-- told anything at any point.** Not that it arrived, not that it was answered,
-- not why.
--
-- The complaint this is built from is verbatim, from Shopify Collective:
--
--     "Without confirmation that suppliers have even seen the request, it makes
--      it nearly impossible to move forward with any certainty, which delays
--      potential sales."
--
-- And NuORDER's, for the other half: "If you Decline or Archive a connection
-- request, the buyer doesn't receive a rejection email." Almost nobody tells
-- the buyer. It is a cheap trust win competitors leave on the table.
--
-- ==== A NOTE ON THE REGISTRY CODE ==========================================
--
-- This is AC-07 and AC-11 in the access-control registry, and it is ALSO
-- **PB-01** -- "a pending buyer sees a real 'we got it, here is what happens
-- next' screen, not a dead end". The overnight prompt of 30 August described
-- PB-01/02/03 as "the paid feed" and deferred them; the 28 August matrix, which
-- is where those codes come from, defines PB as *pending buyer*. The paid feed
-- genuinely is deferred ("scrap the ads thing until we fully launch this") and
-- is untouched. PB-01 is built here because it is the same feature as AC-07 and
-- was in the pre-launch order under that name. PB-02 and PB-03 are NOT built --
-- they need Hadi.
--
-- ==== WHY THE SLA IS PER-WHOLESALER AND NOT ONE GLOBAL NUMBER ==============
--
-- Because it is a promise, and the person who has to keep it is the wholesaler,
-- not OGGI. A single platform-wide "answered within 24 hours" would be OGGI
-- promising something on behalf of someone who never agreed to it, and the
-- first time a wholesaler took three days it would be OGGI that looked
-- dishonest. Each wholesaler carries their own number, defaulting to 48 hours,
-- and it is shown as an EXPECTATION ("usually answers within...") rather than a
-- guarantee.
--
-- ==== WHAT "ESCALATION" MEANS HERE =========================================
--
-- Not an email to the buyer -- there is no transactional email in this build
-- and pretending otherwise would be the exact overclaim this project keeps a
-- file about. It means two true things:
--   1. The BUYER sees that their request is taking longer than that wholesaler
--      usually takes, so they can chase it themselves rather than assume they
--      were ignored.
--   2. The OWNER can list every request that has aged past its wholesaler's own
--      stated time, so OGGI can nudge the wholesaler. That is the only
--      escalation path that actually exists in a marketplace this size.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. EACH WHOLESALER'S OWN STATED TIME
-- ---------------------------------------------------------------------------
alter table wholesale_v2.v2_wholesalers
  add column if not exists access_sla_hours integer not null default 48;

comment on column wholesale_v2.v2_wholesalers.access_sla_hours is
  'AC-11. How long this wholesaler says they take to answer an access request, in hours. Shown to buyers as an expectation, never as a guarantee, because the person who has to keep it is the wholesaler and not OGGI. 48 is a default, not a promise anyone made.';

alter table wholesale_v2.v2_wholesalers
  drop constraint if exists v2_wholesalers_sla_sane;
alter table wholesale_v2.v2_wholesalers
  add constraint v2_wholesalers_sla_sane check (access_sla_hours between 1 and 720);

-- ---------------------------------------------------------------------------
-- 2. WHAT THE BUYER SEES
-- ---------------------------------------------------------------------------
-- Scoped by the caller's own person, resolved INSIDE the function from the
-- account id. There is deliberately nothing here for a caller to name: a
-- function taking a person_id would let anyone read anyone's rejections.
create or replace function wholesale_v2.v2_my_access_requests(p_account_id text)
returns table (
  request_id     uuid,
  wid            text,
  wholesaler_name text,
  brand          text,
  status         text,
  requested_at   timestamptz,
  decided_at     timestamptz,
  reason_code    text,
  reason_text    text,
  sla_hours      integer,
  hours_waiting  integer,
  overdue        boolean
)
language plpgsql stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_acc uuid; v_person uuid;
begin
  begin v_acc := p_account_id::uuid; exception when others then return; end;
  if not wholesale_v2.v2_account_can_act(v_acc) then return; end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = v_acc;
  if v_person is null then return; end if;

  return query
  select r.id, r.wid,
         coalesce(nullif(btrim(w.name),''), w.brand, r.wid),
         w.brand,
         r.status,
         r.created_at,
         r.decided_at,
         r.reason_code,
         r.reason_text,
         w.access_sla_hours,
         greatest(0, floor(extract(epoch from (now() - r.created_at)) / 3600)::integer),
         (r.status = 'pending'
          and now() > r.created_at + make_interval(hours => w.access_sla_hours))
    from wholesale_v2.v2_signup_requests r
    join wholesale_v2.v2_wholesalers w on w.wid = r.wid
   where r.person_id = v_person
   order by r.created_at desc;
end $fn$;

comment on function wholesale_v2.v2_my_access_requests(text) is
  'AC-07/AC-11/PB-01. Every access request this person has made, and where each stands. Scope is the caller''s own person, resolved inside the function -- there is nothing here for a caller to name, because a function taking a person_id would let anyone read anyone else''s rejections.';

revoke all on function wholesale_v2.v2_my_access_requests(text) from public;
grant execute on function wholesale_v2.v2_my_access_requests(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. WHAT THE OWNER SEES — the escalation
-- ---------------------------------------------------------------------------
create or replace function wholesale_v2.v2_overdue_access_requests()
returns table (
  request_id     uuid,
  wid            text,
  wholesaler_name text,
  buyer_name     text,
  requested_at   timestamptz,
  sla_hours      integer,
  hours_waiting  integer
)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select r.id, r.wid,
         coalesce(nullif(btrim(w.name),''), w.brand, r.wid),
         r.buyer_name,
         r.created_at,
         w.access_sla_hours,
         greatest(0, floor(extract(epoch from (now() - r.created_at)) / 3600)::integer)
    from wholesale_v2.v2_signup_requests r
    join wholesale_v2.v2_wholesalers w on w.wid = r.wid
   where wholesale_v2.v2_is_owner()
     and r.status = 'pending'
     and now() > r.created_at + make_interval(hours => w.access_sla_hours)
   order by r.created_at;
$fn$;

comment on function wholesale_v2.v2_overdue_access_requests() is
  'AC-11, the escalation half. Every request that has aged past its OWN wholesaler''s stated time -- not a platform-wide number, because the promise belongs to the wholesaler. Owner only: this is a list of who is keeping shops waiting, and it is not the other wholesalers'' business.';

revoke all on function wholesale_v2.v2_overdue_access_requests() from public, anon;
grant execute on function wholesale_v2.v2_overdue_access_requests() to authenticated;

-- =============================================================================
-- SELF-ASSERTING. Every assertion holds on an EMPTY database as well as a full
-- one -- nothing below counts rows against an absolute number.
-- =============================================================================
do $$
declare n int; v_def text;
begin
  -- 1. Every wholesaler has a stated time, and it is a sane one.
  select count(*) into n from wholesale_v2.v2_wholesalers where access_sla_hours is null;
  if n <> 0 then raise exception 'ASSERT 1 FAILED: % wholesaler(s) have no stated answer time', n; end if;
  select count(*) into n from wholesale_v2.v2_wholesalers
   where access_sla_hours < 1 or access_sla_hours > 720;
  if n <> 0 then raise exception 'ASSERT 1 FAILED: % wholesaler(s) have an impossible answer time', n; end if;

  -- 2. THE BUYER FUNCTION TAKES NO PERSON AND NO WID. Asserted against the
  --    signature, because this is a promise about what a caller CANNOT name.
  --    A person_id argument would let anyone read anyone else's rejections; a
  --    wid argument would let them enumerate which shops applied where.
  select pg_get_function_identity_arguments(p.oid) into v_def
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_my_access_requests';
  if v_def ~* 'person' or v_def ~* '\mwid\M' then
    raise exception 'ASSERT 2 FAILED: v2_my_access_requests accepts % -- scope must be derived, never supplied', v_def;
  end if;

  -- 3. It returns nothing for an unknown or malformed account rather than
  --    raising. It is called from a render path.
  select count(*) into n from wholesale_v2.v2_my_access_requests('not-a-uuid');
  if n <> 0 then raise exception 'ASSERT 3 FAILED: a malformed account id returned % row(s)', n; end if;
  select count(*) into n from wholesale_v2.v2_my_access_requests('00000000-0000-0000-0000-000000000000');
  if n <> 0 then raise exception 'ASSERT 3 FAILED: an unknown account returned % row(s)', n; end if;

  -- 4. The overdue list is OWNER ONLY. Run as postgres v2_is_owner() is false,
  --    so it must be empty here whatever the data says.
  select count(*) into n from wholesale_v2.v2_overdue_access_requests();
  if n <> 0 then raise exception 'ASSERT 4 FAILED: a non-owner listed % overdue request(s)', n; end if;

  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee='anon'
     and routine_name='v2_overdue_access_requests';
  if n <> 0 then raise exception 'ASSERT 4 FAILED: anon can list overdue access requests'; end if;

  -- 5. The buyer's own view IS reachable signed out-of-Supabase, because a
  --    buyer is not a Supabase Auth user -- they hold an account id. Without
  --    this grant the screen would be empty for every real buyer.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee='anon'
     and routine_name='v2_my_access_requests';
  if n = 0 then raise exception 'ASSERT 5 FAILED: a buyer cannot read their own requests'; end if;

  raise notice '105 OK: a buyer can see where their request stands, each wholesaler states its own time, and the owner can list what has gone past it.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. THE DIRECTORY CARRIES EACH WHOLESALER'S STATED TIME
-- ---------------------------------------------------------------------------
-- PB-01's confirmation sentence names the number -- "they usually answer within
-- 2 days" -- and the number has to come from somewhere. Fetching it per card
-- would be one round trip per wholesaler on a screen designed to list all of
-- them, so it rides along on the listing that is already being fetched.
--
-- The return type gains a column, which `create or replace` cannot do, so the
-- function is DROPPED and recreated. THE BODY BELOW IS THE INSTALLED BODY,
-- taken from pg_proc and changed in exactly two places -- the extra output
-- column and the join that feeds it. That is the migration-086 rule: patch from
-- what is installed, not from a repo copy that may have drifted.
--
-- `public.wholesalers` is v1's table and does not have the column; the setting
-- lives on `wholesale_v2.v2_wholesalers`. The join is LEFT and the value is
-- coalesced, because a v1 row with no v2 twin must still list rather than
-- vanish from the directory.
drop function if exists wholesale_v2.v2_directory_list(uuid, text, integer, integer);

create or replace function wholesale_v2.v2_directory_list(
  p_account_id uuid, p_search text default null,
  p_limit integer default 50, p_offset integer default 0)
returns table (wid text, name text, brand text, logo text,
               categories text[], access text, access_sla_hours integer)
language plpgsql stable security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wid    text;
begin
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  select a.person_id, a.wid into v_person, v_wid
    from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id;

  if p_limit is null or p_limit < 1 then p_limit := 50; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  return query
  with declared as (
    select wc.wid, c.name, c.sort_order, 0 as src
      from wholesale_v2.v2_wholesaler_categories wc
      join wholesale_v2.v2_categories c on c.id = wc.category_id
     where c.active
  ),
  derived as (
    select distinct p.wid, btrim(p.category) as name, 9999 as sort_order, 1 as src
      from wholesale_v2.v2_products p
     where coalesce(p.archived, false) = false
       and p.category is not null and btrim(p.category) <> ''
  ),
  cats as (
    select u.wid, u.name, min(u.src) as src, min(u.sort_order) as sort_order
      from (select * from declared union all select * from derived) u
     group by u.wid, u.name
  ),
  cat_agg as (
    select cats.wid, array_agg(cats.name order by cats.src, cats.sort_order, cats.name) as names
      from cats group by cats.wid
  )
  select
    w.wid,
    coalesce(nullif(btrim(w.name), ''), w.brand, w.wid)  as name,
    w.brand,
    w.logo,
    coalesce(ca.names, array[]::text[])                  as categories,
    case
      when v_person is not null and exists (
             select 1 from wholesale_v2.v2_person_memberships m
              where m.person_id = v_person and m.wid = w.wid and m.active
           ) then 'member'
      when v_wid is not null and w.wid = v_wid then 'member'
      when v_person is not null and exists (
             select 1 from wholesale_v2.v2_signup_requests r
              where r.person_id = v_person and r.wid = w.wid and r.status = 'pending'
           ) then 'pending'
      else 'none'
    end as access,
    coalesce(v2w.access_sla_hours, 48) as access_sla_hours
  from public.wholesalers w
  left join cat_agg ca on ca.wid = w.wid
  left join wholesale_v2.v2_wholesalers v2w on v2w.wid = w.wid
  where w.active
    and (
      p_search is null or btrim(p_search) = ''
      or w.name  ilike '%' || btrim(p_search) || '%'
      or w.brand ilike '%' || btrim(p_search) || '%'
    )
  order by
    case when v_person is not null and exists (
           select 1 from wholesale_v2.v2_person_memberships m
            where m.person_id = v_person and m.wid = w.wid and m.active) then 0
         when v_wid is not null and w.wid = v_wid then 0
         else 1 end,
    coalesce(nullif(btrim(w.name), ''), w.brand, w.wid)
  limit p_limit offset p_offset;
end;
$fn$;

comment on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) is
  'DR-01..DR-05, plus AC-11. Every active wholesaler by name, the categories they sell, whether THIS person is in / pending / neither, and how long that wholesaler says they take to answer. No products, no prices, no product counts -- a locked store stays locked while still being findable.';

revoke all on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) from public;
grant execute on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) to anon, authenticated;

do $$
declare v_res text; n int;
begin
  select pg_get_function_result(p.oid) into v_res
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_directory_list';

  if v_res !~* 'access_sla_hours' then
    raise exception 'ASSERT 6 FAILED: the directory no longer carries each wholesaler''s stated answer time';
  end if;

  -- DR-05 restated where it can be broken. Adding a column to this function is
  -- exactly the moment a price or a product count gets added by accident, and
  -- the whole point of the directory is that a locked store stays locked.
  if v_res ~* 'price' or v_res ~* 'product' or v_res ~* 'stock' then
    raise exception 'ASSERT 6 FAILED: the directory now returns % -- a locked store must stay locked while still being findable', v_res;
  end if;

  -- The grants survived the drop. A dropped-and-recreated function loses them,
  -- and a directory nobody can execute is a blank screen for every buyer.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee in ('anon','authenticated')
     and routine_name='v2_directory_list';
  if n < 2 then raise exception 'ASSERT 6 FAILED: the directory lost its grants when it was recreated (% of 2)', n; end if;

  raise notice '105 OK (part 2): the directory carries each wholesaler''s stated answer time, and still no prices.';
end $$;
