-- =============================================================================
-- 041 — EVERY CONSOLE-CREATED WHOLESALER LOGIN WAS DEAD ON ARRIVAL
-- =============================================================================
-- 17 Aug 2026. Reported by Hadi: "I created a new wholesaler and I used their
-- username and password" -> "Database error querying schema".
--
-- THE BUG
-- -------
-- v2_create_wholesaler (migration 034) inserted into auth.users without
-- supplying eight token columns, so they took their column default of NULL.
--
-- GoTrue scans those columns into Go `string` values. A Go string cannot hold
-- NULL, so the scan fails and the whole schema query errors out. The message
-- the user sees -- "Database error querying schema" -- names neither the
-- column nor the row, which is why this looked like a Supabase outage rather
-- than our own INSERT.
--
-- The accounts existed. The password hash was correct. auth.identities was
-- present. They simply could not be signed into, ever. EVERY wholesaler ever
-- created through the owner console was affected: seven rows.
--
-- The columns: confirmation_token, recovery_token, email_change,
-- email_change_token_new, email_change_token_current, phone_change,
-- phone_change_token, reauthentication_token. They must be '' -- the EMPTY
-- STRING -- not NULL.
--
-- This migration does two things: repairs the existing rows, and recreates the
-- function so new ones are born correct. Both, because fixing only the
-- function would leave seven customers permanently locked out, and fixing only
-- the data would let the next created account reintroduce it.
--
-- VERIFIED, NOT ASSUMED: after applying this, a throwaway wholesaler was
-- created through the console, signed in over the real auth endpoint, and
-- returned a genuine access token. The throwaway rows were then deleted.
--
-- Guard to add: a check that asserts no auth.users row has a NULL in any of
-- these eight columns. Tracked in the backlog -- this class of bug is silent
-- at write time and only shows up at someone's first login.
-- =============================================================================

-- ---------------------------------------------------------------------
-- 1. Repair every account already broken
-- ---------------------------------------------------------------------
update auth.users
set confirmation_token         = coalesce(confirmation_token, ''),
    recovery_token             = coalesce(recovery_token, ''),
    email_change               = coalesce(email_change, ''),
    email_change_token_new     = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    phone_change               = coalesce(phone_change, ''),
    phone_change_token         = coalesce(phone_change_token, ''),
    reauthentication_token     = coalesce(reauthentication_token, '')
where confirmation_token is null
   or recovery_token is null
   or email_change is null
   or email_change_token_new is null
   or email_change_token_current is null
   or phone_change is null
   or phone_change_token is null
   or reauthentication_token is null;

-- ---------------------------------------------------------------------
-- 2. Recreate the function so new accounts are born working
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_create_wholesaler(
  p_handle text, p_brand text, p_password text,
  p_name text default null, p_industry text default null, p_location text default null,
  p_phone text default null, p_email text default null, p_currency text default '$',
  p_categories text[] default '{}', p_notes text default null
)
returns table(ok boolean, error text, wid text, login_email text)
language plpgsql
security definer
set search_path to 'wholesale_v2', 'public', 'extensions'
as $function$
declare
  v_wid text; v_login text; v_uid uuid := gen_random_uuid();
  v_cat text; v_catid uuid;
begin
  -- SECURITY DEFINER bypasses RLS. This line IS the access control.
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can create a wholesaler', null::text, null::text;
    return;
  end if;

  v_wid := lower(trim(coalesce(p_handle, '')));
  if v_wid !~ '^[a-z0-9][a-z0-9-]{1,29}$' then
    return query select false,
      'Handle must be 2-30 characters, lowercase letters, numbers or hyphens, e.g. "square"',
      null::text, null::text;
    return;
  end if;

  if coalesce(trim(p_brand), '') = '' then
    return query select false, 'Brand name is required', null::text, null::text;
    return;
  end if;

  if length(coalesce(p_password, '')) < 8 then
    return query select false, 'Password must be at least 8 characters', null::text, null::text;
    return;
  end if;

  v_login := v_wid || '@oggiwholesale.app';

  if exists (select 1 from public.wholesalers w where w.wid = v_wid)
     or exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = v_wid) then
    return query select false, format('The handle "%s" is already taken', v_wid), null::text, null::text;
    return;
  end if;

  if exists (select 1 from auth.users u where lower(u.email) = v_login) then
    return query select false, format('A login for %s already exists', v_login), null::text, null::text;
    return;
  end if;

  -- THE LOGIN.
  -- The eight token columns below are the fix. They MUST be empty strings, not
  -- NULL: GoTrue scans them into Go strings and a NULL throws, surfacing to the
  -- user as "Database error querying schema" at sign-in. Leaving them to their
  -- default produced accounts that existed, held the right password, and could
  -- never be used.
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
  ) values (
    v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_login, extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"email_verified":true}'::jsonb,
    false, false,
    '', '', '', '', '', '', '', ''
  );

  -- WITHOUT THIS ROW EMAIL+PASSWORD LOGIN SILENTLY FAILS. The user row alone is
  -- not enough; GoTrue looks the account up through identities.
  insert into auth.identities (
    id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), v_uid, 'email', v_uid::text,
    jsonb_build_object('sub', v_uid::text, 'email', v_login,
                       'email_verified', true, 'phone_verified', false),
    now(), now(), null
  );

  insert into public.wholesalers (wid, brand, name, currency, active, owner_phone)
  values (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
          coalesce(nullif(trim(p_currency), ''), '$'), true, nullif(trim(p_phone), ''));

  insert into wholesale_v2.v2_wholesalers
    (wid, brand, name, currency, active, industry, location,
     contact_phone, contact_email, owner_notes, created_by)
  values
    (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
     coalesce(nullif(trim(p_currency), ''), '$'), true,
     nullif(trim(p_industry), ''), nullif(trim(p_location), ''),
     nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
     nullif(trim(p_notes), ''), auth.uid());

  insert into public.profiles (id, role, wid) values (v_uid, 'wholesaler', v_wid)
    on conflict (id) do update set role = 'wholesaler', wid = excluded.wid;

  insert into wholesale_v2.v2_user_profiles (id, role, wid, wholesaler_name, actor_label)
  values (v_uid, 'wholesaler', v_wid, trim(p_brand), trim(p_brand))
    on conflict (id) do update
      set role = 'wholesaler', wid = excluded.wid,
          wholesaler_name = excluded.wholesaler_name, actor_label = excluded.actor_label;

  foreach v_cat in array coalesce(p_categories, '{}')
  loop
    if coalesce(trim(v_cat), '') = '' then continue; end if;
    select c.id into v_catid from wholesale_v2.v2_categories c
      where lower(c.name) = lower(trim(v_cat));
    if v_catid is null then
      insert into wholesale_v2.v2_categories (name) values (trim(v_cat)) returning id into v_catid;
    end if;
    insert into wholesale_v2.v2_wholesaler_categories (wid, category_id)
      values (v_wid, v_catid) on conflict do nothing;
    v_catid := null;
  end loop;

  return query select true, ''::text, v_wid, v_login;
end;
$function$;
