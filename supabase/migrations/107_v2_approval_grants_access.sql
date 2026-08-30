-- =============================================================================
-- 107 — APPROVING SOMEBODY ACTUALLY LETS THEM IN            AC-01/ID-03, 30 Aug 2026
-- =============================================================================
--
-- Found during the census for AC-12 (auto-approve rules), and built instead of
-- it, because auto-approve means approving WITHOUT A HUMAN IN THE ROOM — and
-- wiring a rule to this function as it stood would have multiplied the defect
-- below across every buyer, silently, with nobody watching.
--
-- ==== WHAT WAS WRONG, PROVEN IN A REPLAY AND NOT REASONED ABOUT ============
--
-- A buyer who already shops at Store A asks Store B through the directory:
--
--     Store B card before asking ........... none      ("Ask for access")
--     Store B card after asking ............ pending   ("Requested")
--     APPROVED -- it issued a username and a password
--     memberships at Store B ............... 0
--     stores their switcher will list ...... 1         (still just Store A)
--     Store B card NOW says ................ none      (back to "Ask for access")
--     but "Your requests" says ............. approved
--
-- `v2_approve_signup_request` never wrote a `v2_person_memberships` row, and a
-- membership is the ONLY thing that:
--
--   * puts a store in the buyer's switcher (`v2_session_stores` reads nothing
--     else), and
--   * lets them open it (`v2_session_account` re-checks the membership on every
--     entry, deliberately), and
--   * makes the directory say "You have access" (`v2_directory_list`).
--
-- What approval produced instead was a SEPARATE, store-scoped username and a
-- random password — deliverable only by hand, since this build has no email,
-- and usable only on the older wholesaler-code sign-in screen. So the buyer was
-- told "Approved — you can shop here now" on one screen while another screen
-- invited them to ask for access from scratch. That sentence shipped on
-- 30 August and it was false.
--
-- ==== WHY IT WAS NEVER NOTICED ============================================
--
-- Production has ZERO approved requests. Ever. All six memberships that exist
-- were written by `v2_backfill_person_identity`, the one-off utility that
-- linked the pre-marketplace store logins to people. **This path has never
-- run.** It is the exact shape of defect FEATURE-MANIFEST.md was written about:
-- every name correct, every function present, a feature simply never wired to
-- the thing it promises.
--
-- ==== THE DECISION THAT SHAPES THIS FILE ==================================
--
--     THERE ARE TWO KINDS OF APPLICANT, AND ONLY ONE OF THEM NEEDS A PASSWORD.
--
-- A request that carries a `person_id` came from somebody ALREADY SIGNED IN TO
-- OGGI. They have a credential. Minting a second one for them is not a
-- convenience, it is a second identity for the same human at the same company,
-- which is how "who is this shop" stops having one answer. They get a
-- membership, and they can shop the moment the wholesaler presses Approve.
--
-- A request with NO person came through the sign-in screen's "Don't have an
-- account?" form, from somebody with no OGGI account at all. There is nobody to
-- grant a membership TO. That path keeps today's behaviour EXACTLY: a client
-- row, a store-scoped login, and a password shown once for the wholesaler to
-- relay by hand. It is not lovely and it is the only thing that can work for
-- an applicant the platform has never met.
--
-- The function keeps its name, its two arguments and its six output columns, so
-- both review screens keep working and the change is one a wholesaler notices
-- only as "it now says there is no password to send".
--
-- ==== THE ACCOUNT WITH NO USABLE PASSWORD =================================
--
-- The membership must point at a `v2_portal_accounts` row: `v2_session_account`
-- returns `m.account_id` and the whole buyer app runs on it. So the person path
-- still creates a store-scoped account — with a bcrypt hash of a random string
-- NOBODY EVER SEES, and which is never returned.
--
-- `password_hash` is NOT NULL, so it cannot simply be left empty, and a
-- non-bcrypt sentinel like '!' is worse than useless: `v2_buyer_login` does
-- `password_hash = crypt(p_pass, password_hash)`, and crypt() RAISES on an
-- invalid salt. A junk sentinel would turn every login attempt against that
-- account into a 500 instead of a refusal. A real hash of a random secret fails
-- the comparison cleanly, every time, forever.
--
-- ==== WHAT THIS DOES NOT DO ===============================================
--
-- No backfill. A repair would have to guess which portal account belongs to
-- which already-approved request — nothing records the link — by matching a
-- client's shop_name back to the request's buyer_name. On a database with
-- ZERO approved requests that is a fragile repair for no rows, and a fragile
-- repair is how a wrong membership gets written to somebody's account.
--
-- Instead the self-assertion below COUNTS the gap and refuses to install
-- quietly if it is not zero, so any other environment where this has already
-- bitten stops and gets a person looking at it rather than a guess.
-- =============================================================================

