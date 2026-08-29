-- =============================================================================
-- 096 — THE MARKETPLACE FRONT DOOR                 ID-03, ID-09, ID-02, 30 Aug 2026
-- =============================================================================
--
-- Hadi, 30 August: "Make the client bound to us, to the main market. And then
-- each wholesaler gives them access."
--
-- That is the correct model and three quarters of it shipped in 090. A person
-- exists independently of any store (v2_people); a phone or an email identifies
-- them across the whole platform (v2_person_channels, unique on kind+normalised);
-- and a wholesaler granting access is a membership row. What was missing is a
-- way to sign in to OGGI rather than to a shop.
--
-- Today every login is bound to a store by construction:
--   * v2_portal_accounts.wid is NOT NULL
--   * buyer usernames are unique per (wid, username), not globally
-- So "farah" at two wholesalers is two unrelated rows with two unrelated
-- passwords, and nothing in the system knows they are one person.
--
-- ==== WHAT THIS MIGRATION IS CAREFUL NOT TO BREAK ==========================
--
-- GP-02 -- "never force existing buyers to re-register" -- is a live, proven
-- guardrail, and it governs everything below.
--
--   * v2_buyer_login(wid, user, pass) is NOT modified, NOT deprecated and NOT
--     removed. Every buyer who signs in today keeps signing in exactly as they
--     do today. Two doors, both open.
--   * A person with exactly ONE account ADOPTS that account's existing bcrypt
--     hash. They sign in to the marketplace with the password they already
--     have, and were never asked anything.
--   * A person with SEVERAL accounts and differing hashes gets no credential
--     here. Picking one of their passwords would silently make the other stores'
--     passwords wrong; picking none is honest. They set one on first marketplace
--     sign-in, and until then their per-store logins keep working.
--
-- ==== ID-02, AND WHY IT IS IN THIS MIGRATION AND NOT PHASE 7 ===============
--
-- Today the browser stores a bare account id: no expiry, no revocation, no way
-- to prove the holder is the right person. Leak it and someone is that buyer in
-- ONE store, forever.
--
-- A person-level session that can switch stores would make that same leaked
-- value work in EVERY store they belong to. The feature matrix said so on
-- 28 August, in one line: "Blast radius today = 1 store; after this change =
-- every store they can enter."
--
-- So the session is not a bare id here. It is a random 32-byte secret, stored
-- only as a SHA-256 hash, with an expiry and a revocation column, and every
-- resolve re-checks the membership is still active.
--
-- ⚠️ HONEST LIMIT, STATED RATHER THAN IMPLIED. This delivers EXPIRY and
-- REVOCATION. It does NOT deliver per-request proof of possession: once
-- v2_session_account hands back a store's account id, that id is still a bearer
-- value for the ~26 existing functions that take one. Closing that means
-- signing every request, and it is genuinely a Phase 7 job. What this buys is
-- that the long-lived thing on the buyer's phone now expires and can be killed,
-- and that the account id becomes a short-lived derivative instead of the
-- permanent credential. That is strictly better than today and it is not
-- everything.
--
-- ==== THE ENUMERATION RULE =================================================
--
-- The login must fail IDENTICALLY for "no such person" and "wrong password".
-- The identifiers here are phone numbers belonging to your wholesalers' client
-- lists. A login that distinguishes the two cases is a free tool for asking
-- "is this shop on OGGI?" about any number in Lebanon, one request at a time.
-- Asserted below, and red-proved in checks/check_marketplace_login.sql.
-- =============================================================================

