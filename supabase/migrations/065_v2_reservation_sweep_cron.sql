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

create extension if not exists pg_cron;

-- Idempotent: drop any previous incarnation before scheduling.
select cron.unschedule('v2-release-expired-reservations')
 where exists (select 1 from cron.job where jobname = 'v2-release-expired-reservations');

select cron.schedule(
  'v2-release-expired-reservations',
  '*/2 * * * *',
  $cron$select wholesale_v2.v2_release_expired_reservations();$cron$
);
