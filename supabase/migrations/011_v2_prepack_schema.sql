-- OGGI Wholesale v2 — Batch 7: Prepack / ratio-pack selling, schema
-- 11 Aug 2026
--
-- New in v2 (Research 3: Faire's fixed-carton prepack model + Wizzcommerce's
-- sell-through-informed ratio framing). Nothing to migrate from
-- wholesale_state.doc -- v1 has no pack concept at all.
--
-- Design: a pack is a named bundle of specific variants + quantities
-- (e.g. "Boutique Pack — Blue": 1×S, 2×M, 2×L, 1×XL). Buying N packs must
-- collapse to ONE line/message in the UI ("2x Boutique Pack – Style ABC,
-- Blue") per the research doc's explicit WhatsApp-native requirement, but
-- UNDER THE HOOD it reuses the existing variant-level reservation/ledger
-- system completely unchanged -- each pack component still reserves and
-- decrements real per-SKU stock through the same RPCs from Batch 1. This
-- is deliberate: it means Batch 7 adds zero new ways to get inventory
-- wrong, it only adds a display-grouping layer on top of machinery that's
-- already been tested through six batches.

create table if not exists v2_pack_definitions (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2_products(id) on delete cascade,
  wid        text not null references wholesalers(wid) on delete cascade,
  name       text not null,
  color      text,                 -- packs are typically one colourway across sizes; nullable for a mixed-colour pack
  pack_price numeric(10,2),        -- optional flat price for the whole pack; null = sum of component effective prices
  source     text not null default 'manual' check (source in ('manual', 'suggested')),
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_v2_pack_definitions_product on v2_pack_definitions(product_id) where not archived;

create table if not exists v2_pack_components (
  id           uuid primary key default gen_random_uuid(),
  pack_id      uuid not null references v2_pack_definitions(id) on delete cascade,
  variant_id   uuid not null references v2_product_variants(id) on delete cascade,
  qty_per_pack int not null check (qty_per_pack >= 1),
  unique (pack_id, variant_id)
);
create index if not exists idx_v2_pack_components_pack on v2_pack_components(pack_id);

-- Ties several v2_order_items rows together as "one pack line" for display
-- grouping ("2x Boutique Pack"), without changing how stock is decremented
-- (each row still points at its own real variant_id and qty, exactly like
-- a non-pack line). pack_line_id is a fresh id per pack added to an order
-- (NOT the pack definition's id -- one order can contain the same pack
-- definition added twice as two separate lines, e.g. edited independently).
alter table v2_order_items add column if not exists pack_id uuid references v2_pack_definitions(id) on delete set null;
alter table v2_order_items add column if not exists pack_line_id uuid;
alter table v2_order_items add column if not exists pack_qty int;
create index if not exists idx_v2_order_items_pack_line on v2_order_items(pack_line_id) where pack_line_id is not null;

alter table v2_pack_definitions enable row level security;
alter table v2_pack_components enable row level security;

create policy v2_pack_definitions_all on v2_pack_definitions for all using (true) with check (true);
create policy v2_pack_components_all on v2_pack_components for all using (true) with check (true);
