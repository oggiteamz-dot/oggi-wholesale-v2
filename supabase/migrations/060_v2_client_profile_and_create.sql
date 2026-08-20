-- =====================================================================
-- 060 — The client record grows up, and gets a create form worth using
--
-- Hadi, 20 Aug 2026: "When a wholesaler creates an account for someone,
-- I want them to be able to create this account by the bare minimum,
-- meaning the required stuff are on the top. And then the secondary
-- important stuff can be created another day. That's not a problem.
-- Just to make it easier for them to actually do this. The things that
-- are mandatory is company name, owner's name, owner's phone number,
-- what do they sell, and the username and password that they create and
-- give them the ability to auto-generate a random password."
--
-- WHAT THE RECORD LOOKED LIKE BEFORE THIS
-- ---------------------------------------------------------------------
--   shop_name, phone, note, discount_pct, active, access_tier
-- ...and a free-text `note` doing the job of a dozen real fields. You
-- could not answer "which of my customers sell kidswear", "who is in
-- Tripoli", or "how many branches does this one have" without reading
-- prose. That is why the fields below are real columns and not a JSON
-- blob: v2_clients.discount_pct sat silently dead from migration 006
-- until 19 Aug precisely because nothing was watching it, and a blob
-- would have hidden a dozen more the same way.
--
-- THE THREE TIERS (from the research pass, docs/[C] Client Accounts)
-- ---------------------------------------------------------------------
-- T0  required to create at all    — 6 fields, below
-- T1  prompted later, never blocks — city/address/branches/years/etc
-- T2  only when an EVENT asks      — not built here, on purpose
--
-- The tiering is not a style choice. Across 19 B2B platforms the ones
-- that ask everything up front are the ones buyers abandon; Faire defers
-- verification until AFTER a first order, Alibaba until a tier upgrade.
-- The trigger for asking more is an event, never a step in a wizard.
--
-- ⚠️ NO MONEY FIELDS. Hadi, same day: "we're not going to have anything
-- cash related... this is just an ordering system. They then send the
-- invoice and do their business side on their own. And in fact, remove
-- the VAT completely because we don't do anything with money."
-- So: no payment terms, no credit limit, no VAT rate, no tax logic.
-- discount_pct stays because it is the catalogue price itself, not money
-- handling. A vat_number COLUMN exists only as an optional identity
-- field a wholesaler may switch ON if they want it -- it is never
-- computed with, and it is OFF by default.
-- =====================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. T0 — the two genuinely new required fields
-- ---------------------------------------------------------------------
-- shop_name and phone already exist. owner_name and sells do not, and
-- both are things a wholesaler in this market asks in the first thirty
-- seconds of knowing someone.
alter table wholesale_v2.v2_clients
  add column if not exists owner_name text,
  add column if not exists sells text[] not null default '{}';

comment on column wholesale_v2.v2_clients.owner_name is
  'The human being. Distinct from shop_name (the business) -- conflating the two is the bug that made every client read as 0 orders until 17 Aug.';
comment on column wholesale_v2.v2_clients.sells is
  'What this shop actually sells. An array, not prose, so "who sells kidswear" is a query and not a read-through.';

-- ---------------------------------------------------------------------
-- 2. T1 — asked later, never blocking
-- ---------------------------------------------------------------------
alter table wholesale_v2.v2_clients
  add column if not exists city            text,
  add column if not exists area            text,
  add column if not exists address         text,
  add column if not exists country         text,
  add column if not exists phone2          text,
  add column if not exists email           text,
  add column if not exists business_type   text,
  add column if not exists branches        smallint,
  add column if not exists years_in_business smallint,
  add column if not exists instagram       text,
  add column if not exists photo_url       text,
  add column if not exists language        text,
  add column if not exists heard_from      text,
  -- Identity numbers. Present so a wholesaler in the UAE or Saudi CAN
  -- ask; OFF by default because in Lebanon the mandatory VAT threshold
  -- is LBP 5bn/quarter (~$224k/yr), so a perfectly legitimate small shop
  -- is LEGALLY EXEMPT and simply has no number to type. Making it
  -- required would lock out most of the actual market.
  add column if not exists commercial_reg  text,
  add column if not exists vat_number      text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_clients_branches_sane') then
    alter table wholesale_v2.v2_clients
      add constraint v2_clients_branches_sane check (branches is null or branches between 1 and 9999);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'v2_clients_years_sane') then
    alter table wholesale_v2.v2_clients
      add constraint v2_clients_years_sane check (years_in_business is null or years_in_business between 0 and 200);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Which optional fields does THIS wholesaler ask for?
