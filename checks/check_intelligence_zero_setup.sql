-- ============================================================================
-- check_intelligence_zero_setup.sql — Batch 1 gate (migrations 066/067/068)
--
-- THE BUG THIS ENFORCES AGAINST, measured on production 20 Aug 2026:
--   191 active variants. ZERO with a reorder_point set.
--   js/data/inventory-intelligence.js:59 filtered on
--       v.reorderPoint != null && v.available <= v.reorderPoint
--   so getReorderSuggestions() returned an empty list for the ENTIRE
--   platform. A wholesaler who imports a catalogue and never opens
--   Pricing & MOQ saw a screen called "Inventory Intelligence" that read as
--   working and did nothing — while a SKU sat at 9.25 days of cover.
--
--   Worse than an empty state. An empty state admits it has nothing to say;
--   this implied it had looked and found no problems. Same defect class as
--   the reservation leak and as discount_pct sitting dead for two months:
--   working software quietly producing a wrong answer.
--
-- THE RULE:
--   A wholesaler with real order history and ZERO per-SKU configuration must
--   get a real, correct reorder signal. Configuration may TUNE a signal. It
--   may never be required to CREATE one.
--
-- AND FOUR HONESTY RULES, which matter as much as the signal:
--   * Cancelled orders are not demand.
--   * A never-sold variant gets no fabricated reorder point.
--   * "Never stocked" is not "sold out".            (067)
--   * "Nothing to compare against" is not "nothing stood out".  (068)
--
-- RED-PROVEN. Each assertion below was watched to fail before the migration
-- that fixes it, on production data, in a rolled-back transaction:
--   * 2-7  failed against pre-066 with: function v2_inventory_signals_for(text)
--          does not exist  (ASSERT 1 passing at the time, which is what proved
--          the inertness was real and not remembered)
--   * 8    failed against 066 with: never-stocked variant reports "out"
--   * 9    failed against 067 with: sibling_count column did not exist
--
-- Run:  psql <conn> -f checks/check_intelligence_zero_setup.sql
-- Everything runs inside a transaction that is rolled back. This file writes
-- zero rows to production; it ends by raising deliberately to force the
-- rollback while still printing its report.
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid    text := 'zzgate-b1';
  v_loc    uuid; v_prod uuid; v_prod2 uuid;
  v_red    uuid;  -- fast mover, nearly out          -> must fire, must break out
  v_blue   uuid;  -- slow mover, healthy             -> must stay quiet
  v_green  uuid;  -- slow mover, healthy             -> must NOT be a breakout
  v_black  uuid;  -- never sold, has stock           -> no_data, no invented point
  v_never  uuid;  -- never received at all           -> not_tracked, NOT "out"
  v_soldout uuid; -- was stocked, now zero           -> genuinely "out"
  v_ord    uuid;
  v_old    int; v_n int; v_rec record; v_r2 record;
  v_report text := '';
