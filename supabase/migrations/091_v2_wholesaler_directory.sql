-- =============================================================================
-- 091 — THE DIRECTORY                            DR-01..DR-05, 29 August 2026
-- =============================================================================
--
-- "Browse our wholesalers." The first screen in this product that shows a buyer
-- something OTHER than the single store they were let into -- and the first
-- thing that makes OGGI a marketplace rather than one catalogue with a login.
--
-- IT IS BUILT ON 090 AND COULD NOT HAVE BEEN BUILT BEFORE IT. "Which of these
-- wholesalers am I already in?" is a question about a PERSON, and until
-- migration 090 there was no person -- only an account welded to one wid. The
-- access column below is a join through v2_person_memberships, and that is the
-- whole reason ID-01 came first.
--
-- WHAT A STRANGER CAN SEE, AND WHAT THEY CANNOT
--
-- DR-05 is the rule: products and prices stay invisible until access is
-- granted. This function returns a wholesaler's NAME, BRAND, LOGO and the
-- CATEGORIES they sell. It returns:
--
--   * no products
--   * no prices
--   * and deliberately NO PRODUCT COUNT.
--
-- The count is the interesting omission. It is not a product and not a price,
-- so it does not strictly break DR-05, and it would make the directory more
-- useful. It is left out anyway: "this wholesaler lists 4,000 SKUs and that one
-- lists 12" is competitive intelligence about a business that never agreed to
-- publish it, and a directory entry is not consent to a size disclosure. If it
-- is wanted later it should be a setting the wholesaler turns on, not a default
-- this migration chose for them.
--
-- WHERE CATEGORIES COME FROM, AND WHY THERE ARE TWO SOURCES
--
-- v2_wholesaler_categories already exists and is the DECLARED answer -- what a
-- wholesaler says they sell. In production today it holds 3 rows across 9
-- wholesalers, so a directory built on it alone would show six blank cards on
-- the day it launched, and a blank directory teaches a buyer that the feature
-- is broken.
--
-- So the declared categories are unioned with categories DERIVED from the
-- wholesaler's own live products (v2_products.category, archived excluded).
-- Derived is a fact about what they actually list; declared is what they chose
-- to say. Declared wins on ordering because it is intentional. Neither invents
-- anything: a wholesaler with no categories and no products shows none, and
-- that is the honest answer.
--
-- DR-04 REUSES DOOR B RATHER THAN INVENTING A SECOND REQUEST
--
-- v2_submit_signup_request (007/024) already exists, is already rate-limited,
-- and already feeds the wholesaler's approval screen shipped in PR #32. A
-- second request object would mean two tables meaning "someone wants in", two
-- screens to review them, and one of them eventually forgotten -- which is
-- precisely how v2_suppliers came to mean the opposite of "supplier" here.
-- This migration adds ONE column to that table (person_id) so a request made
-- from the directory can be attributed to a person, which is what makes the
-- 'pending' state below showable at all.
-- =============================================================================

-- ------------------------------------------- attribute a request to a person --
alter table wholesale_v2.v2_signup_requests
  add column if not exists person_id uuid references wholesale_v2.v2_people(id) on delete set null;

create index if not exists v2_signup_requests_person_idx
  on wholesale_v2.v2_signup_requests (person_id, wid) where status = 'pending';

comment on column wholesale_v2.v2_signup_requests.person_id is
  'Who asked, when the request came from the directory. Nullable forever: a request submitted from a public signup form has no person yet, and that path must keep working exactly as it does (GP-02). It exists so the directory can show "you already asked" instead of offering a button that silently makes a second request.';

