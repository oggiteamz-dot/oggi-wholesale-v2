-- =============================================================================
-- 101 — THE RANKING RECORD                                    SR-07, 30 Aug 2026
-- =============================================================================
--
-- Eight numbers in v2_ranking_config decide what the recommendation shelves
-- show: how many different shops make something "popular", how far back to
-- look, how many rows to return, how many words two product names must share.
--
-- Today any of them can be changed and NOTHING RECORDS THAT IT HAPPENED.
-- `updated_at` is overwritten in place: it tells you a change occurred and
-- destroys the evidence of what the value was. A shelf can start behaving
-- differently on a Tuesday and by Friday nobody can say why.
--
-- ==== WHY THIS IS WORTH A MIGRATION ========================================
--
-- Not compliance. The 28 August research settled that: the EU DMA does not
-- apply, P2B probably does not, and Lebanon's competition authority was never
-- established. Turkey's Trendyol decision binds Trendyol.
--
-- It is worth building because SR-06 -- the visibility mirror -- already tells
-- a wholesaler where they ranked and who outranked them. SR-06 WITHOUT SR-07
-- IS A CLAIM WITH NO EVIDENCE BEHIND IT. The first supplier who disputes their
-- position will ask what the rules were that day, and today the honest answer
-- is "we don't know". The exposure that actually reaches a company this size is
-- not competition law, it is ordinary misrepresentation: telling wholesalers
-- ranking is neutral while being unable to show it.
--
-- The shape is borrowed from the Turkish Competition Board's remedy language,
-- which is the best-drafted description of this requirement anywhere in the
-- record -- "keeping the PARAMETRIC AND STRUCTURAL changes made on the
-- algorithm models used for product ranking ... in a VERSIONED AND ACCURATE
-- manner". This migration is the parametric half. Migration 102 is the
-- structural half, because a parameter history sitting beside a quietly
-- rewritten ranking function is a record that misleads by omission.
--
-- ==== THE DECISION THAT SHAPES EVERYTHING ELSE =============================
--
--     THE RECORDER IS A TRIGGER, NOT THE APPLICATION.
--
-- NOTHING IN THE APPLICATION WRITES TO v2_ranking_config. There is no screen,
-- no RPC, no code path -- checked across all 102 migrations and the whole js/
-- tree. Every change ever made to those eight numbers was made by hand in the
-- Supabase SQL editor, and that is exactly the path an application-level audit
-- cannot see. An audit that only records what the app does would, today,
-- record nothing at all while looking entirely healthy.
--
-- This is the fourth of the five classic ways a hash-chained audit trail fails
-- ("capturing changes only in the application"). The other four are designed
-- against below: no updates to audit rows (assertion 3), no unstable data in
-- the hash (fixed columns, explicit separator, explicit null marker), context
-- hashed as well as payload (actor and timestamp are inside the hash), and no
-- NULL prev_hash inside a chain (a documented genesis constant instead).
--
-- ==== WHAT IS DELIBERATELY NOT HERE ========================================
--
-- 1. NO BEHAVIOURAL SELF-TEST. Every other migration in this repo proves
--    itself by doing the thing and checking the result. This one must not:
--    the table it creates is an APPEND-ONLY EVIDENCE RECORD, and an installer
--    that seeds it with three fabricated changes to prove the trigger works
--    has damaged the thing it was verifying. Structure is asserted here;
--    BEHAVIOUR is asserted by checks/check_ranking_config_versioned.sql, which
--    runs inside a transaction it rolls back. That gate is also runnable
--    against production for the same reason.
--
-- 2. NO RETENTION JOB. Nothing here deletes anything, ever. Three years is a
--    floor in somebody else's jurisdiction, not a ceiling, and a scheduled
--    deletion is a way to lose evidence on a timetable.
--
-- ==== THE HONEST LIMIT =====================================================
--
-- A superuser can `alter table ... disable trigger`, edit, and re-enable.
-- Nothing inside Postgres prevents the owner of a database doing that. The
-- hash chain does not prevent it either -- it makes it DETECTABLE, because the
-- next row appended will chain onto a head that no longer recomputes. That is
-- the honest ceiling and claiming more would be an overclaim.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE RECORD
-- ---------------------------------------------------------------------------
-- Values are stored TYPED and side by side -- old_int/new_int, old_text/
-- new_text -- rather than as a generic jsonb blob. The reason is the one
-- question this table exists to answer: "what was every ranking number on
-- 4 March?". Out of typed columns that is a one-line query. Out of jsonb it is
-- a fragile query nobody will get right under pressure, which is how this class
-- of feature quietly stops working.
create table if not exists wholesale_v2.v2_ranking_config_history (
  id           bigint generated always as identity primary key,
  key          text        not null,
  op           text        not null,      -- baseline | insert | update | delete
  old_int      integer,
  new_int      integer,
  old_text     text,
  new_text     text,
  old_note     text,
  new_note     text,
  reason       text,                      -- required on the app path, absent on the database path
  actor_id     uuid,                      -- auth.uid() -- real for anything done in the app
  actor_role   text        not null,      -- current_user -- 'postgres' for a dashboard edit
  actor_label  text,                      -- the human name, when we have one
  actor_source text        not null,      -- 'app' | 'database'
  changed_at   timestamptz not null default now(),
  prev_hash    text        not null,
  row_hash     text        not null,
  constraint v2_rch_op_check
    check (op in ('baseline','insert','update','delete')),
  constraint v2_rch_source_check
    check (actor_source in ('app','database')),
  -- A row claiming to come from the app must name who. Without this the
  -- honest-blank rule below is unenforceable: anything could claim 'app'.
  constraint v2_rch_app_has_actor
    check (actor_source <> 'app' or actor_id is not null)
);

