-- =====================================================================
-- 074 ⛔ THE PLATFORM WOULD HAVE STOPPED ACCEPTING STOCK MOVEMENTS ON
--        1 SEPTEMBER 2026
--
-- Found 21 Aug 2026 while writing the Batch 3 valuation gate: a fixture
-- inserting a movement dated a year ago failed with
--
--     no partition of relation "v2_inventory_movements" found for row
--
-- v2_inventory_movements is RANGE-partitioned on created_at. Production
-- had exactly ONE partition:
--
--     v2_inventory_movements_2026_08   FROM 2026-08-01 TO 2026-09-01
--
-- and nothing anywhere creates the next one. The only scheduled job on
-- the database is the reservation sweep.
--
-- WHAT THAT MEANT
-- ---------------------------------------------------------------------
-- At 00:00 on 1 September 2026 -- eleven days after this was found --
-- every write to the movement ledger would have begun raising. And every
-- stock RPC writes to the ledger, so the failure is not cosmetic:
--
--     receiving stock            -> fails
--     submitting an order        -> fails (decrement writes a movement)
--     transferring between sites -> fails
--     adjustments, cycle counts,
--     kit assembly               -> fail
--
-- The entire inventory system stops, platform-wide, at midnight, with the
-- cause in a place nobody would think to look. Same family as the
-- reservation leak: infrastructure quietly guaranteeing a wrong outcome
-- while every screen looks fine -- except this one had a date on it.
--
-- It was found by accident. Nothing in the application would have
-- revealed it until the night it fired.
--
-- THE FIX: THREE INDEPENDENT LAYERS
-- ---------------------------------------------------------------------
-- The reservation leak taught the principle: a scheduler is a tidiness
-- mechanism, not a correctness mechanism. If correctness depends on cron
-- having run, every cron outage is silently an outage of the thing.
--
--   1. RUNWAY. Monthly partitions created now through the end of 2029.
--      Empty partitions cost essentially nothing, and this alone keeps
--      writes working for over three years even if layers 2 and 3 are
--      deleted tomorrow.
--
--   2. A DEFAULT PARTITION. The last-resort catch. If every range is
--      somehow exhausted the row lands here instead of the write failing.
--      An ordering system that refuses to record a sale is worse than one
--      that records it in an untidy place.
--
--   3. A MONTHLY JOB that tops the runway back up to 24 months ahead.
--
-- AND A GATE, because a silent safety net is its own hazard:
-- checks/check_movement_partitions.sql fails if the runway drops below
-- 6 months OR if the default partition holds any rows at all. The default
-- exists to prevent an outage, not to be used -- so the moment it is
-- used, something must say so out loud.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Idempotent partition maker. Safe to call any number of times.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_ensure_movement_partitions(p_months_ahead int default 24)
returns int
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_start   date := date_trunc('month', now())::date;
  v_month   date;
  v_name    text;
  v_created int := 0;
  i         int;
begin
  for i in 0..greatest(p_months_ahead, 1) loop
    v_month := (v_start + make_interval(months => i))::date;
    v_name  := format('v2_inventory_movements_%s', to_char(v_month, 'YYYY_MM'));

    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wholesale_v2' and c.relname = v_name
    ) then
      execute format(
        'create table wholesale_v2.%I partition of wholesale_v2.v2_inventory_movements
           for values from (%L) to (%L)',
        v_name, v_month, (v_month + interval '1 month')::date);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$fn$;

comment on function wholesale_v2.v2_ensure_movement_partitions(int) is
  'Migration 074. Creates any missing monthly partitions of '
  'v2_inventory_movements from the current month forward. Idempotent. Exists '
  'because production had ONE partition, ending 1 Sep 2026, and nothing to '
  'make the next -- every stock movement on the platform would have started '
  'failing that night.';

-- ---------------------------------------------------------------------
-- Layer 1: runway to the end of 2029.
-- ---------------------------------------------------------------------
select wholesale_v2.v2_ensure_movement_partitions(40);

-- ---------------------------------------------------------------------
-- Layer 2: the catch-all, so a write can never simply fail.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'wholesale_v2' and c.relname = 'v2_inventory_movements_default'
  ) then
    create table wholesale_v2.v2_inventory_movements_default
      partition of wholesale_v2.v2_inventory_movements default;
  end if;
end
$$;

comment on table wholesale_v2.v2_inventory_movements_default is
  'Migration 074. Last-resort catch for movement rows outside every declared '
  'monthly range. It exists so a stock write can never fail outright -- an '
  'ordering system that refuses to record a sale is worse than one that '
  'records it untidily. It should always be EMPTY: '
  'checks/check_movement_partitions.sql fails if it is not, because a silent '
  'safety net is its own hazard.';

-- ---------------------------------------------------------------------
-- Layer 3: keep the runway topped up. 03:10 on the 1st of each month.
-- pg_cron is Supabase-hosted; a plain Postgres replay skips this block.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'v2-ensure-movement-partitions',
      '10 3 1 * *',
      'select wholesale_v2.v2_ensure_movement_partitions(24);'
    );
  end if;
end
$$;
