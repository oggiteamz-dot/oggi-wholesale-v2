-- =====================================================================
-- 068 — Make the breakout alert's SILENCE explainable
--
-- WHAT REAL DATA SHOWED
-- After 067, every production wholesaler reported zero breakouts. That looked
-- like a broken feature. It is not -- and the reason matters more than the fix.
--
-- The breakout alert asks a specific question: "is one COLOURWAY of this
-- garment outselling its siblings?" It compares variants sharing a product and
-- a size. On the `demo` catalogue, DEMO-1-M (Black) sells 4.87/day against
-- Navy 1.60, Olive 1.33, Sand 1.07, Cream 1.07 and Crimson 0.87 -- a textbook
-- breakout, and exactly the "blue tee flying off the shelf" case v1 caught.
--
-- It does not fire because those six colours are six separate PRODUCTS, each
-- with one colour and two sizes. Under (product, size), DEMO-1-M has zero
-- siblings. The comparison the alert needs does not exist in that catalogue's
-- shape.
--
-- WHY THE SCOPE IS NOT BEING BROADENED
-- The tempting fix is to compare a variant against every other variant of the
-- same size across the whole catalogue. That would make the alert fire -- and
-- it would be worthless. "Your best-selling product sells more than your
-- average product" is a tautology, not an insight, and it would fire on the
-- same handful of SKUs forever. An alert that is always right and never useful
-- is how alerting dies.
--
-- Nor can colours-modelled-as-products be detected reliably: inferring that
-- DEMO-1 and DEMO-2 are the same garment from name prefixes would be a guess,
-- and a wrong guess here silently compares unrelated items.
--
-- So the scope stays strict and honest. What changes is that the UI can now
-- TELL the wholesaler why there is nothing to see: sibling_count = 0 means
-- "no other colourway of this garment to compare against", which is a fact
-- about their catalogue, not a failure of the tool. Reporting "no breakouts"
-- and reporting "nothing comparable exists" look identical on screen and mean
-- completely different things -- the same distinction 067 had to make between
-- "sold out" and "never stocked". The wholesaler can act on this one: model
-- colourways as variants of one product and the alert starts working.
-- =====================================================================

-- A composite type's shape cannot be altered in place while functions depend
-- on it, so both functions are dropped and rebuilt around the new type. The
-- column list still lives in exactly ONE place.
drop function if exists wholesale_v2.v2_inventory_signals(text);
drop function if exists wholesale_v2.v2_inventory_signals_for(text);
drop type     if exists wholesale_v2.v2_inventory_signal;

create type wholesale_v2.v2_inventory_signal as (
  variant_id uuid, product_id uuid, product_name text, sku text,
  color text, size text,
  on_hand int, reserved int, available int, units_sold int,
  velocity_per_day numeric, days_of_cover numeric, lead_time_days_used int,
  reorder_point int, reorder_point_source text, suggested_qty int,
  status text, is_breakout boolean,
  sibling_median_velocity numeric, breakout_ratio numeric,
  -- 068: how many colourways of the same garment and size this was compared
  -- against. 0 means the comparison was impossible, which is a different
  -- statement from "compared, and nothing stood out".
  sibling_count int
);

comment on type wholesale_v2.v2_inventory_signal is
  'Migrations 066/067/068. One row per active variant: what it is, what is on '
  'the shelf, how fast it moves, when to reorder, where that reorder number '
  'came from, and whether it is outselling its sibling colourways. Declared '
  'once and shared by both signal functions so the two cannot drift apart.';

