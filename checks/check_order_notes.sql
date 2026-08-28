-- ============================================================================
-- check_order_notes.sql — the buyer's note reaches the order. Migration 086.
--
-- WHAT THIS PROVES, and what it deliberately does NOT
--   It does not ask whether a column called buyer_note exists. A column can
--   exist and never be written -- that is the exact defect 086 was written
--   against (v2_orders.notes, present since migration 004, written by nothing).
--   So this submits a REAL order through v2_submit_order with notes attached
--   and reads back what the server actually stored.
--
--   Case 4 is the one that matters most: it asserts p_account_id and
--   p_catalog_id still work after the signature change, because the failure
--   mode this whole migration guards against is a fix that looks applied and
--   has silently dropped a security parameter.
--
-- Run: psql <conn> -f checks/check_order_notes.sql     (rolls itself back)
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid      text;
  v_loc      uuid;
  v_product  uuid;
  v_v1       uuid;
  v_v2       uuid;
  v_res1     v2_stock_reservations;
  v_res2     v2_stock_reservations;
  v_order    v2_orders;
  v_note1    text;
  v_note2    text;
  v_passed   int := 0;
  v_failed   int := 0;
  procedure_note text;
begin
  -- ---- fixture -------------------------------------------------------------
  select w.wid into v_wid from wholesalers w order by w.wid limit 1;
  if v_wid is null then raise exception 'SETUP: no wholesaler to hang a fixture on'; end if;
  insert into v2_wholesalers (wid) values (v_wid) on conflict (wid) do nothing;

  insert into v2_locations (wid, name, is_default) values (v_wid, 'check-order-notes', true) returning id into v_loc;

  insert into v2_products (wid, name, moq_qty) values (v_wid, 'CHECK notes product', 1) returning id into v_product;

  insert into v2_product_variants (product_id, sku, price, extra_attrs)
  values (v_product, 'CHKN-BLUE-M', 10.00, jsonb_build_object('color','Blue','size','M')) returning id into v_v1;
  insert into v2_product_variants (product_id, sku, price, extra_attrs)
  values (v_product, 'CHKN-RED-L', 10.00, jsonb_build_object('color','Red','size','L')) returning id into v_v2;

  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved) values (v_v1, v_loc, 100, 0);
  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved) values (v_v2, v_loc, 100, 0);

  select * into v_res1 from v2_reserve_stock(v_v1, v_loc, 5, gen_random_uuid());
  select * into v_res2 from v2_reserve_stock(v_v2, v_loc, 3, gen_random_uuid());

  -- ---- CASE 1: a per-line note is stored against the RIGHT line ------------
  select * into v_order from v2_submit_order(
    v_wid, 'notes-check-buyer', v_loc,
    jsonb_build_array(
      jsonb_build_object('variant_id', v_v1, 'qty', 5, 'reservation_id', v_res1.id,
                         'note', 'send this one in the darker blue'),
      jsonb_build_object('variant_id', v_v2, 'qty', 3, 'reservation_id', v_res2.id,
                         'note', 'this size runs small, add the bigger cut')
    ),
    null, null, null,
    'deliver before Thursday please'
  );

  select oi.buyer_note into v_note1 from v2_order_items oi where oi.order_id = v_order.id and oi.variant_id = v_v1;
  select oi.buyer_note into v_note2 from v2_order_items oi where oi.order_id = v_order.id and oi.variant_id = v_v2;

  if v_note1 = 'send this one in the darker blue' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 1 FAILED: line 1 note is %, expected the darker-blue note', coalesce(v_note1,'NULL'); end if;

  -- CASE 2: notes did not bleed between lines. A single shared field is the
  -- documented failure (an internal picker note reaching a customer label).
  if v_note2 = 'this size runs small, add the bigger cut' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 2 FAILED: line 2 note is %, expected its own note', coalesce(v_note2,'NULL'); end if;

  -- CASE 3: the order-level note landed. This column had NEVER been written.
  if v_order.notes = 'deliver before Thursday please' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 3 FAILED: order note is %, expected the Thursday note', coalesce(v_order.notes,'NULL'); end if;

  -- ---- CASE 4: THE SECURITY PARAMETERS SURVIVED THE SIGNATURE CHANGE ------
  -- The 15 Aug near-miss: a patch drafted from an older file would have deleted
  -- p_account_id. If this call fails, the signature lost a parameter.
  select * into v_res1 from v2_reserve_stock(v_v1, v_loc, 2, gen_random_uuid());
  begin
    select * into v_order from v2_submit_order(
      p_wid := v_wid, p_buyer_label := 'notes-check-buyer', p_location_id := v_loc,
      p_lines := jsonb_build_array(jsonb_build_object('variant_id', v_v1, 'qty', 2, 'reservation_id', v_res1.id)),
      p_client_id := null, p_account_id := null, p_catalog_id := null, p_notes := null);
    v_passed := v_passed + 1;
  exception when others then
    v_failed := v_failed + 1;
    raise warning 'CASE 4 FAILED: a fully-named 8-arg call raised "%". p_account_id/p_catalog_id may have been lost, or an ambiguous overload survives.', sqlerrm;
  end;

  -- CASE 5: a line with no note stores NULL, not an empty string. An empty
  -- string renders as a blank note box on the warehouse sheet.
  select oi.buyer_note into v_note1 from v2_order_items oi where oi.order_id = v_order.id;
  if v_note1 is null then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 5 FAILED: a line with no note stored %, expected NULL', quote_literal(v_note1); end if;

  -- CASE 6: whitespace-only note is normalised to NULL, not stored.
  select * into v_res2 from v2_reserve_stock(v_v2, v_loc, 1, gen_random_uuid());
  select * into v_order from v2_submit_order(
    v_wid, 'notes-check-buyer', v_loc,
    jsonb_build_array(jsonb_build_object('variant_id', v_v2, 'qty', 1, 'reservation_id', v_res2.id, 'note', '    ')),
    null, null, null, '   ');
  select oi.buyer_note into v_note1 from v2_order_items oi where oi.order_id = v_order.id;
  if v_note1 is null and v_order.notes is null then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 6 FAILED: whitespace-only notes stored as % / %', quote_literal(coalesce(v_note1,'NULL')), quote_literal(coalesce(v_order.notes,'NULL')); end if;

  -- CASE 7: a long note is not truncated. "Unlimited amount of text" was the
  -- requirement; text has no limit but a future varchar(n) would break it.
  select * into v_res1 from v2_reserve_stock(v_v1, v_loc, 1, gen_random_uuid());
  select * into v_order from v2_submit_order(
    v_wid, 'notes-check-buyer', v_loc,
    jsonb_build_array(jsonb_build_object('variant_id', v_v1, 'qty', 1, 'reservation_id', v_res1.id,
                                         'note', repeat('x', 20000))),
    null, null, null, null);
  select oi.buyer_note into v_note1 from v2_order_items oi where oi.order_id = v_order.id;
  if length(v_note1) = 20000 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 7 FAILED: a 20000-char note came back as % chars', coalesce(length(v_note1), -1); end if;

  raise notice '----------------------------------------';
  raise notice 'check_order_notes: passed: %   failed: %', v_passed, v_failed;
  raise notice '----------------------------------------';
  if v_failed > 0 then
    raise exception 'check_order_notes: % case(s) failed', v_failed;
  end if;
end;
$check$;

rollback;
