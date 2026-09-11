-- =============================================================================
-- CHECK: the two desks see their own store, their own desk, and nothing else
--                                                      Block 7, 11 Sep 2026
-- =============================================================================
-- ⭐ THIS GATE BUILDS ITS OWN WORLD AND THEN ROLLS IT BACK.
--
-- Nine of the 55 SQL gates in this repo cannot run on a clean replay because
-- they were written against production data, and they prove nothing there
-- (run_sql_gates.sh counts them separately and never as green). This one takes
-- the other road: two stores, four desks, two orders, and every assertion is
-- about rows it created itself.
--
-- That matters more here than usual. "A warehouse manager at store A cannot see
-- store B" is not a statement about the schema -- it is a statement about what
-- happens when somebody tries, and the only way to know is to try.
--
-- WHAT IT ASSERTS
--   1. ⭐ the WAREHOUSE sees no money, in the SIGNATURE and not merely on screen
--   2. ⭐ the FINANCE desk sees no warehouse floor -- and no fulfil_note
--   3. a desk at store A gets ZERO ROWS for store B, on every function
--   4. a WAREHOUSE id passed to a FINANCE function gets zero rows, and vice versa
--   5. a suspended desk stops immediately
--   6. an order never sent to a desk is invisible to it, even at its own store

begin;
set local search_path = wholesale_v2, public;

-- ---------------------------------------------------------------- the world
insert into public.wholesalers (wid, name, active) values
  ('zzwA','Wall probe A',false), ('zzwB','Wall probe B',false);
insert into wholesale_v2.v2_wholesalers (wid, name, currency) values
  ('zzwA','Wall probe A','$'), ('zzwB','Wall probe B','$');

insert into wholesale_v2.v2_locations (wid, name) values ('zzwA','A dock'), ('zzwB','B dock');

insert into wholesale_v2.v2_products (wid, name) values ('zzwA','A shirt'), ('zzwB','B shirt');
insert into wholesale_v2.v2_product_variants (product_id, sku, cost, extra_attrs)
select id, 'ZZW-'||wid, 3.00, '{"color":"Blue","size":"M"}'::jsonb
  from wholesale_v2.v2_products where wid in ('zzwA','zzwB');

insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
select w.wid, w.wid||' shop', l.id, 'new', 100
  from (values ('zzwA'),('zzwB')) w(wid)
  join wholesale_v2.v2_locations l on l.wid = w.wid;

insert into wholesale_v2.v2_order_items (order_id, variant_id, qty, unit_price, line_total)
select o.id, v.id, 10, 10, 100
  from wholesale_v2.v2_orders o
  join wholesale_v2.v2_products p on p.wid = o.wid
  join wholesale_v2.v2_product_variants v on v.product_id = p.id
 where o.wid in ('zzwA','zzwB');

-- an order at A that is sent to NOBODY, to prove invisibility inside one store
insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
select 'zzwA','A secret shop', l.id, 'new', 55
  from wholesale_v2.v2_locations l where l.wid='zzwA';

insert into wholesale_v2.v2_staff_accounts (wid, desk, username, password_hash) values
  ('zzwA','warehouse','wa','x'), ('zzwA','finance','fa','x'),
  ('zzwB','warehouse','wb','x'), ('zzwB','finance','fb','x');

-- both desks at both stores get their store's FIRST order (not the secret one)
insert into wholesale_v2.v2_order_desk_assignments (order_id, wid, desk)
select o.id, o.wid, d.desk
  from wholesale_v2.v2_orders o
  cross join (values ('warehouse'),('finance')) d(desk)
 where o.wid in ('zzwA','zzwB') and o.buyer_label like '% shop'
   and o.buyer_label not like '%secret%';

