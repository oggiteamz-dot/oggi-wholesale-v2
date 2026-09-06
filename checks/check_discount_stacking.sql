-- =============================================================================
-- CHECK: the discount stack, measured on the INVOICE (MOD-06)
-- =============================================================================
-- Transaction + ROLLBACK. Builds its own fixture; touches no live data.
--   psql "$DATABASE_URL" -f checks/check_discount_stacking.sql
--
-- WHAT THIS IS FOR
-- The build plan states MOD-06 as: "Prove a store at 10% + a customer at 5%
-- still invoices correctly." The word that does the work is INVOICES.
--
-- check_store_pricing_dial.sql already proves that v2_store_discount_pct
-- RETURNS 15 for that case. That is a number coming out of a function. It is
-- not money. Nothing in the repo, before this file, asserted what a buyer is
-- actually CHARGED once two discounts are in play -- and the gap between
-- "the function returns 15" and "the invoice line reads 85.00" is exactly
-- where a pricing bug lives for months without anything turning red.
--
-- So every assertion below is a number written onto v2_order_items by
-- v2_submit_order, or a number v2_effective_unit_price would put there.
--
-- THE ONE THAT PAYS FOR THE FILE IS ASSERTION 2.
-- Two discounts can stack two ways:
--     ADDITIVE      100 x (1 - (10+5)/100)      = 85.00
--     COMPOUNDING   100 x (1 - .10) x (1 - .05) = 85.50
-- The server is additive. Nobody would ever notice fifty cents on a hundred,
-- and nobody would ever find it afterwards either -- it is not a crash, it is
-- not a wrong screen, it is a slightly wrong bill. Assertion 1 alone would
-- pass under either rule if the fixture happened to be built the other way
-- round, so the rule is pinned from BOTH sides: 85.00 is required AND 85.50
-- is forbidden, by name.
--
-- ASSERTION 15 IS AN OPEN QUESTION, NOT A BUG REPORT.
-- It records that the same buyer, on the same day, is charged two different
-- prices for the same shirt depending on which door they came through. That
-- is true of production today and is the decision MOD-06 puts to Hadi.
-- Whoever closes it must INVERT that row rather than delete it, the way
-- MOD-07 inverted the tier rows -- so that the day the two doors agree, this
-- file says so out loud instead of going quiet.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  PASS int := 0; FAIL int := 0;
  w         text := 'zz_m06';
  v_loc     uuid;
  v_prod    uuid;
  v100      uuid;   -- lists at 100.00
  v099      uuid;   -- lists at 0.99, for the rounding case
  cliFive   uuid;   -- customer on 5%
  cliZero   uuid;   -- customer on 0%
  cliOvr    uuid;   -- customer on 5% WITH a negotiated override
  cDefault  uuid;   -- the shelf v2_wholesalers' own trigger creates for us
  cCombine  uuid := '00000000-0000-4000-8000-00000006a002';
  cCatOnly  uuid := '00000000-0000-4000-8000-00000006a003';
  cCustOnly uuid := '00000000-0000-4000-8000-00000006a004';
  cMarkup   uuid := '00000000-0000-4000-8000-00000006a005';
  cDeep     uuid := '00000000-0000-4000-8000-00000006a006';
  o         v2_orders;
  n         numeric;
  m         int;

