-- Companion fixture for check_buyer_store_read.sql (MOD-04, migration 118).
--
-- v2_buyer_store_read delegates BOTH the gate and the row shape to two real
-- functions. Rebuilding the whole catalogue stack in a fixture would take
-- hundreds of lines and would test the fixture. Instead this file provides
-- STUBS of exactly those two, so the gate exercises the real body of
-- v2_buyer_store_read -- its dedupe, its ordering, and crucially its
-- DELEGATION of the gate -- against data the test controls.
--
-- The stubs are deliberately dumb: v2_buyer_catalogs returns whatever the test
-- puts in zz_visible, so a test can make the gate return NOTHING and prove the
-- store read returns nothing too. That is the assertion that matters.
--
-- Load AFTER fixture.sql. Does NOT create v2_buyer_store_read -- that is
-- migration 118's job, and creating it here would test the fixture.
set search_path = wholesale_v2, public;

create table if not exists zz_visible (account_id uuid, catalog_id uuid, rk int);
create table if not exists zz_rows (
  catalog_id uuid, product_id uuid, product_name text, sort_order int,
  variant_id uuid, sku text, price numeric, highlighted boolean
);

create or replace function wholesale_v2.v2_buyer_catalogs(p_account_id uuid)
returns table(id uuid, name text, description text, is_default boolean, access_tier smallint)
language sql stable as $$
  select v.catalog_id, 'zz cat '||v.rk, null::text, v.rk = 1, 1::smallint
    from zz_visible v where v.account_id = p_account_id order by v.rk
$$;

create or replace function wholesale_v2.v2__catalog_rows(p_catalog_id uuid)
returns table(
  product_id uuid, product_name text, description text, category text,
  created_at timestamptz, selling_model text, ratio_curve jsonb,
  moq_qty integer, moq_reorder_qty integer, base_unit integer,
  moq_per_colour integer, catalog_only boolean, highlighted boolean,
  sort_order integer, variant_id uuid, sku text, price numeric,
  compare_at_price numeric, retail_price numeric, extra_attrs jsonb,
  variant_moq_qty integer, barcode text, image_url text, images jsonb,
  total_on_hand numeric, total_reserved numeric, total_available numeric)
language sql stable as $$
  select r.product_id, r.product_name, null::text, null::text, null::timestamptz,
         'open'::text, null::jsonb, null::int, null::int, null::int, null::int,
         false, r.highlighted, r.sort_order, r.variant_id, r.sku, r.price,
         null::numeric, null::numeric, null::jsonb, null::int, null::text,
         null::text, null::jsonb, 0::numeric, 0::numeric, 0::numeric
    from zz_rows r where r.catalog_id = p_catalog_id
$$;
