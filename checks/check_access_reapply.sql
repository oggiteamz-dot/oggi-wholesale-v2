-- =============================================================================
-- check_access_reapply.sql — AC-10
-- =============================================================================
-- THE QUESTION: "a wholesaler turned a shop down. What happens the next time
-- that shop asks — and can the wholesaler see they have asked before?"
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_access_reapply.sql <db>
-- Rolls itself back. A pass raises ROLLBACK_WITH_REPORT. ⚠️ A runner reading
-- only the exit code will call a PASS a failure. (checks/GATE-EVIDENCE.md §7.1
-- — two careful gates spent days on an ignore list for exactly this.)
--
-- THE THREE THAT MATTER MOST:
--
--   * ASSERTION 10 — THE SECOND DOOR. `v2_submit_signup_request`, the sign-in
--     screen's "Don't have an account? Request access", is also granted to anon
--     and also inserts an access request. Before migration 106 a buyer inside a
--     cooldown could sign out and use it. If this assertion ever goes red the
--     whole feature is decorative, because the bypass is one sign-out away and
--     the app puts a button on it.
--
--   * ASSERTIONS 10b AND 11 — THE KNOWN GAP, AND HOW FAR IT MOVED. When this
--     gate was written the anonymous door had only a typed shop name to match
--     on, so renaming the shop escaped the cooldown, and 11 said so out loud
--     rather than leaving it in a comment. Migration 108 gave that door a phone
--     number: 10b now asserts that a DIFFERENT NAME ON THE SAME NUMBER is
--     caught, and 11 concedes only the narrower case — a different name AND a
--     different number. A limitation nothing checks is a limitation that
--     quietly becomes a surprise; one that is asserted moves visibly.
--
--   * ASSERTION 9b — added AFTER a red proof produced zero failures. Assertion
--     9 alone passed whether or not the policy table had a row in it, because a
--     missing row made every guard a NULL comparison and the function fell
--     through to the same answer. 9b moves the row's number and watches the
--     answer move, which is the only version of that assertion that is about
--     the table rather than about a coincidence.
--
--   * ASSERTION 12 — the wholesaler sees the previous application ATTACHED.
--     This is what AC-10 is actually for. Blocking a re-application is the
--     lesser half; reviewing the same shop blind for the third time is the
--     complaint.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  rep text := ''; fails int := 0; n int;
  w      text := '__gate_reapply__';
  p_me   uuid := '33333333-cccc-4ccc-8ccc-333333333333';
  a_me   uuid;
  wprof  uuid := '44444444-dddd-4ddd-8ddd-444444444444';
  r1 uuid; r2 uuid; r3 uuid;
  v_ok boolean; v_msg text; v_state text; v_att int; v_sup uuid;
  v_phone  text := '03 456 789';        -- 108: the anonymous door now requires one
  v_phone2 text := '71 222 333';        -- a different shop, a different number
  NOTE_OLD text := 'We are a childrenswear shop in Tripoli, open six years.';
  NOTE_NEW text := 'Commercial registration 12345, shop on Azmi street, open six years.';
