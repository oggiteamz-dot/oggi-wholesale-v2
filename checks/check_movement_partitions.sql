-- ============================================================================
-- check_movement_partitions.sql — guards migration 074
--
-- THE BUG THIS EXISTS FOR (found 21 Aug 2026):
--   v2_inventory_movements is RANGE-partitioned on created_at. Production had
--   exactly ONE partition:
--       v2_inventory_movements_2026_08  FROM 2026-08-01 TO 2026-09-01
--   and nothing anywhere created the next one.
--
--   At 00:00 on 1 September 2026 every write to the ledger would have begun
--   raising "no partition of relation found for row". Every stock RPC writes
--   to the ledger, so receiving, selling, transferring, adjusting, cycle
--   counting and kit assembly would ALL have stopped, platform-wide, at
--   midnight, eleven days after this was found.
--
--   It was discovered by accident: a Batch 3 test fixture tried to insert a
--   movement dated a year ago. Nothing in the application would have revealed
--   it until the night it fired.
--
-- THE RULES:
--   1. There is always a comfortable runway of future partitions. Six months
--      is the floor -- enough that a failed monthly job is a nuisance rather
--      than a countdown.
--   2. The DEFAULT partition is always EMPTY. It exists so a stock write can
--      never fail outright, but a safety net that is silently in use is its
--      own hazard: if a row ever lands there, the runway logic has failed and
--      somebody needs to know.
--   3. The current month always has its own partition.
--
-- RED-PROVEN against a database at migration 073 (one partition, no default):
--   "ASSERT 1 FAILED: only 0 future monthly partitions"
--
-- Run:  psql <conn> -f checks/check_movement_partitions.sql
-- Read-only. Writes nothing.
-- ============================================================================
begin;

do $check$
declare
  v_future int;
  v_default_rows bigint;
  v_has_default boolean;
  v_has_current boolean;
  v_last text;
  rep text := '';
begin
  -- How many partitions cover months AFTER the current one?
  select count(*) into v_future
    from pg_class c
    join pg_inherits i on i.inhrelid = c.oid
   where i.inhparent = 'wholesale_v2.v2_inventory_movements'::regclass
     and c.relname ~ '\d{4}_\d{2}$'
     and to_date(substring(c.relname from '\d{4}_\d{2}$'), 'YYYY_MM')
         > date_trunc('month', now())::date;

  select max(substring(c.relname from '\d{4}_\d{2}$')) into v_last
    from pg_class c join pg_inherits i on i.inhrelid = c.oid
   where i.inhparent = 'wholesale_v2.v2_inventory_movements'::regclass
     and c.relname ~ '\d{4}_\d{2}$';

  if v_future < 6 then
    raise exception
      'ASSERT 1 FAILED: only % future monthly partitions (last is %). Every stock movement stops when the runway runs out.',
      v_future, coalesce(v_last, 'none');
  end if;
  rep := rep || format(E'\n 1 ok  %s future monthly partitions, runway to %s', v_future, v_last);

  -- The current month must be covered, or writes are failing right now.
  select exists (
    select 1 from pg_class c join pg_inherits i on i.inhrelid = c.oid
     where i.inhparent = 'wholesale_v2.v2_inventory_movements'::regclass
       and c.relname = 'v2_inventory_movements_' || to_char(now(), 'YYYY_MM')
  ) into v_has_current;
  if not v_has_current then
    raise exception 'ASSERT 2 FAILED: there is no partition for the CURRENT month -- stock movements are failing right now';
  end if;
  rep := rep || E'\n 2 ok  the current month has its own partition';

  -- The default partition must exist...
  select exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2' and c.relname = 'v2_inventory_movements_default'
  ) into v_has_default;
  if not v_has_default then
    raise exception 'ASSERT 3 FAILED: no DEFAULT partition -- an out-of-range write would fail outright instead of being caught';
  end if;
  rep := rep || E'\n 3 ok  a default partition exists, so no stock write can simply fail';

  -- ...and must be empty. This is the one that turns a silent net into a loud one.
  execute 'select count(*) from wholesale_v2.v2_inventory_movements_default' into v_default_rows;
  if v_default_rows <> 0 then
    raise exception
      'ASSERT 4 FAILED: the DEFAULT partition holds % row(s). It exists to prevent an outage, not to be used -- the runway logic has failed.',
      v_default_rows;
  end if;
  rep := rep || E'\n 4 ok  the default partition is empty (it is a net, not a destination)';

  raise exception E'ROLLBACK_WITH_REPORT%\n --- check_movement_partitions: 4/4 PASSED ---', rep;
end
$check$;

rollback;
