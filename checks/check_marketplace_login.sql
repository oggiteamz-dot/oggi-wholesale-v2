-- =============================================================================
-- CHECK: the marketplace front door (ID-03, ID-09, ID-02, migration 096)
-- =============================================================================
-- Transaction + ROLLBACK. Calls the real functions against a real fixture.
--
-- THIS FILE GUARDS A LOGIN, so it is written to a higher bar than the others
-- and the ordering is deliberate: the two assertions that would matter most if
-- they broke come first, before any convenience is checked.
--
--   1. THE ENUMERATION RULE. An unknown phone number and a wrong password must
--      be indistinguishable from outside. The identifiers here are phone
--      numbers out of wholesalers' client lists; a login that answers "is this
--      number an OGGI buyer?" is a directory of their customers with extra
--      steps, available to anyone, one request at a time.
--
--   2. THE SESSION ACTUALLY ENDS. Expired and revoked sessions must resolve to
--      nobody. This is the entire reason ID-02 was pulled out of Phase 7: a
--      person-level session that never expires is a wider hole than the
--      per-store one it replaces.
--
-- And one that is easy to forget and expensive to get wrong:
--
--   3. GP-02 — NOBODY IS FORCED TO RE-REGISTER. v2_buyer_login must still work
--      unchanged for every existing buyer, and a person with one account must
--      be able to use the password they already have.
--
-- ==== READING THE OUTPUT ===================================================
-- The tally prints whether or not anything failed, so a gate that CRASHED is
-- distinguishable from a gate that ran and found nothing. If you red-prove this
-- file and see no FAIL lines AND no tally, the gate did not run.
-- =============================================================================
begin;
set local search_path = wholesale_v2, public, extensions;

do $$
declare
  PASS int := 0; FAIL int := 0;
  wA text := 'zz_l_alpha';   -- a store this person belongs to
  wB text := 'zz_l_beta';    -- a second store, same person
  wN text := 'zz_l_never';   -- a store they have never been in
  cliA uuid; cliB uuid; accA uuid; accB uuid;
  pOne uuid;                  -- one account, unambiguous -> adopts its hash
  pAmb uuid;                  -- two accounts, two hashes -> deliberately skipped
  accAmb1 uuid; accAmb2 uuid; cliAmb1 uuid; cliAmb2 uuid;
  r record; r2 record;
  msgUnknown text; msgWrongPass text; msgNoCredential text;
  sid uuid; tok text;
  n int; i int;
