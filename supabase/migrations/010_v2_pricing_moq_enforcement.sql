-- OGGI Wholesale v2 — Batch 6: Pricing & MOQ engine, server-side enforcement
-- 11 Aug 2026
--
-- REAL BUG FOUND WHILE BUILDING THIS BATCH, FIXED HERE:
-- the original v2_submit_order (migration 004) took `unit_price` straight
-- from the client-supplied p_lines jsonb and wrote it to the order with
-- zero server-side verification -- any buyer client (buggy or malicious)
-- could submit an order at any price it liked. Every other money/stock-
-- affecting write in this build goes through an atomic, server-computed
-- RPC specifically so the client can never be trusted for the number that
-- matters (see the reservation/stock-decrement RPCs in migration 001) --
-- pricing had quietly been the one exception. Fixed now, in the batch that
-- actually introduces real pricing logic, rather than shipped once more.
--
-- v2_submit_order is recreated to:
--   1. IGNORE any client-supplied unit_price and recompute it itself via
--      v2_effective_unit_price() -- override price, else the best-matching
--      "all-units" tier for that product's aggregate qty in this order,
--      else the variant's base price.
--   2. Enforce SKU-level, product-level (first-order vs. reorder), and
--      order-level (qty and/or value) MOQ before allowing the order
--      through -- these are real constraints, not just cart-UI hints.
-- Any violation raises and the whole submit aborts -- no partial orders,
-- same atomicity guarantee this RPC has had since Batch 2.

-- p_aggregate_qty is bigint, not int: it's fed from sum(qty) over the
-- order's lines, which Postgres types as bigint, and bigint->int is only
-- an assignment-context cast (not implicit-call-context) -- passing a
-- bigint aggregate into an int parameter fails function-call resolution
-- entirely (found via the curl verification pass below, fixed here).
create or replace function v2_effective_unit_price(
  p_product_id uuid, p_variant_id uuid, p_client_id uuid, p_aggregate_qty bigint
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price numeric;
begin
  if p_client_id is not null then
    select override_price into v_price
    from v2_client_price_overrides
    where client_id = p_client_id and variant_id = p_variant_id;
    if v_price is not null then
      return v_price;
    end if;
  end if;

  select unit_price into v_price
  from v2_pricing_tiers
  where product_id = p_product_id and min_qty <= p_aggregate_qty
  order by min_qty desc
  limit 1;
  if v_price is not null then
    return v_price;
  end if;

  select price into v_price from v2_product_variants where id = p_variant_id;
  return v_price;
end;
$$;

-- `create or replace` does NOT replace a function whose parameter list
-- changed (Postgres treats a different signature as a distinct overload,
-- not a replacement) -- it silently left the old 4-arg version in place
-- alongside the new 5-arg one, which broke every call with a PostgREST
-- "ambiguous overload" error. Found immediately via the curl verification
-- pass below and fixed here rather than left in the saved migration.
drop function if exists public.v2_submit_order(text, text, uuid, jsonb);

create or replace function v2_submit_order(
  p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, p_client_id uuid default null
) returns v2_orders
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order v2_orders;
  v_line record;
  v_product record;
  v_wholesaler record;
  v_subtotal numeric(12,2) := 0;
  v_line_total numeric(12,2);
  v_unit_price numeric(12,2);
  v_is_reorder boolean;
  v_effective_moq int;
  v_total_qty int := 0;
  v_line_count int;
begin
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'cannot submit an empty order';
  end if;

  create temporary table tmp_order_lines on commit drop as
  select
    (l->>'variant_id')::uuid as variant_id,
    (l->>'qty')::integer as qty,
    (l->>'reservation_id')::bigint as reservation_id,
    pv.product_id as product_id,
    pv.moq_qty as variant_moq_qty,
    pv.sku as sku
  from jsonb_array_elements(p_lines) l
  join v2_product_variants pv on pv.id = (l->>'variant_id')::uuid;

  select jsonb_array_length(p_lines) into v_line_count;
  if (select count(*) from tmp_order_lines) <> v_line_count then
    raise exception 'one or more order lines reference an unknown product variant';
  end if;

  -- SKU-level MOQ.
  for v_line in select * from tmp_order_lines where qty < variant_moq_qty loop
    raise exception 'SKU % requires a minimum of % units per order (you have %)', v_line.sku, v_line.variant_moq_qty, v_line.qty;
  end loop;

  -- Product-level MOQ, aggregated across every colorway/size of that
  -- product in this order, with a first-order vs. reorder distinction.
  for v_product in
    select product_id, sum(qty) as agg_qty
    from tmp_order_lines
    group by product_id
  loop
    if p_client_id is not null then
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.client_id = p_client_id and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    else
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.buyer_label = p_buyer_label and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    end if;

    select case when v_is_reorder then coalesce(moq_reorder_qty, moq_qty) else moq_qty end
    into v_effective_moq
    from v2_products where id = v_product.product_id;

    if v_product.agg_qty < v_effective_moq then
      raise exception 'Product requires a minimum of % units total across colours/sizes (% order, you have %)',
        v_effective_moq, case when v_is_reorder then 'reorder' else 'first' end, v_product.agg_qty;
    end if;
  end loop;

  -- Order-level MOQ (wholesaler-wide minimum qty), checked before we do
  -- any writes.
  select order_min_qty, order_min_value into v_wholesaler from v2_wholesalers where wid = p_wid;
  select sum(qty) into v_total_qty from tmp_order_lines;
  if v_wholesaler.order_min_qty is not null and v_total_qty < v_wholesaler.order_min_qty then
    raise exception 'This wholesaler requires a minimum order of % units total (you have %)', v_wholesaler.order_min_qty, v_total_qty;
  end if;

  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal)
  values (p_wid, p_buyer_label, p_client_id, p_location_id, 'new', 0)
  returning * into v_order;

  for v_line in
    select tol.*, agg.agg_qty
    from tmp_order_lines tol
    join (select product_id, sum(qty) as agg_qty from tmp_order_lines group by product_id) agg
      on agg.product_id = tol.product_id
  loop
    perform v2_confirm_reservation(v_line.reservation_id, v_order.id, null);

    v_unit_price := v2_effective_unit_price(v_line.product_id, v_line.variant_id, p_client_id, v_line.agg_qty);
    v_line_total := v_line.qty * v_unit_price;
    v_subtotal := v_subtotal + v_line_total;

    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total)
    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total);
  end loop;

  -- Order-level minimum VALUE can only be checked once the (server-
  -- computed) subtotal is known. Raising here rolls back the whole
  -- transaction, including the order row and item inserts above -- no
  -- partial/invalid order is left behind.
  if v_wholesaler.order_min_value is not null and v_subtotal < v_wholesaler.order_min_value then
    raise exception 'This wholesaler requires a minimum order value of % (this order totals %)', v_wholesaler.order_min_value, v_subtotal;
  end if;

  update v2_orders set subtotal = v_subtotal, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$function$;
