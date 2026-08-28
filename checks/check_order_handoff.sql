-- ============================================================================
-- check_order_handoff.sql — one order, handed to someone who is not signed in
--
-- WHAT THIS PROVES
--   Migration 088 gives an order a shareable link. The entire risk of that
--   feature is the same one 087 was written around, but worse: this link is
--   BUILT to be forwarded. It goes to a warehouse, a driver, a buyer, an
--   accountant -- and nobody controls where it stops.
--
--   So the wall is asserted the same way check_fulfil_note asserts its own:
--   a real fulfilment note is written, and then the LINK's own read path is
--   asked what it can see. The buyer's words must be there. The wholesaler's
--   internal instruction must not.
--
--   It also asserts the two properties that make the link safe to send at all:
--   the reader takes NOTHING from its caller but a token, and rotating the
--   token actually kills the old link -- which is the only remedy that exists
--   once a link has been forwarded to the wrong person.
--
--   Every refusal is asserted BY ITS REASON. check_pack_moq once reported 7
--   green while the function under test crashed on every call.
--
-- Run: psql <conn> -f checks/check_order_handoff.sql      (rolls itself back)
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid text; v_loc uuid; v_product uuid; v_v1 uuid;
  v_res v2_stock_reservations; v_order v2_orders;
  v_client uuid; v_account uuid; v_item bigint;
  v_tok text; v_tok2 text; v_row record; v_txt text; v_n int;
  v_passed int := 0; v_failed int := 0; v_msg text;