create function wholesale_v2.v2_inventory_signals_for(p_wid text)
returns setof wholesale_v2.v2_inventory_signal
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  with cfg as (
    -- Zero setup: with no settings row this still yields exactly one row,
    -- made of defaults. Configuration tunes the signal; it is never
    -- required to create one.
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
    -- The LIVE view (064), never the raw balances table. A phantom
    -- "reserved" here becomes a wrong buying decision.
    select b.variant_id,
           sum(b.qty_on_hand)::int   as on_hand,
           sum(b.qty_reserved)::int  as reserved,
           sum(b.qty_available)::int as available
      from v2_inventory_balances_live b
      join vars v on v.id = b.variant_id
     group by b.variant_id
  ),
  demand as (
    -- Real demand only. A cancelled order is not demand.
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
      -- 067: absence of a balance row is information, not a zero.
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
    -- Sibling colourways: same product, same size. Comparing Red M to
    -- Blue M isolates the colour effect, which is the entire point.
    -- Red M against Blue XXL would just measure size-mix noise.
    -- Zero-velocity siblings are included on purpose: a colourway that
    -- sells nothing is real evidence about the group.
    -- percentile_disc, not _cont: returns a velocity one of these
    -- colourways actually has, rather than an interpolation no colourway
    -- ever achieved — this number is shown to a human.
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
    -- An explicit reorder point always wins; otherwise derive it from the
    -- demand expected during the restock lead time, plus a buffer. Never
    -- invented where there is no demand data.
    case
      when b.manual_rp is not null then b.manual_rp
      when b.velocity > 0 then ceil(b.velocity * (b.lead_used + b.safety_days))::int
    end,
    case
      when b.manual_rp is not null then 'manual'
      when b.velocity > 0          then 'derived'
    end,
    -- Order-up-to: cover the lead time AND land on the cover target once
    -- it arrives, less what is on the shelf now.
    case
      when b.velocity <= 0 then null
      when b.manual_rq is not null then b.manual_rq
      else greatest(ceil(b.velocity * (b.cover_target_days + b.lead_used))::int - b.available, 0)
    end,
    -- not_tracked comes FIRST: a variant nothing was ever received into
    -- is a catalogue entry, not an emergency.
    case
      when not b.has_balance then 'not_tracked'
      when b.available <= 0  then 'out'
      when b.velocity  <= 0  then 'no_data'
      when b.available <= coalesce(b.manual_rp, ceil(b.velocity * (b.lead_used + b.safety_days))::int) then 'reorder'
      when (b.available / b.velocity) <= b.cover_target_days then 'low'
      else 'ok'
    end,
    -- Three guards, all required, so this stays a signal instead of noise:
    -- enough absolute sales to mean anything, enough siblings to compare
    -- against, and either it beats the sibling median by the multiple or
    -- every sibling is dead and this one is not.
    (
      b.velocity > 0
      and b.units_sold >= b.breakout_min_units
      and s.sib_count  >= b.breakout_min_siblings
      and (coalesce(s.sib_median, 0) = 0 or b.velocity >= s.sib_median * b.breakout_multiple)
    ),
    round(coalesce(s.sib_median, 0), 4),
    case when coalesce(s.sib_median,0) > 0 then round(b.velocity / s.sib_median, 2) end,
    s.sib_count::int
  from base b
  join sib s on s.id = b.id

$fn$;

revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from public;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from anon;
revoke execute on function wholesale_v2.v2_inventory_signals_for(text) from authenticated;

comment on function wholesale_v2.v2_inventory_signals_for(text) is
  'Migrations 066/067/068. INTERNAL computation for the inventory signal. '
  'Execute is revoked from public, anon and authenticated so it cannot be '
  'called with another wholesaler''s wid -- call v2_inventory_signals(). Kept '
  'separate so checks/check_intelligence_zero_setup.sql can exercise the real '
  'behaviour without simulating an auth session.';

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
  -- A wholesaler always gets their own data. Only an owner may name someone
  -- else's, and only explicitly.
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

revoke execute on function wholesale_v2.v2_inventory_signals(text) from public;
revoke execute on function wholesale_v2.v2_inventory_signals(text) from anon;
grant  execute on function wholesale_v2.v2_inventory_signals(text) to authenticated;

comment on function wholesale_v2.v2_inventory_signals(text) is
  'Migrations 066/067/068. Public entry point for Inventory Intelligence. '
  'Resolves the caller''s own wid; p_wid is honoured only for owners. Works '
  'with no v2_inventory_settings row at all.';
