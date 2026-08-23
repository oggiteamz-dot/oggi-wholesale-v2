#!/usr/bin/env bash
# =============================================================================
# Rebuild the whole database from this repo, into an empty Postgres.  (Batch 7)
# =============================================================================
# The claim this proves: **this repo can rebuild the product.** It had been
# asserted in FEATURE-MANIFEST.md and doubted in CLAUDE.md for ten days without
# anybody running it. On 21 Aug 2026 it was run, and it stopped five separate
# times -- see checks/check_migration_chain.mjs for the full account. After
# those five fixes: 80 migrations, no errors, and the result matched production
# exactly (tables 89, views 4, functions 91, policies 89).
#
# WHAT IS STUBBED, AND WHY THAT IS HONEST
#   auth.*      -- Supabase's own auth schema. Two tables and four functions,
#                  enough for the FKs and auth.uid() calls to resolve.
#   storage.*   -- buckets, objects and the three path helpers.
#   net.*       -- pg_net's http_post.
#   pg_cron     -- absent; migration 065 now notices and moves on.
#
# None of these are added to supabase/migrations. A fresh Supabase project
# already has the real ones, and a fake sitting in the repo would silently
# shadow them -- a no-op webhook dispatcher that reports success is worse than
# a missing one that raises.
#
# USAGE
#   PGHOST=/tmp PGPORT=5433 ./checks/replay_migrations.sh
# Any Postgres 16 will do. It creates and drops a scratch database called
# oggi_replay and touches nothing else.
# =============================================================================
set -uo pipefail

PGHOST="${PGHOST:-/tmp}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
DB="${REPLAY_DB:-oggi_replay}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

psqlq() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -q "$@"; }

echo "== replaying $ROOT/supabase/migrations into $DB on $PGHOST:$PGPORT"

psqlq -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1 || {
  echo "!! could not create $DB -- is Postgres running on $PGHOST:$PGPORT?"; exit 2; }

# ---- the platform Supabase provides and this repo deliberately does not ------
psqlq -d "$DB" >/dev/null 2>&1 <<'SQL'
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create schema if not exists net;
-- pgcrypto goes in `extensions`, which is where Supabase puts it and where the
-- migrations expect gen_random_bytes()/crypt() to be. Installing it into
-- `public` first makes the second statement a silent no-op ("already exists,
-- skipping") and the chain then dies at migration 056 on a missing
-- extensions.gen_random_bytes -- which is what happened the first time this
-- script was run, and is exactly the class of "the scaffolding was subtly
-- wrong so the check lied" this file exists to avoid.
create extension if not exists pgcrypto schema extensions;

create table if not exists auth.users (
  id uuid primary key, instance_id uuid, aud text, role text, email text,
  encrypted_password text, email_confirmed_at timestamptz,
  created_at timestamptz, updated_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  is_sso_user boolean default false, is_anonymous boolean default false,
  confirmation_token text default '', recovery_token text default '',
  email_change text default '', email_change_token_new text default '',
  email_change_token_current text default '', phone_change text default '',
  phone_change_token text default '', reauthentication_token text default ''
);
create table if not exists auth.identities (
  id uuid primary key, user_id uuid references auth.users(id) on delete cascade,
  provider text, provider_id text, identity_data jsonb,
  created_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz
);
create or replace function auth.uid()   returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub','')::uuid $$;
create or replace function auth.role()  returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role','anon') $$;
create or replace function auth.email() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::jsonb ->> 'email' $$;
create or replace function auth.jwt()   returns jsonb language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb) $$;

create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text,
  owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;
create or replace function storage.filename(name text) returns text
  language sql immutable as $$ select (string_to_array(name,'/'))[array_length(string_to_array(name,'/'),1)] $$;
create or replace function storage.extension(name text) returns text
  language sql immutable as $$ select substring(name from '\.([^.]+)$') $$;

create or replace function net.http_post(url text, body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000) returns bigint language sql as $$ select 0::bigint $$;
SQL

# Supabase puts `extensions` on the database search_path; the migrations rely
# on that for unqualified crypt()/gen_random_bytes() calls.
psqlq -c "alter database $DB set search_path to public, extensions" >/dev/null 2>&1

for r in anon authenticated service_role; do
  psqlq -d "$DB" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='$r')
    then execute 'create role $r nologin'; end if; end \$\$;" >/dev/null 2>&1
done

# ---- the chain itself --------------------------------------------------------
count=0
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort -V); do
  if ! out=$(psqlq -d "$DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1); then
    echo "!! STOPPED AT $(basename "$f")"
    echo "$out" | grep -i error | head -5
    echo "   $count migration(s) applied before this one."
    exit 1
  fi
  count=$((count + 1))
done

read -r t v fn pol shape <<<"$(psqlq -d "$DB" -Atc "
  select (select count(*) from information_schema.tables where table_schema='wholesale_v2' and table_type='BASE TABLE')
      || ' ' || (select count(*) from information_schema.views  where table_schema='wholesale_v2')
      || ' ' || (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='wholesale_v2')
      || ' ' || (select count(*) from pg_policies where schemaname='wholesale_v2')
      || ' ' || (select md5(string_agg(nm, ',' order by nm)) from (
                   select c.relname as nm from pg_class c join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='wholesale_v2' and c.relkind in ('r','v','p')
                   union all
                   select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='wholesale_v2'
                 ) q)")"

echo "== $count migrations applied, no errors"
echo "   tables=$t views=$v functions=$fn policies=$pol"
echo "   shape=$shape"

# The baseline is production as measured on 21 Aug 2026. A DIFFERENCE IS NOT
# AUTOMATICALLY A FAILURE -- it means the repo and the database have diverged,
# and which one is wrong is the question worth asking. It is printed loudly
# either way rather than silently tolerated.
#
# COUNTS ARE A COARSE INSTRUMENT and this file says so rather than implying
# otherwise. Deleting migration 035 during a negative test changed NOTHING in
# these four numbers, because migration 034 creates the same two tables with
# `if not exists`. That is not the gate lying -- the objects really are all
# there -- but it does mean a count cannot answer "is every migration file
# present". checks/check_migration_chain.mjs answers that one, by numbering.
#
# `shape` is the sharper half: an md5 over every table, view and function
# SIGNATURE in the schema. A substitution that happens to preserve the counts
# still moves it.
EXP_T=89 EXP_V=4 EXP_F=94 EXP_P=89
EXP_SHAPE=7378e64d507190e6890803032ce52fbf   # production, 23 Aug 2026 (migration 079 added three functions)
if [ "$t" = "$EXP_T" ] && [ "$v" = "$EXP_V" ] && [ "$fn" = "$EXP_F" ] && [ "$pol" = "$EXP_P" ] && [ "$shape" = "$EXP_SHAPE" ]; then
  echo "   MATCHES the 23 Aug 2026 production baseline exactly, shape included."
else
  echo "   !! differs from the 23 Aug 2026 production baseline"
  echo "      expected tables=$EXP_T views=$EXP_V functions=$EXP_F policies=$EXP_P"
  echo "      Either a migration was applied to production without a file (check"
  echo "      supabase_migrations.schema_migrations against supabase/migrations/),"
  echo "      or a new migration landed here and the baseline above needs moving."
  exit 1
fi

psqlq -c "drop database if exists $DB" >/dev/null 2>&1
echo "== done"
