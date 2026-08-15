-- Seed one wholesaler, one product, one SKU with a per-SKU minimum of 12,
-- and one real pack definition. Fixed UUIDs so the tests are readable.

insert into v2_wholesalers (wid, order_min_qty, order_min_value)
values ('WS-001', null, null);

insert into v2_products (id, wid, name, moq_qty)
values ('11111111-1111-1111-1111-111111111111', 'WS-001', 'Classic Tee', 1);

-- Per-SKU minimum: a buyer must take at least 12 of this SKU on its own.
insert into v2_product_variants (id, product_id, sku, moq_qty) values
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'TEE-BLUE-S', 12),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'TEE-BLUE-M', 12),
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'TEE-BLUE-L', 12);

-- A genuine pack: 1 small, 2 medium, 2 large.
insert into v2_pack_definitions (id, product_id, wid, name, color)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'WS-001', 'Boutique Pack', 'Blue');

insert into v2_pack_components (pack_id, variant_id, qty_per_pack) values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222201', 1),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222202', 2),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222203', 2);

-- A second wholesaler with its own pack, so the check can prove a buyer
-- cannot borrow another wholesaler's pack to unlock a minimum here.
insert into v2_wholesalers (wid) values ('WS-002');
insert into v2_products (id, wid, name, moq_qty)
values ('11111111-1111-1111-1111-111111111112', 'WS-002', 'Other Tee', 1);
insert into v2_pack_definitions (id, product_id, wid, name)
values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111112', 'WS-002', 'Rival Pack');
