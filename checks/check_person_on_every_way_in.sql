-- =============================================================================
-- CHECK: nobody gets an account that can never become an OGGI buyer — 126
-- =============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE. Hadi's specification of the share-link model
-- ends: "either way, they get access and they are logged in. **They are signed
-- up to the marketplace itself.**"
--
-- Before 126 that was impossible through any door in the running app. Both
-- paths that create a buyer wrote v2_portal_accounts.person_id = NULL:
--
--   v2_redeem_buyer_invite            (089:243-250)
--   v2_approve_signup_request, anon   (107:171-179)
--
-- An account with no person can never reach the directory, never switch stores,
-- never search across stores, and v2_set_marketplace_password refuses to
-- upgrade it (096:432). It is a login to one shop, for ever. Production carries
-- one such account today.
--
-- WHY THIS FILE ASSERTS A LOGIN AND NOT A COLUMN.
-- "person_id is not null" is cheap to satisfy and proves almost nothing -- a
-- person row with no channel cannot be found by v2_marketplace_login, so it is
-- half an identity that looks whole. Assertions 4 and 5 therefore go all the
-- way: they call the real marketplace login with the phone and the password the
-- buyer just used, and require a session back. That is the sentence Hadi
-- actually said, tested end to end.
--
-- ⛔ AND THE INVARIANT THAT MUST SURVIVE ALL OF IT (090):
--       NORMALISATION MAY SPLIT A PERSON. IT MUST NEVER MERGE TWO.
-- Assertions 8-10 are that rule. 9 is the one that matters: a second store
-- inviting the SAME phone must reach the SAME person and add a membership --
-- that is the marketplace working -- while a DIFFERENT phone must never be
-- pulled onto an existing person, however similar the shop name.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_person_on_every_way_in.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers          (wid, name) values ('zzp00','Person Co'),('zzp01','Second Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzp00','Person Co'),('zzp01','Second Co') on conflict (wid) do nothing;

create temporary table zzp00_results (ord int, label text, expected text, got text) on commit drop;

do $check$
declare
  v_tok      text;
  v_tok2     text;
  v_tok3     text;
  r          record;
  v_person   uuid;
  v_person2  uuid;
  v_acct     uuid;
  n          int;
  v_sess     record;
