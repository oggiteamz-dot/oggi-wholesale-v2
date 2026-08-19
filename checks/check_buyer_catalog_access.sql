-- =============================================================================
-- CHECK: a buyer sees the catalogs their tier allows, and no others
-- =============================================================================
-- Hadi: "what kind of customer can see this catalog, and anyone above that
-- tier gets it."
--
-- This runs against the live functions inside a transaction that is rolled
-- back, so it touches no real data and is safe on production.
--
-- The load-bearing rows are the NEGATIVE ones. It is easy to write a tier gate
-- that lets the right people in; the whole value is in who it keeps out, and
-- those are the cases that decay silently because nobody notices a door that
-- has quietly opened.
--
--   psql "$DATABASE_URL" -f checks/check_buyer_catalog_access.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers (wid, name) values ('zztier','Tier Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zztier','Tier Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier)
values ('00000000-0000-4000-8000-0000000c1001','zztier','Tier 1 Shop', 1),
       ('00000000-0000-4000-8000-0000000c1003','zztier','Tier 3 Shop', 3);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-0000000b1001','zztier','buyer','zzt1','x','00000000-0000-4000-8000-0000000c1001','T1',true),
       ('00000000-0000-4000-8000-0000000b1003','zztier','buyer','zzt3','x','00000000-0000-4000-8000-0000000c1003','T3',true),
       ('00000000-0000-4000-8000-0000000b1009','zztier','buyer','zzoff','x','00000000-0000-4000-8000-0000000c1003','OFF',false);

-- Migration 045 back-fills a "Main Catalog" for every wholesaler, so the
-- fixture wholesaler has one too. It is tier 1 and active, so it is expected
-- in the tier-1 answer -- named here so the count is not a mystery later.
insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active)
values ('00000000-0000-4000-8000-0000000a1001','zztier','ZZ Everyone',    1, true),
       ('00000000-0000-4000-8000-0000000a1002','zztier','ZZ Tier 2 only', 2, true),
       ('00000000-0000-4000-8000-0000000a1003','zztier','ZZ VIP',         3, true),
       ('00000000-0000-4000-8000-0000000a1004','zztier','ZZ Switched off',1, false);

insert into wholesale_v2.v2_products (id, wid, name)
values ('00000000-0000-4000-8000-0000000d1001','zztier','ZZ VIP Product');
insert into wholesale_v2.v2_catalog_products (catalog_id, product_id)
values ('00000000-0000-4000-8000-0000000a1003','00000000-0000-4000-8000-0000000d1001');

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select 'a tier 1 buyer is NOT shown a tier 2 catalog' as label, 0 as expected,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1001')
           where name = 'ZZ Tier 2 only') as got
  union all
  select 'a tier 1 buyer is NOT shown a tier 3 catalog', 0,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1001')
           where name = 'ZZ VIP')
  union all
  select 'a tier 1 buyer IS shown a tier 1 catalog', 1,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1001')
           where name = 'ZZ Everyone')
  union all
  select 'a tier 3 buyer is shown all three active ones', 3,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1003')
           where name like 'ZZ %')
  union all
  select 'a deactivated catalog is shown to NOBODY, whatever their tier', 0,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1003')
           where name = 'ZZ Switched off')
  union all
  select 'a DEACTIVATED ACCOUNT is shown nothing at all', 0,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-0000000b1009'))
  union all
  select 'an unknown account id is shown nothing, and does not error', 0,
         (select count(*)::int from wholesale_v2.v2_buyer_catalogs('00000000-0000-4000-8000-00000000dead'))
  union all
  -- The gate has to hold on the PRODUCTS call too, or a buyer who guessed a
  -- catalog id would get its contents without ever being shown the catalog.
  select 'a tier 1 buyer asking for a VIP catalog''s products gets nothing', 0,
         (select count(*)::int from wholesale_v2.v2_buyer_catalog_products(
            '00000000-0000-4000-8000-0000000b1001','00000000-0000-4000-8000-0000000a1003'))
  union all
  select 'and a tier 3 buyer asking for the same catalog gets its product', 1,
         (select count(*)::int from wholesale_v2.v2_buyer_catalog_products(
            '00000000-0000-4000-8000-0000000b1003','00000000-0000-4000-8000-0000000a1003'))
) r;

rollback;
