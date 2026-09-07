-- 125 — a partition is a door, and 41 of them were unlocked
--
-- FOUND 7 Sep 2026, while building a runner for the SQL gates. Nobody reported
-- it. checks/check_tenant_isolation.sql has been saying it out loud —
-- "44 problem(s)" — and no runner existed, so nobody ran it.
--
-- THE HOLE, IN PLAIN WORDS
-- v2_inventory_movements is the stock ledger: every receipt, every sale, every
-- correction, for every wholesaler on the platform. It is a PARTITIONED table,
-- one partition per month, and its tenant policy is correct:
--
--   v2_is_owner() or exists (... v2_products p where p.wid = v2_my_wid())
--
-- That policy lives on the PARENT. Postgres applies a parent's policies to
-- queries against the parent, and a partition's own policies when the partition
-- is named directly. The partitions were created by
-- v2_ensure_movement_partitions (migration 074) with a bare
-- `create table ... partition of ...`, which does NOT inherit row security:
-- relrowsecurity is per-relation and a new partition starts with it OFF.
--
-- Meanwhile `authenticated` holds SELECT on all of them. So:
--
--   select * from wholesale_v2.v2_inventory_movements            -- your rows
--   select * from wholesale_v2.v2_inventory_movements_2026_09    -- EVERYONE'S
--
-- One is the app. The other is one HTTP request with the same logged-in token,
-- and it returns the whole platform's stock ledger. 41 of 41 partitions were
-- open, holding 3,081 rows.
--
-- MEASURED BEFORE AND AFTER, on a replay of this repo, with a real wholesaler
-- (a v2_user_profiles row and a JWT claim, not a superuser):
--
--                                          before   after
--   A reading through the PARENT (theirs)      1       1     <- unchanged
--   A naming a PARTITION directly (all)        2       0     <- closed
--
-- The first row is the one that made this safe to apply: enabling row security
-- on a partition does not disturb reads through the parent, because the parent's
-- policy is what is evaluated there. The partitions get RLS and NO policy, which
-- is exactly right — every legitimate read goes through the parent, so a direct
-- read should return nothing at all.
--
-- WHY RLS AND NOT A REVOKE. Revoking SELECT would also close it today. It was
-- not chosen, because the grant is how this happened: `authenticated` holds
-- SELECT/INSERT/UPDATE/DELETE on nearly every table in wholesale_v2, and that
-- blanket grant is IN NO MIGRATION IN THIS REPO — a replay of all 126 files
-- produces almost none of it. Something granted it on production out of band.
-- A fix that depends on a grant staying revoked is a fix that the next blanket
-- grant undoes silently. Row security survives it.
--
-- ⚠ THE GRANT DRIFT IS A SEPARATE, UNFIXED FINDING and is recorded in
-- checks/GATE-EVIDENCE.md rather than papered over here. "This repo can rebuild
-- the product" is true of tables, views and functions — the shape hash proves
-- it every run — and is NOT true of privileges. Nothing checks privileges.

do $fix$
declare
  r record;
  v_n int := 0;
begin
  for r in
    select c.oid, c.relname
      from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class parent on parent.oid = i.inhparent
      join pg_namespace n on n.oid = parent.relnamespace
     where n.nspname = 'wholesale_v2'
       and parent.relname = 'v2_inventory_movements'
       and c.relkind = 'r'
       and not c.relrowsecurity
  loop
    execute format('alter table wholesale_v2.%I enable row level security', r.relname);
    v_n := v_n + 1;
  end loop;
  raise notice '125: row security switched on for % movement partition(s)', v_n;
end
$fix$;

-- THE ROOT CAUSE. 074's creator opens a new door every month. Without this the
-- fix above is a one-off tidy-up and the hole reappears in October.
-- Rewritten rather than replaced: the loop, the naming and the return value are
-- 074's, unchanged, so a diff shows exactly the two lines that were missing.
create or replace function wholesale_v2.v2_ensure_movement_partitions(p_months_ahead int default 24)
returns integer
language plpgsql
security definer
set search_path to 'wholesale_v2', 'public'
as $fn$
declare
  v_start   date := date_trunc('month', now())::date;
  v_month   date;
  v_name    text;
  v_created int := 0;
  i         int;
begin
  for i in 0..greatest(coalesce(p_months_ahead, 24), 0) loop
    v_month := (v_start + make_interval(months => i))::date;
    v_name  := format('v2_inventory_movements_%s', to_char(v_month, 'YYYY_MM'));

    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wholesale_v2' and c.relname = v_name
    ) then
      execute format(
        'create table wholesale_v2.%I partition of wholesale_v2.v2_inventory_movements
           for values from (%L) to (%L)',
        v_name, v_month, (v_month + interval '1 month')::date);

      -- ⭐ THE TWO LINES 074 DID NOT HAVE.
      -- `create table ... partition of` does not inherit row security: it is a
      -- per-relation flag and a new partition starts OFF. No policy is added on
      -- purpose — every legitimate read goes through the parent, where the
      -- tenant policy lives, so a direct read of a partition must return
      -- nothing rather than something filtered.
      execute format('alter table wholesale_v2.%I enable row level security', v_name);

      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$fn$;

comment on function wholesale_v2.v2_ensure_movement_partitions(int) is
  'Creates monthly partitions of the stock ledger ahead of time, each with row '
  'security ON and no policy of its own. Since 125: a partition without row '
  'security is a copy of the whole platform''s ledger readable by naming it.';

-------------------------------------------------------------------- THE PROOF
do $$
declare
  v_open text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_open
    from pg_class c
    join pg_inherits i on i.inhrelid = c.oid
    join pg_class parent on parent.oid = i.inhparent
    join pg_namespace n on n.oid = parent.relnamespace
   where n.nspname = 'wholesale_v2'
     and parent.relname = 'v2_inventory_movements'
     and c.relkind = 'r'
     and not c.relrowsecurity;

  if v_open is not null then
    raise exception '125: these movement partitions still have row security OFF: %', v_open;
  end if;
  raise notice '125 ok: every partition of the stock ledger has row security on';
end $$;

-- And that the creator itself carries the fix, so October does not reopen it.
do $$
begin
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'wholesale_v2' and p.proname = 'v2_ensure_movement_partitions')
     not like '%enable row level security%' then
    raise exception '125: v2_ensure_movement_partitions would create an open partition again';
  end if;
  raise notice '125 ok: next month''s partition will be created closed';
end $$;
