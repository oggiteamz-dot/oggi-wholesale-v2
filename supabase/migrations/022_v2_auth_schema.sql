-- Batch 14 (Security & authentication -- LAST, by design) -- part 1/3.
--
-- Replaces Batch 0's dev-mode "pick any role" access stub with real
-- credentialed authentication for all four roles. Deliberately mirrors
-- the ALREADY-LIVE, already-proven pattern from v1 (public.profiles /
-- public.clients / public.reps / public.login_throttle / is_owner() /
-- my_wid() / client_login() / rep_login()) rather than inventing a new
-- scheme -- that pattern has been in production and battle-tested, and
-- reusing it (as its own v2_-prefixed tables/functions, never touching
-- the v1 originals) is both faster to get right and safer than a novel
-- design reviewed by no one but this session.
--
-- Two tiers, exactly like v1:
--   Owner + Wholesaler -> real Supabase Auth (auth.users, email+password,
--     a real JWT session). These are durable, low-churn, need password
--     reset/recovery -- Supabase Auth is the right tool.
--   Buyer + Sales      -> lightweight username+password accounts of our
--     own (v2_portal_accounts), same as v1's clients/reps. These are
--     high-churn, wholesaler-provisioned, external accounts that don't
--     need a full Supabase Auth identity. Sessions are trusted
--     client-side after a throttled, bcrypt-verified login RPC --
--     identical trust model to v1's clients/reps today, not a new or
--     weaker one introduced by this batch.

-- ---------------------------------------------------------------------
-- v2_user_profiles -- owner/wholesaler identity, keyed by real
-- Supabase Auth users.
-- ---------------------------------------------------------------------
create table if not exists v2_user_profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  role             text not null check (role in ('owner','wholesaler')),
  wid              text references v2_wholesalers(wid) on delete cascade,
  wholesaler_name  text,
  actor_label      text,
  created_at       timestamptz not null default now(),
  constraint v2_user_profiles_wid_required_for_wholesaler
    check (role <> 'wholesaler' or wid is not null)
);
comment on table v2_user_profiles is
  'Owner/wholesaler identity. One row per real Supabase Auth user (auth.uid()). Created only via v2_redeem_invite -- never self-assigned -- so a signup cannot grant itself the wholesaler role for an arbitrary wid or the owner role at all.';

alter table v2_user_profiles enable row level security;
create policy v2_user_profiles_self_read on v2_user_profiles for select
  using (id = auth.uid());
-- No insert/update/delete policy for any client role -- profile rows are
-- written exclusively by v2_redeem_invite (SECURITY DEFINER, below).
-- Deny-all for direct writes is intentional, not an oversight.

-- ---------------------------------------------------------------------
-- v2_invites -- the only path to becoming an owner or wholesaler.
-- ---------------------------------------------------------------------
create table if not exists v2_invites (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  role               text not null check (role in ('owner','wholesaler')),
  wid                text references v2_wholesalers(wid) on delete cascade,
  wholesaler_name    text,
  created_by         uuid references auth.users(id),
  used_by            uuid references auth.users(id),
  used_at            timestamptz,
  expires_at         timestamptz not null default (now() + interval '14 days'),
  created_at         timestamptz not null default now(),
  constraint v2_invites_wid_required_for_wholesaler
    check (role <> 'wholesaler' or wid is not null)
);
comment on table v2_invites is
  'Single-use invite codes. Only an existing owner can mint one (enforced inside v2_create_invite, not by table RLS, since the creator needs a profile that does not exist yet on the very first bootstrap invite -- see the seeded bootstrap row below). Redeeming is the only way v2_user_profiles ever gets a new row.';

alter table v2_invites enable row level security;
create policy v2_invites_owner_read on v2_invites for select
  using (exists (select 1 from v2_user_profiles p where p.id = auth.uid() and p.role = 'owner'));
-- No direct insert/update/delete policy -- all writes go through
-- v2_create_invite / v2_redeem_invite (SECURITY DEFINER).

