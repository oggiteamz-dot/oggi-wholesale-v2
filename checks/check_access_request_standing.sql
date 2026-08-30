-- =============================================================================
-- check_access_request_standing.sql — AC-07, AC-11, PB-01
-- =============================================================================
-- THE QUESTION: "a shop asked a wholesaler for access. Can that shop find out
-- what happened, without asking a human?"
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_access_request_standing.sql <db>
-- Rolls itself back. A pass raises ROLLBACK_WITH_REPORT. ⚠️ A runner reading
-- only the exit code will call a PASS a failure.
--
-- THE TWO THAT MATTER MOST:
--
--   * ASSERTION 3 — one buyer cannot see another buyer's requests. This
--     function returns rejections, and a rejection is the single most private
--     thing in the access flow. It takes no person and no wid for exactly that
--     reason, and assertion 2 asserts it never grows one.
--
--   * ASSERTION 7 — each wholesaler's OWN stated time is used. A single global
--     number would make OGGI the one promising something a wholesaler never
--     agreed to, and the first slow wholesaler would make OGGI look dishonest.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  rep text := ''; fails int := 0; n int;
  w_fast text := '__gate_fast__'; w_slow text := '__gate_slow__';
  p_me uuid := '11111111-aaaa-4aaa-8aaa-111111111111';
  p_other uuid := '22222222-bbbb-4bbb-8bbb-222222222222';
  a_me uuid; a_other uuid; r_pend uuid; r_old uuid; r_dec uuid; v_txt text; v_b boolean;
