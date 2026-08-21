-- =====================================================================
-- 072 — Stock valuation and dead stock (Batch 3; restores v1's L4 and L5)
--
-- v1 showed a headline stock valuation (cost / retail / margin) and an
-- aggregate for money tied up in dead stock. Both were lost in the 2.0
-- rewrite. v2 has the aging buckets but never totals the money.
--
-- THE DECISION THAT SHAPES THIS WHOLE MIGRATION
-- ---------------------------------------------------------------------
-- Measured on production before writing a line of it:
--
--   omni            2,960 units    100% carry a cost
--   sq              1,538 units    100%
--   test            1,400 units      0%   <-- zero
--   demo              495 units    100%
--   mg                199 units    100%
--   w1785168930020     50 units    100%
--
-- A naive SUM(qty * cost) tells wholesaler `test` their stock is worth
-- $0.00. That is not "your inventory is worthless", it is "we do not know
-- what it cost" -- and the two are opposite instructions. One says panic,
-- the other says go and fill in your cost prices.
--
-- So every figure travels with its COVERAGE: how many units and variants
-- it was actually computed over. An unpriced unit is excluded and counted,
-- never silently multiplied by zero. Same principle as 066 refusing to
-- invent a reorder point without demand history, and 067 separating
-- "never stocked" from "sold out".
--
-- TWO MORE THINGS REAL DATA SETTLED
-- ---------------------------------------------------------------------
-- * `retail_price` is populated on 0 of 191 variants. Valuing "at retail"
--   through it would print zero for every wholesaler on the platform. The
--   number a wholesaler actually sells at is `price`, filled on 163. So
--   retail valuation uses price and the label says "at your list price".
--
-- * `v2_receipt_costs` is EMPTY. The landed-cost feature exists in code
--   and has never once been used, so the plan's concern about landed cost
--   and base cost being two unreconciled numbers is real in the schema but
--   currently moot in the data. This values at base cost and says so.
--
-- WHY SECURITY DEFINER IS REQUIRED, NOT MERELY CONVENIENT
-- ---------------------------------------------------------------------
-- Migration 031 revoked SELECT on v2_product_variants.cost from anon and
-- authenticated at the COLUMN level. A wholesaler cannot read their own
-- cost column directly, by design. Valuation therefore has to happen
-- inside a definer function returning aggregates -- also the better shape,
-- since it returns totals rather than a per-variant cost list.
--
-- ⚠️ THE FUNCTION BELOW HAS A DEFECT, FIXED IN 073: dead_stock_days and
-- velocity_window_days are both OUT parameters AND CTE column names, so
-- PL/pgSQL cannot resolve the bare name and the call raises. Kept as
-- written so the history reads honestly; 073 immediately replaces it.
-- =====================================================================

-- Dead stock needs its own age threshold, distinct from the velocity
-- window. "Nothing sold in 90 days" and "this has been sitting since
-- February" are different facts and a wholesaler tunes them separately.
alter table wholesale_v2.v2_inventory_settings
  add column if not exists dead_stock_days int not null default 90
    check (dead_stock_days between 7 and 3650);

comment on column wholesale_v2.v2_inventory_settings.dead_stock_days is
  'Migration 072. How long stock must sit unsold before it counts as dead. '
  'Separate from velocity_window_days on purpose: one asks "is it selling", '
  'the other asks "how long has it been standing there".';

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
    select coalesce(s.velocity_window_days, 90) as velocity_window_days,
           coalesce(s.dead_stock_days,      90) as dead_stock_days
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
       and o.created_at >= now() - make_interval(days => cfg.velocity_window_days)
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
      cfg.dead_stock_days,
      cfg.velocity_window_days
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
             or b.last_in_at <= now() - make_interval(days => b.dead_stock_days))
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
    max(dead_stock_days),
    max(velocity_window_days)
  from scored;
end;
$fn$;

revoke execute on function wholesale_v2.v2_inventory_valuation(text) from public;
revoke execute on function wholesale_v2.v2_inventory_valuation(text) from anon;
grant  execute on function wholesale_v2.v2_inventory_valuation(text) to authenticated;

comment on function wholesale_v2.v2_inventory_valuation(text) is
  'Migration 072. Batch 3. Superseded immediately by 073, which fixes an
   ambiguous-name defect in this body.';