-- ---------------------------------------------------------------------
-- v2_portal_accounts -- buyer + sales credentials (mirrors v1's
-- clients/reps tables, unified into one table with a role column since
-- v2 has no separate "reps" entity yet and the login/throttle logic is
-- identical either way).
-- ---------------------------------------------------------------------
create table if not exists v2_portal_accounts (
  id             uuid primary key default gen_random_uuid(),
  wid            text not null references v2_wholesalers(wid) on delete cascade,
  role           text not null check (role in ('buyer','sales')),
  username       text not null,
  password_hash  text not null,
  client_id      uuid references v2_clients(id) on delete set null,
  actor_label    text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table v2_portal_accounts is
  'Buyer + sales login credentials -- v2''s equivalent of v1''s clients/reps tables. Buyers log in with (wid, username, password) since the buyer app is entered per-wholesaler; sales log in with just (username, password), mirroring v1''s rep_login exactly, since a sales account belongs to exactly one wholesaler team looked up internally.';

-- Buyers: username unique per wholesaler (two different wholesalers can
-- both have a buyer named "shop1"). Sales: username globally unique,
-- matching v1's reps table (rep_login takes no wid).
create unique index if not exists idx_v2_portal_accounts_buyer_username
  on v2_portal_accounts (wid, lower(username)) where role = 'buyer';
create unique index if not exists idx_v2_portal_accounts_sales_username
  on v2_portal_accounts (lower(username)) where role = 'sales';

alter table v2_portal_accounts enable row level security;
create policy v2_portal_accounts_admin_scoped on v2_portal_accounts for all
  using (
    exists (select 1 from v2_user_profiles p where p.id = auth.uid()
            and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_portal_accounts.wid)))
  )
  with check (
    exists (select 1 from v2_user_profiles p where p.id = auth.uid()
            and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_portal_accounts.wid)))
  );
comment on policy v2_portal_accounts_admin_scoped on v2_portal_accounts is
  'Only an owner, or the wholesaler that owns this account''s wid, can read/manage portal accounts directly. Buyers/sales never read this table themselves -- they only ever call v2_buyer_login/v2_sales_login (SECURITY DEFINER), never see password_hash, and cannot enumerate other accounts.';

-- ---------------------------------------------------------------------
-- v2_login_throttle -- identical shape and constants to v1's
-- public.login_throttle (10 fails / 15-minute window / 15-minute lock),
-- already proven in production. Deliberately has NO RLS policies at all
-- (deny-all) and no grants to anon/authenticated -- the row itself
-- reveals which usernames exist and how many times they've failed, so
-- it must never be directly readable over the API, only touched from
-- inside the SECURITY DEFINER login functions below.
-- ---------------------------------------------------------------------
create table if not exists v2_login_throttle (
  key           text primary key,
  fails         integer not null default 0,
  window_start  timestamptz not null default now(),
  locked_until  timestamptz
);
comment on table v2_login_throttle is
  'Failed v2_buyer_login/v2_sales_login attempts. Written only by those SECURITY DEFINER functions. Deliberately has no RLS policies and no grants -- must never be readable over the API, mirroring public.login_throttle in v1.';
alter table v2_login_throttle enable row level security;
-- (no policies created -- RLS enabled with zero policies = deny-all)

-- ---------------------------------------------------------------------
-- General-purpose DB-backed rate limiter, for the new anon-callable
-- surfaces this batch introduces (signup requests, invite redemption
-- attempts) that aren't already covered by v2_login_throttle's
-- password-attempt-specific logic.
-- ---------------------------------------------------------------------
create table if not exists v2_rate_limit_hits (
  key           text primary key,
  hits          integer not null default 0,
  window_start  timestamptz not null default now()
);
comment on table v2_rate_limit_hits is
  'Generic sliding-window rate-limit counters for anon-callable RPCs (see v2_rate_limit_check). Same deny-all posture as v2_login_throttle -- never directly readable, only touched by SECURITY DEFINER functions.';
alter table v2_rate_limit_hits enable row level security;
-- (no policies -- deny-all, same reasoning as v2_login_throttle)

