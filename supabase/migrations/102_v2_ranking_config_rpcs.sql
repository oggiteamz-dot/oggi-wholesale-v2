-- =============================================================================
-- 102 — READING AND CHANGING THE RANKING NUMBERS               SR-07, 30 Aug 2026
-- =============================================================================
--
-- 101 sealed the record. This is the layer on top of it: an owner-only way to
-- read the current numbers, change one with a stated reason, read the timeline,
-- and ask what the rules were on a given day.
--
-- SEPARATE FROM 101 ON PURPOSE. The record must never be re-created -- it is
-- append-only and hash-chained, so a `create or replace` that changed its shape
-- would break every hash after it. This layer, by contrast, is ordinary
-- functions that will be rewritten several times. Keeping them apart means a
-- rework here can never reach the part that must not move.
--
-- ==== THE ONE THAT MATTERS ==================================================
--
--     v2_ranking_config_as_of(when) -- what every ranking number WAS at that
--     moment, reconstructed from the history and not from the current table.
--
-- Storage without this is a filing cabinet nobody can open. It is also the
-- acceptance test for the whole piece of work: change a number, ask what it was
-- yesterday, get yesterday's answer.
--
-- ==== THE STRUCTURAL HALF ===================================================
--
-- The Turkish remedy language this design borrows from covers "the PARAMETRIC
-- AND STRUCTURAL changes made on the algorithm models". 101 is parametric.
-- Structural means the ranking functions themselves -- v2_popular_now and
-- v2_similar_products. Git holds their history, but GIT IS NOT THE DATABASE:
-- it cannot say which version was LIVE on a given date, and the deploy that
-- made it live is a separate event from the commit that wrote it.
--
-- So: a hash of each ranking function's installed source, recorded when it
-- changes, and a gate that goes red when the live source is not the newest
-- recorded one. The snapshot function is the fix; the gate is the enforcement.
-- Nobody will remember to snapshot -- that is precisely why the gate exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. WHICH FUNCTIONS COUNT AS "THE RANKING MODEL"
-- ---------------------------------------------------------------------------
-- A table rather than a hardcoded list, for the same reason the thresholds are
-- a table: the next shelf will add to it, and a list frozen inside a function
-- is a list that silently stops covering everything.
create table if not exists wholesale_v2.v2_ranking_model (
  fn_name  text primary key,
  purpose  text not null
);

comment on table wholesale_v2.v2_ranking_model is
  'SR-07. The functions whose SOURCE counts as part of the ranking model. Anything listed here has its source hashed and recorded when it changes, and check_ranking_config_versioned.sql fails if the live source is not the newest recorded one. Add a row here when a new shelf ships.';

alter table wholesale_v2.v2_ranking_model enable row level security;
revoke all on wholesale_v2.v2_ranking_model from anon, authenticated;

insert into wholesale_v2.v2_ranking_model (fn_name, purpose) values
  ('v2_popular_now',      'RC-02. Decides what appears under "Popular right now" and in what order.'),
  ('v2_similar_products', 'RC-03. Decides what appears under "More like this" and in what order.'),
  ('v2_buy_it_again',     'RC-01. Decides what a buyer is offered to reorder and in what order.')
