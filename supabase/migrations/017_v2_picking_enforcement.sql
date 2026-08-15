-- OGGI Wholesale v2 — Batch 10: scan-to-pick RPCs
-- 11 Aug 2026
--
-- v2_scan_pick_item is the atomic "one physical unit just got scanned"
-- primitive -- one scan, one unit, matching how a warehouse actually works
-- (a picker scans each unit as they place it in the box, not a typed qty).
-- Row-level locking (FOR UPDATE) makes concurrent scans against the same
-- order safe even if two staff members somehow pick the same order at
-- once, though that's an edge case at this scale, not the common path.
--
-- None of this touches v2_inventory_balances/v2_inventory_movements --
-- confirmed before writing this that real stock is already decremented at
-- v2_submit_order time (see migrations/016's header comment). This is a
-- pure fulfillment-verification checklist layered on top.

drop function if exists public.v2_start_order_pick(uuid);
drop function if exists public.v2_scan_pick_item(uuid, text);
drop function if exists public.v2_undo_pick_item(uuid, text);

-- Idempotently creates one pick-checklist row per real order item. Safe to
-- call every time the mobile pick screen opens for an order (on_conflict
-- do nothing) -- it never resets progress already made.
create or replace function public.v2_start_order_pick(p_order_id uuid)
returns setof v2_order_pick_items
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into v2_order_pick_items (order_id, order_item_id, variant_id, expected_qty)
  select oi.order_id, oi.id, oi.variant_id, oi.qty
  from v2_order_items oi
  where oi.order_id = p_order_id
  on conflict (order_item_id) do nothing;

  return query select * from v2_order_pick_items where order_id = p_order_id order by updated_at;
end;
$$;

-- Resolves p_code against barcode first, falling back to sku (see
-- migrations/016 header), finds the order's own not-yet-fully-picked line
-- for that exact variant, and increments it by one unit.
create or replace function public.v2_scan_pick_item(p_order_id uuid, p_code text)
returns v2_order_pick_items
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_variant_id uuid;
  v_pick v2_order_pick_items;
begin
  -- Two explicit steps, NOT a union -- `select ... union all select ...
  -- limit 1` does not reliably prefer the first branch's rows, so a
  -- barcode match could lose to a coincidental sku match (or vice versa)
  -- depending on the planner. Barcode is checked first and only falls
  -- through to sku when no barcode matches, exactly as intended.
  select id into v_variant_id from v2_product_variants where barcode = p_code limit 1;
  if v_variant_id is null then
    select id into v_variant_id from v2_product_variants where sku = p_code limit 1;
  end if;

  if v_variant_id is null then
    raise exception 'No SKU or barcode matches "%"', p_code;
  end if;

  select * into v_pick from v2_order_pick_items
    where order_id = p_order_id and variant_id = v_variant_id and picked_qty < expected_qty
    order by updated_at
    limit 1
    for update;

  if v_pick is null then
    if exists (select 1 from v2_order_pick_items where order_id = p_order_id and variant_id = v_variant_id) then
      raise exception 'Already fully picked for this SKU on this order';
    end if;
    raise exception 'This SKU is not part of this order';
  end if;

  update v2_order_pick_items
    set picked_qty = picked_qty + 1, picked_at = now(), updated_at = now()
    where id = v_pick.id
    returning * into v_pick;

  return v_pick;
end;
$$;

-- Undoes one scan (for a mis-scan) -- same code resolution, decrements the
-- most recently-updated partially-or-fully-picked line for that variant by
-- one unit. Never goes below zero (the table's own check constraint
-- backstops this even if the "greatest" picked line has 0 already, in
-- which case this simply finds no eligible row and raises).
create or replace function public.v2_undo_pick_item(p_order_id uuid, p_code text)
returns v2_order_pick_items
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_variant_id uuid;
  v_pick v2_order_pick_items;
begin
  select id into v_variant_id from v2_product_variants where barcode = p_code limit 1;
  if v_variant_id is null then
    select id into v_variant_id from v2_product_variants where sku = p_code limit 1;
  end if;

  if v_variant_id is null then
    raise exception 'No SKU or barcode matches "%"', p_code;
  end if;

  select * into v_pick from v2_order_pick_items
    where order_id = p_order_id and variant_id = v_variant_id and picked_qty > 0
    order by updated_at desc
    limit 1
    for update;

  if v_pick is null then
    raise exception 'Nothing picked yet for this SKU on this order';
  end if;

  update v2_order_pick_items
    set picked_qty = picked_qty - 1, updated_at = now()
    where id = v_pick.id
    returning * into v_pick;

  return v_pick;
end;
$$;
