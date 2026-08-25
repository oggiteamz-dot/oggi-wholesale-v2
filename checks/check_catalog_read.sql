-- =============================================================================
-- CHECK: v2_catalog_read — Batch S, gate S1
-- =============================================================================
-- What this proves: the buyer can still see the shop, and can see NOTHING
-- else. Both halves matter and only one of them is obvious. It is trivially
-- easy to close this leak by closing the shop; check_anon_scope.sh cannot tell
-- those apart, and this is the gate that can.
--
-- The rows below are, in order:
--   1-3   the shop works        — products, prices and live stock come back
--   4-7   the fence holds       — wrong tier, wrong wholesaler, dead token,
--                                 not-logged-in all return NOTHING
--   8     no cross-catalog bleed — a second catalog on the SAME wholesaler is
--                                 invisible, which is the ordinary case that
--                                 the cross-TENANT test would not catch
--   9     cost cannot come back — asserted against the function's return type,
--                                 not against a row, because a definer
--                                 function outranks the column revoke that
--                                 protects cost everywhere else (migration
--                                 031). This is the one thing here that no
--                                 amount of correct data would reveal.
--  10     a product with NO VARIANTS still appears — the LEFT JOIN. An inner
--                                 join makes a catalog_only product silently
--                                 VANISH from the buyer's catalogue, and
--                                 silent disappearance is this project's
--                                 recurring failure mode, not a hypothetical.
--  11-12  availability is LIVE — an EXPIRED cart hold must not suppress real
--                                 stock. This is the 20 Aug reservation leak,
--                                 which cost nine days of phantom holds on
--                                 production, guarded at its new call site.
--
-- Runs inside a rolled-back transaction, so it is safe against production.
--
--   psql "$DATABASE_URL" -f checks/check_catalog_read.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers        (wid, name) values ('zzread','Read Co')  on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzread','Read Co') on conflict (wid) do nothing;
insert into public.wholesalers        (wid, name) values ('zzrival','Rival Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzrival','Rival Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier)
values ('00000000-0000-4000-8000-0000000c3001','zzread','Tier 1 Shop', 1);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-0000000b3001','zzread','buyer','zzr1','x','00000000-0000-4000-8000-0000000c3001','T1',true),
       ('00000000-0000-4000-8000-0000000b3099','zzrival','buyer','zzriv','x',null,'RIVAL',true);

insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
values ('00000000-0000-4000-8000-0000000a3001','zzread','ZZ Shop Window', 1, true,  true,  'tok_read_public'),
       ('00000000-0000-4000-8000-0000000a3002','zzread','ZZ Held Back',   1, true,  true,  'tok_read_other'),
       ('00000000-0000-4000-8000-0000000a3003','zzread','ZZ Tier 5 Only', 5, true,  false, 'tok_read_t5'),
       ('00000000-0000-4000-8000-0000000a3004','zzread','ZZ Switched off',1, false, false, 'tok_read_off');

-- Three products. One ordinary with two variants, one that is IN A DIFFERENT
-- CATALOG of the same wholesaler, and one with no variants at all.
insert into wholesale_v2.v2_products (id, wid, name, selling_model, base_unit)
values ('00000000-0000-4000-8000-0000000d3001','zzread','Shown Tee',     'open', 12),
       ('00000000-0000-4000-8000-0000000d3002','zzread','Held Back Tee', 'open', null),
       ('00000000-0000-4000-8000-0000000d3003','zzread','Coming Soon',   'open', null);

-- ⚠️ THE REFUSED CATALOGS ARE DELIBERATELY STOCKED.
--
-- They were empty in the first draft of this file, and every one of rows 4-7
-- passed while the security gate was ripped out entirely -- because an empty
-- catalog returns zero rows whether it is fenced or wide open. The gate was
-- asserting nothing and reading green, which is the same defect as
-- check_selling_model_setup on 23 Aug: a test that describes an accident
-- instead of a rule.
--
-- With products in them, zero rows can only mean the gate refused. Do not
-- "tidy" these inserts away.
insert into wholesale_v2.v2_catalog_products (catalog_id, product_id, sort_order, highlighted) values
  ('00000000-0000-4000-8000-0000000a3001','00000000-0000-4000-8000-0000000d3001', 10, false),
  ('00000000-0000-4000-8000-0000000a3001','00000000-0000-4000-8000-0000000d3003', 20, false),
  ('00000000-0000-4000-8000-0000000a3002','00000000-0000-4000-8000-0000000d3002', 10, false),
  ('00000000-0000-4000-8000-0000000a3003','00000000-0000-4000-8000-0000000d3001', 10, false),
  ('00000000-0000-4000-8000-0000000a3003','00000000-0000-4000-8000-0000000d3002', 20, false),
  ('00000000-0000-4000-8000-0000000a3004','00000000-0000-4000-8000-0000000d3001', 10, false);

-- cost is set on purpose. If it ever appears in the output, row 9 is the only
-- thing standing between that and every buyer's screen.
insert into wholesale_v2.v2_product_variants (id, product_id, sku, price, cost, extra_attrs)
values ('00000000-0000-4000-8000-0000000e3001','00000000-0000-4000-8000-0000000d3001','ZZ-RED-M',  20.00, 7.00, '{"color":"Red","size":"M"}'),
       ('00000000-0000-4000-8000-0000000e3002','00000000-0000-4000-8000-0000000d3001','ZZ-RED-L',  20.00, 7.00, '{"color":"Red","size":"L"}'),
       ('00000000-0000-4000-8000-0000000e3099','00000000-0000-4000-8000-0000000d3002','ZZ-HIDDEN', 99.00, 1.00, '{"color":"Blue","size":"M"}');

insert into wholesale_v2.v2_locations (id, wid, name, is_default)
values ('00000000-0000-4000-8000-0000000f3001','zzread','Main', true);

insert into wholesale_v2.v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved)
values ('00000000-0000-4000-8000-0000000e3001','00000000-0000-4000-8000-0000000f3001', 100, 40),
       ('00000000-0000-4000-8000-0000000e3002','00000000-0000-4000-8000-0000000f3001',  50,  0);