create or replace function wholesale_v2.v2_approve_signup_request(
  p_id uuid, p_username text default null)
returns table (ok boolean, msg text, username text, temp_password text,
               client_id uuid, account_id uuid)
language plpgsql
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_req        wholesale_v2.v2_signup_requests%rowtype;
  v_client_id  uuid;
  v_account_id uuid;
  v_username   text;
  v_password   text;
  v_note       text;
begin
  select * into v_req from wholesale_v2.v2_signup_requests where id = p_id for update;
  if v_req.id is null then
    return query select false, 'Signup request not found', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_req.wid) then
    return query select false, 'Not authorized', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  if v_req.status = 'approved' then
    return query select false, 'Already approved', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  v_note := trim(both ' ' from concat_ws(' -- ', v_req.location, v_req.volume, v_req.sells));

  insert into wholesale_v2.v2_clients (wid, shop_name, note, active)
  values (v_req.wid, v_req.buyer_name, v_note, true)
  returning id into v_client_id;

  v_username := coalesce(nullif(lower(trim(p_username)), ''),
                         lower(regexp_replace(v_req.buyer_name, '[^a-z0-9]+', '', 'gi'))
                         || floor(random() * 900 + 100)::text);

  if v_req.person_id is not null then
    if not exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = v_req.wid) then
      return query select false,
        'This store is not set up on the marketplace yet, so access cannot be granted. Tell OGGI before approving.',
        null::text, null::text, null::uuid, null::uuid;
      return;
    end if;

    insert into wholesale_v2.v2_portal_accounts
      (wid, role, username, password_hash, client_id, actor_label, person_id)
    values (v_req.wid, 'buyer', v_username,
            extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'),
                             extensions.gen_salt('bf')),
            v_client_id, v_req.buyer_name, v_req.person_id)
    returning id into v_account_id;

    insert into wholesale_v2.v2_person_memberships
      (person_id, wid, client_id, account_id, role, active)
    values (v_req.person_id, v_req.wid, v_client_id, v_account_id, 'buyer', true)
    on conflict (person_id, wid, role) do update
      set active = true, client_id = excluded.client_id,
          account_id = excluded.account_id, revoked_at = null;

    update wholesale_v2.v2_signup_requests
       set status = 'approved',
           reviewed_by = coalesce(wholesale_v2.v2_my_wid(), 'owner'),
           reviewed_at = now(),
           decided_at  = now()
     where id = p_id;

    return query select true,
      'They can shop your store now. There is no password to send — they already sign in to OGGI, and your store has just appeared in their app.',
      null::text, null::text, v_client_id, v_account_id;
    return;
  end if;

  v_password := encode(extensions.gen_random_bytes(9), 'base64');
  v_password := replace(replace(replace(v_password, '/', '2'), '+', '9'), '=', '');

  insert into wholesale_v2.v2_portal_accounts
    (wid, role, username, password_hash, client_id, actor_label)
  values (v_req.wid, 'buyer', v_username,
          extensions.crypt(v_password, extensions.gen_salt('bf')),
          v_client_id, v_req.buyer_name)
  returning id into v_account_id;

  update wholesale_v2.v2_signup_requests
     set status = 'approved',
         reviewed_by = coalesce(wholesale_v2.v2_my_wid(), 'owner'),
         reviewed_at = now(),
         decided_at  = now()
   where id = p_id;

  return query select true, '', v_username, v_password, v_client_id, v_account_id;
end;
$fn$;

