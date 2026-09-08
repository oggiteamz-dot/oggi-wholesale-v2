-- 130 — OGGI sells here, and the platform can finally say which store is its own
--
-- HADI, 8 Sep 2026, answering the question that had been open since the
-- marketplace was built:
--
--   "we do sell"
--
-- and, on where those products appear:  IN THE ORDINARY RESULTS, LABELLED.
--
-- ==== THIS MIGRATION IS THE SECOND HALF OF A PROMISE ======================
--
-- js/views/ranking-policy.js is a page every wholesaler can read, and until
-- today it said, in bold:
--
--   "OGGI does not sell any products on this platform. There is no OGGI-owned
--    brand here, AND NOTHING IN THE SYSTEM THAT COULD MARK ONE."
--
-- That last clause is what this migration ends. It also promised: "This page
-- will say so BEFORE it happens, not afterwards."
--
-- ⭐ SO THE PAGE WAS REWRITTEN FIRST, IN THE SAME PULL REQUEST, AND
-- checks/check_oggi_sells_in_order.sh EXISTS TO KEEP THAT ORDER TRUE FOREVER:
-- it goes red if a store is ever marked first-party and holds public products
-- while the page still tells wholesalers that OGGI sells nothing. Intending
-- the right order is not the same as being unable to get it wrong.
--
-- ==== WHY A FLAG ON v2_wholesalers AND NOT A NEW KIND OF THING ============
--
-- The OGGI store is a wholesaler row like any other. Every tenant-isolation
-- rule already written -- 125's partition doors, check_tenant_isolation,
-- check_partition_isolation, the whole LINK block -- then covers it with no
-- exceptions, and exceptions are where leaks live. A separate "first-party
-- product" table would need every one of those rules restated, and the restated
-- copy is the one that drifts.
--
-- ==== AT MOST ONE ========================================================
--
-- Two first-party stores is a labelling rule with an ambiguity in it: "OGGI's
-- own" stops naming one thing. The partial unique index makes a second one
-- impossible to store rather than merely discouraged.

alter table wholesale_v2.v2_wholesalers
  add column if not exists is_first_party boolean not null default false;

comment on column wholesale_v2.v2_wholesalers.is_first_party is
  'True for the ONE store OGGI itself sells from. Since 8 Sep 2026 OGGI sells '
  'on this platform and its products appear in the ordinary results, labelled '
  '-- so this column is what every buyer-facing surface reads to draw that '
  'label. It is never an input to ordering: checks/check_oggi_ranking_is_blind '
  'asserts that setting it cannot move a single product.';

create unique index if not exists v2_wholesalers_one_first_party
  on wholesale_v2.v2_wholesalers ((true)) where is_first_party;

-- ⭐ NOBODY IS MARKED BY THIS MIGRATION, AND THAT IS DELIBERATE.
--
-- Marking a store is a business act with a date attached -- the day OGGI starts
-- selling -- and it belongs to whoever performs it, not to a migration that
-- happens to run at some point during a deploy. The column ships at false for
-- all thirteen existing stores, the page already tells wholesalers what will
-- happen, and the gate holds the order.

do $$
declare n int; m int;
begin
  select count(*) into n from wholesale_v2.v2_wholesalers;
  select count(*) into m from wholesale_v2.v2_wholesalers where is_first_party;

  if m > 0 then
    raise exception '130: % store(s) came out of this migration already marked first-party. This migration marks nobody -- marking is a dated business act, not a deploy side effect.', m;
  end if;

  -- ⚠️ THE SELF-TEST BUILDS ITS OWN TWO STORES, AND THAT IS THE 116/119 RULE.
  --
  -- The first draft of this block marked "the first two wholesalers, whichever
  -- they are" and expected a unique violation. On production, with thirteen
  -- stores, it passed. On an EMPTY replay it marked nothing, no violation was
  -- raised, and the migration refused to apply -- correctly, because the test
  -- was asserting something about the DATA IT HAPPENED TO FIND rather than
  -- about the CHANGE IT MAKES. That is the exact rule 116 was corrected for and
  -- 119 broke again the next day, and it took the replay about four seconds to
  -- catch it a third time.
  --
  -- Two rows of its own, in a subtransaction, rolled back either way: the same
  -- statement on an empty database and on a full one.
  begin
    insert into public.wholesalers (wid, name, active)
      values ('zz130a', 'Index Probe A', false), ('zz130b', 'Index Probe B', false);
    insert into wholesale_v2.v2_wholesalers (wid, name, is_first_party)
      values ('zz130a', 'Index Probe A', true), ('zz130b', 'Index Probe B', true);
    raise exception '130: TWO stores were marked first-party at once. The one-store index is not doing its job, and "OGGI''s own" would stop naming one thing.';
  exception
    when unique_violation then null;   -- correct: the second one is impossible
  end;

  -- And the probe rows left nothing behind. The subtransaction above rolls back
  -- on the exception, but saying so out loud is cheaper than the afternoon
  -- somebody spends wondering what Index Probe A is.
  if exists (select 1 from wholesale_v2.v2_wholesalers where wid in ('zz130a','zz130b'))
     or exists (select 1 from public.wholesalers where wid in ('zz130a','zz130b')) then
    raise exception '130: the index probe left rows behind';
  end if;

  raise notice '130 ok: % store(s) exist, none is marked, and a second first-party store cannot be stored', n;
end $$;
