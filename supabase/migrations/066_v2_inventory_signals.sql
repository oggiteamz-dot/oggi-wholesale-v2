-- =====================================================================
-- 066 — Inventory Intelligence that works with zero configuration
--
-- WHAT WAS WRONG
-- Measured on production, 20 Aug 2026: 191 active variants, ZERO with a
-- reorder_point set. js/data/inventory-intelligence.js:59 filters on
--     v.reorderPoint != null && v.available <= v.reorderPoint
-- so getReorderSuggestions() returned an empty list for the ENTIRE
-- platform. A wholesaler who imports a catalogue and never opens
-- Pricing & MOQ gets a screen called "Inventory Intelligence" that reads
-- as working and does nothing. Worse than an empty state: an empty state
-- admits it has nothing to say. This implied it had looked and found no
-- problems, while a variant sat at 3.7 days of cover.
--
-- Same defect class as the reservation leak and discount_pct sitting dead
-- for two months: working software quietly producing a wrong answer.
--
-- THE PRINCIPLE
-- Configuration may TUNE a signal. It must never be required to CREATE
-- one. Order history and stock on hand already say a SKU is running out.
-- Derive the reorder point, let an explicit one win, and always say WHICH
-- of the two the number came from -- a number whose origin cannot be seen
-- gets ignored, and an ignored signal is the same as no signal.
--
-- WHY DEFAULTS MATCH THE OLD HARDCODED NUMBERS
-- velocity_window_days defaults to 90 and low_stock_threshold to 15 --
-- exactly the constants hardcoded in the client. Nothing any wholesaler
-- currently sees changes value on the day this ships; the numbers merely
-- become theirs to change.
--
-- THE ONE NUMBER THAT DOES CHANGE, DELIBERATELY
-- "Low stock" on the wholesaler's own screens stops meaning "15 units"
-- and starts meaning "less than cover_target days of stock left". A flat
-- unit count is meaningless across velocity classes: 15 units of a slow
-- mover is six months of cover, 15 of a fast mover is a week. The flat
-- threshold survives ONLY as the fallback where there is no demand
-- history and days-of-cover cannot be computed.
--
-- SUPERSEDED IN PART by 067 (not_tracked + grants) and 068 (sibling_count).
-- Kept as written so the history reads honestly; replaying 066 then 067
-- then 068 produces the correct end state.
-- =====================================================================

create table if not exists wholesale_v2.v2_inventory_settings (
  wid                    text primary key
                           references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  velocity_window_days   int     not null default 90  check (velocity_window_days between 7 and 730),
  lead_time_days         int     not null default 14  check (lead_time_days between 0 and 365),
  cover_target_days      int     not null default 30  check (cover_target_days between 1 and 730),
  safety_days            int     not null default 7   check (safety_days between 0 and 365),
  low_stock_threshold    int     not null default 15  check (low_stock_threshold >= 0),
  breakout_multiple      numeric not null default 1.5 check (breakout_multiple >= 1),
  breakout_min_siblings  int     not null default 3   check (breakout_min_siblings >= 1),
  breakout_min_units     int     not null default 5   check (breakout_min_units >= 1),
  updated_at             timestamptz not null default now()
);

alter table wholesale_v2.v2_inventory_settings enable row level security;

drop policy if exists v2_inventory_settings_read on wholesale_v2.v2_inventory_settings;
create policy v2_inventory_settings_read on wholesale_v2.v2_inventory_settings
  for select using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

drop policy if exists v2_inventory_settings_write on wholesale_v2.v2_inventory_settings;
create policy v2_inventory_settings_write on wholesale_v2.v2_inventory_settings
  for all using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid())
      with check (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

comment on table wholesale_v2.v2_inventory_settings is
  'Migration 066. Per-wholesaler tuning for the inventory signal. A missing '
  'row is a fully supported state and behaves exactly like a row of defaults '
  '-- v2_inventory_signals_for() coalesces against the defaults rather than '
  'requiring a row to exist. Defaults deliberately reproduce the constants '
  'previously hardcoded in the client (90-day window, 15-unit low threshold) '
  'so shipping this changes no number a wholesaler is currently looking at.';

-- The row shape is declared ONCE, as a named composite type, and both
-- functions return `setof` it. Writing the 20-column list twice would be
-- the same duplication that left this codebase with the HTML-escape helper
-- in ten copies under four names, drifting apart.
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'wholesale_v2' and t.typname = 'v2_inventory_signal'
  ) then
    create type wholesale_v2.v2_inventory_signal as (
      variant_id uuid, product_id uuid, product_name text, sku text,
      color text, size text,
      on_hand int, reserved int, available int, units_sold int,
      velocity_per_day numeric, days_of_cover numeric, lead_time_days_used int,
      reorder_point int, reorder_point_source text, suggested_qty int,
      status text, is_breakout boolean,
      sibling_median_velocity numeric, breakout_ratio numeric
    );
  end if;
end
$$;

drop function if exists wholesale_v2.v2_inventory_signals(text);
drop function if exists wholesale_v2.v2_inventory_signals_for(text);

create function wholesale_v2.v2_inventory_signals_for(p_wid text)
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
    case
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

revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from public;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from anon;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from authenticated;

create function wholesale_v2.v2_inventory_signals(p_wid text default null)
returns setof wholesale_v2.v2_inventory_signal
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
  return query select * from wholesale_v2.v2_inventory_signals_for(v_wid);
end;
$fn$;

grant execute on function wholesale_v2.v2_inventory_signals(text) to authenticated;