create index if not exists idx_v2_rch_key_time
  on wholesale_v2.v2_ranking_config_history (key, changed_at desc);
create index if not exists idx_v2_rch_time
  on wholesale_v2.v2_ranking_config_history (changed_at desc);

comment on table wholesale_v2.v2_ranking_config_history is
  'SR-07. Every change ever made to a ranking number, with who made it and what it was before. Append-only and hash-chained. Written by a trigger on v2_ranking_config so that a change made in the Supabase SQL editor is recorded exactly as a change made in the app -- which matters, because today the SQL editor is the ONLY writer. Never deleted from, never updated. Read through v2_ranking_history_list() and v2_ranking_config_as_of().';

alter table wholesale_v2.v2_ranking_config_history enable row level security;
-- No policy and no grant, the same posture as v2_ranking_config itself. Gate S7:
-- anon holds no key to any table in this schema, and 098 is the migration that
-- had to learn it the hard way. `authenticated` is revoked here too, explicitly,
-- because the schema's standing default privileges would otherwise hand this
-- table to every signed-in user the moment it was created.
revoke all on wholesale_v2.v2_ranking_config_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE HASH CHAIN
-- ---------------------------------------------------------------------------
-- Canonical string, explicit separator, explicit null marker. Nulls and empty
-- strings must not hash alike, or "the note was cleared" and "the note was
-- never set" become the same event.
-- The canonical string uses U+001F UNIT SEPARATOR between fields and U+001E
-- RECORD SEPARATOR inside the null marker. Both are control characters; neither
-- can be typed into a note or a reason by accident, so no real value can
-- imitate a null. (chr(0) would be the obvious marker and Postgres refuses it
-- outright: "null character not permitted".)
--
-- The timestamp goes in via to_char and NOT ::text, because the text cast of a
-- timestamptz depends on the session's DateStyle and TimeZone -- two sessions
-- would hash the same instant differently. That is "hashing unstable data", the
-- second named failure mode of this design.
--
-- These notes live here rather than inside the body on purpose: a comment
-- inside a function body is copied into pg_proc, and then every path that ever
-- installs the function has to reproduce it byte-for-byte or the repo and the
-- database quietly disagree. That already happened once tonight.
create or replace function wholesale_v2.v2_rch_canonical(
  p_id bigint, p_key text, p_op text,
  p_old_int integer, p_new_int integer,
  p_old_text text, p_new_text text,
  p_old_note text, p_new_note text,
  p_reason text, p_actor_id uuid, p_actor_role text,
  p_actor_source text, p_changed_at timestamptz, p_prev_hash text)