begin
  -- ---------------------------------------------------------------- fixture
  insert into public.wholesalers (wid,name,brand,currency,active) values
    (wA,'Zed Login Alpha','LA','$',true),
    (wB,'Zed Login Beta','LB','€',true),
    (wN,'Zed Login Never','LN','$',true);
  insert into wholesale_v2.v2_wholesalers (wid) values (wA),(wB),(wN);

  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wA,'Zed One Shop','03 010 010') returning id into cliA;
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wB,'Zed One Shop','03 010 010') returning id into cliB;

  -- THE UNAMBIGUOUS PERSON: one account, so 096's back-fill adopts its hash.
  insert into wholesale_v2.v2_portal_accounts (wid,client_id,role,username,password_hash,actor_label,active)
    values (wA,cliA,'buyer','zzone', extensions.crypt('one-password', extensions.gen_salt('bf')),'Zed One',true)
    returning id into accA;

  -- THE AMBIGUOUS PERSON: two accounts, two DIFFERENT passwords.
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wA,'Zed Amb Shop','03 020 020') returning id into cliAmb1;
  insert into wholesale_v2.v2_clients (wid,shop_name,phone) values (wB,'Zed Amb Shop','03 020 020') returning id into cliAmb2;
  insert into wholesale_v2.v2_portal_accounts (wid,client_id,role,username,password_hash,actor_label,active)
    values (wA,cliAmb1,'buyer','zzamb', extensions.crypt('alpha-pass', extensions.gen_salt('bf')),'Zed Amb',true)
    returning id into accAmb1;
  insert into wholesale_v2.v2_portal_accounts (wid,client_id,role,username,password_hash,actor_label,active)
    values (wB,cliAmb2,'buyer','zzamb', extensions.crypt('beta-pass', extensions.gen_salt('bf')),'Zed Amb',true)
    returning id into accAmb2;

  -- The real linking path, not hand-built person rows.
  perform wholesale_v2.v2_backfill_person_identity();
  select a.person_id into pOne from wholesale_v2.v2_portal_accounts a where a.id = accA;
  select a.person_id into pAmb from wholesale_v2.v2_portal_accounts a where a.id = accAmb1;

  -- Second-store membership for the unambiguous person.
  insert into wholesale_v2.v2_person_memberships (person_id,wid,client_id,account_id,role,active)
    values (pOne, wB, cliB, null, 'buyer', true)
  on conflict (person_id, wid, role) do update set active = true, client_id = excluded.client_id;

  -- Re-run 096's back-fill logic over the fixture, exactly as the migration does.
  insert into wholesale_v2.v2_person_credentials (person_id, password_hash, adopted_from)
  select x.person_id, x.password_hash, x.account_id
  from (
    select a.person_id, min(a.password_hash) as password_hash,
           (array_agg(a.id order by a.id::text))[1] as account_id,
           count(distinct a.password_hash) as n_hashes
      from wholesale_v2.v2_portal_accounts a
     where a.person_id is not null and a.role='buyer' and a.active
     group by a.person_id
  ) x
  where x.n_hashes = 1
  on conflict (person_id) do nothing;

  -- ============ 1. THE ENUMERATION RULE ===================================
  -- Three different underlying failures. All three must look the same.
  select * into r from wholesale_v2.v2_marketplace_login('03 999 999','whatever');
  msgUnknown := r.msg;
  if r.ok is false then PASS:=PASS+1; raise notice '  PASS  an unknown phone number is refused';
  else FAIL:=FAIL+1; raise warning '  FAIL  an unknown phone number LOGGED IN'; end if;

  select * into r from wholesale_v2.v2_marketplace_login('03 010 010','WRONG-PASSWORD');
  msgWrongPass := r.msg;
  if r.ok is false then PASS:=PASS+1; raise notice '  PASS  a wrong password is refused';
  else FAIL:=FAIL+1; raise warning '  FAIL  a wrong password LOGGED IN'; end if;

  -- The ambiguous person exists and has NO marketplace credential. That third
  -- state must not be distinguishable either, or it answers "is this number
  -- registered but not set up yet", which is still a yes/no about a real shop.
  select * into r from wholesale_v2.v2_marketplace_login('03 020 020','anything');
  msgNoCredential := r.msg;
  if r.ok is false then PASS:=PASS+1; raise notice '  PASS  a person with no marketplace password yet is refused';
  else FAIL:=FAIL+1; raise warning '  FAIL  a person with no marketplace credential LOGGED IN'; end if;

  if msgUnknown is not distinct from msgWrongPass
     and msgWrongPass is not distinct from msgNoCredential then
    PASS:=PASS+1;
    raise notice '  PASS  ENUMERATION: unknown number, wrong password and no-credential-yet are INDISTINGUISHABLE';
  else
    FAIL:=FAIL+1;
    raise warning '  FAIL  ENUMERATION LEAK: unknown="%", wrong-password="%", no-credential="%" -- anyone can now ask whether a given phone number is an OGGI buyer', msgUnknown, msgWrongPass, msgNoCredential;
  end if;

  -- ============ 2. THE HAPPY PATH, and GP-02 ==============================
  -- The unambiguous person signs in with the password they ALREADY HAD. They
  -- were never asked to choose a new one.
  select * into r from wholesale_v2.v2_marketplace_login('03 010 010','one-password');
  if r.ok is true then PASS:=PASS+1;
    raise notice '  PASS  GP-02: an existing buyer signs in to OGGI with the password they already had';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the adopted password does not work -- an existing buyer would be locked out of the new door'; end if;
  sid := r.session_id; tok := r.session_token;

  if r.session_token is not null and length(r.session_token) >= 32 then PASS:=PASS+1;
    raise notice '  PASS  a session secret of at least 32 characters is issued';
  else FAIL:=FAIL+1; raise warning '  FAIL  session secret was % ', coalesce(length(r.session_token)::text,'NULL'); end if;

  -- GP-02, the other half: the ORIGINAL per-store door is untouched.
  select * into r2 from wholesale_v2.v2_buyer_login(wA,'zzone','one-password');
  if r2.ok is true then PASS:=PASS+1;
    raise notice '  PASS  GP-02: the per-store login still works exactly as before -- two doors, both open';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  v2_buyer_login stopped working -- every existing buyer just lost their login'; end if;

  -- ============ 3. THE SECRET IS NOT STORED ===============================
  select count(*) into n from wholesale_v2.v2_buyer_sessions s where s.id = sid and s.token_hash = tok;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  the session secret is stored as a hash, not in the clear -- a database dump is not a set of live sessions';
  else FAIL:=FAIL+1; raise warning '  FAIL  the raw session secret is in the table'; end if;

  -- ============ 4. THE SESSION RESOLVES, AND ONLY WITH ITS OWN TOKEN ======
  if wholesale_v2.v2_session_person(sid, tok) = pOne then PASS:=PASS+1;
    raise notice '  PASS  a live session resolves to its person';
  else FAIL:=FAIL+1; raise warning '  FAIL  a live session did not resolve'; end if;

  if wholesale_v2.v2_session_person(sid, 'not-the-token') is null then PASS:=PASS+1;
    raise notice '  PASS  a wrong token resolves to nobody';
  else FAIL:=FAIL+1; raise warning '  FAIL  a WRONG TOKEN resolved a session'; end if;

  if wholesale_v2.v2_session_person(gen_random_uuid(), tok) is null then PASS:=PASS+1;
    raise notice '  PASS  a real token against the wrong session id resolves to nobody';
  else FAIL:=FAIL+1; raise warning '  FAIL  a token worked against a different session id'; end if;

  -- ============ 5. THE STORE LIST, and ID-09 ==============================
  select count(*) into n from wholesale_v2.v2_session_stores(sid, tok);
  if n = 2 then PASS:=PASS+1;
    raise notice '  PASS  the session lists BOTH stores this person belongs to -- one login, many shops';
  else FAIL:=FAIL+1; raise warning '  FAIL  the session lists % store(s), expected 2', n; end if;

  select count(*) into n from wholesale_v2.v2_session_stores(sid, tok) s where s.wid = wN;
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  a store they have never been in is not listed';
  else FAIL:=FAIL+1; raise warning '  LEAK: a store they have never entered is in the switcher'; end if;

  select count(*) into n from wholesale_v2.v2_session_stores(gen_random_uuid(), 'bogus');
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  a bogus session lists no stores, and does not raise';
  else FAIL:=FAIL+1; raise warning '  FAIL  a bogus session listed % store(s)', n; end if;

  -- ============ 6. ENTERING A STORE =======================================
  select * into r from wholesale_v2.v2_session_account(sid, tok, wA);
  if r.ok is true then PASS:=PASS+1; raise notice '  PASS  the session can enter a store it belongs to';
  else FAIL:=FAIL+1; raise warning '  FAIL  the session could not enter its own store'; end if;

  select * into r from wholesale_v2.v2_session_account(sid, tok, wN);
  if r.ok is not true then PASS:=PASS+1;
    raise notice '  PASS  the session CANNOT enter a store it has no membership in';
  else FAIL:=FAIL+1;
    raise warning '  LEAK: the session entered a store it was never given access to'; end if;

  -- THE REVOCATION GUARANTEE, at the session layer this time. Membership is
  -- re-checked on every entry, not trusted from login.
  update wholesale_v2.v2_person_memberships
     set active = false, revoked_at = now() where person_id = pOne and wid = wB;
  select * into r from wholesale_v2.v2_session_account(sid, tok, wB);
  if r.ok is not true then PASS:=PASS+1;
    raise notice '  PASS  a store revoked AFTER sign-in is refused immediately -- membership is re-checked, not trusted from login';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a REVOKED store is still enterable for the life of the session'; end if;

  select count(*) into n from wholesale_v2.v2_session_stores(sid, tok);
  if n = 1 then PASS:=PASS+1; raise notice '  PASS  the revoked store also drops out of the switcher';
  else FAIL:=FAIL+1; raise warning '  FAIL  the switcher still lists % store(s) after a revoke', n; end if;
  update wholesale_v2.v2_person_memberships
     set active = true, revoked_at = null where person_id = pOne and wid = wB;

  -- ============ 7. THE SESSION ACTUALLY ENDS ==============================
  update wholesale_v2.v2_buyer_sessions set expires_at = now() - interval '1 second' where id = sid;
  if wholesale_v2.v2_session_person(sid, tok) is null then PASS:=PASS+1;
    raise notice '  PASS  an EXPIRED session resolves to nobody -- this is the hole ID-02 exists to close';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  an EXPIRED session still resolves -- the session never ends'; end if;

  select count(*) into n from wholesale_v2.v2_session_stores(sid, tok);
  if n = 0 then PASS:=PASS+1; raise notice '  PASS  an expired session lists no stores either';
  else FAIL:=FAIL+1; raise warning '  FAIL  an expired session still lists % store(s)', n; end if;

  select * into r from wholesale_v2.v2_session_account(sid, tok, wA);
  if r.ok is not true then PASS:=PASS+1; raise notice '  PASS  an expired session cannot enter a store';
  else FAIL:=FAIL+1; raise warning '  FAIL  an expired session entered a store'; end if;

  update wholesale_v2.v2_buyer_sessions set expires_at = now() + interval '1 day' where id = sid;

  -- Revocation.
  if wholesale_v2.v2_session_logout(sid, tok) then PASS:=PASS+1; raise notice '  PASS  logout reports success';
  else FAIL:=FAIL+1; raise warning '  FAIL  logout reported failure for a live session'; end if;

  if wholesale_v2.v2_session_person(sid, tok) is null then PASS:=PASS+1;
    raise notice '  PASS  a logged-out session resolves to nobody';
  else FAIL:=FAIL+1; raise warning '  FAIL  a logged-out session still resolves'; end if;

  select count(*) into n from wholesale_v2.v2_buyer_sessions where id = sid and revoked_at is not null;
  if n = 1 then PASS:=PASS+1;
    raise notice '  PASS  logout REVOKES rather than deletes -- same rule as AC-09 and AC-13';
  else FAIL:=FAIL+1; raise warning '  FAIL  logout deleted the session row'; end if;

  -- ============ 8. THE AMBIGUOUS PERSON WAS DELIBERATELY SKIPPED ==========
  select count(*) into n from wholesale_v2.v2_person_credentials where person_id = pAmb;
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  a person with two DIFFERENT store passwords got no credential -- picking one would silently break the other';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  the back-fill guessed a password for a person who has two different ones'; end if;

  -- ...and they can set one, by proving an existing per-store password.
  select * into r from wholesale_v2.v2_set_marketplace_password(wA,'zzamb','WRONG','new-marketplace-pass');
  if r.ok is not true then PASS:=PASS+1;
    raise notice '  PASS  setting a marketplace password REQUIRES a correct existing store password';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  a marketplace password was set without proving the old one -- anyone could claim any identity'; end if;

  select * into r from wholesale_v2.v2_set_marketplace_password(wA,'zzamb','alpha-pass','short');
  if r.ok is not true then PASS:=PASS+1; raise notice '  PASS  a password under 8 characters is refused';
  else FAIL:=FAIL+1; raise warning '  FAIL  a 5-character password was accepted'; end if;

  select * into r from wholesale_v2.v2_set_marketplace_password(wA,'zzamb','alpha-pass','new-marketplace-pass');
  if r.ok is true then PASS:=PASS+1; raise notice '  PASS  with the correct store password, a marketplace password can be set';
  else FAIL:=FAIL+1; raise warning '  FAIL  could not set a marketplace password with correct details: %', r.msg; end if;

  select * into r from wholesale_v2.v2_marketplace_login('03 020 020','new-marketplace-pass');
  if r.ok is true then PASS:=PASS+1; raise notice '  PASS  and they can then sign in to OGGI with it';
  else FAIL:=FAIL+1; raise warning '  FAIL  the newly set marketplace password does not work'; end if;

  -- Their OLD per-store passwords must BOTH still work. This is the failure the
  -- back-fill refused to risk, so it must be checked rather than assumed.
  select * into r2 from wholesale_v2.v2_buyer_login(wA,'zzamb','alpha-pass');
  if r2.ok is true then PASS:=PASS+1; raise notice '  PASS  their first store password still works';
  else FAIL:=FAIL+1; raise warning '  FAIL  setting a marketplace password broke their store-A login'; end if;
  select * into r2 from wholesale_v2.v2_buyer_login(wB,'zzamb','beta-pass');
  if r2.ok is true then PASS:=PASS+1; raise notice '  PASS  their second store password still works too';
  else FAIL:=FAIL+1; raise warning '  FAIL  setting a marketplace password broke their store-B login'; end if;

  -- ============ 9. THE THROTTLE ===========================================
  -- A new front door with no rate limit would be worse than the one beside it.
  delete from wholesale_v2.v2_login_throttle
   where key like 'mkt|%' or key like 'buyer|%';
  for i in 1..10 loop
    perform wholesale_v2.v2_marketplace_login('03 010 010','wrong-'||i);
  end loop;
  select * into r from wholesale_v2.v2_marketplace_login('03 010 010','one-password');
  if r.ok is not true then PASS:=PASS+1;
    raise notice '  PASS  ten wrong attempts lock the identifier out -- even the CORRECT password is refused while locked';
  else FAIL:=FAIL+1;
    raise warning '  FAIL  no lockout after ten failed attempts -- the front door can be brute-forced'; end if;

  -- ============ 10. THE BROWSER ROLES CANNOT READ THE TABLES ==============
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2'
     and table_name in ('v2_person_credentials','v2_buyer_sessions')
     and grantee in ('anon','authenticated');
  if n = 0 then PASS:=PASS+1;
    raise notice '  PASS  anon and authenticated hold NOTHING on the credential and session tables';
  else FAIL:=FAIL+1; raise warning '  FAIL  browser roles hold % grant(s) on credentials or sessions', n; end if;

  -- ============ 11. NO CALLER MAY NAME A STORE AT LOGIN ===================
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_marketplace_login')) not ilike '%wid%'
  then PASS:=PASS+1;
    raise notice '  PASS  the marketplace login takes no wid -- it is the door to OGGI, not to a shop';
  else FAIL:=FAIL+1; raise warning '  FAIL  v2_marketplace_login takes a wid'; end if;

  raise notice '----------------------------------------';
  raise notice 'check_marketplace_login: passed: %   failed: %', PASS, FAIL;
  raise notice '----------------------------------------';
  if FAIL > 0 then raise exception 'check_marketplace_login FAILED with % problem(s)', FAIL; end if;
end $$;

rollback;
