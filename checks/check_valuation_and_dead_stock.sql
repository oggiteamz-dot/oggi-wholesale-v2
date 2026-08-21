-- ============================================================================
-- check_valuation_and_dead_stock.sql — Batch 3 gate (migrations 072/073)
--
-- WHAT THIS PROTECTS, and why it is the whole point of the batch.
--
-- Measured on production before a line was written:
--     omni  2,960 units  100% carry a cost
--     sq    1,538 units  100%
--     test  1,400 units    0%   <-- zero
--     demo    495 units  100%
--
-- A naive SUM(qty * cost) tells wholesaler `test` their stock is worth
-- $0.00. That is not "worthless", it is "unknown", and the two are opposite
-- instructions: one says panic, the other says go and fill in your costs.
--
-- THE RULE:
--   Every money figure travels with its COVERAGE. An unpriced unit is
--   excluded from the total and counted separately -- never silently
--   multiplied by zero. Where nothing can be computed the answer is NULL,
--   not 0.
--
-- AND THE DEAD-STOCK RULE:
--   "Has not sold" is not the same as "is dead". Stock that arrived last
--   week and has not sold is NEW. Calling it dead would flag every fresh
--   delivery on the platform, and a wholesaler who is told their new
--   arrivals are dead stock stops reading the number.
--
-- RED-PROVEN against a database replayed to migration 071 (the pre-Batch-3
-- state): fails with v2_inventory_valuation() absent.
--
-- Run:  psql <conn> -f checks/check_valuation_and_dead_stock.sql
-- Everything runs inside a transaction that is rolled back.
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  wid_a text := 'zzval-a';
  wid_b text := 'zzval-b';
  uid_a uuid := '44444444-4444-4444-8444-444444444444';
  uid_b uuid := '55555555-5555-4555-8555-555555555555';
  loc_a uuid; prod_a uuid; loc_b uuid; prod_b uuid;
  v_costed uuid; v_uncosted uuid; v_dead uuid; v_fresh uuid; v_selling uuid; v_other uuid;
  r record; rep text := '';
