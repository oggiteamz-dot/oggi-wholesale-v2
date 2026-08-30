-- =============================================================================
-- check_access_decisions.sql — AC-08, AC-09, AC-17
-- =============================================================================
-- THE QUESTION: "when somebody is let into a store, or kept out of one, does
-- the system know who decided, when, and why?"
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_access_decisions.sql <db>
--
-- Runs inside a transaction that ROLLS ITSELF BACK. A pass raises
-- ROLLBACK_WITH_REPORT carrying the report; nothing is written, so this file is
-- safe against PRODUCTION -- which matters here more than usual, because the
-- thing under test is an audit log and seeding it with fabricated decisions
-- would damage the evidence it exists to be.
--
-- ⚠️ A runner reading only psql's exit code will mark a PASS as a failure.
-- Look for ROLLBACK_WITH_REPORT.
--
-- ==== THE ASSERTION THAT JUSTIFIES THE WHOLE DESIGN ========================
--
-- Assertion 4. The browser still declines by writing to the table directly --
-- there was no function to call until migration 104 added one, and the client
-- has not been switched over yet. An audit built by editing the approve/decline
-- FUNCTIONS would record nothing for that path, which is the most-used path
-- there is. Assertion 4 does the raw UPDATE the browser does, and requires the
-- log to have caught it.
--
-- Sentinel first: assertion 0 must always appear. A red proof that produces no
-- failures has proven nothing until the gate is known to have run at all.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  rep text := ''; fails int := 0; n int;
  v_wid text := '__gate_ac__';
  v_req uuid; v_inv uuid; v_ok boolean; v_msg text; v_before int;
