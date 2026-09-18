-- =============================================================================
-- 140 — THE SALESPERSON CAN READ AGAIN
-- =============================================================================
--
-- WHAT WAS BROKEN
-- ---------------
-- /sales/clients, /sales/orders and /sales/visits all answered
--   42501  permission denied for table v2_clients
-- and rendered empty. Three of the salesperson's four screens.
--
-- WHY. A salesperson's browser runs as `anon`, exactly like a buyer's. Batch S
-- (migration 085) revoked anon's grants on every v2 table AND removed the
-- default-privileges rule that had been handing them out to each new table, and
-- it moved the BUYER's reads behind SECURITY DEFINER functions that re-check the
-- share token or portal account inside themselves.
--
-- The salesperson's reads were never moved. They still go straight at the
-- tables through js/data/clients.js, wholesaler-orders.js and visits.js -- the
-- same modules the WHOLESALER uses, which is why nobody noticed: signed in as a
-- wholesaler those modules hold a real Supabase Auth JWT and RLS lets them
-- through. Signed in as a rep, the identical call is anon and is refused.
--
-- It went unseen for three weeks because there was exactly one sales account in
-- the entire database (`rep1` on the `test` tenant, a credential created to
-- prove R12 worked) and nobody had signed into it since.
--
-- THE RULE THIS FOLLOWS
-- ---------------------
-- 048's lesson, quoted in js/data/staff-auth.js: AN ID FROM A BROWSER IS A
-- CLAIM, NOT A CREDENTIAL. Every function below takes the account id the rep
-- holds and re-derives the wid from it, server-side, re-checking that the
-- account is still a salesperson, still active, and that its store is still
-- active. The caller never says which wid it wants and could not be believed if
-- it did. Same shape as 085's buyer functions, one tier over.
--
-- WHAT A REP MAY SEE, AND WHAT THEY MAY NOT
-- -----------------------------------------
-- A rep sells, so they see shops, order totals and their own visit log.
-- They do NOT see `cost` or margin -- 031/032 stripped cost from every browser
-- role and only the finance desk reaches it, through 137. Nothing here widens
-- that: every column is named explicitly, so adding a column to v2_clients can
-- never silently start publishing it to the sales tier. That is 045's rule and
-- it is why these are not `select *`.
-- =============================================================================

-- ---------------------------------------------------------------- the gate --
-- One place that answers "which store is this account, if any". Every function
-- below goes through it, so the membership test cannot drift between them.
create or replace function wholesale_v2.v2_sales_wid(p_account_id uuid)
returns text
language sql
stable
security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
  select a.wid
  from v2_portal_accounts a
  join v2_wholesalers w on w.wid = a.wid
  where a.id = p_account_id
    and a.role = 'sales'
    and a.active = true
    and w.active = true;
$$;

-- ------------------------------------------------------------- the clients --
create or replace function wholesale_v2.v2_sales_clients(p_account_id uuid)
returns table (
  id uuid, wid text, shop_name text, owner_name text, phone text, phone2 text,
  email text, city text, area text, address text, country text,
  business_type text, instagram text, photo_url text, note text,
  discount_pct numeric, access_tier smallint, status text, active boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
declare v_wid text := wholesale_v2.v2_sales_wid(p_account_id);
begin
  if v_wid is null then return; end if;   -- no rows, not an error: a suspended
                                          -- rep sees an empty list, and the
                                          -- screen's own empty state explains it
  return query
  select c.id, c.wid, c.shop_name, c.owner_name, c.phone, c.phone2,
         c.email, c.city, c.area, c.address, c.country,
         c.business_type, c.instagram, c.photo_url, c.note,
         c.discount_pct, c.access_tier, c.status::text, c.active,
         c.created_at, c.updated_at
  from v2_clients c
  where c.wid = v_wid
    and c.status in ('active', 'banned', 'pending');
end;
$$;

-- -------------------------------------------------------------- the orders --
-- Totals, yes. A rep whose job is selling cannot work without knowing what a
-- shop has been spending. Cost and margin are absent by construction.
create or replace function wholesale_v2.v2_sales_orders(p_account_id uuid, p_limit integer default 400)
returns table (
  id uuid, wid text, reference text, client_id uuid, buyer_label text,
  status text, subtotal numeric, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
declare v_wid text := wholesale_v2.v2_sales_wid(p_account_id);
begin
  if v_wid is null then return; end if;
  return query
  select o.id, o.wid, o.reference, o.client_id, o.buyer_label,
         o.status::text, o.subtotal, o.created_at
  from v2_orders o
  where o.wid = v_wid
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 400), 1000));
end;
$$;

