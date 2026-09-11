-- =============================================================================
-- CHECK: two state machines, a reason on every hand-back, and a sale that
--        survives our own bug                          Block 7, 11 Sep 2026
-- =============================================================================
-- ==== ⛔ THE ONE THAT MATTERS MOST ==========================================
--
--   NO DESK FUNCTION WRITES v2_orders.status.
--
-- The order status is a STATEMENT TO THE CUSTOMER (new → confirmed → shipped →
-- delivered). The desk state is a fact about work inside a building. Merging
-- them would mean a buyer is told their order shipped because a picker tapped
-- something -- which is migration 087's mistake (one field, two audiences) in a
-- different column, and 087 exists because a merchant's internal picker note
-- was found printed on a customer's shipping label.
--
-- It would be an easy and well-meant change to make ("the warehouse finished,
-- so mark it shipped"), which is exactly why it is asserted rather than
-- remembered.
--
-- ==== AND THE ONE THAT IS DELIBERATELY BACKWARDS =============================
--
-- Every other gate in this repo says: a check that cannot run is RED. The
-- auto-routing trigger says the opposite -- it swallows its own failure and
-- lets the order through -- because an order arriving is the CUSTOMER'S act and
-- routing it is ours, and ours must never cost theirs. The failure is loud in a
-- table instead of loud in a rollback. This gate proves both halves: that a
-- broken rule does not stop the order, AND that it does not fail silently.

begin;
set local search_path = wholesale_v2, public;

select label, expected, coalesce(got,'(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (

  select 1 as ord,
    '⛔ no desk function writes the ORDER status — a picker cannot tell a buyer anything' as label,
    'none' as expected,
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='wholesale_v2'
        and (p.proname like 'v2_desk_%' or p.proname like 'v2_warehouse_%'
             or p.proname like 'v2_finance_%')
        and pg_get_functiondef(p.oid) ~* 'update\s+(wholesale_v2\.)?v2_orders') as got

  union all
  select 2, 'the two triggers that route an order are both installed', 'trg_v2_route_order_confirmed,trg_v2_route_order_new',
    (select coalesce(string_agg(tgname, ',' order by tgname), '(none)')
       from pg_trigger where tgrelid='wholesale_v2.v2_orders'::regclass and not tgisinternal
         and tgname like 'trg_v2_route_order%')

  union all
  select 3, '⭐ the routing trigger catches its own failure — an order is the customer''s act', 'yes',
    (select case when pg_get_functiondef('wholesale_v2.v2_route_order_to_desks()'::regprocedure)
                      ~* 'exception\s+when\s+others' then 'yes' else 'NO' end)

  union all
  select 4, 'and it writes the failure down rather than swallowing it in silence', 'yes',
    (select case when pg_get_functiondef('wholesale_v2.v2_route_order_to_desks()'::regprocedure)
                      like '%v2_order_routing_failures%' then 'yes' else 'NO' end)

  union all
  select 5, '⚠️ no order has silently failed to route (a row here is a real defect)', '0',
    (select count(*)::text from wholesale_v2.v2_order_routing_failures)

  union all
  select 6, '⛔ every hand-back carries a reason — a refusal with nothing after it is a dead end', '0',
    (select count(*)::text from wholesale_v2.v2_order_desk_assignments
      where state='returned' and coalesce(trim(return_reason),'')='')

  union all
  select 7, 'and the table refuses to store one without', 'yes',
    (select case when count(*) > 0 then 'yes' else 'NO' end
       from pg_constraint
      where conrelid='wholesale_v2.v2_order_desk_assignments'::regclass
        and conname = 'v2_desk_return_has_a_reason')

  union all
  select 8, 'an order sits on a desk at most once', '0',
    (select count(*)::text from (
       select order_id, desk from wholesale_v2.v2_order_desk_assignments
        group by order_id, desk having count(*) > 1) d)

  union all
  select 9, 'every assignment carries the tenant on the row rather than joining for it', 'yes',
    (select case when count(*) = 1 then 'yes' else 'NO' end
       from information_schema.columns
      where table_schema='wholesale_v2' and table_name='v2_order_desk_assignments'
        and column_name='wid' and is_nullable='NO')

  union all
  select 10, 'no assignment has drifted from its order''s store', '0',
    (select count(*)::text from wholesale_v2.v2_order_desk_assignments a
       join wholesale_v2.v2_orders o on o.id = a.order_id
      where a.wid <> o.wid)

) t order by ord;

-- =============================================================================
-- ⭐ THE BEHAVIOURAL HALF: a routing rule that cannot possibly work must not
-- cost the sale. Built and rolled back, like check_desk_walls.sql.
-- =============================================================================
insert into public.wholesalers (wid,name,active) values ('zzrt','Routing probe',false);
insert into wholesale_v2.v2_wholesalers (wid,name) values ('zzrt','Routing probe');
insert into wholesale_v2.v2_locations (wid,name) values ('zzrt','dock');
insert into wholesale_v2.v2_order_desk_routing (wid,desk,auto_send_on) values ('zzrt','warehouse','on_new');

-- break the thing the trigger is about to write to
alter table wholesale_v2.v2_order_desk_assignments
  add constraint zzrt_break check (desk <> 'warehouse');

insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
select 'zzrt','a real customer', l.id, 'new', 200 from wholesale_v2.v2_locations l where l.wid='zzrt';

alter table wholesale_v2.v2_order_desk_assignments drop constraint zzrt_break;

select label, expected, got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select 1 as ord,
    '⭐ a routing rule that CANNOT work did not stop the order — the customer keeps their sale' as label,
    '1' as expected,
    (select count(*)::text from wholesale_v2.v2_orders where wid='zzrt') as got
  union all
  select 2, '⭐ and it did not fail silently — the failure is written down where somebody can read it', '1',
    (select count(*)::text from wholesale_v2.v2_order_routing_failures where wid='zzrt')
) t order by ord;

rollback;
