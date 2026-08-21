-- =====================================================================
-- 073 — Fix an ambiguous name in 072's valuation function
--
-- 072 declared dead_stock_days and velocity_window_days as OUT parameters
-- of the returns-table AND used the same two names as CTE columns.
-- PL/pgSQL cannot tell a bare `dead_stock_days` from the variable, and
-- refused:
--     column reference "dead_stock_days" is ambiguous
--
-- Worth recording that it failed LOUDLY. Postgres could instead have
-- silently resolved to the variable and computed dead stock against
-- whatever the OUT parameter held -- null until the query assigns it, so
-- every variant would have scored is_dead = false and the feature would
-- have reported "no dead stock" forever, correct-looking and wrong. That
-- is the failure mode this codebase keeps meeting.
--
-- The CTE columns are renamed with a cfg_ prefix. Nothing else changes.
-- =====================================================================

drop function if exists wholesale_v2.v2_inventory_valuation(text);

create function wholesale_v2.v2_inventory_valuation(p_wid text default null)
returns table (
  units_on_hand        bigint,
  units_valued         bigint,
  units_unvalued       bigint,
  variants_total       bigint,
  variants_valued      bigint,
  variants_unvalued    bigint,
  coverage_pct         numeric,
  value_at_cost        numeric,
  value_at_price       numeric,
  margin_value         numeric,
  margin_pct           numeric,
  dead_units           bigint,
  dead_variants        bigint,
  dead_value_at_cost   numeric,
  dead_stock_days      int,
  velocity_window_days int
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
begin
  v_wid := case
             when wholesale_v2.v2_is_owner() and p_wid is not null then p_wid
             else wholesale_v2.v2_my_wid()
           end;
  if v_wid is null then
    return;
  end if;

  return query
  with cfg as (
    -- cfg_ prefix: these names must not collide with this function's OUT
    -- parameters, or PL/pgSQL resolves the bare name to the variable.
    select coalesce(s.velocity_window_days, 90) as cfg_window_days,
           coalesce(s.dead_stock_days,      90) as cfg_dead_days
      from (select 1) x
      left join v2_inventory_settings s on s.wid = v_wid
  ),
  vars as (
    select v.id, v.cost, v.price
      from v2_product_variants v
      join v2_products p on p.id = v.product_id
     where p.wid = v_wid and v.archived = false and p.archived = false
  ),
  onhand as (
    -- On HAND, not available. Valuation asks what the stock in the building
    -- is worth, and a unit held for someone's cart is still on the shelf
    -- and still cost money to buy.
    select b.variant_id, sum(b.qty_on_hand)::bigint as qty
      from v2_inventory_balances b
      join vars v on v.id = b.variant_id
     group by b.variant_id
  ),
  sold as (
    select oi.variant_id, sum(oi.qty)::bigint as units_sold
      from v2_order_items oi
      join v2_orders o on o.id = oi.order_id
      join vars v on v.id = oi.variant_id
     cross join cfg
     where o.wid = v_wid
       and o.status <> 'cancelled'
       and o.created_at >= now() - make_interval(days => cfg.cfg_window_days)
     group by oi.variant_id
  ),
  last_in as (
    -- Age is measured from the last time stock ARRIVED, by any route.
    -- Counting only 'receive' would call a warehouse transfer old stock.
    select m.variant_id, max(m.created_at) as last_in_at
      from v2_inventory_movements m
      join vars v on v.id = m.variant_id
     where m.movement_type in ('receive','transfer_in')
     group by m.variant_id
  ),
  base as (
    select
      v.id,
      coalesce(h.qty, 0)                       as qty,
      v.cost,
      v.price,
      (v.cost  is not null and v.cost  > 0)    as has_cost,
      (v.price is not null and v.price > 0)    as has_price,
      coalesce(s.units_sold, 0)                as units_sold,
      l.last_in_at,
      cfg.cfg_dead_days,
      cfg.cfg_window_days
      from vars v
      left join onhand  h on h.variant_id = v.id
      left join sold    s on s.variant_id = v.id
      left join last_in l on l.variant_id = v.id
     cross join cfg
  ),
  scored as (
    select b.*,
      -- Dead: on the shelf, nothing sold in the window, and standing there
      -- longer than the threshold. A variant holding stock with no inbound
      -- movement on record is treated as old, because there is no evidence
      -- it is recent.
      (b.qty > 0
        and b.units_sold = 0
        and (b.last_in_at is null
             or b.last_in_at <= now() - make_interval(days => b.cfg_dead_days))
      ) as is_dead
    from base b
  )
  select
    coalesce(sum(qty), 0)::bigint,
    coalesce(sum(qty) filter (where has_cost), 0)::bigint,
    coalesce(sum(qty) filter (where not has_cost), 0)::bigint,
    count(*)::bigint,
    count(*) filter (where has_cost)::bigint,
    count(*) filter (where not has_cost)::bigint,
    -- Coverage by UNITS, not by variants: one uncosted SKU holding 1,400
    -- units matters far more than twenty uncosted SKUs holding none.
    case when coalesce(sum(qty),0) = 0 then null
         else round(100.0 * coalesce(sum(qty) filter (where has_cost),0) / sum(qty), 1)
    end,
    round(coalesce(sum(qty * cost)  filter (where has_cost), 0), 2),
    round(coalesce(sum(qty * price) filter (where has_price), 0), 2),
    -- Margin only over stock where BOTH numbers are known, otherwise it is
    -- a subtraction between two different populations.
    round(coalesce(sum(qty * (price - cost)) filter (where has_cost and has_price), 0), 2),
    case when coalesce(sum(qty * price) filter (where has_cost and has_price), 0) = 0 then null
         else round(100.0 * coalesce(sum(qty * (price - cost)) filter (where has_cost and has_price), 0)
                    / sum(qty * price) filter (where has_cost and has_price), 1)
    end,
    coalesce(sum(qty) filter (where is_dead), 0)::bigint,
    count(*) filter (where is_dead)::bigint,
    round(coalesce(sum(qty * cost) filter (where is_dead and has_cost), 0), 2),
    max(cfg_dead_days),
    max(cfg_window_days)
  from scored;
end;
$fn$;

revoke execute on function wholesale_v2.v2_inventory_valuation(text) from public;
revoke execute on function wholesale_v2.v2_inventory_valuation(text) from anon;
grant  execute on function wholesale_v2.v2_inventory_valuation(text) to authenticated;

comment on function wholesale_v2.v2_inventory_valuation(text) is
  'Migrations 072/073. Batch 3. Stock value at cost and at list price, margin, '
  'and the money tied up in dead stock -- each reported WITH its coverage, '
  'because one production wholesaler holds 1,400 units of which 0%% carry a '
  'cost and "$0.00" would have read as worthless rather than as unknown. '
  'SECURITY DEFINER is required, not convenient: migration 031 revoked the '
  'cost column from authenticated, so these aggregates can only be computed '
  'inside a definer function.';
