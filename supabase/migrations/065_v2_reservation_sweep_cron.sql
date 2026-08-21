-- =====================================================================
-- 065 — Actually schedule the sweep migration 001 asked for
--
-- 001 shipped v2_release_expired_reservations() with the comment "call
-- from pg_cron every 1-5 min". pg_cron was never installed and nothing
-- ever called it. 064 made availability correct WITHOUT a sweeper, on
-- purpose — a scheduler is a tidiness mechanism, not a correctness one.
-- This file adds the tidiness half: it stops v2_stock_reservations from
-- growing unbounded and keeps the qty_reserved counter converged with
-- the live view.
--
-- If this file fails to apply (permissions, extension unavailable),
-- NOTHING breaks. Stock stays sellable and the numbers stay honest;
-- dead rows just accumulate. That separation is deliberate.
--
-- Verify with:  select jobid, jobname, schedule, active from cron.job;
--               select * from cron.job_run_details order by start_time desc limit 5;
-- =====================================================================

-- Batch 7 (21 Aug 2026): wrapped in a guard, to match what the header above
-- already promises.
--
-- This file used to run `create extension if not exists pg_cron;` bare. On
-- Supabase that works. On a plain Postgres the extension is not available, the
-- statement raises, and -- under `psql -v ON_ERROR_STOP=1`, which is how you
-- replay a migration chain -- EVERYTHING AFTER THIS FILE IS SKIPPED. So a file
-- whose own header says "if this fails, nothing breaks" was in fact the thing
-- that stopped the repo rebuilding the product from migration 065 onward.
--
-- Now: if pg_cron is unavailable it says so and moves on. The distinction that
-- makes this safe is the one migration 064 established -- availability is
-- correct at READ TIME whether or not any sweeper ever runs. Missing the cron
-- job costs tidiness (dead reservation rows accumulate), never correctness.
-- It is a NOTICE and not silence, because a Supabase project that somehow
-- lacks pg_cron should tell someone rather than quietly skip its housekeeping.
do $cron_guard$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice '065: pg_cron is not available here (%). The sweep is NOT scheduled. Availability is still correct -- migration 064 filters expired holds at read time -- but v2_stock_reservations will accumulate dead rows until something calls v2_release_expired_reservations().', sqlerrm;
    return;
  end;

  -- Idempotent: drop any previous incarnation before scheduling.
  perform cron.unschedule('v2-release-expired-reservations')
   where exists (select 1 from cron.job where jobname = 'v2-release-expired-reservations');

  perform cron.schedule(
    'v2-release-expired-reservations',
    '*/2 * * * *',
    $cron$select wholesale_v2.v2_release_expired_reservations();$cron$
  );
  raise notice '065: sweep scheduled every 2 minutes.';
end;
$cron_guard$;
