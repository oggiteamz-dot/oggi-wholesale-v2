-- OGGI Wholesale v2 — Batch 7: Prepack / ratio-pack, checkout support
-- 11 Aug 2026
--
-- Extends v2_submit_order (unchanged signature -- p_lines is still just
-- jsonb, so `create or replace` genuinely replaces this time, no duplicate
-- overload like the mistake in migration 010) to accept optional
-- pack_id/pack_line_id/pack_qty on any line and:
--   1. Write them onto the resulting v2_order_items row, so the order
--      history UI can group a pack's component lines back into one
--      display line ("2x Boutique Pack – Style ABC, Blue").
--   2. SKIP the per-SKU MOQ check for pack-derived lines -- a pack's fixed
--      composition (e.g. "1×S, 2×M, 2×L, 1×XL") is deliberately allowed to
--      include fewer units of one size than that SKU's own open-order
--      MOQ, because the pack itself is the sellable unit, not the raw SKU.
--      Product-level MOQ still counts pack units toward the aggregate
--      (sum(qty) per product_id is unchanged), so a pack still has to
--      contribute real units toward the product minimum -- it just isn't
--      double-gated by a per-size minimum that doesn't apply to it.

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
    (l->>'pack_id')::uuid as pack_id,
    (l->>'pack_line_id')::uuid as pack_line_id,
    nullif(l->>'pack_qty', '')::integer as pack_qty,
    pv.product_id as product_id,
    pv.moq_qty as variant_moq_qty,
    pv.sku as sku
  from jsonb_array_elements(p_lines) l
  join v2_product_variants pv on pv.id = (l->>'variant_id')::uuid;

  select jsonb_array_length(p_lines) into v_line_count;
  if (select count(*) from tmp_order_lines) <> v_line_count then
    raise exception 'one or more order lines reference an unknown product variant';
  end if;

  -- SKU-level MOQ -- skipped for pack-derived lines (see header comment).
  for v_line in select * from tmp_order_lines where qty < variant_moq_qty and pack_line_id is null loop
    raise exception 'SKU % requires a minimum of % units per order (you have %)', v_line.sku, v_line.variant_moq_qty, v_line.qty;
  end loop;

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

    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total, pack_id, pack_line_id, pack_qty)
    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total, v_line.pack_id, v_line.pack_line_id, v_line.pack_qty);
  end loop;

  if v_wholesaler.order_min_value is not null and v_subtotal < v_wholesaler.order_min_value then
    raise exception 'This wholesaler requires a minimum order value of % (this order totals %)', v_wholesaler.order_min_value, v_subtotal;
  end if;

  update v2_orders set subtotal = v_subtotal, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$function$;