returns text
language sql immutable
set search_path = wholesale_v2, public
as $fn$
  select concat_ws(chr(31),
    p_id::text,
    coalesce(p_key,          chr(30)||'NULL'),
    coalesce(p_op,           chr(30)||'NULL'),
    coalesce(p_old_int::text,chr(30)||'NULL'),
    coalesce(p_new_int::text,chr(30)||'NULL'),
    coalesce(p_old_text,     chr(30)||'NULL'),
    coalesce(p_new_text,     chr(30)||'NULL'),
    coalesce(p_old_note,     chr(30)||'NULL'),
    coalesce(p_new_note,     chr(30)||'NULL'),
    coalesce(p_reason,       chr(30)||'NULL'),
    coalesce(p_actor_id::text, chr(30)||'NULL'),
    coalesce(p_actor_role,   chr(30)||'NULL'),
    coalesce(p_actor_source, chr(30)||'NULL'),
    to_char(p_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(p_prev_hash,    chr(30)||'NULL'))
$fn$;

comment on function wholesale_v2.v2_rch_canonical(bigint,text,text,integer,integer,text,text,text,text,text,uuid,text,text,timestamptz,text) is
  'SR-07. The exact string that gets hashed for one history row. Context (actor, time) is inside the hash as well as the payload -- hashing only the payload is a named failure mode, because it lets the actor be rewritten without breaking the chain.';

-- The genesis constant. A documented value, never NULL: "allowing NULLs for
-- prev_hash inside a chain without a clear rule" is the fifth named failure
-- mode, and a nullable link is indistinguishable from a severed one.
create or replace function wholesale_v2.v2_rch_genesis()
returns text language sql immutable as
$fn$ select md5('wholesale_v2.v2_ranking_config_history/genesis/2026-08-30') $fn$;

-- The advisory lock serialises appends. Two transactions that both read the
-- chain head before either inserts would FORK the chain -- the specific
-- concurrency failure of every naive hash-chained audit. A transaction-scoped
-- lock is released automatically at commit or rollback.
create or replace function wholesale_v2.v2_rch_chain()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('wholesale_v2.v2_ranking_config_history'));

  select h.row_hash into v_prev
    from wholesale_v2.v2_ranking_config_history h
   order by h.id desc limit 1;

  new.prev_hash := coalesce(v_prev, wholesale_v2.v2_rch_genesis());
  new.row_hash  := md5(wholesale_v2.v2_rch_canonical(
      new.id, new.key, new.op, new.old_int, new.new_int,
      new.old_text, new.new_text, new.old_note, new.new_note,
      new.reason, new.actor_id, new.actor_role, new.actor_source,
      new.changed_at, new.prev_hash));
  return new;
end $fn$;

drop trigger if exists trg_v2_rch_chain on wholesale_v2.v2_ranking_config_history;
create trigger trg_v2_rch_chain
  before insert on wholesale_v2.v2_ranking_config_history
  for each row execute function wholesale_v2.v2_rch_chain();

