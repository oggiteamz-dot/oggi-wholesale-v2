-- =============================================================================
-- check_ranking_config_versioned.sql — SR-07
-- =============================================================================
-- THE QUESTION: "if somebody changes what the recommendation shelves do, does
-- the system still know it happened, who did it, and what it was before?"
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_ranking_config_versioned.sql <db>
--
-- Everything runs inside a transaction that ROLLS ITSELF BACK. A pass raises
-- ROLLBACK_WITH_REPORT carrying the report; nothing is written, so this file is
-- safe to run against PRODUCTION and that is the point -- migration 101
-- deliberately contains no behavioural self-test, because an append-only
-- evidence table must not be seeded with fabricated changes by its own
-- installer. This file is where the behaviour is proven instead.
--
-- ⚠️ A runner that reads only psql's exit code will mark a PASS as a failure.
-- Two gates in this repo spent days on the "known failures" list for exactly
-- that reason. Look for ROLLBACK_WITH_REPORT in the output.
--
-- ==== SENTINEL FIRST =======================================================
-- Assertion 0 is a sentinel that must ALWAYS appear in the report. A red proof
-- that produces no failures has proven nothing until you know the gate ran at
-- all -- deleting lines to break the code can produce a syntax error, and a
-- crashed gate and a blind gate look identical from outside. If the sentinel
-- line is missing from the output, the run is void whatever else it says.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  rep         text := '';
  fails       int  := 0;
  n           int;
  v_owner     uuid;
  v_made_user boolean := false;
  v_before    timestamptz;
  v_old       int;
  v_ok        boolean;
  v_msg       text;
  v_src       text;
  r           record;
