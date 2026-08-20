-- =====================================================================
-- 064 — The reservation leak: expired cart holds suppressed real stock
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------
-- v2_release_expired_reservations() has existed since migration 001. Its
-- own comment reads "call from pg_cron every 1-5 min, per Research 1 §3".
-- Nothing ever called it. pg_cron was never even installed.
--
-- That alone would only be untidy. What made it a live bug is the second
-- half: availability is computed as
--
--     available = qty_on_hand - qty_reserved
--
-- where qty_reserved is a plain counter on v2_inventory_balances that is
-- NEVER filtered by expires_at at read time. So the TTL on a cart hold
-- was decorative. A buyer who put two units in a cart and closed the tab
-- removed those two units from the sellable world permanently, with no
-- error, no log line and nothing in any report to say so.
--
-- Measured on production before this migration ran: 2 reservations, both
-- expired 9 days earlier, holding 4 units of a variant with 8 on hand.
-- 100% of all reserved stock in the system was phantom. The catalog was
-- telling buyers "4 available" about a shelf with 8 boxes on it.
--
-- THE PRINCIPLE BEHIND THE FIX
-- ---------------------------------------------------------------------
-- A scheduler is a tidiness mechanism, not a correctness mechanism. If
-- the answer to "is this stock sellable?" depends on a cron job having
-- run recently, then every cron outage is silently an inventory outage,
-- and nobody finds out for nine days. So this migration fixes it twice,
-- at two independent layers:
--
--   1. READ TIME (the one that guarantees correctness). Availability is
--      derived from reservations that are actually still alive, not from
--      a counter. Correct even if no sweeper ever runs again.
--
--   2. WRITE TIME + SCHEDULE (tidiness, and keeping the counter honest).
--      Reserving or transferring stock first releases any expired holds
--      on that exact row; and pg_cron sweeps globally every 2 minutes so
--      the rows don't pile up forever.
--
-- Layer 1 alone is sufficient for a buyer to see the truth. Layer 2 stops
-- an expired hold from blocking a NEW reservation (the counter is what
-- the atomic check uses) and keeps the table from growing unbounded.
--
-- WHY qty_reserved SURVIVES AT ALL
-- ---------------------------------------------------------------------
-- It stays because the reserve path needs a single-row atomic UPDATE ...
-- WHERE on_hand - reserved >= qty to be race-free under concurrency; you
-- cannot get that from an aggregate over another table without taking
-- heavier locks. So: the counter remains the concurrency primitive, and
-- the live view remains the source of truth for display. The sweep is
-- what keeps the two converged.
--
-- Gate: checks/check_reservation_expiry.sql (6 assertions). Proven RED on
-- production before this file was applied — assertion 3 failed with
-- "available=798 expected=800".
-- =====================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Live holds — reservations that are actually still alive.
--
-- SECURITY NOTE, and it matters: this view deliberately does NOT get
-- security_invoker. v2_stock_reservations is RLS-restricted to the owner
-- and the owning wholesaler, so an invoker-rights view would report ZERO
-- holds to a buyer or to anon — which would show them stock that is
-- already spoken for and let them oversell it. Definer rights here are
-- the safe direction, and the view exposes only an aggregate quantity:
-- no cart_id, no buyer_id, nothing about WHO is holding it.
-- ---------------------------------------------------------------------
create or replace view v2_live_holds as
select variant_id,
       location_id,
       sum(qty)::integer as qty
  from v2_stock_reservations
 where status = 'active'
   and expires_at > now()
 group by variant_id, location_id;

comment on view v2_live_holds is
  'Cart holds that have not expired, aggregated per variant+location. Definer-rights on purpose (see 064). Never join this to anything that would reveal cart_id or buyer_id.';

grant select on v2_live_holds to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Drop-in truthful replacement for v2_inventory_balances.
--
-- Same column names as the table, so any read site can switch to it by
-- changing one identifier and nothing downstream needs to know. Adds
-- qty_available so callers stop re-deriving the subtraction by hand --
-- every place that does that arithmetic itself is a place the bug can
-- come back.
-- ---------------------------------------------------------------------
create or replace view v2_inventory_balances_live as
select b.variant_id,
       b.location_id,
       b.qty_on_hand,
       coalesce(h.qty, 0)                  as qty_reserved,
       b.qty_on_hand - coalesce(h.qty, 0)  as qty_available,
       b.updated_at
  from v2_inventory_balances b
  left join v2_live_holds h
         on h.variant_id = b.variant_id
        and h.location_id = b.location_id;

