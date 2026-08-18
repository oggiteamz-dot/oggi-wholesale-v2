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
       -- 18 Aug 2026: v2_wholesalers and v2_wholesaler_brands added after the
       -- roster leak. Same shape as the cost leak, one table over: `anon` held
       -- a table-wide SELECT, so the `using (true)` read policy published the
       -- whole client list -- brand, name, contact phone, contact email, owner
       -- notes, subscription price and expiry -- to anyone holding the
       -- publishable key that ships in the JS bundle.
       and g.table_name in ('v2_product_variants', 'v2_wholesalers', 'v2_wholesaler_brands')
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
  -- 7. Wholesaler PII and billing must be unreachable from a browser.
  --
  --    Checked as a COLUMN privilege, for either browser role. `authenticated`
  --    is the owner AND the wholesalers, so a grant here would hand every
  --    wholesaler OGGI's private notes and every other customer's price.
  --    The owner reads these through v2_require_owner()-gated functions.
  ------------------------------------------------------------------
  for txt in
    select cp.grantee || ' can read v2_wholesalers.' || cp.column_name
      from information_schema.column_privileges cp
     where cp.table_schema = 'wholesale_v2'
       and cp.table_name = 'v2_wholesalers'
       and cp.privilege_type = 'SELECT'
       and cp.grantee in ('anon', 'authenticated')
       and cp.column_name in ('contact_phone','contact_email','owner_notes',
                              'price_amount','price_currency','billing_period',
                              'paid_until','subscription_status',
                              'cancelled_at','cancel_reason','created_by')
  loop
    fails := fails || format('PII: %s -- this is a customer PII / revenue column and no browser role may hold SELECT on it', txt);
  end loop;

  ------------------------------------------------------------------
  -- 8. anon must hold NOTHING on v2_wholesalers.
  --
  --    Buyers and sales reps run as `anon` and authenticate through
  --    v2_portal_accounts, so auth.uid() is NULL for them and NO row policy
  --    can scope their read to their own wholesaler. Any SELECT grant here,
  --    however narrow the columns, permits enumerating the whole roster.
  --    Their only route is v2_public_wholesaler(p_wid): exact id, one row.
  ------------------------------------------------------------------
  select count(*) into n
    from information_schema.column_privileges cp
   where cp.table_schema = 'wholesale_v2' and cp.table_name = 'v2_wholesalers'
     and cp.grantee = 'anon';
  if n > 0 then
    fails := fails || format('ENUMERATION: anon holds %s privilege(s) on v2_wholesalers. It must hold none -- buyers reach a wholesaler only through v2_public_wholesaler(p_wid).', n);
  end if;

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_public_wholesaler';
  if n = 0 then
    fails := fails || 'MISSING: v2_public_wholesaler() is gone -- buyers have no way to read their own supplier''s name and currency, so the catalogue will render blank';
  end if;

  ------------------------------------------------------------------
  -- 9. No SECURITY DEFINER view may be readable by a browser role.
  --
  --    A view created without security_invoker runs with ITS OWNER's rights
  --    and bypasses row-level security on every base table it touches. It
  --    does not appear in pg_policies, so a policy audit will not find it.
  --    That is exactly how v2_wholesaler_billing published every
  --    subscription price and expiry date to the anon role while
  --    v2_wholesalers itself looked like it had policies.
  ------------------------------------------------------------------
  for txt in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'wholesale_v2'
     where c.relkind = 'v'
       and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%'
       and (has_table_privilege('anon', c.oid, 'SELECT')
            or has_table_privilege('authenticated', c.oid, 'SELECT'))
  loop
    fails := fails || format('DEFINER VIEW: %s runs with its owner''s rights (no security_invoker) AND is readable by a browser role -- it bypasses RLS on every table it reads. Either set security_invoker=true or revoke it and expose an owner-checked function.', txt);
  end loop;

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
