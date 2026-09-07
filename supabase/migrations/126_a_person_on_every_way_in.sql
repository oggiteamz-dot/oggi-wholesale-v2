-- 126 — LINK-00. A person on every way in.
--
-- HADI, 7 Sep 2026, specifying the share-link model, last sentence:
--   "But either way, they get access and they are logged in.
--    **They are signed up to the marketplace itself.**"
--
-- THAT SENTENCE DESCRIBES SOMETHING THAT DOES NOT EXIST.
-- docs/OUTSTANDING.md §9.2 says it plainly and production confirms it: all 7
-- people on the platform were created by v2_backfill_person_identity, a one-off
-- utility that maps ALREADY-EXISTING logins to humans. Nothing in the running
-- app has ever created a person. There is no marketplace sign-up.
--
-- Worse, the two paths that look like sign-up both mint a DEAD END:
--
--   v2_redeem_buyer_invite              -> v2_clients + v2_portal_accounts, person_id NULL
--   v2_approve_signup_request (anon)    -> v2_clients + v2_portal_accounts, person_id NULL
--
-- An account with person_id NULL can never reach the directory, never switch
-- stores, never search across stores, and v2_set_marketplace_password refuses
-- to upgrade it (096:432). It is a login to one shop, for ever. Production has
-- one such account today; every new one through either door would be another.
--
-- So this is the keystone of Block 3 and it comes before the link itself:
-- build the link first and it is a nicer front door onto the same dead end.
--
-- WHAT A PERSON IS, and why the channel matters more than the row.
-- v2_people holds no phone and no email on purpose (090:78) -- those are
-- CHANNELS, and v2_person_channels carries `unique (kind, normalised)`, which
-- 090 calls "THE join key of the whole marketplace". A person row without a
-- channel cannot be found by v2_marketplace_login, so it is only half an
-- identity. This migration therefore attaches every channel it is given, and
-- the gate asserts the difference between the two cases rather than pretending
-- there is only one.
--
-- ⛔ THE INVARIANT, 090's and not negotiable:
--       NORMALISATION MAY SPLIT A PERSON. IT MUST NEVER MERGE TWO.
-- v2_ensure_person only ever CREATES a person or RETURNS one that the phone
-- already points at. It never moves a channel from one person to another, and
-- it never writes a channel whose normalised value is already taken. Asserted
-- in checks/check_person_on_every_way_in.sql, not merely intended.

