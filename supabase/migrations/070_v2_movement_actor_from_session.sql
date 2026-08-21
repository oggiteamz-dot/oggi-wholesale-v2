-- =====================================================================
-- 070 — Record WHO moved the stock
--
-- WHY
-- ---------------------------------------------------------------------
-- Batch 2 puts the movement ledger on screen. An audit trail answers
-- "why is this 12 and not 20", and half that answer is who did it.
--
-- Measured on production before this migration: of 236 movements, only
-- 9 carry an actor -- and all 9 are transfers. v2_transfer_stock sets
-- actor_id from auth.uid() itself. Every other path takes p_actor_id
-- from the caller, and all six JS call sites pass literal null:
--     js/data/inventory-admin.js:189, :201, :207
--     js/data/csv-import.js:208
--     js/data/kits.js:82
--     js/data/products-admin.js:338
--
-- So "who" would have been blank on 96% of rows, and blank on every
-- future row too. A column that is permanently empty is worse than an
-- absent one: it looks like data loss rather than a decision.
--
-- THE FIX, AND WHY IT IS SERVER-SIDE
-- ---------------------------------------------------------------------
--     p_actor_id  ->  coalesce(p_actor_id, auth.uid())
--
-- The obvious alternative was to edit the six JS call sites to pass a
-- user id. That is more work AND weaker: an id supplied by the client is
-- an id the client can choose. Deriving it from the session inside a
-- SECURITY DEFINER function cannot be spoofed, needs no client change,
-- and fixes all six call sites plus any written in future. It is exactly
-- what v2_transfer_stock already does, so this makes the odd one out
-- into the rule.
--
-- p_actor_id is still honoured when explicitly supplied, so a server-
-- side job acting on someone's behalf can still say so.
--
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------
-- Nothing is backfilled. The 227 historical rows keep a null actor,
-- because there is no honest way to find out who they were. The ledger
-- UI says "not recorded" for those rather than inventing a name -- the
-- same principle as 066 refusing to fabricate a reorder point for a
-- variant with no demand history.
--
-- REBASED ON THE LIVE DEFINITIONS, not on whichever migration was
-- easiest to find. Both bodies below are byte-identical to
-- pg_get_functiondef() as of 21 Aug 2026 except for the single coalesce
-- on each. This is the discipline migration 028 nearly got wrong, where
-- rebuilding from an older copy would have silently deleted the
-- p_account_id protection added later.
-- =====================================================================

create or replace function wholesale_v2.v2_receive_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer,
  p_reference_type text default 'manual'::text, p_reference_id uuid default null::uuid,
  p_actor_id uuid default null::uuid, p_note text default null::text)
returns wholesale_v2.v2_inventory_balances
language plpgsql
security definer
set search_path to 'wholesale_v2'
as $function$
declare v_row v2_inventory_balances;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  insert into v2_inventory_balances (variant_id, location_id, qty_on_hand)
    values (p_variant_id, p_location_id, p_qty)
    on conflict (variant_id, location_id)
    do update set qty_on_hand = v2_inventory_balances.qty_on_hand + excluded.qty_on_hand,
                  updated_at = now()
    returning * into v_row;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
    -- 070: fall back to the session's user. Unspoofable, and it makes every
    -- future movement attributable without touching a single call site.
    values (p_variant_id, p_location_id, 'receive', p_qty, p_reference_type, p_reference_id,
            coalesce(p_actor_id, auth.uid()), p_note);

  return v_row;
end; $function$;

create or replace function wholesale_v2.v2_decrement_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer, p_movement_type text,
  p_reference_type text default null::text, p_reference_id uuid default null::uuid,
  p_actor_id uuid default null::uuid, p_note text default null::text)
returns wholesale_v2.v2_inventory_balances
language plpgsql
security definer
set search_path to 'wholesale_v2'
as $function$
declare v_row v2_inventory_balances;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  update v2_inventory_balances
    set qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    where variant_id = p_variant_id and location_id = p_location_id
      and qty_on_hand >= p_qty
    returning * into v_row;

  if v_row is null then
    return null;
  end if;

  insert into v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
    -- 070: see v2_receive_stock above.
    values (p_variant_id, p_location_id, p_movement_type, -p_qty, p_reference_type, p_reference_id,
            coalesce(p_actor_id, auth.uid()), p_note);

  return v_row;
end; $function$;
