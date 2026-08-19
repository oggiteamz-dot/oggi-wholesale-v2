-- =============================================================================
-- CHECK: the catalog + customer discount arithmetic
-- =============================================================================
-- Runs worked examples straight through the live v2_effective_unit_price and
-- fails loudly if any of them moves. Everything happens inside a transaction
-- that is rolled back, so it touches no real data and can be run against
-- production.
--
-- Two of these rows encode instructions given in words and are the reason this
-- file exists rather than a comment:
--
--   "they combine into 25%"  -- stacking is ADDITIVE on the list price, not
--                               5% and then 20% of what is left (which would
--                               be 76.00, not 75.00).
--   "if there's a customer that doesn't have a preset discount, it's
--    basically 0%, then it automatically activates the catalog's discount"
--                            -- customer_only mode falls back to the catalog
--                               discount rather than charging full list.
--
-- Run:  psql "$DATABASE_URL" -f checks/check_catalog_pricing.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers (wid, name) values ('zzchk','Check Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzchk','Check Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, discount_pct, access_tier)
values ('00000000-0000-4000-8000-0000000c0001','zzchk','Twenty Percent Shop', 20, 1),
       ('00000000-0000-4000-8000-0000000c0002','zzchk','No Discount Shop',     0, 1);

insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, discount_pct, discount_mode)
values ('00000000-0000-4000-8000-0000000a0001','zzchk','Combine 5',      1,  5, 'combine'),
       ('00000000-0000-4000-8000-0000000a0002','zzchk','CatalogOnly 5',  1,  5, 'catalog_only'),
       ('00000000-0000-4000-8000-0000000a0003','zzchk','CustomerOnly 5', 1,  5, 'customer_only'),
       ('00000000-0000-4000-8000-0000000a0004','zzchk','Markup -10',     1,-10, 'combine');

insert into wholesale_v2.v2_products (id, wid, name)
values ('00000000-0000-4000-8000-0000000d0001','zzchk','Check Product');

insert into wholesale_v2.v2_product_variants (id, product_id, sku, price)
values ('00000000-0000-4000-8000-0000000e0001','00000000-0000-4000-8000-0000000d0001','ZZ-1',100);

-- A hand-negotiated price for one customer on one variant. It must come back
-- untouched by either discount: that number is a promise somebody made.
insert into wholesale_v2.v2_client_price_overrides (client_id, variant_id, override_price)
values ('00000000-0000-4000-8000-0000000c0001','00000000-0000-4000-8000-0000000e0001', 12.00);

select
  label, expected, actual,
  case when actual is not distinct from expected then 'PASS' else 'FAIL' end as verdict
from (
  select label, expected,
    wholesale_v2.v2_effective_unit_price(
      '00000000-0000-4000-8000-0000000d0001',
      '00000000-0000-4000-8000-0000000e0001',
      client_id, 1, catalog_id) as actual
  from (values
    ('negotiated price wins outright, no discount touches it',
       12.00::numeric, '00000000-0000-4000-8000-0000000c0001'::uuid, '00000000-0000-4000-8000-0000000a0001'::uuid),
    ('combine: 5 + 0 = 5% off 100',
       95.00, '00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000a0001'),
    ('customer_only + customer at 0 falls back to the catalog discount',
       95.00, '00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000a0003'),
    ('negative catalog discount raises the price',
       110.00, '00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000a0004'),
    ('no catalog and no customer: list price stands',
       100.00, null, null)
  ) as t(label, expected, client_id, catalog_id)
) r;

-- The same cases again for a customer with NO negotiated price, so the
-- discount arithmetic itself is visible rather than shadowed by the override.
insert into wholesale_v2.v2_clients (id, wid, shop_name, discount_pct, access_tier)
values ('00000000-0000-4000-8000-0000000c0003','zzchk','Twenty No Override', 20, 1);

select
  label, expected, actual,
  case when actual is not distinct from expected then 'PASS' else 'FAIL' end as verdict
from (
  select label, expected,
    wholesale_v2.v2_effective_unit_price(
      '00000000-0000-4000-8000-0000000d0001',
      '00000000-0000-4000-8000-0000000e0001',
      '00000000-0000-4000-8000-0000000c0003', 1, catalog_id) as actual
  from (values
    ('combine: 5 + 20 = 25% off 100 (additive, NOT 76.00)', 75.00::numeric, '00000000-0000-4000-8000-0000000a0001'::uuid),
    ('catalog_only: the customer 20% is ignored',            95.00, '00000000-0000-4000-8000-0000000a0002'),
    ('customer_only: the catalog 5% is ignored',             80.00, '00000000-0000-4000-8000-0000000a0003'),
    ('negative catalog -10 + customer 20 = 10% off',         90.00, '00000000-0000-4000-8000-0000000a0004'),
    ('no catalog, customer 20% still applies',               80.00, null)
  ) as t(label, expected, catalog_id)
) r;

rollback;
