-- OGGI Wholesale v2 — Migrations 034–036 (consolidated)
-- Owner console: wholesaler profile fields, categories, and the atomic
-- create-wholesaler function.
-- 17 Aug 2026 · CR-0001
--
-- ====================================================================
-- WHY THREE MIGRATIONS ARE IN ONE FILE
-- These were applied live to the database as three separate migrations
-- (034_v2_wholesaler_profile_fields, 035_v2_categories,
-- 036_v2_create_wholesaler_rpc) and are recorded that way in
-- supabase_migrations.schema_migrations. They are saved here as one file
-- so the repo can rebuild the database, which it could not do otherwise.
--
-- This matters because of a real defect found in the 17 Aug regression
-- audit: migration 029's enforcement was applied live and never saved as
-- a file, so a database rebuilt from this repo silently had NO
-- selling-model enforcement while the live one did. Live-but-unsaved is
-- the failure mode. Everything below is safe to re-run: every statement
-- is idempotent (if not exists / or replace / on conflict do nothing).
-- ====================================================================


-- ====================================================================
-- 034 — wholesaler profile fields
--
-- Before this, the whole table was six columns:
--   wid · brand · name · currency · active · updated_at
-- There was nowhere to record a wholesaler's industry, categories or
-- location. ADDITIVE ONLY: every column is nullable, so all pre-existing
-- rows stay valid and all code written before today keeps working. No
-- rename, no drop -- which is what makes a plain code rollback safe.
-- ====================================================================

alter table wholesale_v2.v2_wholesalers
  add column if not exists industry       text,
  -- Free text, not a country dropdown: OGGI's wholesalers are described
  -- by district ("Bourj Hammoud, Beirut"), not by country.
  add column if not exists location       text,
  -- WhatsApp destination for sending credentials (CR-0001 R4).
  add column if not exists contact_phone  text,
  -- Nullable by design: an OGGI-issued login (brand@oggiwholesale.app)
  -- is not a real inbox, so this is legitimately empty until the
  -- wholesaler supplies a real address.
  add column if not exists contact_email  text,
  -- Owner's private notes. Never shown to the wholesaler.
  add column if not exists owner_notes    text,
  add column if not exists created_at     timestamptz not null default now(),
  add column if not exists created_by     uuid;

comment on column wholesale_v2.v2_wholesalers.industry is
  'Single trade the wholesaler is in. For the many-valued "what do they sell", see v2_wholesaler_categories.';
comment on column wholesale_v2.v2_wholesalers.contact_phone is
  'Digits-only phone used to build the wa.me credential-delivery link.';


-- ====================================================================
-- 035 — categories
--
-- WHY A TABLE, NOT A HARD-CODED LIST: Hadi asked for presets he can click
-- AND the ability to type a new one. As a JavaScript array, adding
-- "Swimwear" would mean a code change, a deploy and a developer -- for a
-- piece of business vocabulary he should own. As a table, he adds it
-- himself and it is instantly available.
--
-- WHY A JOIN TABLE: a wholesaler sells across several categories at once
-- ("a wholesaler can have multiple different categories that they sell").
-- ====================================================================

create table if not exists wholesale_v2.v2_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- Lets the owner order the preset chips by what he uses most, rather
  -- than alphabetical-forever.
  sort_order int  not null default 100,
  -- Retire without deleting: wholesalers already linked keep their
  -- category and their history, it just stops being offered.
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- "Menswear" and "menswear" must not both exist.
create unique index if not exists v2_categories_name_ci
  on wholesale_v2.v2_categories (lower(name));

-- CASCADE on wid cleans up when a wholesaler goes; RESTRICT on the
-- category stops one being deleted out from under a wholesaler.
create table if not exists wholesale_v2.v2_wholesaler_categories (
  wid         text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  category_id uuid not null references wholesale_v2.v2_categories(id)   on delete restrict,
  primary key (wid, category_id)
);

create index if not exists v2_wholesaler_categories_by_category
  on wholesale_v2.v2_wholesaler_categories (category_id);

alter table wholesale_v2.v2_categories            enable row level security;
alter table wholesale_v2.v2_wholesaler_categories enable row level security;

-- Readable by anyone signed in (the buyer supplier directory will want
-- "what do they sell"); writable by the owner only. Uses the existing
-- v2_is_owner() helper so there is ONE definition of "is this the owner".
drop policy if exists v2_categories_read on wholesale_v2.v2_categories;
create policy v2_categories_read on wholesale_v2.v2_categories
  for select using (true);

drop policy if exists v2_categories_write on wholesale_v2.v2_categories;
create policy v2_categories_write on wholesale_v2.v2_categories
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

drop policy if exists v2_wholesaler_categories_read on wholesale_v2.v2_wholesaler_categories;
create policy v2_wholesaler_categories_read on wholesale_v2.v2_wholesaler_categories
  for select using (true);

drop policy if exists v2_wholesaler_categories_write on wholesale_v2.v2_wholesaler_categories;
create policy v2_wholesaler_categories_write on wholesale_v2.v2_wholesaler_categories
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select on wholesale_v2.v2_categories, wholesale_v2.v2_wholesaler_categories to anon, authenticated;
grant insert, update, delete on wholesale_v2.v2_categories, wholesale_v2.v2_wholesaler_categories to authenticated;