begin
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  -- ---- fixture -------------------------------------------------------------
  insert into public.wholesalers (wid, name, active) values (v_wid, 'Gate Co', true)
    on conflict (wid) do nothing;
  insert into wholesale_v2.v2_wholesalers (wid, name) values (v_wid, 'Gate Co')
    on conflict (wid) do nothing;

  -- ---------------------------------------------------------------- 1 -------
  -- A REQUEST ARRIVING IS ITSELF AN EVENT. Without it the log can say who was
  -- declined but not how long they waited, which is the number AC-11 needs.
  select count(*) into v_before from wholesale_v2.v2_audit_log;
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, location, status)
  values (v_wid, 'Gate Shop', 'Beirut', 'pending') returning id into v_req;

  select count(*) into n from wholesale_v2.v2_audit_log
   where action = 'access_requested' and target_id = v_req::text;
  if n = 1 then rep := rep || E'\n 1  ok   a request arriving is recorded, with the time it arrived';
  else fails := fails+1; rep := rep || format(E'\n 1  FAIL a new request produced %s audit row(s)', n); end if;

  -- ---------------------------------------------------------------- 2 -------
  -- Editing a pending request without deciding it is NOT an access decision.
  select count(*) into v_before from wholesale_v2.v2_audit_log;
  update wholesale_v2.v2_signup_requests set location = 'Tripoli' where id = v_req;
  select count(*) - v_before into n from wholesale_v2.v2_audit_log;
  if n = 0 then rep := rep || E'\n 2  ok   editing a pending request recorded nothing — the log stays readable';
  else fails := fails+1; rep := rep || format(E'\n 2  FAIL a non-decision added %s row(s)', n); end if;

  -- ---------------------------------------------------------------- 3 -------
  -- A DECLINE WITHOUT A REASON IS REFUSED, and nothing is changed by the
  -- refusal. Run as postgres v2_is_owner() is false, so authorisation is
  -- checked first -- assert on the row, not on the message.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_decline_signup_request(v_req, null, null) d;
  select count(*) into n from wholesale_v2.v2_signup_requests
   where id = v_req and status = 'pending';
  if not v_ok and n = 1 then
    rep := rep || E'\n 3  ok   a decline with no reason changed nothing';
  else fails := fails+1; rep := rep || format(E'\n 3  FAIL decline-without-reason returned ok=%s and left status changed', v_ok); end if;

  -- ---------------------------------------------------------------- 4 -------
  -- ⭐ THE ONE THAT JUSTIFIES THE DESIGN.
  -- This is EXACTLY what js/data/owner.js does today: a raw table UPDATE from
  -- the browser, with no function involved. An audit written into the approve
  -- and decline functions would be blind to it.
  select count(*) into v_before from wholesale_v2.v2_audit_log;
  update wholesale_v2.v2_signup_requests
     set status = 'rejected', reviewed_by = 'the old browser path', reviewed_at = now()
   where id = v_req;

  select count(*) into n from wholesale_v2.v2_audit_log
   where action = 'access_declined' and target_id = v_req::text;
  if n = 1 then
    rep := rep || E'\n 4  ok   ⭐ THE BROWSER''S RAW TABLE WRITE WAS CAUGHT — the path with no function to edit is recorded anyway';
  else fails := fails+1;
    rep := rep || format(E'\n 4  FAIL the raw browser decline produced %s audit row(s) — an audit that only watches functions is blind to the most-used path', n); end if;

  -- ---------------------------------------------------------------- 5 -------
  -- AC-09: it is a STATE. The row survives, so AC-10 can attach it to a
  -- re-application later. Shopify's reject deletes the company; this must not.
  select count(*) into n from wholesale_v2.v2_signup_requests where id = v_req;
  if n = 1 then rep := rep || E'\n 5  ok   the declined request still exists — reject is a state, never a deletion';
  else fails := fails+1; rep := rep || E'\n 5  FAIL the declined request was deleted'; end if;

  -- ---------------------------------------------------------------- 6 -------
  -- The reason vocabulary is the database's, not the screen's.
  begin
    update wholesale_v2.v2_signup_requests set reason_code = 'made_up' where id = v_req;
    fails := fails+1; rep := rep || E'\n 6a FAIL an unknown decline reason was accepted';
  exception when check_violation then rep := rep || E'\n 6a ok   an unknown decline reason was refused'; end;
  begin
    update wholesale_v2.v2_signup_requests set reason_code = 'other', reason_text = null where id = v_req;
    fails := fails+1; rep := rep || E'\n 6b FAIL "other" was accepted with no explanation — the loophole that makes a required reason optional';
  exception when check_violation then rep := rep || E'\n 6b ok   "other" still requires an explanation'; end;

  -- ---------------------------------------------------------------- 7 -------
  -- The reason reaches the LOG, not just the row. A reason only visible by
  -- reading the request row cannot answer "why did we decline this shop in
  -- March" once the row has been re-used by a re-application.
  update wholesale_v2.v2_signup_requests
     set status = 'pending', reason_code = null, reason_text = null where id = v_req;
  update wholesale_v2.v2_signup_requests
     set status = 'rejected', reason_code = 'outside_area', reason_text = 'no delivery to Akkar yet'
   where id = v_req;
  select count(*) into n from wholesale_v2.v2_audit_log
   where target_id = v_req::text and action = 'access_declined'
     and details->>'reason_code' = 'outside_area'
     and details->>'reason_text' = 'no delivery to Akkar yet';
  if n = 1 then rep := rep || E'\n 7  ok   the reason is in the log, not only on the row';
  else fails := fails+1; rep := rep || format(E'\n 7  FAIL the decline reason did not reach the log (%s matching rows)', n); end if;

  -- ---------------------------------------------------------------- 8 -------
  -- Approving is recorded too. The approve RPC still contains no audit insert;
  -- this passes because the trigger watches the table.
  update wholesale_v2.v2_signup_requests set status = 'approved' where id = v_req;
  select count(*) into n from wholesale_v2.v2_audit_log
   where target_id = v_req::text and action = 'access_approved';
  if n = 1 then rep := rep || E'\n 8  ok   approving is recorded — without a single line added to the approve function';
  else fails := fails+1; rep := rep || format(E'\n 8  FAIL approving produced %s audit row(s)', n); end if;

  -- ---------------------------------------------------------------- 9 -------
  -- Declining something already approved is refused, and says what to do
  -- instead. Silently declining it would leave a working login behind a
  -- rejected request.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_decline_signup_request(v_req, 'cannot_verify', null) d;
  if not v_ok and v_msg ilike '%ban%' then
    rep := rep || E'\n 9  ok   declining an approved request is refused, and points at the action that actually closes the login';
  else fails := fails+1; rep := rep || format(E'\n 9  FAIL declining an approved request returned ok=%s (%s)', v_ok, left(coalesce(v_msg,''),60)); end if;

  -- --------------------------------------------------------------- 10 -------
  -- Invitations are the other way in.
  insert into wholesale_v2.v2_buyer_invites (wid, token, shop_name, phone, expires_at)
  values (v_wid, 'tok_SECRET_do_not_log_me', 'Gate Shop', '96170123456', now() + interval '7 days')
  returning id into v_inv;
  select count(*) into n from wholesale_v2.v2_audit_log
   where action='invite_issued' and target_id = v_inv::text;
  if n = 1 then rep := rep || E'\n10a ok   issuing an invitation is recorded';
  else fails := fails+1; rep := rep || format(E'\n10a FAIL issuing an invitation produced %s row(s)', n); end if;

  update wholesale_v2.v2_buyer_invites set revoked_at = now() where id = v_inv;
  select count(*) into n from wholesale_v2.v2_audit_log
   where action='invite_revoked' and target_id = v_inv::text;
  if n = 1 then rep := rep || E'\n10b ok   revoking an invitation is recorded';
  else fails := fails+1; rep := rep || format(E'\n10b FAIL revoking an invitation produced %s row(s)', n); end if;

  -- --------------------------------------------------------------- 11 -------
  -- ⭐ THE TOKEN IS THE CREDENTIAL AND MUST NOT BE IN THE LOG. The audit log is
  -- read by more people, and for longer, than the invitation is valid for.
  select count(*) into n from wholesale_v2.v2_audit_log
   where details::text like '%tok_SECRET_do_not_log_me%';
  if n = 0 then rep := rep || E'\n11  ok   ⭐ the invite token never reached the audit log';
  else fails := fails+1; rep := rep || format(E'\n11  FAIL the invite TOKEN is in %s audit row(s) — that is the credential', n); end if;

  -- ...but enough to identify the invitation to a human.
  select count(*) into n from wholesale_v2.v2_audit_log
   where action='invite_issued' and target_id = v_inv::text
     and details->>'shop_name' = 'Gate Shop' and details->>'phone_last4' = '3456';
  if n = 1 then rep := rep || E'\n11b ok   ...while still naming the shop and the last four digits, so the row means something';
  else fails := fails+1; rep := rep || E'\n11b FAIL the invite row cannot be identified by a human'; end if;

  -- --------------------------------------------------------------- 12 -------
  -- The log stays owner-only. An access-decision history readable by every
  -- wholesaler is a list of who else applied where.
  select count(*) into n from pg_policies
   where schemaname='wholesale_v2' and tablename='v2_audit_log' and qual ilike '%is_owner%';
  if n >= 1 then rep := rep || E'\n12  ok   the audit log is still owner-only';
  else fails := fails+1; rep := rep || E'\n12  FAIL the audit log is no longer owner-scoped'; end if;

  -- ---------------------------------------------------------------------------
  if fails > 0 then
    raise exception E'check_access_decisions: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_access_decisions: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
