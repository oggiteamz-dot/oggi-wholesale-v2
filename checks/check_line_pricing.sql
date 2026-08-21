-- ============================================================================
-- check_line_pricing.sql — Batch 5 gate, the database half
--
-- WHAT THIS PROVES
--   That the numbers checks/check_line_pricing.mjs asserts in JavaScript are
--   the numbers v2_submit_order actually writes onto an order. The .mjs half
--   pins the cart; this half pins the invoice; the two files carry the same
--   case ids so neither can be edited alone (the .mjs greps this file for
--   them and fails if one goes missing).
--
-- THE DEFECT IT WAS WRITTEN AGAINST (live before Batch 5)
--   The buyer app priced a PACK line by v2_pack_definitions.pack_price, or by
--   the sum of its components at list price -- with no negotiated price, no
--   quantity break and no catalog discount applied -- and counted its pieces
--   as ZERO toward the quantity-break aggregate. The server has never done
--   either of those things. It prices every line, pack or loose, as
--   qty x v2_effective_unit_price(product, variant, client, agg_qty, catalog)
--   and never reads pack_price at all.
--
--   So a pack sitting in a discounted catalog was displayed at full price and
--   invoiced at the discount. Nobody audits a bill that came in LOWER than
--   the cart, which is exactly why it could have run for months.
--
-- Run:  psql <conn> -f checks/check_line_pricing.sql
-- Everything happens inside a transaction that is ROLLED BACK. No fixture is
-- left behind and no real wholesaler's data is modified: the products,
-- variants and packs below are created fresh under an existing wid (chosen,
-- not created, because v2_wholesalers carries an FK into v1's public
-- wholesalers table that a check has no business writing to).
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid       text;
  v_loc       uuid;
  v_product   uuid;
  v_cat       uuid;
  v_pack      uuid;
  v_sizes     text[] := array['S','M','L','XL'];
  v_size      text;
  v_variant   uuid;
  v_variants  uuid[] := '{}';
  v_res       v2_stock_reservations;
  v_lines     jsonb;
  v_order     v2_orders;
  v_packline  uuid;
  i           int;
  v_log       text := '';
