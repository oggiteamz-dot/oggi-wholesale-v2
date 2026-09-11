-- =============================================================================
-- 132 — THE THIRD TIER: store staff                    Block 7, 11 September 2026
-- =============================================================================
--
-- HADI, 11 Sep 2026:
--   "You're gonna be building a new view, which is the warehouse manager view.
--    ... And another one for the accountant or the finance manager as well."
--
-- Neither identity system this schema already has can hold either of them, and
-- the reasons are different. Both are worth writing down, because the obvious
-- move is wrong in a way that does not show up until something leaks.
--
-- ==== ❌ NOT v2_user_profiles (022:31, roles owner|wholesaler) ================
--
-- v2_my_wid() (022:215-221) is the tenant predicate for 201 policy and function
-- sites across 61 migrations, and IT CARRIES NO ROLE. Every one of those sites
-- asks only "are you the platform owner, or are you staff of this wid?".
--
-- A warehouse manager given a profile row with a wid would be INDISTINGUISHABLE
-- FROM THE OWNER OF THE BUSINESS at all 201 of them, immediately: prices,
-- product deletion, cost, client bans, share links. Not through a bug -- through
-- the design working exactly as written.
--
-- ==== ❌ NOT v2_portal_accounts (022:84, roles buyer|sales) ==================
--
-- The salesperson lives there and the shape looks right. It is not.
--
-- checks/check_person_identity.sql:135 is a LIVE gate: every portal account must
-- have a person_id. So a warehouse login would be forced to become a MARKETPLACE
-- PERSON -- and v2_person_channels carries `unique (kind, normalised)`, which 090
-- calls "THE join key of the whole marketplace".
--
--   A warehouse manager at store A who also owns a shop buying from store B
--   would have their STAFF LOGIN AND THEIR BUYER ACCOUNT COLLAPSED INTO ONE
--   HUMAN on their phone number.
--
-- 090's own invariant is "normalisation may split a person. It must never merge
-- two." Putting staff into that channel space is an invitation to break it.
--
-- And the concept is simply wrong. v2_people means "ONE HUMAN SHOPPING AT MANY
-- STORES". A picker at one warehouse is the opposite of that sentence.
--
-- ==== ✅ SO: A THIRD TIER, AND WHAT IT BUYS =================================
--
--   * its own table            -> check_person_identity and the nine-table
--                                 share-link census stay green, untouched
--   * runs as PostgREST anon   -> DENY BY DEFAULT. Every read and every write
--                                 must be an explicit SECURITY DEFINER RPC with
--                                 a column list somebody chose on purpose.
--   * no person, no channel    -> a staff phone is never a marketplace join key
--   * v2_my_wid() is NULL      -> inherits nothing from the 201 sites
--   * a `desk` column          -> warehouse =/= finance is expressible, and each
--                                 desk gets its OWN column allowlist (135, 136)
--
-- The cost is one RPC per thing a desk may do. That is the salesperson precedent
-- (048:132) adopted deliberately rather than reluctantly: a tier that can do
-- nothing until somebody writes down what it may do is the only kind of tier
-- that cannot quietly acquire a power nobody granted it.
--
-- ⚠️ THIS MIGRATION CREATES NO STAFF. Like 130, it builds the shape and marks
-- nobody. Hiring is a dated business act, not a deploy side effect.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ------------------------------------------------------------------ the table
create table if not exists v2_staff_accounts (
  id             uuid primary key default gen_random_uuid(),
  wid            text not null references v2_wholesalers(wid) on delete cascade,

  -- DESK, not "role". The word matters: `role` in this schema already means two
  -- different things in two different tables, and a third meaning would be the
  -- next person's hour. A desk is a place work arrives at.
  desk           text not null check (desk in ('warehouse','finance')),

  username       text not null,
  password_hash  text not null,
  actor_label    text,
  active         boolean not null default true,

  created_at     timestamptz not null default now(),
  created_by     uuid,                       -- the auth user who hired them
  updated_at     timestamptz not null default now()
);

comment on table v2_staff_accounts is
  'Store staff: a warehouse manager or a finance manager, belonging to exactly '
  'one wholesaler. Migration 132. DELIBERATELY NOT v2_user_profiles (would '
  'inherit full wholesaler authority at every v2_my_wid() site) and DELIBERATELY '
  'NOT v2_portal_accounts (would force a marketplace person row, putting a staff '
  'phone number into v2_person_channels'' unique join key). Runs as anon and '
  'holds no table grant: everything a desk may do is an explicit SECURITY '
  'DEFINER function with a column list.';

comment on column v2_staff_accounts.desk is
  'warehouse | finance. Named `desk` rather than `role` because `role` already '
  'means owner|wholesaler in v2_user_profiles and buyer|sales in '
  'v2_portal_accounts; a third meaning of the same word is a trap.';

-- Usernames are unique PER STORE, not globally. Two different wholesalers may
-- both have a "warehouse" login and neither should have to discover that the
-- other took the name. (v2_portal_accounts made the opposite choice for `sales`
-- -- 022:101 -- because a salesperson signs in without naming a store. A desk
-- always names its store, so it does not need a global namespace.)
create unique index if not exists idx_v2_staff_accounts_username
  on v2_staff_accounts (wid, lower(username));

