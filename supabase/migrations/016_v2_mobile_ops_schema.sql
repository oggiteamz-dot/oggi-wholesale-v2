-- OGGI Wholesale v2 — Batch 10: mobile barcode receiving/picking schema
-- 11 Aug 2026
--
-- Two real gaps this closes:
--
-- 1) There was no scannable-barcode field distinct from a SKU. A real SKU
--    (an internal catalog code, often human-composed like
--    "KN-330-MidnightBlue-36") and a real scannable barcode (a UPC/EAN
--    printed on the physical product, or an internal warehouse label) are
--    often different strings. `barcode` is added, nullable and unique when
--    set (Postgres unique indexes treat NULLs as distinct, so any number of
--    un-barcoded SKUs is fine) -- receiving/picking lookups fall back to
--    matching the SKU itself when no barcode has been assigned yet, so the
--    feature works immediately even before a wholesaler has printed any
--    barcode labels.
--
-- 2) There was no picking/fulfillment-verification layer at all. Checked
--    directly against the real v2_submit_order/v2_confirm_reservation
--    functions before building this: real stock is ALREADY decremented the
--    moment a buyer submits an order (v2_submit_order calls
--    v2_confirm_reservation per line, which converts the reservation
--    straight into a 'sale' movement). So "picking" here does NOT touch
--    inventory balances again -- that already happened correctly at order
--    time. What's missing is a way to verify, scan-by-scan, that the
--    physical units matching an order's line items actually got pulled off
--    the shelf and packed before the order ships -- a checklist against
--    real order_items, not a second inventory-mutation path.
--    v2_order_pick_items is that checklist: one row per real
--    v2_order_items row, tracking picked_qty against the order's own
--    expected_qty. It denormalizes variant_id from the order item so the
--    scan RPC (migrations/017) can match a scanned code straight to "which
--    line of THIS order does this belong to" without an extra join.

alter table v2_product_variants
  add column if not exists barcode text;

create unique index if not exists v2_product_variants_barcode_uq
  on v2_product_variants(barcode) where barcode is not null;

create table if not exists v2_order_pick_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references v2_orders(id) on delete cascade,
  order_item_id  bigint not null references v2_order_items(id) on delete cascade,
  variant_id     uuid not null references v2_product_variants(id) on delete cascade,
  expected_qty   int not null check (expected_qty > 0),
  picked_qty     int not null default 0 check (picked_qty >= 0 and picked_qty <= expected_qty),
  picked_at      timestamptz,
  updated_at     timestamptz not null default now()
);
create unique index if not exists v2_order_pick_items_item_uq on v2_order_pick_items(order_item_id);
create index if not exists v2_order_pick_items_order_idx on v2_order_pick_items(order_id);
create index if not exists v2_order_pick_items_variant_idx on v2_order_pick_items(order_id, variant_id);

alter table v2_order_pick_items enable row level security;
create policy v2_order_pick_items_all on v2_order_pick_items for all using (true) with check (true);
