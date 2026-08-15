-- OGGI Wholesale v2 — Batch 6: Pricing & MOQ engine, schema
-- 11 Aug 2026
--
-- New in v2 (not a v1-parity feature -- Research 3 validated, nothing to
-- migrate from wholesale_state.doc, so no data migration section here.
-- Real tiers/MOQs/overrides get entered going forward via the wholesaler
-- admin UI this batch also ships -- no fabricated seed data).
--
-- Design:
--   * Tiered pricing is PRODUCT-scoped and "all-units" (Research 3): the
--     aggregate qty across every variant/colorway of one product decides
--     which tier's unit_price applies to ALL units of that product in the
--     order, not just marginal units above the threshold.
--   * MOQ exists at three levels: SKU (variant), product (aggregate across
--     colorways, with a separate first-order vs. reorder threshold), and
--     order (wholesaler-wide minimum qty and/or value).
--   * Per-customer negotiated price ("Your Price") overrides both tiers
--     and the base price for that one client+variant pair.
--   * All of this is enforced authoritatively server-side in
--     010_v2_pricing_moq_enforcement.sql, not just shown client-side for
--     UX -- the same discipline already applied to stock writes in
--     Batch 1 (atomic RPC-only, never trust the client).

alter table v2_products
  add column if not exists moq_qty int not null default 1,
  add column if not exists moq_reorder_qty int;
alter table v2_products add constraint v2_products_moq_qty_positive check (moq_qty >= 1);
alter table v2_products add constraint v2_products_moq_reorder_positive check (moq_reorder_qty is null or moq_reorder_qty >= 1);

alter table v2_product_variants
  add column if not exists moq_qty int not null default 1,
  add column if not exists retail_price numeric(10,2);
alter table v2_product_variants add constraint v2_product_variants_moq_qty_positive check (moq_qty >= 1);

alter table v2_wholesalers
  add column if not exists order_min_qty int,
  add column if not exists order_min_value numeric(10,2);

-- Needed for real reorder-detection (first-order vs. reorder MOQ) and for
-- resolving a buyer's negotiated price overrides server-side, without
-- relying on fragile buyer_label string matching for anything that
-- actually gates behaviour (label matching stays fine for display-only
-- uses like the salesperson recency list from Batch 4).
alter table v2_orders add column if not exists client_id uuid references v2_clients(id) on delete set null;
create index if not exists idx_v2_orders_client on v2_orders(client_id);

create table if not exists v2_pricing_tiers (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2_products(id) on delete cascade,
  min_qty    int not null check (min_qty >= 1),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  created_at timestamptz not null default now(),
  unique (product_id, min_qty)
);
create index if not exists idx_v2_pricing_tiers_product on v2_pricing_tiers(product_id, min_qty);

create table if not exists v2_client_price_overrides (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references v2_clients(id) on delete cascade,
  variant_id     uuid not null references v2_product_variants(id) on delete cascade,
  override_price numeric(10,2) not null check (override_price >= 0),
  note           text,
  created_by     text,
  created_at     timestamptz not null default now(),
  unique (client_id, variant_id)
);
create index if not exists idx_v2_client_price_overrides_client on v2_client_price_overrides(client_id);

alter table v2_pricing_tiers enable row level security;
alter table v2_client_price_overrides enable row level security;

-- Same temporary/permissive dev-mode posture as every other v2_ table,
-- hardened for real in Batch 14.
create policy v2_pricing_tiers_all on v2_pricing_tiers for all using (true) with check (true);
create policy v2_client_price_overrides_all on v2_client_price_overrides for all using (true) with check (true);
