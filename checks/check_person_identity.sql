-- =============================================================================
-- CHECK: one person, many stores (ID-01, migration 090)
-- =============================================================================
-- Runs inside a transaction and ROLLS BACK. It plants a fixture designed to
-- break the identity rule in both directions and asserts the outcome.
--
-- IT CALLS v2_backfill_person_identity() -- the REAL function the migration
-- calls -- rather than reimplementing the mapping. A gate that reimplements
-- the thing it checks passes while the thing is broken; this repo has two
-- recorded instances of exactly that.
--
-- THE PROPERTY UNDER TEST, in one sentence:
--   two logins that belong to the SAME human must collapse to one person with
--   two memberships, and two logins that belong to DIFFERENT humans must never
--   collapse, no matter how similar their contact details look.
--
-- The second half matters far more than the first. Failing to merge costs a
-- buyer a convenience. Merging wrongly hands one shop another shop's store
-- access, which is the worst thing this schema can do.
--
-- RUN:  psql <conn> -d <db> -f checks/check_person_identity.sql
-- =============================================================================
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_ident_a'; wB text := 'zz_ident_b'; wC text := 'zz_ident_c';
  cA uuid; cB uuid; cC uuid; cD uuid; cE uuid; cF uuid;
  aA uuid; aB uuid; aC uuid; aD uuid; aE uuid; aF uuid;
  n int; n2 int; pid1 uuid; pid2 uuid;
  function_result record;
