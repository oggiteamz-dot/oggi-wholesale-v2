-- =============================================================================
-- CHECK: a signed-out stranger cannot change anybody's stock — migration 124
-- =============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE, found 6 Sep 2026 while writing migration 121
-- and left open overnight on purpose (121's header says why):
--
--   v2_receive_stock, v2_decrement_stock and v2_assemble_kit are all SECURITY
--   DEFINER, none of them checks who is calling, and all three were granted to
--   `anon` -- the role every visitor holds before logging in, using the key
--   that ships inside the JavaScript bundle. A signed-out stranger holding a
--   variant id and a location id could fill or empty a stranger's warehouse.
--   Variant ids are not secret: a public share link hands them out by design.
--
-- v2_assemble_kit is the one that makes this file worth having. It is not a
-- stock function by name -- it builds a kit -- but it CALLS both of the others,
-- so a fix that revoked the two obvious grants would have left the hole open
-- through a third door and looked complete.
--
-- WHAT MUST STAY OPEN, and why row 4 exists. The signed-out BUYER's cart runs
-- as anon: the portal-account model has no Supabase Auth session at all, so
-- v2_reserve_stock, v2_confirm_reservation and v2_release_reservation must
-- keep their grants or every public catalogue on the platform stops working.
-- The rule is therefore not "anon touches no stock" but:
--
--        **anon may SPEAK FOR stock, and may never CHANGE it.**
--
-- Rows 1-3 are the second half of that sentence, row 4 the first, and row 8 is
-- the sentence itself stated by BEHAVIOUR rather than by name -- so a future
-- v2_writeoff_stock granted to anon out of habit turns this file red without
-- anybody remembering to add it here.
--
-- The three privilege rows do not read a catalogue table: they BECOME anon and
-- make the call. A grant somebody re-adds in the Supabase dashboard would not
-- show up in a repo diff, and a permission that is only ever read is a
-- permission nobody has tested.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_anon_cannot_write_stock.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers          (wid, name) values ('zz124','Anon Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zz124','Anon Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_locations (id, wid, name, is_default, archived)
values ('00000000-0000-4000-8000-000000124100','zz124','Anon Warehouse', false, false);

insert into wholesale_v2.v2_products (id, wid, name, selling_model)
values ('00000000-0000-4000-8000-000000124d01','zz124','Anon Shirt','open');
insert into wholesale_v2.v2_product_variants (id, product_id, sku, price)
values ('00000000-0000-4000-8000-000000124e01','00000000-0000-4000-8000-000000124d01','ZZ124-M', 10.00);

-- Some stock to steal, so a successful decrement would be a REAL theft rather
-- than an error about an empty shelf. If the grant is ever restored, row 2
-- fails because the call SUCCEEDS -- which is the failure that matters.
do $fixture$ begin
  perform wholesale_v2.v2_receive_stock(
    '00000000-0000-4000-8000-000000124e01','00000000-0000-4000-8000-000000124100',
    500, 'fixture', null, null, 'check_anon_cannot_write_stock fixture');
end $fixture$;

create temporary table zz124_results (ord int, label text, expected text, got text) on commit drop;
-- The block below BECOMES anon, and anon cannot write to a table postgres just
-- created. Granting on the scratch table is about recording the result, not
-- about what anon may do to stock -- it lives for one rolled-back transaction
-- and touches nothing in wholesale_v2.
grant all on zz124_results to public;

do $check$
declare
  v_got text;
begin
  ---------------------------------------------------------------- BECOME anon
  set local role anon;

  begin
    perform wholesale_v2.v2_receive_stock(
      '00000000-0000-4000-8000-000000124e01','00000000-0000-4000-8000-000000124100',
      10000, 'attack', null, null, 'a stranger filling a warehouse');
    v_got := 'THE CALL SUCCEEDED';
  exception
    when insufficient_privilege then v_got := 'refused';
    when others then v_got := 'wrong refusal: ' || sqlstate;
  end;
  insert into zz124_results values (1, 'a signed-out stranger cannot ADD stock', 'refused', v_got);

  begin
    perform wholesale_v2.v2_decrement_stock(
      '00000000-0000-4000-8000-000000124e01','00000000-0000-4000-8000-000000124100',
      500, 'adjustment', 'attack', null, null, 'a stranger emptying a warehouse');
    v_got := 'THE CALL SUCCEEDED';
  exception
    when insufficient_privilege then v_got := 'refused';
    when others then v_got := 'wrong refusal: ' || sqlstate;
  end;
  insert into zz124_results values (2, 'a signed-out stranger cannot REMOVE stock', 'refused', v_got);

  -- The third door. A made-up kit id is enough: the privilege check happens
  -- before the function body runs, so a refusal here is about the GRANT and
  -- never about the kit not existing -- and if the grant came back, the
  -- exception would be a different sqlstate and this row would still fail.
  begin
    perform wholesale_v2.v2_assemble_kit(
      '00000000-0000-4000-8000-00000000dead','00000000-0000-4000-8000-000000124100',
      1, null, 'a stranger assembling a kit');
    v_got := 'THE CALL SUCCEEDED';
  exception
    when insufficient_privilege then v_got := 'refused';
    when others then v_got := 'wrong refusal: ' || sqlstate;
  end;
  insert into zz124_results values (3, 'and cannot reach them through v2_assemble_kit either', 'refused', v_got);

  ------------------------------------------------- WHAT MUST STILL WORK AS anon
  -- ⛔ The signed-out buyer's cart. Without this row, "revoke everything from
  -- anon" would make rows 1-3 green and take every public catalogue down.
  begin
    perform wholesale_v2.v2_reserve_stock(
      '00000000-0000-4000-8000-000000124e01','00000000-0000-4000-8000-000000124100',
      2, gen_random_uuid(), null, 15);
    v_got := 'allowed';
  exception
    when insufficient_privilege then v_got := 'REFUSED — the signed-out cart is broken';
    when others then v_got := 'allowed';   -- reached the body; the grant is intact
  end;
  insert into zz124_results values (4, 'the signed-out buyer can still RESERVE stock', 'allowed', v_got);

  reset role;
end
$check$;

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zz124_results

  -- 5-7. The grants themselves, so a failure says WHICH way round it went
  --      rather than only that a call behaved oddly.
  union all select 5, 'none of the three is granted to anon', '0',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='wholesale_v2'
        and p.proname in ('v2_receive_stock','v2_decrement_stock','v2_assemble_kit')
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  union all select 6, 'none of the three is granted to PUBLIC either', '0',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='wholesale_v2'
        and p.proname in ('v2_receive_stock','v2_decrement_stock','v2_assemble_kit')
        and has_function_privilege('public', p.oid, 'EXECUTE'))

  -- A grant to PUBLIC is a grant to every role that will ever exist, including
  -- ones nobody has created yet, and it is how the anon grant arrived in the
  -- first place. Revoking it also takes the implicit grant off `authenticated`,
  -- so row 7 is the proof that the warehouse screens still work.
  union all select 7, 'all three are still granted to authenticated', '3',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='wholesale_v2'
        and p.proname in ('v2_receive_stock','v2_decrement_stock','v2_assemble_kit')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE'))

  -- 8. ⛔ THE RULE, BY BEHAVIOUR. Every function that writes an inventory row,
  --    or that calls one of the two that do, must be closed to anon -- except
  --    the reservation path, which is named here on purpose so that adding to
  --    the exception list is a deliberate act somebody has to type.
  union all select 8, 'NO other anon-callable function can change stock', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='wholesale_v2'
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and (p.prosrc ~* '(insert into|update)[[:space:]]+(wholesale_v2\.)?v2_inventory_(balances|movements)'
          or p.prosrc ~ 'v2_receive_stock' or p.prosrc ~ 'v2_decrement_stock')
        and p.proname not in ('v2_reserve_stock','v2_confirm_reservation','v2_release_reservation'))

  -- 9. and the other half of the same sentence, so a later "tidy the grants"
  --    pass cannot break the buyer's cart while row 8 stays green.
  union all select 9, 'the signed-out cart keeps all three reservation calls', '3',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='wholesale_v2'
        and p.proname in ('v2_reserve_stock','v2_confirm_reservation','v2_release_reservation')
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 10. the stock the fixture created is still there. If a refusal above were
  --     somehow not a refusal, the balance would read 9500 or 0, not 500.
  union all select 10, 'the warehouse still holds exactly what it started with', '500',
    (select coalesce(sum(qty_on_hand),0)::text from wholesale_v2.v2_inventory_balances
      where variant_id = '00000000-0000-4000-8000-000000124e01')
) r
order by ord;

rollback;
