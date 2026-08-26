-- =============================================================================
-- CHECK: buyer pricing through the gate — Batch S, S4
-- =============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE, proven live on 26 Aug 2026 from the app's
-- own origin, signed out, with the key that ships in the bundle:
--
--   v2_catalog_discount_pct(p_catalog_id, p_client_id) is SECURITY DEFINER,
--   granted to anon, and takes BOTH IDS FROM THE CALLER with no check.
--
--     AMANI Stores (sq)     -> 10.00
--     CEDAR Shops (sq)      ->  5.00
--     Boutique Farah (test) -> 10.00
--     catalog 'test432'     -> -5.00   <- a price INCREASE, documented as
--                                          "invisible to the buyer by design"
--
-- The negative one needs NO guessing: a buyer holds their own client id in
-- their session, so one call tells them they are being marked up.
--
-- ROW 2 IS THE STRUCTURAL ONE. It asserts the replacement takes no client id
-- AT ALL — not that it refuses a bad one. A gate you can pass the wrong
-- argument to is a gate someone will pass the wrong argument to; the fix is
-- for the argument not to exist. Same lesson as migration 048.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_buyer_pricing.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers        (wid, name) values ('zzprc','Price Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzprc','Price Co') on conflict (wid) do nothing;
insert into public.wholesalers        (wid, name) values ('zzriv2','Rival Two') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzriv2','Rival Two') on conflict (wid) do nothing;

-- Two clients with DIFFERENT negotiated terms. The whole point is that one
-- must never be able to read the other's.
insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier, discount_pct)
values ('00000000-0000-4000-8000-0000000c5001','zzprc','Generous Terms', 1, 10.00),
       ('00000000-0000-4000-8000-0000000c5002','zzprc','Ordinary Terms', 1,  0.00);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-0000000b5001','zzprc','buyer','zzq1','x','00000000-0000-4000-8000-0000000c5001','G',true),
       ('00000000-0000-4000-8000-0000000b5002','zzprc','buyer','zzq2','x','00000000-0000-4000-8000-0000000c5002','O',true),
       ('00000000-0000-4000-8000-0000000b5003','zzprc','buyer','zzq3','x','00000000-0000-4000-8000-0000000c5001','X',false),
       ('00000000-0000-4000-8000-0000000b5099','zzriv2','buyer','zzrv','x',null,'RIVAL',true);

-- A catalogue with a hidden MARKUP (negative), customer_only mode.
insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token, discount_pct, discount_mode)
values ('00000000-0000-4000-8000-0000000a5001','zzprc','ZZ Priced',   1, true, true,  'tok_price',    0.00, 'combine'),
       ('00000000-0000-4000-8000-0000000a5002','zzprc','ZZ Markup',   1, true, true,  'tok_markup',  -5.00, 'catalog_only'),
       ('00000000-0000-4000-8000-0000000a5003','zzprc','ZZ Tier 5',   5, true, false, 'tok_prc_t5',  20.00, 'catalog_only');

insert into wholesale_v2.v2_products (id, wid, name, selling_model)
values ('00000000-0000-4000-8000-0000000d5001','zzprc','Tiered Tee','open'),
       -- A SECOND product with its OWN, different breaks, deliberately NOT in
       -- the catalogue under test. Without it, a join that ignores product_id
       -- entirely returns the same two rows and the leak is undetectable —
       -- exactly the false green a one-product fixture gave on 26 Aug.
       ('00000000-0000-4000-8000-0000000d5002','zzprc','Other Tee','open');

insert into wholesale_v2.v2_catalog_products (catalog_id, product_id, sort_order) values
  ('00000000-0000-4000-8000-0000000a5001','00000000-0000-4000-8000-0000000d5001', 10),
  -- the tier-5 catalogue is deliberately STOCKED, so zero can only mean refusal
  ('00000000-0000-4000-8000-0000000a5003','00000000-0000-4000-8000-0000000d5001', 10);

