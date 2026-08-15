-- OGGI Wholesale v2 — Batch 9: kit assembly RPC
-- 11 Aug 2026
--
-- v2_assemble_kit is the ONLY way component stock converts into kit stock.
-- Built entirely out of the existing v2_decrement_stock/v2_receive_stock
-- RPCs from migrations/001 -- no new balance-mutation logic, same "reuse
-- the already-tested ledger primitives" discipline as Batch 7's prepacks.
--
-- Atomicity: this is one plpgsql function body, so it runs inside the one
-- transaction PostgREST opens for the RPC call. If ANY component has
-- insufficient stock, v2_decrement_stock returns null (its own established
-- behaviour, see migrations/001) and this function RAISEs, which rolls back
-- every component decrement already applied in this call -- a kit assembly
-- can never partially consume some components and not others.
--
-- movement_type note: the table's check constraint (see
-- v2_inventory_movements_movement_type_check) only allows a fixed set of
-- values, and doesn't include a kit-specific one -- 'adjustment' is used
-- for the component consumption side (a kit assembly IS a stock
-- adjustment: units leave the component SKU's on-hand count without a
-- sale), with reference_type='kit_assembly'/reference_id=<kit id> so
-- reporting can still tell a kit consumption apart from a manual count
-- correction. The produce side reuses v2_receive_stock unchanged, which
-- always writes movement_type='receive' -- also disambiguated via the same
-- reference_type/reference_id.

drop function if exists public.v2_assemble_kit(uuid, uuid, integer, uuid, text);

create or replace function public.v2_assemble_kit(
  p_kit_id uuid,
  p_location_id uuid,
  p_qty int,
  p_actor_id uuid default null,
  p_note text default null
)
returns v2_inventory_balances
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_kit v2_kit_definitions;
  v_comp record;
  v_dec v2_inventory_balances;
  v_result v2_inventory_balances;
begin
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  select * into v_kit from v2_kit_definitions where id = p_kit_id and active = true;
  if v_kit is null then
    raise exception 'kit % not found or inactive', p_kit_id;
  end if;

  if not exists (select 1 from v2_kit_components where kit_id = p_kit_id) then
    raise exception 'kit % has no components defined', p_kit_id;
  end if;

  for v_comp in select * from v2_kit_components where kit_id = p_kit_id loop
    select * into v_dec from v2_decrement_stock(
      v_comp.component_variant_id, p_location_id, v_comp.qty_per_kit * p_qty,
      'adjustment', 'kit_assembly', p_kit_id, p_actor_id,
      coalesce(p_note, 'Kit assembly: ' || p_qty || 'x ' || v_kit.name)
    );
    if v_dec is null then
      raise exception 'insufficient stock for component % (need % units) to assemble % of kit %',
        v_comp.component_variant_id, v_comp.qty_per_kit * p_qty, p_qty, v_kit.name;
    end if;
  end loop;

  select * into v_result from v2_receive_stock(
    v_kit.kit_variant_id, p_location_id, p_qty,
    'kit_assembly', p_kit_id, p_actor_id,
    coalesce(p_note, 'Kit assembly: produced ' || p_qty || 'x ' || v_kit.name)
  );

  return v_result;
end;
$$;