-- ----------------------------------------------------- the person's password
create table if not exists wholesale_v2.v2_person_credentials (
  person_id     uuid primary key references wholesale_v2.v2_people(id) on delete cascade,
  password_hash text not null,
  must_change   boolean not null default false,
  -- Which account's hash was adopted, if any. Kept because "where did this
  -- password come from" is unanswerable afterwards otherwise, and because a
  -- back-fill nobody can audit is a back-fill nobody should trust.
  adopted_from  uuid references wholesale_v2.v2_portal_accounts(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table wholesale_v2.v2_person_credentials is
  'ID-03. One password per PERSON, for signing in to OGGI rather than to a shop. Separate table rather than a column on v2_people because ID-05 (the WhatsApp code) is coming and credentials want their own grants and their own policy. v2_portal_accounts.password_hash is untouched and still authoritative for the per-store door.';

alter table wholesale_v2.v2_person_credentials enable row level security;
-- No policy is created on purpose. Nothing reads this table except SECURITY
-- DEFINER functions below, which bypass RLS; with RLS on and no policy, a
-- direct read by anon or authenticated returns nothing rather than everything.
-- Fail locked, never fail open (GP-03).
revoke all on table wholesale_v2.v2_person_credentials from anon, authenticated;

-- ------------------------------------------------------------ the session --
create table if not exists wholesale_v2.v2_buyer_sessions (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references wholesale_v2.v2_people(id) on delete cascade,
  -- SHA-256 of the secret. The secret itself is returned to the caller ONCE, at
  -- login, and is never stored. A stolen database dump is then not a stolen set
  -- of live sessions.
  token_hash   text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists v2_buyer_sessions_person_idx
  on wholesale_v2.v2_buyer_sessions (person_id) where revoked_at is null;

comment on table wholesale_v2.v2_buyer_sessions is
  'ID-02, partial. An expiring, revocable buyer session. Holds a HASH of the secret, never the secret. Delivers expiry and revocation; per-request proof of possession is still Phase 7 -- see the migration header, which says so plainly rather than implying more than was built.';

alter table wholesale_v2.v2_buyer_sessions enable row level security;
revoke all on table wholesale_v2.v2_buyer_sessions from anon, authenticated;

-- =============================================================================
-- BACK-FILL: adopt the password a person already has, where it is unambiguous.
-- =============================================================================
insert into wholesale_v2.v2_person_credentials (person_id, password_hash, adopted_from)
select x.person_id, x.password_hash, x.account_id
from (
  select a.person_id,
         min(a.password_hash)                     as password_hash,
         -- min() has no uuid overload; ordering the ids as text is enough,
         -- because this branch only ever runs when every account of this
         -- person shares one hash, so WHICH id is recorded is provenance,
         -- not a choice between different passwords.
         (array_agg(a.id order by a.id::text))[1] as account_id,
         count(*)                                 as n_accounts,
         count(distinct a.password_hash)          as n_hashes
    from wholesale_v2.v2_portal_accounts a
   where a.person_id is not null and a.role = 'buyer' and a.active
   group by a.person_id
) x
-- Exactly one account, or several that already share a hash. Anything else is
-- ambiguous and is deliberately left without a credential: guessing which of a
-- person's passwords is "the" password would silently break the others.
where x.n_hashes = 1
on conflict (person_id) do nothing;

-- =============================================================================
-- ID-03 — SIGN IN TO OGGI. No wholesaler code.
-- =============================================================================
create or replace function wholesale_v2.v2_marketplace_login(
  p_identifier text,
  p_password   text
)
returns table (
  ok           boolean,
  msg          text,
  session_id   uuid,
  session_token text,
  person_id    uuid,
  display_name text,
  expires_at   timestamptz
)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_norm    text;
  v_kind    text;
  v_person  uuid;
  v_hash    text;
  v_name    text;
  v_secret  text;
  v_sid     uuid;
  v_exp     timestamptz;
  v_key     text;
  v_row     wholesale_v2.v2_login_throttle%rowtype;
  MAX_FAILS  constant integer  := 10;
  WINDOW_LEN constant interval := interval '15 minutes';
  LOCK_LEN   constant interval := interval '15 minutes';
  SESSION_LEN constant interval := interval '30 days';
begin
  -- An email contains '@'; anything else is treated as a phone. Both are
  -- normalised by THE SAME function 090 uses, so "the same human" means the
  -- same thing at the front door as it does everywhere else in the schema.
  v_kind := case when coalesce(p_identifier,'') like '%@%' then 'email' else 'phone' end;
  v_norm := wholesale_v2.v2_normalise_channel(v_kind, p_identifier);

  -- Throttled on the normalised identifier, reusing the same table and the same
  -- limits as v2_buyer_login. A new front door with no rate limit would be a
  -- worse door than the one it stands beside.
  v_key := 'mkt|' || coalesce(v_norm, lower(coalesce(p_identifier,'')));
  select * into v_row from wholesale_v2.v2_login_throttle where key = v_key for update;

  if v_row.key is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, 'Too many attempts. Try again in a few minutes.',
                        null::uuid, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_row.key is not null and v_row.window_start < now() - WINDOW_LEN then
    update wholesale_v2.v2_login_throttle
       set fails = 0, window_start = now(), locked_until = null
     where key = v_key;
    v_row.fails := 0;
  end if;

  if v_norm is not null then
    select ch.person_id into v_person
      from wholesale_v2.v2_person_channels ch
     where ch.kind = v_kind and ch.normalised = v_norm
     limit 1;
  end if;

  if v_person is not null then
    select cr.password_hash into v_hash
      from wholesale_v2.v2_person_credentials cr where cr.person_id = v_person;
  end if;

  -- ==== THE ENUMERATION RULE =============================================
  -- ONE branch for every failure. No-such-number, no-credential-yet and
  -- wrong-password are indistinguishable from outside: same message, same
  -- shape, same throttle increment. The identifiers here are phone numbers out
  -- of wholesalers' client lists, and a login that answers "is this shop on
  -- OGGI?" is a directory of their customers with extra steps.
  if v_person is null or v_hash is null
     or v_hash <> extensions.crypt(coalesce(p_password,''), v_hash) then
    insert into wholesale_v2.v2_login_throttle(key, fails, window_start)
    values (v_key, 1, now())
    on conflict (key) do update
      set fails = wholesale_v2.v2_login_throttle.fails + 1,
          locked_until = case when wholesale_v2.v2_login_throttle.fails + 1 >= MAX_FAILS
                              then now() + LOCK_LEN else null end;
    return query select false, 'That phone or email and password do not match.',
                        null::uuid, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  delete from wholesale_v2.v2_login_throttle where key = v_key;

  select pe.display_name into v_name from wholesale_v2.v2_people pe where pe.id = v_person;

  -- The secret goes back to the caller once and is never stored. What is stored
  -- is its SHA-256, so a database dump is not a set of live sessions.
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp    := now() + SESSION_LEN;

  insert into wholesale_v2.v2_buyer_sessions (person_id, token_hash, expires_at)
  values (v_person, encode(extensions.digest(v_secret, 'sha256'), 'hex'), v_exp)
  returning id into v_sid;

  return query select true, null::text, v_sid, v_secret, v_person, v_name, v_exp;
end;
$fn$;

comment on function wholesale_v2.v2_marketplace_login(text, text) is
  'ID-03. Sign in to OGGI with a phone or email -- no wholesaler code. Fails identically for an unknown identifier and a wrong password, because the identifiers are wholesalers'' client phone numbers. Returns a session secret ONCE; only its hash is stored.';

revoke all on function wholesale_v2.v2_marketplace_login(text, text) from public;
grant execute on function wholesale_v2.v2_marketplace_login(text, text) to anon, authenticated;

-- =============================================================================
-- ID-09 — THE STORES THIS SESSION MAY ENTER.
-- =============================================================================
-- Recomputed from ACTIVE memberships on every call, exactly like RC-01: a
-- wholesaler who revokes access disappears from the switcher on the next call,
-- with nothing to invalidate.
create or replace function wholesale_v2.v2_session_stores(
  p_session_id uuid,
  p_token      text
)
returns table (
  wid             text,
  wholesaler_name text,
  brand           text,
  logo            text,
  currency        text,
  account_id      uuid,
  client_id       uuid
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare v_person uuid;
begin
  v_person := wholesale_v2.v2_session_person(p_session_id, p_token);
  if v_person is null then return; end if;   -- no session: nothing, never an error

  return query
  select m.wid,
         coalesce(nullif(btrim(w.name), ''), w.brand, m.wid),
         w.brand, w.logo, coalesce(w.currency, '$'),
         m.account_id, m.client_id
    from wholesale_v2.v2_person_memberships m
    join public.wholesalers w on w.wid = m.wid
   where m.person_id = v_person and m.active and w.active
   order by coalesce(nullif(btrim(w.name), ''), w.brand, m.wid);
end;
$fn$;

revoke all on function wholesale_v2.v2_session_stores(uuid, text) from public;
grant execute on function wholesale_v2.v2_session_stores(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------- the resolver --
-- Returns the PERSON behind a live session, or null. One place where a session
-- is judged, so expiry and revocation cannot be enforced in one caller and
-- forgotten in another.
create or replace function wholesale_v2.v2_session_person(
  p_session_id uuid,
  p_token      text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare v_person uuid;
begin
  if p_session_id is null or coalesce(p_token,'') = '' then return null; end if;

  update wholesale_v2.v2_buyer_sessions s
     set last_seen_at = now()
   where s.id = p_session_id
     and s.revoked_at is null
     and s.expires_at > now()
     -- Compared as a hash. The stored value is not the secret, so an attacker
     -- with the table still does not have a usable token.
     and s.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  returning s.person_id into v_person;

  return v_person;
end;
$fn$;

revoke all on function wholesale_v2.v2_session_person(uuid, text) from public;
grant execute on function wholesale_v2.v2_session_person(uuid, text) to anon, authenticated;

-- ------------------------------------------- entering one particular store --
create or replace function wholesale_v2.v2_session_account(
  p_session_id uuid,
  p_token      text,
  p_wid        text
)
returns table (ok boolean, account_id uuid, client_id uuid, wholesaler_name text, currency text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare v_person uuid;
begin
  v_person := wholesale_v2.v2_session_person(p_session_id, p_token);
  if v_person is null then
    return query select false, null::uuid, null::uuid, null::text, null::text; return;
  end if;

  -- THE MEMBERSHIP IS RE-CHECKED HERE, not trusted from login. A buyer who was
  -- revoked an hour after signing in cannot keep entering that store for the
  -- remaining 30 days of their session.
  return query
  select true, m.account_id, m.client_id,
         coalesce(nullif(btrim(w.name), ''), w.brand, m.wid),
         coalesce(w.currency, '$')
    from wholesale_v2.v2_person_memberships m
    join public.wholesalers w on w.wid = m.wid
   where m.person_id = v_person and m.wid = p_wid and m.active and w.active
   limit 1;

  if not found then
    return query select false, null::uuid, null::uuid, null::text, null::text;
  end if;
end;
$fn$;

revoke all on function wholesale_v2.v2_session_account(uuid, text, text) from public;
grant execute on function wholesale_v2.v2_session_account(uuid, text, text) to anon, authenticated;

-- ----------------------------------------------------------------- logout --
create or replace function wholesale_v2.v2_session_logout(
  p_session_id uuid,
  p_token      text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare n int;
begin
  -- Revoked, never deleted. Same rule as AC-09 and AC-13: the fact that a
  -- session existed and was ended is worth more than a tidy table.
  update wholesale_v2.v2_buyer_sessions s
     set revoked_at = now()
   where s.id = p_session_id
     and s.revoked_at is null
     and s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end;
$fn$;

revoke all on function wholesale_v2.v2_session_logout(uuid, text) from public;
grant execute on function wholesale_v2.v2_session_logout(uuid, text) to anon, authenticated;

-- ------------------------------------------- setting a marketplace password --
-- For the ambiguous people the back-fill deliberately skipped, and for anyone
-- changing theirs. Proves possession by way of an EXISTING per-store password,
-- so this is not a way to set a password on somebody else's identity.
create or replace function wholesale_v2.v2_set_marketplace_password(
  p_wid      text,
  p_username text,
  p_old_pass text,
  p_new_pass text
)
returns table (ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare v_acct wholesale_v2.v2_portal_accounts%rowtype;
begin
  if length(coalesce(p_new_pass,'')) < 8 then
    return query select false, 'Choose a password of at least 8 characters.'; return;
  end if;

  select a.* into v_acct
    from wholesale_v2.v2_portal_accounts a
   where a.wid = p_wid and lower(a.username) = lower(p_username)
     and a.role = 'buyer' and a.active
     and a.password_hash = extensions.crypt(coalesce(p_old_pass,''), a.password_hash)
   limit 1;

  if v_acct.id is null or v_acct.person_id is null then
    return query select false, 'Those sign-in details do not match.'; return;
  end if;

  insert into wholesale_v2.v2_person_credentials (person_id, password_hash, adopted_from)
  values (v_acct.person_id, extensions.crypt(p_new_pass, extensions.gen_salt('bf')), v_acct.id)
  on conflict (person_id) do update
    set password_hash = excluded.password_hash,
        adopted_from  = excluded.adopted_from,
        updated_at    = now();

  return query select true, null::text;
end;
$fn$;

revoke all on function wholesale_v2.v2_set_marketplace_password(text, text, text, text) from public;
grant execute on function wholesale_v2.v2_set_marketplace_password(text, text, text, text) to anon, authenticated;

-- =============================================================================
-- SELF-ASSERTING. Raises and rolls the whole migration back if any guarantee
-- above is not true of what was just created.
-- =============================================================================
do $$
declare
  n int; r record; src text;
  v_person uuid; v_sid uuid; v_tok text;
  v_wid text := 'zz96_store';
  v_cli uuid; v_acc uuid;
begin
  -- 1. GP-02. The old door is untouched.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_buyer_login';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: v2_buyer_login is gone -- every existing buyer just lost their login'; end if;

  -- 2. The secret is never stored in the clear.
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_buyer_sessions'
     and column_name in ('token','secret','session_token');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: v2_buyer_sessions has a column holding the raw token'; end if;

  -- 3. Neither credential nor session table is readable by the browser roles.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2'
     and table_name in ('v2_person_credentials','v2_buyer_sessions')
     and grantee in ('anon','authenticated');
  if n <> 0 then raise exception 'ASSERT 3 FAILED: anon/authenticated hold % grant(s) on the credential or session tables', n; end if;

  -- 4. The login takes no wid. Scope is derived, never supplied.
  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='wholesale_v2' and p.proname='v2_marketplace_login')) ilike '%wid%'
    then raise exception 'ASSERT 4 FAILED: v2_marketplace_login takes a wid -- it is meant to be the door to OGGI, not to a shop'; end if;

  -- 5. THE ENUMERATION RULE, checked behaviourally rather than by reading code.
  select * into r from wholesale_v2.v2_marketplace_login('96999999999', 'anything');
  if r.ok is not false then raise exception 'ASSERT 5 FAILED: an unknown identifier logged in'; end if;
  declare msg_unknown text := r.msg;
  begin
    -- A real person with a real credential, wrong password.
    insert into wholesale_v2.v2_people (display_name) values ('Zed 96') returning id into v_person;
    insert into wholesale_v2.v2_person_channels (person_id, kind, raw, normalised)
      values (v_person, 'phone', '03 969 696', wholesale_v2.v2_normalise_channel('phone','03 969 696'));
    insert into wholesale_v2.v2_person_credentials (person_id, password_hash)
      values (v_person, extensions.crypt('correct-horse', extensions.gen_salt('bf')));

    select * into r from wholesale_v2.v2_marketplace_login('03 969 696', 'WRONG');
    if r.ok is not false then raise exception 'ASSERT 5 FAILED: a wrong password logged in'; end if;
    if r.msg is distinct from msg_unknown then
      raise exception 'ASSERT 5 FAILED: unknown identifier says %, wrong password says % -- the difference is a tool for asking whether any given phone number is an OGGI buyer', msg_unknown, r.msg;
    end if;

    -- 6. The right password DOES work, and returns a session.
    select * into r from wholesale_v2.v2_marketplace_login('03 969 696', 'correct-horse');
    if r.ok is not true then raise exception 'ASSERT 6 FAILED: the correct password was refused'; end if;
    if r.session_token is null or length(r.session_token) < 32 then
      raise exception 'ASSERT 6 FAILED: no session secret was issued'; end if;
    if r.expires_at is null or r.expires_at <= now() then
      raise exception 'ASSERT 6 FAILED: the session has no future expiry -- ID-02 is the point of this'; end if;
    v_sid := r.session_id; v_tok := r.session_token;

    -- 7. The stored value is a HASH, not the secret.
    select count(*) into n from wholesale_v2.v2_buyer_sessions s
     where s.id = v_sid and s.token_hash = v_tok;
    if n <> 0 then raise exception 'ASSERT 7 FAILED: the raw session secret is stored in the table'; end if;

    -- 8. The session resolves, a wrong token does not.
    if wholesale_v2.v2_session_person(v_sid, v_tok) is distinct from v_person then
      raise exception 'ASSERT 8 FAILED: a valid session did not resolve to its person'; end if;
    if wholesale_v2.v2_session_person(v_sid, 'not-the-token') is not null then
      raise exception 'ASSERT 8 FAILED: a WRONG token resolved a session'; end if;

    -- 9. An EXPIRED session resolves to nobody. This is ID-02's whole point.
    update wholesale_v2.v2_buyer_sessions set expires_at = now() - interval '1 second' where id = v_sid;
    if wholesale_v2.v2_session_person(v_sid, v_tok) is not null then
      raise exception 'ASSERT 9 FAILED: an EXPIRED session still resolves -- the session never expires, which is the hole this migration exists to close'; end if;
    update wholesale_v2.v2_buyer_sessions set expires_at = now() + interval '1 day' where id = v_sid;

    -- 10. A REVOKED session resolves to nobody.
    perform wholesale_v2.v2_session_logout(v_sid, v_tok);
    if wholesale_v2.v2_session_person(v_sid, v_tok) is not null then
      raise exception 'ASSERT 10 FAILED: a logged-out session still resolves'; end if;
    -- and logout revokes rather than deletes
    select count(*) into n from wholesale_v2.v2_buyer_sessions where id = v_sid and revoked_at is not null;
    if n <> 1 then raise exception 'ASSERT 10 FAILED: logout deleted the session row instead of revoking it'; end if;
  end;

  -- ==== CLEAN UP AFTER ITSELF ==============================================
  -- These assertions are BEHAVIOURAL: they log a real person in, because
  -- reading the source and concluding "that looks right" is how the enumeration
  -- rule would get shipped broken. The cost is that the block creates rows, and
  -- a do-block does NOT roll back when it succeeds -- only when it raises. So
  -- the fixture is removed explicitly here.
  --
  -- Without this, applying 096 leaves a person called 'Zed 96' with a working
  -- password and a live phone channel in PRODUCTION. The channel index is
  -- unique on (kind, normalised), so it would also permanently reserve a real
  -- Lebanese phone number against a fake identity.
  --
  -- Deleting the person cascades to channels, credentials and sessions.
  delete from wholesale_v2.v2_login_throttle where key like 'mkt|%96999999999%' or key like '%969696%';
  delete from wholesale_v2.v2_people where id = v_person;

  select count(*) into n from wholesale_v2.v2_person_channels
   where normalised = wholesale_v2.v2_normalise_channel('phone','03 969 696');
  if n <> 0 then raise exception 'ASSERT 11 FAILED: the assertion fixture was left behind in the database'; end if;

  raise notice '096 OK: OGGI-level login with no wid, identical failures, hashed session secrets, expiry and revocation both enforced. v2_buyer_login untouched.';
end $$;
