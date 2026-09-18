-- =============================================================================
-- 140a — 140's ORDERS FUNCTION NAMED A COLUMN THAT DOES NOT EXIST
-- =============================================================================
-- 140 shipped `select o.reference` from v2_orders. There is no `reference`
-- column: the order's human label is `buyer_label`.
--
-- ⚠️ THE LESSON, AND THE REASON THIS FILE EXISTS.
-- A plpgsql body is NOT parsed when the function is created. `create function`
-- succeeded, the migration reported success, and its self-test PASSED — because
-- that self-test called v2_sales_clients and never called v2_sales_orders. The
-- broken function was found by a human query afterwards, not by the migration.
--
-- So the self-test below CALLS EVERY FUNCTION THE MIGRATION DEFINES, against a
-- real account, and asserts on what comes back. A self-test that exercises one
-- of five functions is not a self-test, it is a sample.
--
-- The DROP is in THIS migration, not a later one: the 1 Sep PGRST203 outage was
-- caused by `create or replace` with a new argument list leaving the old
-- signature in place, giving PostgREST two candidates for every existing call.
-- =============================================================================

drop function if exists wholesale_v2.v2_sales_orders(uuid, integer);

create function wholesale_v2.v2_sales_orders(p_account_id uuid, p_limit integer default 400)
returns table (
  id uuid, wid text, client_id uuid, buyer_label text, catalog_id uuid,
  status text, subtotal numeric, notes text, created_at timestamptz
) language plpgsql stable security definer
set search_path to 'wholesale_v2', 'extensions'
as $$
declare v_wid text := wholesale_v2.v2_sales_wid(p_account_id);
begin
  if v_wid is null then return; end if;
  return query
  select o.id, o.wid, o.client_id, o.buyer_label, o.catalog_id,
         o.status::text, o.subtotal, o.notes, o.created_at
  from v2_orders o where o.wid = v_wid
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 400), 1000));
end;
$$;
-- `fulfil_note` is deliberately absent: 087 exists because one shared field
-- printed an internal picker note on a customer's label. It is the office's
-- instruction to the warehouse, and a rep is a third party to it — exactly as
-- 137 keeps it away from finance.

grant execute on function wholesale_v2.v2_sales_orders(uuid, integer) to anon, authenticated;

do $$
declare
  v_acct uuid; v_wid text; n integer; r record;
begin
  select id, wid into v_acct, v_wid from wholesale_v2.v2_portal_accounts
  where role = 'sales' and active = true order by created_at desc limit 1;

  if v_acct is null then
    raise notice '140a: no active sales account to test against';
  else
    select count(*) into n from wholesale_v2.v2_sales_clients(v_acct);
    raise notice '140a: clients -> %', n;
    select count(*) into n from wholesale_v2.v2_sales_orders(v_acct);
    raise notice '140a: orders  -> %', n;
    select count(*) into n from wholesale_v2.v2_sales_visits(v_acct);
    raise notice '140a: visits  -> %', n;

    for r in select * from wholesale_v2.v2_sales_clients(v_acct) loop
      assert r.wid = v_wid, 'ASSERT FAILED: clients leaked wid ' || r.wid;
    end loop;
    for r in select * from wholesale_v2.v2_sales_orders(v_acct) loop
      assert r.wid = v_wid, 'ASSERT FAILED: orders leaked wid ' || r.wid;
    end loop;
    for r in select * from wholesale_v2.v2_sales_visits(v_acct) loop
      assert r.wid = v_wid, 'ASSERT FAILED: visits leaked wid ' || r.wid;
    end loop;
  end if;

  -- a BUYER account id gets nothing: the ROLE is checked, not merely the id
  select id into v_acct from wholesale_v2.v2_portal_accounts where role = 'buyer' limit 1;
  if v_acct is not null then
    select count(*) into n from wholesale_v2.v2_sales_clients(v_acct);
    assert n = 0, 'ASSERT FAILED: a buyer id returned ' || n || ' clients';
    select count(*) into n from wholesale_v2.v2_sales_orders(v_acct);
    assert n = 0, 'ASSERT FAILED: a buyer id returned ' || n || ' orders';
    select count(*) into n from wholesale_v2.v2_sales_visits(v_acct);
    assert n = 0, 'ASSERT FAILED: a buyer id returned ' || n || ' visits';
  end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'wholesale_v2' and p.proname = 'v2_sales_orders';
  assert n = 1, 'ASSERT FAILED: v2_sales_orders has ' || n || ' signatures';

  raise notice 'migration 140a self-test passed';
end $$;