-- Starter presets for an apparel wholesale market. A STARTING POINT, not
-- a fixed list -- edited from the owner console, not from this file.
insert into wholesale_v2.v2_categories (name, sort_order) values
  ('Womenswear', 10), ('Menswear', 20), ('Kidswear', 30), ('Babywear', 40),
  ('Shoes', 50), ('Bags', 60), ('Accessories', 70), ('Jewellery', 80),
  ('Lingerie & Nightwear', 90), ('Sportswear & Activewear', 100),
  ('Denim', 110), ('Outerwear & Jackets', 120), ('Knitwear', 130),
  ('Swimwear', 140), ('Modest Wear & Abaya', 150), ('Workwear & Uniforms', 160),
  ('Fabrics & Textiles', 170), ('Home Textiles & Linen', 180),
  ('Scarves & Shawls', 190), ('Socks & Hosiery', 200)
on conflict do nothing;


-- ====================================================================
-- 036 — v2_create_wholesaler
--
-- WHAT THIS SOLVES: until 17 Aug 2026 there was NO way, anywhere in the
-- product, to create a wholesaler -- not in the owner console, not in any
-- database function. The four that existed were inserted by hand in
-- migration 008 and by test fixtures. Onboarding a real wholesaler was
-- impossible.
--
-- WHY ONE FUNCTION AND NOT SEVERAL BROWSER CALLS: creating a wholesaler
-- touches FIVE places --
--   1. auth.users               the login
--   2. auth.identities          without this, email+password login FAILS
--   3. public.wholesalers       v1's table; v2_wholesalers has a FOREIGN
--                               KEY to it, so the v2 row cannot exist
--                               without it
--   4. v2_wholesalers           the v2 record
--   5. public.profiles AND v2_user_profiles -- the TWO separate role
--      systems this product has. v1 security reads the first, v2 reads
--      the second. Writing only one makes a wholesaler that half-exists:
--      on 17 Aug these held 6 rows and 2 rows respectively, already
--      drifted apart.
-- From the browser that is five requests that can fail independently,
-- leaving a half-created wholesaler nobody can finish or remove. One
-- function is ONE transaction: it all lands, or none of it does.
--
-- WHY SECURITY DEFINER: rather than depend on both RLS systems agreeing
-- about who you are -- they already disagree -- this runs with definer
-- rights and does its OWN owner check on the first line. That check IS
-- the security boundary. Same pattern as v2_create_invite.
--
-- FAILURE MODE AVOIDED: writing to v1's tables from the browser as `anon`
-- returns "200 OK, 0 rows changed" -- a success message and nothing
-- created. Migration 008's header documents that silent no-op happening
-- twice in this build. Every failure path below returns a LOUD reason.
-- ====================================================================

create or replace function wholesale_v2.v2_create_wholesaler(
  p_handle        text,                    -- 'square' -> square@oggiwholesale.app
  p_brand         text,
  p_password      text,
  p_name          text default null,
  p_industry      text default null,
  p_location      text default null,
  p_phone         text default null,
  p_email         text default null,
  p_currency      text default '$',
  p_categories    text[] default '{}',     -- NAMES; unknown ones are created
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
  -- 1. Owner only. Checked here, not by hiding a button.
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can create a wholesaler', null::text, null::text;
    return;
  end if;

  -- 2. Validate everything BEFORE writing anything, so a bad input can
  --    never leave a partial record behind.
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

  -- 8 characters is Supabase Auth's own default floor.
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

  -- 3. The login. Field-for-field the same shape as accounts that already
  --    work (verified against square@oggiwholesale.app on 17 Aug 2026) --
  --    a missing field here produces an account that exists but cannot
  --    sign in.
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

  -- WITHOUT THIS ROW, EMAIL+PASSWORD LOGIN SILENTLY FAILS. The user row
  -- alone is not enough; GoTrue looks accounts up through identities.
  insert into auth.identities (
    id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), v_uid, 'email', v_uid::text,
    jsonb_build_object('sub', v_uid::text, 'email', v_login,
                       'email_verified', true, 'phone_verified', false),
    now(), now(), null
  );

  -- 4. v1's row FIRST -- v2_wholesalers.wid references it. brand and
  --    currency are NOT NULL in v1's table.
  insert into public.wholesalers (wid, brand, name, currency, active, owner_phone)
  values (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
          coalesce(nullif(trim(p_currency), ''), '$'), true, nullif(trim(p_phone), ''));

  -- 5. v2's row, with everything 034 added.
  insert into wholesale_v2.v2_wholesalers
    (wid, brand, name, currency, active, industry, location,
     contact_phone, contact_email, owner_notes, created_by)
  values
    (v_wid, trim(p_brand), coalesce(nullif(trim(p_name), ''), trim(p_brand)),
     coalesce(nullif(trim(p_currency), ''), '$'), true,
     nullif(trim(p_industry), ''), nullif(trim(p_location), ''),
     nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
     nullif(trim(p_notes), ''), auth.uid());

  -- 6. BOTH role tables. Skipping either makes a wholesaler that works in
  --    one half of the product and is invisible in the other.
  insert into public.profiles (id, role, wid) values (v_uid, 'wholesaler', v_wid)
    on conflict (id) do update set role = 'wholesaler', wid = excluded.wid;

  insert into wholesale_v2.v2_user_profiles (id, role, wid, wholesaler_name, actor_label)
  values (v_uid, 'wholesaler', v_wid, trim(p_brand), trim(p_brand))
    on conflict (id) do update
      set role = 'wholesaler', wid = excluded.wid,
          wholesaler_name = excluded.wholesaler_name, actor_label = excluded.actor_label;

  -- 7. Categories. An unrecognised name is CREATED -- that is what makes
  --    "type your own" work without a code change.
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
  'CR-0001 R1/R3. Creates a wholesaler end to end in one transaction: auth user + identity, v1 row, v2 row, BOTH role-profile tables, and category links. Owner-only, checked inside the function. Returns (ok, error, wid, login_email) rather than raising, so the UI can show the reason.';
