-- =============================================================================
-- 098 — TAKING BACK THE KEY 097 HANDED OUT                    SR-09, 30 Aug 2026
-- =============================================================================
--
-- 097 ended with:
--
--     grant select on wholesale_v2.v2_attribute_aliases to anon, authenticated;
--
-- and the comment beside it said "readable by the app (the facet list is not a
-- secret)". Both halves of that sentence are true and the conclusion was still
-- wrong, because it answered a question this schema does not ask.
--
-- ==== WHAT ACTUALLY CAUGHT IT ==============================================
--
-- checks/check_anon_grants.sql, which is gate S7 from Batch 5 and asks one
-- question: "does anon still hold a key to any table in this schema, or a
-- standing rule that will hand it one tomorrow?" It passed on the database
-- before 097 and raised on the database after it:
--
--     S7 DID NOT LAND: anon still holds privileges on
--     v2_attribute_aliases({...,authenticated=r/postgres,anon=r/postgres})
--
-- It was not found by reading 097. It was found by running every gate in the
-- repository afterwards, which is the entire argument for doing that.
--
-- ==== WHY THE RULE IS "NO TABLE KEYS", NOT "NO SECRETS" ====================
--
-- Migration 085 took every table grant away from anon on purpose. Not because
-- each table held a secret -- the facet list genuinely does not -- but because
-- a grant plus `using (true)` is a STANDING door, and the schema's whole shape
-- is that reads go through SECURITY DEFINER functions that decide what a caller
-- may see. One table where that is not true is a precedent, and the next
-- migration that wants "just a small read" cites it. The value of "anon holds
-- nothing" is that it is checkable in one line and has no exceptions to
-- remember; an exception costs more than the RPC it saves.
--
-- ==== NOTHING BREAKS, BECAUSE NOTHING WAS READING IT =======================
--
-- No file under js/ mentions v2_attribute_aliases. The normaliser does not need
-- the grant either: v2_normalise_attribute is SECURITY DEFINER and reads the
-- table as its owner, which is why the triggers keep working after this.
--
-- When RC-02 or RC-03 needs a browsable list of families, it gets an RPC that
-- returns the families in scope for that caller -- which is a better answer
-- anyway, because "every family in the system" is not what a buyer inside one
-- store should be shown.
--
-- The read POLICY is dropped with the grant. A policy with no grant behind it
-- is dead code that reads like a live permission, and the next person to look
-- would have to work out which of the two was load-bearing.
-- =============================================================================

revoke all on wholesale_v2.v2_attribute_aliases from anon, authenticated;
drop policy if exists v2_attribute_aliases_read on wholesale_v2.v2_attribute_aliases;

-- RLS stays ON. With no grant and no policy the table is closed to both browser
-- roles twice over, which is the state every other table in this schema is in.

-- =============================================================================
-- SELF-ASSERTING.
-- =============================================================================
do $$
declare n int; leftover text; fam text;
begin
  -- 1. The key is gone -- asked the same way gate S7 asks it, table ACLs and
  --    COLUMN ACLs both, because a column grant is invisible to pg_class.relacl
  --    and that is the hole S7 was written to close.
  select string_agg(x.label, ', ') into leftover from (
    select format('%s(%s)', c.relname, c.relacl::text) as label
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2' and c.relname = 'v2_attribute_aliases'
       and c.relacl::text like '%anon=%'
    union all
    select format('%s.%s [column]', c.relname, a.attname)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2' and c.relname = 'v2_attribute_aliases'
       and a.attnum > 0 and not a.attisdropped and a.attacl::text like '%anon=%'
  ) x;
  if leftover is not null then
    raise exception 'ASSERT 1 FAILED: anon still holds a key to the taxonomy (%)', leftover; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_attribute_aliases'
     and grantee in ('anon','authenticated');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: % grant(s) remain for the browser roles', n; end if;

  -- 2. And PUBLIC is not the back door out of it. A grant to PUBLIC is a grant
  --    to every role including anon, and does not appear as `anon=` above.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_attribute_aliases' and grantee='PUBLIC';
  if n <> 0 then raise exception 'ASSERT 2 FAILED: the taxonomy is granted to PUBLIC'; end if;

  -- 3. THE THING THAT WOULD MAKE THIS A BAD TRADE: normalisation must still
  --    work. v2_normalise_attribute is SECURITY DEFINER and reads the table as
  --    its owner, so revoking the browser roles' grant is invisible to it --
  --    but that is an argument, and an argument is not a check.
  fam := wholesale_v2.v2_normalise_attribute('colour','Crimson Red');
  if fam is distinct from 'red' then
    raise exception 'ASSERT 3 FAILED: revoking the grant broke the normaliser (got %)', coalesce(fam,'NULL'); end if;

  -- 4. RLS is still on, so the table is closed twice rather than once.
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and c.relname='v2_attribute_aliases' and c.relrowsecurity;
  if n <> 1 then raise exception 'ASSERT 4 FAILED: row level security was turned off along with the grant'; end if;

  raise notice '098 OK: the taxonomy is closed to anon and authenticated, and normalisation still resolves.';
end $$;