begin
  -- ---------------------------------------------------------------- fixture --
  insert into public.wholesalers (wid, name) values
    (wA,'Ident A'),(wB,'Ident B'),(wC,'Ident C') on conflict do nothing;
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wC)
    on conflict do nothing;

  -- THE SAME HUMAN in two stores, phone written two different ways.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wA,'Boutique Farah','03 456 789') returning id into cA;
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wB,'Boutique Farah','+961 3 456 789') returning id into cB;

  -- THE SAME HUMAN again, this time matched on email with different casing.
  insert into wholesale_v2.v2_clients (wid, shop_name, email)
    values (wA,'Zahle Fashion','Lara@Zahle.com') returning id into cC;
  insert into wholesale_v2.v2_clients (wid, shop_name, email)
    values (wB,'Zahle Fashion',' lara@zahle.COM ') returning id into cD;

  -- TWO DIFFERENT HUMANS whose records both carry junk in the phone field.
  -- This is the dangerous case: if '0' and '-' normalise to anything, every
  -- record holding junk becomes one person.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wA,'Junk Shop One','0') returning id into cE;
  -- '0' and '00' are chosen deliberately: with the minimum-length guard in
  -- place both normalise to NULL and these stay two people. With the guard
  -- REMOVED both collapse to the string '961' and these two unrelated shops
  -- become one person -- which is precisely the failure this gate exists to
  -- catch. An earlier version of this fixture used '-', which normalises to
  -- NULL by a different route (no digits at all) and therefore never merged
  -- even with the guard gone: the assertion passed against broken code and
  -- proved nothing. The red proof is what exposed that.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wC,'Junk Shop Two','00') returning id into cF;

  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wA,cA,'buyer','zzfarah_a','x','Farah',true) returning id into aA;
  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wB,cB,'buyer','zzfarah_b','x','Farah',true) returning id into aB;
  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wA,cC,'buyer','zzlara_a','x','Lara',true) returning id into aC;
  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wB,cD,'buyer','zzlara_b','x','Lara',true) returning id into aD;
  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wA,cE,'buyer','zzjunk_one','x','Junk One',true) returning id into aE;
  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
    values (wC,cF,'buyer','zzjunk_two','x','Junk Two',true) returning id into aF;

  -- ------------------------------------------------- run the REAL backfill --
  select * into function_result from wholesale_v2.v2_backfill_person_identity();

  -- ============================ THE MERGE HALF =============================
  select pa.person_id into pid1 from wholesale_v2.v2_portal_accounts pa where pa.id = aA;
  select pa.person_id into pid2 from wholesale_v2.v2_portal_accounts pa where pa.id = aB;
  if pid1 is not null and pid1 = pid2 then
    PASS := PASS+1; raise notice '  PASS  same phone, two spellings, two stores -> ONE person';
  else
    FAIL := FAIL+1; raise warning '  FAIL  "03 456 789" and "+961 3 456 789" did NOT become the same person (% vs %)', pid1, pid2;
  end if;

  select count(*) into n from wholesale_v2.v2_person_memberships pm where pm.person_id = pid1;
  if n = 2 then
    PASS := PASS+1; raise notice '  PASS  that person holds membership in BOTH stores (this is the marketplace)';
  else
    FAIL := FAIL+1; raise warning '  FAIL  expected 2 memberships for the merged person, found %', n;
  end if;

  select pa.person_id into pid1 from wholesale_v2.v2_portal_accounts pa where pa.id = aC;
  select pa.person_id into pid2 from wholesale_v2.v2_portal_accounts pa where pa.id = aD;
  if pid1 is not null and pid1 = pid2 then
    PASS := PASS+1; raise notice '  PASS  same email, different case and padding -> ONE person';
  else
    FAIL := FAIL+1; raise warning '  FAIL  "Lara@Zahle.com" and " lara@zahle.COM " did NOT merge';
  end if;

  -- ============================ THE SPLIT HALF =============================
  -- The half that actually protects people.
  select pa.person_id into pid1 from wholesale_v2.v2_portal_accounts pa where pa.id = aE;
  select pa.person_id into pid2 from wholesale_v2.v2_portal_accounts pa where pa.id = aF;
  if pid1 is not null and pid2 is not null and pid1 <> pid2 then
    PASS := PASS+1; raise notice '  PASS  two records holding junk phones stayed TWO people';
  else
    FAIL := FAIL+1; raise warning '  FAIL  junk phone values merged two unrelated shops into one person -- each would see the other''s stores';
  end if;

  select count(*) into n from wholesale_v2.v2_person_channels ch
    where ch.raw in ('0','00');
  if n = 0 then
    PASS := PASS+1; raise notice '  PASS  junk created no channel at all';
  else
    FAIL := FAIL+1; raise warning '  FAIL  % junk channel(s) exist and are live join keys', n;
  end if;

  if wholesale_v2.v2_normalise_channel('phone','+1 555 010 0999')
     is distinct from wholesale_v2.v2_normalise_channel('phone','+961 555 010 0999') then
    PASS := PASS+1; raise notice '  PASS  a US number and a Lebanese number stay different people';
  else
    FAIL := FAIL+1; raise warning '  FAIL  a foreign number was re-interpreted as Lebanese';
  end if;

  -- =========================== THE INVARIANTS ==============================
  select count(*) into n from wholesale_v2.v2_portal_accounts where person_id is null;
  if n = 0 then
    PASS := PASS+1; raise notice '  PASS  every login has a person -- the backfill skipped nobody';
  else
    FAIL := FAIL+1; raise warning '  FAIL  % login(s) left with no person', n;
  end if;

  -- Idempotence: running it twice must change nothing.
  select count(*) into n from wholesale_v2.v2_people;
  perform wholesale_v2.v2_backfill_person_identity();
  select count(*) into n2 from wholesale_v2.v2_people;
  if n2 = n then
    PASS := PASS+1; raise notice '  PASS  running the backfill twice creates nobody new';
  else
    FAIL := FAIL+1; raise warning '  FAIL  the backfill is not idempotent -- a second run duplicated people';
  end if;

  select count(*) into n from (
    select person_id, wid, role from wholesale_v2.v2_person_memberships
     group by 1,2,3 having count(*) > 1) d;
  if n = 0 then
    PASS := PASS+1; raise notice '  PASS  no duplicate memberships';
  else
    FAIL := FAIL+1; raise warning '  FAIL  % duplicate membership(s)', n;
  end if;

  -- ===================== THE LOGIN MUST NOT HAVE MOVED =====================
  -- GP-02: nobody re-registers. The username indexes must be exactly as they were.
  select count(*) into n from pg_indexes
   where schemaname='wholesale_v2'
     and indexname in ('idx_v2_portal_accounts_buyer_username','idx_v2_portal_accounts_sales_username');
  if n = 2 then
    PASS := PASS+1; raise notice '  PASS  both username indexes intact -- no existing buyer must re-register';
  else
    FAIL := FAIL+1; raise warning '  FAIL  a username index went missing; existing logins would break';
  end if;

  -- ========================== THE CROSS-STORE LEAK =========================
  -- A wholesaler must not be able to learn that their buyer also buys elsewhere.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and grantee='anon'
     and table_name in ('v2_people','v2_person_channels','v2_person_memberships');
  if n = 0 then
    PASS := PASS+1; raise notice '  PASS  anon holds nothing on the identity tables';
  else
    FAIL := FAIL+1; raise warning '  FAIL  anon holds % grant(s) -- buyers ARE anon, so every person''s cross-store map is readable', n;
  end if;

  select count(*) into n from pg_policies
   where schemaname='wholesale_v2' and tablename='v2_people'
     and qual ilike '%v2_my_wid%';
  if n = 0 then
    PASS := PASS+1; raise notice '  PASS  the person row is not exposed per-wholesaler (no cross-store inference)';
  else
    FAIL := FAIL+1; raise warning '  FAIL  a wholesaler-scoped policy on v2_people would let a store enumerate its buyers'' other stores';
  end if;

  raise notice '----------------------------------------';
  raise notice 'check_person_identity: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then
    raise exception 'check_person_identity FAILED with % problem(s)', FAIL;
  end if;
end $$;

rollback;
