-- =============================================================================
-- 043 — EVERY WHOLESALER GETS A STOCK LOCATION (and nobody gets TRUNCATE)
-- =============================================================================
-- 18 Aug 2026.
--
-- PART A — THE BLOCKER
-- -------------------
-- Stock can only be received INTO a location: v2_receive_stock takes a
-- p_location_id, and v2_inventory_balances is keyed on (variant_id,
-- location_id). A wholesaler with no location therefore cannot receive stock
-- at all -- not through the importer, not through the Inventory screen, not
-- through anything.
--
-- v2_create_wholesaler (migration 034, recreated in 041) inserts the
-- wholesaler row, the auth user, the auth identity, both profile rows and the
-- category links. It has never inserted a location. Every wholesaler created
-- through the owner console is therefore born unable to hold inventory.
--
-- Measured before writing this, and it is not theoretical:
--
--   wid              locations  products  variants  balance rows
--   mg                       1         2        32            32
--   omni                     1         2        32            32
--   sq                       1         4        64            64
--   w1785168930020           1         1         5             5
--   test                     0         0         0             0   <-- console-created
--
-- The four with a location were seeded by the v1 data migration, which created
-- "Main Warehouse" for each. `test` is the only one made through the console,
-- and it is the only one that cannot function.
--
-- This migration back-fills the missing ones and fixes the function, because
-- doing only the second would leave the existing customer broken and doing
-- only the first would let the next one break again.
--
-- Note on scope: this guarantees every wholesaler has ONE location. It does
-- NOT build location management -- creating a second warehouse, or moving
-- stock between two, is regression #17 and is its own piece of work. No UI
-- writes v2_locations at all today.
--
-- PART B — A DESTRUCTIVE PRIVILEGE NOBODY SHOULD HOLD
-- --------------------------------------------------
-- While checking the grants on v2_locations for Part A, both browser roles
-- turned out to hold TRUNCATE on 35 tables in this schema.
--
-- TRUNCATE IS NOT SUBJECT TO ROW-LEVEL SECURITY. Row policies filter SELECT,
-- INSERT, UPDATE and DELETE. They do not apply to TRUNCATE at all -- a role
-- holding the privilege empties the whole table regardless of how carefully
-- every policy is written. v2_locations had four correct, tightly scoped
-- policies and an anon TRUNCATE grant sitting underneath them.
--
-- Honest assessment: PostgREST cannot issue a TRUNCATE, so this is not
-- reachable through the API as it stands today. It is being removed anyway,
-- because it is a privilege with no legitimate use in this application (no
-- code path truncates anything), and its blast radius is every order, every
-- product and every stock balance in the system. REFERENCES and TRIGGER go
-- with it for the same reason -- granted by a blanket GRANT ALL, wanted by
-- nothing.
--
-- SELECT / INSERT / UPDATE / DELETE are deliberately untouched here. Those are
-- load-bearing and are governed by the row policies, which do work.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- A1. Back-fill: a default location for any wholesaler that has none
-- ---------------------------------------------------------------------
-- "Main Warehouse" matches what the v1 data migration named the other four,
-- so the roster stays consistent rather than gaining one oddly-named row.
insert into wholesale_v2.v2_locations (wid, name, is_default, archived)
select w.wid, 'Main Warehouse', true, false
from wholesale_v2.v2_wholesalers w
where not exists (
  select 1 from wholesale_v2.v2_locations l
  where l.wid = w.wid and not l.archived
);

-- A wholesaler could also have locations but no DEFAULT one -- the importer
-- and every "receive" path pick the default first, so that state is just as
-- broken, only less visibly. Promote the oldest.
update wholesale_v2.v2_locations l
set is_default = true
where l.id = (
  select l2.id from wholesale_v2.v2_locations l2
  where l2.wid = l.wid and not l2.archived
  order by l2.created_at asc limit 1
)
and not exists (
  select 1 from wholesale_v2.v2_locations l3
  where l3.wid = l.wid and l3.is_default and not l3.archived
);

-- ---------------------------------------------------------------------
-- A2. Fix the function so new wholesalers are born with one
-- ---------------------------------------------------------------------
-- Recreated in full rather than patched, because CREATE OR REPLACE FUNCTION
-- replaces the whole body. Identical to migration 041 except for the single
-- v2_locations insert marked below -- diff the two if you need to be sure.
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
  -- The eight token columns below MUST be empty strings, not NULL: GoTrue
  -- scans them into Go strings and a NULL throws, surfacing to the user as
  -- "Database error querying schema" at sign-in. See migration 041.
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

  -- WITHOUT THIS ROW EMAIL+PASSWORD LOGIN SILENTLY FAILS. GoTrue looks the
  -- account up through identities; the user row alone is not enough.
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

  -- ===== THE FIX (migration 043) =====
  -- Without this row the wholesaler cannot receive a single unit of stock:
  -- v2_receive_stock requires a location id and v2_inventory_balances is
  -- keyed on it. Creating it here rather than lazily at first receive means
  -- the Inventory screen and the importer both find it already present,
  -- instead of each having to invent one and risk creating two.
  --
  -- NOT confused with v2_wholesalers.location above -- that is a free-text
  -- descriptor of where the business is ("Beirut"). This is a physical stock
  -- location that inventory rows point at.
  insert into wholesale_v2.v2_locations (wid, name, is_default, archived)
  values (v_wid, 'Main Warehouse', true, false);
  -- ===================================

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

-- ---------------------------------------------------------------------
-- B. Remove TRUNCATE / REFERENCES / TRIGGER from both browser roles
-- ---------------------------------------------------------------------
-- Applied schema-wide rather than table-by-table: the grants came from a
-- blanket GRANT ALL, so a hand-written list would drift the moment a table is
-- added. SELECT/INSERT/UPDATE/DELETE are untouched -- those are load-bearing
-- and the row policies do govern them.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass::text as obj
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'wholesale_v2' and c.relkind in ('r','p','v','m')
  loop
    execute format('revoke truncate, references, trigger on %s from anon, authenticated', r.obj);
  end loop;
end $$;

-- Stop new tables inheriting them again. Default privileges apply only to
-- objects created LATER by this role, which is why the loop above is still
-- needed for everything that already exists.
alter default privileges in schema wholesale_v2
  revoke truncate, references, trigger on tables from anon, authenticated;