-- ---------------------------------------------------------------------
-- Hadi: "just make it a toggle and they change it as they see fit. It's
-- not up to us."
--
-- This replaces the country-detection idea from the research doc, and is
-- better: guessing what to ask from someone's country is us deciding.
-- A toggle is them deciding. Empty object = the sensible default set
-- below, resolved in the app, so switching this on later never rewrites
-- anyone's existing data.
alter table wholesale_v2.v2_wholesalers
  add column if not exists client_fields jsonb not null default '{}'::jsonb;

comment on column wholesale_v2.v2_wholesalers.client_fields is
  'Per-wholesaler switch for which OPTIONAL client fields the forms show, e.g. {"vat_number": true, "years_in_business": false}. The six required fields are not listed here and cannot be switched off. Empty = app defaults.';

-- ---------------------------------------------------------------------
-- 4. A password the wholesaler hands over ONCE, that dies on first use
-- ---------------------------------------------------------------------
-- The wholesaler will send this over WhatsApp. That is not a flaw in the
-- design, it is how this market works and pretending otherwise builds
-- the wrong product. The mitigation is that the password is single-use:
-- the buyer must replace it the first time they sign in, so the copy
-- sitting in a WhatsApp thread stops being a key the moment it is used.
alter table wholesale_v2.v2_portal_accounts
  add column if not exists must_change_password boolean not null default false;

comment on column wholesale_v2.v2_portal_accounts.must_change_password is
  'Set when a wholesaler generates a password for someone. The buyer is forced to replace it on first sign-in, so the copy relayed over WhatsApp is dead on arrival.';

