-- OGGI Wholesale v2 — Batch 9: Inventory intelligence schema
-- 11 Aug 2026
--
-- Four features, four additive schema pieces, none of them touching the
-- Batch 1 core ledger tables (v2_inventory_movements/v2_inventory_balances)
-- or their RPCs -- every write below either reuses those RPCs as-is
-- (v2_receive_stock/v2_decrement_stock are already generic over
-- movement_type/reference_type, see migrations/001) or lives in a brand
-- new table.
--
-- 1) Reorder-point automation: reorder_point/reorder_qty/lead_time_days on
--    v2_product_variants, same precedent as Batch 6's moq_qty/retail_price
--    living directly on the variant row rather than a side table (cheap
--    join, one row per SKU, matches how buyers/wholesalers already think
--    about a SKU's settings). All nullable -- a variant with no reorder
--    point configured simply never triggers a reorder suggestion, rather
--    than defaulting to some fabricated number.
--
-- 2) Kit/bundle SKUs: DELIBERATELY a different mechanism from Batch 7's
--    prepacks. A prepack collapses to one cart line at ORDER time but never
--    exists as real on-hand stock of its own, and is scoped to one
--    product's own colourways. A kit here is pre-ASSEMBLED ahead of time
--    into its own real, sellable, cross-product SKU (v2_kit_definitions.
--    kit_variant_id IS a normal v2_product_variants row -- it can be
--    priced, ordered, and counted exactly like any other SKU) whose
--    components can span multiple different products. v2_assemble_kit
--    (migrations/015) is the only way component stock converts into kit
--    stock, and it's built entirely out of the existing
--    v2_decrement_stock/v2_receive_stock RPCs.
--
-- 3) Landed cost tracking: v2_receipt_costs is a side table keyed to a
--    specific receiving movement (v2_inventory_movements.id), NOT a column
--    added to the movements table itself -- freight/duty/other costs are
--    optional extra detail about a receipt, not every receipt has them
--    (e.g. a count correction has no landed cost), so a side table with a
--    nullable link is more honest than a column that's empty most rows.
--
-- 4) ABC-tiered cycle counting: v2_cycle_counts logs actual physical counts
--    (expected vs counted, so variance is always the real database's own
--    computation at the moment of the count, never a client guess). The
--    ABC classification itself is NOT stored -- it's derived live from real
--    trailing order history (js/data/inventory-intelligence.js), same
--    "derive from real data, don't cache a snapshot that goes stale"
--    principle as Batch 7's sell-through ratio suggestion.

alter table v2_product_variants
  add column if not exists reorder_point int,
  add column if not exists reorder_qty int,
  add column if not exists lead_time_days int;

create table if not exists v2_kit_definitions (
  id             uuid primary key default gen_random_uuid(),
  wid            text not null references v2_wholesalers(wid) on delete cascade,
  kit_variant_id uuid not null references v2_product_variants(id) on delete cascade,
  name           text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index if not exists v2_kit_definitions_variant_uq on v2_kit_definitions(kit_variant_id);

create table if not exists v2_kit_components (
  id                    uuid primary key default gen_random_uuid(),
  kit_id                uuid not null references v2_kit_definitions(id) on delete cascade,
  component_variant_id  uuid not null references v2_product_variants(id) on delete cascade,
  qty_per_kit           int not null check (qty_per_kit > 0)
);

create table if not exists v2_receipt_costs (
  id                uuid primary key default gen_random_uuid(),
  -- Soft reference only (no FK): v2_inventory_movements' primary key is the
  -- composite (id, created_at) -- almost certainly because it's a
  -- time-partitioned ledger table -- so a plain single-column FK to `id`
  -- isn't possible without altering that table's key structure, which this
  -- build does not do to an established core table. The ledger is
  -- append-only/never deleted in practice, so an unenforced reference here
  -- is a reasonable, low-risk tradeoff for a reporting/audit-trail column.
  movement_id       bigint,
  variant_id        uuid not null references v2_product_variants(id) on delete cascade,
  qty               int not null check (qty > 0),
  freight_cost      numeric not null default 0,
  duty_cost         numeric not null default 0,
  other_cost        numeric not null default 0,
  landed_unit_cost  numeric not null,
  created_at        timestamptz not null default now()
);

create table if not exists v2_cycle_counts (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null references v2_wholesalers(wid) on delete cascade,
  variant_id    uuid not null references v2_product_variants(id) on delete cascade,
  location_id   uuid not null references v2_locations(id) on delete cascade,
  expected_qty  int not null,
  counted_qty   int not null,
  variance      int not null,
  counted_by    text,
  counted_at    timestamptz not null default now()
);

alter table v2_kit_definitions enable row level security;
alter table v2_kit_components enable row level security;
alter table v2_receipt_costs enable row level security;
alter table v2_cycle_counts enable row level security;

create policy v2_kit_definitions_all on v2_kit_definitions for all using (true) with check (true);
create policy v2_kit_components_all on v2_kit_components for all using (true) with check (true);
create policy v2_receipt_costs_all on v2_receipt_costs for all using (true) with check (true);
create policy v2_cycle_counts_all on v2_cycle_counts for all using (true) with check (true);