-- ---------------------------------------------------------------------------
-- 3. APPEND-ONLY, ENFORCED
-- ---------------------------------------------------------------------------
-- "Allowing updates to audit rows" is the first named failure mode. A rule that
-- lives only in a comment is a rule that will be broken by the person who never
-- read the comment.
create or replace function wholesale_v2.v2_rch_no_rewrite()
returns trigger
language plpgsql
as $fn$
begin
  raise exception
    'v2_ranking_config_history is append-only: % is not permitted. This table exists to be evidence; a row that can be changed after the fact is not evidence. If a row is wrong, append a correcting row.',
    tg_op;
end $fn$;

drop trigger if exists trg_v2_rch_no_rewrite on wholesale_v2.v2_ranking_config_history;
create trigger trg_v2_rch_no_rewrite
  before update or delete on wholesale_v2.v2_ranking_config_history
  for each row execute function wholesale_v2.v2_rch_no_rewrite();

-- Belt as well as braces: the trigger stops the statement, the missing grant
-- stops it reaching the trigger. Neither alone is enough -- a future
-- `alter table ... disable trigger` leaves only the grant, and a future
-- `grant` leaves only the trigger.
revoke update, delete, truncate on wholesale_v2.v2_ranking_config_history
  from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 4. WHO DID IT
-- ---------------------------------------------------------------------------
-- Guarded, because request.jwt.claims is an EMPTY STRING rather than absent in
-- a plain psql session, and `''::jsonb` raises "invalid input syntax for type
-- json". That exact error is why check_bulk_price_safety.sql cannot run on a
-- bare replay today -- the same trap, one gate earlier.
-- Malformed claims are swallowed and answered with null. They mean "we do not
-- know who this was", which is exactly what null already says, and they are not
-- an error worth failing a ranking change over.
create or replace function wholesale_v2.v2_rch_actor_uid()
returns uuid
language plpgsql stable
set search_path = wholesale_v2, public
as $fn$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  if v is null then return null; end if;
  return (v::jsonb ->> 'sub')::uuid;
exception when others then
  return null;
end $fn$;

-- The reason for a change, set by the write RPC with `set local`. A trigger
-- cannot demand one -- refusing the write would mean the audit breaks the very
-- thing it audits -- so the app path requires it and the database path records
-- its absence honestly.
create or replace function wholesale_v2.v2_rch_reason()
returns text
language plpgsql stable
set search_path = wholesale_v2, public
as $fn$
begin
  return nullif(current_setting('wholesale_v2.change_reason', true), '');
exception when others then
  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. THE RECORDER
-- ---------------------------------------------------------------------------
-- An UPDATE that changed nothing anyone cares about is NOT an event, and the
-- first branch of the body drops it. Without that, a touch of updated_at fills
-- the record with rows saying a number changed to itself, and a timeline nobody
-- can read is the same thing as not having one.
create or replace function wholesale_v2.v2_ranking_config_record()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_uid    uuid   := wholesale_v2.v2_rch_actor_uid();
  v_label  text;
  v_op     text;
begin
  if tg_op = 'UPDATE'
     and new.int_value is not distinct from old.int_value
     and new.text_value is not distinct from old.text_value
     and new.note is not distinct from old.note then
    return null;
  end if;

  v_op := lower(tg_op);

  if v_uid is not null then
    select p.actor_label into v_label
      from wholesale_v2.v2_user_profiles p where p.id = v_uid;
  end if;

  insert into wholesale_v2.v2_ranking_config_history
    (key, op, old_int, new_int, old_text, new_text, old_note, new_note,
     reason, actor_id, actor_role, actor_label, actor_source)
  values (
    coalesce(new.key, old.key),
    v_op,
    case when tg_op in ('UPDATE','DELETE') then old.int_value  end,
    case when tg_op in ('UPDATE','INSERT') then new.int_value  end,
    case when tg_op in ('UPDATE','DELETE') then old.text_value end,
    case when tg_op in ('UPDATE','INSERT') then new.text_value end,
    case when tg_op in ('UPDATE','DELETE') then old.note       end,
    case when tg_op in ('UPDATE','INSERT') then new.note       end,
    wholesale_v2.v2_rch_reason(),
    v_uid,
    current_user::text,
    v_label,
    case when v_uid is not null then 'app' else 'database' end);

  return null;