begin
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  -- ---- fixture: two wholesalers with DIFFERENT stated times, two people -----
  insert into public.wholesalers (wid, name, active) values
    (w_fast,'Fast Co',true), (w_slow,'Slow Co',true) on conflict (wid) do nothing;
  insert into wholesale_v2.v2_wholesalers (wid, name, access_sla_hours) values
    (w_fast,'Fast Co',4), (w_slow,'Slow Co',240) on conflict (wid) do nothing;
  update wholesale_v2.v2_wholesalers set access_sla_hours = 4   where wid = w_fast;
  update wholesale_v2.v2_wholesalers set access_sla_hours = 240 where wid = w_slow;

  insert into wholesale_v2.v2_people (id) values (p_me), (p_other) on conflict do nothing;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, person_id, actor_label)
  values (w_fast,'buyer','gate_me','x',p_me,'Me') returning id into a_me;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, person_id, actor_label)
  values (w_fast,'buyer','gate_other','x',p_other,'Other') returning id into a_other;

  -- mine: one fresh pending, one long-overdue pending, one declined
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, person_id, created_at)
  values (w_slow,'My Shop','pending',p_me, now()) returning id into r_pend;
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, person_id, created_at)
  values (w_fast,'My Shop','pending',p_me, now() - interval '9 hours') returning id into r_old;
  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, status, person_id, reason_code, reason_text, decided_at)
  values (w_fast,'My Shop','rejected',p_me,'outside_area','no delivery to Akkar yet', now())
  returning id into r_dec;
  -- somebody else's, at the same wholesaler
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, person_id)
  values (w_fast,'Their Shop','rejected',p_other);

  -- ---------------------------------------------------------------- 1 -------
  select count(*) into n from wholesale_v2.v2_my_access_requests(a_me::text);
  if n = 3 then rep := rep || E'\n 1  ok   a buyer sees all three of their own requests';
  else fails := fails+1; rep := rep || format(E'\n 1  FAIL a buyer saw %s of their 3 requests', n); end if;

  -- ---------------------------------------------------------------- 2 -------
  select pg_get_function_identity_arguments(p.oid) into v_txt
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_my_access_requests';
  if v_txt !~* 'person' and v_txt !~* '\mwid\M' then
    rep := rep || E'\n 2  ok   the function takes no person and no wid — scope is derived, never supplied';
  else fails := fails+1; rep := rep || format(E'\n 2  FAIL it accepts %s', v_txt); end if;

  -- ---------------------------------------------------------------- 3 -------
  -- ⭐ A rejection is the most private thing in this flow.
  select count(*) into n from wholesale_v2.v2_my_access_requests(a_me::text) q
   where q.request_id = (select id from wholesale_v2.v2_signup_requests
                          where person_id = p_other limit 1);
  if n = 0 then rep := rep || E'\n 3  ok   ⭐ one buyer cannot see another buyer''s request, at the same wholesaler';
  else fails := fails+1; rep := rep || E'\n 3  FAIL a buyer saw somebody else''s request'; end if;

  select count(*) into n from wholesale_v2.v2_my_access_requests(a_other::text);
  if n = 1 then rep := rep || E'\n 3b ok   ...and the other buyer sees exactly their own one';
  else fails := fails+1; rep := rep || format(E'\n 3b FAIL the other buyer saw %s row(s)', n); end if;

  -- ---------------------------------------------------------------- 4 -------
  -- A fresh request at a slow wholesaler is NOT overdue.
  select q.overdue into v_b from wholesale_v2.v2_my_access_requests(a_me::text) q
   where q.request_id = r_pend;
  if v_b is false then rep := rep || E'\n 4  ok   a fresh request is not flagged as late';
  else fails := fails+1; rep := rep || E'\n 4  FAIL a request made seconds ago is already late'; end if;

  -- ---------------------------------------------------------------- 5 -------
  -- Nine hours old at a wholesaler who says four IS overdue.
  select q.overdue into v_b from wholesale_v2.v2_my_access_requests(a_me::text) q
   where q.request_id = r_old;
  if v_b then rep := rep || E'\n 5  ok   a request past its wholesaler''s stated time is flagged late';
  else fails := fails+1; rep := rep || E'\n 5  FAIL a 9-hour-old request at a 4-hour wholesaler is not flagged'; end if;

  -- ---------------------------------------------------------------- 6 -------
  -- The decline reason travels, and the CODE is what travels — the wording is
  -- the client's job, from the one shared list.
  select q.reason_code into v_txt from wholesale_v2.v2_my_access_requests(a_me::text) q
   where q.request_id = r_dec;
  if v_txt = 'outside_area' then rep := rep || E'\n 6  ok   the decline reason reaches the buyer''s own view';
  else fails := fails+1; rep := rep || format(E'\n 6  FAIL the reason came back as %s', coalesce(v_txt,'null')); end if;

  -- ---------------------------------------------------------------- 7 -------
  -- ⭐ EACH WHOLESALER'S OWN NUMBER, not one global.
  select count(distinct q.sla_hours) into n from wholesale_v2.v2_my_access_requests(a_me::text) q;
  if n = 2 then rep := rep || E'\n 7  ok   ⭐ each wholesaler''s own stated time is used (two different numbers came back)';
  else fails := fails+1; rep := rep || format(E'\n 7  FAIL %s distinct stated time(s) across two wholesalers — a single global number would have OGGI promising something no wholesaler agreed to', n); end if;

  -- ---------------------------------------------------------------- 8 -------
  -- The overdue list is the OWNER's. Run as postgres, v2_is_owner() is false.
  select count(*) into n from wholesale_v2.v2_overdue_access_requests();
  if n = 0 then rep := rep || E'\n 8  ok   the overdue list is empty to a non-owner — it is a list of who is keeping shops waiting';
  else fails := fails+1; rep := rep || format(E'\n 8  FAIL a non-owner listed %s overdue request(s)', n); end if;

  -- ---------------------------------------------------------------- 9 -------
  -- The directory carries the number, and still carries no prices.
  select pg_get_function_result(p.oid) into v_txt
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_directory_list';
  if v_txt ~* 'access_sla_hours' then rep := rep || E'\n 9  ok   the directory carries each wholesaler''s stated time';
  else fails := fails+1; rep := rep || E'\n 9  FAIL the directory does not carry the stated time'; end if;
  if v_txt !~* 'price' and v_txt !~* 'product' then
    rep := rep || E'\n 9b ok   ...and DR-05 still holds: no price, no product, in the directory projection';
  else fails := fails+1; rep := rep || format(E'\n 9b FAIL the directory projection now contains %s', v_txt); end if;

  -- --------------------------------------------------------------- 10 -------
  -- Called from a render path: bad input returns nothing rather than raising.
  select count(*) into n from wholesale_v2.v2_my_access_requests('not-a-uuid');
  if n = 0 then rep := rep || E'\n10  ok   a malformed account id returns nothing rather than raising';
  else fails := fails+1; rep := rep || E'\n10  FAIL a malformed account id returned rows'; end if;

  if fails > 0 then
    raise exception E'check_access_request_standing: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_access_request_standing: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
