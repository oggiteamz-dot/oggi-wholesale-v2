-- =====================================================================
-- check_client_ban.sql — does a ban actually stop anything?
--
-- RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f checks/check_client_ban.sql
-- PASS: exit code 0
-- FAIL: raises, non-zero exit. Read the message; every failure names
--       which numbered assertion broke and what it saw instead.
--
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------
-- A ban is the easiest feature in this codebase to fake. Flip a column,
-- paint the row red, and every naive test passes: the flag is set, the
-- badge renders, the wholesaler is satisfied. Meanwhile the buyer is
-- still signed in and still ordering.
--
-- On a Supabase-Auth product that is not hypothetical, it is the DEFAULT
-- behaviour -- Supabase's own docs say a ban "does not revoke existing
-- sessions", and an already-issued JWT keeps working until it expires.
-- v2's buyers happen to sit in v2_portal_accounts with a bcrypt hash
-- rather than in Supabase Auth, so v2 dodges that specific trap -- but
-- only by accident of an old decision, not by design. This file is what
-- makes it on purpose.
--
-- So the assertions below are deliberately about CONSEQUENCES, never
-- about state:
--   not "is status = 'banned'"  but  "does login now refuse them"
--   not "is there a ban row"    but  "can they still act mid-session"
--   not "does the badge render" but  "is the OTHER wholesaler untouched"
--
-- THIS CHECK MUST BE ABLE TO GO RED. It was proven to on 20 Aug 2026 by
-- running assertion 5a with the ban step removed: it raised
-- "BANNED BUYER STILL LOGGED IN -- ban is decoration", as designed. A
-- check that has never failed has never been tested.
--
-- It creates its own data under shop_name 'ZZ Ban Proof Shop' and deletes
-- every row it made, including the audit entries. It is safe to run
-- against production and leaves nothing behind.
-- =====================================================================
do $proof$
declare
  -- SQUARE Wholesale's admin profile: the ban RPCs check ownership, so
  -- the check must run AS a wholesaler, not as a superuser.
  SQ_PROFILE constant uuid := 'a315d124-1038-4a7a-a76a-6c8ada1d3594';
  PW constant text := 'BanProof!2026';
  c_sq uuid; c_test uuid; a_sq uuid; a_test uuid;
  r record; n int; fails text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', SQ_PROFILE::text)::text, false);

  -- The same human, known to TWO wholesalers. This is the shape that
  -- makes assertion 8 meaningful.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
  values ('sq','ZZ Ban Proof Shop','+96170000001') returning id into c_sq;
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
  values ('test','ZZ Ban Proof Shop','+96170000001') returning id into c_test;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
  values ('sq','buyer','zzbanproof', extensions.crypt(PW, extensions.gen_salt('bf')), c_sq,'ZZ Proof')
  returning id into a_sq;
  insert into wholesale_v2.v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
  values ('test','buyer','zzbanproof', extensions.crypt(PW, extensions.gen_salt('bf')), c_test,'ZZ Proof')
  returning id into a_test;

  -- 1. Baseline. If this fails the rest proves nothing.
  select * into r from wholesale_v2.v2_buyer_login('sq','zzbanproof',PW);
  if not (r.ok and r.status='ok') then fails := fails||E'\n  [1] login should work BEFORE the ban; got ok='||r.ok||' status='||coalesce(r.status,'null'); end if;

  -- 2. The ban itself.
  select * into r from wholesale_v2.v2_ban_client(c_sq,'bad_conduct','Proof run');
  if not r.ok then fails := fails||E'\n  [2] ban was rejected: '||r.msg; end if;

  -- 3. The legacy `active` boolean must follow the new status enum, or
  --    every pre-059 query that filters on it silently disagrees.
  select status::text as st, active into r from wholesale_v2.v2_clients where id=c_sq;
  if r.st<>'banned' then fails := fails||E'\n  [3a] status should be banned, got '||r.st; end if;
  if r.active then fails := fails||E'\n  [3b] legacy active flag not synced -- trigger broken'; end if;

  -- 4. The login row is switched off in the same transaction.
  select active into r from wholesale_v2.v2_portal_accounts where id=a_sq;
  if r.active then fails := fails||E'\n  [4] portal account still active after ban'; end if;

  -- 5. THE ONE THAT MATTERS.
  select * into r from wholesale_v2.v2_buyer_login('sq','zzbanproof',PW);
  if r.ok then fails := fails||E'\n  [5a] BANNED BUYER STILL LOGGED IN -- ban is decoration'; end if;
  if coalesce(r.status,'')<>'banned' then fails := fails||E'\n  [5b] should report banned, got '||coalesce(r.status,'null'); end if;
  if coalesce(r.banned_by_name,'')<>'SQUARE Wholesale' then fails := fails||E'\n  [5c] must name the wholesaler, got '||coalesce(r.banned_by_name,'null'); end if;

  -- 6. Telling a banned person why must not become a way to discover
  --    which usernames exist. Wrong password stays blank.
  select * into r from wholesale_v2.v2_buyer_login('sq','zzbanproof','wrong-password');
  if coalesce(r.status,'')<>'bad' then fails := fails||E'\n  [6a] wrong password should be generic, got '||coalesce(r.status,'null'); end if;
  if r.banned_by_name is not null then fails := fails||E'\n  [6b] LEAK: a wrong password revealed the ban'; end if;

  -- 7. Mid-session, not just at the door.
  if wholesale_v2.v2_account_can_act(a_sq) then fails := fails||E'\n  [7] banned account can still act mid-session'; end if;

  -- 8. The ban belongs to ONE relationship. Thrown out by SQUARE must
  --    never mean thrown off OGGI.
  select * into r from wholesale_v2.v2_buyer_login('test','zzbanproof',PW);
  if not (r.ok and r.status='ok') then fails := fails||E'\n  [8a] BAN LEAKED ACROSS WHOLESALERS; got status='||coalesce(r.status,'null'); end if;
  if not wholesale_v2.v2_account_can_act(a_test) then fails := fails||E'\n  [8b] other wholesaler''s account wrongly blocked'; end if;

  -- 9/10. The guardrails.
  select * into r from wholesale_v2.v2_ban_client(c_sq,'non_payment',null);
  if r.ok then fails := fails||E'\n  [9] double-ban should be refused'; end if;
  select * into r from wholesale_v2.v2_ban_client(c_test,'other','   ');
  if r.ok then fails := fails||E'\n  [10] reason "other" with blank text should be refused'; end if;

  -- 11. Reversible, fully.
  select * into r from wholesale_v2.v2_unban_client(c_sq,'Proof cleanup');
  if not r.ok then fails := fails||E'\n  [11a] unban failed: '||r.msg; end if;
  select * into r from wholesale_v2.v2_buyer_login('sq','zzbanproof',PW);
  if not (r.ok and r.status='ok') then fails := fails||E'\n  [11b] login should work again after unban, got '||coalesce(r.status,'null'); end if;

  -- 12. ...but the history is NOT erased by the reversal.
  select count(*) into n from wholesale_v2.v2_client_bans where client_id=c_sq;
  if n<>1 then fails := fails||E'\n  [12a] ban record should survive the unban, found '||n; end if;
  select count(*) into n from wholesale_v2.v2_client_bans where client_id=c_sq and reversed_at is not null and reversed_by is not null;
  if n<>1 then fails := fails||E'\n  [12b] reversal not stamped with who and when'; end if;

  delete from wholesale_v2.v2_client_bans where client_id in (c_sq,c_test);
  delete from wholesale_v2.v2_portal_accounts where id in (a_sq,a_test);
  delete from wholesale_v2.v2_clients where id in (c_sq,c_test);
  delete from wholesale_v2.v2_audit_log where target_id in (c_sq::text,c_test::text);
  delete from wholesale_v2.v2_login_throttle where key like 'buyer|%|zzbanproof';
  perform set_config('request.jwt.claims', null, false);

  if fails <> '' then
    raise exception 'CLIENT BAN CHECK FAILED:%', fails;
  end if;
  raise notice 'check_client_ban: PASS (12 assertions)';
end
$proof$;
