-- =============================================================================
-- CHECK: the count check, on the server                    (CNT-00, 6 Sep 2026)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
--   psql "$DATABASE_URL" -f checks/check_receive_count.sql
--
-- THE REPORTED PROBLEM
-- A wholesaler buys 250 pieces, enters the colours and sizes, misclicks, and
-- the breakdown totals 270. Nothing stops the save. The invoice says one number
-- and the stock says another.
--
-- WHY THIS FILE IS SQL AND NOT ONLY A BROWSER GATE
-- checks/check_receive_count.mjs drives the screen and proves the button is
-- disabled and says "20 too many". That is the person's experience of the rule.
-- It is not the rule. A disabled button is a UI state: it survives exactly as
-- long as this one screen is the only way in, and this codebase already has a
-- CSV import path and a barcode path that write stock without going near it.
--
-- So the count check lives in v2_receive_product, and this file is where it is
-- earned. Every assertion below is the DATABASE refusing, or the database
-- having written exactly what it said it would.
--
-- THE ASSERTION THAT MATTERS MOST IS 3.
-- Not "it raised an exception" -- that is easy and proves little. Assertion 3
-- is that after a refused receipt, the warehouse holds EXACTLY what it held
-- before: no partial write, no nine boxes of a sixteen-box delivery. A
-- half-applied receipt is worse than a refused one, because nothing anywhere
-- records that it happened.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  PASS int := 0; FAIL int := 0;
  w        text := 'zz_cnt';
  wOther   text := 'zz_cnt_rival';
  uMe      uuid := '00000000-0000-4000-8000-0000000f0001';
  uThem    uuid := '00000000-0000-4000-8000-0000000f0002';
  v_loc    uuid;
  v_locOther uuid;
  v_locArch uuid;
  v_prod   uuid;
  v_prodOther uuid;
  v_vOther uuid;
  v_ids    uuid[] := '{}';
  v_lines  jsonb;
  v_before numeric;
  v_after  numeric;
  v_msg    text;
  n        int;
  i        int;
  colours  text[] := array['Navy','Ecru','Olive','Rust'];
  sizes    text[] := array['S','M','L','XL'];
  c        text;
  s        text;
  vid      uuid;