-- ---------------------------------------------------------------------
-- 5. Create a client and their login, in ONE transaction
-- ---------------------------------------------------------------------
-- Two separate calls would let a client exist with no login, or a login
-- with no client -- and the second of those is exactly the state that
-- made SQUARE's account authenticate into nowhere on 17 Aug.
--
-- The generated password is returned in this response and NOWHERE ELSE.
-- It is bcrypt-hashed on the way in; there is no column holding it in
-- readable form and no function that can hand it back. Reuses the exact
-- mechanism v2_approve_signup_request has used since migration 024
-- rather than inventing a second one.
create or replace function wholesale_v2.v2_create_client(
  p_shop_name   text,
  p_owner_name  text,
  p_phone       text,
  p_sells       text[],
  p_username    text,
  p_password    text default null,       -- null => generate one
  p_discount_pct numeric default 0,
  p_access_tier smallint default 1,
  p_extra       jsonb default '{}'::jsonb
)
returns table(ok boolean, msg text, client_id uuid, account_id uuid, username text, temp_password text)
language plpgsql
security definer
set search_path = wholesale_v2, public, extensions
as $$
declare
  v_wid       text;
  v_client_id uuid;
  v_account_id uuid;
  v_user      text;
  v_pass      text;
  v_generated boolean := false;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then
    return query select false, 'Only a wholesaler can add a client.', null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  -- The six required fields, refused in the database and not merely in
  -- the form, so a stray API call cannot create a half-record.
  if coalesce(btrim(p_shop_name), '') = '' then
    return query select false, 'Company name is required.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if coalesce(btrim(p_owner_name), '') = '' then
    return query select false, 'Owner name is required.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if coalesce(btrim(p_phone), '') = '' then
    return query select false, 'Owner phone is required.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if p_sells is null or array_length(p_sells, 1) is null then
    return query select false, 'Say what they sell -- it decides which catalogues they belong in.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if coalesce(btrim(p_username), '') = '' then
    return query select false, 'Username is required.', null::uuid, null::uuid, null::text, null::text; return;
  end if;

  v_user := lower(btrim(p_username));

  -- Same phone = same person. Catching this here is what stops the
  -- duplicate records that make order history quietly wrong.
  -- NOTE the table aliases below. This function RETURNS TABLE(... username
  -- ...), which puts `username` (and `client_id`, `msg`, `ok`) into scope as
  -- OUT variables. An unqualified `username` inside a query over
  -- v2_portal_accounts is therefore ambiguous and Postgres refuses it at RUN
  -- time, not at CREATE time -- so the function compiles happily and fails the
  -- first time a wholesaler clicks Add. Caught 20 Aug 2026 by seeding real
  -- clients through this function instead of inserting rows directly, which is
  -- the whole reason the seed goes through the real code path.
  if exists (select 1 from wholesale_v2.v2_clients c
              where c.wid = v_wid and c.phone is not null
                and regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
                and c.status <> 'archived') then
    return query select false, 'You already have a client with that phone number.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if exists (select 1 from wholesale_v2.v2_portal_accounts a
              where a.wid = v_wid and lower(a.username) = v_user and a.role = 'buyer') then
    return query select false, 'That username is already taken.', null::uuid, null::uuid, null::text, null::text; return;
  end if;
  if exists (select 1 from wholesale_v2.v2_clients c2 where c2.wid = v_wid and c2.shop_name = btrim(p_shop_name)) then
    return query select false, 'You already have a client with that company name.', null::uuid, null::uuid, null::text, null::text; return;
  end if;

  if p_password is null or btrim(p_password) = '' then
    v_pass := encode(extensions.gen_random_bytes(9), 'base64');
    v_pass := replace(replace(replace(v_pass, '/', '2'), '+', '9'), '=', '');
    v_generated := true;
  else
    if length(p_password) < 8 then
      return query select false, 'A typed password must be at least 8 characters.', null::uuid, null::uuid, null::text, null::text; return;
    end if;
    v_pass := p_password;
  end if;

  insert into wholesale_v2.v2_clients (
    wid, shop_name, owner_name, phone, sells, discount_pct, access_tier, status,
    city, area, address, country, phone2, email, business_type,
    branches, years_in_business, instagram, language, heard_from,
    commercial_reg, vat_number, note
  ) values (
    v_wid, btrim(p_shop_name), btrim(p_owner_name), btrim(p_phone), p_sells,
    coalesce(p_discount_pct, 0), coalesce(p_access_tier, 1), 'active',
    nullif(btrim(coalesce(p_extra->>'city','')),''),
    nullif(btrim(coalesce(p_extra->>'area','')),''),
    nullif(btrim(coalesce(p_extra->>'address','')),''),
    nullif(btrim(coalesce(p_extra->>'country','')),''),
    nullif(btrim(coalesce(p_extra->>'phone2','')),''),
    nullif(btrim(coalesce(p_extra->>'email','')),''),
    nullif(btrim(coalesce(p_extra->>'business_type','')),''),
    nullif(p_extra->>'branches','')::smallint,
    nullif(p_extra->>'years_in_business','')::smallint,
    nullif(btrim(coalesce(p_extra->>'instagram','')),''),
    nullif(btrim(coalesce(p_extra->>'language','')),''),
    nullif(btrim(coalesce(p_extra->>'heard_from','')),''),
    nullif(btrim(coalesce(p_extra->>'commercial_reg','')),''),
    nullif(btrim(coalesce(p_extra->>'vat_number','')),''),
    nullif(btrim(coalesce(p_extra->>'note','')),'')
  )
  returning id into v_client_id;

  insert into wholesale_v2.v2_portal_accounts (
    wid, role, username, password_hash, client_id, actor_label, must_change_password
  ) values (
    v_wid, 'buyer', v_user, extensions.crypt(v_pass, extensions.gen_salt('bf')),
    v_client_id, btrim(p_owner_name), true
  )
  returning id into v_account_id;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (v_wid, 'client_created', 'client', v_client_id::text,
          jsonb_build_object('shop_name', btrim(p_shop_name), 'username', v_user, 'password_generated', v_generated));

  -- temp_password is returned ONLY when we generated it. If the
  -- wholesaler typed one, they already know it, and echoing it back
  -- would put it in a network response for no reason.
  return query select true, 'Client created.', v_client_id, v_account_id, v_user,
                      case when v_generated then v_pass else null end;
