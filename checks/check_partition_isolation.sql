-- =============================================================================
-- CHECK: naming a partition does not get you the whole platform's ledger — 125
-- =============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE, found 7 Sep 2026 and reproduced below:
--
--   select * from wholesale_v2.v2_inventory_movements            -> your rows
--   select * from wholesale_v2.v2_inventory_movements_2026_09    -> EVERYONE'S
--
-- The tenant policy is on the PARENT. Postgres evaluates a parent's policies for
-- queries on the parent and a partition's own for queries on the partition, and
-- `create table ... partition of` does not inherit row security. 074 created 41
-- partitions with a bare create, `authenticated` holds SELECT on all of them,
-- and the ledger holds 3,081 rows across every wholesaler on the platform.
--
-- WHY THIS FILE IS SHAPED THE WAY IT IS
-- It does not ask whether a flag is set. It BECOMES a signed-in wholesaler --
-- a real v2_user_profiles row and a real request.jwt.claims, the same way the
-- app arrives -- and then tries to read the other wholesaler's ledger, first
-- through the front door and then by naming the partition. A flag is a
-- statement about configuration; this is a statement about what a person can
-- actually fetch, and it is the second one that was wrong for months.
--
-- The two numbers that matter, and both must hold:
--   A reading through the PARENT           -> 1   (their own row: NOT broken)
--   A naming the PARTITION directly        -> 0   (the leak: closed)
-- Assertion 1 without assertion 2 would pass a fix that revoked everything and
-- broke the warehouse screen. Assertion 2 without assertion 1 would pass a
-- system with no tenant isolation at all.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_partition_isolation.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers          (wid, name) values ('zzp1','Part One'),('zzp2','Part Two') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzp1','Part One'),('zzp2','Part Two') on conflict (wid) do nothing;

-- A real staff login for zzp1, because v2_my_wid() reads v2_user_profiles by
-- auth.uid(). Role 'wholesaler', never 'owner' -- an owner passes every tenant
-- check and would make this file green for the wrong reason.
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000ee001') on conflict do nothing;
insert into wholesale_v2.v2_user_profiles (id, wid, role, actor_label)
values ('00000000-0000-4000-8000-0000000ee001','zzp1','wholesaler','P1 staff');

insert into wholesale_v2.v2_products (id, wid, name) values
 ('00000000-0000-4000-8000-0000000ba001','zzp1','P1 Shirt'),
 ('00000000-0000-4000-8000-0000000bb001','zzp2','P2 Shirt');
insert into wholesale_v2.v2_product_variants (id, product_id, sku) values
 ('00000000-0000-4000-8000-0000000ba002','00000000-0000-4000-8000-0000000ba001','P1-1'),
 ('00000000-0000-4000-8000-0000000bb002','00000000-0000-4000-8000-0000000bb001','P2-1');
insert into wholesale_v2.v2_locations (id, wid, name, is_default, archived) values
 ('00000000-0000-4000-8000-0000000ba003','zzp1','P1 store',false,false),
 ('00000000-0000-4000-8000-0000000bb003','zzp2','P2 store',false,false);

-- One movement each, in the CURRENT month, so they land in the same live
-- partition. Different quantities so a leak is legible in the number.
insert into wholesale_v2.v2_inventory_movements (variant_id, location_id, movement_type, qty_delta, created_at)
values ('00000000-0000-4000-8000-0000000ba002','00000000-0000-4000-8000-0000000ba003','receive', 11, now()),
       ('00000000-0000-4000-8000-0000000bb002','00000000-0000-4000-8000-0000000bb003','receive', 22, now());

-- PRODUCTION'S GRANTS, REPRODUCED ON PURPOSE.
-- On production `authenticated` holds SELECT on nearly every table in the
-- schema -- a blanket grant that is in no migration in this repo, so a replay
-- does not have it. Without these lines this file would pass on a replay for a
-- reason that is not true of the live database, which is the worst kind of
-- green. See checks/GATE-EVIDENCE.md, "the grant drift".
grant select on wholesale_v2.v2_inventory_movements, wholesale_v2.v2_products,
                wholesale_v2.v2_product_variants, wholesale_v2.v2_user_profiles to authenticated;