-- 40 units "reserved" by a cart that died an hour ago. The stored counter says
-- 40. The truth is zero. Row 11 is the difference.
-- id is GENERATED ALWAYS; let the sequence issue it rather than fighting it.
insert into wholesale_v2.v2_stock_reservations (variant_id, location_id, qty, cart_id, expires_at, status)
values ('00000000-0000-4000-8000-0000000e3001','00000000-0000-4000-8000-0000000f3001', 40,
        '00000000-0000-4000-8000-00000000cc01', now() - interval '1 hour', 'active');

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict from (

  -- 1-3: the shop works
  select 'a public link returns the catalog''s products' as label, '2' as expected,
         (select count(distinct product_id)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null)) as got
  union all select 'prices come back with them', '20.00',
         (select to_char(max(price),'FM990.00')
            from wholesale_v2.v2_catalog_read('tok_read_public', null))
  union all select 'the wholesaler''s own settings ride along (base_unit)', '12',
         (select max(base_unit)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null))

  -- 4-7: the fence
  union all select 'a tier 1 buyer opening a TIER 5 link gets nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_catalog_read('tok_read_t5','00000000-0000-4000-8000-0000000b3001'))
  union all select 'a buyer of ANOTHER wholesaler gets nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_catalog_read('tok_read_t5','00000000-0000-4000-8000-0000000b3099'))
  union all select 'a switched-off catalog gets nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_catalog_read('tok_read_off','00000000-0000-4000-8000-0000000b3001'))
  union all select 'a made-up token gets nothing', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_read('tok_nonsense', null))

  -- 8: no bleed between two catalogs of the SAME wholesaler
  union all select 'a product held back in another catalog stays invisible', '0',
         (select count(*)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null)
           where sku = 'ZZ-HIDDEN')

  -- 9: cost cannot come back in through a definer function
  union all select 'cost is not in the return type at all', 'absent',
         (select case when count(*) = 0 then 'absent' else 'LEAKED' end
            from information_schema.parameters
           where specific_schema = 'wholesale_v2'
             and specific_name like 'v2_catalog_read%'
             and parameter_name = 'cost')

  -- 10: the LEFT JOIN. A product with no colours yet must not disappear.
  union all select 'a product with NO variants still appears', '1',
         (select count(*)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null)
           where product_name = 'Coming Soon' and variant_id is null)

  -- 11-12: availability is live, not the stored counter
  union all select 'an EXPIRED hold does not suppress real stock', '100',
         (select max(total_available)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null)
           where sku = 'ZZ-RED-M')
  union all select 'and on-hand is reported truthfully beside it', '100',
         (select max(total_on_hand)::text
            from wholesale_v2.v2_catalog_read('tok_read_public', null)
           where sku = 'ZZ-RED-M')

  -- ==== S2b: the SIGNED-IN path. Every catalog on production is private, so
  -- this is the path buyers actually use -- and the 23 Aug plan did not
  -- mention it at all. ====

  union all select 'a signed-in buyer sees their catalog''s products', '2',
         (select count(distinct product_id)::text
            from wholesale_v2.v2_buyer_catalog_read(
              '00000000-0000-4000-8000-0000000b3001',
              '00000000-0000-4000-8000-0000000a3001'))
  union all select 'with prices, exactly as the link path gives them', '20.00',
         (select to_char(max(price),'FM990.00')
            from wholesale_v2.v2_buyer_catalog_read(
              '00000000-0000-4000-8000-0000000b3001',
              '00000000-0000-4000-8000-0000000a3001'))
  -- The catalog exists, is stocked, and belongs to the RIGHT wholesaler --
  -- it is simply above this buyer's tier. Zero rows can only be the gate.
  union all select 'a catalog above the buyer''s tier gives nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_buyer_catalog_read(
              '00000000-0000-4000-8000-0000000b3001',
              '00000000-0000-4000-8000-0000000a3003'))
  union all select 'another wholesaler''s account gets nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_buyer_catalog_read(
              '00000000-0000-4000-8000-0000000b3099',
              '00000000-0000-4000-8000-0000000a3001'))
  union all select 'a switched-off catalog gives nothing here too', '0',
         (select count(*)::text
            from wholesale_v2.v2_buyer_catalog_read(
              '00000000-0000-4000-8000-0000000b3001',
              '00000000-0000-4000-8000-0000000a3004'))
  union all select 'a null account id gives nothing', '0',
         (select count(*)::text
            from wholesale_v2.v2_buyer_catalog_read(
              null, '00000000-0000-4000-8000-0000000a3001'))

  -- ==== The one that protects the whole batch ====
  --
  -- v2__catalog_rows takes a catalog id and checks NOTHING. It is safe only
  -- because it is callable solely from inside the two gated functions, which
  -- run as definer. One `grant execute ... to anon` on it hands every catalog
  -- on the platform to anyone who can guess a uuid -- and undoes Batch S in a
  -- single line, silently, with every other assertion here still green.
  union all select 'the ungated internal reader is granted to NOBODY', 'ungranted',
         (select case when count(*) = 0 then 'ungranted' else 'GRANTED — DANGER' end
            from pg_proc pr
            join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname = 'wholesale_v2'
             and pr.proname = 'v2__catalog_rows'
             and (has_function_privilege('anon',          pr.oid, 'EXECUTE')
               or has_function_privilege('authenticated', pr.oid, 'EXECUTE')))
) r;

rollback;
