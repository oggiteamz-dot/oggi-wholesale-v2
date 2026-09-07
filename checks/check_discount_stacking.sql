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
-- ↺ 7 Sep 2026 -- MIGRATION 122 MOVED THE STACK, AND THIS FILE MOVED WITH IT.
-- When MOD-06 wrote this file, "a store at 10%" was implemented as a SHELF at
-- 10%, and assertion 15 recorded the consequence as an open question: the same
-- buyer, the same shirt, the same afternoon, two different prices depending on
-- which link they opened. Hadi closed it -- "They should get the same price.
-- The share link just automatically grants them access to the wholesaler that
-- gave them that link." -- and migration 122 made v2_wholesalers.discount_pct
-- the only rate that reaches a price.
--
-- So the SUBJECT of this file is unchanged: a store rate stacking with a
-- customer rate, measured on an invoice. What changed is where the store rate
-- lives. Nearly every number below is therefore the SAME number as before,
-- reached through the dial instead of the shelf, and the shelves stay in the
-- fixture as DECOYS: every order is still routed through a shelf carrying its
-- own rate, and the assertion is that the rate does not reach the bill. An
-- order routed through the 10% shelf while the dial reads 10% must invoice
-- 85.00 and never 75.00, and that companion row is written out by name.
--
-- Assertion 15 is inverted rather than deleted, per the practice: it now
-- submits the SAME order through two different shelves and requires one
-- answer. Assertion 17 is inverted too -- migration 123 bounded the dial the
-- day after this file recorded that it was unbounded.
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
  -- THE DIAL IS THE SUBJECT (122). 10.00/combine is "a store at 10%", which is
  -- the sentence MOD-06 was written to prove. Individual assertions move it and
  -- put it back; each one says which value it needs and why.
  update wholesale_v2.v2_wholesalers
     set order_min_qty = null, order_min_value = null, discount_pct = 10.00, discount_mode = 'combine'
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
  -- 1. THE MOD-06 CASE. A store at 10% and a customer at 5%, on the invoice.
  --    Routed through the 10% COMBINE SHELF on purpose: since 122 that shelf's
  --    rate must reach nothing, so 85.00 is a claim about two things -- the
  --    dial arrived, and the shelf did not. 1b names the wrong answer.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 85.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1: a 10%% store dial + 5%% customer invoiced % per unit, expected 85.00', n; end if;
  if n <> 75.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 1b: 75.00 -- the SHELF''s 10%% was added to the dial''s 10%%. Migration 122 says a shelf carries no rate; the door is deciding the price again.'; end if;

  ---------------------------------------------------------------------------
  -- 2. AND IT IS NOT COMPOUNDED. 100 x .90 x .95 = 85.50. The rule is
  --    additive on the percentages, and this is the row that says so.
  ---------------------------------------------------------------------------
  if n <> 85.50 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 2: the server COMPOUNDED the two discounts (85.50). Every stacked invoice on the platform is now wrong by the product of the two rates.'; end if;

  ---------------------------------------------------------------------------
  -- 3. combine with a customer on zero is the STORE rate alone (122).
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliZero, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 3: a 10%% store dial + 0%% customer invoiced %, expected 90.00', n; end if;

  ---------------------------------------------------------------------------
  -- 4. catalog_only IGNORES the customer -- on the invoice, not just in the
  --    percentage function. A customer who negotiated 5% gets nothing for it,
  --    and that is the intended rule.
  --    ↺ SINCE 122 THE MODE IS THE STORE'S, not the shelf's, so the mode is set
  --    on the dial here. The order is still routed through the catalog_only
  --    SHELF, which now means nothing -- and that is the second half of the
  --    assertion, because if shelf modes still worked this row would pass for
  --    the old reason. Row 4b removes that escape: the store is put in
  --    'combine' while the shelf stays 'catalog_only', and the customer's 5%
  --    must come back.
  ---------------------------------------------------------------------------
  update wholesale_v2.v2_wholesalers set discount_mode = 'catalog_only' where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCatOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4: catalog_only invoiced % for a 5%% customer, expected 90.00 (the customer must be ignored)', n; end if;

  update wholesale_v2.v2_wholesalers set discount_mode = 'combine' where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCatOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 85.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 4b: the SHELF''s catalog_only mode is still being obeyed -- invoiced %, expected 85.00 now that the STORE is on combine (122)', n; end if;

  ---------------------------------------------------------------------------
  -- 5. customer_only: the customer's own rate replaces the STORE's (122).
  ---------------------------------------------------------------------------
  update wholesale_v2.v2_wholesalers set discount_mode = 'customer_only' where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCustOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 95.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 5: customer_only invoiced %, expected 95.00', n; end if;

  ---------------------------------------------------------------------------
  -- 6. THE QUIRK, PRICED. customer_only with a customer on 0% falls back to
  --    the STORE rate rather than charging list. check_store_pricing_
  --    dial asserts this as a percentage; here it is 90.00 on a bill. If
  --    anyone ever "simplifies" the fallback away, every such client is
  --    silently moved to full price and this row is what says so.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliZero, null, cCustOnly, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 90.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 6: customer_only + 0%% customer invoiced %, expected the 90.00 store fallback', n; end if;
  update wholesale_v2.v2_wholesalers set discount_mode = 'combine' where wid = w;

  ---------------------------------------------------------------------------
  -- 7. A NEGATIVE dial sells ABOVE list, and a customer discount only
  --    partly offsets it: -10 + 5 = -5, so 100.00 is billed at 105.00.
  --    A markup is real pricing and must survive stacking intact.
  --    ↺ The -10 is now on the DIAL. The order still goes through the -10%
  --    markup SHELF, so a shelf that had started pricing again would give
  --    -20 + 5 = 115.00 rather than 105.00.
  ---------------------------------------------------------------------------
  update wholesale_v2.v2_wholesalers set discount_pct = -10.00 where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cMarkup, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 105.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 7: a -10%% store dial with a 5%% customer invoiced %, expected 105.00 (115.00 means the shelf priced too)', n; end if;

  ---------------------------------------------------------------------------
  -- 8. A stack over 100% floors at ZERO. It must never go negative: a
  --    negative unit price is a credit note wearing an invoice's clothes,
  --    and it would flow into subtotal, into the picking sheet, and into
  --    whatever accounting this ever exports to.
  --
  --    100% is the deepest EITHER rate may go -- v2_catalogs_discount_range
  --    has always bounded the shelf, and migration 123 now bounds the dial and
  --    the customer rate to the same -100..100. The overshoot therefore has to
  --    come from the SUM, which 123 deliberately leaves unbounded and explains
  --    why in its header. 100 + 5 = 105, and this row is the reason that is
  --    survivable: the price floors at 0.00 instead of going negative.
  ---------------------------------------------------------------------------
  update wholesale_v2.v2_wholesalers set discount_pct = 100.00 where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cDeep, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 0.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8: a 105%% stack invoiced %, expected 0.00', n; end if;
  if n >= 0 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 8b: a NEGATIVE unit price (%) reached an invoice line', n; end if;
  update wholesale_v2.v2_wholesalers set discount_pct = 10.00 where wid = w;

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
  -- 14. ↺ THE MOD-05 BRIDGE HAS BEEN CROSSED. This row used to require that
  --     the dial and the default shelf agreed, because the switch-over had not
  --     happened and a difference would have meant it moved money. 122 made
  --     the crossing, so the assertion turns around: what must now be true is
  --     that the INVOICE follows the dial, and the row is written as the dial's
  --     price against the bill rather than against the shelf.
  --
  --     The dial is moved to a number no shelf in this fixture carries (25%),
  --     so the answer cannot be produced by any shelf: 100.00 less 25+5 = 70.00.
  ---------------------------------------------------------------------------
  update wholesale_v2.v2_wholesalers set discount_pct = 25.00 where wid = w;
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cCombine, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 70.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 14: the dial was moved to 25%% and a 5%% customer was invoiced %, expected 70.00 -- the invoice is not following the dial', n; end if;
  if round(100.00 * (1 - v2_store_discount_pct(w, cliFive) / 100.0), 2) = n
  then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 14b: the percentage function and the invoice disagree -- the cart will not match the bill'; end if;
  update wholesale_v2.v2_wholesalers set discount_pct = 10.00 where wid = w;

  ---------------------------------------------------------------------------
  -- 15. ↺ THE TWO DOORS, INVERTED (122). This row used to record the defect:
  --     the same customer, the same shirt, the same afternoon, 95.00 through
  --     the store screen and 85.00 through a share link, because the buyer saw
  --     the whole store but was PRICED through whichever shelf they arrived on.
  --     326 (account, variant) pairs on production disagreed that way.
  --
  --     Hadi: "They should get the same price. The share link just
  --     automatically grants them access to the wholesaler that gave them that
  --     link." Migration 122 did it, and the row is turned around rather than
  --     deleted: the SAME order is now submitted through both doors and the two
  --     answers must be equal. 85.00 -- the dial's 10 plus the customer's 5 --
  --     is what BOTH now read, and 95.00 (the old store-screen answer) is
  --     forbidden by name, so reinstating the shelf turns this red from either
  --     direction.
  ---------------------------------------------------------------------------
  o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
         'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
         'variant_id', v100, 'qty', 1)), cliFive, null, cDefault, null);
  select unit_price into n from v2_order_items where order_id = o.id;
  if n = 85.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15: the store screen (default shelf) invoiced %, expected the store dial''s 85.00', n; end if;
  if n <> 95.00 then PASS := PASS+1; else FAIL := FAIL+1;
    raise warning 'FAIL 15b: 95.00 -- the default shelf is pricing again and the two doors have gone back to disagreeing. This is the defect migration 122 closed.'; end if;

  -- 15c. And the comparison itself, so the pair stays honest on a day somebody
  --      changes the fixture's numbers: one order through the DEFAULT shelf and
  --      one through the DEEPEST shelf in the fixture, and the two unit prices
  --      must be the same number.
  declare n2 numeric;
  begin
    o := v2_submit_order(w, 'm06', v_loc, jsonb_build_array(jsonb_build_object(
           'reservation_id', (v2_reserve_stock(v100, v_loc, 1, gen_random_uuid(), null, 15)).id,
           'variant_id', v100, 'qty', 1)), cliFive, null, cDeep, null);
    select unit_price into n2 from v2_order_items where order_id = o.id;
    if n2 = n then PASS := PASS+1; else FAIL := FAIL+1;
      raise warning 'FAIL 15c: the same buyer, the same shirt -- % through the default shelf and % through the 100%% shelf. The door still decides the price.', n, n2; end if;
  end;

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
  -- 17. ↺ THE STORE DIAL IS NOW BOUNDED TOO (123). This row used to assert the
  --     opposite: v2_catalogs.discount_pct was checked into -100..100 while the
  --     dial migration 117 added to v2_wholesalers constrained only
  --     discount_mode, leaving the PERCENTAGE open to 500% or -5000%. That cost
  --     nothing while nothing read it -- and 122 made it the number that prices
  --     every order in the store, one keypress from every invoice. Migration
  --     123 gave it the shelf's own range, on the reasoning that the dial IS
  --     the shelf's replacement and a different range would be the fix creating
  --     the hole.
  ---------------------------------------------------------------------------
  begin
    update wholesale_v2.v2_wholesalers set discount_pct = 500 where wid = w;
    FAIL := FAIL+1;
    raise warning 'FAIL 17: the store dial accepted 500%%. Since 122 that number prices every order in the store.';
  exception when check_violation then PASS := PASS+1;
  end;

  -- 17b. and the same at the other end, because a markup is the direction
  --      nobody tests: -5000% would bill 51x list.
  begin
    update wholesale_v2.v2_wholesalers set discount_pct = -5000 where wid = w;
    FAIL := FAIL+1;
    raise warning 'FAIL 17b: the store dial accepted -5000%%, which bills fifty-one times list price.';
  exception when check_violation then PASS := PASS+1;
  end;

  -- 17c. and the CUSTOMER's rate, the other half of the sum, which had never
  --      been checked at all and is bounded by the same migration.
  begin
    update wholesale_v2.v2_clients set discount_pct = 500 where id = cliFive;
    FAIL := FAIL+1;
    raise warning 'FAIL 17c: a customer rate accepted 500%%.';
  exception when check_violation then PASS := PASS+1;
  end;

  -- 17d. ⚠ WHAT 123 DELIBERATELY DID NOT BOUND, asserted as today's truth so
  --      that the day somebody decides otherwise, this row tells them the
  --      decision was made on purpose and where it is written down. In
  --      'combine' mode the total is store + customer, so 100 + 100 = 200 is
  --      reachable with both halves legal. Migration 123's header explains why
  --      a sum constraint would be a worse screen than an over-generous total,
  --      and assertion 8 is why it is survivable: the PRICE floors at 0.00.
  --      If this row ever goes red, the sum was bounded -- invert it, do not
  --      delete it.
  ---------------------------------------------------------------------------
  begin
    update wholesale_v2.v2_wholesalers set discount_pct = 100 where wid = w;
    update wholesale_v2.v2_clients     set discount_pct = 100 where id = cliFive;
    if v2_store_discount_pct(w, cliFive) = 200 then PASS := PASS+1; else FAIL := FAIL+1;
      raise warning 'FAIL 17d: two legal halves summed to % rather than 200 -- the arithmetic changed', v2_store_discount_pct(w, cliFive); end if;
  exception when check_violation then FAIL := FAIL+1;
    raise warning 'FAIL 17d: the SUM of the two rates is now bounded. That may well be right -- invert this row and say so in GATE-EVIDENCE, and read migration 123''s header first.';
  end;
  update wholesale_v2.v2_clients set discount_pct = 5.00 where id = cliFive;
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