insert into wholesale_v2.v2_pricing_tiers (product_id, min_qty, unit_price)
values ('00000000-0000-4000-8000-0000000d5001', 12, 9.00),
       ('00000000-0000-4000-8000-0000000d5001', 48, 8.00),
       -- the other product's breaks. If these ever appear in a result for the
       -- catalogue under test, the query has stopped scoping by product.
       ('00000000-0000-4000-8000-0000000d5002', 6, 77.00);

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict from (

  -- 1. the buyer gets their OWN terms
  select 'a buyer gets their own negotiated discount' as label, '10.00' as expected,
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5001',
            '00000000-0000-4000-8000-0000000a5001'),'FM990.00')) as got

  -- 2. ⛔ THE STRUCTURAL ASSERTION. Not "it refuses a wrong client id" —
  --    there is no client id to pass. The argument does not exist.
  union all select 'the buyer discount function takes NO client id', 'absent',
         (select case when count(*) = 0 then 'absent' else 'STILL TAKES ONE' end
            from information_schema.parameters
           where specific_schema='wholesale_v2'
             and specific_name like 'v2_buyer_discount_pct%'
             and parameter_name ilike '%client%')

  -- 3. two buyers of the SAME wholesaler get their own numbers, not each other's
  union all select 'a different buyer gets their own, lower terms', '0.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5002',
            '00000000-0000-4000-8000-0000000a5001'),'FM990.00'))

  -- 4. the hidden MARKUP still applies to the buyer who is on that catalogue --
  --    it is real pricing, and hiding it from the app would make the cart
  --    disagree with the invoice. What changes is that only THEY can read it.
  union all select 'the catalogue markup still reaches the right buyer', '-5.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5002',
            '00000000-0000-4000-8000-0000000a5002'),'FM990.00'))

  -- 5-7. the fence
  union all select 'a catalogue above the buyer''s tier contributes nothing', '10.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5001',
            '00000000-0000-4000-8000-0000000a5003'),'FM990.00'))
  union all select 'a DEACTIVATED account gets nothing', '0.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5003',
            '00000000-0000-4000-8000-0000000a5001'),'FM990.00'))
  union all select 'an unknown account gets nothing', '0.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-00000000dead',
            '00000000-0000-4000-8000-0000000a5001'),'FM990.00'))
  union all select 'a rival''s buyer gets nothing from this catalogue', '0.00',
         (select to_char(wholesale_v2.v2_buyer_discount_pct(
            '00000000-0000-4000-8000-0000000b5099',
            '00000000-0000-4000-8000-0000000a5001'),'FM990.00'))

  -- 9. ONE arithmetic rule. The gated function must agree exactly with the
  --    function the server itself uses, or the cart and the invoice drift.
  union all select 'it agrees exactly with the server''s own pricing rule', 'agree',
         (select case when wholesale_v2.v2_buyer_discount_pct(
                          '00000000-0000-4000-8000-0000000b5001',
                          '00000000-0000-4000-8000-0000000a5001')
                       = wholesale_v2.v2_catalog_discount_pct(
                          '00000000-0000-4000-8000-0000000a5001',
                          '00000000-0000-4000-8000-0000000c5001')
                     then 'agree' else 'DRIFTED' end)

  -- 10-13. quantity breaks
  union all select 'a link buyer sees the quantity breaks', '2',
         (select count(*)::text from wholesale_v2.v2_catalog_tiers('tok_price', null))
  union all select 'and they are the wholesaler''s own numbers', '9.00,8.00',
         (select string_agg(to_char(unit_price,'FM990.00'), ',' order by min_qty)
            from wholesale_v2.v2_catalog_tiers('tok_price', null))
  union all select 'a tier-5 catalogue gives a tier-1 buyer no breaks', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_tiers(
            'tok_prc_t5','00000000-0000-4000-8000-0000000b5001'))
  union all select 'a made-up token gives no breaks', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_tiers('tok_nonsense', null))
  union all select 'another product''s breaks never appear in this catalogue', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_tiers('tok_price', null)
           where unit_price = 77.00)
  union all select 'the signed-in path returns the same breaks', '2',
         (select count(*)::text from wholesale_v2.v2_buyer_catalog_tiers(
            '00000000-0000-4000-8000-0000000b5001','00000000-0000-4000-8000-0000000a5001'))

  -- 15. the internal reader stays unreachable
  union all select 'the ungated tier reader is granted to NOBODY', 'ungranted',
         (select case when count(*) = 0 then 'ungranted' else 'GRANTED — DANGER' end
            from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname='wholesale_v2' and pr.proname='v2__catalog_tier_rows'
             and (has_function_privilege('anon', pr.oid, 'EXECUTE')
               or has_function_privilege('authenticated', pr.oid, 'EXECUTE')))
) r;

rollback;
