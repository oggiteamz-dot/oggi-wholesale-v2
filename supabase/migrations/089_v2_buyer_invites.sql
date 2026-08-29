-- =============================================================================
-- 089 — DOOR A: THE INVITATION                            AC-03, 29 August 2026
-- =============================================================================
--
-- The third of the three ways into a locked store, and the only one that was
-- genuinely missing.
--
--   Door B — the shop asks, the wholesaler approves      (007 + 024, AC-01)
--   Door C — the wholesaler types their phone in         (060, shipped)
--   Door A — the wholesaler SENDS them a link            <- this
--
-- `v2_invites` already exists (022) and is NOT this: it is authenticated-only,
-- it writes v2_user_profiles, and it invites an OWNER or a WHOLESALER. Reusing
-- it would mean one table meaning two different things, which is how
-- `v2_suppliers` came to mean the opposite of "supplier" in this codebase
-- (see 050's header). A buyer invite is its own object.
--
-- WHY A LINK AND NOT AN EMAIL
-- There is no transactional email anywhere in this system, and 024 says so in
-- its own comment rather than pretending. The research on 28 Aug found the
-- same failure everywhere: MUST-NOT #10, "do not rely on an activation email
-- arriving." Cin7 solves it by handing the merchant a copyable link per
-- customer; that is what this does. The wholesaler pastes it into the WhatsApp
-- thread they are already having with that shop.
--
-- FIVE THINGS THE RESEARCH SAID AND THIS DOES
--
--  1. INVITED-BUT-NOT-YET-ACCEPTED IS A REAL STATE, visible to the wholesaler
--     with the date it was sent. Without it nobody knows whether anyone got in.
--
--  2. AN INVITE IS SINGLE-USE AND REVOCABLE. A link sent on WhatsApp WILL be
--     forwarded; that is what WhatsApp is for. Single-use means a forwarded
--     link is dead the moment the intended shop uses it, and revoke is the
--     remedy when it is forwarded before they do.
--
--  3. IT DOES NOT EXPIRE IN A DAY. MUST-NOT #12: "do not expire an invite so
--     fast that a real buyer misses it." A shop owner in a market does not
--     read WhatsApp on our schedule. 30 days, and expiry is a timestamp the
--     wholesaler can see, not a silent death.
--
--  4. REDEEMING CREATES THE CLIENT AND THE LOGIN IN ONE TRANSACTION, exactly
--     as 024 and 060 do. A client who cannot sign in is not a client -- the
--     same gap that left SQUARE authenticating into nowhere on 17 Aug.
--
--  5. ENTERING AN IDENTIFIER CREATES A REQUEST, NEVER SILENTLY AN ACCOUNT.
--     MUST-NOT #3, from a merchant who woke to unauthorised orders because
--     "anyone entering an email" auto-created a customer. Here the account is
--     created only by REDEEMING a real token the wholesaler issued.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- It does not send anything. It does not know how to. It returns a link and
-- says so, and the wholesaler is the delivery mechanism -- which is honest,
-- and is also how every credential in this system is already relayed (060's
-- header records that as a deliberate market accommodation, not a gap).
-- =============================================================================

create table if not exists wholesale_v2.v2_buyer_invites (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  token         text not null default encode(extensions.gen_random_bytes(12), 'hex'),
  -- What the wholesaler knows about them when they send it. All optional: the
  -- point of an invite is that you send it before you have their details.
  shop_name     text,
  phone         text,
  note          text,
  -- Lifecycle. Four states, and they are distinguishable on purpose: sent,
  -- redeemed, revoked, expired. "It didn't work" is not a state anyone can act
  -- on; each of these tells the wholesaler what to do next.
  created_by    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days',
  redeemed_at   timestamptz,
  redeemed_client_id  uuid references wholesale_v2.v2_clients(id) on delete set null,
  redeemed_account_id uuid references wholesale_v2.v2_portal_accounts(id) on delete set null,
  revoked_at    timestamptz,
  revoked_by    text
);

create unique index if not exists v2_buyer_invites_token_uq
  on wholesale_v2.v2_buyer_invites (token);
create index if not exists v2_buyer_invites_wid_idx
  on wholesale_v2.v2_buyer_invites (wid, created_at desc);

comment on table wholesale_v2.v2_buyer_invites is
  'Door A. An invitation to ONE shop to join ONE wholesaler''s store. Single-use, revocable, 30 days. Not v2_invites, which is the owner/wholesaler invite and writes v2_user_profiles -- one table meaning two things is how v2_suppliers came to mean the opposite of supplier in this codebase.';
comment on column wholesale_v2.v2_buyer_invites.token is
  '96 bits, hex, URL-safe. The unguessable half of /i/<token>. A link sent on WhatsApp WILL be forwarded, so the invite is single-use and revocable rather than merely secret.';
comment on column wholesale_v2.v2_buyer_invites.expires_at is
  'Thirty days, not a day. A shop owner in a market does not read WhatsApp on our schedule, and an invite that dies before it is opened is worse than no invite -- it costs the wholesaler the relationship AND makes the product look broken.';

alter table wholesale_v2.v2_buyer_invites enable row level security;

-- Direct table access is the wholesaler's own, and the owner's. A prospective
-- buyer never reads this table; they go through the definer functions below.
drop policy if exists v2_buyer_invites_scoped on wholesale_v2.v2_buyer_invites;
create policy v2_buyer_invites_scoped on wholesale_v2.v2_buyer_invites for all
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid())
  with check (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

grant select, insert, update on wholesale_v2.v2_buyer_invites to authenticated;
-- anon gets NOTHING on the table. 085 revoked every table privilege from anon
-- and set the default-privileges rule to keep doing so; this table arrives
-- closed and stays closed. A prospective buyer reaches it only through
-- v2_invite_by_token, which returns a fixed, named, harmless projection.

-- ------------------------------------------------------- issue an invite --
create or replace function wholesale_v2.v2_issue_buyer_invite(
  p_shop_name text default null,
  p_phone     text default null,
  p_note      text default null,
  p_days      integer default 30
)
returns table(ok boolean, msg text, invite_id uuid, token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_wid text;
  v_row wholesale_v2.v2_buyer_invites%rowtype;
begin
  -- Re-checked INSIDE, like every definer function in this schema since 080.
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then
    return query select false, 'Only a wholesaler can invite a shop.', null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Clamped rather than trusted. A caller-supplied 36500 would be an invite
  -- that never dies, which is the same as no expiry at all.
  if p_days is null or p_days < 1 then p_days := 30; end if;
  if p_days > 180 then p_days := 180; end if;

  insert into wholesale_v2.v2_buyer_invites (wid, shop_name, phone, note, created_by, expires_at)
  values (v_wid, nullif(btrim(p_shop_name), ''), nullif(btrim(p_phone), ''),
          nullif(btrim(p_note), ''), coalesce(auth.jwt() ->> 'email', 'wholesaler'),
          now() + make_interval(days => p_days))
  returning * into v_row;

  return query select true, 'ok'::text, v_row.id, v_row.token, v_row.expires_at;
end;
$fn$;

revoke all on function wholesale_v2.v2_issue_buyer_invite(text, text, text, integer) from public;
grant execute on function wholesale_v2.v2_issue_buyer_invite(text, text, text, integer) to authenticated;

-- --------------------------------------------- what the invited shop sees --
create or replace function wholesale_v2.v2_invite_by_token(p_token text)
returns table(status text, wholesaler_name text, shop_name text)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_inv wholesale_v2.v2_buyer_invites%rowtype;
  v_wname text;
begin
  select * into v_inv from wholesale_v2.v2_buyer_invites i where i.token = p_token;

  -- An invented token and a revoked one are told apart ON PURPOSE here, unlike
  -- the order link. The difference is who is holding it: an order link may be
  -- in a stranger's hands, so a dead link and a fake one must read alike. An
  -- invite is held by someone the wholesaler chose to contact, and "this
  -- invitation was withdrawn" is information they can act on, where "not
  -- found" would send them back to the wholesaler to ask a question the
  -- product could have answered.
  if v_inv.id is null then
    return query select 'not_found'::text, null::text, null::text; return;
  end if;

  select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_inv.wid;

  if v_inv.revoked_at is not null then
    return query select 'revoked'::text, v_wname, v_inv.shop_name; return;
  end if;
  if v_inv.redeemed_at is not null then
    return query select 'used'::text, v_wname, v_inv.shop_name; return;
  end if;
  if v_inv.expires_at < now() then
    return query select 'expired'::text, v_wname, v_inv.shop_name; return;
  end if;

  return query select 'ok'::text, v_wname, v_inv.shop_name;
end;
$fn$;

revoke all on function wholesale_v2.v2_invite_by_token(text) from public;
grant execute on function wholesale_v2.v2_invite_by_token(text) to anon;
grant execute on function wholesale_v2.v2_invite_by_token(text) to authenticated;

-- ------------------------------------------------------------- redeem it --
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

  -- The client and the login, in ONE transaction. A client who cannot sign in
  -- is not a client (060's header, and the 17 Aug SQUARE incident).
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
  values (v_inv.wid, v_shop, v_inv.phone)
  returning id into v_client;

  insert into wholesale_v2.v2_portal_accounts (wid, client_id, role, username, password_hash, actor_label, active)
  values (v_inv.wid, v_client, 'buyer', v_user,
          extensions.crypt(p_password, extensions.gen_salt('bf')), v_shop, true)
  returning id into v_account;

  update wholesale_v2.v2_buyer_invites
     set redeemed_at = now(), redeemed_client_id = v_client, redeemed_account_id = v_account
   where id = v_inv.id;

  return query select true, 'ok'::text, v_inv.wid, v_client, v_account;
end;
$fn$;

revoke all on function wholesale_v2.v2_redeem_buyer_invite(text, text, text, text) from public;
-- anon, necessarily: the person redeeming has no account yet -- that is the
-- entire point. The token IS the authorisation, it is resolved inside the
-- function, and it is single-use under a row lock.
grant execute on function wholesale_v2.v2_redeem_buyer_invite(text, text, text, text) to anon;
grant execute on function wholesale_v2.v2_redeem_buyer_invite(text, text, text, text) to authenticated;

-- ------------------------------------------------------------- revoke it --
create or replace function wholesale_v2.v2_revoke_buyer_invite(p_invite_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_owner text;
begin
  select i.wid into v_owner from wholesale_v2.v2_buyer_invites i where i.id = p_invite_id;
  if v_owner is null then raise exception 'invite not found'; end if;
  v_wid := wholesale_v2.v2_my_wid();
  if not (wholesale_v2.v2_is_owner() or v_wid = v_owner) then
    raise exception 'not your invitation';
  end if;
  update wholesale_v2.v2_buyer_invites
     set revoked_at = now(), revoked_by = coalesce(auth.jwt() ->> 'email', 'wholesaler')
   where id = p_invite_id and redeemed_at is null;
  return found;
end;
$fn$;

revoke all on function wholesale_v2.v2_revoke_buyer_invite(uuid) from public;
-- anon is NOT granted: buyers and reps are anon (085), and a buyer must never
-- be able to withdraw their wholesaler's invitations.
grant execute on function wholesale_v2.v2_revoke_buyer_invite(uuid) to authenticated;

-- =============================================================================
-- SELF-ASSERTING, like 085 and 088.
-- =============================================================================
do $$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema='wholesale_v2' and table_name='v2_buyer_invites';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: v2_buyer_invites was not created'; end if;

  -- The lock this whole batch is about: anon must hold NO table privilege.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_buyer_invites' and grantee='anon';
  if n <> 0 then raise exception 'ASSERT 2 FAILED: anon holds % grant(s) on v2_buyer_invites -- 085 closed that door and this migration must not reopen it', n; end if;

  if not has_function_privilege('anon','wholesale_v2.v2_invite_by_token(text)','execute')
    then raise exception 'ASSERT 3 FAILED: an invited shop cannot open their own link'; end if;
  if not has_function_privilege('anon','wholesale_v2.v2_redeem_buyer_invite(text,text,text,text)','execute')
    then raise exception 'ASSERT 4 FAILED: an invited shop cannot redeem -- they have no account yet, which is the point'; end if;

  if has_function_privilege('anon','wholesale_v2.v2_issue_buyer_invite(text,text,text,integer)','execute')
    then raise exception 'ASSERT 5 FAILED: anon can ISSUE invitations -- buyers and reps are anon, so anyone could mint access to a store'; end if;
  if has_function_privilege('anon','wholesale_v2.v2_revoke_buyer_invite(uuid)','execute')
    then raise exception 'ASSERT 6 FAILED: anon can REVOKE invitations -- a buyer could withdraw their wholesaler''s invites'; end if;

  -- The projection an unauthenticated caller can see must stay small and dull.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_invite_by_token'
     and (pg_get_function_result(p.oid) ilike '%phone%' or pg_get_function_result(p.oid) ilike '%note%');
  if n <> 0 then raise exception 'ASSERT 7 FAILED: v2_invite_by_token exposes the phone or the wholesaler''s private note to whoever holds the link'; end if;

  raise notice '089 OK: invites created; anon may open and redeem, and may not issue or revoke; the public projection carries no phone and no note.';
end $$;
