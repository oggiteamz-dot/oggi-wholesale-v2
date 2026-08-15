-- OGGI Wholesale v2 — Batch 2: orders schema + atomic checkout RPC
-- 11 Aug 2026
--
-- Buyer order history/status/reorder (Batch 2's own scope, per BATCH-PLAN-V2)
-- needs an orders table that didn't exist yet -- Batch 1 was inventory-only
-- by design. Adding it here, scoped narrowly, same v2_ prefix discipline.
--
-- Checkout is built on Batch 1's existing reservation RPCs (reserve at
-- add-to-cart, confirm at submit) rather than inventing a new stock-write
-- path -- that plumbing already exists and is exactly what Research 1
-- prescribed (soft TTL holds prevent two buyers overselling the same
-- variant during checkout).

create table if not exists v2_orders (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null references wholesalers(wid) on delete cascade,
  buyer_label   text not null,               -- dev-mode: free-text label; becomes a real client_id FK in Batch 14
  location_id   uuid not null references v2_locations(id),
  status        text not null default 'new'
                check (status in ('new','confirmed','shipped','delivered','cancelled')),
  subtotal      numeric(12,2) not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_v2_orders_wid on v2_orders(wid, created_at desc);
create index if not exists idx_v2_orders_buyer on v2_orders(wid, buyer_label, created_at desc);

create table if not exists v2_order_items (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references v2_orders(id) on delete cascade,
  variant_id   uuid not null references v2_product_variants(id),
  qty          integer not null check (qty > 0),
  unit_price   numeric(12,2) not null default 0,
  line_total   numeric(12,2) not null default 0
);
create index if not exists idx_v2_order_items_order on v2_order_items(order_id);
create index if not exists idx_v2_order_items_variant on v2_order_items(variant_id);

alter table v2_orders enable row level security;
alter table v2_order_items enable row level security;

-- Same temporary/permissive-during-build posture as v2_products (Batch 14
-- hardens this for real). Read is open (needed for order history to
-- render); writes only ever happen through v2_submit_order below, never
-- direct table writes from the client.
create policy v2_orders_read on v2_orders for select using (true);
create policy v2_order_items_read on v2_order_items for select using (true);

-- Atomic checkout: takes a buyer's cart (already reserved via
-- v2_reserve_stock at add-to-cart time) and converts it into a real order
-- in one transaction. If ANY line's reservation is no longer valid (buyer
-- sat on an expired cart, or it was already confirmed/released), the whole
-- submit fails and nothing is partially created -- no half-placed orders.
create or replace function v2_submit_order(
  p_wid text,
  p_buyer_label text,
  p_location_id uuid,
  p_lines jsonb  -- [{reservation_id, variant_id, qty, unit_price}, ...]
) returns v2_orders
language plpgsql security definer set search_path = public as $$
declare
  v_order v2_orders;
  v_line jsonb;
  v_subtotal numeric(12,2) := 0;
  v_line_total numeric(12,2);
begin
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'cannot submit an empty order';
  end if;

  insert into v2_orders (wid, buyer_label, location_id, status, subtotal)
  values (p_wid, p_buyer_label, p_location_id, 'new', 0)
  returning * into v_order;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    -- confirm_reservation raises if the reservation isn't active -- this
    -- aborts the whole transaction (and the order insert above rolls back
    -- with it), which is exactly the atomicity we want.
    perform v2_confirm_reservation(
      (v_line->>'reservation_id')::bigint,
      v_order.id,
      null
    );

    v_line_total := (v_line->>'qty')::integer * (v_line->>'unit_price')::numeric;
    v_subtotal := v_subtotal + v_line_total;

    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total)
    values (
      v_order.id,
      (v_line->>'variant_id')::uuid,
      (v_line->>'qty')::integer,
      (v_line->>'unit_price')::numeric,
      v_line_total
    );
  end loop;

  update v2_orders set subtotal = v_subtotal, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;