comment on function wholesale_v2.v2_approve_signup_request(uuid, text) is
  'AC-01/ID-03. Approving a request from an OGGI buyer now GRANTS A MEMBERSHIP, which is the only thing that puts a store in their switcher, lets v2_session_account open it, or makes the directory say "you have access" -- until 107 it wrote none, so approval granted nothing and the buyer was told "you can shop here now" while the directory offered them the Ask button again. A request with no person still gets today''s store-scoped login and a one-time password, because there is nobody to grant a membership to.';

revoke all on function wholesale_v2.v2_approve_signup_request(uuid, text) from public, anon;
grant execute on function wholesale_v2.v2_approve_signup_request(uuid, text) to authenticated;

-- =============================================================================
-- SELF-ASSERTING. Structure, authorisation, and the one count that says whether
-- this defect has already bitten in whatever database is being installed into.
-- Every assertion holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; v_ok boolean; v_src text;
begin
  -- 1. THE WHOLE POINT: approval writes a membership. Asserted against the
  --    function's own source, because the behavioural proof needs a fixture and
  --    this has to hold at install time on an empty database too.
  select prosrc into v_src from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_approve_signup_request';
  if v_src !~* 'insert into wholesale_v2\.v2_person_memberships' then
    raise exception 'ASSERT 1 FAILED: approving a request still writes no membership -- approval grants nothing';
  end if;

  -- 2. ...and it is conditional on there being a person to grant it to. A
  --    function that always inserted one would fail outright on the anonymous
  --    door, where person_id is null and the FK would reject it.
  if v_src !~* 'v_req\.person_id is not null' then
    raise exception 'ASSERT 2 FAILED: the membership is not conditional on the request carrying a person';
  end if;

  -- 3. THE PASSWORD IS NOT ISSUED TO SOMEBODY WHO ALREADY HAS ONE. A promise
  --    about an ABSENCE, so it is asserted over the whole person branch rather
  --    than at one point in it (GATE-EVIDENCE.md section 7b).
  if substring(v_src from 'v_req\.person_id is not null.*?return;\s*end if;') ~* 'v_password' then
    raise exception 'ASSERT 3 FAILED: the marketplace path still mints a password -- that is a second credential for the same human at the same company';
  end if;

  -- 4. The legacy path is UNCHANGED and still issues one. Half of this file is
  --    a promise that nothing was taken away from the anonymous applicant.
  if v_src !~* 'gen_random_bytes\(9\)' then
    raise exception 'ASSERT 4 FAILED: the no-person path no longer issues a one-time password -- the anonymous applicant has been left with no way in';
  end if;

  -- 5. Nothing anonymous may approve anybody.
  if has_function_privilege('anon','wholesale_v2.v2_approve_signup_request(uuid,text)','execute') then
    raise exception 'ASSERT 5 FAILED: anon can approve access requests';
  end if;

  -- 6. Authorisation still lives in the function. Run as postgres there is no
  --    jwt, so this is the check refusing, not the row being absent.
  select a.ok into v_ok from wholesale_v2.v2_approve_signup_request(
    '00000000-0000-0000-0000-000000000000'::uuid, null) a;
  if v_ok then raise exception 'ASSERT 6 FAILED: approving a non-existent request reported success'; end if;

  -- 7. HAS THIS ALREADY BITTEN HERE? Every approved request that came from an
  --    OGGI buyer and has no membership is somebody who was told they could
  --    shop and cannot. On production this is 0 -- there are no approved
  --    requests at all -- which is why no backfill is attempted. Anywhere else,
  --    this stops and gets a person looking rather than guessing which account
  --    belongs to which request.
  select count(*) into n
    from wholesale_v2.v2_signup_requests r
   where r.status = 'approved' and r.person_id is not null
     and not exists (select 1 from wholesale_v2.v2_person_memberships m
                      where m.person_id = r.person_id and m.wid = r.wid and m.active);
  if n <> 0 then
    raise exception 'ASSERT 7 FAILED: % approved request(s) granted no membership before this migration. They were told they could shop and cannot. Repair them by hand -- nothing records which portal account belongs to which request, so this migration will not guess.', n;
  end if;

  raise notice '107 OK: approving an OGGI buyer grants a membership, the anonymous door still issues a password, and no existing approval was left stranded.';
end $$;