begin
  ------------------------------------------------------------ DOOR 1: an invite
  -- Issued by hand rather than through v2_issue_buyer_invite, because that RPC
  -- reads v2_my_wid() from a JWT this transaction does not have. The row is
  -- what the RPC would have written.
  insert into wholesale_v2.v2_buyer_invites (wid, shop_name, phone)
  values ('zzp00', 'Rita Boutique', '03 456 789')
  returning token into v_tok;

  select * into r from wholesale_v2.v2_redeem_buyer_invite(v_tok, 'Rita Boutique', 'ritab', 'hunter2secret');

  insert into zzp00_results values
    (1, 'redeeming an invitation succeeds', 'true', r.ok::text);

  select person_id into v_person from wholesale_v2.v2_portal_accounts where id = r.account_id;
  insert into zzp00_results values
    (2, 'and the account it created belongs to a PERSON (was always null)', 'yes',
        case when v_person is null then 'STILL A DEAD END' else 'yes' end);

  -- 3. the membership: the row that actually puts the store in their app
  select count(*) into n from wholesale_v2.v2_person_memberships m
   where m.person_id = v_person and m.wid = 'zzp00' and m.active;
  insert into zzp00_results values
    (3, 'a membership exists, so the store appears in their switcher', '1', n::text);

  -- 4. ⭐ THE SENTENCE ITSELF. Not "a column is set" -- a real marketplace
  --    login, with the number the wholesaler typed and the password the buyer
  --    chose, returning a session.
  select * into v_sess from wholesale_v2.v2_marketplace_login('03 456 789', 'hunter2secret');
  insert into zzp00_results values
    (4, 'they can sign in to OGGI with that phone and that password', 'true',
        coalesce(v_sess.ok::text, 'false'));

  -- 5. and the store is in the list that session can open
  if v_sess.ok then
    select count(*) into n from wholesale_v2.v2_session_stores(v_sess.session_id, v_sess.session_token) s
     where s.wid = 'zzp00';
  else
    n := -1;
  end if;
  insert into zzp00_results values
    (5, 'and their new store is in the list that session can open', '1', n::text);

  ----------------------------------------------------- DOOR 2: an approval
  -- The public "Request access" form. 108 makes the phone required; that is
  -- what the identity is built from.
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, location, volume, sells, status, phone)
  values ('zzp00', 'Maison Farah', 'Beirut', '200/mo', 'Womenswear', 'pending', '03 111 222');

  -- Approving needs owner or the store's own staff. A real staff row, role
  -- 'wholesaler' and never 'owner' -- an owner passes every tenant check and
  -- would make this green for the wrong reason.
  insert into auth.users (id) values ('00000000-0000-4000-8000-00000000fa01') on conflict do nothing;
  insert into wholesale_v2.v2_user_profiles (id, wid, role, actor_label)
  values ('00000000-0000-4000-8000-00000000fa01','zzp00','wholesaler','P00 staff');
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fa01"}', true);

  select * into r from wholesale_v2.v2_approve_signup_request(
    (select id from wholesale_v2.v2_signup_requests where buyer_name = 'Maison Farah'), null);

  insert into zzp00_results values
    (6, 'approving a request from the public form succeeds', 'true', r.ok::text);

  select person_id into v_person2 from wholesale_v2.v2_portal_accounts where id = r.account_id;
  insert into zzp00_results values
    (7, 'and THAT account belongs to a person too (the other dead end)', 'yes',
        case when v_person2 is null then 'STILL A DEAD END' else 'yes' end);

  -- 7b. the one-time password they are handed is their OGGI password as well
  insert into zzp00_results values
    (7, 'and the one-time password works on the marketplace, not just the store', 'true',
        coalesce((select ok::text from wholesale_v2.v2_marketplace_login('03 111 222', r.temp_password)), 'false'));

  ------------------------------------------------ ⛔ THE 090 INVARIANT
  -- 8. the same phone at a SECOND store reaches the SAME person. This is the
  --    marketplace working: one human, two shops, one login.
  insert into wholesale_v2.v2_buyer_invites (wid, shop_name, phone)
  values ('zzp01', 'Rita Boutique Two', '+961 3 456 789')   -- same number, written differently
  returning token into v_tok2;
  select * into r from wholesale_v2.v2_redeem_buyer_invite(v_tok2, 'Rita Boutique Two', 'ritab2', 'hunter2secret');

  insert into zzp00_results values
    (8, 'the same number written differently reaches the SAME person', 'same person',
        case when (select person_id from wholesale_v2.v2_portal_accounts where id = r.account_id)
                  = (select person_id from wholesale_v2.v2_portal_accounts a
                      where a.wid='zzp00' and a.username='ritab')
             then 'same person' else 'A SECOND PERSON WAS CREATED' end);

  -- 9. and they now hold TWO memberships, one per store
  select count(*) into n from wholesale_v2.v2_person_memberships m
   where m.person_id = (select person_id from wholesale_v2.v2_portal_accounts a
                         where a.wid='zzp00' and a.username='ritab')
     and m.active;
  insert into zzp00_results values
    (9, 'one human, two stores, two memberships', '2', n::text);

  -- 10. ⛔ AND A DIFFERENT NUMBER IS A DIFFERENT PERSON, however alike the shop
  --     name. Without this row, "always return the first person you find" would
  --     satisfy assertion 8 and quietly merge the whole platform into one human.
  insert into wholesale_v2.v2_buyer_invites (wid, shop_name, phone)
  values ('zzp01', 'Rita Boutique Three', '03 999 888')
  returning token into v_tok3;
  select * into r from wholesale_v2.v2_redeem_buyer_invite(v_tok3, 'Rita Boutique Three', 'ritab3', 'hunter2secret');

  insert into zzp00_results values
    (10, 'a DIFFERENT number is a different person, however alike the name', 'different',
         case when (select person_id from wholesale_v2.v2_portal_accounts where id = r.account_id)
                   = (select person_id from wholesale_v2.v2_portal_accounts a
                       where a.wid='zzp00' and a.username='ritab')
              then 'TWO PEOPLE WERE MERGED' else 'different' end);

  -- 11. nobody's channel was moved. Every channel still belongs to whoever it
  --     belonged to when it was written -- the invariant stated as a count.
  select count(*) into n from wholesale_v2.v2_person_channels ch
   where ch.kind = 'phone'
   group by ch.normalised having count(distinct ch.person_id) > 1;
  insert into zzp00_results values
    (11, 'no phone number is claimed by two people', '0', coalesce(n,0)::text);

  ------------------------------------------- ⚠ THE HALF STATE, ASSERTED
  -- An applicant with NO phone. Migration 108 made the number required on the
  -- public form, but two requests submitted BEFORE 108 are sitting on
  -- production right now with none, so this is a real case and not a
  -- hypothetical. They get a person and a membership -- the store works, and
  -- the account is not the permanent dead end it used to be -- and they cannot
  -- sign in to OGGI until a number is on file.
  --
  -- Both halves are asserted. Row 14 says the store works; row 15 says the
  -- wholesaler is TOLD about the limit rather than left to discover it. A
  -- silent half state is how "they are signed up to the marketplace" ends up
  -- true of some buyers and not others with nothing on screen to tell them
  -- apart -- which is the shape of the defect this whole file exists to close.
  insert into wholesale_v2.v2_signup_requests (wid, buyer_name, location, volume, sells, status, phone)
  values ('zzp00', 'No Number Shop', 'Tripoli', '50/mo', 'Kidswear', 'pending', null);

  select * into r from wholesale_v2.v2_approve_signup_request(
    (select id from wholesale_v2.v2_signup_requests where buyer_name = 'No Number Shop'), null);

  select count(*) into n from wholesale_v2.v2_person_memberships m
   where m.account_id = r.account_id and m.active;
  insert into zzp00_results values
    (14, 'an applicant with no phone still gets a person and a membership', '1', n::text);

  insert into zzp00_results values
    (15, 'and the wholesaler is TOLD they cannot sign in to OGGI yet', 'told',
         case when r.msg like '%cannot sign in to OGGI%' then 'told' else 'SILENTLY HALF DONE' end);

  perform set_config('request.jwt.claims', '', true);
end
$check$;

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzp00_results

  -- 12. ⛔ THE HELPERS ARE NOT A BROWSER'S TO CALL. v2_ensure_person takes a
  --     phone number and tells you whether it already knows it. Granted to a
  --     browser role that is a way to test whether any number on earth is an
  --     OGGI customer, one call at a time.
  union all select 12, 'the identity helpers are callable by NO browser role', 'none',
    (select coalesce(string_agg(p.proname, ', '), 'none')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='wholesale_v2'
        and p.proname in ('v2_ensure_person','v2_ensure_person_credential')
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')))

  -- 13. and a store invitation may never RESET an existing OGGI password.
  --     v2_ensure_person_credential is insert-on-conflict-do-nothing; if it
  --     ever grows an UPDATE, whoever holds a link can change a password.
  union all select 13, 'a link can never overwrite an existing marketplace password', 'insert only',
    (select case when p.prosrc ~* 'update .*v2_person_credentials|do update'
                 then 'IT CAN OVERWRITE ONE' else 'insert only' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='wholesale_v2' and p.proname='v2_ensure_person_credential')
) r
order by ord, label;

rollback;
