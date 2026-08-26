-- =============================================================================
-- CHECK: v2_catalog_packs / v2_buyer_catalog_packs / v2_buyer_pack — Batch S, S3
-- =============================================================================
-- Three of the four selling models can ONLY be ordered as a pack. For those
-- products the pack IS the buy button, so "can this buyer see the packs" and
-- "can this buyer order at all" are the same question.
--
-- ROW 1 IS THE ONE THAT MATTERS. It is a regression guard for a real defect
-- found on 26 Aug 2026: js/views/buyer.js:745, the SHARE LINK view, passed
-- `packs: []` to every card — always, unconditionally. The card then printed
-- "This product has no bundles set up yet, so it cannot be ordered. Ask the
-- wholesaler to add one." The wholesaler HAD set one up. Counted on production
-- the same day: 13 of 23 live products across five of six wholesalers, dead on
-- the one channel the product is built around.
--
-- That bug was invisible to every gate in this repo because nothing asserted
-- that a buyer holding a LINK can see a pack. Row 1 does.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_catalog_packs.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers        (wid, name) values ('zzpack','Pack Co')  on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzpack','Pack Co') on conflict (wid) do nothing;
insert into public.wholesalers        (wid, name) values ('zzpriv','Rival Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzpriv','Rival Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier)
values ('00000000-0000-4000-8000-0000000c4001','zzpack','Pack Shop', 1);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-0000000b4001','zzpack','buyer','zzp1','x','00000000-0000-4000-8000-0000000c4001','P1',true),
       ('00000000-0000-4000-8000-0000000b4099','zzpriv','buyer','zzpr','x',null,'RIVAL',true);

insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
values ('00000000-0000-4000-8000-0000000a4001','zzpack','ZZ Pack Window', 1, true, true,  'tok_pack_public'),
       ('00000000-0000-4000-8000-0000000a4002','zzpack','ZZ Pack T5',     5, true, false, 'tok_pack_t5');

-- A PREPACK product: unorderable without a pack. This is the shape that broke.
insert into wholesale_v2.v2_products (id, wid, name, selling_model)
values ('00000000-0000-4000-8000-0000000d4001','zzpack','Boxed Tee','prepack'),
       ('00000000-0000-4000-8000-0000000d4002','zzpack','Empty Box Tee','prepack');

insert into wholesale_v2.v2_catalog_products (catalog_id, product_id, sort_order) values
  ('00000000-0000-4000-8000-0000000a4001','00000000-0000-4000-8000-0000000d4001', 10),
  ('00000000-0000-4000-8000-0000000a4001','00000000-0000-4000-8000-0000000d4002', 20),
  -- The tier-5 catalog is deliberately STOCKED, so that zero rows from it can
  -- only mean the gate refused. An empty catalog would pass while wide open.
  ('00000000-0000-4000-8000-0000000a4002','00000000-0000-4000-8000-0000000d4001', 10);

insert into wholesale_v2.v2_product_variants (id, product_id, sku, price, cost, extra_attrs)
values ('00000000-0000-4000-8000-0000000e4001','00000000-0000-4000-8000-0000000d4001','ZZP-S', 10.00, 3.00, '{"color":"Red","size":"S"}'),
       ('00000000-0000-4000-8000-0000000e4002','00000000-0000-4000-8000-0000000d4001','ZZP-M', 10.00, 3.00, '{"color":"Red","size":"M"}'),
       ('00000000-0000-4000-8000-0000000e4003','00000000-0000-4000-8000-0000000d4001','ZZP-L', 10.00, 3.00, '{"color":"Red","size":"L"}');

-- pack_price is set on purpose. If it ever appears in the output, row 5 is all
-- that stands between the wholesaler's margin structure and a competitor.
insert into wholesale_v2.v2_pack_definitions (id, product_id, wid, name, color, pack_price, source, archived)
values ('00000000-0000-4000-8000-0000000f4001','00000000-0000-4000-8000-0000000d4001','zzpack','Full box','Red', 99.00, 'manual', false),
       -- a pack with NO components yet: must still come back, not vanish
       ('00000000-0000-4000-8000-0000000f4002','00000000-0000-4000-8000-0000000d4002','zzpack','Not filled in',null, null, 'manual', false);

insert into wholesale_v2.v2_pack_components (pack_id, variant_id, qty_per_pack) values
  ('00000000-0000-4000-8000-0000000f4001','00000000-0000-4000-8000-0000000e4001', 2),
  ('00000000-0000-4000-8000-0000000f4001','00000000-0000-4000-8000-0000000e4002', 3),
  ('00000000-0000-4000-8000-0000000f4001','00000000-0000-4000-8000-0000000e4003', 1);

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict from (

  -- 1. THE REGRESSION GUARD for the 26 Aug link bug.
  select 'a buyer holding a LINK can see the pack (the 26 Aug bug)' as label, '3' as expected,
         (select count(*)::text from wholesale_v2.v2_catalog_packs('tok_pack_public', null)
           where pack_name = 'Full box') as got
  union all select 'and the box adds up to the pieces the wholesaler set', '6',
         (select sum(qty_per_pack)::text from wholesale_v2.v2_catalog_packs('tok_pack_public', null)
           where pack_name = 'Full box')
  -- Asserts the SET of sizes, deliberately order-independent.
  --
  -- ⚠️ KNOWN DEFECT, PRE-EXISTING, NOT INTRODUCED HERE. Pack components are
  -- ordered ALPHABETICALLY by size — in this function and, since Batch 7, in
  -- js/data/prepacks.js (`(a.size||"").localeCompare(b.size||"")`, lines 59 and
  -- 100). So a box of S/M/L renders on the buyer card as "1×L/3×M/2×S", and a
  -- numeric range of 8/10/12 renders as 10/12/8.
  --
  -- This assertion does NOT pin the alphabetical order, because a test that
  -- goes red the day somebody FIXES the ordering is a test that will be deleted
  -- rather than read — the same mistake as the two assertions rewritten in
  -- check_billboard_and_highlights on 25 Aug. It pins what actually matters to
  -- correctness: every component of the box comes back, exactly once.
  --
  -- The ordering itself needs the wholesaler's own size sequence (v2_size_ratios,
  -- migration 061) rather than the alphabet. Reported to Hadi 26 Aug; not fixed
  -- here because this batch is about who may READ, not about display order.
  union all select 'every size in the box comes back, exactly once', 'L,M,S',
         (select string_agg(extra_attrs->>'size', ',' order by (extra_attrs->>'size'))
            from wholesale_v2.v2_catalog_packs('tok_pack_public', null)
           where pack_name = 'Full box' and extra_attrs->>'size' in ('S','M','L'))
  union all select 'and their unit price, which is what the buyer is charged', '10.00',
         (select to_char(max(unit_price),'FM990.00') from wholesale_v2.v2_catalog_packs('tok_pack_public', null))

  -- 5. pack_price must never cross the boundary. Asserted on the return TYPE,
  --    because a definer function outranks every grant that protects it.
  union all select 'pack_price is not in the return type at all', 'absent',
         (select case when count(*) = 0 then 'absent' else 'LEAKED' end
            from information_schema.parameters
           where specific_schema = 'wholesale_v2'
             and (specific_name like 'v2_catalog_packs%'
               or specific_name like 'v2_buyer_catalog_packs%'
               or specific_name like 'v2_buyer_pack%'
               or specific_name like 'v2__catalog_pack_rows%')
             and parameter_name = 'pack_price')

  -- 6. the fence
  union all select 'a tier 1 buyer opening the TIER 5 link gets no packs', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_packs('tok_pack_t5','00000000-0000-4000-8000-0000000b4001'))
  union all select 'another wholesaler''s buyer gets no packs', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_packs('tok_pack_t5','00000000-0000-4000-8000-0000000b4099'))
  union all select 'a made-up token gets no packs', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_packs('tok_nonsense', null))

  -- 9. the signed-in path agrees with the link path
  union all select 'the signed-in path returns the same box', '3',
         (select count(*)::text from wholesale_v2.v2_buyer_catalog_packs(
            '00000000-0000-4000-8000-0000000b4001','00000000-0000-4000-8000-0000000a4001')
           where pack_name = 'Full box')
  union all select 'a catalog above the buyer''s tier gives no packs', '0',
         (select count(*)::text from wholesale_v2.v2_buyer_catalog_packs(
            '00000000-0000-4000-8000-0000000b4001','00000000-0000-4000-8000-0000000a4002'))

  -- 11. a pack with no components must APPEAR, not vanish. A vanished pack is
  --     indistinguishable from the bug this batch exists to fix.
  union all select 'a pack with nothing in it still appears (not vanished)', '1',
         (select count(*)::text from wholesale_v2.v2_catalog_packs('tok_pack_public', null)
           where pack_name = 'Not filled in' and variant_id is null)

  -- 12. reorder
  union all select 'reorder: the buyer''s own pack comes back', '3',
         (select count(*)::text from wholesale_v2.v2_buyer_pack(
            '00000000-0000-4000-8000-0000000b4001','00000000-0000-4000-8000-0000000f4001'))
  union all select 'reorder: another wholesaler''s buyer gets nothing', '0',
         (select count(*)::text from wholesale_v2.v2_buyer_pack(
            '00000000-0000-4000-8000-0000000b4099','00000000-0000-4000-8000-0000000f4001'))
  union all select 'reorder: a null account gets nothing', '0',
         (select count(*)::text from wholesale_v2.v2_buyer_pack(
            null,'00000000-0000-4000-8000-0000000f4001'))

  -- 15. the internal reader stays unreachable
  union all select 'the ungated pack reader is granted to NOBODY', 'ungranted',
         (select case when count(*) = 0 then 'ungranted' else 'GRANTED — DANGER' end
            from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname = 'wholesale_v2' and pr.proname = 'v2__catalog_pack_rows'
             and (has_function_privilege('anon', pr.oid, 'EXECUTE')
               or has_function_privilege('authenticated', pr.oid, 'EXECUTE')))
) r;

rollback;
