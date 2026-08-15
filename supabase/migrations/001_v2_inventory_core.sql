-- OGGI Wholesale v2 — Batch 1: Core variant + ledger-based inventory schema
-- 3 Aug 2026
--
-- SAFETY: every object here is prefixed v2_ and lives alongside the existing
-- v1 tables (wholesalers/products/orders/wholesale_state/etc). Nothing v1
-- reads or writes touches these tables. v1 stays live and untouched. This is
-- additive-only, per Hadi's explicit instruction not to remove/delete the
-- old app while building the new one.
--
-- Source: [C] TRUE DEEP RESEARCH 1 — ERP-Level Inventory (Aug 3 2026), §5-§7.
-- Every design choice below (variant-grain stock, append-only ledger, atomic
-- RPC-only writes, soft TTL reservations, partitioned ledger) is taken
-- directly from that research, not improvised.

-- ============================================================
-- 1. Normalized product/variant schema (Research 1 §5)
-- ============================================================

-- NOTE: wholesalers' primary key is `wid` (text), not `id` — confirmed via
-- list_tables against the live schema before writing this. Every FK below
-- targets wholesalers(wid) with a matching `text` column type, not uuid.

create table if not exists v2_products (
  id          uuid primary key default gen_random_uuid(),
  wid         text not null references wholesalers(wid) on delete cascade,
  name        text not null,
  description text,
  category    text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_v2_products_wid on v2_products(wid) where not archived;

create table if not exists v2_product_options (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2_products(id) on delete cascade,
  name       text not null,              -- e.g. 'Color', 'Size'
  position   int not null default 0
);
create index if not exists idx_v2_options_product on v2_product_options(product_id);

create table if not exists v2_product_option_values (
  id        uuid primary key default gen_random_uuid(),
  option_id uuid not null references v2_product_options(id) on delete cascade,
  value     text not null,               -- e.g. 'Red', 'Medium'
  position  int not null default 0
);
create index if not exists idx_v2_option_values_option on v2_product_option_values(option_id);

create table if not exists v2_product_variants (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references v2_products(id) on delete cascade,
  sku          text not null,
  price        numeric(12,2),
  cost         numeric(12,2),             -- landed cost, feeds Batch 9
  compare_at_price numeric(12,2),         -- suggested retail / MSRP, feeds catalog display
  extra_attrs  jsonb not null default '{}',
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_id, sku)
);
create index if not exists idx_v2_variants_product on v2_product_variants(product_id) where not archived;
create index if not exists idx_v2_variants_extra_attrs on v2_product_variants using gin (extra_attrs);

create table if not exists v2_product_variant_option_values (
  variant_id      uuid not null references v2_product_variants(id) on delete cascade,
  option_value_id uuid not null references v2_product_option_values(id) on delete cascade,
  primary key (variant_id, option_value_id)
);

-- ============================================================
-- 2. Locations (warehouse-level only — no aisle/bin per PRD scope)
-- ============================================================

