-- Companion fixture for check_product_public_flag.sql (MOD-01, migration 116).
--
-- checks/fixture.sql is deliberately minimal -- it was built for the pack/MOQ
-- gate and carries only what that needs. This file adds the catalogue side
-- WITHOUT touching fixture.sql, so no existing gate changes behaviour.
--
-- It does NOT create v2_products.is_public. That column is what migration 116
-- is for, and creating it here would mean the gate tests the fixture instead
-- of the migration.
--
-- Load order:
--   fixture.sql -> fixture_public_flag.sql -> 116_product_public_flag.sql
--   -> check_product_public_flag.sql
set search_path = wholesale_v2, public;

-- the v1 wholesaler row the marketplace feed still joins for `active`
create table if not exists public.wholesalers (
  wid    text primary key,
  name   text,
  active boolean not null default true,
  logo   text
);

alter table wholesale_v2.v2_products
  add column if not exists category text,
  add column if not exists archived boolean not null default false;

create table if not exists wholesale_v2.v2_catalogs (
  id           uuid primary key default gen_random_uuid(),
  wid          text not null,
  name         text not null,
  access_tier  int  not null default 1,
  active       boolean not null default true,
  is_public    boolean not null default false,
  share_token  text unique
);

create table if not exists wholesale_v2.v2_catalog_products (
  catalog_id uuid not null references wholesale_v2.v2_catalogs(id) on delete cascade,
  product_id uuid not null references wholesale_v2.v2_products(id) on delete cascade,
  sort_order int,
  primary key (catalog_id, product_id)
);
