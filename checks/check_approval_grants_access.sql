-- =============================================================================
-- check_approval_grants_access.sql — AC-01 / ID-03
-- =============================================================================
-- THE QUESTION: *"a wholesaler pressed Approve. Can that shop now actually buy
-- from them?"*
--
-- It sounds too obvious to test. It was false in production for the whole life
-- of the marketplace front door, and nothing anywhere said so, because the
-- path had never once run: production has ZERO approved requests. Every
-- membership that exists was written by a one-off backfill utility.
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_approval_grants_access.sql <db>
-- Rolls itself back. A pass raises ROLLBACK_WITH_REPORT. ⚠️ A runner reading
-- only the exit code will call a PASS a failure (GATE-EVIDENCE.md §7.1).
--
-- THE THREE THAT MATTER MOST:
--
--   * ASSERTION 3 — the buyer's OWN SESSION can open the store. Not "a row
--     exists": the actual function the app calls on every store entry,
--     v2_session_account, with a real session token. A membership that exists
--     but does not open the door is the same defect one layer down.
--
--   * ASSERTION 8 — the anonymous applicant's password STILL WORKS. Half of
--     migration 107 is a promise that nothing was taken from the person with no
--     OGGI account, and the only way to keep that promise honestly is to log in
--     with the password the function just issued.
--
--   * ASSERTION 6b — added teeth AFTER a red proof produced zero failures. The
--     first version signed in with a username that does not exist at that
--     store, so it failed for the wrong reason and would have passed with the
--     account's password set to a hash of the empty string.
--
--   * ASSERTION 6 — the marketplace buyer gets NO second password, and the
--     account minted for them cannot be logged into. Two credentials for one
--     human at one company is how "who is this shop" stops having one answer.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public, extensions;

do $$
declare
  rep text := ''; fails int := 0; n int;
  wA text := '__gate_appr_A__';   -- the store the buyer already belongs to
  wB text := '__gate_appr_B__';   -- the store they ask for access to
  wC text := '__gate_appr_C__';   -- a v1 store with no marketplace twin
  p uuid := '55555555-eeee-4eee-8eee-555555555555';
  accA uuid; owner_id uuid := '66666666-ffff-4fff-8fff-666666666666';
  reqB uuid; reqAnon uuid; sid uuid; secret text := 'gate-secret-token';
  r record; v_access text; v_acct uuid; v_pass text; v_user text; v_ok boolean; v_msg text;
