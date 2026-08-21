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

-- Signature corrected in Batch 7, 21 Aug 2026. This stub declared its fourth
-- argument as `int`; the real function has taken `bigint` since migration 010,
-- and v2_submit_order passes a bigint. Postgres will not narrow bigint to int
-- when resolving a function call, so every ACCEPTANCE case in
-- check_pack_moq.sh died on
--
--     function v2_effective_unit_price(uuid, uuid, uuid, bigint) does not exist
--
-- while all eight REJECTION cases passed. A check that only ever says no can
-- "pass" by having broken the feature outright -- which is precisely the
-- failure the acceptance cases exist to catch, and they were the half that was
-- silently dead.
create function v2_effective_unit_price(uuid, uuid, uuid, bigint) returns numeric
language plpgsql as $$ begin return 10.00; end; $$;

-- ---------------------------------------------------------------------------
-- Added Batch 7, 21 Aug 2026, because this fixture had fallen behind the
-- function it tests.
-- ---------------------------------------------------------------------------
-- Migration 024 gave v2_submit_order a sixth parameter, p_account_id, so the
-- server takes wid / client_id / buyer_label from the authenticated account
-- row instead of believing whatever the caller sent. That is the protection
-- against "order as any buyer". This fixture was written before 024 and never
-- gained the table, so loading 028 into it died on
--
--     relation "wholesale_v2.v2_portal_accounts" does not exist
--
-- and check_pack_moq.sh could not run AT ALL. Before Batch 7 that surfaced as
-- eight false "MOQ rule broken" alarms; the preflight now stops instead, which
-- is honest but still means nothing was being guarded. A gate that cannot run
-- guards nothing, however loudly it says so.
--
-- Only the columns 028 reads are reproduced. v2_clients is a bare stub for the
-- foreign key -- client identity is not what this check is about.
create table v2_clients (
  id   uuid primary key default gen_random_uuid(),
  wid  text not null references v2_wholesalers(wid) on delete cascade
);

create table v2_portal_accounts (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null references v2_wholesalers(wid) on delete cascade,
  role          text not null check (role in ('buyer','sales')),
  username      text not null,
  password_hash text not null,
  client_id     uuid references v2_clients(id) on delete set null,
  actor_label   text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