on conflict (fn_name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. THE STRUCTURAL RECORD
-- ---------------------------------------------------------------------------
create table if not exists wholesale_v2.v2_ranking_model_snapshot (
  id          bigint generated always as identity primary key,
  fn_name     text        not null references wholesale_v2.v2_ranking_model(fn_name),
  src_hash    text        not null,
  src_len     integer     not null,
  reason      text,
  actor_role  text        not null,
  taken_at    timestamptz not null default now()
);

create index if not exists idx_v2_rms_fn_time
  on wholesale_v2.v2_ranking_model_snapshot (fn_name, taken_at desc);

comment on table wholesale_v2.v2_ranking_model_snapshot is
  'SR-07, structural half. A hash of each ranking function''s installed source, recorded when it changes. Answers "which version of the ranker was live in March?", which git cannot answer because a commit is not a deploy.';

alter table wholesale_v2.v2_ranking_model_snapshot enable row level security;
revoke all on wholesale_v2.v2_ranking_model_snapshot from anon, authenticated;

-- Append-only, the same rule and the same reasoning as the parametric record.
create or replace function wholesale_v2.v2_rms_no_rewrite()
returns trigger language plpgsql as
$fn$ begin
  raise exception 'v2_ranking_model_snapshot is append-only: % is not permitted.', tg_op;
end $fn$;

drop trigger if exists trg_v2_rms_no_rewrite on wholesale_v2.v2_ranking_model_snapshot;
create trigger trg_v2_rms_no_rewrite
  before update or delete on wholesale_v2.v2_ranking_model_snapshot
  for each row execute function wholesale_v2.v2_rms_no_rewrite();

-- The hash of what is installed RIGHT NOW. pg_get_functiondef, not prosrc:
-- prosrc is the body alone, so a change to the argument list, the return type,
-- the volatility or the search_path -- every one of which changes what the
-- function does -- would leave the hash untouched.
create or replace function wholesale_v2.v2_ranking_model_hash(p_fn text)
returns table (src_hash text, src_len integer)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select md5(string_agg(d, chr(31) order by d)), sum(length(d))::integer
    from (select pg_get_functiondef(p.oid) as d
            from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'wholesale_v2' and p.proname = p_fn) q;
$fn$;

comment on function wholesale_v2.v2_ranking_model_hash(text) is
  'SR-07. Hashes every overload of a ranking function together, ordered, so adding an overload changes the hash. Uses pg_get_functiondef rather than prosrc: a change to the signature, return type, volatility or search_path changes behaviour and must change the hash.';

-- A function listed as part of the model but NOT installed is reported as
-- MISSING rather than recorded with a null hash, which would later read as
-- "no change since".
create or replace function wholesale_v2.v2_ranking_model_record(p_reason text default null)
returns table (fn_name text, action text, src_hash text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare r record; v_hash text; v_len integer; v_last text;
begin
  for r in select m.fn_name as fname from wholesale_v2.v2_ranking_model m order by m.fn_name
  loop
    select h.src_hash, h.src_len into v_hash, v_len
      from wholesale_v2.v2_ranking_model_hash(r.fname) h;

    if v_hash is null then
      fn_name := r.fname; action := 'MISSING — listed in v2_ranking_model but not installed';
      src_hash := null; return next; continue;
    end if;

    select s.src_hash into v_last
      from wholesale_v2.v2_ranking_model_snapshot s
     where s.fn_name = r.fname order by s.id desc limit 1;

    if v_last is not distinct from v_hash then
      fn_name := r.fname; action := 'unchanged'; src_hash := v_hash; return next;
    else
      insert into wholesale_v2.v2_ranking_model_snapshot (fn_name, src_hash, src_len, reason, actor_role)
      values (r.fname, v_hash, v_len, p_reason, current_user::text);
      fn_name := r.fname;
      action := case when v_last is null then 'first snapshot' else 'CHANGED — recorded' end;
      src_hash := v_hash; return next;
    end if;
  end loop;
end $fn$;

comment on function wholesale_v2.v2_ranking_model_record(text) is
  'SR-07. Records the current source hash of every ranking function that has changed since its last snapshot. Idempotent: running it twice records nothing the second time. Run it in any migration that changes a ranking function -- and if you forget, check_ranking_config_versioned.sql will name the function.';

-- ---------------------------------------------------------------------------
-- 3. READING THE NUMBERS
-- ---------------------------------------------------------------------------
-- Columns are qualified throughout the bodies below: the OUT parameters are
-- variables inside the function, and an unqualified column of the same name is
-- ambiguous. That trap cost an hour on migration 100.
--
-- v2_ranking_history_list collapses the four value columns into one display
-- column, because a key is either a number or a word list and a screen showing
-- four columns of which two are always blank is a screen nobody reads.
--
-- v2_ranking_config_as_of is reconstructed from the HISTORY and never from the
-- current table. Reading the current table would defeat the whole point: the
-- answer would silently become "whatever it is today" for any key that has not
-- changed since -- right by luck, and wrong the moment it mattered. Its
-- `still_true` column says whether the value it reports survives to now, so the
-- reader is not diffing two screens; and a key DELETED before that date is
-- excluded rather than reported as having had a value of null.
--
-- v2_ranking_config_set checks the owner first (here, not by hiding a button),
-- then requires a reason -- the argument already made and won for deactivating
-- a wholesaler in Batch 8A -- then refuses an unknown key outright, because a
-- typo would insert a ninth row nothing reads while the shelf went on using its
-- old value. It hands the reason to the trigger with `set local` so it cannot
-- leak into the next statement on a pooled connection and label an unrelated
-- change.
--
-- All of this is written here rather than inside the bodies deliberately: a
-- comment inside a body is copied into pg_proc, and then every path that ever
-- installs the function has to reproduce it byte-for-byte or the repo and the
-- database quietly disagree.
create or replace function wholesale_v2.v2_ranking_config_list()
returns table (
  key            text,
  int_value      integer,
  text_value     text,
  note           text,
  updated_at     timestamptz,
  last_reason    text,
  last_actor     text,
  last_source    text,
  change_count   integer
)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select c.key, c.int_value, c.text_value, c.note, c.updated_at,
         last.reason,
         coalesce(last.actor_label, last.actor_role),
         last.actor_source,
         (select count(*)::integer from wholesale_v2.v2_ranking_config_history h2
           where h2.key = c.key and h2.op <> 'baseline')
    from wholesale_v2.v2_ranking_config c
    left join lateral (
      select h.reason, h.actor_label, h.actor_role, h.actor_source
        from wholesale_v2.v2_ranking_config_history h
       where h.key = c.key order by h.id desc limit 1
    ) last on true
   where wholesale_v2.v2_is_owner()
   order by c.key;
$fn$;

comment on function wholesale_v2.v2_ranking_config_list() is
  'SR-07. The ranking numbers as they stand, with who last touched each and why. Owner only -- the where clause returns zero rows to anyone else rather than raising, so a non-owner learns nothing about what keys exist.';

create or replace function wholesale_v2.v2_ranking_history_list(
  p_key text default null, p_limit integer default 200)
returns table (
  id           bigint,
  key          text,
  op           text,
  old_value    text,
  new_value    text,
  reason       text,
  actor        text,
  actor_source text,
  changed_at   timestamptz
)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select h.id, h.key, h.op,
         coalesce(h.old_int::text, h.old_text),
         coalesce(h.new_int::text, h.new_text),
         h.reason,
         coalesce(h.actor_label, h.actor_role),
         h.actor_source,
         h.changed_at
    from wholesale_v2.v2_ranking_config_history h
   where wholesale_v2.v2_is_owner()
     and (p_key is null or h.key = p_key)
   order by h.id desc
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;

comment on function wholesale_v2.v2_ranking_history_list(text, integer) is
  'SR-07. The timeline of ranking changes, newest first. Owner only.';

-- ---------------------------------------------------------------------------
-- 4. THE QUESTION THIS WHOLE THING EXISTS TO ANSWER
-- ---------------------------------------------------------------------------
create or replace function wholesale_v2.v2_ranking_config_as_of(p_when timestamptz)
returns table (
  key         text,
  int_value   integer,
  text_value  text,
  note        text,
  as_of_event timestamptz,
  still_true  boolean
)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select q.h_key, q.h_int, q.h_text, q.h_note, q.h_when,
         not exists (
           select 1 from wholesale_v2.v2_ranking_config_history later
            where later.key = q.h_key and later.changed_at > q.h_when
              and later.id > q.h_id)
    from (
      select distinct on (h.key)
             h.key as h_key, h.id as h_id,
             case when h.op = 'delete' then null else h.new_int  end as h_int,
             case when h.op = 'delete' then null else h.new_text end as h_text,
             case when h.op = 'delete' then null else h.new_note end as h_note,
             h.changed_at as h_when,
             h.op as h_op
        from wholesale_v2.v2_ranking_config_history h
       where h.changed_at <= p_when
       order by h.key, h.changed_at desc, h.id desc
    ) q
   where wholesale_v2.v2_is_owner()
     and q.h_op <> 'delete'
   order by q.h_key;
$fn$;

comment on function wholesale_v2.v2_ranking_config_as_of(timestamptz) is
  'SR-07. What every ranking number WAS at that moment, rebuilt from the history and never from the current table. This is the answer to "what were the rules on the day you say I was demoted?" -- the only question this record exists to answer. Owner only.';

-- ---------------------------------------------------------------------------
-- 5. CHANGING A NUMBER
-- ---------------------------------------------------------------------------
create or replace function wholesale_v2.v2_ranking_config_set(
  p_key    text,
  p_int    integer,
  p_text   text,
  p_reason text)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_cur wholesale_v2.v2_ranking_config%rowtype;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can change a ranking number'; return;
  end if;

  if coalesce(length(trim(p_reason)), 0) < 5 then
    return query select false,
      'Say why this is changing — it goes into the permanent record, and an entry with no reason is one nobody can explain later.';
    return;
  end if;

  select * into v_cur from wholesale_v2.v2_ranking_config c where c.key = p_key;
  if not found then
    return query select false, format(
      'There is no ranking setting called "%s". Nothing was changed.', p_key);
    return;
  end if;

  if v_cur.int_value is not null and p_int is null then
    return query select false, format('"%s" is a number and a number is required.', p_key); return;
  end if;
  if v_cur.text_value is not null and coalesce(trim(p_text),'') = '' then
    return query select false, format('"%s" is a list of words and cannot be emptied.', p_key); return;
  end if;
  if v_cur.int_value is not null and p_int < 0 then
    return query select false, 'A ranking number cannot be negative.'; return;
  end if;

  if v_cur.int_value is not distinct from p_int
     and v_cur.text_value is not distinct from coalesce(p_text, v_cur.text_value) then
    return query select true, 'That is already the value — nothing was recorded.'; return;
  end if;

  perform set_config('wholesale_v2.change_reason', trim(p_reason), true);

  update wholesale_v2.v2_ranking_config c
     set int_value  = case when c.int_value  is not null then p_int else c.int_value end,
         text_value = case when c.text_value is not null then coalesce(p_text, c.text_value) else c.text_value end,
         updated_at = now()
   where c.key = p_key;

  return query select true, format('"%s" updated and recorded.', p_key);
end $fn$;

comment on function wholesale_v2.v2_ranking_config_set(text, integer, text, text) is
  'SR-07. The owner changes a ranking number and must say why. Refuses an unknown key outright -- a typo that silently created a ninth row would leave the shelf reading its old value with a plausible-looking config row beside it. The recording is done by the trigger from 101, not here, so a change made any other way is recorded identically.';

-- ---------------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------------
-- Every one of these is owner-gated INSIDE the function, so execute is granted
-- to the signed-in role and the answer to a non-owner is zero rows or a refusal
-- -- never an error that confirms what exists. `anon` gets none of them: an
-- owner is always a signed-in Supabase Auth user, so there is no path that
-- needs the signed-out role.
revoke all on function wholesale_v2.v2_ranking_config_list() from public;
revoke all on function wholesale_v2.v2_ranking_history_list(text, integer) from public;
revoke all on function wholesale_v2.v2_ranking_config_as_of(timestamptz) from public;
revoke all on function wholesale_v2.v2_ranking_config_set(text, integer, text, text) from public;
revoke all on function wholesale_v2.v2_ranking_history_verify() from public;
revoke all on function wholesale_v2.v2_ranking_model_record(text) from public;
revoke all on function wholesale_v2.v2_ranking_model_hash(text) from public;

grant execute on function wholesale_v2.v2_ranking_config_list() to authenticated;
grant execute on function wholesale_v2.v2_ranking_history_list(text, integer) to authenticated;
grant execute on function wholesale_v2.v2_ranking_config_as_of(timestamptz) to authenticated;
grant execute on function wholesale_v2.v2_ranking_config_set(text, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE FIRST STRUCTURAL SNAPSHOT
-- ---------------------------------------------------------------------------
select * from wholesale_v2.v2_ranking_model_record(
  'First snapshot, taken at install (migration 102). This is the ranking model as it stood when the structural record began, not a change.');

-- =============================================================================
-- SELF-ASSERTING. Every assertion holds on an EMPTY database as well as a full
-- one: the reconstruction tests below build their own history rows inside a
-- key that this migration creates and removes, so they do not depend on any
-- production data existing.
-- =============================================================================
do $$
declare n int; v_ok boolean; v_msg text; v_int int;
begin
  -- 1. The browser roles hold no table key on either new table.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2'
     and table_name in ('v2_ranking_model','v2_ranking_model_snapshot')
     and grantee in ('anon','authenticated','PUBLIC');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: the browser roles hold % grant(s) on the structural record', n; end if;

  -- 2. anon can execute NONE of these. The owner is always signed in; a
  --    signed-out caller has no business reaching any of it.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee='anon'
     and routine_name in ('v2_ranking_config_list','v2_ranking_history_list',
                          'v2_ranking_config_as_of','v2_ranking_config_set',
                          'v2_ranking_history_verify','v2_ranking_model_record');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: anon can execute % of the ranking functions', n; end if;

  -- 3. Every function named in the model is actually installed. A model list
  --    naming something that does not exist would make the gate below green
  --    for a function nobody is watching.
  select count(*) into n from wholesale_v2.v2_ranking_model m
   where not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                      where ns.nspname='wholesale_v2' and p.proname = m.fn_name);
  if n <> 0 then raise exception 'ASSERT 3 FAILED: % function(s) listed in the ranking model are not installed', n; end if;

  -- 4. Every function in the model has a snapshot, and it matches what is
  --    installed right now.
  select count(*) into n from wholesale_v2.v2_ranking_model m
   where (select s.src_hash from wholesale_v2.v2_ranking_model_snapshot s
           where s.fn_name = m.fn_name order by s.id desc limit 1)
         is distinct from (select h.src_hash from wholesale_v2.v2_ranking_model_hash(m.fn_name) h);
  if n <> 0 then raise exception 'ASSERT 4 FAILED: % ranking function(s) do not match their newest snapshot at install', n; end if;

  -- 5. Recording twice records nothing the second time. An audit that grows a
  --    row every time it is run is an audit whose row count means nothing.
  select count(*) into n from wholesale_v2.v2_ranking_model_snapshot;
  perform wholesale_v2.v2_ranking_model_record('idempotency check');
  select count(*) - n into n from wholesale_v2.v2_ranking_model_snapshot;
  if n <> 0 then raise exception 'ASSERT 5 FAILED: taking the same snapshot twice added % row(s)', n; end if;

  -- 6. THE STRUCTURAL RECORD CANNOT BE REWRITTEN.
  begin
    update wholesale_v2.v2_ranking_model_snapshot set src_hash = 'tampered'
     where id = (select min(id) from wholesale_v2.v2_ranking_model_snapshot);
    raise exception 'ASSERT 6 FAILED: the structural record accepted an UPDATE';
  exception
    when sqlstate 'P0001' then
      if sqlerrm like 'ASSERT 6 FAILED%' then raise; end if;   -- our own, re-raise
  end;

  -- 7. A NON-OWNER SEES NOTHING. Run as postgres, v2_is_owner() is false
  --    (there is no jwt), so every reader must return zero rows and the writer
  --    must refuse. This is the check that would have caught an owner gate
  --    written as a comment.
  select count(*) into n from wholesale_v2.v2_ranking_config_list();
  if n <> 0 then raise exception 'ASSERT 7 FAILED: a caller who is not the owner listed % ranking number(s)', n; end if;
  select count(*) into n from wholesale_v2.v2_ranking_history_list(null, 10);
  if n <> 0 then raise exception 'ASSERT 7 FAILED: a caller who is not the owner read % history row(s)', n; end if;
  select count(*) into n from wholesale_v2.v2_ranking_config_as_of(now());
  if n <> 0 then raise exception 'ASSERT 7 FAILED: a caller who is not the owner reconstructed % row(s)', n; end if;
  select s.ok, s.message into v_ok, v_msg from wholesale_v2.v2_ranking_config_set('popular_min_buyers', 4, null, 'assertion') s;
  if v_ok then raise exception 'ASSERT 7 FAILED: a caller who is not the owner changed a ranking number'; end if;

  -- 8. And the refusal did not change anything.
  select c.int_value into v_int from wholesale_v2.v2_ranking_config c where c.key='popular_min_buyers';
  if v_int is distinct from 3 then
    raise exception 'ASSERT 8 FAILED: the refused change was applied anyway (popular_min_buyers is now %)', v_int; end if;

  raise notice '102 OK: owner-only reads, an owner-only write that requires a reason, an as-of reconstruction built from the history, and a structural record of the ranking functions themselves.';
end $$;
