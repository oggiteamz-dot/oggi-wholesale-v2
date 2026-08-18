-- =============================================================================
-- 046 — A NEW WHOLESALER IS ALSO BORN WITH A CATALOG
-- =============================================================================
-- 18 Aug 2026, minutes after 045.
--
-- Migration 045 created v2_catalogs and back-filled a "Main Catalog" for every
-- wholesaler THAT EXISTED WHEN IT RAN. It did not teach v2_create_wholesaler to
-- make one. So a wholesaler created after 045 had a stock location (043 fixed
-- that) and no catalog at all.
--
-- Caught within a minute of writing 045, by creating a throwaway wholesaler
-- through the console's own function and looking at what it was born with:
--
--     catalogs   0
--     locations  1
--
-- This is EXACTLY the bug 043 existed to fix, one table over, reintroduced by
-- the person who had just fixed it. Worth writing down rather than quietly
-- correcting, because the lesson is not "remember catalogs" -- it is that a
-- back-fill and a creation path are two different things, and doing only the
-- back-fill leaves a hole that opens for the NEXT customer rather than an
-- existing one. Nobody notices, because everyone currently on the system is
-- fine.
--
-- The symptom would have been the Catalogs screen telling a brand-new customer
-- "No catalogs found — if you are seeing this, tell OGGI", which is at least
-- honest, but is not something a customer should ever see on day one.
--
-- The general guard is in checks/check_data_invariants.sql: every wholesaler
-- must have exactly one default catalog, alongside the location assertion 043
-- added. That check is what makes this class of gap loud instead of silent.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Anyone created between 045 and now
-- ---------------------------------------------------------------------
insert into wholesale_v2.v2_catalogs (wid, name, description, is_default, active)
select w.wid, 'Main Catalog',
       'Everything you sell. Created automatically so nothing was left unfiled.',
       true, true
from wholesale_v2.v2_wholesalers w
where not exists (
  select 1 from wholesale_v2.v2_catalogs c where c.wid = w.wid and c.is_default
);

-- ---------------------------------------------------------------------
-- 2. And everyone from here on
-- ---------------------------------------------------------------------
-- Done as a trigger on v2_wholesalers rather than by editing
-- v2_create_wholesaler for the third time. The function has now been rewritten
-- in 041, 043 and would be again here; each rewrite restates 100 lines to
-- change three, and every restatement is a chance to drop something that was
-- added by the previous one. A trigger states the rule once, in one place, and
-- covers every path that inserts a wholesaler -- including the v1 data
-- migration and anything added later that nobody thought to update.
--
-- The same argument applies to the location insert in 043. That one is left
-- where it is: moving working code to make it symmetrical is a change with
-- risk and no benefit today. If a third born-with-it default ever appears,
-- both should move here together.
create or replace function wholesale_v2.v2_wholesaler_default_catalog()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
begin
  insert into wholesale_v2.v2_catalogs (wid, name, description, is_default, active)
  values (new.wid, 'Main Catalog',
          'Everything you sell. Created automatically so nothing was left unfiled.',
          true, true)
  -- If one somehow already exists, leave it alone. The partial unique index
  -- v2_catalogs_one_default is what actually guarantees "at most one"; this
  -- clause just stops the trigger turning a harmless race into a failed
  -- wholesaler creation.
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists v2_wholesaler_default_catalog_trg on wholesale_v2.v2_wholesalers;
create trigger v2_wholesaler_default_catalog_trg
  after insert on wholesale_v2.v2_wholesalers
  for each row execute function wholesale_v2.v2_wholesaler_default_catalog();

comment on function wholesale_v2.v2_wholesaler_default_catalog() is
  'Gives every newly inserted wholesaler a default catalog. A trigger rather than another edit to v2_create_wholesaler, so it covers every insertion path rather than the one function somebody remembered to update.';