procedure_placeholder boolean;
begin
  -- helper: record a result line
  -- (inline rather than a function, so this file installs nothing at all)

  -- ---------------------------------------------------------------- 0 -------
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  -- ---------------------------------------------------------------- 1 -------
  -- The record is closed to the browser roles. The schema's standing default
  -- privileges hand every new table to `authenticated`, so this is not
  -- paranoia: it is the exact defect migration 098 had to correct, and the
  -- shape hash the replay compares does NOT cover permissions.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2'
     and table_name in ('v2_ranking_config','v2_ranking_config_history',
                        'v2_ranking_model','v2_ranking_model_snapshot')
     and grantee in ('anon','authenticated','PUBLIC');
  if n = 0 then rep := rep || E'\n 1  ok   the ranking record holds no table key for anon or authenticated';
  else fails := fails+1; rep := rep || format(E'\n 1  FAIL the browser roles hold %s grant(s) on the ranking tables', n); end if;

  -- ---------------------------------------------------------------- 2 -------
  -- A CHANGE MADE THE WAY EVERY CHANGE HAS ACTUALLY BEEN MADE -- a plain
  -- UPDATE, as if typed into the Supabase SQL editor -- is recorded. This is
  -- the assertion the whole design exists for: an application-level audit
  -- would record nothing here and look perfectly healthy doing it.
  select c.int_value into v_old from wholesale_v2.v2_ranking_config c where c.key='popular_min_buyers';
  update wholesale_v2.v2_ranking_config set int_value = v_old + 7, updated_at = now()
   where key = 'popular_min_buyers';

  select count(*) into n from wholesale_v2.v2_ranking_config_history h
   where h.key='popular_min_buyers' and h.op='update'
     and h.old_int = v_old and h.new_int = v_old + 7;
  if n = 1 then rep := rep || format(E'\n 2  ok   a hand-typed UPDATE was recorded, %s -> %s, with the OLD value kept', v_old, v_old+7);
  else fails := fails+1; rep := rep || format(E'\n 2  FAIL a hand-typed UPDATE produced %s matching history row(s) — the SQL editor is the only writer this system has ever had', n); end if;

  -- ---------------------------------------------------------------- 3 -------
  -- ...and it is recorded HONESTLY as having no named human behind it, rather
  -- than being attributed to whoever happens to be convenient.
  select count(*) into n from wholesale_v2.v2_ranking_config_history h
   where h.key='popular_min_buyers' and h.op='update' and h.new_int = v_old+7
     and h.actor_source='database' and h.actor_id is null and h.actor_role is not null;
  if n = 1 then rep := rep || E'\n 3  ok   a database-side change is recorded as having no named human, not as an invented one';
  else fails := fails+1; rep := rep || E'\n 3  FAIL a database-side change was not recorded honestly'; end if;

  -- ---------------------------------------------------------------- 4 -------
  -- A no-op UPDATE is NOT an event. Without this the timeline fills with rows
  -- saying a number changed to itself, and a timeline nobody can read is the
  -- same thing as not having one.
  select count(*) into n from wholesale_v2.v2_ranking_config_history where key='popular_min_buyers';
  update wholesale_v2.v2_ranking_config set updated_at = now() where key = 'popular_min_buyers';
  select count(*) - n into n from wholesale_v2.v2_ranking_config_history where key='popular_min_buyers';
  if n = 0 then rep := rep || E'\n 4  ok   touching a row without changing a value recorded nothing';
  else fails := fails+1; rep := rep || format(E'\n 4  FAIL a no-op update added %s history row(s)', n); end if;

  -- ---------------------------------------------------------------- 5 -------
  -- The record cannot be rewritten. Both directions: UPDATE and DELETE.
  begin
    update wholesale_v2.v2_ranking_config_history set new_int = 999
     where id = (select min(id) from wholesale_v2.v2_ranking_config_history);
    fails := fails+1; rep := rep || E'\n 5a FAIL the history accepted an UPDATE — it is a diary, not evidence';
  exception when others then
    rep := rep || E'\n 5a ok   the history refused an UPDATE';
  end;
  begin
    delete from wholesale_v2.v2_ranking_config_history
     where id = (select min(id) from wholesale_v2.v2_ranking_config_history);
    fails := fails+1; rep := rep || E'\n 5b FAIL the history accepted a DELETE';
  exception when others then
    rep := rep || E'\n 5b ok   the history refused a DELETE';
  end;

  -- ---------------------------------------------------------------- 6 -------
  -- The chain verifies as it stands.
  select count(*) into n from wholesale_v2.v2_ranking_history_verify();
  if n = 0 then rep := rep || E'\n 6  ok   the hash chain verifies end to end';
  else fails := fails+1; rep := rep || format(E'\n 6  FAIL the hash chain reports %s problem row(s)', n); end if;

  -- ---------------------------------------------------------------- 7 -------
  -- AND IT ACTUALLY DETECTS TAMPERING. A verifier that has only ever returned
  -- "fine" is not a verifier. The only way to plant a bad row is to switch the
  -- chaining trigger off, which is exactly what a person tampering would do,
  -- and it is safe here because the whole transaction is thrown away.
  alter table wholesale_v2.v2_ranking_config_history disable trigger trg_v2_rch_chain;
  insert into wholesale_v2.v2_ranking_config_history
    (key, op, new_int, actor_role, actor_source, prev_hash, row_hash)
  values ('popular_min_buyers','update', 4242, 'tamper', 'database',
          md5('not the real head'), md5('not the real hash'));
  alter table wholesale_v2.v2_ranking_config_history enable trigger trg_v2_rch_chain;

  select count(*) into n from wholesale_v2.v2_ranking_history_verify();
  if n > 0 then rep := rep || format(E'\n 7  ok   a planted row was DETECTED (%s problem row(s) reported)', n);
  else fails := fails+1; rep := rep || E'\n 7  FAIL a row inserted with a forged hash verified clean — the chain proves nothing'; end if;

  -- ---------------------------------------------------------------- 8 -------
  -- Everything below needs an owner, because every reader is owner-gated.
  -- Production has one; a bare replay does not, so make one and let the
  -- rollback take it away.
  select p.id into v_owner from wholesale_v2.v2_user_profiles p where p.role='owner' limit 1;
  if v_owner is null then
    v_owner := '00000000-0000-4000-8000-00000000ffff';
    begin insert into auth.users (id) values (v_owner); exception when others then null; end;
    insert into wholesale_v2.v2_user_profiles (id, role, wholesaler_name, actor_label)
    values (v_owner, 'owner', 'Gate owner', 'gate-owner');
    v_made_user := true;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role','authenticated')::text, true);

  select count(*) into n from wholesale_v2.v2_ranking_config_list();
  if n > 0 then rep := rep || format(E'\n 8  ok   the owner can read the ranking numbers (%s of them)', n);
  else fails := fails+1; rep := rep || E'\n 8  FAIL the owner cannot read the ranking numbers'; end if;

  -- ---------------------------------------------------------------- 9 -------
  -- A CHANGE WITH NO REASON IS REFUSED.
  select s.ok, s.message into v_ok, v_msg
    from wholesale_v2.v2_ranking_config_set('popular_window_days', 60, null, '  ') s;
  if not v_ok then rep := rep || E'\n 9a ok   a change with no stated reason was refused';
  else fails := fails+1; rep := rep || E'\n 9a FAIL a ranking number changed with no reason recorded'; end if;

  -- AN UNKNOWN KEY IS REFUSED OUTRIGHT rather than quietly inserted. A typo
  -- that created a ninth row would leave the shelf reading its old value with
  -- a plausible config row sitting next to it.
  select count(*) into n from wholesale_v2.v2_ranking_config;
  select s.ok into v_ok from wholesale_v2.v2_ranking_config_set('populer_min_buyers', 9, null, 'a plausible typo') s;
  select count(*) - n into n from wholesale_v2.v2_ranking_config;
  if not v_ok and n = 0 then rep := rep || E'\n 9b ok   a typo''d key was refused and created nothing';
  else fails := fails+1; rep := rep || format(E'\n 9b FAIL a typo''d key was accepted (ok=%s, rows added=%s)', v_ok, n); end if;

  -- --------------------------------------------------------------- 10 -------
  -- A REAL CHANGE THROUGH THE APP names the human who made it and carries the
  -- reason. This is the difference between the two paths, and it must be
  -- visible in the record.
  select s.ok into v_ok from wholesale_v2.v2_ranking_config_set(
    'popular_window_days', 45, null, 'Gate: shortening the window to check the record.') s;
  select count(*) into n from wholesale_v2.v2_ranking_config_history h
   where h.key='popular_window_days' and h.new_int=45
     and h.actor_source='app' and h.actor_id = v_owner
     and h.reason = 'Gate: shortening the window to check the record.';
  if v_ok and n = 1 then rep := rep || E'\n10  ok   an app change is recorded with the human who made it and the reason they gave';
  else fails := fails+1; rep := rep || format(E'\n10  FAIL an app change was not attributed (ok=%s, matching rows=%s)', v_ok, n); end if;

  -- --------------------------------------------------------------- 11 -------
  -- THE QUESTION THE WHOLE THING EXISTS TO ANSWER.
  -- "What was the window before I changed it?" must come back as the OLD value
  -- even though the table now holds the new one. Reading the current table for
  -- this would be right by luck and wrong the moment it mattered.
  select h.changed_at - interval '1 second' into v_before
    from wholesale_v2.v2_ranking_config_history h
   where h.key='popular_window_days' and h.new_int=45 order by h.id desc limit 1;

  select a.int_value into n from wholesale_v2.v2_ranking_config_as_of(v_before) a
   where a.key='popular_window_days';
  select c.int_value into v_old from wholesale_v2.v2_ranking_config c where c.key='popular_window_days';
  if n = 90 and v_old = 45 then
    rep := rep || E'\n11  ok   as-of answers 90 for a moment before the change while the table now holds 45';
  else fails := fails+1; rep := rep || format(E'\n11  FAIL as-of returned %s for a date before the change (table now holds %s, expected 90 and 45)', coalesce(n,-1), coalesce(v_old,-1)); end if;

  -- --------------------------------------------------------------- 12 -------
  -- A key that did not exist on a date is not reported as having existed with
  -- no value. Asked for a moment before the record began, as-of returns
  -- nothing at all rather than eight rows of nulls.
  select count(*) into n from wholesale_v2.v2_ranking_config_as_of('2000-01-01'::timestamptz);
  if n = 0 then rep := rep || E'\n12  ok   as-of before the record began returns nothing, not a row of nulls';
  else fails := fails+1; rep := rep || format(E'\n12  FAIL as-of for the year 2000 returned %s row(s)', n); end if;

  -- --------------------------------------------------------------- 13 -------
  -- THE STRUCTURAL HALF. Every ranking function's live source must match its
  -- newest snapshot. This is what makes forgetting loud: change v2_popular_now
  -- in a future migration without recording it and this line names it.
  perform set_config('request.jwt.claims', '', true);
  for r in select m.fn_name as fname from wholesale_v2.v2_ranking_model m order by m.fn_name loop
    select h.src_hash into v_src from wholesale_v2.v2_ranking_model_hash(r.fname) h;
    select s.src_hash into v_msg from wholesale_v2.v2_ranking_model_snapshot s
      where s.fn_name = r.fname order by s.id desc limit 1;
    if v_src is not null and v_src = v_msg then
      rep := rep || format(E'\n13  ok   %s matches its newest recorded version', r.fname);
    else
      fails := fails+1;
      rep := rep || format(E'\n13  FAIL %s has changed and was never recorded — run: select * from wholesale_v2.v2_ranking_model_record(''why it changed'');', r.fname);
    end if;
  end loop;

  -- --------------------------------------------------------------- 14 -------
  -- The shelves still do not read the promotion table. Restated here rather
  -- than left to the RC gates, because SR-07 is the file somebody will read
  -- when they are asked whether ranking was neutral, and the answer must not
  -- depend on a different file having been run.
  for r in select m.fn_name as fname from wholesale_v2.v2_ranking_model m order by m.fn_name loop
    select p.prosrc into v_src from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='wholesale_v2' and p.proname = r.fname limit 1;
    if v_src ~* 'v2_oggi_promoted' then
      fails := fails+1;
      rep := rep || format(E'\n14  FAIL %s reads the promotion table — paid placement has entered a shelf that claims to be earned', r.fname);
    end if;
  end loop;
  if fails = 0 or rep !~ '14  FAIL' then
    rep := rep || E'\n14  ok   no ranking function reads the promotion table';
  end if;

  -- ---------------------------------------------------------------------------
  if fails > 0 then
    raise exception E'check_ranking_config_versioned: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_ranking_config_versioned: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
