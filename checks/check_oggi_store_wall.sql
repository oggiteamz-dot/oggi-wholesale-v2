-- =============================================================================
-- CHECK: the people who run the OGGI store cannot read anyone else's sales
--                                                      OWN-04, 8 Sep 2026
-- =============================================================================
-- HADI, 8 Sep 2026, choosing between three arrangements: separate staff, with
-- no access to the owner console.
--
-- WHY THIS GATE EXISTS AT ALL, AND IT IS NOT SQUEAMISHNESS.
--
-- js/views/ranking-policy.js still tells every wholesaler, in its closing
-- section:
--
--     "your sales data is never used against you"
--
-- That sentence survived the 8 Sep edit. It is the ONE claim on that page which
-- OGGI selling could falsify, and it is now the only thing on the page standing
-- between the arrangement and a plain misrepresentation. Until today it was a
-- promise with nothing behind it: the owner console reads every store's orders,
-- and if the people running the OGGI store hold owner logins then what sells in
-- a supplier's shop is, in fact, available to their competitor.
--
-- This gate is what puts something behind it.
--
-- ==== WHAT IT ACTUALLY CHECKS ==============================================
--
-- v2_user_profiles is one row per real Supabase Auth user, role 'owner' or
-- 'wholesaler'. A single USER cannot hold both -- the role column is single
-- valued and id is the primary key -- so "no user is both" is true by
-- construction and asserting it would prove nothing.
--
-- The thing that is NOT true by construction, and is the actual risk, is that
-- the same HUMAN holds two logins. So the wall is asserted on the EMAIL:
--
--   ⭐ no email address may hold an owner profile AND a wholesaler profile for
--      the first-party store.
--
-- That is the difference between a gate that is satisfied by the schema and a
-- gate that is satisfied by the arrangement actually being in place.
--
-- Writes nothing: one transaction, rolled back at the end.

begin;
set local search_path = wholesale_v2, public;

select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (

  -- 1. ⭐ THE WALL. Named emails, so a failure says who rather than how many.
  select 1 as ord, '⭐ nobody who runs the OGGI store also holds an owner login' as label,
         'none' as expected,
    (select coalesce(string_agg(distinct u.email, ', '), 'none')
       from wholesale_v2.v2_user_profiles staff
       join auth.users u on u.id = staff.id
      where staff.role = 'wholesaler'
        and staff.wid in (select wid from wholesale_v2.v2_wholesalers where is_first_party)
        and exists (
          select 1 from wholesale_v2.v2_user_profiles o
           join auth.users u2 on u2.id = o.id
          where o.role = 'owner' and lower(u2.email) = lower(u.email))) as got

  -- 2. And the reverse view of the same fact, because the join above is easy to
  --    get subtly wrong and a second phrasing of one rule costs almost nothing.
  union all select 2, 'and no owner login belongs to someone on the OGGI store''s staff', 'none',
    (select coalesce(string_agg(distinct u.email, ', '), 'none')
       from wholesale_v2.v2_user_profiles o
       join auth.users u on u.id = o.id
      where o.role = 'owner'
        and exists (
          select 1 from wholesale_v2.v2_user_profiles staff
           join auth.users u2 on u2.id = staff.id
          where staff.role = 'wholesaler'
            and staff.wid in (select wid from wholesale_v2.v2_wholesalers where is_first_party)
            and lower(u2.email) = lower(u.email)))

  -- 3. An owner profile is platform-wide and carries no wid. One scoped to the
  --    first-party store would be a hybrid -- owner reach, house-brand
  --    interest -- which is the exact shape the wall exists to prevent, and it
  --    would slip past assertions 1 and 2 if it were the SAME login rather than
  --    two.
  union all select 3, 'no owner login is scoped to the first-party store', 'none',
    (select coalesce(string_agg(o.id::text, ', '), 'none')
       from wholesale_v2.v2_user_profiles o
      where o.role = 'owner'
        and o.wid in (select wid from wholesale_v2.v2_wholesalers where is_first_party))

  -- 4. The wall is only meaningful if the owner console is genuinely the only
  --    way to read another store's sales. Asserted rather than assumed: no
  --    browser role may read the orders table directly.
  union all select 4, 'and the owner console really is the only door to another store''s orders', 'none',
    (select coalesce(string_agg(distinct g.grantee || ':' || g.privilege_type, ', '), 'none')
       from information_schema.role_table_grants g
      where g.table_schema = 'wholesale_v2' and g.table_name = 'v2_orders'
        and g.grantee in ('anon', 'PUBLIC'))

  -- 5. ⚠️ A STATUS LINE, AND LABELLED AS ONE RATHER THAN DRESSED AS A CHECK.
  --
  --    With no first-party store marked, assertions 1-3 return 'none' for the
  --    happiest possible reason -- their subquery is empty -- and this file
  --    would report all-green forever while watching nothing. That is the shape
  --    check_link_cap_under_concurrency.sh had twice before it measured
  --    anything, and the fix there was to make the gate say what it had
  --    actually done.
  --
  --    My first attempt at this line expected 'stated' and returned the
  --    sentence, so it failed on its own text. Rather than bend the comparison
  --    until it passed -- which would have made it an assertion that asserts
  --    nothing while looking like one -- it now says STATUS in its own label.
  --    A row that always passes is only dishonest if it pretends otherwise.
  union all select 5,
    'STATUS (not an assertion) — ' || (
      select case when count(*) = 0
                  then 'no first-party store is marked yet, so 1-3 are vacuous BY DESIGN and begin biting the day one is'
                  else 'watching ' || string_agg(wid, ', ') end
        from wholesale_v2.v2_wholesalers where is_first_party),
    'status', 'status'
) r
order by ord, label;

rollback;