begin
  -- ------------------------------------------------------------- fixture
  insert into public.wholesalers (wid) values (wid_a), (wid_b);
  insert into v2_wholesalers (wid,name) values (wid_a,'Val A'), (wid_b,'Val B');
  insert into auth.users (id) values (uid_a), (uid_b);
  insert into v2_user_profiles (id,role,wid,actor_label) values
    (uid_a,'wholesaler',wid_a,'A'), (uid_b,'wholesaler',wid_b,'B');
  insert into v2_locations (wid,name) values (wid_a,'A Main') returning id into loc_a;
  insert into v2_locations (wid,name) values (wid_b,'B Main') returning id into loc_b;
  insert into v2_products (wid,name) values (wid_a,'A Coat') returning id into prod_a;
  insert into v2_products (wid,name) values (wid_b,'B Coat') returning id into prod_b;

  -- 100 units @ cost 10, price 25  -> valued
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_a,'A-COSTED','10','25','{"color":"Red","size":"M"}'::jsonb) returning id into v_costed;
  -- 500 units, NO cost at all -> must be excluded AND counted
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_a,'A-UNCOSTED',null,'25','{"color":"Blue","size":"M"}'::jsonb) returning id into v_uncosted;
  -- 40 units @ cost 5, last arrived a YEAR ago, never sold -> DEAD
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_a,'A-DEAD','5','12','{"color":"Olive","size":"M"}'::jsonb) returning id into v_dead;
  -- 30 units @ cost 5, arrived YESTERDAY, never sold -> NEW, not dead
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_a,'A-FRESH','5','12','{"color":"Sand","size":"M"}'::jsonb) returning id into v_fresh;
  -- 20 units @ cost 5, arrived a year ago BUT sold recently -> not dead
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_a,'A-SELLING','5','12','{"color":"Cream","size":"M"}'::jsonb) returning id into v_selling;
  -- B's stock, which must never appear in A's totals
  insert into v2_product_variants (product_id,sku,cost,price,extra_attrs)
    values (prod_b,'B-ONLY','999','999','{"color":"Onyx","size":"M"}'::jsonb) returning id into v_other;

  insert into v2_inventory_balances (variant_id,location_id,qty_on_hand,qty_reserved) values
    (v_costed,loc_a,100,0), (v_uncosted,loc_a,500,0), (v_dead,loc_a,40,0),
    (v_fresh,loc_a,30,0), (v_selling,loc_a,20,0), (v_other,loc_b,7,0);

  -- inbound history that decides "dead" vs "new"
  insert into v2_inventory_movements (variant_id,location_id,movement_type,qty_delta,created_at) values
    (v_dead,   loc_a,'receive',40, now() - interval '365 days'),
    (v_fresh,  loc_a,'receive',30, now() - interval '1 day'),
    (v_selling,loc_a,'receive',20, now() - interval '365 days'),
    (v_costed, loc_a,'receive',100,now() - interval '2 days');

  -- A-SELLING sold recently, so it is old stock that is still moving
  declare v_ord uuid;
  begin
    insert into v2_orders (wid,buyer_label,location_id,status,created_at)
      values (wid_a,'Buyer',loc_a,'delivered', now() - interval '3 days') returning id into v_ord;
    insert into v2_order_items (order_id,variant_id,qty,unit_price) values (v_ord,v_selling,4,12);
  end;

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select * into r from v2_inventory_valuation();
  perform set_config('role','postgres',true);

  -- ---------------------------------------------------------- ASSERT 1
  -- Uncosted stock is EXCLUDED from the money, and COUNTED separately.
  -- 100 @10 + 40 @5 + 30 @5 + 20 @5 = 1000 + 200 + 150 + 100 = 1450.
  -- The 500 uncosted units contribute nothing and must not be silently
  -- valued at zero and folded in.
  if r.value_at_cost <> 1450 then
    raise exception 'ASSERT 1 FAILED: value_at_cost % (expected 1450 -- uncosted units must be excluded, not zero-valued)', r.value_at_cost;
  end if;
  if r.units_unvalued <> 500 then
    raise exception 'ASSERT 1 FAILED: units_unvalued % (expected 500)', r.units_unvalued;
  end if;
  rep := rep || format(E'\n 1  ok   %s at cost over %s units; %s uncosted units excluded AND counted',
    r.value_at_cost, r.units_valued, r.units_unvalued);

  -- ---------------------------------------------------------- ASSERT 2
  -- Coverage is by UNITS. 190 of 690 units carry a cost = 27.5%.
  -- Measuring by variant would say 4 of 5 = 80% and hide that most of the
  -- stock on the floor is unpriced.
  if r.units_on_hand <> 690 then
    raise exception 'ASSERT 2 FAILED: units_on_hand % (expected 690)', r.units_on_hand;
  end if;
  if round(r.coverage_pct,1) <> 27.5 then
    raise exception 'ASSERT 2 FAILED: coverage %, expected 27.5 -- coverage must be by UNITS, not by variant count', r.coverage_pct;
  end if;
  rep := rep || format(E'\n 2  ok   coverage %s%% measured by units (%s of %s), not by variant count',
    r.coverage_pct, r.units_valued, r.units_on_hand);

  -- ---------------------------------------------------------- ASSERT 3
  -- Margin only over stock where BOTH numbers are known.
  -- (25-10)*100 + (12-5)*40 + (12-5)*30 + (12-5)*20 = 1500 + 280 + 210 + 140 = 2130
  if r.margin_value <> 2130 then
    raise exception 'ASSERT 3 FAILED: margin_value % (expected 2130 over cost-and-price-known stock only)', r.margin_value;
  end if;
  rep := rep || format(E'\n 3  ok   margin %s computed only where cost AND price are both known', r.margin_value);

  -- ---------------------------------------------------------- ASSERT 4
  -- DEAD is old AND unsold. Only A-DEAD qualifies: 40 units @5 = 200.
  if r.dead_variants <> 1 then
    raise exception 'ASSERT 4 FAILED: dead_variants % (expected exactly 1 -- A-FRESH arrived yesterday and A-SELLING still sells)', r.dead_variants;
  end if;
  if r.dead_units <> 40 or r.dead_value_at_cost <> 200 then
    raise exception 'ASSERT 4 FAILED: dead % units worth % (expected 40 / 200)', r.dead_units, r.dead_value_at_cost;
  end if;
  rep := rep || format(E'\n 4  ok   dead stock: %s units, %s tied up -- and ONLY the genuinely stale variant',
    r.dead_units, r.dead_value_at_cost);

  -- 075: stock that cannot be dated is its OWN category, not "old".
  -- A-UNCOSTED has 500 units and no inbound movement on record.
  if r.unknown_age_variants <> 1 or r.unknown_age_units <> 500 then
    raise exception 'ASSERT 4b FAILED: undated stock reported as % variants / % units (expected 1 / 500) -- absence of evidence must not become evidence of age',
      r.unknown_age_variants, r.unknown_age_units;
  end if;
  rep := rep || format(E'\n 4b ok   %s units of undated stock counted separately, NOT assumed dead', r.unknown_age_units);

  -- ---------------------------------------------------------- ASSERT 5
  -- The two near-misses, stated explicitly because they are what makes
  -- the number trustworthy: new stock is not dead, and old stock that is
  -- still selling is not dead.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  select * into r from v2_inventory_valuation();
  perform set_config('role','postgres',true);
  if r.dead_units >= 70 then
    raise exception 'ASSERT 5 FAILED: fresh stock is being counted as dead (dead_units=%)', r.dead_units;
  end if;
  rep := rep || E'\n 5  ok   stock received yesterday is NOT dead; old stock that still sells is NOT dead';

  -- ---------------------------------------------------------- ASSERT 6
  -- Tenant scoping. B holds one unit priced at 999; if any of it leaks
  -- into A's totals the arithmetic above would already have failed, but
  -- assert it directly so the reason is unambiguous.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_b), true);
  select * into r from v2_inventory_valuation();
  perform set_config('role','postgres',true);
  if r.units_on_hand <> 7 then
    raise exception 'ASSERT 6 FAILED: wholesaler B sees % units, owns 7', r.units_on_hand;
  end if;
  rep := rep || format(E'\n 6  ok   wholesaler B sees only their own %s units', r.units_on_hand);

  -- ---------------------------------------------------------- ASSERT 7
  -- Nothing computable must return NULL, not 0. This is the production
  -- case: `test` holds 1,400 units and no costs at all.
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', uid_a), true);
  update v2_product_variants set cost = null
   where id in (v_costed, v_dead, v_fresh, v_selling);
  select * into r from v2_inventory_valuation();
  perform set_config('role','postgres',true);
  if r.margin_pct is not null then
    raise exception 'ASSERT 7 FAILED: margin_pct is %, expected NULL when nothing can be valued', r.margin_pct;
  end if;
  if r.coverage_pct <> 0 then
    raise exception 'ASSERT 7 FAILED: coverage %, expected 0 when no unit carries a cost', r.coverage_pct;
  end if;
  rep := rep || E'\n 7  ok   with no costs at all: coverage 0%, margin NULL -- "unknown", never "worthless"';

  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_valuation_and_dead_stock: 7/7 PASSED (0 rows written) ---', rep;
end
$check$;

rollback;
