-- =============================================================================
-- 139 — THE REPO COULD NOT REBUILD THE PRODUCT EDITOR   Block 7, 11 September 2026
-- =============================================================================
--
-- ⚠️ THIS MIGRATION EXISTS BECAUSE A GATE WRITTEN FOR SOMETHING ELSE REFUSED
-- TO APPLY TO PRODUCTION, AND THE REFUSAL WAS RIGHT.
--
-- Migration 137's self-test asserted that `cost` was granted to no browser role.
-- It passed on a clean replay and PRODUCTION REJECTED IT: `authenticated` holds
-- SELECT, INSERT and UPDATE on wholesale_v2.v2_product_variants.cost there.
--
-- ==== WHAT THAT ACTUALLY MEANT ==============================================
--
-- Not a leak. `authenticated` is the role an OWNER or a WHOLESALER signs in as,
-- and the read policy on that table scopes rows to
--
--     (auth.uid() is null) or v2_is_owner()
--       or (the product belongs to v2_my_wid())
--
-- so a wholesaler reads their own variants and nobody else's. A wholesaler
-- seeing their own buying prices is the product working correctly.
--
-- ⛔ `anon` is a different question and is untouched by this migration. That
-- clause `(auth.uid() is null)` is TRUE for anon, so anon can reach every ROW of
-- that table, and the ONLY thing keeping cost out of a signed-out browser is the
-- column grant. 032's header states it exactly: "A TABLE-level GRANT already
-- permits every column, and a column-level REVOKE does not carve an exception
-- out of it." anon holds no cost grant, in production or here, and 137 now
-- asserts precisely that rather than the broader thing it asserted first.
--
-- ==== ⭐ SO WHAT IS THE DEFECT? THE REPO HAD STOPPED MATCHING PRODUCTION =====
--
-- Migration 031, 17 Aug 2026, line 51:
--
--     revoke select (cost) on wholesale_v2.v2_product_variants from authenticated;
--
-- It offered v2_my_variant_costs() as the replacement. THE APP NEVER MOVED TO
-- IT. js/data/products-admin.js:659 still selects `cost` off the table, and
-- writes it at :503, :779 and :976 -- which is how a wholesaler sets a buying
-- price at all.
--
-- Somebody re-granted it on production so the product editor kept working, and
-- no migration was ever written. Production has been right and the repo has
-- been wrong, quietly, since 17 August.
--
-- THAT MATTERS BECAUSE OF WHAT checks/replay_migrations.sh CLAIMS:
--
--     "The claim this proves: **this repo can rebuild the product.**"
--
-- It could not. A fresh Supabase project built from these migrations would come
-- up with a product editor that cannot read or write a cost price, and the
-- failure would appear as an empty field rather than as an error -- the exact
-- silent-loss shape FEATURE-MANIFEST.md exists to prevent.
--
-- ==== THE FIX, AND THE ALTERNATIVE THAT WAS NOT TAKEN =======================
--
-- Restore the grant, so the repo reproduces the thing that works.
--
-- The alternative was to move the app onto v2_my_variant_costs() as 031
-- intended. That is a bigger change than it looks -- the editor WRITES cost as
-- well as reads it, and 031's function is read-only -- and it would be a
-- behaviour change to a live screen made at 3am by an agent nobody asked. The
-- honest move is to make the repo match the product, write down why, and leave
-- the redesign to somebody who wants it.
--
-- ⚠️ AND A MATCHED PAIR, so this cannot silently reverse itself: the assertion
-- below requires the grant to be PRESENT. If a future migration revokes it
-- again for tidiness, the build goes red here instead of the product editor
-- going quiet in front of a wholesaler.
-- =============================================================================

set search_path = wholesale_v2, public;

-- The wholesaler's own buying price, on their own products, behind RLS.
grant select (cost), insert (cost), update (cost)
  on wholesale_v2.v2_product_variants to authenticated;

-- ⛔ And anon keeps nothing. Stated here as well as in 031/032 because this file
-- is the one that grants, and a grant and its limit belong on the same page.
revoke select (cost) on wholesale_v2.v2_product_variants from anon;

comment on column wholesale_v2.v2_product_variants.cost is
  'The wholesaler''s buying price. Readable and writable by `authenticated` '
  '(owner or the wholesaler who owns the product, scoped by RLS) -- migration '
  '139 restored that grant after discovering the repo had not reproduced it '
  'since 031. NEVER granted to anon: the read policy on this table admits anon '
  'to every row, so the column grant is the only thing protecting it (032).';

-- =============================================================================
-- SELF-TEST — a MATCHED PAIR. One assertion that the grant is there, one that
-- anon's is not. Reversing either turns the build red.
-- =============================================================================
do $$
declare n integer;
begin
  select count(*) into n from information_schema.column_privileges
   where table_schema='wholesale_v2' and table_name='v2_product_variants'
     and column_name='cost' and grantee='authenticated' and privilege_type='SELECT';
  if n <> 1 then
    raise exception 'ASSERT 1 FAILED: `authenticated` cannot read cost -- the product editor would show an empty buying price and never say why';
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema='wholesale_v2' and table_name='v2_product_variants'
     and column_name='cost' and grantee='authenticated' and privilege_type='UPDATE';
  if n <> 1 then
    raise exception 'ASSERT 2 FAILED: `authenticated` cannot write cost -- a wholesaler could not set a buying price';
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema='wholesale_v2' and table_name='v2_product_variants'
     and column_name='cost' and grantee in ('anon','public');
  if n <> 0 then
    raise exception '⛔ ASSERT 3 FAILED: cost is granted to anon/public (% grant(s)) -- every buying price on the platform would be readable with the publishable key that ships in the JS bundle', n;
  end if;

  raise notice '139 OK: the wholesaler can read and write their own cost, and a signed-out browser still cannot.';
end $$;