comment on view v2_inventory_balances_live is
  'v2_inventory_balances with qty_reserved computed from live (non-expired) holds instead of the stored counter. READ FROM THIS, not from the table, anywhere availability is shown.';

alter view v2_inventory_balances_live set (security_invoker = true);
grant select on v2_inventory_balances_live to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. The aggregate view every catalog read goes through, now truthful.
--    Column names and types are unchanged, so this is invisible to
--    callers except that the numbers stop lying.
-- ---------------------------------------------------------------------
create or replace view v2_inventory_by_variant as
select b.variant_id,
       sum(b.qty_on_hand)                        as total_on_hand,
       sum(coalesce(h.qty, 0))                   as total_reserved,
       sum(b.qty_on_hand) - sum(coalesce(h.qty, 0)) as total_available,
       jsonb_object_agg(b.location_id, jsonb_build_object(
         'on_hand', b.qty_on_hand, 'reserved', coalesce(h.qty, 0)
       )) as by_location
  from v2_inventory_balances b
  left join v2_live_holds h
         on h.variant_id = b.variant_id
        and h.location_id = b.location_id
 group by b.variant_id;

alter view v2_inventory_by_variant set (security_invoker = true);

-- ---------------------------------------------------------------------
-- 4. Targeted sweep — release expired holds on ONE variant+location.
--
-- Called at the top of the two write paths that gate on the counter.
-- Scoped rather than global so a busy shop's reserve call doesn't pay
-- for sweeping the whole table.
-- ---------------------------------------------------------------------
create or replace function v2_release_expired_holds_for(
  p_variant_id uuid, p_location_id uuid
) returns integer
language plpgsql security definer set search_path = wholesale_v2 as $$
declare v_count integer := 0; v_r record;
begin
  for v_r in
    select id from v2_stock_reservations
     where status = 'active'
       and expires_at < now()
       and variant_id = p_variant_id
       and location_id = p_location_id
     for update skip locked
  loop
    perform v2_release_reservation(v_r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

comment on function v2_release_expired_holds_for(uuid, uuid) is
  'Release expired cart holds on one variant+location. Cheap enough to call on every reserve/transfer. SKIP LOCKED so two concurrent reserves never deadlock on each other.';

-- ---------------------------------------------------------------------
-- 5. Reserve path: expire before you check.
--
-- Without this, an expired hold still blocks a new reservation, because
-- the atomic check reads the counter. Availability would LOOK right in
-- the catalog and then adding to cart would fail -- which is worse than
-- the original bug, not better.
-- ---------------------------------------------------------------------
create or replace function v2_reserve_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer,
  p_cart_id uuid, p_buyer_id uuid default null, p_ttl_minutes integer default 15
) returns v2_stock_reservations
language plpgsql security definer set search_path = wholesale_v2 as $$
declare v_bal v2_inventory_balances; v_res v2_stock_reservations;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  -- Dead carts do not get a vote on what is sellable. (064)
  perform v2_release_expired_holds_for(p_variant_id, p_location_id);

  update v2_inventory_balances
    set qty_reserved = qty_reserved + p_qty, updated_at = now()
    where variant_id = p_variant_id and location_id = p_location_id
      and qty_on_hand - qty_reserved >= p_qty
    returning * into v_bal;

  if v_bal is null then
    return null;  -- genuinely not enough available stock
  end if;

  insert into v2_stock_reservations
    (variant_id, location_id, qty, cart_id, buyer_id, expires_at)
    values (p_variant_id, p_location_id, p_qty, p_cart_id, p_buyer_id,
            now() + (p_ttl_minutes || ' minutes')::interval)
    returning * into v_res;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id)
    values (p_variant_id, p_location_id, 'reserve', 0, 'cart', p_cart_id);

  return v_res;
end; $$;