begin
  -- ------------------------------------------------------------- fixture
  -- A wholesaler whose catalogue was imported and never configured.
  -- NOTE: v2_wholesalers.wid carries an FK to public.wholesalers — a
  -- cross-schema coupling to v1 that is not documented anywhere else.
  insert into public.wholesalers (wid) values (v_wid);
  insert into v2_wholesalers (wid, name) values (v_wid, 'Gate B1 Co.');
  insert into v2_locations (wid, name) values (v_wid, 'Main') returning id into v_loc;
  insert into v2_products (wid, name) values (v_wid, 'Gate Tee') returning id into v_prod;

  -- Four colourways of the SAME product in the SAME size, so the
  -- sibling-colour comparison has something real to compare against.
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod,'GATE-RED-M','{"color":"Red","size":"M"}'::jsonb)   returning id into v_red;
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod,'GATE-BLUE-M','{"color":"Blue","size":"M"}'::jsonb) returning id into v_blue;
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod,'GATE-GREEN-M','{"color":"Green","size":"M"}'::jsonb) returning id into v_green;
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod,'GATE-BLACK-M','{"color":"Black","size":"M"}'::jsonb) returning id into v_black;

  -- reorder_point is deliberately NULL on all four. That is the point.

  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved)
    values (v_red,v_loc,5,0),(v_blue,v_loc,300,0),(v_green,v_loc,300,0),(v_black,v_loc,300,0);

  -- A second product for the never-stocked vs sold-out distinction.
  insert into v2_products (wid, name) values (v_wid, 'Gate Tee 2') returning id into v_prod2;
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod2,'NEVER-M','{"color":"Ivory","size":"M"}'::jsonb)  returning id into v_never;
  insert into v2_product_variants (product_id, sku, extra_attrs)
    values (v_prod2,'SOLDOUT-M','{"color":"Onyx","size":"M"}'::jsonb) returning id into v_soldout;
  -- v_never gets NO balance row at all. v_soldout gets one that reads zero.
  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved)
    values (v_soldout, v_loc, 0, 0);

  -- 30 days of history. Red ~4/day; Blue and Green ~0.1/day.
  for v_n in 1..30 loop
    insert into v2_orders (wid,buyer_label,location_id,status,created_at)
      values (v_wid,'Gate Buyer',v_loc,'delivered', now()-(v_n||' days')::interval)
      returning id into v_ord;
    insert into v2_order_items (order_id,variant_id,qty,unit_price) values (v_ord,v_red,4,10);
    if v_n % 10 = 0 then
      insert into v2_order_items (order_id,variant_id,qty,unit_price) values (v_ord,v_blue,1,10);
      insert into v2_order_items (order_id,variant_id,qty,unit_price) values (v_ord,v_green,1,10);
    end if;
  end loop;

  -- A CANCELLED order with a huge quantity. Not demand. If it leaks in,
  -- Blue looks like a fast mover and the wholesaler buys stock they do not
  -- need — the tool actively costs them money.
  insert into v2_orders (wid,buyer_label,location_id,status,created_at)
    values (v_wid,'Gate Buyer',v_loc,'cancelled', now()-interval '3 days') returning id into v_ord;
  insert into v2_order_items (order_id,variant_id,qty,unit_price) values (v_ord,v_blue,900,10);

  -- ---------------------------------------------------------- ASSERT 1
  -- Documents the bug itself. Under the OLD rule this wholesaler gets
  -- nothing, though Red has 5 units against ~1.3/day of demand.
  select count(*) into v_old
    from v2_product_variants v join v2_products p on p.id=v.product_id
   where p.wid=v_wid and v.reorder_point is not null
     and (select coalesce(sum(b.qty_available),0) from v2_inventory_balances_live b
           where b.variant_id=v.id) <= v.reorder_point;
  if v_old <> 0 then
    raise exception 'ASSERT 1 FAILED: expected the old reorder rule to be inert on an unconfigured catalogue, got % suggestions', v_old;
  end if;
  v_report := v_report || E'\n  1  ok   old rule inert (0 suggestions) on real demand — the bug, reproduced';

  -- ---------------------------------------------------------- ASSERT 2
  -- THE ONE THAT MATTERS. Zero configuration, real history, real signal.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_red;
  if v_rec.variant_id is null then
    raise exception 'ASSERT 2 FAILED: no signal row at all for a fast-moving, nearly-out variant';
  end if;
  if coalesce(v_rec.velocity_per_day,0) <= 0 then
    raise exception 'ASSERT 2 FAILED: velocity computed as % for a variant that sold 120 units', v_rec.velocity_per_day;
  end if;
  if v_rec.status not in ('reorder','out','low') then
    raise exception 'ASSERT 2 FAILED: status "%" for a variant with 5 units and ~1.3/day demand', v_rec.status;
  end if;
  if coalesce(v_rec.suggested_qty,0) <= 0 then
    raise exception 'ASSERT 2 FAILED: suggested_qty % — a reorder signal with nothing to order is not a signal', v_rec.suggested_qty;
  end if;
  v_report := v_report || format(E'\n  2  ok   ZERO-SETUP SIGNAL: %s, %s/day, %s days cover, order %s units',
      v_rec.status, round(v_rec.velocity_per_day,3), round(v_rec.days_of_cover,1), v_rec.suggested_qty);

  -- ---------------------------------------------------------- ASSERT 3
  -- Provenance. A number whose origin cannot be seen gets ignored, and an
  -- ignored signal is the same as no signal.
  if v_rec.reorder_point_source <> 'derived' then
    raise exception 'ASSERT 3 FAILED: reorder_point_source "%", expected "derived" when no manual point is set', v_rec.reorder_point_source;
  end if;
  v_report := v_report || format(E'\n  3  ok   reorder point %s labelled "%s", not passed off as the wholesaler''s own',
      v_rec.reorder_point, v_rec.reorder_point_source);

  -- ---------------------------------------------------------- ASSERT 4
  -- Cancelled orders are not demand; healthy stock is not alarmed.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_blue;
  if v_rec.units_sold >= 900 then
    raise exception 'ASSERT 4 FAILED: a CANCELLED 900-unit order leaked into demand (units_sold=%)', v_rec.units_sold;
  end if;
  if v_rec.status <> 'ok' then
    raise exception 'ASSERT 4 FAILED: a healthy slow mover with 300 on hand was flagged "%"', v_rec.status;
  end if;
  v_report := v_report || format(E'\n  4  ok   cancelled order excluded (sold=%s, not 903); healthy variant = %s',
      v_rec.units_sold, v_rec.status);

  -- ---------------------------------------------------------- ASSERT 5
  -- The breakout alert (v1's L2, "the blue tee flying off the shelf").
  -- It must fire on the outlier and stay silent on the ordinary, or it is
  -- noise and gets switched off.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_red;
  if not v_rec.is_breakout then
    raise exception 'ASSERT 5a FAILED: Red outsells its sibling colours %sx and was not flagged (siblings=%)',
      v_rec.breakout_ratio, v_rec.sibling_count;
  end if;
  v_report := v_report || format(E'\n  5a ok   breakout FIRES on the outlier: %sx the median of %s sibling colourways',
      v_rec.breakout_ratio, v_rec.sibling_count);
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_green;
  if v_rec.is_breakout then
    raise exception 'ASSERT 5b FAILED: an ordinary slow mover was flagged as a breakout — the alert is noise';
  end if;
  v_report := v_report || E'\n  5b ok   breakout SILENT on the ordinary colourway';

  -- ---------------------------------------------------------- ASSERT 6
  -- Honesty about absence: never sold gets no invented reorder point.
  -- Same principle as the ABC tier refusing to classify with no revenue.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_black;
  if v_rec.status <> 'no_data' then
    raise exception 'ASSERT 6 FAILED: a never-sold variant got status "%" instead of no_data', v_rec.status;
  end if;
  if v_rec.reorder_point is not null then
    raise exception 'ASSERT 6 FAILED: a never-sold variant was given a fabricated reorder point of %', v_rec.reorder_point;
  end if;
  v_report := v_report || E'\n  6  ok   never-sold variant = no_data, with no invented reorder point';

  -- ---------------------------------------------------------- ASSERT 7
  -- Settings are optional AND live. Optional but dead is the worse of the
  -- two failures — that is how discount_pct hid for two months.
  select count(*) into v_n from v2_inventory_settings where wid = v_wid;
  if v_n <> 0 then
    raise exception 'ASSERT 7 FAILED: fixture already had a settings row; every assertion above would be unproven';
  end if;
  insert into v2_inventory_settings (wid, cover_target_days) values (v_wid, 90);
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_red;
  if coalesce(v_rec.suggested_qty,0) <= 60 then
    raise exception 'ASSERT 7 FAILED: raising cover target to 90 days did not raise the suggestion (got %) — the setting is dead', v_rec.suggested_qty;
  end if;
  v_report := v_report || format(E'\n  7  ok   settings optional AND live: cover 30d->90d raises the order to %s', v_rec.suggested_qty);

  -- ---------------------------------------------------------- ASSERT 8
  -- 067. "Never stocked" is not "sold out". Conflating them put 43 false
  -- OUT alarms on production wholesaler "test"'s screen, which would have
  -- taught its owner to ignore the three real ones.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_never;
  select * into v_r2  from v2_inventory_signals_for(v_wid) where variant_id = v_soldout;
  if v_rec.status <> 'not_tracked' then
    raise exception 'ASSERT 8a FAILED: a never-received variant reports "%" — indistinguishable from a genuine sell-out', v_rec.status;
  end if;
  if v_r2.status <> 'out' then
    raise exception 'ASSERT 8b FAILED: a genuinely sold-out variant reports "%" — the real alarm was suppressed', v_r2.status;
  end if;
  v_report := v_report || E'\n  8  ok   never-received = not_tracked; genuinely sold-out still = out';

  -- ---------------------------------------------------------- ASSERT 9
  -- 068. "Nothing to compare against" must be distinguishable from
  -- "compared, nothing stood out". On production, every demo variant has
  -- sibling_count = 0 because that catalogue models each colour as its own
  -- product — a fact about the catalogue, not a failure of the tool.
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_red;
  if v_rec.sibling_count <> 3 then
    raise exception 'ASSERT 9a FAILED: expected 3 sibling colourways, got % — the comparison is not being scoped to product+size', v_rec.sibling_count;
  end if;
  select * into v_rec from v2_inventory_signals_for(v_wid) where variant_id = v_never;
  if v_rec.sibling_count <> 1 then
    raise exception 'ASSERT 9b FAILED: expected 1 sibling on the second product, got %', v_rec.sibling_count;
  end if;
  v_report := v_report || E'\n  9  ok   sibling_count exposed, so the UI can say WHY a breakout alert is silent';

  raise exception E'ROLLBACK_WITH_REPORT%\n\n  --- check_intelligence_zero_setup: 11/11 ASSERTIONS PASSED (0 rows written) ---', v_report;
end
$check$;

rollback;
