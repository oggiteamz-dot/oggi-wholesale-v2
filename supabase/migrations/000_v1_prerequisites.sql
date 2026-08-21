-- =====================================================================
-- 000 — what v2 needs from v1 before any v2 migration can run
--
-- THE PROBLEM THIS FIXES
-- ---------------------------------------------------------------------
-- v2 lives in its own schema, `wholesale_v2`, and looks self-contained.
-- It is not. TEN foreign keys point out of it into v1's `public` schema,
-- and several v2 functions write there directly:
--
--   v2_clients, v2_locations, v2_orders, v2_pack_definitions,
--   v2_products, v2_signup_requests, v2_suppliers, v2_visit_log,
--   v2_webhook_endpoints, v2_wholesalers
--       -> all reference public.wholesalers(wid)
--
--   v2_create_wholesaler   writes public.wholesalers AND public.profiles
--   v2_set_wholesaler_brands writes public.wholesalers
--   v2_buyer_login etc.    read/write public.login_throttle
--   migration 002         reads public.wholesale_state, public.clients
--                         and public.reps -- it IS the v1 -> v2 data
--                         migration, so the chain stops at 002 without them
--
-- No v2 migration creates any of those tables, because on the real
-- database v1 got there first. So replaying this repo into an empty
-- Postgres fails on the very first foreign key -- which is the concrete
-- reason behind the standing complaint that "the repo cannot rebuild the
-- product". Found on 21 Aug 2026 while replaying the full migration
-- chain on a clean Postgres 16.
--
-- WHAT THIS FILE IS, AND WHAT IT IS NOT
-- ---------------------------------------------------------------------
-- It is NOT v1's schema. v1 is a separate product with its own tables,
-- policies and history, and pretending otherwise would create a second,
-- lying copy of it -- the exact duplication problem this codebase keeps
-- being bitten by.
--
-- It is the MINIMUM SHAPE v2's own constraints and its v1->v2 data
-- migration require: the six tables v2 actually touches, with the columns
-- and defaults v2 actually relies on, taken from the live database on
-- 21 Aug 2026 rather than from memory.
--
-- Every statement is `if not exists`. On the real database, where v1
-- owns these tables, this file does nothing at all. On an empty
-- database it is what lets the rest of the chain run.
--
-- IF v1 AND v2 EVER PART COMPANY
-- ---------------------------------------------------------------------
-- The honest long-term fix is for v2 to stop reaching into v1: point the
-- ten foreign keys at v2_wholesalers, and have v2_create_wholesaler
-- write only v2's tables. That is a real migration with real risk (v1 is
-- live and reads those rows), so it is named here rather than smuggled
-- in. Until then this file is the truthful description of the coupling.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The one every foreign key points at.
-- ---------------------------------------------------------------------
create table if not exists public.wholesalers (
  wid         text primary key,
  brand       text not null default 'Catalog',
  name        text default 'Order Sheet',
  currency    text not null default '$',
  logo        text,
  owner_phone text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- v1's role table. v2 has its own (v2_user_profiles) and writes BOTH,
-- deliberately -- see migration 036's header: v1 security reads this one,
-- v2 reads the other, and on 17 Aug they already held 6 rows and 2 rows.
-- Writing only one produces a wholesaler that half-exists.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key,
  role       text not null default 'wholesaler',
  wid        text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Login throttling, shared between v1 and v2's buyer login.
-- ---------------------------------------------------------------------
create table if not exists public.login_throttle (
  key          text primary key,
  fails        integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);

-- ---------------------------------------------------------------------
-- v1's whole application state, as ONE json document in ONE row
-- (`id = 'main'`). Migration 002 is the v1 -> v2 data migration and reads
-- this to populate v2's real tables, so the chain cannot even reach 003
-- without it. On an empty database it stays empty and 002 simply migrates
-- nothing, which is the correct outcome: a fresh install has no v1 data.
-- ---------------------------------------------------------------------
create table if not exists public.wholesale_state (
  id         text primary key,
  doc        jsonb,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- v1's buyer and sales-rep logins. Referenced by v2's migration chain in
-- the same read-only, migrate-the-data way.
-- ---------------------------------------------------------------------
create table if not exists public.clients (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null,
  username      text not null,
  password_hash text not null,
  name          text,
  discount      numeric not null default 0,
  role          text not null default 'client',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.reps (
  id            uuid primary key default gen_random_uuid(),
  wid           text not null,
  username      text not null,
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