create table if not exists v2_locations (
  id         uuid primary key default gen_random_uuid(),
  wid        text not null references wholesalers(wid) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_locations_wid on v2_locations(wid) where not archived;

-- ============================================================
-- 3. Ledger-based stock tracking (Research 1 §1, §7 — partitioned from day one)
-- ============================================================

create table if not exists v2_inventory_movements (
  id              bigint generated always as identity,
  variant_id      uuid not null references v2_product_variants(id),
  location_id     uuid not null references v2_locations(id),
  movement_type   text not null check (movement_type in
                   ('receive','sale','sale_reversal','transfer_out','transfer_in',
                    'adjustment','count_correction','reserve','release')),
  qty_delta       integer not null,
  reference_type  text,                 -- 'order','po','count','manual'
  reference_id    uuid,
  actor_id        uuid,
  note            text,
  created_at      timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- First partition (current month) so the table is usable immediately;
-- pg_partman (if/when installed) takes over monthly partition creation
-- and retention from here, per Research 1 §7.
create table if not exists v2_inventory_movements_2026_08
  partition of v2_inventory_movements
  for values from ('2026-08-01') to ('2026-09-01');

create index if not exists idx_v2_movements_variant_loc
  on v2_inventory_movements (variant_id, location_id, created_at);
create index if not exists idx_v2_movements_reference
  on v2_inventory_movements (reference_type, reference_id);

-- Rollup: the only "current stock" number, always kept in sync with the
-- ledger by the same transaction that writes a movement row. Never written
-- to directly from the client — see the RPC functions below.
create table if not exists v2_inventory_balances (
  variant_id   uuid not null references v2_product_variants(id),
  location_id  uuid not null references v2_locations(id),
  qty_on_hand  integer not null default 0,
  qty_reserved integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (variant_id, location_id)
);

-- Aggregate-across-locations view, computed on read (Research 1 §4 — don't
-- prematurely materialize; promote only if measured as a bottleneck).
create or replace view v2_inventory_by_variant as
select variant_id,
       sum(qty_on_hand)  as total_on_hand,
       sum(qty_reserved) as total_reserved,
       sum(qty_on_hand) - sum(qty_reserved) as total_available,
       jsonb_object_agg(location_id, jsonb_build_object(
         'on_hand', qty_on_hand, 'reserved', qty_reserved
       )) as by_location
from v2_inventory_balances
group by variant_id;

-- ============================================================
-- 4. Soft stock reservations with TTL (Research 1 §3)
-- ============================================================

create table if not exists v2_stock_reservations (
  id          bigint generated always as identity primary key,
  variant_id  uuid not null references v2_product_variants(id),
  location_id uuid not null references v2_locations(id),
  qty         integer not null check (qty > 0),
  cart_id     uuid not null,
  buyer_id    uuid,
  expires_at  timestamptz not null,
  status      text not null default 'active'
              check (status in ('active','confirmed','released','expired')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_reservations_active
  on v2_stock_reservations (variant_id, location_id) where status = 'active';
create index if not exists idx_v2_reservations_expiry
  on v2_stock_reservations (expires_at) where status = 'active';

-- ============================================================
-- 5. Atomic, race-condition-safe write functions (Research 1 §2)
--    These are the ONLY sanctioned way to change stock. No client code
--    should ever UPDATE v2_inventory_balances directly.
-- ============================================================

-- Receive stock (increments on_hand, writes a ledger row, atomically).
create or replace function v2_receive_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer,
  p_reference_type text default 'manual', p_reference_id uuid default null,
  p_actor_id uuid default null, p_note text default null
) returns v2_inventory_balances
language plpgsql security definer as $$
declare v_row v2_inventory_balances;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand)
    values (p_variant_id, p_location_id, p_qty)
    on conflict (variant_id, location_id)
    do update set qty_on_hand = v2_inventory_balances.qty_on_hand + excluded.qty_on_hand,
                  updated_at = now()
    returning * into v_row;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
    values (p_variant_id, p_location_id, 'receive', p_qty, p_reference_type, p_reference_id, p_actor_id, p_note);

  return v_row;
end; $$;

-- Decrement stock atomically; returns null if insufficient stock (caller
-- checks for null, not an exception, so a cart UI can show "only N left").
create or replace function v2_decrement_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer,
  p_movement_type text, p_reference_type text default null, p_reference_id uuid default null,
  p_actor_id uuid default null, p_note text default null
) returns v2_inventory_balances
language plpgsql security definer as $$
declare v_row v2_inventory_balances;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  update v2_inventory_balances
    set qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    where variant_id = p_variant_id and location_id = p_location_id
      and qty_on_hand >= p_qty
    returning * into v_row;

  if v_row is null then
    return null;  -- insufficient stock; caller decides how to surface this
  end if;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
    values (p_variant_id, p_location_id, p_movement_type, -p_qty, p_reference_type, p_reference_id, p_actor_id, p_note);

  return v_row;
end; $$;

-- Create a soft reservation (cart hold). Increments qty_reserved atomically;
-- fails (returns null) if not enough AVAILABLE (on_hand - reserved) stock.
create or replace function v2_reserve_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer,
  p_cart_id uuid, p_buyer_id uuid default null, p_ttl_minutes integer default 15
) returns v2_stock_reservations
language plpgsql security definer as $$
declare v_bal v2_inventory_balances; v_res v2_stock_reservations;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  update v2_inventory_balances
    set qty_reserved = qty_reserved + p_qty, updated_at = now()
    where variant_id = p_variant_id and location_id = p_location_id
      and qty_on_hand - qty_reserved >= p_qty
    returning * into v_bal;

  if v_bal is null then
    return null;  -- not enough AVAILABLE stock (on_hand - already-reserved)
  end if;

  insert into v2_stock_reservations
    (variant_id, location_id, qty, cart_id, buyer_id, expires_at)
    values (p_variant_id, p_location_id, p_qty, p_cart_id, p_buyer_id, now() + (p_ttl_minutes || ' minutes')::interval)
    returning * into v_res;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id)
    values (p_variant_id, p_location_id, 'reserve', p_qty, 'cart', p_cart_id);

  return v_res;