-- ------------------------------------------------------------------ asserts
select label, expected, coalesce(got,'(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (

  -- 1. ⭐ THE MONEY WALL, in the signature.
  select 1 as ord,
    '⭐ NO warehouse function returns money — a price on a pick sheet is a price on the warehouse floor' as label,
    'none' as expected,
    (select coalesce(string_agg(p.specific_name||'.'||p.parameter_name, ', '), 'none')
       from information_schema.parameters p
      where p.specific_schema='wholesale_v2' and p.parameter_mode='OUT'
        and p.specific_name like 'v2_warehouse_%'
        and p.parameter_name ~* '(price|cost|total|subtotal|amount|margin|discount|revenue|invoice)') as got

  -- 2. ⭐ THE FLOOR WALL, in the signature. fulfil_note especially: it is one
  --    department's instruction to another, and finance is a third.
  union all
  select 2, '⭐ NO finance function returns the warehouse floor, fulfil_note included', 'none',
    (select coalesce(string_agg(p.specific_name||'.'||p.parameter_name, ', '), 'none')
       from information_schema.parameters p
      where p.specific_schema='wholesale_v2' and p.parameter_mode='OUT'
        and p.specific_name like 'v2_finance_%'
        and p.parameter_name ~* '(fulfil|pick|bin|on_hand|reserved|barcode)')

  -- 3. ⭐ CROSS-STORE. A sees exactly one order; it is A's.
  union all
  select 3, '⭐ the warehouse at store A sees one order, and it is store A''s', 'zzwA shop',
    (select coalesce(string_agg(distinct q.buyer_label, ', '), '(none)')
       from wholesale_v2.v2_warehouse_queue(
         (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='warehouse')) q)

  union all
  select 4, 'and the warehouse at store B sees only store B''s', 'zzwB shop',
    (select coalesce(string_agg(distinct q.buyer_label, ', '), '(none)')
       from wholesale_v2.v2_warehouse_queue(
         (select id from wholesale_v2.v2_staff_accounts where wid='zzwB' and desk='warehouse')) q)

  union all
  select 5, '⭐ finance at store A sees only store A''s', 'zzwA shop',
    (select coalesce(string_agg(distinct q.buyer_label, ', '), '(none)')
       from wholesale_v2.v2_finance_queue(
         (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='finance')) q)

  -- 6. ⭐ A's warehouse asking for B's ORDER BY ID gets nothing.
  union all
  select 6, '⭐ the warehouse at A cannot open store B''s order by its id', '0',
    (select count(*)::text from wholesale_v2.v2_warehouse_order(
       (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='warehouse'),
       (select id from wholesale_v2.v2_orders where wid='zzwB' limit 1)))

  union all
  select 7, 'and finance at A cannot open store B''s order either', '0',
    (select count(*)::text from wholesale_v2.v2_finance_order(
       (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='finance'),
       (select id from wholesale_v2.v2_orders where wid='zzwB' limit 1)))

  -- 7. ⭐ THE DESKS DO NOT REACH EACH OTHER, even inside one store.
  union all
  select 8, '⭐ a WAREHOUSE id passed to a FINANCE function returns nothing', '0',
    (select count(*)::text from wholesale_v2.v2_finance_queue(
       (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='warehouse')))

  union all
  select 9, '⭐ and a FINANCE id passed to a WAREHOUSE function returns nothing', '0',
    (select count(*)::text from wholesale_v2.v2_warehouse_queue(
       (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='finance')))

  -- 8. an order never SENT to the desk is invisible, at its own store
  union all
  select 10, '⭐ an order never sent to the warehouse is invisible to it, even at its own store', '0',
    (select count(*)::text from wholesale_v2.v2_warehouse_order(
       (select id from wholesale_v2.v2_staff_accounts where wid='zzwA' and desk='warehouse'),
       (select id from wholesale_v2.v2_orders where wid='zzwA' and buyer_label like '%secret%')))

) t order by ord;

-- ---------------------------------------------------------------------------
-- 9. SUSPENSION BITES AT ONCE, and it is asserted as its own statement because
-- it needs a write in between: the same desk, the same call, before and after.
-- A gate that only checks the "after" proves nothing about whether it was ever
-- working.
select '(before suspending) the warehouse at B sees its order' as label,
       '1' as expected,
       (select count(*)::text from wholesale_v2.v2_warehouse_queue(
          (select id from wholesale_v2.v2_staff_accounts where wid='zzwB' and desk='warehouse'))) as got,
       case when (select count(*) from wholesale_v2.v2_warehouse_queue(
          (select id from wholesale_v2.v2_staff_accounts where wid='zzwB' and desk='warehouse'))) = 1
            then 'PASS' else 'FAIL' end as verdict;

update wholesale_v2.v2_staff_accounts set active=false where wid='zzwB' and desk='warehouse';

select '⭐ and after suspending them, the same call returns nothing' as label,
       '0' as expected,
       (select count(*)::text from wholesale_v2.v2_warehouse_queue(
          (select id from wholesale_v2.v2_staff_accounts where wid='zzwB' and desk='warehouse'))) as got,
       case when (select count(*) from wholesale_v2.v2_warehouse_queue(
          (select id from wholesale_v2.v2_staff_accounts where wid='zzwB' and desk='warehouse'))) = 0
            then 'PASS' else 'FAIL' end as verdict;

rollback;
