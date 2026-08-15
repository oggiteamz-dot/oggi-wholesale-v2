-- Minimal fixture reproducing the tables that v2_submit_order touches.
-- Column definitions copied from the real migrations (001, 004, 009, 011).
-- Reservation + pricing helpers are stubbed: they are irrelevant to the MOQ
-- logic under test and pulling in the full inventory ledger would add noise.

create table v2_wholesalers (
  wid text primary key,
  order_min_qty int,
  order_min_value numeric(12,2)
);

create table v2_products (
  id uuid primary key default gen_random_uuid(),
  wid text not null references v2_wholesalers(wid),
  name text not null,
  moq_qty int not null default 1,          -- from migration 009
  moq_reorder_qty int
);

create table v2_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2_products(id),
  sku text not null,
  moq_qty int not null default 1           -- per-SKU minimum, from migration 009
);

create table v2_orders (
  id uuid primary key default gen_random_uuid(),
  wid text not null,
  buyer_label text not null,
  client_id uuid,
  location_id uuid,
  status text not null default 'new',
  subtotal numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table v2_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references v2_orders(id),
  variant_id uuid not null references v2_product_variants(id),
  qty int not null,
  unit_price numeric(12,2),
  line_total numeric(12,2),
  pack_id uuid,                            -- added by migration 011
  pack_line_id uuid,
  pack_qty int
);

-- The pack tables that migration 012 never consults. That omission is the bug.
create table v2_pack_definitions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2_products(id),
  wid text not null references v2_wholesalers(wid),
  name text not null,
  color text,
  pack_price numeric(10,2),
  source text not null default 'manual',
  archived boolean not null default false
);

create table v2_pack_components (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references v2_pack_definitions(id),
  variant_id uuid not null references v2_product_variants(id),
  qty_per_pack int not null check (qty_per_pack >= 1),
  unique (pack_id, variant_id)
);

-- Stubs: not under test.
create function v2_confirm_reservation(bigint, uuid, uuid) returns void
language plpgsql as $$ begin return; end; $$;

create function v2_effective_unit_price(uuid, uuid, uuid, int) returns numeric
language plpgsql as $$ begin return 10.00; end; $$;