begin
  select w.wid into v_wid from wholesalers w order by w.wid limit 1;
  if v_wid is null then raise exception 'SETUP: no wholesaler'; end if;
  -- A DISTINCTIVE sentinel in the column 042 closed, so case 6 can assert on
  -- the real value rather than guessing at what a phone number looks like.
  insert into v2_wholesalers (wid, name, contact_phone)
    values (v_wid, 'CHK handoff wholesaler', 'SENTINEL-96133-DO-NOT-LEAK')
    on conflict (wid) do update set name = excluded.name, contact_phone = excluded.contact_phone;

  insert into v2_locations (wid, name, is_default) values (v_wid, 'chk-handoff', true) returning id into v_loc;
  insert into v2_products (wid, name, moq_qty) values (v_wid, 'CHK handoff product', 1) returning id into v_product;
  insert into v2_product_variants (product_id, sku, price, extra_attrs)
    values (v_product, 'CHKH-M', 12.50, jsonb_build_object('color','Indigo','size','M')) returning id into v_v1;
  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved) values (v_v1, v_loc, 100, 0);

  insert into v2_clients (wid, shop_name) values (v_wid, 'CHK handoff shop') returning id into v_client;
  insert into v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (v_wid, v_client, 'buyer', 'chk-handoff-buyer', 'x', 'CHK handoff shop', true)
    returning id into v_account;

  select * into v_res from v2_reserve_stock(v_v1, v_loc, 3, gen_random_uuid());
  select * into v_order from v2_submit_order(
    v_wid, 'CHK handoff shop', v_loc,
    jsonb_build_array(jsonb_build_object('variant_id', v_v1, 'qty', 3, 'reservation_id', v_res.id,
                                         'note', 'BUYER SAID: the darker indigo please')),
    v_client, v_account, null, 'BUYER SAID: deliver before Thursday');

  select id into v_item from v2_order_items where order_id = v_order.id limit 1;

  -- The wholesaler's own internal instruction, on both the line and the order.
  update v2_order_items set fulfil_note = 'WAREHOUSE: pull from back stock, damaged box' where id = v_item;
  update v2_orders      set fulfil_note = 'WAREHOUSE: this shop always disputes, photograph it' where id = v_order.id;

  -- ---- CASE 1: every order got a token, and it is unguessable-shaped -----
  select order_token into v_tok from v2_orders where id = v_order.id;
  if v_tok is not null and length(v_tok) = 24 and v_tok ~ '^[0-9a-f]{24}$' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 1 FAILED: token is % (expected 24 hex chars = 96 bits)', coalesce(v_tok,'NULL'); end if;

  -- ---- CASE 2: the link opens, and carries the order ---------------------
  select * into v_row from v2_order_by_token(v_tok);
  if v_row.status = 'ok' and v_row.order_id = v_order.id then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 2 FAILED: a valid token did not open the order (status %)', coalesce(v_row.status,'NULL'); end if;

  -- ---- CASE 3: it carries the LINES, with what was ordered ---------------
  if jsonb_array_length(v_row.items) = 1
     and (v_row.items->0->>'qty')::int = 3
     and (v_row.items->0->>'sku') = 'CHKH-M'
     and (v_row.items->0->>'color') = 'Indigo'
  then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 3 FAILED: the line did not come through: %', v_row.items::text; end if;

  -- ---- CASE 4: THE WALL. The buyer's words travel; the warehouse's do not.
  -- This is the whole reason the feature is dangerous, and it is red-proved:
  -- adding fulfil_note to the returned jsonb makes this fail.
  if v_row.items::text ilike '%darker indigo%' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 4a FAILED: the BUYER''s own note did not reach the link -- their words are the point of it'; end if;

  if v_row.items::text ilike '%back stock%' or v_row.items::text ilike '%fulfil%' then
    v_failed := v_failed + 1;
    raise warning 'CASE 4b FAILED: the WAREHOUSE note reached a link built to be forwarded: %', v_row.items::text;
  else v_passed := v_passed + 1; end if;

  if v_row::text ilike '%always disputes%' then
    v_failed := v_failed + 1;
    raise warning 'CASE 4c FAILED: the ORDER-level warehouse note reached the link';
  else v_passed := v_passed + 1; end if;

  -- ---- CASE 5: the buyer's order-level note DOES travel ------------------
  if v_row.buyer_order_note = 'BUYER SAID: deliver before Thursday' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 5 FAILED: the buyer''s order note is missing (got %)', coalesce(v_row.buyer_order_note,'NULL'); end if;

  -- ---- CASE 6: the wholesaler's contact number never travels -------------
  -- 042 closed that column deliberately. A link built to be forwarded must not
  -- be the thing that reopens it.
  -- The first version of this asserted on a phone-number-SHAPED regex and
  -- failed on the order's own timestamp. Guessing at shapes is how a check
  -- lies in both directions; this asserts on the actual value, planted above.
  select * into v_row from v2_order_by_token(v_tok);
  if v_row::text ilike '%SENTINEL-96133%' then
    v_failed := v_failed + 1;
    raise warning 'CASE 6 FAILED: the wholesaler''s contact number reached a link built to be forwarded';
  else v_passed := v_passed + 1; end if;

  -- and belt-and-braces: the column is not even in the signature
  select count(*) into v_n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_order_by_token'
     and pg_get_function_result(p.oid) ilike '%phone%';
  if v_n = 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 6b FAILED: v2_order_by_token declares a phone column in its return type'; end if;

  -- ---- CASE 7: an invented token and a dead one answer IDENTICALLY -------
  select * into v_row from v2_order_by_token('ffffffffffffffffffffffff');
  if v_row.status = 'not_found' and v_row.order_id is null then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 7 FAILED: an invented token answered % -- telling a stranger whether an order exists', coalesce(v_row.status,'NULL'); end if;

  -- ---- CASE 8: rotating actually KILLS the old link ----------------------
  -- The only remedy once a link has been forwarded to the wrong person.
  update v2_orders set order_token = encode(extensions.gen_random_bytes(12),'hex') where id = v_order.id;
  select order_token into v_tok2 from v2_orders where id = v_order.id;
  if v_tok2 <> v_tok then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 8a FAILED: rotation produced the same token'; end if;

  select * into v_row from v2_order_by_token(v_tok);
  if v_row.status = 'not_found' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 8b FAILED: the OLD link still opens after rotation -- rotation is decorative'; end if;

  select * into v_row from v2_order_by_token(v_tok2);
  if v_row.status = 'ok' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 8c FAILED: the NEW link does not open'; end if;

  -- ---- CASE 9: anon reads, anon CANNOT rotate ---------------------------
  -- Buyers and sales reps ARE the anon role (085). A buyer who could rotate
  -- could invalidate their own wholesaler's links.
  if has_function_privilege('anon','wholesale_v2.v2_order_by_token(text)','execute')
    then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 9a FAILED: anon cannot open an order link, so no buyer or driver can use one'; end if;

  if has_function_privilege('anon','wholesale_v2.v2_rotate_order_token(uuid)','execute') then
    v_failed := v_failed + 1;
    raise warning 'CASE 9b FAILED: anon can rotate an order token -- buyers and reps ARE anon';
  else v_passed := v_passed + 1; end if;

  -- ---- CASE 10: the reader takes NOTHING from its caller ----------------
  -- 080: "A definer function that trusts its caller is a BIGGER hole than the
  -- one being closed." One argument, and it is the secret itself.
  select count(*) into v_n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_order_by_token' and p.pronargs = 1;
  if v_n = 1 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 10 FAILED: v2_order_by_token takes more than a token -- anything else is a claim the caller makes about itself'; end if;

  -- ---- CASE 11: no table grant was handed out on the way ----------------
  select count(*) into v_n
    from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_orders' and grantee='anon';
  if v_n = 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 11 FAILED: anon holds % grant(s) on v2_orders -- 085 revoked those and this feature must not restore them', v_n; end if;

  raise notice '----------------------------------------';
  raise notice 'check_order_handoff: passed: %   failed: %', v_passed, v_failed;
  raise notice '----------------------------------------';
  if v_failed > 0 then raise exception 'check_order_handoff: % case(s) failed', v_failed; end if;
end;
$check$;

rollback;