begin
  ------------------------------------------------------------------- fixture
  insert into public.wholesalers        (wid, name) values (w, 'Count Co'), (wOther, 'Rival Co')
    on conflict (wid) do nothing;
  insert into wholesale_v2.v2_wholesalers (wid, name) values (w, 'Count Co'), (wOther, 'Rival Co')
    on conflict (wid) do nothing;

  -- Two signed-in wholesalers. The rival exists so that "it refused" can be
  -- distinguished from "it refuses everybody".
  -- v2_user_profiles has an FK into auth.users, so the two accounts have to
  -- exist there first. Both are role 'wholesaler', never 'owner': an owner
  -- passes every tenant check by design, and a fixture signed in as one would
  -- make assertions 6 and 7 pass for the wrong reason.
  insert into auth.users (id, email) values (uMe, 'me@zzcnt.test'), (uThem, 'rival@zzcnt.test')
    on conflict (id) do nothing;
  insert into wholesale_v2.v2_user_profiles (id, role, wid)
       values (uMe, 'wholesaler', w), (uThem, 'wholesaler', wOther)
    on conflict (id) do update set wid = excluded.wid, role = excluded.role;

  insert into wholesale_v2.v2_locations (wid, name, is_default) values (w, 'Count Warehouse', true)
    returning id into v_loc;
  insert into wholesale_v2.v2_locations (wid, name) values (wOther, 'Rival Warehouse')
    returning id into v_locOther;
  insert into wholesale_v2.v2_locations (wid, name, archived) values (w, 'Old Shed', true)
    returning id into v_locArch;

  insert into wholesale_v2.v2_products (wid, name, selling_model, moq_qty)
       values (w, 'CNT Poplin Shirt', 'open', 1) returning id into v_prod;
  insert into wholesale_v2.v2_products (wid, name, selling_model, moq_qty)
       values (wOther, 'Rival Shirt', 'open', 1) returning id into v_prodOther;

  -- 4 colours x 4 sizes = the sixteen boxes the whole feature is about.
  foreach c in array colours loop
    foreach s in array sizes loop
      insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
      values (v_prod, 'CNT-' || left(c,2) || '-' || s, 20.00,
              jsonb_build_object('color', c, 'size', s))
      returning id into vid;
      v_ids := v_ids || vid;
    end loop;
  end loop;

  insert into wholesale_v2.v2_product_variants (product_id, sku, price, extra_attrs)
  values (v_prodOther, 'RIV-1', 20.00, jsonb_build_object('color','Navy','size','S'))
  returning id into v_vOther;

  -- Sign in as the wholesaler who owns the warehouse.
  perform set_config('request.jwt.claims', json_build_object('sub', uMe)::text, true);

  ---------------------------------------------------------------------------
  -- 1. THE HAPPY PATH. 250 pieces across sixteen boxes: 15 in each with the
  --    spare 10 on the first ten, which is what "spread evenly" produces.
  ---------------------------------------------------------------------------
  v_lines := '[]'::jsonb;
  for i in 1..16 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'variant_id', v_ids[i], 'qty', 15 + case when i <= 10 then 1 else 0 end));
  end loop;

  perform wholesale_v2.v2_receive_product(v_loc, v_lines, 250, null);

  select coalesce(sum(qty_on_hand), 0) into v_after
    from wholesale_v2.v2_inventory_balances b
   where b.location_id = v_loc and b.variant_id = any(v_ids);
  if v_after = 250 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1: a correct 250-piece receipt put % on hand', v_after; end if;

  ---------------------------------------------------------------------------
  -- 2. EVERY BOX LANDED WHERE IT WAS SENT. A total that is right while the
  --    sizes are shuffled is the same bug wearing a passing number.
  ---------------------------------------------------------------------------
  select count(*) into n
    from wholesale_v2.v2_inventory_balances b
   where b.location_id = v_loc
     and b.variant_id = any(v_ids)
     and b.qty_on_hand <> (15 + case when array_position(v_ids, b.variant_id) <= 10 then 1 else 0 end);
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 2: % box(es) hold a quantity they were not sent', n; end if;

  ---------------------------------------------------------------------------
  -- 3. ⭐ 270 AGAINST A BILLED 250 IS REFUSED, AND NOTHING IS WRITTEN.
  --    The refusal is the easy half. The half that matters is that the
  --    warehouse holds exactly what it held before -- no nine boxes of a
  --    sixteen-box delivery, which is worse than a refusal because nothing
  --    anywhere records that it happened.
  ---------------------------------------------------------------------------
  select coalesce(sum(qty_on_hand), 0) into v_before
    from wholesale_v2.v2_inventory_balances b
   where b.location_id = v_loc and b.variant_id = any(v_ids);

  -- Exactly 270, so the refusal message can be asserted word for word:
  -- sixteen boxes of 17 is 272, and the last box holds 15 instead.
  v_lines := '[]'::jsonb;
  for i in 1..16 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'variant_id', v_ids[i], 'qty', case when i = 16 then 15 else 17 end));
  end loop;

  begin
    perform wholesale_v2.v2_receive_product(v_loc, v_lines, 250, null);
    FAIL := FAIL+1; raise warning 'FAIL 3: a 270-piece breakdown against a 250 invoice was ACCEPTED';
  exception when others then
    v_msg := SQLERRM;
    PASS := PASS+1;
  end;

  select coalesce(sum(qty_on_hand), 0) into v_after
    from wholesale_v2.v2_inventory_balances b
   where b.location_id = v_loc and b.variant_id = any(v_ids);
  if v_after = v_before then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 3b: a REFUSED receipt still moved stock: % before, % after', v_before, v_after; end if;

  ---------------------------------------------------------------------------
  -- 4. AND THE MESSAGE NAMES BOTH NUMBERS AND THE DIRECTION.
  --    "Counts do not match" sends somebody back to a grid of sixteen boxes
  --    with no idea which way to look. CNT-04, in the database.
  ---------------------------------------------------------------------------
  if v_msg like '%270%' and v_msg like '%250%' and v_msg like '%20 too many%'
    then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4: the refusal did not name both numbers and the direction: %', v_msg; end if;

  ---------------------------------------------------------------------------
  -- 5. A SHORT count is refused too, and says so the other way round.
  --    A gate that only catches the overs teaches people to under-enter.
  ---------------------------------------------------------------------------
  v_lines := jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 230));
  begin
    perform wholesale_v2.v2_receive_product(v_loc, v_lines, 250, null);
    FAIL := FAIL+1; raise warning 'FAIL 5: a 230-piece breakdown against a 250 invoice was ACCEPTED';
  exception when others then
    v_msg := SQLERRM;
    if v_msg like '%20 still to enter%' then PASS := PASS+1; else FAIL := FAIL+1;
      raise warning 'FAIL 5: refused, but did not say "20 still to enter": %', v_msg; end if;
  end;

  ---------------------------------------------------------------------------
  -- 6. THE TENANT BOUNDARY. A variant belonging to another wholesaler cannot
  --    ride along inside an otherwise valid delivery.
  ---------------------------------------------------------------------------
  v_lines := jsonb_build_array(
    jsonb_build_object('variant_id', v_ids[1], 'qty', 5),
    jsonb_build_object('variant_id', v_vOther,  'qty', 5));
  begin
    perform wholesale_v2.v2_receive_product(v_loc, v_lines, 10, null);
    FAIL := FAIL+1; raise warning 'FAIL 6: a rival wholesaler''s SKU was received into this warehouse';
  exception when others then PASS := PASS+1;
  end;

  ---------------------------------------------------------------------------
  -- 7. AND THE WAREHOUSE ITSELF. Signed in as the rival, this warehouse is
  --    not theirs -- even though every SKU named is real.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', uThem)::text, true);
  v_lines := jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 5));
  begin
    perform wholesale_v2.v2_receive_product(v_loc, v_lines, 5, null);
    FAIL := FAIL+1; raise warning 'FAIL 7: a rival received stock into somebody else''s warehouse';
  exception when others then PASS := PASS+1;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', uMe)::text, true);

  ---------------------------------------------------------------------------
  -- 8. An ARCHIVED warehouse is not a warehouse.
  ---------------------------------------------------------------------------
  begin
    perform wholesale_v2.v2_receive_product(v_locArch,
      jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 5)), 5, null);
    FAIL := FAIL+1; raise warning 'FAIL 8: stock was received into an archived warehouse';
  exception when others then PASS := PASS+1;
  end;

  ---------------------------------------------------------------------------
  -- 9. THE SAME SIZE TWICE. Two lines for one SKU can add up to the invoice
  --    while meaning something nobody can read back off the grid.
  ---------------------------------------------------------------------------
  begin
    perform wholesale_v2.v2_receive_product(v_loc, jsonb_build_array(
      jsonb_build_object('variant_id', v_ids[1], 'qty', 5),
      jsonb_build_object('variant_id', v_ids[1], 'qty', 5)), 10, null);
    FAIL := FAIL+1; raise warning 'FAIL 9: the same SKU was accepted on two lines';
  exception when others then PASS := PASS+1;
  end;

  ---------------------------------------------------------------------------
  -- 10-12. The shapes that must never get through: a zero line, an empty
  --        delivery, and no invoice figure at all.
  ---------------------------------------------------------------------------
  begin
    perform wholesale_v2.v2_receive_product(v_loc,
      jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 0)), 0, null);
    FAIL := FAIL+1; raise warning 'FAIL 10: a zero-quantity line was accepted';
  exception when others then PASS := PASS+1;
  end;

  begin
    perform wholesale_v2.v2_receive_product(v_loc, '[]'::jsonb, 10, null);
    FAIL := FAIL+1; raise warning 'FAIL 11: an empty delivery was accepted';
  exception when others then PASS := PASS+1;
  end;

  begin
    perform wholesale_v2.v2_receive_product(v_loc,
      jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 5)), 0, null);
    FAIL := FAIL+1; raise warning 'FAIL 12: a receipt with no invoice figure was accepted';
  exception when others then PASS := PASS+1;
  end;

  ---------------------------------------------------------------------------
  -- 13. CALLABLE TWICE IN ONE TRANSACTION. Migration 077's lesson: an
  --     "on commit drop" temp table is still standing on the second call, and
  --     a function that cannot be called twice cannot be tested at all. This
  --     file has already called it many times above; this asserts the SECOND
  --     real receipt lands on top of the first rather than replacing it.
  ---------------------------------------------------------------------------
  perform wholesale_v2.v2_receive_product(v_loc,
    jsonb_build_array(jsonb_build_object('variant_id', v_ids[1], 'qty', 4)), 4, null);
  select qty_on_hand into v_after
    from wholesale_v2.v2_inventory_balances
   where location_id = v_loc and variant_id = v_ids[1];
  if v_after = 20 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 13: 16 then 4 on the same box gave % on hand, expected 20', v_after; end if;

  ---------------------------------------------------------------------------
  -- 14. THE LEDGER. One movement per line, typed 'product_receive' so a
  --     counted delivery can be told from a one-off correction without
  --     reading the note and guessing.
  ---------------------------------------------------------------------------
  select count(*) into n
    from wholesale_v2.v2_inventory_movements m
   where m.location_id = v_loc and m.reference_type = 'product_receive';
  if n = 17 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 14: % movements typed product_receive, expected 17 (16 + 1)', n; end if;

  ---------------------------------------------------------------------------
  -- 15. NOT GRANTED TO anon. v2_receive_stock IS -- SECURITY DEFINER, no
  --     tenant check, callable by anybody holding the key that ships in the
  --     bundle. That hole is recorded in GATE-EVIDENCE and deliberately not
  --     changed unattended; this asserts the NEW door does not copy it.
  ---------------------------------------------------------------------------
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_receive_product'
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15: v2_receive_product is callable by anon'; end if;

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_receive_product'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15b: a signed-in wholesaler cannot call v2_receive_product'; end if;

  ---------------------------------------------------------------------------
  -- 16. EXACTLY ONE OVERLOAD. Migration 113 added a defaulted argument to
  --     v2_marketplace_feed, PostgREST refused BOTH signatures with PGRST203,
  --     and the live feed broke until 114 dropped the old one.
  ---------------------------------------------------------------------------
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_receive_product';
  if n = 1 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 16: % overloads of v2_receive_product', n; end if;

  ---------------------------------------------------------------------------
  -- 17. NO OVERRIDE ARGUMENT. CNT-10 -- accepting a short delivery with a
  --     typed reason, written to the audit log -- is a separate feature and a
  --     separate decision. An override parameter added "for later" is an
  --     override somebody uses today, and then the count check is advisory.
  ---------------------------------------------------------------------------
  select count(*) into n
    from information_schema.parameters
   where specific_schema = 'wholesale_v2'
     and specific_name like 'v2_receive_product%'
     and (parameter_name ilike '%override%' or parameter_name ilike '%force%'
       or parameter_name ilike '%skip%'     or parameter_name ilike '%ignore%');
  if n = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 17: v2_receive_product has grown an override argument — the count check is now advisory'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_receive_count: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_receive_count FAILED (% of % assertions)', FAIL, PASS+FAIL;
  end if;
end;
$check$;

rollback;
