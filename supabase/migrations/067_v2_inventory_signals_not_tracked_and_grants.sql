-- =====================================================================
-- 067 — Correcting two defects in 066, found by testing it against real
--       production data rather than against its own fixture.
--
-- DEFECT 1 — "never stocked" was reported as "out of stock"
-- 066 computed status as: available <= 0 -> 'out'. A variant that has never
-- been received has no balance row at all, so it also lands on available = 0,
-- and 066 called it 'out'.
--
-- Those are different facts and this codebase already knew it. From
-- js/data/inventory-admin.js:175 --
--     "Lets the view distinguish 'sold out' from 'never had any'. They look
--      identical as a number and mean entirely different things: one needs
--      reordering, the other has simply not been received yet."
-- and migration 062 drew the same line for the buyer catalogue with its three
-- states in / out / not_tracked.
--
-- Measured on production: wholesaler 'test' has 46 active variants, 43 of
-- which have never been received. Under 066 that screen opens with 43 red
-- OUT OF STOCK alarms for products the wholesaler never intended to stock.
-- Nobody reads a screen that cries wolf 43 times, so the effect of the bug is
-- that the three REAL alerts get ignored too. An alert system that trains its
-- user to ignore it is worse than no alert system, because it also consumes
-- the attention a working one would have earned.
--
-- DEFECT 2 — anon could call the public entry point
-- 066 granted execute to `authenticated`, but Postgres grants EXECUTE to
-- PUBLIC by default on a newly created function, and anon inherits it.
-- Verified after 066 shipped:
--     has_function_privilege('anon','v2_inventory_signals(text)','execute') = true
--
-- No data actually leaked: for an anonymous caller v2_my_wid() returns null
-- and the function returns an empty set. But that is defence by luck. It
-- holds only while v2_my_wid() keeps its current behaviour, and it puts the
-- security of this function in a different file from the function. Migration
-- 031 already wrote down the principle being broken: "defence that does not
-- depend on the next person getting RLS right."
-- =====================================================================

-- Signature and return type unchanged, so CREATE OR REPLACE is safe and the
-- composite type does not need rebuilding.
create or replace function wholesale_v2.v2_inventory_signals_for(p_wid text)
returns setof wholesale_v2.v2_inventory_signal
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  with cfg as (
    select
      coalesce(s.velocity_window_days,  90)  as velocity_window_days,
      coalesce(s.lead_time_days,        14)  as lead_time_days,
      coalesce(s.cover_target_days,     30)  as cover_target_days,
      coalesce(s.safety_days,            7)  as safety_days,
      coalesce(s.low_stock_threshold,   15)  as low_stock_threshold,
      coalesce(s.breakout_multiple,    1.5)  as breakout_multiple,
      coalesce(s.breakout_min_siblings,  3)  as breakout_min_siblings,
      coalesce(s.breakout_min_units,     5)  as breakout_min_units
    from (select 1) x
    left join v2_inventory_settings s on s.wid = p_wid
  ),
  vars as (
    select v.id, v.product_id, v.sku, v.reorder_point, v.reorder_qty, v.lead_time_days,
           p.name as product_name,
           nullif(v.extra_attrs->>'color','') as color,
           nullif(v.extra_attrs->>'size','')  as size
      from v2_product_variants v
      join v2_products p on p.id = v.product_id
     where p.wid = p_wid and v.archived = false and p.archived = false
  ),
  bal as (
    select b.variant_id,
           sum(b.qty_on_hand)::int   as on_hand,
           sum(b.qty_reserved)::int  as reserved,
           sum(b.qty_available)::int as available
      from v2_inventory_balances_live b
      join vars v on v.id = b.variant_id
     group by b.variant_id
  ),
  demand as (
    select oi.variant_id, sum(oi.qty)::int as units_sold
      from v2_order_items oi
      join v2_orders o on o.id = oi.order_id
      join vars v      on v.id = oi.variant_id
     cross join cfg
     where o.wid = p_wid
       and o.status <> 'cancelled'
       and o.created_at >= now() - make_interval(days => cfg.velocity_window_days)
     group by oi.variant_id
  ),
  base as (
    select
      v.id, v.product_id, v.product_name, v.sku, v.color, v.size,
      coalesce(b.on_hand,0)    as on_hand,
      coalesce(b.reserved,0)   as reserved,
      coalesce(b.available,0)  as available,
      -- 067: the fact that separates "never had any" from "sold out".
      -- Absence of a balance row is information, not a zero.
      (b.variant_id is not null) as has_balance,
      coalesce(d.units_sold,0) as units_sold,
      (coalesce(d.units_sold,0)::numeric / cfg.velocity_window_days) as velocity,
      coalesce(v.lead_time_days, cfg.lead_time_days) as lead_used,
      v.reorder_point as manual_rp,
      v.reorder_qty   as manual_rq,
      cfg.*
      from vars v
      left join bal    b on b.variant_id = v.id
      left join demand d on d.variant_id = v.id
     cross join cfg
  ),
  sib as (
    select b.id,
           (select percentile_disc(0.5) within group (order by s.velocity)
              from base s
             where s.product_id = b.product_id
               and coalesce(s.size,'') = coalesce(b.size,'')
               and s.id <> b.id) as sib_median,
           (select count(*) from base s
             where s.product_id = b.product_id
               and coalesce(s.size,'') = coalesce(b.size,'')
               and s.id <> b.id) as sib_count
      from base b
  )
  select
    b.id, b.product_id, b.product_name, b.sku, b.color, b.size,
    b.on_hand, b.reserved, b.available, b.units_sold,
    round(b.velocity, 4),
    case when b.velocity > 0 then round(b.available / b.velocity, 2) end,
    b.lead_used,
    case
      when b.manual_rp is not null then b.manual_rp
      when b.velocity > 0 then ceil(b.velocity * (b.lead_used + b.safety_days))::int
    end,
    case
      when b.manual_rp is not null then 'manual'
      when b.velocity > 0          then 'derived'
    end,
    case
      when b.velocity <= 0 then null
      when b.manual_rq is not null then b.manual_rq
      else greatest(ceil(b.velocity * (b.cover_target_days + b.lead_used))::int - b.available, 0)
    end,
    -- 067: not_tracked comes FIRST. A variant nothing was ever received
    -- into is not an emergency; it is a catalogue entry.
    case
      when not b.has_balance then 'not_tracked'
      when b.available <= 0  then 'out'
      when b.velocity  <= 0  then 'no_data'
      when b.available <= coalesce(b.manual_rp, ceil(b.velocity * (b.lead_used + b.safety_days))::int) then 'reorder'
      when (b.available / b.velocity) <= b.cover_target_days then 'low'
      else 'ok'
    end,
    (
      b.velocity > 0
      and b.units_sold >= b.breakout_min_units
      and s.sib_count  >= b.breakout_min_siblings
      and (coalesce(s.sib_median, 0) = 0 or b.velocity >= s.sib_median * b.breakout_multiple)
    ),
    round(coalesce(s.sib_median, 0), 4),
    case when coalesce(s.sib_median,0) > 0 then round(b.velocity / s.sib_median, 2) end
  from base b
  join sib s on s.id = b.id
$fn$;

-- Defect 2. Explicit, not inherited.
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from public;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from anon;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from authenticated;

revoke execute on function wholesale_v2.v2_inventory_signals(text) from public;
revoke execute on function wholesale_v2.v2_inventory_signals(text) from anon;
grant  execute on function wholesale_v2.v2_inventory_signals(text) to authenticated;