-- -------------------------------------------------------------- the visits --
create or replace function wholesale_v2.v2_sales_visits(p_account_id uuid, p_limit integer default 100)
returns table (
  id bigint, wid text, client_id uuid, shop_name text,
  rep_label text, note text, visited_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
declare v_wid text := wholesale_v2.v2_sales_wid(p_account_id);
begin
  if v_wid is null then return; end if;
  return query
  select v.id, v.wid, v.client_id, c.shop_name,
         v.rep_label, v.note, v.visited_at
  from v2_visit_log v
  left join v2_clients c on c.id = v.client_id
  where v.wid = v_wid
  order by v.visited_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- --------------------------------------------------------- logging a visit --
-- The write path was refused for the same reason the reads were. The client id
-- is checked to belong to the rep's OWN store: without that, a rep could log a
-- visit against another wholesaler's shop by passing its uuid.
create or replace function wholesale_v2.v2_sales_log_visit(
  p_account_id uuid, p_client_id uuid, p_rep_label text, p_note text
)
returns table (ok boolean, msg text, id bigint)
language plpgsql
security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
declare
  v_wid text := wholesale_v2.v2_sales_wid(p_account_id);
  v_id  bigint;
begin
  if v_wid is null then
    return query select false, 'This login is no longer active.'::text, null::bigint; return;
  end if;
  if not exists (select 1 from v2_clients c where c.id = p_client_id and c.wid = v_wid) then
    return query select false, 'That shop is not on your list.'::text, null::bigint; return;
  end if;
  insert into v2_visit_log (wid, client_id, rep_label, note)
  values (v_wid, p_client_id, nullif(trim(coalesce(p_rep_label, '')), ''), nullif(trim(coalesce(p_note, '')), ''))
  returning v2_visit_log.id into v_id;
  return query select true, null::text, v_id;
end;
$$;

-- ------------------------------------------------------------------ grants --
-- EXECUTE only, on the functions. No table grant is added anywhere: 085 revoked
-- those deliberately and this migration must not quietly undo it.
grant execute on function wholesale_v2.v2_sales_wid(uuid)                        to anon, authenticated;
grant execute on function wholesale_v2.v2_sales_clients(uuid)                    to anon, authenticated;
grant execute on function wholesale_v2.v2_sales_orders(uuid, integer)            to anon, authenticated;
grant execute on function wholesale_v2.v2_sales_visits(uuid, integer)            to anon, authenticated;
grant execute on function wholesale_v2.v2_sales_log_visit(uuid, uuid, text, text) to anon, authenticated;

-- ------------------------------------------------------------- self-test ----
do $$
declare
  n integer;
begin
  -- 1. a null / unknown account gets nothing, rather than everything
  select count(*) into n from wholesale_v2.v2_sales_clients(null);
  assert n = 0, 'ASSERT 1 FAILED: a null account id returned ' || n || ' clients';
  select count(*) into n from wholesale_v2.v2_sales_clients('00000000-0000-0000-0000-000000000000');
  assert n = 0, 'ASSERT 2 FAILED: an unknown account id returned ' || n || ' clients';

  -- 3. ANON still holds no grant on these tables.
  --
  -- ⚠️ DELIBERATELY NOT asserted against `authenticated`. The first draft of
  -- this line counted both roles and FAILED the migration with "12 table
  -- grant(s)" — because `authenticated` legitimately holds SELECT, INSERT,
  -- UPDATE and DELETE on all three. That is the WHOLESALER, and it is the
  -- whole reason this bug was invisible: the same data module works as
  -- `authenticated` and is refused as `anon`. The assertion doing that was the
  -- assertion working: it stopped a migration whose author had not yet checked
  -- which role was actually being refused.
  select count(*) into n
  from information_schema.role_table_grants
  where table_schema = 'wholesale_v2'
    and table_name in ('v2_clients','v2_orders','v2_visit_log')
    and grantee = 'anon';
  assert n = 0, 'ASSERT 3 FAILED: anon holds ' || n || ' table grant(s) on the sales tables — 085 has been undone';

  -- 4. one signature each, no stale overload (the 1 Sep PGRST203 lesson)
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'wholesale_v2'
    and p.proname in ('v2_sales_wid','v2_sales_clients','v2_sales_orders','v2_sales_visits','v2_sales_log_visit');
  assert n = 5, 'ASSERT 4 FAILED: expected 5 sales functions, found ' || n;

  raise notice 'migration 140 self-test passed';
end $$;
