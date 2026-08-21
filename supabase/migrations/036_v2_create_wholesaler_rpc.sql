-- OGGI Wholesale v2 — Migration 036: create a wholesaler, atomically
-- 17 Aug 2026 · CR-0001 R1 + R3
--
-- ============================================================team=====
-- WHAT THIS SOLVES
-- Until today there was NO way, anywhere in the product, to create a
-- wholesaler. Not in the owner console, not in any database function.
-- The four that exist were put there by hand in migration 008 and by the
-- test fixtures. Onboarding a real wholesaler was impossible.
--
-- WHY IT IS ONE FUNCTION AND NOT SEVERAL BROWSER CALLS
-- Creating a wholesaler actually touches FIVE places:
--   1. auth.users        -- the login itself
--   2. auth.identities   -- without this row, email+password login fails
--   3. public.wholesalers    -- v1's table. v2_wholesalers has a FOREIGN
--                               KEY to it, so the v2 row cannot exist
--                               without it.
--   4. wholesale_v2.v2_wholesalers  -- the v2 record
--   5. public.profiles AND wholesale_v2.v2_user_profiles -- the TWO
--      separate role systems this product has. v1 security reads the
--      first, v2 reads the second. Writing only one makes a wholesaler
--      that half-exists: on 17 Aug these two tables held 6 rows and 2
--      rows respectively, already drifted apart.
--
-- Doing that from the browser would be five requests that can fail
-- independently, leaving a half-created wholesaler with no way to finish
-- it. A single function is ONE transaction: it all lands, or none of it
-- does and you get an error message instead of a mess.
--
-- WHY SECURITY DEFINER
-- v1's tables are protected by v1's own rules, which read public.profiles
-- via is_owner(). v2's read v2_user_profiles. Rather than depend on both
-- systems agreeing about who you are -- they already disagree -- this
-- function runs with definer rights and does its OWN owner check on the
-- first line. That check is the security boundary, not the RLS policies.
-- This is the same pattern v2_create_invite already uses.
--
-- FAILURE MODE THIS DELIBERATELY AVOIDS
-- Writing to v1's tables from the browser as `anon` returns "200 OK, 0
-- rows changed" -- a success message and nothing created. Migration 008's
-- own header documents that exact silent no-op happening twice in this
-- build. Every failure path below returns a LOUD, specific message.
-- ====================================================================
--
-- ---------------------------------------------------------------------
-- RECOVERED 21 Aug 2026 (Batch 7), together with 035 and 038. Applied on
-- 17 Aug, file never committed. The text below is exactly what the
-- database recorded in supabase_migrations.schema_migrations -- including
-- the stray "team" in the banner above, which is reproduced rather than
-- tidied, because a recovered file that differs from the record is not a
-- recovery.
--
-- THIS MIGRATION IS ALSO THE BEST EXISTING ACCOUNT OF WHY v2 CANNOT BE
-- REBUILT FROM THIS REPO ALONE: it writes to public.wholesalers and
-- public.profiles, which no v2 migration creates. See
-- 000_v1_prerequisites.sql, added in the same batch.
-- ---------------------------------------------------------------------

create or replace function wholesale_v2.v2_create_wholesaler(
  p_handle        text,                    -- 'square' -> login square@oggiwholesale.app
  p_brand         text,
  p_password      text,
  p_name          text default null,
  p_industry      text default null,
  p_location      text default null,
  p_phone         text default null,
  p_email         text default null,
  p_currency      text default '$',
  p_categories    text[] default '{}',     -- names, not ids: new ones are created
  p_notes         text default null
)
returns table (ok boolean, error text, wid text, login_email text)
language plpgsql
security definer
set search_path to 'wholesale_v2', 'public', 'extensions'
as $$
declare
  v_wid    text;
  v_login  text;
  v_uid    uuid := gen_random_uuid();
  v_cat    text;
  v_catid  uuid;
begin
  -- 1. Only an owner. Checked here, inside the function, not by hiding a
  --    button -- a wholesaler calling this directly is still rejected.
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can create a wholesaler', null::text, null::text;
    return;
  end if;

  -- 2. Validate before touching anything, so a bad input never leaves
  --    a partial record behind.
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

  -- 8 characters is the same floor Supabase Auth enforces by default.
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

  -- 3. The login. Field-for-field the same shape as the accounts that
  --    already work (verified against square@oggiwholesale.app on
  --    17 Aug 2026), because a missing field here produces an account
  --    that exists but cannot sign in.
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
  ) values (
    v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_login, extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"email_verified":true}'::jsonb,
    false, false
  );

  -- WITHOUT THIS ROW EMAIL+PASSWORD LOGIN SILENTLY FAILS. The user row
  -- alone is not enough; GoTrue looks the account up through identities.
  insert into auth.identities (
    id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), v_uid, 'email', v_uid::text,
    jsonb_build_object('sub', v_uid::text, 'email', v_login,
                       'email_verified', true, 'phone_verified', false),
    now(), now(), null
  );

  -- 4. v1's row FIRST -- v2_wholesalers.wid references it, so the order
  --    matters. brand and currency are NOT NULL in v1's table.
  insert into public.wholesalers (wid, brand, name, currency, active, owner_phone)
  values (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
          coalesce(nullif(trim(p_currency), ''), '$'), true, nullif(trim(p_phone), ''));

  -- 5. v2's row, with everything migration 034 added.
  insert into wholesale_v2.v2_wholesalers
    (wid, brand, name, currency, active, industry, location,
     contact_phone, contact_email, owner_notes, created_by)
  values
    (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
     coalesce(nullif(trim(p_currency), ''), '$'), true,
     nullif(trim(p_industry), ''), nullif(trim(p_location), ''),
     nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
     nullif(trim(p_notes), ''), auth.uid());

  -- 6. BOTH role tables. Skipping either one makes a wholesaler that
  --    works in one half of the product and is invisible in the other.
  insert into public.profiles (id, role, wid) values (v_uid, 'wholesaler', v_wid)
    on conflict (id) do update set role = 'wholesaler', wid = excluded.wid;

  insert into wholesale_v2.v2_user_profiles (id, role, wid, wholesaler_name, actor_label)
  values (v_uid, 'wholesaler', v_wid, trim(p_brand), trim(p_brand))
    on conflict (id) do update
      set role = 'wholesaler', wid = excluded.wid,
          wholesaler_name = excluded.wholesaler_name, actor_label = excluded.actor_label;

  -- 7. Categories. A name that does not exist yet is CREATED, which is
  --    what makes "type your own" work without a code change.
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
$$;

revoke all on function wholesale_v2.v2_create_wholesaler(text,text,text,text,text,text,text,text,text,text[],text) from public, anon;
grant execute on function wholesale_v2.v2_create_wholesaler(text,text,text,text,text,text,text,text,text,text[],text) to authenticated;

comment on function wholesale_v2.v2_create_wholesaler(text,text,text,text,text,text,text,text,text,text[],text) is
  'CR-0001 R1/R3. Creates a wholesaler end to end in one transaction: auth user + identity, v1 wholesalers row, v2_wholesalers row, BOTH role-profile tables, and category links. Owner-only, checked inside the function. Returns (ok, error, wid, login_email) rather than raising, so the UI can show the reason.';
