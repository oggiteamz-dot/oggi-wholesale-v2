-- CHECK: one wholesaler's private data is not readable by anyone else.
--
-- This is the production gate. Until it passes, a second wholesaler cannot
-- safely be given a login.
--
-- Read-only. Writes nothing, opens no transaction. Run it against any
-- environment:
--
--   psql "$DATABASE_URL" -f checks/check_tenant_isolation.sql
--
-- WHY IT EXISTS
-- -------------
-- On 15 Aug 2026, migration 023 was found to have scoped every WRITE correctly
-- while leaving three READ policies as `using (true)`. Verified by querying as
-- the `anon` role -- the role every buyer and every anonymous visitor uses,
-- because only owners and wholesalers sign in through Supabase Auth:
--
--   wid 'mg'   32 costs visible -> 45.3% margin derivable
--   wid 'omni' 32 costs visible -> 58.3% margin derivable
--   wid 'sq'   64 costs visible -> 45.6% margin derivable
--
-- Anyone with no login could read every wholesaler's buying prices. The key
-- required is in the public JavaScript bundle by design.
--
-- A POSTGRES TRAP THIS CHECK GUARDS AGAINST
-- -----------------------------------------
-- The first fix revoked SELECT on the `cost` COLUMN and changed nothing --
-- anon still read a cost of 13.00 straight afterwards. A TABLE-level GRANT
-- already permits every column, and a column-level REVOKE does not carve an
-- exception out of it. The working fix was to drop the table grant for anon
-- and grant back an explicit safe column list.
--
-- So this check asserts the GRANTS, not the policies. A policy can be correct
-- while the grant underneath makes it irrelevant.

do $$
declare
  fails text[] := '{}';
  txt text;
  n int;
begin
  ------------------------------------------------------------------
  -- 1. The public must not hold a blanket table grant on anything
  --    carrying private commercial data.
  ------------------------------------------------------------------
  for txt in
    select c.relname
      from information_schema.role_table_grants g
      join pg_class c on c.relname = g.table_name
      join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'wholesale_v2'
     where g.grantee = 'anon' and g.privilege_type = 'SELECT'
       and g.table_schema = 'wholesale_v2'
       and g.table_name in ('v2_product_variants')
  loop
    fails := fails || format(
      'GRANT: anon holds a table-wide SELECT on %s. A column-level REVOKE will NOT override this -- drop the table grant and grant an explicit safe column list instead.', txt);
  end loop;

  ------------------------------------------------------------------
  -- 2. Specific private columns must not be readable by the public.
  ------------------------------------------------------------------
  for txt in
    select column_name
      from information_schema.column_privileges
     where table_schema = 'wholesale_v2'
       and table_name = 'v2_product_variants'
       and grantee = 'anon'
       and privilege_type = 'SELECT'
       and column_name in ('cost','reorder_point','reorder_qty','lead_time_days')
  loop
    fails := fails || format(
      'LEAK: anon can read v2_product_variants.%s -- this is the wholesaler''s private operating data', txt);
  end loop;

  ------------------------------------------------------------------
  -- 3. Reads must not be unconditionally open on tenant-owned tables.
  --    `using (true)` is how the cost leak happened.
  ------------------------------------------------------------------
  for txt in
    select c.relname || '.' || p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'wholesale_v2'
     where p.polcmd in ('r','*')
       and pg_get_expr(p.polqual, p.polrelid) = 'true'
       and c.relname in ('v2_products','v2_product_variants','v2_orders','v2_order_items','v2_clients','v2_pack_definitions')
  loop
    fails := fails || format('OPEN READ: policy %s is `using (true)` -- every tenant can read every other tenant''s rows', txt);
  end loop;

  ------------------------------------------------------------------
  -- 4. Row security must actually be switched on.
  ------------------------------------------------------------------
  for txt in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'wholesale_v2'
     where c.relkind = 'r' and not c.relrowsecurity
       and c.relname like 'v2_%'
  loop
    fails := fails || format('RLS OFF: %s has row security disabled entirely', txt);
  end loop;

  ------------------------------------------------------------------
  -- 5. The scoping function must derive identity from the auth token,
  --    never from anything the client can claim for itself.
  ------------------------------------------------------------------
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_my_wid'
     and p.prosrc like '%auth.uid()%';
  if n = 0 then
    fails := fails || 'IDENTITY: v2_my_wid() no longer derives the wholesaler from auth.uid() -- tenant scoping cannot be trusted';
  end if;

  ------------------------------------------------------------------
  -- 6. There must be a scoped route to cost for the people entitled to it,
  --    otherwise the fix above simply breaks the wholesaler's own tools.
  ------------------------------------------------------------------
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_my_variant_costs';
  if n = 0 then
    fails := fails || 'MISSING: v2_my_variant_costs() is gone -- wholesalers have no scoped way to read their own costs';
  end if;

  ------------------------------------------------------------------
  if array_length(fails,1) is null then
    raise notice 'check_tenant_isolation: ALL ASSERTIONS HELD';
  else
    raise notice 'check_tenant_isolation: % FAILURE(S)', array_length(fails,1);
    foreach txt in array fails loop raise notice '  X %', txt; end loop;
    raise exception 'check_tenant_isolation FAILED with % problem(s)', array_length(fails,1);
  end if;
end $$;

-- NOT COVERED HERE, stated rather than implied:
-- the wholesaler-to-wholesaler path is asserted through grants and policy
-- shape, not by logging in as two real wholesalers and comparing what each
-- sees. That end-to-end test needs two real Supabase Auth accounts, which do
-- not exist yet (v2_user_profiles is empty). What HAS been demonstrated: an
-- authenticated user whose profile grants no wholesaler sees 0 products and 0
-- variants, so the policy denies by default rather than waving logged-in users
-- through. Run the two-account comparison once the first two wholesalers exist.
