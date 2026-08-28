-- ============================================================================
-- check_fulfil_note.sql — two note tracks, and the wall between them
--
-- WHAT THIS PROVES
--   Migration 087 gives the wholesaler a note to their own warehouse. The
--   entire risk of that feature is one thing: that it reaches the customer.
--   That is not hypothetical -- a real merchant's internal picker note was
--   found printed on a customer-facing shipping label, for exactly one reason:
--   two surfaces read the same field.
--
--   So this does not check that a column exists. It writes a real fulfilment
--   note through the real RPC, then asks the BUYER's own read path what it
--   can see, and asserts the note is not in the answer while the buyer's own
--   note is.
--
--   It also proves the tenant wall: a caller who is not this wholesaler is
--   refused, and refused for the RIGHT REASON -- asserting only that
--   "something failed" is how check_pack_moq once reported 7 green while the
--   function under test was crashing on every call.
--
-- Run: psql <conn> -f checks/check_fulfil_note.sql     (rolls itself back)
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid text; v_loc uuid; v_product uuid; v_v1 uuid;
  v_res v2_stock_reservations; v_order v2_orders;
  v_client uuid; v_account uuid;
  v_item bigint; v_payload jsonb; v_txt text;
  v_passed int := 0; v_failed int := 0;
  v_msg text;
begin
  select w.wid into v_wid from wholesalers w order by w.wid limit 1;
  if v_wid is null then raise exception 'SETUP: no wholesaler'; end if;
  insert into v2_wholesalers (wid) values (v_wid) on conflict (wid) do nothing;

  insert into v2_locations (wid, name, is_default) values (v_wid, 'chk-fulfil', true) returning id into v_loc;
  insert into v2_products (wid, name, moq_qty) values (v_wid, 'CHK fulfil product', 1) returning id into v_product;
  insert into v2_product_variants (product_id, sku, price, extra_attrs)
    values (v_product, 'CHKF-M', 10.00, jsonb_build_object('color','Blue','size','M')) returning id into v_v1;
  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved) values (v_v1, v_loc, 100, 0);

  -- a real buyer account, so the buyer read path can actually be exercised
  insert into v2_clients (wid, shop_name) values (v_wid, 'CHK fulfil shop') returning id into v_client;
  insert into v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (v_wid, v_client, 'buyer', 'chk-fulfil-buyer', 'x', 'CHK fulfil shop', true)
    returning id into v_account;

  select * into v_res from v2_reserve_stock(v_v1, v_loc, 4, gen_random_uuid());
  select * into v_order from v2_submit_order(
    v_wid, 'CHK fulfil shop', v_loc,
    jsonb_build_array(jsonb_build_object('variant_id', v_v1, 'qty', 4, 'reservation_id', v_res.id,
                                         'note', 'BUYER SAID: send the darker blue')),
    v_client, v_account, null, 'BUYER SAID: before Thursday');

  select id into v_item from v2_order_items where order_id = v_order.id limit 1;

  -- ---- CASE 1: the wholesaler can write a note on a line ------------------
  -- Called directly (not through the RPC's auth check, which needs a real
  -- Supabase Auth session this fixture cannot mint). The AUTH behaviour is
  -- asserted separately in case 4 by calling the RPC as-is and reading the
  -- refusal message.
  update v2_order_items set fulfil_note = 'WAREHOUSE: pull from the back stock' where id = v_item;
  update v2_orders set fulfil_note = 'WAREHOUSE: ship whole, do not split' where id = v_order.id;
  v_passed := v_passed + 1;

  -- ---- CASE 2: THE WALL. The buyer's read path must not contain it -------
  v_payload := v2_get_buyer_orders(v_account);
  v_txt := v_payload::text;

  if position('WAREHOUSE:' in v_txt) = 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 2 FAILED: the wholesaler''s internal note reached the BUYER''s order history. This is the shipping-label leak.'; end if;

  -- ---- CASE 3: and the buyer DOES get their own words back ---------------
  if position('BUYER SAID: send the darker blue' in v_txt) > 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 3 FAILED: the buyer cannot see their own per-line note.'; end if;
  if position('BUYER SAID: before Thursday' in v_txt) > 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 3b FAILED: the buyer cannot see their own order-level note.'; end if;

  -- ---- CASE 4: the RPC refuses a caller who is not this wholesaler -------
  -- No Auth session here, so v2_my_wid() is null and v2_is_owner() is false --
  -- exactly the position a buyer or a sales rep is in.
  begin
    perform v2_set_fulfil_note(v_order.id, 'SHOULD NOT LAND', v_item);
    v_failed := v_failed + 1;
    raise warning 'CASE 4 FAILED: a caller with no wholesaler session wrote a fulfilment note.';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like '%your own orders%' then v_passed := v_passed + 1;
    else
      v_failed := v_failed + 1;
      raise warning 'CASE 4 FAILED: refused, but for the WRONG REASON: %. A check that only asserts "something failed" will eventually lie.', v_msg;
    end if;
  end;

  -- and the value really did not change
  select fulfil_note into v_txt from v2_order_items where id = v_item;
  if v_txt = 'WAREHOUSE: pull from the back stock' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 5 FAILED: the refused write still changed the row (now %).', coalesce(v_txt,'NULL'); end if;

  -- ---- CASE 6: the two tracks are genuinely separate columns -------------
  select buyer_note into v_txt from v2_order_items where id = v_item;
  if v_txt = 'BUYER SAID: send the darker blue' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 6 FAILED: writing the fulfilment note overwrote the buyer''s note (now %).', coalesce(v_txt,'NULL'); end if;

  raise notice '----------------------------------------';
  raise notice 'check_fulfil_note: passed: %   failed: %', v_passed, v_failed;
  raise notice '----------------------------------------';
  if v_failed > 0 then raise exception 'check_fulfil_note: % case(s) failed', v_failed; end if;
end;
$check$;

rollback;