begin
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  -- ---- fixture --------------------------------------------------------------
  insert into public.wholesalers (wid, name, active)
    values (wA,'Store A',true), (wB,'Store B',true), (wC,'Store C (v1 only)',true);
  insert into wholesale_v2.v2_wholesalers (wid, name) values (wA,'Store A'), (wB,'Store B');
  -- wC deliberately has NO v2 twin.

  insert into wholesale_v2.v2_people (id, display_name) values (p, 'Probe Shop');
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, person_id, actor_label)
    values (wA,'buyer','gate_appr','x',p,'Probe Shop') returning id into accA;
  insert into wholesale_v2.v2_person_memberships (person_id, wid, account_id, role, active)
    values (p, wA, accA, 'buyer', true);

  -- a REAL marketplace session for this person, so the store-entry path can be
  -- exercised rather than described
  insert into wholesale_v2.v2_buyer_sessions (person_id, token_hash, expires_at)
  values (p, encode(extensions.digest(secret,'sha256'),'hex'), now() + interval '30 days')
  returning id into sid;

  insert into auth.users (id, email) values (owner_id, 'gate-appr@example.invalid');
  insert into wholesale_v2.v2_user_profiles (id, role, wid, actor_label)
    values (owner_id, 'owner', null, 'owner');

  -- the buyer asks Store B, exactly as the directory does
  perform wholesale_v2.v2_directory_request_access(accA::text, wB, 'a real shop in Tripoli');
  select id into reqB from wholesale_v2.v2_signup_requests where person_id = p and wid = wB;

  -- ---------------------------------------------------------------- 1 -------
  select count(*) into n from wholesale_v2.v2_session_stores(sid, secret) s where s.wid = wB;
  if n = 0 then rep := rep || E'\n 1  ok   before approval the store is not in the buyer''s switcher';
  else fails := fails+1; rep := rep || E'\n 1  FAIL the store was already in the switcher before anyone approved it'; end if;

  -- ---- approve it, as the owner, exactly as the screen does ------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  select * into r from wholesale_v2.v2_approve_signup_request(reqB, null);
  perform set_config('request.jwt.claims', '{}', true);

  -- ---------------------------------------------------------------- 2 -------
  select count(*) into n from wholesale_v2.v2_person_memberships m
   where m.person_id = p and m.wid = wB and m.active;
  if r.ok and n = 1 then rep := rep || E'\n 2  ok   ⭐ approving an OGGI buyer GRANTS A MEMBERSHIP — the thing that had never been written';
  else fails := fails+1; rep := rep || format(E'\n 2  FAIL approve ok=%s, memberships=%s (%s)', r.ok, n, r.msg); end if;

  -- ---------------------------------------------------------------- 3 -------
  -- ⭐ THE ONE THAT MATTERS: the buyer's own session can open the store. This
  -- is the function the app calls on every entry, with a real token.
  select a.ok, a.account_id into v_ok, v_acct
    from wholesale_v2.v2_session_account(sid, secret, wB) a;
  if v_ok and v_acct is not null then
    rep := rep || E'\n 3  ok   ⭐ ...and the buyer''s own session can now OPEN that store, through the function the app uses';
  else fails := fails+1; rep := rep || format(E'\n 3  FAIL the membership exists but v2_session_account refuses to open the store (ok=%s)', v_ok); end if;

  -- ---------------------------------------------------------------- 4 -------
  select count(*) into n from wholesale_v2.v2_session_stores(sid, secret) s where s.wid = wB;
  if n = 1 then rep := rep || E'\n 4  ok   ...and it appears in their store switcher, which is where they will look for it';
  else fails := fails+1; rep := rep || format(E'\n 4  FAIL the store switcher lists it %s time(s)', n); end if;

  -- ---------------------------------------------------------------- 5 -------
  -- The directory and "Your requests" must now AGREE. They contradicted each
  -- other before 107: one said "Approved — you can shop here now", the other
  -- offered the Ask button again.
  select d.access into v_access from wholesale_v2.v2_directory_list(accA, null, 50, 0) d where d.wid = wB;
  if v_access = 'member' then
    rep := rep || E'\n 5  ok   ⭐ the directory card says "you have access" — it said "none" before 107, contradicting the buyer''s own requests list';
  else fails := fails+1; rep := rep || format(E'\n 5  FAIL the directory card says %L after approval', v_access); end if;

  -- ---------------------------------------------------------------- 6 -------
  -- ⭐ NO SECOND CREDENTIAL. Asserted twice: nothing was returned, AND the
  -- account that was minted cannot be logged into with anything.
  if r.temp_password is null and r.username is null then
    rep := rep || E'\n 6  ok   ⭐ no password was issued to somebody who already signs in to OGGI';
  else fails := fails+1; rep := rep || format(E'\n 6  FAIL a second credential was minted: username=%L password issued=%s', r.username, (r.temp_password is not null)); end if;

  -- ⚠️ 6b WAS BLIND AND A RED PROOF FOUND IT. It read
  --      v2_buyer_login(wB, 'gate_appr', '')
  -- where `gate_appr` is the fixture's username at store A. There is no such
  -- user at store B, so the login failed for the wrong reason and the assertion
  -- passed no matter what password the marketplace account carried. Replacing
  -- the random hash with crypt('') -- a hash of the EMPTY STRING, which anyone
  -- could sign in with -- produced ZERO failures.
  --
  -- It now looks the username UP from the account the membership actually
  -- points at, and tries the three passwords a broken hash would accept.
  select a.username into v_user
    from wholesale_v2.v2_portal_accounts a
    join wholesale_v2.v2_person_memberships m on m.account_id = a.id
   where m.person_id = p and m.wid = wB;
  if v_user is null then
    fails := fails+1; rep := rep || E'\n 6b FAIL the membership points at no account, so nothing could be tested';
  else
    n := 0;
    for v_msg in select unnest(array['', v_user, 'password']) loop
      select b.ok into v_ok from wholesale_v2.v2_buyer_login(wB, v_user, v_msg) b;
      if coalesce(v_ok,false) then n := n + 1; end if;
    end loop;
    if n = 0 then
      rep := rep || format(E'\n 6b ok   ...and the account behind that membership (%s) refuses the empty password, its own name, and "password"', v_user);
    else fails := fails+1; rep := rep || format(E'\n 6b FAIL the marketplace account accepted %s of 3 guessed passwords', n); end if;
  end if;

  -- ---------------------------------------------------------------- 7 -------
  -- ⚠️ THIS ASSERTION WAS WRONG THE FIRST TIME AND THE CODE WAS RIGHT. It read
  -- `msg !~* 'password to send.*[A-Za-z0-9]{8}'`, meaning to say "the message
  -- does not contain an actual password" -- and it fired on the correct
  -- message, because ordinary prose after the words "password to send" is also
  -- eight alphanumerics. Guessing at the SHAPE of a credential in free text is
  -- not a check; whether a credential was returned is a structural question and
  -- assertion 6 already answers it. What is left for 7 is the real behavioural
  -- difference between the two paths: the legacy one returns an empty msg and
  -- expects the screen to render a password box, this one returns a sentence.
  if r.msg is not null and length(btrim(r.msg)) > 20 then
    rep := rep || E'\n 7  ok   the wholesaler is given a real sentence to act on, where the legacy path returns an empty message and a password box';
  else fails := fails+1; rep := rep || format(E'\n 7  FAIL the success message is %L', r.msg); end if;

  -- ---------------------------------------------------------------- 8 -------
  -- ⭐ THE OTHER HALF OF THE PROMISE: the anonymous applicant is untouched.
  -- Proven by LOGGING IN with the password the function just issued, not by
  -- checking that a string came back.
  -- The sixth argument is the phone, required since migration 108: this door
  -- collected no contact detail at all until then, so approving one of its
  -- requests minted a password with nobody to send it to. This gate's fixture
  -- is the applicant, so it supplies one.
  select d.ok into v_ok
    from wholesale_v2.v2_submit_signup_request(wB, 'Walk In Shop', 'Tripoli', '100/mo', 'kidswear', '76 543 210') d;
  select id into reqAnon from wholesale_v2.v2_signup_requests
   where wid = wB and buyer_name = 'Walk In Shop' and person_id is null;

  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  select * into r from wholesale_v2.v2_approve_signup_request(reqAnon, null);
  perform set_config('request.jwt.claims', '{}', true);
  v_user := r.username; v_pass := r.temp_password;

  if r.ok and v_user is not null and v_pass is not null then
    rep := rep || E'\n 8  ok   an applicant with no OGGI account still gets a login and a one-time password';
  else fails := fails+1; rep := rep || format(E'\n 8  FAIL the anonymous path returned ok=%s username=%L password=%s', r.ok, v_user, (v_pass is not null)); end if;

  select b.ok into v_ok from wholesale_v2.v2_buyer_login(wB, v_user, v_pass) b;
  if coalesce(v_ok,false) then
    rep := rep || E'\n 8b ok   ⭐ ...and that password ACTUALLY WORKS — proven by signing in with it, not by seeing a string come back';
  else fails := fails+1; rep := rep || E'\n 8b FAIL the password the function issued does not log in'; end if;

  select count(*) into n from wholesale_v2.v2_person_memberships m
   where m.wid = wB and m.client_id = r.client_id;
  if n = 0 then rep := rep || E'\n 8c ok   ...and no membership was invented for a person who does not exist';
  else fails := fails+1; rep := rep || E'\n 8c FAIL a membership was created for an applicant with no person'; end if;

  -- ---------------------------------------------------------------- 9 -------
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  select a.ok, a.msg into v_ok, v_msg from wholesale_v2.v2_approve_signup_request(reqB, null) a;
  perform set_config('request.jwt.claims', '{}', true);
  if not v_ok then rep := rep || E'\n 9  ok   approving the same request twice is refused, so a double click cannot mint a second account';
  else fails := fails+1; rep := rep || E'\n 9  FAIL the same request was approved twice'; end if;

  -- --------------------------------------------------------------- 10 -------
  -- A store that exists in v1 but has no marketplace twin cannot be joined.
  -- It must say so in words, not die on a foreign key.
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, person_id)
  values (wC, 'Probe Shop', 'pending', p) returning id into reqAnon;
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  begin
    select a.ok, a.msg into v_ok, v_msg from wholesale_v2.v2_approve_signup_request(reqAnon, null) a;
    if (not v_ok) and v_msg ~* 'not set up on the marketplace' then
      rep := rep || E'\n10  ok   a store with no marketplace record refuses in words rather than dying on a foreign key';
    else fails := fails+1; rep := rep || format(E'\n10  FAIL ok=%s msg=%L', v_ok, v_msg); end if;
  exception when others then
    fails := fails+1;
    rep := rep || format(E'\n10  FAIL approving into a store with no marketplace record RAISED: %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims', '{}', true);

  -- --------------------------------------------------------------- 11 -------
  -- Migration 104's recorder still fires on approval. AC-17 asked "who let this
  -- shop in", and 107 rewrote the function that answers it.
  select count(*) into n from wholesale_v2.v2_audit_log
   where action = 'access_approved' and target_id = reqB::text;
  if n = 1 then rep := rep || E'\n11  ok   the access decision is still recorded — 104''s trigger survived this rewrite';
  else fails := fails+1; rep := rep || format(E'\n11  FAIL %s audit entries for the approval, expected 1', n); end if;

  -- --------------------------------------------------------------- 12 -------
  select count(*) into n from wholesale_v2.v2_signup_requests
   where id = reqB and status='approved' and decided_at is not null and reviewed_by is not null;
  if n = 1 then rep := rep || E'\n12  ok   the request records WHEN it was decided and by WHOM';
  else fails := fails+1; rep := rep || E'\n12  FAIL the approved request has no decided_at or no reviewed_by'; end if;

  -- --------------------------------------------------------------- 13 -------
  if has_function_privilege('anon','wholesale_v2.v2_approve_signup_request(uuid,text)','execute') then
    fails := fails+1; rep := rep || E'\n13  FAIL anon can approve access requests';
  else rep := rep || E'\n13  ok   nothing anonymous can approve anybody'; end if;

  if fails > 0 then
    raise exception E'check_approval_grants_access: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_approval_grants_access: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