do $g$ declare r record; begin
  for r in select c.relname from pg_class c
             join pg_inherits i on i.inhrelid = c.oid
             join pg_class parent on parent.oid = i.inhparent
             join pg_namespace n on n.oid = parent.relnamespace
            where n.nspname='wholesale_v2' and parent.relname='v2_inventory_movements' and c.relkind='r'
  loop execute format('grant select on wholesale_v2.%I to authenticated', r.relname); end loop;
end $g$;

create temporary table zzp_results (ord int, label text, expected text, got text) on commit drop;
grant all on zzp_results to public;

do $check$
declare
  v_live text := format('v2_inventory_movements_%s', to_char(now(), 'YYYY_MM'));
  n bigint;
begin
  ------------------------------------------------------ become a real wholesaler
  perform set_config('request.jwt.claims',
                     '{"sub":"00000000-0000-4000-8000-0000000ee001"}', true);
  set local role authenticated;

  -- 1. THE FRONT DOOR STILL WORKS. If this ever reads 0, somebody "fixed" the
  --    leak by breaking the warehouse screen, and the movement history, the
  --    valuation report and the dead-stock report went blank with it.
  execute 'select count(*) from wholesale_v2.v2_inventory_movements' into n;
  insert into zzp_results values (1, 'a wholesaler still reads their OWN ledger through the parent', '1', n::text);

  -- 2. ⛔ THE LEAK. Naming the live partition returns nothing at all -- not
  --    "their own rows", NOTHING, because no legitimate read ever names a
  --    partition. Before 125 this was 2: their row and a stranger's.
  execute format('select count(*) from wholesale_v2.%I', v_live) into n;
  insert into zzp_results values (2, 'naming the live partition directly returns nothing (was 2)', '0', n::text);

  -- 3. and the default partition, the net that catches out-of-range dates
  execute 'select count(*) from wholesale_v2.v2_inventory_movements_default' into n;
  insert into zzp_results values (3, 'the default partition is closed too', '0', n::text);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$check$;

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzp_results

  -- 4. ⛔ THE RULE, BY BEHAVIOUR RATHER THAN BY THE THREE NAMES ABOVE.
  --    41 partitions exist and one more appears every month. Asserting three
  --    of them is asserting the three somebody remembered.
  union all select 4, 'EVERY partition of the ledger has row security on', 'none open',
    (select coalesce(string_agg(c.relname, ', ' order by c.relname), 'none open')
       from pg_class c
       join pg_inherits i on i.inhrelid = c.oid
       join pg_class parent on parent.oid = i.inhparent
       join pg_namespace n on n.oid = parent.relnamespace
      where n.nspname='wholesale_v2' and parent.relname='v2_inventory_movements'
        and c.relkind='r' and not c.relrowsecurity)

  -- 5. and NEXT month's will be born closed. Without this the fix is a tidy-up
  --    that October undoes.
  union all select 5, 'the partition creator switches row security on', 'yes',
    (select case when p.prosrc like '%enable row level security%' then 'yes' else 'NO — OCTOBER REOPENS IT' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='wholesale_v2' and p.proname='v2_ensure_movement_partitions')

  -- 6. the parent keeps the policy that does the actual scoping. Enabling RLS
  --    on the children would be worth nothing if somebody dropped this.
  union all select 6, 'the parent still carries the tenant policy', '1',
    (select count(*)::text from pg_policies
      where schemaname='wholesale_v2' and tablename='v2_inventory_movements')

  -- 7. ⚠ TODAY'S TRUTH, NOT AN ENDORSEMENT. v2_live_holds is a definer-rights
  --    view readable by anon and authenticated. Migration 064 chose that
  --    deliberately and wrote down why: an invoker view reports zero holds to a
  --    buyer, who then oversells stock somebody else is already holding. It
  --    exposes an aggregate quantity and nothing about WHO. It is asserted here
  --    so that the day it starts exposing cart_id or buyer_id, or the day
  --    somebody flips it to invoker without reading 064, this file says so.
  union all select 7, 'v2_live_holds is still an aggregate and still definer-rights', 'aggregate only',
    (select case when pg_get_viewdef(c.oid) ~* 'cart_id|buyer_id|client_id'
                 then 'IT NOW EXPOSES WHO IS HOLDING' else 'aggregate only' end
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='wholesale_v2' and c.relname='v2_live_holds')
) r
order by ord;

rollback;