--------------------------------------------------------------- find or create
create or replace function wholesale_v2.v2_ensure_person(
  p_phone text default null,
  p_name  text default null,
  p_email text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path to 'wholesale_v2', 'public'
as $fn$
declare
  v_phone_key text := wholesale_v2.v2_normalise_channel('phone', p_phone);
  v_email_key text := wholesale_v2.v2_normalise_channel('email', p_email);
  v_person    uuid;
  v_name      text := nullif(btrim(coalesce(p_name, '')), '');
begin
  -- FIND. The phone first, because it is the channel this platform actually
  -- has: 59 of 59 clients on production carry one that normalises, and the
  -- email column is mostly empty.
  if v_phone_key is not null then
    select ch.person_id into v_person
      from wholesale_v2.v2_person_channels ch
     where ch.kind = 'phone' and ch.normalised = v_phone_key;
  end if;

  if v_person is null and v_email_key is not null then
    select ch.person_id into v_person
      from wholesale_v2.v2_person_channels ch
     where ch.kind = 'email' and ch.normalised = v_email_key;
  end if;

  -- CREATE. A person with no channel at all is still created deliberately --
  -- it is what stops an account being a STRUCTURAL dead end, and a channel can
  -- be attached later without a merge. It is not yet a marketplace login, and
  -- the gate says so out loud rather than letting it look finished.
  if v_person is null then
    insert into wholesale_v2.v2_people (display_name)
    values (v_name)
    returning id into v_person;
  elsif v_name is not null then
    -- Fill in a name we did not have. Never overwrite one we did: the earlier
    -- record is the one somebody checked.
    update wholesale_v2.v2_people
       set display_name = v_name, updated_at = now()
     where id = v_person and coalesce(btrim(display_name), '') = '';
  end if;

  -- ATTACH. `on conflict (kind, normalised) do nothing` is the invariant in one
  -- line: if the number already belongs to somebody, this writes nothing and
  -- takes nobody's channel away. It cannot merge two people because it never
  -- UPDATEs an existing channel's person_id.
  if v_phone_key is not null then
    insert into wholesale_v2.v2_person_channels (person_id, kind, raw, normalised, source)
    values (v_person, 'phone', btrim(p_phone), v_phone_key, 'ensure-126')
    on conflict (kind, normalised) do nothing;
  end if;

  if v_email_key is not null then
    insert into wholesale_v2.v2_person_channels (person_id, kind, raw, normalised, source)
    values (v_person, 'email', btrim(p_email), v_email_key, 'ensure-126')
    on conflict (kind, normalised) do nothing;
  end if;

  return v_person;
end;
$fn$;

comment on function wholesale_v2.v2_ensure_person(text, text, text) is
  'Find-or-create a person from a phone and/or an email. Never merges two '
  'people and never moves a channel: the unique (kind, normalised) index plus '
  'on conflict do nothing IS the 090 invariant. Internal only.';

-- Granted to NOBODY. It creates identity rows and takes a phone number as an
-- argument, so a browser role holding it could mint people and, worse, probe
-- whether a number is already known by watching what comes back. Every caller
-- is a SECURITY DEFINER function that has already checked something -- a token,
-- an approval -- and an internal call inside a definer function runs as the
-- definer regardless of the caller's grants.
revoke all on function wholesale_v2.v2_ensure_person(text, text, text) from public, anon, authenticated;

--------------------------------------------------------- the marketplace login
-- A credential is what turns a person into somebody who can sign in to OGGI
-- rather than only to one shop. It ADOPTS the password the buyer just chose,
-- which is what 096's own backfill did (096:118-138) and what a person expects:
-- one password, whichever door they came through.
create or replace function wholesale_v2.v2_ensure_person_credential(
  p_person   uuid,
  p_password text
) returns boolean
language plpgsql
volatile
security definer
set search_path to 'wholesale_v2', 'public', 'extensions'
as $fn$
declare
  v_made boolean := false;
begin
  if p_person is null or coalesce(length(p_password), 0) < 6 then
    return false;
  end if;

  -- ⛔ NEVER OVERWRITES. A person who already signs in to OGGI has a password
  -- they chose; letting a store invitation replace it would be a password reset
  -- performed by whoever holds a link, with no proof of anything. If they
  -- already have one, they keep it and this returns false -- which is not a
  -- failure, it is the answer.
  insert into wholesale_v2.v2_person_credentials (person_id, password_hash, adopted_from)
  values (p_person, extensions.crypt(p_password, extensions.gen_salt('bf')), null)
  on conflict (person_id) do nothing;

  get diagnostics v_made = row_count;
  return v_made;
end;
$fn$;

comment on function wholesale_v2.v2_ensure_person_credential(uuid, text) is
  'Gives a person an OGGI password if they have none. Never overwrites one: a '
  'store invitation must not be able to reset somebody''s marketplace password.';

revoke all on function wholesale_v2.v2_ensure_person_credential(uuid, text) from public, anon, authenticated;

------------------------------------------------------------------- the two doors
-- Both are rewritten with their ORIGINAL bodies intact and the identity block
-- added, so a diff shows exactly what was inserted. Neither signature changes
-- -- migration 113's lesson, and the app calls both.

create or replace function wholesale_v2.v2_redeem_buyer_invite(
  p_token     text,
  p_shop_name text,
  p_username  text,
  p_password  text
)
returns table(ok boolean, msg text, wid text, client_id uuid, account_id uuid)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_inv     wholesale_v2.v2_buyer_invites%rowtype;
  v_client  uuid;
  v_account uuid;
  v_user    text;
  v_shop    text;
  v_person  uuid;
begin
  -- Locked for update: two people opening the same forwarded link at the same
  -- moment must not both get an account. Single-use has to mean single-use
  -- under concurrency, or it is only single-use when nobody is racing.
  select * into v_inv from wholesale_v2.v2_buyer_invites i
   where i.token = p_token for update;

  if v_inv.id is null                then return query select false, 'This invitation link is not valid.', null::text, null::uuid, null::uuid; return; end if;
  if v_inv.revoked_at is not null    then return query select false, 'This invitation was withdrawn.', null::text, null::uuid, null::uuid; return; end if;
  if v_inv.redeemed_at is not null   then return query select false, 'This invitation has already been used.', null::text, null::uuid, null::uuid; return; end if;
  if v_inv.expires_at < now()        then return query select false, 'This invitation has expired. Ask for a new one.', null::text, null::uuid, null::uuid; return; end if;

  v_shop := coalesce(nullif(btrim(p_shop_name), ''), v_inv.shop_name);
  if coalesce(btrim(v_shop), '') = '' then
    return query select false, 'Please give your shop name.', null::text, null::uuid, null::uuid; return;
  end if;

  v_user := lower(btrim(coalesce(p_username, '')));
  if length(v_user) < 3 then
    return query select false, 'Choose a username of at least 3 characters.', null::text, null::uuid, null::uuid; return;
  end if;
  if coalesce(length(p_password), 0) < 6 then
    return query select false, 'Choose a password of at least 6 characters.', null::text, null::uuid, null::uuid; return;
  end if;
  if exists (select 1 from wholesale_v2.v2_portal_accounts a
              where a.wid = v_inv.wid and lower(a.username) = v_user and a.role = 'buyer') then
    return query select false, 'That username is taken for this store. Try another.', null::text, null::uuid, null::uuid; return;
  end if;

  -- ⭐ ADDED BY 126. Before the client and the login, so that if identity
  -- cannot be established the whole redemption rolls back rather than leaving
  -- another orphan account behind.
  v_person := wholesale_v2.v2_ensure_person(v_inv.phone, v_shop, null);

  -- THE SHOP NAME CLASH, which this function had no answer for.
  -- v2_clients carries unique (wid, shop_name) since 006. There was no
  -- exception handler, so redeeming with a name the wholesaler already has
  -- raised a raw Postgres unique violation and js/views/public-order.js:323
  -- showed the buyer "duplicate key value violates unique constraint". It is a
  -- sentence now, in the same shape as every other refusal here.
  if exists (select 1 from wholesale_v2.v2_clients c
              where c.wid = v_inv.wid and c.shop_name = v_shop) then
    return query select false,
      'That shop name is already on file with this store. Add something to tell them apart, or ask them which name to use.',
      null::text, null::uuid, null::uuid; return;
  end if;

  -- The client and the login, in ONE transaction. A client who cannot sign in
  -- is not a client (060's header, and the 17 Aug SQUARE incident).
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
  values (v_inv.wid, v_shop, v_inv.phone)
  returning id into v_client;

  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active, person_id)
  values (v_inv.wid, v_client, 'buyer', v_user,
          extensions.crypt(p_password, extensions.gen_salt('bf')), v_shop, true, v_person)
  returning id into v_account;

  -- ⭐ ADDED BY 126. The membership is what makes the store appear in their
  -- switcher and the directory read 'member' -- migration 107 exists entirely
  -- because approval used to skip this row and grant nothing.
  --
  -- UPDATE-then-INSERT rather than the `on conflict (person_id, wid, role)`
  -- that 107 uses, and NOT out of preference. This function RETURNS a column
  -- called `wid`, so inside it `wid` is a PL/pgSQL variable, and an ON CONFLICT
  -- inference clause cannot be table-qualified -- Postgres answers "column
  -- reference wid is ambiguous" and refuses. Exactly the trap migration 121 hit
  -- with variant_id, in a different clause. 107's version is fine because its
  -- OUT columns are (ok, msg, username, temp_password, client_id, account_id).
  --
  -- The two statements are atomic here for a reason that is already load-
  -- bearing: the invite row was taken FOR UPDATE at the top of this function,
  -- so two people racing the same link are serialised before they reach this.
  update wholesale_v2.v2_person_memberships m
     set active = true, client_id = v_client, account_id = v_account, revoked_at = null
   where m.person_id = v_person and m.wid = v_inv.wid and m.role = 'buyer';
  if not found then
    insert into wholesale_v2.v2_person_memberships (person_id, wid, client_id, account_id, role, active)
    values (v_person, v_inv.wid, v_client, v_account, 'buyer', true);
  end if;

  -- ⭐ ADDED BY 126. One password, both doors. Never overwrites an existing one.
  perform wholesale_v2.v2_ensure_person_credential(v_person, p_password);

  update wholesale_v2.v2_buyer_invites
     set redeemed_at = now(), redeemed_client_id = v_client, redeemed_account_id = v_account
   where id = v_inv.id;

  return query select true, 'ok'::text, v_inv.wid, v_client, v_account;
end;
$fn$;

revoke all on function wholesale_v2.v2_redeem_buyer_invite(text, text, text, text) from public;
grant execute on function wholesale_v2.v2_redeem_buyer_invite(text, text, text, text) to anon, authenticated;

-------------------------------------------------------------- the second door
-- v2_approve_signup_request's ANONYMOUS branch. The person branch already does
-- the right thing -- migration 107 built it -- and is untouched here except
-- that the two branches now converge instead of diverging.
--
-- This branch is the one that runs when somebody came through the public
-- "Request access" form on the login screen. Migration 108 made a phone
-- REQUIRED on that form, precisely because "it is the only way they can send
-- you your login". So this branch always has a number to build an identity
-- from, and the reason it did not was that nothing had been decided about
-- whether such an applicant should become a real OGGI buyer.
--
-- Hadi has now decided: "either way, they get access and they are logged in.
-- They are signed up to the marketplace itself." §9.2 question 1, answered.
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
  v_person     uuid;
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

  -- ⭐ ADDED BY 126, and BEFORE the client insert for the same reason as the
  -- invite path: if the store is not on the marketplace, refuse before writing
  -- anything rather than after. This check used to live inside the person
  -- branch only, so the anonymous branch could create a client for a store
  -- that could not carry a membership.
  if not exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = v_req.wid) then
    return query select false,
      'This store is not set up on the marketplace yet, so access cannot be granted. Tell OGGI before approving.',
      null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  -- ⭐ ADDED BY 126. The same clash 006's unique (wid, shop_name) has always
  -- been able to raise here, in words rather than as Postgres error text.
  if exists (select 1 from wholesale_v2.v2_clients c
              where c.wid = v_req.wid and c.shop_name = v_req.buyer_name) then
    return query select false,
      'You already have a client with that shop name. Open their record instead, or ask this applicant which name to use.',
      null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  v_note := trim(both ' ' from concat_ws(' -- ', v_req.location, v_req.volume, v_req.sells));

  insert into wholesale_v2.v2_clients (wid, shop_name, note, active, phone)
  values (v_req.wid, v_req.buyer_name, v_note, true, v_req.phone)
  returning id into v_client_id;

  v_username := coalesce(nullif(lower(trim(p_username)), ''),
                         lower(regexp_replace(v_req.buyer_name, '[^a-z0-9]+', '', 'gi'))
                         || floor(random() * 900 + 100)::text);

  ---------------------------------------------------------------- the person
  -- ⭐ ADDED BY 126. Both branches now have one. An applicant who came through
  -- the public form carries a phone (108 requires it), so this is a real
  -- marketplace identity, not a placeholder.
  v_person := coalesce(v_req.person_id,
                       wholesale_v2.v2_ensure_person(v_req.phone, v_req.buyer_name, null));

  if v_req.person_id is not null then
    -- Unchanged from 107: an existing OGGI buyer needs no password, because
    -- they already have one. The random hash is never shown to anyone and
    -- exists so crypt() has something to compare against (107:68-80).
    insert into wholesale_v2.v2_portal_accounts
      (wid, role, username, password_hash, client_id, actor_label, person_id)
    values (v_req.wid, 'buyer', v_username,
            extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'),
                             extensions.gen_salt('bf')),
            v_client_id, v_req.buyer_name, v_person)
    returning id into v_account_id;
  else
    -- The anonymous applicant. They get a one-time password to relay by hand,
    -- exactly as before -- AND, new in 126, that password becomes their OGGI
    -- credential too, so the login they are given works on the marketplace and
    -- not only on this one store.
    v_password := encode(extensions.gen_random_bytes(9), 'base64');
    v_password := replace(replace(replace(v_password, '/', '2'), '+', '9'), '=', '');

    insert into wholesale_v2.v2_portal_accounts
      (wid, role, username, password_hash, client_id, actor_label, person_id)
    values (v_req.wid, 'buyer', v_username,
            extensions.crypt(v_password, extensions.gen_salt('bf')),
            v_client_id, v_req.buyer_name, v_person)
    returning id into v_account_id;

    perform wholesale_v2.v2_ensure_person_credential(v_person, v_password);
  end if;

  -- The membership, for BOTH branches now. This is the row that puts the store
  -- in their switcher and makes the directory say 'member'; 107 exists because
  -- approval used to write none.
  insert into wholesale_v2.v2_person_memberships
    (person_id, wid, client_id, account_id, role, active)
  values (v_person, v_req.wid, v_client_id, v_account_id, 'buyer', true)
  on conflict (person_id, wid, role) do update
    set active = true, client_id = excluded.client_id,
        account_id = excluded.account_id, revoked_at = null;

  update wholesale_v2.v2_signup_requests
     set status = 'approved',
         reviewed_by = coalesce(wholesale_v2.v2_my_wid(), 'owner'),
         reviewed_at = now(),
         decided_at  = now()
   where id = p_id;

  if v_req.person_id is not null then
    return query select true,
      'They can shop your store now. There is no password to send — they already sign in to OGGI, and your store has just appeared in their app.',
      null::text, null::text, v_client_id, v_account_id;
  else
    -- ⭐ ADDED BY 126, and it is a message about a HALF state rather than a
    -- failure. A person needs a CHANNEL to be findable by v2_marketplace_login;
    -- 108 made the phone required on the public form, but requests submitted
    -- BEFORE 108 have none, and production is holding two of them right now.
    -- Such an applicant gets a person and a membership -- so the store works
    -- and the account is not the permanent dead end it used to be -- and cannot
    -- sign in to OGGI itself until a number is on file.
    --
    -- Saying so is the whole point. A silent half-state is how "they are signed
    -- up to the marketplace" becomes true of some buyers and not others with
    -- nothing on any screen to tell them apart.
    if not exists (select 1 from wholesale_v2.v2_person_channels ch
                    where ch.person_id = v_person and ch.kind = 'phone') then
      return query select true,
        'Approved, and here is their login for your store. They have no phone number on file, so they cannot sign in to OGGI itself yet — add their number to their client record and they will be able to.',
        v_username, v_password, v_client_id, v_account_id;
      return;
    end if;

    return query select true, '', v_username, v_password, v_client_id, v_account_id;
  end if;
