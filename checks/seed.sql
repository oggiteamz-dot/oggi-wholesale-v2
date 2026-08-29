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

-- ---------------------------------------------------------------------------
-- A stock location for WS-001.  Added 29 Aug 2026.
-- ---------------------------------------------------------------------------
-- Migration 047 gave every order a location and made v2_orders.location_id NOT
-- NULL. This seed predates that, and the three ACCEPTANCE cases in
-- check_pack_moq.sh were still passing `null` for it -- so all three failed on
-- the not-null constraint and printed "expected ACCEPTED", which reads exactly
-- like the MOQ rule wrongly rejecting a legitimate order.
--
-- It was not that. The eight REJECTION cases were green and rejecting for the
-- right reasons throughout; only the acceptance half was asking the server an
-- impossible question. Proven by replaying the chain to 087 (without the two
-- new migrations) and getting the identical 8 pass / 3 fail.
--
-- Fixed UUID so the check can name it.
insert into v2_locations (id, wid, name, is_default)
values ('55555555-5555-5555-5555-555555555555', 'WS-001', 'Main Warehouse', true);

-- Stock for those three SKUs at that location.  Added 29 Aug 2026.
-- v2_submit_order confirms a reservation for every line (migration 001's
-- v2_confirm_reservation), so an order with no reservation dies with
-- "reservation not active or not found" before any MOQ rule is consulted.
-- 1000 of each is far above anything the cases below order; the point is to
-- take stock scarcity OUT of the experiment, so that an acceptance failure
-- can only mean the MOQ rule refused a legitimate order.
insert into v2_inventory_balances (variant_id, location_id, qty_on_hand)
select v.id, '55555555-5555-5555-5555-555555555555', 1000
from v2_product_variants v
where v.product_id = '11111111-1111-1111-1111-111111111111';

-- A wholesale price on each SKU.  Added 29 Aug 2026.
-- v2_order_items.unit_price is NOT NULL and v2_effective_unit_price resolves
-- from v2_product_variants.price, so a priceless SKU makes every acceptance
-- case die on the constraint. The value is arbitrary -- nothing here asserts
-- on money -- but it must exist for the order to be writable at all.
update v2_product_variants set price = 10.00
 where product_id = '11111111-1111-1111-1111-111111111111';