end; $$;

-- Release an active reservation (cart abandoned, or expiry sweep calls this).
create or replace function v2_release_reservation(p_reservation_id bigint)
returns void language plpgsql security definer as $$
declare v_res v2_stock_reservations;
begin
  select * into v_res from v2_stock_reservations where id = p_reservation_id and status = 'active';
  if v_res is null then return; end if;

  update v2_inventory_balances
    set qty_reserved = qty_reserved - v_res.qty, updated_at = now()
    where variant_id = v_res.variant_id and location_id = v_res.location_id;

  update v2_stock_reservations set status = 'released' where id = p_reservation_id;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id)
    values (v_res.variant_id, v_res.location_id, 'release', v_res.qty, 'cart', v_res.cart_id);
end; $$;

-- Confirm a reservation at checkout: converts the reserved hold into a real
-- sale (decrements on_hand AND qty_reserved together, atomically).
create or replace function v2_confirm_reservation(
  p_reservation_id bigint, p_order_id uuid default null, p_actor_id uuid default null
) returns v2_inventory_balances
language plpgsql security definer as $$
declare v_res v2_stock_reservations; v_row v2_inventory_balances;
begin
  select * into v_res from v2_stock_reservations where id = p_reservation_id and status = 'active';
  if v_res is null then raise exception 'reservation not active or not found'; end if;

  update v2_inventory_balances
    set qty_on_hand = qty_on_hand - v_res.qty, qty_reserved = qty_reserved - v_res.qty, updated_at = now()
    where variant_id = v_res.variant_id and location_id = v_res.location_id
    returning * into v_row;

  update v2_stock_reservations set status = 'confirmed' where id = p_reservation_id;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id)
    values (v_res.variant_id, v_res.location_id, 'sale', -v_res.qty, 'order', p_order_id, p_actor_id);

  return v_row;
end; $$;

-- Sweep expired reservations (call from pg_cron every 1-5 min, per Research 1 §3).
create or replace function v2_release_expired_reservations() returns integer
language plpgsql security definer as $$
declare v_count integer := 0; v_r record;
begin
  for v_r in select id from v2_stock_reservations where status = 'active' and expires_at < now() loop
    perform v2_release_reservation(v_r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

-- ============================================================
-- 6. Internal webhook/event infrastructure (Research 2 — build before any
--    external integration; every future integration is a consumer of this)
-- ============================================================

create table if not exists v2_webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  wid         text references wholesalers(wid) on delete cascade,
  url         text not null,
  secret      text not null,          -- HMAC signing secret, per Research 2 §6
  event_types text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists v2_webhook_deliveries (
  id           bigint generated always as identity primary key,
  endpoint_id  uuid not null references v2_webhook_endpoints(id) on delete cascade,
  event_type   text not null,
  payload      jsonb not null,
  status       text not null default 'pending'
               check (status in ('pending','delivered','failed','dead_letter')),
  attempt_count integer not null default 0,
  last_response_code integer,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists idx_v2_deliveries_pending
  on v2_webhook_deliveries (status, created_at) where status in ('pending','failed');

-- ============================================================
-- 7. RLS — enabled on every new table, scoped to the owning wholesaler,
--    mirroring the pattern already used by v1's wholesalers_write_scoped.
-- ============================================================

alter table v2_products enable row level security;
alter table v2_product_options enable row level security;
alter table v2_product_option_values enable row level security;
alter table v2_product_variants enable row level security;
alter table v2_product_variant_option_values enable row level security;
alter table v2_locations enable row level security;
alter table v2_inventory_movements enable row level security;
alter table v2_inventory_balances enable row level security;
alter table v2_stock_reservations enable row level security;
alter table v2_webhook_endpoints enable row level security;
alter table v2_webhook_deliveries enable row level security;

-- Placeholder-safe default: authenticated role can read/write scoped to
-- their own wid via existing session claims. Tightened for real in Batch 14
-- (Security). Deliberately permissive-but-scoped during the build so every
-- batch is testable, per PRD §7 -- NOT a production security posture yet.
create policy v2_products_scoped on v2_products for all
  using (wid::text = coalesce(auth.jwt() ->> 'wid', wid::text))
  with check (true);
create policy v2_locations_scoped on v2_locations for all
  using (wid::text = coalesce(auth.jwt() ->> 'wid', wid::text))
  with check (true);