begin
  -- ---- fixture -------------------------------------------------------------
  select w.wid into v_wid from v2_wholesalers w where w.active order by w.wid limit 1;
  if v_wid is null then
    raise exception 'SETUP: no active wholesaler to hang a fixture on';
  end if;

  select l.id into v_loc from v2_locations l where l.wid = v_wid and not l.archived order by l.is_default desc limit 1;
  if v_loc is null then
    insert into v2_locations (wid, name, is_default) values (v_wid, 'check-line-pricing', true) returning id into v_loc;
  end if;

  -- A prepack product: the server refuses loose lines for it, which is what
  -- makes it the right shape to test pack pricing on.
  insert into v2_products (wid, name, selling_model, moq_qty)
  values (v_wid, 'CHECK line-pricing prepack', 'prepack', 1)
  returning id into v_product;

  foreach v_size in array v_sizes loop
    insert into v2_product_variants (product_id, sku, price, extra_attrs)
    values (v_product, 'CHK-'||v_size, 8.00, jsonb_build_object('color','Blue','size',v_size))
    returning id into v_variant;
    v_variants := v_variants || v_variant;
    insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved)
    values (v_variant, v_loc, 500, 0);
  end loop;

  -- A pack of 12: three of each size. pack_price is set DELIBERATELY, and to a
  -- number nothing else in this file could produce, so that if the server ever
  -- starts charging it this check fails loudly instead of the change landing
  -- unnoticed.  ->  case "flat-pack-price-is-not-charged"
  insert into v2_pack_definitions (wid, product_id, name, color, pack_price, source)
  values (v_wid, v_product, 'CHECK pack', 'Blue', 50.00, 'manual')
  returning id into v_pack;

  for i in 1 .. array_length(v_variants, 1) loop
    insert into v2_pack_components (pack_id, variant_id, qty_per_pack) values (v_pack, v_variants[i], 3);
  end loop;

  -- ---- ASSERT 1: "pack-plain" -- one pack of 12 at 8.00 is charged 96.00 ---
  v_packline := gen_random_uuid();
  v_lines := '[]'::jsonb;
  for i in 1 .. array_length(v_variants, 1) loop
    v_res := v2_reserve_stock(v_variants[i], v_loc, 3, gen_random_uuid(), null, 15);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'reservation_id', v_res.id, 'variant_id', v_variants[i], 'qty', 3,
      'pack_id', v_pack, 'pack_line_id', v_packline, 'pack_qty', 1));
  end loop;

  v_order := v2_submit_order(v_wid, 'check-line-pricing', v_loc, v_lines, null, null, null);
  v_log := v_log || format('A1 pack-plain=%s ', v_order.subtotal);
  if v_order.subtotal <> 96.00 then
    raise exception 'ASSERT 1 FAILED (pack-plain): subtotal=% expected 96.00', v_order.subtotal;
  end if;

  -- ---- ASSERT 2: "flat-pack-price-is-not-charged" --------------------------
  -- Same order. pack_price on this pack is 50.00. The order came to 96.00, so
  -- the flat price is stored and NOT charged. This is decision D4 written as
  -- an executable fact rather than a sentence in a document.
  if v_order.subtotal = 50.00 then
    raise exception 'ASSERT 2 FAILED (flat-pack-price-is-not-charged): the server charged pack_price. The buyer UI and this rule now disagree.';
  end if;

  -- ---- ASSERT 3: "pack-discount" -- 25% off makes it 12 x 6.00 = 72.00 ----
  insert into v2_catalogs (wid, name, access_tier, discount_pct, discount_mode, is_default, active)
  values (v_wid, 'CHECK 25pct', 1, 25, 'catalog_only', false, true)
  returning id into v_cat;

  v_packline := gen_random_uuid();
  v_lines := '[]'::jsonb;
  for i in 1 .. array_length(v_variants, 1) loop
    v_res := v2_reserve_stock(v_variants[i], v_loc, 3, gen_random_uuid(), null, 15);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'reservation_id', v_res.id, 'variant_id', v_variants[i], 'qty', 3,
      'pack_id', v_pack, 'pack_line_id', v_packline, 'pack_qty', 1));
  end loop;

  v_order := v2_submit_order(v_wid, 'check-line-pricing', v_loc, v_lines, null, null, v_cat);
  v_log := v_log || format('| A3 pack-discount=%s ', v_order.subtotal);
  if v_order.subtotal <> 72.00 then
    raise exception 'ASSERT 3 FAILED (pack-discount): subtotal=% expected 72.00. A pack in a discounted catalog must be discounted; the buyer card used to show 96.00 for this exact order.', v_order.subtotal;
  end if;

  -- ---- ASSERT 4: "pack-crosses-tier" ---------------------------------------
  -- A 12+ break at 6.50. The 12 pieces are all inside ONE pack line, so this
  -- only fires if the aggregate counts pack pieces. The buyer app counted them
  -- as zero, which is why it never showed the break it had earned.
  insert into v2_pricing_tiers (product_id, min_qty, unit_price) values (v_product, 12, 6.50);

  v_packline := gen_random_uuid();
  v_lines := '[]'::jsonb;
  for i in 1 .. array_length(v_variants, 1) loop
    v_res := v2_reserve_stock(v_variants[i], v_loc, 3, gen_random_uuid(), null, 15);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'reservation_id', v_res.id, 'variant_id', v_variants[i], 'qty', 3,
      'pack_id', v_pack, 'pack_line_id', v_packline, 'pack_qty', 1));
  end loop;

  v_order := v2_submit_order(v_wid, 'check-line-pricing', v_loc, v_lines, null, null, null);
  v_log := v_log || format('| A4 pack-crosses-tier=%s ', v_order.subtotal);
  if v_order.subtotal <> 78.00 then
    raise exception 'ASSERT 4 FAILED (pack-crosses-tier): subtotal=% expected 78.00 (12 x 6.50)', v_order.subtotal;
  end if;

  -- ---- ASSERT 5: "pack-plus-loose-share-aggregate" -------------------------
  -- Two pack lines of 12 -- 24 pieces of one product in one order. The break
  -- is per PRODUCT across the whole order, so both lines price at 6.50:
  -- 24 x 6.50 = 156.00. (Loose lines cannot be mixed in here because the
  -- product is a prepack and v2_enforce_selling_model refuses them -- so the
  -- cross-line aggregate is proven with two pack lines instead, which tests
  -- the same code path in v2_submit_order's `agg` CTE.)
  v_lines := '[]'::jsonb;
  for i in 1 .. array_length(v_variants, 1) loop
    v_res := v2_reserve_stock(v_variants[i], v_loc, 3, gen_random_uuid(), null, 15);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'reservation_id', v_res.id, 'variant_id', v_variants[i], 'qty', 3,
      'pack_id', v_pack, 'pack_line_id', v_packline, 'pack_qty', 1));
  end loop;
  v_packline := gen_random_uuid();
  for i in 1 .. array_length(v_variants, 1) loop
    v_res := v2_reserve_stock(v_variants[i], v_loc, 3, gen_random_uuid(), null, 15);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'reservation_id', v_res.id, 'variant_id', v_variants[i], 'qty', 3,
      'pack_id', v_pack, 'pack_line_id', v_packline, 'pack_qty', 1));
  end loop;

  v_order := v2_submit_order(v_wid, 'check-line-pricing', v_loc, v_lines, null, null, null);
  v_log := v_log || format('| A5 two-pack-lines-aggregate=%s ', v_order.subtotal);
  if v_order.subtotal <> 156.00 then
    raise exception 'ASSERT 5 FAILED (pack-plus-loose-share-aggregate): subtotal=% expected 156.00 (24 pieces x 6.50)', v_order.subtotal;
  end if;

  -- ---- ASSERT 6: every order item was priced per UNIT ----------------------
  -- The rule in one line: line_total = qty x unit_price, on every row the
  -- server wrote. If that ever stops holding, "unit price x quantity" is no
  -- longer something the buyer screen is allowed to display.
  if exists (
    select 1 from v2_order_items oi
     where oi.order_id = v_order.id
       and oi.line_total <> round(oi.qty * oi.unit_price, 2)
  ) then
    raise exception 'ASSERT 6 FAILED: an order item''s line_total is not qty x unit_price';
  end if;

  raise notice 'check_line_pricing: all 6 assertions passed -- %', v_log;
end;
$check$;

rollback;