end $fn$;

comment on function wholesale_v2.v2_ranking_config_record() is
  'SR-07. Records every change to a ranking number, whatever made it -- the app, a migration, or a hand-typed statement in the Supabase SQL editor. A no-op UPDATE is not recorded, so the timeline stays readable.';

drop trigger if exists trg_v2_ranking_config_record on wholesale_v2.v2_ranking_config;
create trigger trg_v2_ranking_config_record
  after insert or update or delete on wholesale_v2.v2_ranking_config
  for each row execute function wholesale_v2.v2_ranking_config_record();

-- ---------------------------------------------------------------------------
-- 6. THE BASELINE
-- ---------------------------------------------------------------------------
-- Without this the history begins mid-story: an as-of query for any date before
-- the first CHANGE returns nothing, which reads as "there were no rules" rather
-- than "the rules were these and nobody had touched them".
--
-- `where not exists` over the whole table, not per key: re-running this
-- migration after real changes have been recorded must not append a second set
-- of baselines dated today claiming to be the beginning.
insert into wholesale_v2.v2_ranking_config_history
  (key, op, new_int, new_text, new_note, reason, actor_role, actor_source, changed_at)
select c.key, 'baseline', c.int_value, c.text_value, c.note,
       'Recorded at install (migration 101). This is the value as it stood when the record began, not a change.',
       current_user::text, 'database', c.updated_at
  from wholesale_v2.v2_ranking_config c
 where not exists (select 1 from wholesale_v2.v2_ranking_config_history)
 order by c.updated_at, c.key;

-- ---------------------------------------------------------------------------
-- 7. VERIFY THE CHAIN
-- ---------------------------------------------------------------------------
-- Returns nothing when the record is intact. Returns the first row that does
-- not recompute, and every row after it, when it is not.
-- The walk continues from what each row ACTUALLY stores, not from what it
-- should have stored. Otherwise one altered row reports as every row after it
-- being broken too, and the real culprit is buried in the noise.
create or replace function wholesale_v2.v2_ranking_history_verify()
returns table (bad_id bigint, bad_key text, problem text)
language plpgsql stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare r record; v_expected_prev text := wholesale_v2.v2_rch_genesis(); v_hash text;
begin
  for r in
    select * from wholesale_v2.v2_ranking_config_history order by id
  loop
    if r.prev_hash is distinct from v_expected_prev then
      bad_id := r.id; bad_key := r.key;
      problem := format('link broken: this row points at %s but the row before it hashes to %s',
                        left(r.prev_hash,12), left(v_expected_prev,12));
      return next;
    end if;

    v_hash := md5(wholesale_v2.v2_rch_canonical(
        r.id, r.key, r.op, r.old_int, r.new_int, r.old_text, r.new_text,
        r.old_note, r.new_note, r.reason, r.actor_id, r.actor_role,
        r.actor_source, r.changed_at, r.prev_hash));

    if v_hash is distinct from r.row_hash then
      bad_id := r.id; bad_key := r.key;
      problem := format('content altered: the row recomputes to %s but stores %s',
                        left(v_hash,12), left(r.row_hash,12));
      return next;
    end if;

    v_expected_prev := r.row_hash;
  end loop;
end $fn$;

comment on function wholesale_v2.v2_ranking_history_verify() is
  'SR-07. Recomputes the whole hash chain and names the first row that does not link or does not recompute. Silence means the record is intact. This is what makes the record evidence rather than a diary: a superuser CAN edit it, and this is how you find out that they did.';