begin
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  -- ---- fixture --------------------------------------------------------------
  insert into public.wholesalers (wid, name, active) values (w,'Reapply Co',true)
    on conflict (wid) do nothing;
  insert into wholesale_v2.v2_wholesalers (wid, name, access_sla_hours) values (w,'Reapply Co',48)
    on conflict (wid) do nothing;
  insert into wholesale_v2.v2_people (id) values (p_me) on conflict do nothing;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, person_id, actor_label)
  values (w,'buyer','gate_reapply','x',p_me,'Noor Boutique') returning id into a_me;

  -- ---------------------------------------------------------------- 1 -------
  -- A shop that has never asked gets in the queue, as attempt 1, linked to
  -- nothing. If this fails, 106 broke the ordinary first application.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_OLD) d;
  select r.attempt, r.supersedes into v_att, v_sup
    from wholesale_v2.v2_signup_requests r where r.person_id = p_me and r.wid = w
    order by r.created_at desc, r.attempt desc, r.id desc limit 1;
  if v_ok and v_att = 1 and v_sup is null then
    rep := rep || E'\n 1  ok   a first application still works, as attempt 1, superseding nothing';
  else fails := fails+1; rep := rep || format(E'\n 1  FAIL first application: ok=%s attempt=%s supersedes=%s (%s)', v_ok, v_att, v_sup, v_msg); end if;

  select id into r1 from wholesale_v2.v2_signup_requests
   where person_id = p_me and wid = w order by created_at desc, attempt desc, id desc limit 1;

  -- ---------------------------------------------------------------- 2 -------
  select d.ok into v_ok from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_OLD) d;
  if not v_ok then rep := rep || E'\n 2  ok   asking twice while it is still pending is refused';
  else fails := fails+1; rep := rep || E'\n 2  FAIL a second request was accepted while the first was still pending'; end if;

  -- ---------------------------------------------------------------- 3 -------
  -- Declined for a reason with a 90-day cooldown. The refusal must NAME THE
  -- DATE: "come back later" with no date is the dead end PB-01 removed.
  update wholesale_v2.v2_signup_requests
     set status='rejected', reason_code='outside_area', decided_at=now() where id = r1;
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_NEW) d;
  if not v_ok and v_msg ~ to_char(now() + interval '90 days', 'FMDD Mon YYYY') then
    rep := rep || E'\n 3  ok   inside the cooldown it is refused, and the refusal names the date they may return';
  else fails := fails+1; rep := rep || format(E'\n 3  FAIL cooldown refusal: ok=%s msg=%L', v_ok, v_msg); end if;

  -- ---------------------------------------------------------------- 4 -------
  -- cannot_verify is the reason the BUYER can fix: no wait at all, but they
  -- must say something. Both halves asserted, because either alone is wrong.
  update wholesale_v2.v2_signup_requests
     set reason_code='cannot_verify', decided_at=now() where id = r1;
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, null) d;
  if not v_ok and v_msg ~* 'line or two' then
    rep := rep || E'\n 4  ok   "we could not verify you" lets them return at once — but not empty-handed';
  else fails := fails+1; rep := rep || format(E'\n 4  FAIL cannot_verify with no note: ok=%s msg=%L', v_ok, v_msg); end if;

  -- ---------------------------------------------------------------- 5 -------
  -- THE SAME WORDS ARE NOT NEW INFORMATION. Spacing and case deliberately
  -- mangled: the claim is about words, not whitespace.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(
      a_me::text, w, '  we ARE a   childrenswear shop in Tripoli, open six years. ') d;
  if not v_ok and v_msg ~* 'word for word' then
    rep := rep || E'\n 5  ok   re-sending the same note, respaced and recased, is refused as what it is';
  else fails := fails+1; rep := rep || format(E'\n 5  FAIL identical note re-accepted: ok=%s msg=%L', v_ok, v_msg); end if;

  -- ---------------------------------------------------------------- 6 -------
  -- A real re-application: accepted, attempt 2, and LINKED to what it replaces.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_NEW) d;
  select r.id, r.attempt, r.supersedes into r2, v_att, v_sup
    from wholesale_v2.v2_signup_requests r where r.person_id = p_me and r.wid = w
    order by r.created_at desc, r.attempt desc, r.id desc limit 1;
  if v_ok and v_att = 2 and v_sup = r1 then
    rep := rep || E'\n 6  ok   a re-application with something new is accepted, as attempt 2, linked to the one it replaces';
  else fails := fails+1; rep := rep || format(E'\n 6  FAIL re-application: ok=%s attempt=%s supersedes=%s expected %s (%s)', v_ok, v_att, v_sup, r1, v_msg); end if;

  -- ---------------------------------------------------------------- 7 -------
  -- "You already have an account under another name" — applying again is the
  -- WRONG ACTION, so it is refused with advice rather than a date.
  update wholesale_v2.v2_signup_requests
     set status='rejected', reason_code='existing_account', decided_at=now() where id = r2;
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_NEW || ' more') d;
  if not v_ok and v_msg ~* 'another name' and v_msg !~* 'ask this wholesaler again on' then
    rep := rep || E'\n 7  ok   "you already have an account" refuses with what would actually help, not with a date';
  else fails := fails+1; rep := rep || format(E'\n 7  FAIL existing_account: ok=%s msg=%L', v_ok, v_msg); end if;

  -- ---------------------------------------------------------------- 8 -------
  -- Three attempts on a `other` decline is the cap. The fourth is refused as
  -- exhausted, and NOT as a cooldown — a shop that has been told no three
  -- times is owed the honest sentence, not a date that will not help.
  update wholesale_v2.v2_signup_requests
     set reason_code='other', reason_text='x', decided_at = now() - interval '400 days'
   where person_id = p_me and wid = w;
  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, status, person_id, reason_code, reason_text, decided_at, attempt)
  values (w,'Noor Boutique','rejected',p_me,'other','x', now() - interval '400 days', 3);
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_NEW || ' and again') d;
  if not v_ok and v_msg ~* 'times and they have said no' then
    rep := rep || E'\n 8  ok   past the attempt cap it says so plainly instead of offering another date';
  else fails := fails+1; rep := rep || format(E'\n 8  FAIL exhausted: ok=%s msg=%L', v_ok, v_msg); end if;

  -- ---------------------------------------------------------------- 9 -------
  -- EVERY DECLINE MADE BEFORE MIGRATION 104 HAS reason_code = NULL, because
  -- there was nowhere to put a reason. If a null reason resolved to "no policy
  -- row", every one of those shops would be locked out permanently and nothing
  -- would ever say so.
  delete from wholesale_v2.v2_signup_requests where person_id = p_me and wid = w;
  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, status, person_id, reason_code, decided_at)
  values (w,'Noor Boutique','rejected',p_me, null, now() - interval '400 days')
  returning id into r3;
  select s.state into v_state
    from wholesale_v2.v2_access_reapply_standing(p_me, w, 'Noor Boutique') s;
  if v_state = 'ok' then
    rep := rep || E'\n 9  ok   a decline from before reasons existed is not a life sentence';
  else fails := fails+1; rep := rep || format(E'\n 9  FAIL a null-reason decline answered %L, not ok', v_state); end if;

  -- ---------------------------------------------------------------- 9b ------
  -- ⚠️ 9 ALONE WAS A BLIND ASSERTION AND A RED PROOF CAUGHT IT. Deleting the
  -- `__unknown__` row produced ZERO failures: with no row the whole policy
  -- record is NULL, every guard is a NULL comparison, and the function fell
  -- through to `ok` -- the same answer, for the opposite reason.
  --
  -- So 9b proves the ROW IS WHAT DECIDES, by moving its number and watching the
  -- answer follow. This is the assertion that goes red if the table is ever
  -- bypassed, deleted, or quietly replaced by constants in a function body.
  update wholesale_v2.v2_access_reapply_policy set cooldown_days = 3650 where reason_code = '__unknown__';
  select s.state into v_state
    from wholesale_v2.v2_access_reapply_standing(p_me, w, 'Noor Boutique') s;
  if v_state = 'wait' then
    rep := rep || E'\n 9b ok   ...and the POLICY ROW is what decides it — move its number and the answer moves';
  else fails := fails+1; rep := rep || format(E'\n 9b FAIL the policy row does not drive the answer: raising __unknown__ to 3650 days still answered %L', v_state); end if;
  update wholesale_v2.v2_access_reapply_policy set cooldown_days = 30 where reason_code = '__unknown__';

  -- --------------------------------------------------------------- 10 -------
  -- ⚠️ THE SECOND DOOR. Same shop name, no session at all, straight at the
  -- sign-in screen's RPC. Before 106 this was an open bypass of everything
  -- above it in this file.
  update wholesale_v2.v2_signup_requests
     set reason_code='outside_area', decided_at = now() where id = r3;
  update wholesale_v2.v2_signup_requests set phone = v_phone where id = r3;
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_submit_signup_request(w, 'noor  BOUTIQUE.', null, null, NOTE_NEW, v_phone) d;
  if not v_ok and v_msg ~* 'can ask again on' then
    rep := rep || E'\n10  ok   the sign-in screen door obeys the SAME cooldown';
  else fails := fails+1; rep := rep || format(E'\n10  FAIL the anonymous door bypassed the cooldown: ok=%s msg=%L', v_ok, v_msg); end if;

  -- --------------------------------------------------------------- 10b ------
  -- ⭐ MIGRATION 108 NARROWED THE GAP BELOW. A phone number outranks a shop
  -- name, so renaming the shop no longer escapes the cooldown -- which is what
  -- assertion 11 had to concede when the name was the only handle this door had.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_submit_signup_request(w, 'A Completely Different Name', null, null, NOTE_NEW, v_phone) d;
  if not v_ok and v_msg ~* 'can ask again on' then
    rep := rep || E'\n10b ok   ⭐ ...and a DIFFERENT SHOP NAME on the same number is still matched — 106 could not do this';
  else fails := fails+1; rep := rep || format(E'\n10b FAIL renaming the shop escaped the cooldown: ok=%s msg=%L', v_ok, v_msg); end if;

  -- --------------------------------------------------------------- 10c ------
  -- The door REFUSES without a usable number at all. A request nobody can
  -- answer is not a request: approving one mints a password with nowhere to
  -- send it, which is what this form did from Batch 4 until 108.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_submit_signup_request(w, 'No Number Shop', null, null, NOTE_NEW, null) d;
  if not v_ok and v_msg ~* 'phone number is required' then
    rep := rep || E'\n10c ok   ⭐ a request with no phone number is refused — it could never have been answered';
  else fails := fails+1; rep := rep || format(E'\n10c FAIL a contactless request was accepted: ok=%s msg=%L', v_ok, v_msg); end if;

  select d.ok into v_ok
    from wholesale_v2.v2_submit_signup_request(w, 'Junk Number Shop', null, null, NOTE_NEW, '12') d;
  if not v_ok then rep := rep || E'\n10d ok   ...and so is one that is not a phone number, judged by the same normaliser the schema uses everywhere else';
  else fails := fails+1; rep := rep || E'\n10d FAIL "12" was accepted as a phone number'; end if;

  -- --------------------------------------------------------------- 11 -------
  -- ⚠️ THE KNOWN GAP, ASSERTED SO IT CANNOT BECOME A SURPRISE. A typed name is
  -- the only handle the anonymous door has. A different name is a different
  -- applicant, and this line says so out loud rather than leaving it in prose.
  select d.ok into v_ok
    from wholesale_v2.v2_submit_signup_request(w, 'A Completely Different Shop', null, null, NOTE_NEW, v_phone2) d;
  if v_ok then
    rep := rep || E'\n11  ok   KNOWN GAP, narrowed by 108 and still asserted: a different name AND a different number is a different applicant';
  else fails := fails+1; rep := rep || E'\n11  FAIL a genuinely new shop was refused — the match is catching people it should not'; end if;

  -- --------------------------------------------------------------- 12 -------
  -- WHAT THIS FEATURE IS FOR. The wholesaler opens the queue and the previous
  -- application is already there — reason, note, date, and which attempt.
  delete from wholesale_v2.v2_signup_requests where wid = w;
  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, status, person_id, reason_code, reason_text, sells, decided_at, reviewed_by)
  values (w,'Noor Boutique','rejected',p_me,'cannot_verify','not enough detail', NOTE_OLD,
          now() - interval '1 day', 'Reapply Co')
  returning id into r1;
  select d.ok into v_ok
    from wholesale_v2.v2_directory_request_access(a_me::text, w, NOTE_NEW) d;

  -- v2_user_profiles.id is FK'd to auth.users, so the wholesaler identity has
  -- to exist there first. Fabricated inside the transaction like everything
  -- else here, and rolled back with it.
  insert into auth.users (id, email) values (wprof, 'gate-reapply@example.invalid')
    on conflict (id) do nothing;
  insert into wholesale_v2.v2_user_profiles (id, role, wid, actor_label)
  values (wprof, 'wholesaler', w, 'Reapply Co') on conflict (id) do nothing;
  perform set_config('request.jwt.claims',
    json_build_object('sub', wprof::text, 'role', 'authenticated')::text, true);

  select q.attempt, q.prior_reason_code, q.prior_note, q.prior_count
    into v_att, v_msg, v_state, n
    from wholesale_v2.v2_pending_access_requests() q where q.wid = w;
  if v_att = 2 and v_msg = 'cannot_verify' and v_state = NOTE_OLD and n = 1 then
    rep := rep || E'\n12  ok   the wholesaler''s queue carries the previous application — attempt, reason, note and count';
  else fails := fails+1; rep := rep || format(E'\n12  FAIL queue history: attempt=%s prior_reason=%L prior_note=%L prior_count=%s', v_att, v_msg, v_state, n); end if;

  -- --------------------------------------------------------------- 13 -------
  -- ...and the buyer's own list carries the standing on the NEWEST row only.
  -- Two live "Ask again" buttons for one wholesaler is one button that lies.
  -- '{}' and not '' or NULL. An EMPTY claims string is not valid json and
  -- v2_my_role() raises on it -- the documented reason
  -- check_bulk_price_safety.sql sits on the environmental-failure list, and
  -- resetting a GUC to NULL inside a transaction leaves it as '' rather than
  -- unset. '{}' is what a real anon PostgREST request looks like: valid json,
  -- no sub, no role, so auth.uid() is null and v2_my_role() falls to 'anon'.
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into n from wholesale_v2.v2_my_access_requests(a_me::text) m
   where m.can_reapply or m.reapply_state is not null;
  if n = 1 then rep := rep || E'\n13  ok   re-apply standing appears on exactly one row per wholesaler, the newest';
  else fails := fails+1; rep := rep || format(E'\n13  FAIL %s of the buyer''s rows carry a re-apply standing', n); end if;

  select count(*) into n from wholesale_v2.v2_my_access_requests(a_me::text) m where m.superseded;
  if n = 1 then rep := rep || E'\n13b ok   ...and the older attempt is flagged superseded, so the screen can fold it into history';
  else fails := fails+1; rep := rep || format(E'\n13b FAIL %s row(s) flagged superseded, expected 1', n); end if;

  -- --------------------------------------------------------------- 14 -------
  -- The queue is not a public list of who has been turned down.
  select count(*) into n from wholesale_v2.v2_pending_access_requests();
  if n = 0 then rep := rep || E'\n14  ok   with no session the queue is empty, not everything';
  else fails := fails+1; rep := rep || format(E'\n14  FAIL a caller with no session read %s pending request(s)', n); end if;

  -- --------------------------------------------------------------- 15 -------
  -- The policy is an operating rule, not a page. A shop that can read it picks
  -- the reason that comes back soonest.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_access_reapply_policy'
     and grantee in ('anon','authenticated','public');
  if n = 0 then rep := rep || E'\n15  ok   no browser role can read the re-apply policy table';
  else fails := fails+1; rep := rep || format(E'\n15  FAIL %s browser grant(s) on the policy table', n); end if;

  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and routine_name='v2_access_reapply_standing'
     and grantee in ('anon','authenticated','public');
  if n = 0 then rep := rep || E'\n15b ok   ...and nothing outside the definer functions can call the standing helper';
  else fails := fails+1; rep := rep || format(E'\n15b FAIL %s role(s) can call v2_access_reapply_standing directly', n); end if;

  if fails > 0 then
    raise exception E'check_access_reapply: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_access_reapply: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