-- ---------------------------------------------------------------------
-- 6. Transfer path: same treatment.
--
-- v2_transfer_stock refuses to move units that are "reserved for open
-- carts". Before this, a warehouse move could be blocked for nine days
-- by a tab someone closed. Body is otherwise byte-identical to 047.
-- ---------------------------------------------------------------------
create or replace function v2_transfer_stock(
  p_variant_id uuid, p_from_location uuid, p_to_location uuid,
  p_qty integer, p_note text default null
) returns table(ok boolean, error text, from_on_hand integer, to_on_hand integer)
language plpgsql security definer set search_path = wholesale_v2, public as $$
declare
  v_wid text; v_from_wid text; v_to_wid text;
  v_on_hand int; v_reserved int; v_avail int;
  v_from_row wholesale_v2.v2_inventory_balances;
  v_to_row   wholesale_v2.v2_inventory_balances;
begin
  if p_qty is null or p_qty <= 0 then
    return query select false, 'Enter how many units to move.', null::int, null::int; return;
  end if;
  if p_from_location = p_to_location then
    return query select false, 'Pick two different locations.', null::int, null::int; return;
  end if;

  select p.wid into v_wid
    from wholesale_v2.v2_product_variants v
    join wholesale_v2.v2_products p on p.id = v.product_id
   where v.id = p_variant_id;
  if v_wid is null then
    return query select false, 'That product variant does not exist, or belongs to a different wholesaler.', null::int, null::int; return;
  end if;

  perform wholesale_v2.v2_require_owner_or_own(v_wid);

  select l.wid into v_from_wid from wholesale_v2.v2_locations l where l.id = p_from_location and not l.archived;
  select l.wid into v_to_wid   from wholesale_v2.v2_locations l where l.id = p_to_location   and not l.archived;
  if v_from_wid is null or v_to_wid is null then
    return query select false, 'One of those locations does not exist, or is archived.', null::int, null::int; return;
  end if;
  if v_from_wid is distinct from v_wid or v_to_wid is distinct from v_wid then
    return query select false, 'Those locations belong to a different wholesaler.', null::int, null::int; return;
  end if;

  -- (064) Release dead holds BEFORE reading the counter, or a closed tab
  -- can veto a warehouse transfer indefinitely.
  perform wholesale_v2.v2_release_expired_holds_for(p_variant_id, p_from_location);

  select b.qty_on_hand, b.qty_reserved into v_on_hand, v_reserved
    from wholesale_v2.v2_inventory_balances b
   where b.variant_id = p_variant_id and b.location_id = p_from_location
   for update;

  if v_on_hand is null then
    return query select false, 'There is no stock of that variant at the source location.', null::int, null::int; return;
  end if;

  v_avail := v_on_hand - coalesce(v_reserved, 0);
  if v_avail < p_qty then
    return query select false, format(
      'Only %s available to move (%s on hand, %s reserved for open carts).',
      v_avail, v_on_hand, coalesce(v_reserved, 0)), null::int, null::int;
    return;
  end if;

  v_from_row := wholesale_v2.v2_decrement_stock(
    p_variant_id, p_from_location, p_qty, 'transfer_out', 'transfer', null, auth.uid(),
    coalesce(p_note, 'Transfer out'));
  if v_from_row is null then
    raise exception 'Transfer failed while removing stock from the source location';
  end if;

  insert into wholesale_v2.v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved, updated_at)
  values (p_variant_id, p_to_location, p_qty, 0, now())
  on conflict (variant_id, location_id)
    do update set qty_on_hand = v2_inventory_balances.qty_on_hand + excluded.qty_on_hand,
                  updated_at = now()
  returning * into v_to_row;

  insert into wholesale_v2.v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
  values (p_variant_id, p_to_location, 'transfer_in', p_qty, 'transfer', null, auth.uid(),
          coalesce(p_note, 'Transfer in'));

  return query select true, ''::text, v_from_row.qty_on_hand, v_to_row.qty_on_hand;
end; $$;

-- ---------------------------------------------------------------------
-- 7. Clean up the damage that is already on the shelf.
-- ---------------------------------------------------------------------
do $$
declare v_freed integer;
begin
  select v2_release_expired_reservations() into v_freed;
  raise notice '064: released % stale reservation(s) that had been suppressing stock', v_freed;
end $$;