end;
$$;
revoke all on function wholesale_v2.v2_create_client(text, text, text, text[], text, text, numeric, smallint, jsonb) from public, anon;
grant execute on function wholesale_v2.v2_create_client(text, text, text, text[], text, text, numeric, smallint, jsonb) to authenticated;

comment on function wholesale_v2.v2_create_client is
  'Creates the CRM row AND the buyer login in one transaction, so neither can exist without the other. Returns a generated password exactly once, never stored readable. Refuses the six required fields server-side, and refuses a duplicate phone, username or company name.';

-- ---------------------------------------------------------------------
-- 6. Reset a password without deleting the person
-- ---------------------------------------------------------------------
-- Without this, every forgotten password becomes a message to OGGI
-- instead of something the wholesaler settles in ten seconds.
create or replace function wholesale_v2.v2_reset_client_password(p_client_id uuid)
returns table(ok boolean, msg text, username text, temp_password text)
language plpgsql
security definer
set search_path = wholesale_v2, public, extensions
as $$
declare
  v_client wholesale_v2.v2_clients%rowtype;
  v_acct   wholesale_v2.v2_portal_accounts%rowtype;
  v_pass   text;
begin
  select * into v_client from wholesale_v2.v2_clients where id = p_client_id;
  if v_client.id is null then
    return query select false, 'No such client.', null::text, null::text; return;
  end if;
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_client.wid) then
    return query select false, 'Not your client.', null::text, null::text; return;
  end if;

  select a.* into v_acct from wholesale_v2.v2_portal_accounts a
   where a.client_id = p_client_id and a.wid = v_client.wid and a.role = 'buyer' limit 1;
  if v_acct.id is null then
    return query select false, 'This client has no login yet.', null::text, null::text; return;
  end if;

  v_pass := encode(extensions.gen_random_bytes(9), 'base64');
  v_pass := replace(replace(replace(v_pass, '/', '2'), '+', '9'), '=', '');

  update wholesale_v2.v2_portal_accounts a
     set password_hash = extensions.crypt(v_pass, extensions.gen_salt('bf')),
         must_change_password = true,
         updated_at = now()
   where a.id = v_acct.id;

  -- Clear the lockout too. Someone who forgot their password has usually
  -- just failed ten attempts, and resetting into a locked account looks
  -- exactly like the reset not working.
  delete from wholesale_v2.v2_login_throttle t
   where t.key = 'buyer|' || lower(v_client.wid) || '|' || lower(v_acct.username);

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (coalesce(wholesale_v2.v2_my_wid(),'owner'), 'client_password_reset', 'client', p_client_id::text,
          jsonb_build_object('username', v_acct.username));

  return query select true, 'New password generated.', v_acct.username, v_pass;
end;
$$;
revoke all on function wholesale_v2.v2_reset_client_password(uuid) from public, anon;
grant execute on function wholesale_v2.v2_reset_client_password(uuid) to authenticated;

comment on function wholesale_v2.v2_reset_client_password is
  'Generates a new one-time password for a client and forces a change on next sign-in. Also clears the login throttle, because resetting into a locked account looks identical to the reset having failed.';