-- =============================================================================
-- SELF-ASSERTING — structure only, on purpose (see the header). Every assertion
-- below holds on an EMPTY database as well as a full one: nothing here counts
-- rows against an absolute number, it asserts RELATIONSHIPS. That is the lesson
-- 097 taught by stopping the replay dead on an assertion that only held where
-- production data happened to be.
-- =============================================================================
do $$
declare n int; m int;
begin
  -- 1. The record exists and is closed to the browser roles.
  select count(*) into n from information_schema.tables
   where table_schema='wholesale_v2' and table_name='v2_ranking_config_history';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: the history table does not exist'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_ranking_config_history'
     and grantee in ('anon','authenticated','PUBLIC');
  if n <> 0 then
    raise exception 'ASSERT 1 FAILED: the browser roles hold % grant(s) on the ranking history -- the schema''s default privileges hand every new table to `authenticated` unless a migration takes it back, which is what 098 discovered', n;
  end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_ranking_config_history'
     and c.relrowsecurity;
  if n <> 1 then raise exception 'ASSERT 1 FAILED: row security is not enabled on the ranking history'; end if;

  -- 2. THE RECORDER IS ON THE CONFIG TABLE. This is the whole design: an audit
  --    written by the application would today record nothing, because the
  --    application does not write to this table at all.
  select count(*) into n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_ranking_config'
     and t.tgname='trg_v2_ranking_config_record' and not t.tgisinternal;
  if n <> 1 then
    raise exception 'ASSERT 2 FAILED: nothing is recording changes to the ranking config'; end if;

  -- ... and it fires on all three operations. A recorder that catches updates
  -- and not deletes loses the one event that removes a rule entirely.
  if (select tgtype::int & 28 from pg_trigger t
        join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
       where ns.nspname='wholesale_v2' and c.relname='v2_ranking_config'
         and t.tgname='trg_v2_ranking_config_record') <> 28 then
    raise exception 'ASSERT 2 FAILED: the recorder does not fire on all of insert, update and delete';
  end if;

  -- 3. APPEND-ONLY IS ENFORCED, not merely intended.
  select count(*) into n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_ranking_config_history'
     and t.tgname='trg_v2_rch_no_rewrite' and not t.tgisinternal;
  if n <> 1 then raise exception 'ASSERT 3 FAILED: the history can be rewritten'; end if;

  select count(*) into n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_ranking_config_history'
     and t.tgname='trg_v2_rch_chain' and not t.tgisinternal;
  if n <> 1 then raise exception 'ASSERT 3 FAILED: the chain is not being written'; end if;

  -- 4. EVERY CONFIG KEY HAS A STARTING POINT. Stated as a relationship, so it
  --    is true of eight keys and true of none.
  select count(*) into n from wholesale_v2.v2_ranking_config;
  select count(distinct key) into m from wholesale_v2.v2_ranking_config_history;
  if m < n then
    raise exception 'ASSERT 4 FAILED: % ranking key(s) have no history at all -- an as-of query before the first change would report that they never existed', n - m;
  end if;

  -- 5. THE CHAIN IS INTACT AS INSTALLED. If the baseline rows themselves do not
  --    verify, nothing built on top of them is worth anything.
  select count(*) into n from wholesale_v2.v2_ranking_history_verify();
  if n <> 0 then
    raise exception 'ASSERT 5 FAILED: the hash chain does not verify at install (% problem rows)', n; end if;

  -- 6. NO NULL LINKS. The genesis row uses a constant; every other row points
  --    at a real predecessor. A nullable link is indistinguishable from a
  --    severed one.
  select count(*) into n from wholesale_v2.v2_ranking_config_history
   where prev_hash is null or row_hash is null;
  if n <> 0 then raise exception 'ASSERT 6 FAILED: % history row(s) have a null link', n; end if;

  raise notice '101 OK: every change to a ranking number is now recorded by a trigger, chained, and impossible to rewrite in place. Behaviour is proven by checks/check_ranking_config_versioned.sql, deliberately not by this migration -- an evidence table must not be seeded with fabricated events by its own installer.';
end $$;