-- ================================================================ the list ====
create or replace function wholesale_v2.v2_directory_list(
  p_account_id uuid,
  p_search     text default null,
  p_limit      integer default 50,
  p_offset     integer default 0
)
returns table (
  wid          text,
  name         text,
  brand        text,
  logo         text,
  categories   text[],
  access       text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wid    text;
begin
  -- The caller is trusted for NOTHING except the account id, which is checked
  -- here rather than believed. Same discipline as every buyer-facing definer
  -- since 080: a definer function that trusts its caller is a bigger hole than
  -- the one being closed.
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;   -- no rows. Not an error: an error message is itself information.
  end if;

  select a.person_id, a.wid into v_person, v_wid
    from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id;

  -- Clamped, not trusted. A caller-supplied limit of 100000 is a scrape.
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
    -- What they actually list. Archived products do not speak for a business.
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
      -- THE PAYOFF OF 090. Membership is a fact about a person, not an account.
      when v_person is not null and exists (
             select 1 from wholesale_v2.v2_person_memberships m
              where m.person_id = v_person and m.wid = w.wid and m.active
           ) then 'member'
      -- Defensive: an account that predates the person layer still sees its own
      -- store as its own. person_id is nullable on purpose (090) and this
      -- function must not tell a buyer they are a stranger to the shop they are
      -- signed in to.
      when v_wid is not null and w.wid = v_wid then 'member'
      when v_person is not null and exists (
             select 1 from wholesale_v2.v2_signup_requests r
              where r.person_id = v_person and r.wid = w.wid and r.status = 'pending'
           ) then 'pending'
      else 'none'
    end as access
  from public.wholesalers w
  left join cat_agg ca on ca.wid = w.wid
  where w.active
    and (
      p_search is null or btrim(p_search) = ''
      or w.name  ilike '%' || btrim(p_search) || '%'
      or w.brand ilike '%' || btrim(p_search) || '%'
    )
  order by
    -- Stores the buyer is already in come first: the directory is also the
    -- answer to "where do I shop today", not only "who else is there".
    case when v_person is not null and exists (
           select 1 from wholesale_v2.v2_person_memberships m
            where m.person_id = v_person and m.wid = w.wid and m.active) then 0
         when v_wid is not null and w.wid = v_wid then 0
         else 1 end,
    coalesce(nullif(btrim(w.name), ''), w.brand, w.wid)
  limit p_limit offset p_offset;
end;
$fn$;

revoke all on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) from public;
-- anon, necessarily: buyers and sales reps ARE anon since 085. The account id
-- is re-checked inside the function, which is what makes that safe.
grant execute on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) to anon;
grant execute on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) to authenticated;

comment on function wholesale_v2.v2_directory_list(uuid, text, integer, integer) is
  'Every active wholesaler by name, with the categories they sell and whether THIS person is already in, has asked, or has not. Returns no products, no prices and deliberately no product count -- a directory entry is not consent to publish how big your catalogue is. Resolves the caller from the account id INSIDE itself and returns zero rows for an account it cannot verify.';

-- ===================================================== request access (DR-04) ==
create or replace function wholesale_v2.v2_directory_request_access(
  p_account_id text,
  p_wid        text,
  p_note       text default null
)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_acc    uuid;
  v_person uuid;
  v_label  text;
  v_shop   text;
begin
  begin
    v_acc := p_account_id::uuid;
  exception when others then
    return query select false, 'Please sign in again.'; return;
  end;

  if not wholesale_v2.v2_account_can_act(v_acc) then
    return query select false, 'Please sign in again.'; return;
  end if;

  if p_wid is null or not exists (
       select 1 from public.wholesalers w where w.wid = p_wid and w.active) then
    return query select false, 'That wholesaler is not available.'; return;
  end if;

  select a.person_id, a.actor_label, c.shop_name
    into v_person, v_label, v_shop
    from wholesale_v2.v2_portal_accounts a
    left join wholesale_v2.v2_clients c on c.id = a.client_id
   where a.id = v_acc;

  -- Already in. Offering a button that makes a pointless request is how a
  -- product teaches people not to trust its buttons.
  if v_person is not null and exists (
       select 1 from wholesale_v2.v2_person_memberships m
        where m.person_id = v_person and m.wid = p_wid and m.active) then
    return query select false, 'You already have access to this wholesaler.'; return;
  end if;

  if v_person is not null and exists (
       select 1 from wholesale_v2.v2_signup_requests r
        where r.person_id = v_person and r.wid = p_wid and r.status = 'pending') then
    -- AC-07 in spirit: tell them it is already with the wholesaler rather than
    -- silently making a second row nobody will review twice.
    return query select false, 'You have already asked this wholesaler. They have your request.'; return;
  end if;

  -- Rate-limited per wholesaler, matching v2_submit_signup_request exactly.
  if not wholesale_v2.v2_rate_limit_check('signup_request|' || p_wid, 30, 3600) then
    return query select false, 'Too many requests for this wholesaler right now -- please try again later.'; return;
  end if;

  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, location, volume, sells, status, person_id)
  values (p_wid,
          coalesce(nullif(btrim(v_shop), ''), nullif(btrim(v_label), ''), 'A shop on OGGI'),
          null, null, nullif(btrim(p_note), ''), 'pending', v_person);

  return query select true, 'Sent. The wholesaler will see your request.';
