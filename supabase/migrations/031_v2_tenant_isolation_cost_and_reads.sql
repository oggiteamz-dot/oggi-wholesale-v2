-- Back-filled 15 Aug 2026 from the live database (project olaipgdckbgjediddloj).
-- Applied live 2026-08-15 (schema_migrations version 20260815153658,
-- name "v2_tenant_isolation_cost_and_reads"); never previously saved as a repo
-- file. Exported verbatim so the repo can rebuild the database from scratch.

-- Migration 031: close the cross-tenant read leak.
--
-- WHAT WAS WRONG
-- --------------
-- Migration 023 scoped every WRITE correctly (v2_is_owner() OR wid =
-- v2_my_wid(), where v2_my_wid() reads a real Supabase Auth uid -- so writes
-- were genuinely safe). But three read policies were left as `using (true)`:
--   v2_products_read, v2_product_variants_read, v2_inventory_balances_read
--
-- v2_product_variants.cost is the wholesaler's BUYING price. Verified on 15 Aug
-- 2026 by querying as the `anon` role -- the role every buyer and every
-- anonymous visitor uses, since only owners and wholesalers sign in through
-- Supabase Auth (js/lib/dev-auth.js:141):
--
--   wid 'mg'   32 variants, 32 costs visible, 45.3% margin derivable
--   wid 'omni' 32 variants, 32 costs visible, 58.3% margin derivable
--   wid 'sq'   64 variants, 64 costs visible, 45.6% margin derivable
--   wid 'w17…' 5 variants,   5 costs visible, 50.0% margin derivable
--
-- Anyone at all -- no login -- could read every wholesaler's cost prices and
-- compute their exact margins. The publishable key needed to do it is, by
-- design, in the public JavaScript bundle. This is the concrete reason a
-- second wholesaler could not safely be given a login.
--
-- WHAT THIS DOES
-- --------------
-- 1. Revokes the `cost` column from anon and authenticated at the grant level,
--    then grants it back only to the roles that legitimately need it. Column
--    privileges are checked before row policies, so this holds even if a read
--    policy is later loosened again -- defence that does not depend on the
--    next person getting RLS right.
-- 2. Scopes authenticated reads of products/variants to the caller's own
--    wholesaler (or owner), so one wholesaler cannot enumerate another's
--    catalogue while logged in.
-- 3. Leaves anonymous READ of the catalogue open -- buyers browse suppliers
--   without an account and that is the product working as intended. They now
--   simply cannot see cost.
--
-- ORDER MATTERS: js/data/catalog.js was changed FIRST to select an explicit
-- column list instead of select("*"), and that change was confirmed live
-- before this migration ran. select("*") against a revoked column errors
-- outright, which would have taken the buyer catalogue down.

-- 1. Cost is not public.
revoke select (cost) on wholesale_v2.v2_product_variants from anon;
revoke select (cost) on wholesale_v2.v2_product_variants from authenticated;
grant  select (cost) on wholesale_v2.v2_product_variants to service_role;

-- Wholesalers and owners read cost through this, which is scoped to the
-- caller's own wid by the same function the write policies already trust.
create or replace function wholesale_v2.v2_my_variant_costs()
returns table (variant_id uuid, product_id uuid, sku text, cost numeric)
language sql
stable
security definer
set search_path = wholesale_v2
as $$
  select v.id, v.product_id, v.sku, v.cost
    from v2_product_variants v
    join v2_products p on p.id = v.product_id
   where v2_is_owner() or p.wid = v2_my_wid();
$$;

grant execute on function wholesale_v2.v2_my_variant_costs() to authenticated;

comment on function wholesale_v2.v2_my_variant_costs() is
  'Migration 031. The only route to variant cost for a logged-in user. Scoped '
  'to the caller''s own wholesaler (or owner) via v2_my_wid(). The cost column '
  'itself is revoked from anon and authenticated.';

-- 2. A logged-in wholesaler sees their own catalogue, not everyone's.
--    Anonymous callers (auth.uid() is null) still read the catalogue, which is
--    what lets buyers browse suppliers without an account.
drop policy if exists v2_products_read on wholesale_v2.v2_products;
create policy v2_products_read on wholesale_v2.v2_products
  for select using (
    auth.uid() is null
    or wholesale_v2.v2_is_owner()
    or wid = wholesale_v2.v2_my_wid()
  );

drop policy if exists v2_product_variants_read on wholesale_v2.v2_product_variants;
create policy v2_product_variants_read on wholesale_v2.v2_product_variants
  for select using (
    auth.uid() is null
    or wholesale_v2.v2_is_owner()
    or exists (
      select 1 from wholesale_v2.v2_products p
       where p.id = v2_product_variants.product_id
         and p.wid = wholesale_v2.v2_my_wid())
  );
