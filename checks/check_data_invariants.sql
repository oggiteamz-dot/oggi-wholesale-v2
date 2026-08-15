-- CHECK: data-shape invariants for OGGI Wholesale v2
--
-- Behaviour/shape checks, not name checks. Every assertion below is about
-- what the DATA actually looks like and whether the code actually enforces
-- it. None of them can be satisfied by a function still having the right
-- name -- which matters, because both feature losses in this product's
-- history were invisible to name-matching:
--
--   * the 2.0 rewrite dropped the size axis, and a sweep that grepped
--     function names could not see it, because the loss lived in the SHAPE
--     of a record;
--   * the selling models survived migration as DATA and were then ignored
--     by the CODE -- see assertion 5, which is red today.
--
-- Run against any environment. Read-only: it opens no transaction, writes
-- nothing, and only raises.
--
--   psql "$DATABASE_URL" -f checks/check_data_invariants.sql
--
-- Every failure is collected and reported together, so one run tells you
-- everything that is wrong rather than only the first thing.

do $$
declare
  fails text[] := '{}';
  warns text[] := '{}';
  n bigint;
  txt text;
begin
  ------------------------------------------------------------------
  -- 1. ORDER-LINE SHAPE
  -- The check that would have caught BOTH historical losses. An order
  -- line must be able to say: which exact variant, how many, and (if it
  -- came from a pack) which pack, which pack line, and how many packs.
  -- Losing any of these columns silently reduces what an order can
  -- express -- which is precisely how the size axis disappeared.
  ------------------------------------------------------------------
  for txt in
    select c from unnest(array['variant_id','qty','pack_id','pack_line_id','pack_qty']) c
    where not exists (
      select 1 from information_schema.columns
      where table_schema='wholesale_v2' and table_name='v2_order_items' and column_name=c)
  loop
    fails := fails || format('ORDER-LINE SHAPE: v2_order_items has lost column "%s" -- an order can no longer express it', txt);
  end loop;

  ------------------------------------------------------------------
  -- 2. THE COLOUR x SIZE AXIS
  -- This is the thing the 2.0 rewrite lost. Note it is NOT a column --
  -- colour and size live inside extra_attrs -- so a check looking for
  -- columns named "size" would pass while the axis was being destroyed.
  -- Assert on the data.
  ------------------------------------------------------------------
  select count(*) into n from wholesale_v2.v2_product_variants
   where not (extra_attrs ? 'size') or not (extra_attrs ? 'color');
  if n > 0 then
    fails := fails || format('SIZE AXIS: %s variant(s) are missing colour and/or size in extra_attrs -- this is the exact loss the 2.0 rewrite caused', n);
  end if;

  -- A variant is identified by product + colour + size. Duplicates mean
  -- two rows compete to be the same SKU and stock will drift between them.
  select count(*) into n from (
    select product_id, extra_attrs->>'color' c, extra_attrs->>'size' s
    from wholesale_v2.v2_product_variants where not archived
    group by 1,2,3 having count(*) > 1) d;
  if n > 0 then
    fails := fails || format('SIZE AXIS: %s duplicate (product, colour, size) combination(s) -- two rows claiming the same SKU', n);
  end if;

  ------------------------------------------------------------------
  -- 3. STOCK INVARIANTS
  -- v2 stores stock per variant per location with no denormalised total,
  -- so there is no total to drift (good). What CAN go wrong is reserving
  -- stock that does not exist, or negative quantities.
  ------------------------------------------------------------------
  select count(*) into n from wholesale_v2.v2_inventory_balances
   where qty_on_hand < 0 or qty_reserved < 0;
  if n > 0 then
    fails := fails || format('STOCK: %s balance row(s) with a negative quantity', n);
  end if;

  select count(*) into n from wholesale_v2.v2_inventory_balances
   where qty_reserved > qty_on_hand;
  if n > 0 then
    fails := fails || format('STOCK: %s row(s) reserve more stock than is on hand -- overselling', n);
  end if;

  -- Every variant a buyer can see should have somewhere to be counted.
  select count(*) into n from wholesale_v2.v2_product_variants v
   where not v.archived
     and not exists (select 1 from wholesale_v2.v2_inventory_balances b where b.variant_id = v.id);
  if n > 0 then
    warns := warns || format('STOCK: %s live variant(s) have no inventory balance row at any location', n);
  end if;

  ------------------------------------------------------------------
  -- 4. PACK INTEGRITY
  -- A pack with no components is unbuyable; a component pointing at a
  -- variant of a different product is incoherent.
  ------------------------------------------------------------------
  select count(*) into n from wholesale_v2.v2_pack_definitions d
   where not d.archived
     and not exists (select 1 from wholesale_v2.v2_pack_components c where c.pack_id = d.id);
  if n > 0 then
    fails := fails || format('PACKS: %s live pack(s) have no components -- nothing to buy', n);
  end if;

  select count(*) into n
    from wholesale_v2.v2_pack_components c
    join wholesale_v2.v2_pack_definitions d on d.id = c.pack_id
    join wholesale_v2.v2_product_variants v on v.id = c.variant_id
   where v.product_id <> d.product_id;
  if n > 0 then
    fails := fails || format('PACKS: %s component(s) reference a variant from a different product', n);
  end if;

  ------------------------------------------------------------------
  -- 5. SELLING MODELS: DATA vs ENFORCEMENT
  --
  -- RED as of 15 Aug 2026 for 'ratio' only. 'series' WAS red here; it is
  -- now enforced by migration 029 and has been removed from this list.
  -- Add a value back the moment enforcement is removed.
  --
  -- Every variant carries extra_attrs.sellMode, faithfully migrated from
  -- v1 by migration 002 line 191. Four values exist in the live data:
  -- open, prepack, ratio, series.
  --
  -- But only 'open' and 'prepack' are actually ENFORCED anywhere. The
  -- application reads sellMode once (js/data/catalog.js:76), maps it onto
  -- every variant object, and then no code ever reads it again. What
  -- decides how a product can be bought is whether a pack definition
  -- exists (js/components/product-card.js:90), not what the data says.
  --
  -- So a product whose wholesaler declared it "series" is sold as loose
  -- open stock. The declaration survived the migration and is silently
  -- ignored -- which is worse than the feature being absent, because the
  -- data and the API surface both claim it is there.
  --
  -- This assertion compares what the DATA declares against what the CODE
  -- can honour. Update ENFORCED only when enforcement genuinely ships.
  ------------------------------------------------------------------
  for txt, n in
    select v.extra_attrs->>'sellMode', count(*)
      from wholesale_v2.v2_product_variants v
     where coalesce(v.extra_attrs->>'sellMode','open') not in ('open','prepack','series')
     group by 1
  loop
    fails := fails || format(
      'SELLING MODEL NOT ENFORCED: %s variant(s) are declared "%s" in the data, but nothing in the code enforces it -- they are sold as open stock',
      n, txt);
  end loop;

  -- Any brand-new value nobody has considered at all.
  for txt in
    select distinct v.extra_attrs->>'sellMode'
      from wholesale_v2.v2_product_variants v
     where v.extra_attrs->>'sellMode' is not null
       and v.extra_attrs->>'sellMode' not in ('open','prepack','ratio','series')
  loop
    fails := fails || format('SELLING MODEL UNKNOWN: sellMode "%s" appears in the data and is not a recognised model', txt);
  end loop;

  -- Migration 029 makes 'series' real by generating a pack containing every
  -- live variant. If that pack goes missing, the enforcement below silently
  -- makes the product UNBUYABLE rather than series-only -- so assert it.
  select count(*) into n
    from wholesale_v2.v2_products p
   where p.selling_model = 'series' and not p.archived
     and not exists (select 1 from wholesale_v2.v2_pack_definitions d
                      where d.product_id = p.id and d.source = 'series' and not d.archived);
  if n > 0 then
    fails := fails || format('SERIES: %s series product(s) have no generated series pack -- they are unbuyable, not series-only', n);
  end if;

  select count(*) into n from (
    select d.id from wholesale_v2.v2_pack_definitions d
      join wholesale_v2.v2_product_variants v on v.product_id = d.product_id and not v.archived
     where d.source = 'series' and not d.archived
     group by d.id
    having count(*) <> (select count(*) from wholesale_v2.v2_pack_components c where c.pack_id = d.id)) x;
  if n > 0 then
    fails := fails || format('SERIES: %s series pack(s) do not contain every live variant -- a series must be the whole grid', n);
  end if;

  ------------------------------------------------------------------
  -- 6. MOQ IS MEANINGFUL
  -- Minimum order quantity is what makes this wholesale rather than
  -- retail. A zero or negative minimum is not a minimum.
  ------------------------------------------------------------------
  select count(*) into n from wholesale_v2.v2_products where moq_qty < 1;
  if n > 0 then
    fails := fails || format('MOQ: %s product(s) have a minimum below 1', n);
  end if;
  select count(*) into n from wholesale_v2.v2_product_variants where moq_qty < 1;
  if n > 0 then
    fails := fails || format('MOQ: %s variant(s) have a per-SKU minimum below 1', n);
  end if;

  ------------------------------------------------------------------
  -- REPORT
  ------------------------------------------------------------------
  if array_length(warns,1) is not null then
    raise notice 'WARNINGS (not failures):';
    foreach txt in array warns loop raise notice '  ~ %', txt; end loop;
  end if;

  if array_length(fails,1) is null then
    raise notice 'check_data_invariants: ALL ASSERTIONS HELD';
  else
    raise notice 'check_data_invariants: % FAILURE(S)', array_length(fails,1);
    foreach txt in array fails loop raise notice '  X %', txt; end loop;
    raise exception 'check_data_invariants FAILED with % problem(s) -- see the notices above', array_length(fails,1);
  end if;
end $$;
