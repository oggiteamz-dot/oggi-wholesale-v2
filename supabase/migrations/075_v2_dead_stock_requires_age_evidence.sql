-- =====================================================================
-- 075 — Dead stock requires POSITIVE EVIDENCE of age
--
-- Caught by the Batch 3 gate before this ever reached a screen.
--
-- 072/073 scored a variant as dead when it held stock, had not sold, and
-- either was last received before the threshold OR had no inbound
-- movement on record at all. That last clause is the defect: it treats
-- ABSENCE of evidence as evidence of age, which is the exact opposite of
-- what the rest of this system does with missing information.
--
-- 066 refuses to invent a reorder point without demand history.
-- 067 separates "never stocked" from "sold out".
-- 072 excludes uncosted units rather than valuing them at zero.
-- And then 072 turned round and called undated stock old.
--
-- MEASURED ON PRODUCTION: wholesaler `demo` has 6 stocked variants, and
-- 5 of them -- 450 units, the bulk of their stock -- have no inbound
-- movement, because they were created before the ledger recorded one.
-- Under the old rule those become dead stock the moment they go a quiet
-- 90 days, for no reason other than being old on paper.
--
-- Dead now needs a real last-arrival date. Stock that cannot be dated is
-- reported in its own pair of columns rather than being quietly dropped
-- from the totals -- because "we cannot tell" is a fact the wholesaler
-- can act on (record a receipt), whereas silence just makes the
-- dead-stock figure look better than the evidence supports.
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
  unknown_age_units    bigint,
  unknown_age_variants bigint,
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
      -- Dead requires POSITIVE EVIDENCE OF AGE. 072 treated "no inbound
      -- record" as old, which is the opposite of what the rest of this
      -- system does with missing information. On production that would
      -- have called 450 of demo's units dead stock purely because their
      -- arrival predates the movement ledger.
      (b.qty > 0
        and b.units_sold = 0
        and b.last_in_at is not null
        and b.last_in_at <= now() - make_interval(days => b.cfg_dead_days)
      ) as is_dead,
      -- Counted, not hidden. Stock we cannot date is a real category and
      -- the wholesaler can act on it; silently omitting it would make the
      -- dead-stock figure look better than the evidence supports.
      (b.qty > 0 and b.last_in_at is null) as age_unknown
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
    coalesce(sum(qty) filter (where age_unknown), 0)::bigint,
    count(*) filter (where age_unknown)::bigint,
    max(cfg_dead_days),
    max(cfg_window_days)
  from scored;
end;
$fn$;

revoke execute on function wholesale_v2.v2_inventory_valuation(text) from public;
revoke execute on function wholesale_v2.v2_inventory_valuation(text) from anon;
grant  execute on function wholesale_v2.v2_inventory_valuation(text) to authenticated;

comment on function wholesale_v2.v2_inventory_valuation(text) is
  'Migrations 072/073/075. Batch 3. Stock value at cost and at list price, '
  'margin, and money tied up in dead stock -- each with its coverage. 075 made '
  'dead stock require positive evidence of age; undated stock is reported '
  'separately rather than assumed old.';
