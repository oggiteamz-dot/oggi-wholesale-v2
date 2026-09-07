-- =============================================================================
-- CHECK: the store + customer discount arithmetic
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
--                            -- customer_only mode falls back to the store's
--                               own rate rather than charging full list.
--
-- ↺ 7 Sep 2026 -- MIGRATION 122. Every expected number in this file is
-- UNCHANGED. What changed is where the non-customer half of the sum comes
-- from: until 122 it was the SHELF the caller named, and a buyer was therefore
-- quoted a different price depending on which link they opened (326 such pairs
-- measured on production). Hadi: "They should get the same price." So the rate
-- is now v2_wholesalers.discount_pct -- one number per store -- and the mode is
-- the store's too.
--
-- The arithmetic being asserted did not move, so neither did the numbers. The
-- file is restructured only because the store rate cannot vary row by row the
-- way a catalogue id could: each block sets the dial, says what it is setting
-- it to, and then prices.
--
-- ⛔ THE SHELVES ARE KEPT, AS DECOYS. Every case is priced THROUGH a shelf
-- carrying a rate and a mode of its own, and the assertion is that neither
-- reaches the bill. Without them this file would pass just as well against a
-- function that had quietly gone back to reading the shelf on a day the two
-- happened to agree. The rows headed "the shelf is a decoy" are the ones that
-- would catch that, and they name the wrong answer.
--
-- Run:  psql "$DATABASE_URL" -f checks/check_catalog_pricing.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers (wid, name) values ('zzchk','Check Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzchk','Check Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, discount_pct, access_tier)
values ('00000000-0000-4000-8000-0000000c0001','zzchk','Twenty Percent Shop', 20, 1),
       ('00000000-0000-4000-8000-0000000c0002','zzchk','No Discount Shop',     0, 1),
       ('00000000-0000-4000-8000-0000000c0003','zzchk','Twenty No Override',  20, 1);

-- Four shelves, four rates, four modes -- none of which may reach a price.
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

create temporary table zzchk_rows (ord int, label text, expected numeric, actual numeric) on commit drop;

do $check$
declare
  P constant uuid := '00000000-0000-4000-8000-0000000d0001';  -- product
  V constant uuid := '00000000-0000-4000-8000-0000000e0001';  -- variant, lists at 100.00
  cOvr  constant uuid := '00000000-0000-4000-8000-0000000c0001';  -- 20%, has a 12.00 override
  cZero constant uuid := '00000000-0000-4000-8000-0000000c0002';  --  0%
  cTwen constant uuid := '00000000-0000-4000-8000-0000000c0003';  -- 20%
  sCom  constant uuid := '00000000-0000-4000-8000-0000000a0001';  -- shelf: 5, combine
  sCat  constant uuid := '00000000-0000-4000-8000-0000000a0002';  -- shelf: 5, catalog_only
  sCust constant uuid := '00000000-0000-4000-8000-0000000a0003';  -- shelf: 5, customer_only
  sMark constant uuid := '00000000-0000-4000-8000-0000000a0004';  -- shelf: -10, combine
begin
  -------------------------------------------------- THE STORE AT 5%, COMBINE
  update wholesale_v2.v2_wholesalers set discount_pct = 5, discount_mode = 'combine' where wid = 'zzchk';

  insert into zzchk_rows values
    (1, 'negotiated price wins outright, no discount touches it', 12.00,
        wholesale_v2.v2_effective_unit_price(P, V, cOvr,  1, sCom)),
    (2, 'combine: 5 + 0 = 5% off 100', 95.00,
        wholesale_v2.v2_effective_unit_price(P, V, cZero, 1, sCom)),
    (3, 'combine: 5 + 20 = 25% off 100 (additive, NOT 76.00)', 75.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCom));

  -- 4-6. ⛔ THE SHELF IS A DECOY. Same store, same customer, three shelves
  --      carrying three different rates and three different modes. If any of
  --      them still priced, these would read 70.00 (5+5+20), 95.00 (the
  --      shelf's catalog_only ignoring the customer) and 85.00 (-10+5+20).
  insert into zzchk_rows values
    (4, 'the shelf is a decoy: its own 5% is not added again (NOT 70.00)', 75.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCat)),
    (5, 'the shelf is a decoy: its catalog_only mode is not obeyed (NOT 95.00)', 75.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCust)),
    (6, 'the shelf is a decoy: its -10% markup does not reach the bill (NOT 85.00)', 75.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sMark));

  -- 7. and no shelf named at all gives the same answer as every shelf did.
  insert into zzchk_rows values
    (7, 'and naming no shelf at all gives that same number', 75.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, null));

  ------------------------------------------- THE STORE AT 5%, CUSTOMER_ONLY
  -- The mode that carries a written instruction: a customer on 0% falls back
  -- to the store's own rate rather than being charged full list.
  update wholesale_v2.v2_wholesalers set discount_mode = 'customer_only' where wid = 'zzchk';

  insert into zzchk_rows values
    (8, 'customer_only + customer at 0 falls back to the store discount', 95.00,
        wholesale_v2.v2_effective_unit_price(P, V, cZero, 1, sCom)),
    (9, 'customer_only: the store 5% is ignored when the customer has a rate', 80.00,
        wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCom));

  -------------------------------------------- THE STORE AT 5%, CATALOG_ONLY
  update wholesale_v2.v2_wholesalers set discount_mode = 'catalog_only' where wid = 'zzchk';

  insert into zzchk_rows values
    (10, 'catalog_only: the customer 20% is ignored', 95.00,
         wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCom));

  ------------------------------------------------ THE STORE AT -10%, COMBINE
  update wholesale_v2.v2_wholesalers set discount_pct = -10, discount_mode = 'combine' where wid = 'zzchk';

  insert into zzchk_rows values
    (11, 'a negative store discount raises the price', 110.00,
         wholesale_v2.v2_effective_unit_price(P, V, cZero, 1, sCom)),
    (12, 'negative store -10 + customer 20 = 10% off', 90.00,
         wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCom));

  --------------------------------------------------- THE STORE AT 0, COMBINE
  update wholesale_v2.v2_wholesalers set discount_pct = 0, discount_mode = 'combine' where wid = 'zzchk';

  insert into zzchk_rows values
    (13, 'no store rate and no customer: list price stands', 100.00,
         wholesale_v2.v2_effective_unit_price(P, V, null,  1, null)),
    (14, 'no store rate, customer 20% still applies', 80.00,
         wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, null));

  -- 15. ⛔ AND WITH THE DIAL AT ZERO, A 5% SHELF STILL CHANGES NOTHING. This
  --     is the row that survives a fixture whose numbers all drift to zero: it
  --     is the only case where "the shelf contributed nothing" and "everything
  --     is zero" would otherwise be the same green, so it is stated against a
  --     customer who DOES have a rate. 80.00, never 75.00.
  insert into zzchk_rows values
    (15, 'with the dial at 0 a 5% shelf still adds nothing (NOT 75.00)', 80.00,
         wholesale_v2.v2_effective_unit_price(P, V, cTwen, 1, sCom));
end
$check$;

select label, expected, actual,
       case when actual is not distinct from expected then 'PASS' else 'FAIL' end as verdict
  from zzchk_rows order by ord;

rollback;