end;
$fn$;

revoke all on function wholesale_v2.v2_directory_request_access(text, text, text) from public;
grant execute on function wholesale_v2.v2_directory_request_access(text, text, text) to anon;
grant execute on function wholesale_v2.v2_directory_request_access(text, text, text) to authenticated;

comment on function wholesale_v2.v2_directory_request_access(text, text, text) is
  'DR-04. Creates a pending row in v2_signup_requests -- the SAME object Door B already reviews (PR #32) -- stamped with the person so the directory can show "you already asked". Refuses politely when the buyer is already a member or already has a request pending, because a button that does nothing visible is worse than no button.';

-- =============================================================================
-- SELF-ASSERTING, like 085, 088, 089, 090.
-- =============================================================================
do $$
declare n int; r record;
begin
  -- 1. DR-05: the projection must not carry products or prices.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_directory_list'
     and (pg_get_function_result(p.oid) ilike '%price%'
       or pg_get_function_result(p.oid) ilike '%product%'
       or pg_get_function_result(p.oid) ilike '%sku%');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: v2_directory_list exposes products or prices to someone with no access -- DR-05'; end if;

  -- 2. anon must be able to READ the directory (buyers are anon since 085)...
  if not has_function_privilege('anon','wholesale_v2.v2_directory_list(uuid,text,integer,integer)','execute')
    then raise exception 'ASSERT 2 FAILED: anon cannot read the directory, so no buyer can'; end if;
  if not has_function_privilege('anon','wholesale_v2.v2_directory_request_access(text,text,text)','execute')
    then raise exception 'ASSERT 3 FAILED: anon cannot request access from the directory'; end if;

  -- 3. ...and must STILL hold no table privilege anywhere near it.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and grantee='anon'
     and table_name in ('v2_signup_requests','v2_categories','v2_wholesaler_categories','v2_person_memberships');
  if n <> 0 then raise exception 'ASSERT 4 FAILED: anon holds % table grant(s) around the directory -- 085 closed those', n; end if;

  -- 4. an unverifiable account gets rows: none. Not an error, not everything.
  select count(*) into n from wholesale_v2.v2_directory_list(
    '00000000-0000-0000-0000-000000000000'::uuid, null, 50, 0);
  if n <> 0 then raise exception 'ASSERT 5 FAILED: an unknown account id returned % directory row(s)', n; end if;
  select count(*) into n from wholesale_v2.v2_directory_list(null, null, 50, 0);
  if n <> 0 then raise exception 'ASSERT 6 FAILED: a null account id returned % directory row(s)', n; end if;

  -- 5. the person_id column landed and is nullable (GP-02: the old public
  --    signup form has no person and must keep working).
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_signup_requests'
     and column_name='person_id' and is_nullable='YES';
  if n <> 1 then raise exception 'ASSERT 7 FAILED: v2_signup_requests.person_id is missing or NOT NULL'; end if;

  raise notice '091 OK: directory readable by anon through a checked account only; no products, prices or counts in the projection; request path reuses Door B.';
end $$;
