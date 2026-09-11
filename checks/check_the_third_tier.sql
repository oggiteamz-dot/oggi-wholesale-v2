-- =============================================================================
-- CHECK: the store-staff tier can do nothing nobody wrote down
--                                                      Block 7, 11 Sep 2026
-- =============================================================================
-- Migrations 132/133 added a THIRD identity tier: a warehouse manager and a
-- finance manager, belonging to one store. This gate asserts the three
-- properties the whole design rests on, from outside the migration that made
-- them -- because a self-test proves the change, and a gate proves the state.
--
--   1. ⛔ A DESK RUNS AS anon AND anon HOLDS NOTHING. If anon ever gains a
--      grant on v2_staff_accounts, a picker can read every password hash in the
--      store and discover which other stores exist. Supabase grants new objects
--      to anon BY DEFAULT (022:276-283 records the trap), so this is not
--      belt-and-braces -- it is the only thing standing between that table and
--      the public internet.
--
--   2. ⭐ EVERY FUNCTION A DESK CAN REACH GOES THROUGH v2_staff_wid(). An id
--      handed over by a browser is a CLAIM, not a credential. One gate function,
--      checked in one place; the alternative is six copies of a security check
--      and the sixth is the one that forgets `active`.
--
--   3. A DESK IS NOT A MARKETPLACE PERSON. This is the reason the tier is its
--      own table rather than a widened v2_portal_accounts: person channels
--      carry `unique (kind, normalised)`, which 090 calls "THE join key of the
--      whole marketplace". A warehouse manager who also owns a shop would have
--      had their staff login and their buyer account merged on their phone
--      number. 090's invariant: normalisation may split a person, it must never
--      merge two.
--
-- Writes nothing: one transaction, rolled back at the end.

begin;
set local search_path = wholesale_v2, public;

select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (

  -- 1. ⛔ the grant
  select 1 as ord,
         '⛔ anon holds NO grant on v2_staff_accounts — a desk cannot read a password hash' as label,
         'none' as expected,
    (select coalesce(string_agg(distinct grantee || ':' || privilege_type, ', '), 'none')
       from information_schema.role_table_grants
      where table_schema='wholesale_v2' and table_name='v2_staff_accounts'
        and grantee in ('anon','public')) as got

  union all
  select 2, 'and none on the routing tables either', 'none',
    (select coalesce(string_agg(distinct table_name || '/' || grantee, ', '), 'none')
       from information_schema.role_table_grants
      where table_schema='wholesale_v2' and grantee in ('anon','public')
        and table_name in ('v2_order_desk_assignments','v2_order_desk_routing',
                           'v2_order_routing_failures','v2_money_received'))

  -- 2. ⭐ the one gate
  union all
  select 3, '⭐ every desk function passes through v2_staff_wid — an id from a browser is a claim, not a credential', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='wholesale_v2'
        and (p.proname like 'v2_warehouse_%' or p.proname like 'v2_finance_%'
             or p.proname like 'v2_desk_%' or p.proname = 'v2_record_money_received'
             or p.proname = 'v2_money_received_for_order')
        and p.proname <> 'v2_desk_send'      -- 134's, and it is the WHOLESALER's
        and pg_get_functiondef(p.oid) not like '%v2_staff_wid(%')

  union all
  select 4, 'and v2_staff_wid itself checks desk AND active AND the store', 'yes',
    (select case when pg_get_functiondef('wholesale_v2.v2_staff_wid(uuid,text)'::regprocedure)
                      like '%s.desk = p_desk%'
                 and pg_get_functiondef('wholesale_v2.v2_staff_wid(uuid,text)'::regprocedure)
                      like '%s.active%'
                 and pg_get_functiondef('wholesale_v2.v2_staff_wid(uuid,text)'::regprocedure)
                      like '%w.active%'
            then 'yes' else 'NO' end)

  -- 3. not a marketplace person
  union all
  select 5, '⭐ a desk is not a marketplace person — no staff id appears in v2_person_memberships', '0',
    (select count(*)::text from wholesale_v2.v2_person_memberships m
      where m.account_id in (select id from wholesale_v2.v2_staff_accounts))

  union all
  select 6, 'and the person-identity invariant is untouched: every portal account still has a person', '0',
    (select count(*)::text from wholesale_v2.v2_portal_accounts where person_id is null)

  -- 4. hiring is closed to a desk
  union all
  select 7, '⛔ a desk cannot hire or suspend a desk', 'none',
    (select coalesce(string_agg(distinct routine_name, ', '), 'none')
       from information_schema.role_routine_grants
      where routine_schema='wholesale_v2' and grantee in ('anon','public')
        and routine_name in ('v2_create_staff_account','v2_set_staff_active'))

  -- 5. and a desk holds no wholesaler authority anywhere
  union all
  select 8, '⛔ no staff id was ever written into v2_user_profiles — a desk holds no v2_my_wid() power', '0',
    (select count(*)::text from wholesale_v2.v2_user_profiles
      where id in (select id from wholesale_v2.v2_staff_accounts))

  -- 6. the vocabulary has not quietly widened
  union all
  select 9, 'the desk vocabulary is still exactly two words', 'finance,warehouse',
    (select coalesce(string_agg(distinct desk, ',' order by desk), 'finance,warehouse')
       from wholesale_v2.v2_staff_accounts)

) t order by ord;

rollback;