create or replace function v2_rate_limit_check(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row v2_rate_limit_hits%rowtype;
begin
  select * into v_row from v2_rate_limit_hits where key = p_key for update;

  if v_row.key is null then
    insert into v2_rate_limit_hits(key, hits, window_start) values (p_key, 1, now());
    return true;
  end if;

  if v_row.window_start < now() - make_interval(secs => p_window_seconds) then
    update v2_rate_limit_hits set hits = 1, window_start = now() where key = p_key;
    return true;
  end if;

  if v_row.hits >= p_max then
    return false;
  end if;

  update v2_rate_limit_hits set hits = hits + 1 where key = p_key;
  return true;
end;
$$;
-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_rate_limit_check'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Generic sliding-window limiter: returns true and records a hit if the caller is under p_max hits per p_window_seconds for p_key, false (and records nothing further) once over. Callers choose their own key shape, e.g. ''signup_request|'' || p_wid || ''|'' || inet_client_addr()::text.');
  end loop;
end $cmt$;
revoke all on function v2_rate_limit_check(text, integer, integer) from public;
grant execute on function v2_rate_limit_check(text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Helper functions -- exact analogues of v1's is_owner()/my_wid(), for
-- use inside every RLS policy that follows in migration 023.
-- ---------------------------------------------------------------------
create or replace function v2_my_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$ select role from v2_user_profiles where id = auth.uid(); $$;

create or replace function v2_my_wid()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$ select wid from v2_user_profiles where id = auth.uid(); $$;

create or replace function v2_is_owner()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$ select coalesce(v2_my_role() = 'owner', false); $$;

revoke all on function v2_my_role() from public;
revoke all on function v2_my_wid() from public;
revoke all on function v2_is_owner() from public;
grant execute on function v2_my_role() to anon, authenticated;
grant execute on function v2_my_wid() to anon, authenticated;
grant execute on function v2_is_owner() to anon, authenticated;

-- ---------------------------------------------------------------------
-- v2_create_invite / v2_redeem_invite
-- ---------------------------------------------------------------------
create or replace function v2_create_invite(
  p_role text, p_wid text, p_wholesaler_name text, p_expires_in_days integer default 14
)
returns table(ok boolean, msg text, code text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_code text;
begin
  if not v2_is_owner() then
    return query select false, 'Only an owner can create invites', null::text;
    return;
  end if;
  if p_role not in ('owner','wholesaler') then
    return query select false, 'Invalid role for an invite', null::text;
    return;
  end if;
  if p_role = 'wholesaler' and (p_wid is null or not exists (select 1 from v2_wholesalers w where w.wid = p_wid)) then
    return query select false, 'A wholesaler invite needs a valid existing wid', null::text;
    return;
  end if;

  -- A URL-safe random token; encode() avoids ever emitting characters
  -- that would need escaping if pasted into a link.
  v_code := encode(gen_random_bytes(18), 'base64');
  v_code := replace(replace(replace(v_code, '/', '_'), '+', '-'), '=', '');

  insert into v2_invites (code, role, wid, wholesaler_name, created_by, expires_at)
  values (v_code, p_role, p_wid, p_wholesaler_name, auth.uid(), now() + make_interval(days => p_expires_in_days));

  return query select true, '', v_code;
end;
$$;
-- IMPORTANT: `revoke ... from public` alone is NOT enough on this
-- project -- Supabase's default privileges grant EXECUTE on every new
-- public-schema function directly to the `anon` role (not to the PUBLIC
-- pseudo-role), so anon must be revoked explicitly too. Migration 018
-- got this right for v2_get_integration_secret; this one originally
-- missed it (found live during Batch 14's final security sweep, fixed
-- in 025_v2_fix_batch14_grant_hygiene.sql, and corrected here so a
-- fresh db reset matches).
revoke all on function v2_create_invite(text, text, text, integer) from public, anon;
grant execute on function v2_create_invite(text, text, text, integer) to authenticated;

create or replace function v2_redeem_invite(p_code text, p_actor_label text default null)
returns table(ok boolean, msg text, role text, wid text, wholesaler_name text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_invite v2_invites%rowtype;
  v_rl_ok boolean;
begin
  if auth.uid() is null then
    return query select false, 'You must be signed in to redeem an invite', null::text, null::text, null::text;
    return;
  end if;

  -- Rate-limit redemption attempts per calling user, so a signed-in
  -- attacker can't brute-force a 24-byte random invite code by sheer
  -- volume of guesses (the code itself is the only secret here).
  v_rl_ok := v2_rate_limit_check('redeem_invite|' || auth.uid()::text, 20, 900);
  if not v_rl_ok then
    return query select false, 'Too many attempts -- wait a few minutes and try again', null::text, null::text, null::text;
    return;
  end if;

  if exists (select 1 from v2_user_profiles where id = auth.uid()) then
    return query select false, 'This account already has a role', null::text, null::text, null::text;
    return;
  end if;

  select * into v_invite from v2_invites where code = p_code for update;
  if v_invite.id is null then
    return query select false, 'Invalid invite code', null::text, null::text, null::text;
    return;
  end if;
  if v_invite.used_by is not null then
    return query select false, 'This invite has already been used', null::text, null::text, null::text;
    return;
  end if;
  if v_invite.expires_at < now() then
    return query select false, 'This invite has expired', null::text, null::text, null::text;
    return;
  end if;

  insert into v2_user_profiles (id, role, wid, wholesaler_name, actor_label)
  values (auth.uid(), v_invite.role, v_invite.wid, v_invite.wholesaler_name,
          coalesce(nullif(trim(p_actor_label), ''), v_invite.role));

  update v2_invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;

  return query select true, '', v_invite.role, v_invite.wid, v_invite.wholesaler_name;
end;
$$;
revoke all on function v2_redeem_invite(text, text) from public, anon;
grant execute on function v2_redeem_invite(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- v2_buyer_login / v2_sales_login -- exact structural mirror of v1's
-- client_login()/rep_login() (same throttle constants, same
-- "locked and wrong-password look identical to the caller" behaviour).
-- ---------------------------------------------------------------------
create or replace function v2_buyer_login(p_wid text, p_user text, p_pass text)
returns table(
  ok boolean, account_id uuid, client_id uuid, wid text,
  wholesaler_name text, shop_name text, discount_pct numeric, actor_label text
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_key text := 'buyer|' || lower(coalesce(p_wid,'')) || '|' || lower(coalesce(p_user,''));
  v_row v2_login_throttle%rowtype;
  v_hit boolean := false;
  MAX_FAILS constant integer := 10;
  WINDOW_LEN constant interval := interval '15 minutes';
  LOCK_LEN constant interval := interval '15 minutes';
begin
  select * into v_row from v2_login_throttle where key = v_key for update;

  if v_row.key is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, null::uuid, null::uuid, null::text, null::text, null::text, null::numeric, null::text;
    return;
  end if;

  if v_row.key is not null and v_row.window_start < now() - WINDOW_LEN then
    update v2_login_throttle set fails = 0, window_start = now(), locked_until = null where key = v_key;
    v_row.fails := 0;
  end if;

  select true into v_hit
  from v2_portal_accounts a
  join v2_wholesalers w on w.wid = a.wid
  where a.wid = p_wid and lower(a.username) = lower(p_user) and a.role = 'buyer'
    and a.active = true and w.active = true
    and a.password_hash = crypt(p_pass, a.password_hash)
  limit 1;

  if coalesce(v_hit, false) then
    delete from v2_login_throttle where key = v_key;
    return query
    select true, a.id, a.client_id, a.wid, w.name, c.shop_name, c.discount_pct, a.actor_label
    from v2_portal_accounts a
    join v2_wholesalers w on w.wid = a.wid
    left join v2_clients c on c.id = a.client_id
    where a.wid = p_wid and lower(a.username) = lower(p_user) and a.role = 'buyer'
      and a.active = true and w.active = true
      and a.password_hash = crypt(p_pass, a.password_hash);
    return;
  end if;

  insert into v2_login_throttle(key, fails, window_start) values (v_key, 1, now())
  on conflict (key) do update
    set fails = v2_login_throttle.fails + 1,
        locked_until = case when v2_login_throttle.fails + 1 >= MAX_FAILS then now() + LOCK_LEN else null end;

  return query select false, null::uuid, null::uuid, null::text, null::text, null::text, null::numeric, null::text;
end;
$$;
revoke all on function v2_buyer_login(text, text, text) from public;
grant execute on function v2_buyer_login(text, text, text) to anon, authenticated;

create or replace function v2_sales_login(p_user text, p_pass text)
returns table(ok boolean, account_id uuid, wid text, wholesaler_name text, actor_label text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_key text := 'sales|' || lower(coalesce(p_user,''));
  v_row v2_login_throttle%rowtype;
  v_hit boolean := false;
  MAX_FAILS constant integer := 10;
  WINDOW_LEN constant interval := interval '15 minutes';
  LOCK_LEN constant interval := interval '15 minutes';
begin
  select * into v_row from v2_login_throttle where key = v_key for update;

  if v_row.key is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  if v_row.key is not null and v_row.window_start < now() - WINDOW_LEN then
    update v2_login_throttle set fails = 0, window_start = now(), locked_until = null where key = v_key;
    v_row.fails := 0;
  end if;

  select true into v_hit
  from v2_portal_accounts a
  join v2_wholesalers w on w.wid = a.wid
  where lower(a.username) = lower(p_user) and a.role = 'sales'
    and a.active = true and w.active = true
    and a.password_hash = crypt(p_pass, a.password_hash)
  limit 1;

  if coalesce(v_hit, false) then
    delete from v2_login_throttle where key = v_key;
    return query
    select true, a.id, a.wid, w.name, a.actor_label
    from v2_portal_accounts a
    join v2_wholesalers w on w.wid = a.wid
    where lower(a.username) = lower(p_user) and a.role = 'sales'
      and a.active = true and w.active = true
      and a.password_hash = crypt(p_pass, a.password_hash);
    return;
  end if;

  insert into v2_login_throttle(key, fails, window_start) values (v_key, 1, now())
  on conflict (key) do update
    set fails = v2_login_throttle.fails + 1,
        locked_until = case when v2_login_throttle.fails + 1 >= MAX_FAILS then now() + LOCK_LEN else null end;

  return query select false, null::uuid, null::text, null::text, null::text;
end;
$$;
revoke all on function v2_sales_login(text, text) from public;
grant execute on function v2_sales_login(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- v2_create_portal_account -- owner or the owning wholesaler only.
-- Mirrors v1's create_rep() authorization check exactly.
-- ---------------------------------------------------------------------
create or replace function v2_create_portal_account(
  p_role text, p_wid text, p_username text, p_password text,
  p_client_id uuid default null, p_actor_label text default null
)
returns table(ok boolean, msg text, account_id uuid)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_id uuid;
begin
  if not (v2_is_owner() or v2_my_wid() = p_wid) then
    return query select false, 'Not authorized', null::uuid;
    return;
  end if;
  if p_role not in ('buyer','sales') then
    return query select false, 'Invalid role', null::uuid;
    return;
  end if;

  p_username := lower(trim(p_username));
  if p_username = '' or p_password is null or length(p_password) < 6 then
    return query select false, 'Username and a password (6+ characters) are required', null::uuid;
    return;
  end if;

  if p_role = 'buyer' and exists (select 1 from v2_portal_accounts where wid = p_wid and role = 'buyer' and lower(username) = p_username) then
    return query select false, 'That username is already used by another buyer at this wholesaler', null::uuid;
    return;
  end if;
  if p_role = 'sales' and exists (select 1 from v2_portal_accounts where role = 'sales' and lower(username) = p_username) then
    return query select false, 'That username is taken -- pick another', null::uuid;
    return;
  end if;

  insert into v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
  values (p_wid, p_role, p_username, crypt(p_password, gen_salt('bf')), p_client_id, coalesce(nullif(trim(p_actor_label), ''), p_username))
  returning id into v_id;

  return query select true, '', v_id;
end;
$$;
revoke all on function v2_create_portal_account(text, text, text, text, uuid, text) from public, anon;
grant execute on function v2_create_portal_account(text, text, text, text, uuid, text) to authenticated;