create index if not exists idx_v2_staff_accounts_wid_desk
  on v2_staff_accounts (wid, desk) where active;

-- -------------------------------------------------------------------- the RLS
alter table v2_staff_accounts enable row level security;

-- Only the platform owner or the wholesaler who employs them may see or manage
-- staff, and only through the `authenticated` role -- which a desk is not.
drop policy if exists v2_staff_accounts_admin_scoped on v2_staff_accounts;
create policy v2_staff_accounts_admin_scoped on v2_staff_accounts
  for all
  using      (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

-- ⛔ THE GRANT, AND IT IS THE WHOLE SECURITY MODEL OF THIS TIER.
--
-- anon gets NOTHING. A desk session runs as anon, so a desk cannot read its own
-- row, cannot read anyone's password hash, and cannot discover that another
-- store exists. Everything it can do arrives later as a definer function that
-- takes its id and re-checks it.
--
-- Supabase's default privileges grant new objects to anon (022:276-283 records
-- the trap). Revoking explicitly is not belt-and-braces; it is the only thing
-- standing between this table and the public internet.
revoke all on table v2_staff_accounts from public, anon;
grant select, insert, update, delete on table v2_staff_accounts to authenticated;

-- =============================================================================
-- SELF-TEST — it builds its own probes and asserts about the CHANGE IT MADE,
-- never about the data it happens to find. (The 116/119 rule; 130 broke it on a
-- Sunday and refused to apply to an empty replay.)
-- =============================================================================
do $$
declare
  n integer;
  v_probe_wid  constant text := 'zz132a';
  v_id_a uuid;
  v_id_b uuid;
begin
  -- 1. the desk vocabulary is exactly two words
  select count(*) into n
    from pg_constraint
   where conrelid = 'wholesale_v2.v2_staff_accounts'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%desk%warehouse%finance%';
  if n <> 1 then
    raise exception 'ASSERT 1 FAILED: the desk vocabulary is not one CHECK naming exactly warehouse and finance (found %)', n;
  end if;

  -- 2. ⛔ anon holds nothing. The single most important line in this file.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'wholesale_v2'
     and table_name = 'v2_staff_accounts'
     and grantee in ('anon','public');
  if n <> 0 then
    raise exception 'ASSERT 2 FAILED: anon/public hold % grant(s) on v2_staff_accounts -- a desk could read password hashes', n;
  end if;

  -- 3. RLS is on, and there is a policy. (A table with RLS enabled and no
  --    policy denies everyone; a table with a policy and no RLS denies no one.
  --    Both are silent.)
  select count(*) into n from pg_tables
   where schemaname='wholesale_v2' and tablename='v2_staff_accounts' and rowsecurity;
  if n <> 1 then raise exception 'ASSERT 3 FAILED: row level security is not enabled'; end if;
  select count(*) into n from pg_policies
   where schemaname='wholesale_v2' and tablename='v2_staff_accounts';
  if n < 1 then raise exception 'ASSERT 4 FAILED: no policy on v2_staff_accounts'; end if;

  -- 5. usernames collide WITHIN a store and not ACROSS stores. Asserted on
  --    probes this block creates and then rolls back, so it is a claim about
  --    the index rather than about whoever happens to be in the table.
  begin
    -- Two probe stores of this block's own making. v2_wholesalers carries a FK
    -- to the legacy public.wholesalers, so both halves are needed -- 130's
    -- probes do the same and for the same reason.
    insert into public.wholesalers (wid, name, active)
    values (v_probe_wid, 'zz132 probe A', false), ('zz132b', 'zz132 probe B', false);
    insert into wholesale_v2.v2_wholesalers (wid, name)
    values (v_probe_wid, 'zz132 probe A'), ('zz132b', 'zz132 probe B');

    insert into v2_staff_accounts (wid, desk, username, password_hash)
    values (v_probe_wid, 'warehouse', 'depot', 'x') returning id into v_id_a;

    -- the SAME username in a DIFFERENT store must be allowed
    insert into v2_staff_accounts (wid, desk, username, password_hash)
    values ('zz132b', 'warehouse', 'depot', 'x') returning id into v_id_b;

    -- the same username in the SAME store must not be, case-folded
    begin
      insert into v2_staff_accounts (wid, desk, username, password_hash)
      values (v_probe_wid, 'finance', 'DEPOT', 'x');
      raise exception 'ASSERT 5 FAILED: two logins named DEPOT in one store were both accepted';
    exception when unique_violation then
      null;  -- correct
    end;

    -- a desk outside the vocabulary must be refused
    begin
      insert into v2_staff_accounts (wid, desk, username, password_hash)
      values (v_probe_wid, 'driver', 'wheels', 'x');
      raise exception 'ASSERT 6 FAILED: an unknown desk was accepted';
    exception when check_violation then
      null;  -- correct
    end;

    raise exception 'zz132 rollback';
  exception
    when others then
      if sqlerrm not like 'zz132 rollback%' and sqlerrm not like 'ASSERT%' then
        raise exception 'ASSERT 5/6 FAILED unexpectedly: %', sqlerrm;
      end if;
      if sqlerrm like 'ASSERT%' then raise; end if;
  end;

  raise notice '132 OK: the third tier exists, anon holds nothing, and it employs nobody.';
end $$;