end;
$fn$;

comment on function wholesale_v2.v2_approve_signup_request(uuid, text) is
  'AC-01/ID-03/LINK-00. Approving a request GRANTS A MEMBERSHIP -- the only '
  'thing that puts a store in a buyer''s switcher. Since 126 BOTH branches do: '
  'an applicant with no OGGI identity gets one built from the phone the public '
  'form requires, and the one-time password they are sent is their marketplace '
  'password too. Before 126 that branch minted a login to one shop, for ever.';

revoke all on function wholesale_v2.v2_approve_signup_request(uuid, text) from public, anon;
grant execute on function wholesale_v2.v2_approve_signup_request(uuid, text) to authenticated;

-------------------------------------------------------------------- THE PROOF
do $$
declare v_n int;
begin
  -- Exactly one overload of each: 113's lesson, asserted rather than trusted.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='wholesale_v2'
     and p.proname in ('v2_ensure_person','v2_ensure_person_credential',
                       'v2_redeem_buyer_invite','v2_approve_signup_request');
  if v_n <> 4 then
    raise exception '126: expected 4 functions, found % -- an overload would make PostgREST refuse them', v_n;
  end if;

  -- The two identity helpers are reachable by NO browser role.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='wholesale_v2'
     and p.proname in ('v2_ensure_person','v2_ensure_person_credential')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_n <> 0 then
    raise exception '126: % identity helper(s) are callable from a browser -- a caller could mint people and probe whether a phone is known', v_n;
  end if;

  -- And that both doors now write a person. Source-level, because a corpus
  -- assertion in a migration is the mistake 116 and 119 both made.
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='wholesale_v2' and p.proname='v2_redeem_buyer_invite')
     not like '%v2_ensure_person%' then
    raise exception '126: v2_redeem_buyer_invite still mints an account with no person';
  end if;
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='wholesale_v2' and p.proname='v2_approve_signup_request')
     not like '%v2_ensure_person%' then
    raise exception '126: v2_approve_signup_request still mints an account with no person';
  end if;

  raise notice '126 ok: both doors build an identity, and neither helper is reachable from a browser';
end $$;