begin
  ------------------------------------------------------------------- fixture
  insert into public.wholesalers        (wid, name) values (w, 'MOD06 Co') on conflict (wid) do nothing;
  insert into wholesale_v2.v2_wholesalers (wid, name) values (w, 'MOD06 Co') on conflict (wid) do nothing;
  -- Order minimums off: this file is about price, and a minimum that refuses
  -- the order would make every assertion below fail for the wrong reason.
  update wholesale_v2.v2_wholesalers
     set order_min_qty = null, order_min_value = null, discount_pct = 0, discount_mode = 'combine'
   where wid = w;

  insert into wholesale_v2.v2_locations (wid, name, is_default) values (w, 'MOD06 store', true)
    returning id into v_loc;

  insert into wholesale_v2.v2_clients (wid, shop_name, access_tier, discount_pct)
       values (w, 'Five Percent', 1, 5.00)  returning id into cliFive;
  insert into wholesale_v2.v2_clients (wid, shop_name, access_tier, discount_pct)
       values (w, 'Zero Percent', 1, 0.00)  returning id into cliZero;
  insert into wholesale_v2.v2_clients (wid, shop_name, access_tier, discount_pct)
       values (w, 'Has Override', 1, 5.00)  returning id into cliOvr;

  -- Every mode the schema allows, each on its own shelf, so one order can be
  -- routed through exactly one rule at a time.
  -- The DEFAULT shelf is not created here. Inserting a wholesaler already
  -- creates one (v2_catalogs_one_default enforces exactly one per wid), and a
  -- fixture that made its own would be testing a shape the product cannot
  -- reach. It is found and set to 0%/combine, which is what every default
  -- shelf on production carries.
  select c.id into cDefault from wholesale_v2.v2_catalogs c where c.wid = w and c.is_default;
  if cDefault is null then
    raise exception 'SETUP: no default catalogue was created for %', w;
  end if;
  update wholesale_v2.v2_catalogs
     set discount_pct = 0.00, discount_mode = 'combine', active = true
   where id = cDefault;

  insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_default, discount_pct, discount_mode)
  values (cCombine,  w, 'MOD06 Combine 10',   1, true, false,  10.00, 'combine'),
         (cCatOnly,  w, 'MOD06 CatOnly 10',   1, true, false,  10.00, 'catalog_only'),
         (cCustOnly, w, 'MOD06 CustOnly 10',  1, true, false,  10.00, 'customer_only'),
         (cMarkup,   w, 'MOD06 Markup -10',   1, true, false, -10.00, 'combine'),
         (cDeep,     w, 'MOD06 Deep 100',     1, true, false, 100.00, 'combine');

  insert into wholesale_v2.v2_products (id, wid, name, selling_model, moq_qty)
       values (gen_random_uuid(), w, 'MOD06 Poplin Shirt', 'open', 1)
    returning id into v_prod;

  insert into wholesale_v2.v2_product_variants (product_id, sku, price, moq_qty, extra_attrs)
       values (v_prod, 'M06-100', 100.00, 1, jsonb_build_object('color','White','size','M'))
    returning id into v100;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price, moq_qty, extra_attrs)
       values (v_prod, 'M06-099', 0.99, 1, jsonb_build_object('color','White','size','S'))
    returning id into v099;

  insert into wholesale_v2.v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved)
       values (v100, v_loc, 10000, 0), (v099, v_loc, 10000, 0);

  -- A quantity break, so assertion 10 can prove the ORDER of operations.
  insert into wholesale_v2.v2_pricing_tiers (product_id, min_qty, unit_price)
       values (v_prod, 12, 80.00);

  -- A negotiated price for one customer, deliberately NOT a round number and
  -- deliberately not derivable from any discount in this file -- so if it ever
  -- appears with a percentage applied on top, the number says which.
  insert into wholesale_v2.v2_client_price_overrides (client_id, variant_id, override_price)
       values (cliOvr, v100, 71.00);

  insert into wholesale_v2.v2_catalog_products (catalog_id, product_id, sort_order)
  values (cDefault, v_prod, 10), (cCombine, v_prod, 10), (cCatOnly, v_prod, 10),
         (cCustOnly, v_prod, 10), (cMarkup, v_prod, 10), (cDeep, v_prod, 10);

  ---------------------------------------------------------------------------
  -- 1. THE MOD-06 CASE. A 10% shelf and a 5% customer, on the invoice.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 85.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1: 10%% shelf + 5%% customer invoiced % per unit, expected 85.00', n; end if;

  ---------------------------------------------------------------------------
  -- 2. AND IT IS NOT COMPOUNDED. 100 x .90 x .95 = 85.50. The rule is
  --    additive on the percentages, and this is the row that says so.
  ---------------------------------------------------------------------------
  if n <> 85.50 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 2: the server COMPOUNDED the two discounts (85.50). Every stacked invoice on the platform is now wrong by the product of the two rates.'; end if;

  ---------------------------------------------------------------------------
  -- 3. combine with a customer on zero is the shelf rate alone.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliZero, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 3: 10%% shelf + 0%% customer invoiced %, expected 90.00', n; end if;

  ---------------------------------------------------------------------------
  -- 4. catalog_only IGNORES the customer -- on the invoice, not just in the
  --    percentage function. A customer who negotiated 5% and is put on a
  --    catalog_only shelf gets nothing for it, and that is the intended rule.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCatOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4: catalog_only invoiced % for a 5%% customer, expected 90.00 (the customer must be ignored)', n; end if;

  ---------------------------------------------------------------------------
  -- 5. customer_only: the customer's own rate replaces the shelf's.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCustOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 95.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 5: customer_only invoiced %, expected 95.00', n; end if;

  ---------------------------------------------------------------------------
  -- 6. THE QUIRK, PRICED. A customer_only shelf with a customer on 0% falls
  --    back to the SHELF rate rather than charging list. check_store_pricing_
  --    dial asserts this as a percentage; here it is 90.00 on a bill. If
  --    anyone ever "simplifies" the fallback away, every such client is
  --    silently moved to full price and this row is what says so.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliZero, null, cCustOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 6: customer_only + 0%% customer invoiced %, expected the 90.00 shelf fallback', n; end if;

  ---------------------------------------------------------------------------
  -- 7. A NEGATIVE dial sells ABOVE list, and a customer discount only
  --    partly offsets it: -10 + 5 = -5, so 100.00 is billed at 105.00.
  --    A markup is real pricing and must survive stacking intact.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cMarkup, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 105.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 7: a -10%% shelf with a 5%% customer invoiced %, expected 105.00', n; end if;

  ---------------------------------------------------------------------------
  -- 8. A stack over 100% floors at ZERO. It must never go negative: a
  --    negative unit price is a credit note wearing an invoice's clothes,
  --    and it would flow into subtotal, into the picking sheet, and into
  --    whatever accounting this ever exports to.
  --
  --    100% is the deepest a SHELF may go -- v2_catalogs_discount_range bounds
  --    it to -100..100 -- so the overshoot has to come from the customer's
  --    own rate, which is bounded by nothing at all (see 17). 100 + 5 = 105.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cDeep, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 0.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8: a 105%% stack invoiced %, expected 0.00', n; end if;
  if n >= 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8b: a NEGATIVE unit price (%) reached an invoice line', n; end if;

  ---------------------------------------------------------------------------
  -- 9. A NEGOTIATED PRICE WINS OUTRIGHT. The override is an absolute number,
  --    not a starting point: the 10% shelf and the 5% customer rate are both
  --    discarded. 71.00 -- not 85.00 (as if the override were ignored), and
  --    not 60.35 (as if 15% came off it as well). Both wrong answers are
  --    named, because "it returned a plausible number" is how this one hides.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliOvr, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 71.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 9: a negotiated price of 71.00 invoiced at %', n; end if;
  if n <> 60.35 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 9b: the discount stack was applied ON TOP of a negotiated price. Every customer with an override is now being given their discount twice.'; end if;

  ---------------------------------------------------------------------------
  -- 10. THE ORDER OF OPERATIONS. A quantity break is chosen FIRST and the
  --     discount comes off the BROKEN price, not off list. 12 crosses the
  --     break to 80.00, then 15% off = 68.00 each = 816.00.
  --     Discount-then-break would give 12 x 80.00 = 960.00; break-then-list
  --     would give 12 x 85.00 = 1020.00. Neither is 816.00.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 12, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 12)), cliFive, null, cCombine, null);
  if o.subtotal = 816.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 10: 12 across a break at 80.00 with 15%% off billed %, expected 816.00', o.subtotal; end if;

  ---------------------------------------------------------------------------
  -- 11. ROUNDING HAPPENS PER UNIT, THEN MULTIPLIES. 0.99 less 15% is 0.8415;
  --     the unit is rounded to 0.84 and seven of them are 5.88. Rounding the
  --     LINE instead would give 5.89. One penny, on every line, forever --
  --     and the buyer's screen shows a unit price, so the unit is what has
  --     to be the rounded number or the arithmetic on screen stops adding up.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v099, v_loc, 7, gen_random_uuid(), null, 15)).id,
         'variant_id', v099, 'qty', 7)), cliFive, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 0.84 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 11: 0.99 less 15%% invoiced at % per unit, expected 0.84', n; end if;
  if o.subtotal = 5.88 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 11b: seven at 0.84 came to %, expected 5.88 (5.89 means the LINE was rounded, not the unit)', o.subtotal; end if;

  ---------------------------------------------------------------------------
  -- 12. On every line this file wrote: line_total = qty x unit_price.
  ---------------------------------------------------------------------------
  select count(*) into m
    from v2_order_items oi join v2_orders ord on ord.id = oi.order_id
   where ord.wid = w and oi.line_total <> round(oi.qty * oi.unit_price, 2);
  if m = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 12: % line(s) where line_total is not qty x unit_price', m; end if;

  ---------------------------------------------------------------------------
  -- 13. And every order's subtotal is the sum of its own lines.
  ---------------------------------------------------------------------------
  select count(*) into m from v2_orders ord
   where ord.wid = w
     and ord.subtotal is distinct from
         (select coalesce(sum(oi.line_total),0) from v2_order_items oi where oi.order_id = ord.id);
  if m = 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 13: % order(s) whose subtotal is not the sum of their lines', m; end if;

  ---------------------------------------------------------------------------
  -- 14. THE MOD-05 BRIDGE, IN MONEY. The store dial and the default shelf
  --     must price identically, for a customer WITH a discount -- otherwise
  --     switching v2_effective_unit_price over to the store dial (which is
  --     what MOD-05 built and has deliberately left inert) would move a bill.
  --     Asserted here as two prices, not two percentages.
  ---------------------------------------------------------------------------
  if round(100.00 * (1 - v2_store_discount_pct(w, cliFive)   / 100.0), 2)
   = round(100.00 * (1 - v2_catalog_discount_pct(cDefault, cliFive) / 100.0), 2)
  then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 14: the store dial and the default shelf price a 100.00 shirt differently for the same customer -- the MOD-05 switch-over would move money'; end if;

  ---------------------------------------------------------------------------
  -- 15. ⚠ THE TWO DOORS. TODAY'S TRUTH, AND THE OPEN QUESTION.
  --     The same customer, the same shirt, the same afternoon:
  --       through the store screen (the DEFAULT shelf)  ->  95.00
  --       through the share link for the 10% shelf      ->  85.00
  --     Since MOD-04 the buyer SEES the whole store but is PRICED through
  --     one shelf, so a product that the wholesaler put on a 10% shelf is
  --     billed at the default shelf's rate when reached from the store
  --     screen. Nothing on screen is wrong -- the screen and the invoice
  --     agree with each other. What disagrees is the two doors.
  --
  --     This is not asserted because it is right. It is asserted because it
  --     is TRUE, it is money, and it must not change without somebody
  --     deciding that it should. When that decision is made, INVERT this
  --     row -- do not delete it.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cDefault, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 95.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15: the same shirt through the default shelf invoiced %, expected 95.00', n; end if;
  if n <> 85.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15b: the two doors now AGREE at 85.00. That is very likely the fix -- but it is a price change, so invert rows 15 and 15b and record the decision in GATE-EVIDENCE.'; end if;

  ---------------------------------------------------------------------------
  -- 16. A SHELF CANNOT BE SET PAST 100%. The floor in assertion 8 is the last
  --     line of defence; this is the first one, and it is the one that stops
  --     a typo ever becoming an invoice.
  ---------------------------------------------------------------------------
  begin
    update wholesale_v2.v2_catalogs set discount_pct = 500 where id = cCombine;
    FAIL := FAIL+1;
    raise warning 'FAIL 16: a catalogue accepted a 500%% discount';
  exception when check_violation then PASS := PASS+1;
  end;

  ---------------------------------------------------------------------------
  -- 17. ⚠ THE STORE DIAL HAS NO SUCH BOUND. TODAY'S TRUTH.
  --     v2_catalogs.discount_pct is checked into -100..100. The dial migration
  --     117 added to v2_wholesalers constrains only discount_mode -- the
  --     PERCENTAGE is unbounded, so a store can be set to 500% or -5000%.
  --     Nothing reads it yet, which is why this has cost nothing so far. The
  --     moment MOD-05's switch-over happens it becomes the number that prices
  --     every order in the store, with a fat-fingered keypress and no check
  --     between it and the invoice.
  --
  --     Asserted as it stands, not as it should be. Adding the constraint is
  --     a one-line migration; when it lands, INVERT this row.
  ---------------------------------------------------------------------------
  begin
    update wholesale_v2.v2_wholesalers set discount_pct = 500 where wid = w;
    PASS := PASS+1;
  exception when check_violation then FAIL := FAIL+1;
    raise warning 'FAIL 17: the store dial is now BOUNDED. That is the right fix -- invert this row and say so in GATE-EVIDENCE.';
  end;
  update wholesale_v2.v2_wholesalers set discount_pct = 0 where wid = w;

  raise notice '----------------------------------------';
  raise notice 'check_discount_stacking: % passed, % failed', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_discount_stacking FAILED (% of % assertions)', FAIL, PASS+FAIL;
  end if;
end;
$check$;

rollback;
