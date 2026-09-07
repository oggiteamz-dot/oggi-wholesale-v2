-- =============================================================================
-- CHECK: one price per buyer, whichever door they came through — migration 122
-- =============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE, measured live on 7 Sep 2026:
-- 326 (account, variant) pairs where the same buyer was quoted two different
-- prices for the same shirt depending on which link they opened.
--
--   Aïsha Couture, demo-atelier, customer rate 15%
--   A-101 Silk Slip Dress, list 128.00
--     through the store screen    108.80   (0% shelf  + 15% customer)
--     through the Occasion link    96.00   (10% shelf + 15% customer)
--
-- HADI, on being shown it: "It shouldn't. No. The marketplace doesn't add some
-- kind of price or, like, percentage or anything like that. They should get the
-- same price. The share link just automatically grants them access to the
-- wholesaler that gave them that link."
--
-- SO: a link grants ACCESS and never a price. Migration 122 points all three
-- pricing functions at the STORE dial. This file is the proof, and it is
-- written so it CANNOT pass on a fixture where every rate is zero -- that is
-- how "the two doors agree" could otherwise be green while meaning nothing.
--
-- THE NUMBERS ARE DELIBERATELY ALL DIFFERENT
--   store dial       7.00      the only rate that may reach a price
--   customer A      11.00      -> 18.00 total, 82.00 on a 100.00 shirt
--   customer B       0.00      ->  7.00 total, 93.00
--   deep shelf      10.00      must contribute NOTHING (18 never 28, never 10)
--   markup shelf    -5.00      must contribute NOTHING (18 never 13, never 6)
--   tier-5 shelf    20.00      must contribute NOTHING (18 never 38, never 20)
-- Every wrong answer any earlier version of this code could give is a
-- DIFFERENT number from every right one, so no assertion here can be satisfied
-- by an accident of arithmetic.
--
-- Runs inside a rolled-back transaction; safe against production.
--   psql "$DATABASE_URL" -f checks/check_one_price_per_buyer.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers          (wid, name) values ('zz122','Door Co')  on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name, discount_pct, discount_mode)
values ('zz122','Door Co', 7.00, 'combine') on conflict (wid) do update
   set discount_pct = 7.00, discount_mode = 'combine';
insert into public.wholesalers          (wid, name) values ('zz122r','Rival Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name, discount_pct, discount_mode)
values ('zz122r','Rival Co', 0.00, 'combine') on conflict (wid) do update
   set discount_pct = 0.00, discount_mode = 'combine';

insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier, discount_pct)
values ('00000000-0000-4000-8000-000000122c01','zz122','Customer A', 1, 11.00),
       ('00000000-0000-4000-8000-000000122c02','zz122','Customer B', 1,  0.00);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-000000122b01','zz122', 'buyer','zz122a','x','00000000-0000-4000-8000-000000122c01','A',true),
       ('00000000-0000-4000-8000-000000122b02','zz122', 'buyer','zz122b','x','00000000-0000-4000-8000-000000122c02','B',true),
       ('00000000-0000-4000-8000-000000122b99','zz122r','buyer','zz122r','x',null,'RIVAL',true);

-- Four shelves, four different rates, so "the shelf contributed nothing" is a
-- claim about four numbers rather than about one that happened to be zero.
-- The store already HAS a default shelf: creating a wholesaler creates one, and
-- v2_catalogs_one_default refuses a second. So the default is adopted rather
-- than inserted -- taking the fixture's id so the assertions below can name it.
update wholesale_v2.v2_catalogs
   set id = '00000000-0000-4000-8000-000000122a00',
       name = 'Everything', active = true, is_public = true,
       share_token = 'tok122_def', discount_pct = 0.00, discount_mode = 'combine'
 where wid = 'zz122' and is_default;

insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token, discount_pct, discount_mode, is_default)
values ('00000000-0000-4000-8000-000000122a01','zz122','Deep',       1, true, true,  'tok122_deep', 10.00, 'catalog_only',  false),
       ('00000000-0000-4000-8000-000000122a02','zz122','Markup',     1, true, true,  'tok122_up',   -5.00, 'customer_only', false),
       ('00000000-0000-4000-8000-000000122a03','zz122','Tier5',      5, true, false, 'tok122_t5',   20.00, 'catalog_only',  false);

insert into wholesale_v2.v2_products (id, wid, name, selling_model)
values ('00000000-0000-4000-8000-000000122d01','zz122','Door Shirt','open');

insert into wholesale_v2.v2_product_variants (id, product_id, sku, price)
values ('00000000-0000-4000-8000-000000122e01','00000000-0000-4000-8000-000000122d01','ZZ122-M', 100.00),
       ('00000000-0000-4000-8000-000000122e02','00000000-0000-4000-8000-000000122d01','ZZ122-L', 100.00);

-- A quantity break, so assertion 14 can prove the ORDER of operations survived.
insert into wholesale_v2.v2_pricing_tiers (product_id, min_qty, unit_price)
values ('00000000-0000-4000-8000-000000122d01', 12, 80.00);

-- A negotiated price on the SECOND variant only, so it proves an override wins
-- without hiding the ordinary path on the first.
insert into wholesale_v2.v2_client_price_overrides (client_id, variant_id, override_price)
values ('00000000-0000-4000-8000-000000122c01','00000000-0000-4000-8000-000000122e02', 71.00);

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict from (

  ------------------------------------------------------------ THE STORE SCREEN
  -- 1-4. The same buyer, four different shelves, one rate. Written as four
  -- separate rows rather than one equality, so a failure says WHICH shelf
  -- leaked rather than only that something did.
  select 'the default shelf quotes the store rate' as label, '18.00' as expected,
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b01',
           '00000000-0000-4000-8000-000000122a00'),'FM990.00') as got

  union all select 'a 10% shelf adds nothing (not 28.00, not 10.00)', '18.00',
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b01',
           '00000000-0000-4000-8000-000000122a01'),'FM990.00')

  union all select 'a -5% MARKUP shelf takes nothing away (not 13.00, not 6.00)', '18.00',
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b01',
           '00000000-0000-4000-8000-000000122a02'),'FM990.00')

  union all select 'a 20% shelf adds nothing (not 38.00, not 20.00)', '18.00',
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b01',
           '00000000-0000-4000-8000-000000122a03'),'FM990.00')

  -- 5. and the same claim as a COMPARISON of the two code paths, so it stays
  --    true on a day somebody changes the fixture's numbers.
  union all select 'the deepest and the shallowest shelf agree with each other', 'agree',
         case when wholesale_v2.v2_buyer_discount_pct(
                     '00000000-0000-4000-8000-000000122b01',
                     '00000000-0000-4000-8000-000000122a00')
                 = wholesale_v2.v2_buyer_discount_pct(
                     '00000000-0000-4000-8000-000000122b01',
                     '00000000-0000-4000-8000-000000122a03')
              then 'agree' else 'THE DOOR STILL DECIDES' end

  -- 6. THE DIAL IS ACTUALLY BEING READ. Without this row, a function that
  --    returned the customer's rate alone would satisfy every row above.
  union all select 'the STORE dial is in the number, not just the customer''s rate', '7.00',
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b02',
           '00000000-0000-4000-8000-000000122a01'),'FM990.00')

  -------------------------------------------------------------- THE SHARE LINK
  -- 7-9. The other door. Same buyer, same answer.
  union all select 'a share link quotes the same rate as the store screen', '18.00',
         to_char(wholesale_v2.v2_token_discount_pct(
           'tok122_deep','00000000-0000-4000-8000-000000122b01'),'FM990.00')

  union all select 'the store screen and the share link agree', 'agree',
         case when wholesale_v2.v2_token_discount_pct(
                     'tok122_deep','00000000-0000-4000-8000-000000122b01')
                 = wholesale_v2.v2_buyer_discount_pct(
                     '00000000-0000-4000-8000-000000122b01',
                     '00000000-0000-4000-8000-000000122a00')
              then 'agree' else 'THE TWO DOORS STILL DISAGREE' end

  union all select 'a signed-out visitor on a public link gets the store rate only', '7.00',
         to_char(wholesale_v2.v2_token_discount_pct('tok122_deep', null),'FM990.00')

  -- 10-12. ⛔ THE ACCESS CHECK IS UNTOUCHED. 122 changed what a link is worth,
  --        not who may open it. These are the rows that turn red if somebody
  --        "simplifies" the token function now that it no longer reads a rate.
  union all select 'a private link still refuses a signed-out visitor', '0.00',
         to_char(wholesale_v2.v2_token_discount_pct('tok122_t5', null),'FM990.00')
  union all select 'a private link still refuses another wholesaler''s buyer', '0.00',
         to_char(wholesale_v2.v2_token_discount_pct(
           'tok122_t5','00000000-0000-4000-8000-000000122b99'),'FM990.00')
  union all select 'a made-up token still answers nothing', '0.00',
         to_char(wholesale_v2.v2_token_discount_pct('tok122_nonsense', null),'FM990.00')

  -- 13. a rival's buyer gets their OWN store's dial (0.00), never this one (7.00)
  union all select 'a rival''s buyer never picks up this store''s dial', '0.00',
         to_char(wholesale_v2.v2_buyer_discount_pct(
           '00000000-0000-4000-8000-000000122b99',
           '00000000-0000-4000-8000-000000122a00'),'FM990.00')

  ----------------------------------------------------------------- THE INVOICE
  -- 14-17. The screen is a promise; this is the bill. 100.00 less 18% = 82.00
  --        through every shelf id anyone could name, including one belonging
  --        to a DIFFERENT WHOLESALER and one that does not exist -- because
  --        the rate is derived from the product, so a caller cannot name a
  --        store either.
  union all select 'the invoice charges the store rate', '82.00',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e01',
           '00000000-0000-4000-8000-000000122c01', 1,
           '00000000-0000-4000-8000-000000122a00'),'FM990.00')
  union all select 'and the same through the 10% shelf (not 72.00)', '82.00',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e01',
           '00000000-0000-4000-8000-000000122c01', 1,
           '00000000-0000-4000-8000-000000122a01'),'FM990.00')
  union all select 'and the same through a shelf id that is not even this store''s', '82.00',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e01',
           '00000000-0000-4000-8000-000000122c01', 1,
           '00000000-0000-4000-8000-00000000dead'),'FM990.00')
  union all select 'and the same when no shelf is named at all', '82.00',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e01',
           '00000000-0000-4000-8000-000000122c01', 1, null),'FM990.00')

  -- 18. THE ORDER OF OPERATIONS SURVIVED. The break is chosen first and the
  --     discount comes off the broken price: 80.00 less 18% = 65.60, not
  --     100.00 less 18% then broken (82.00) and not the break alone (80.00).
  union all select 'the quantity break is still chosen before the discount', '65.60',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e01',
           '00000000-0000-4000-8000-000000122c01', 12,
           '00000000-0000-4000-8000-000000122a00'),'FM990.00')

  -- 19. a negotiated price is absolute and still beats every rate
  union all select 'a negotiated price still wins outright', '71.00',
         to_char(wholesale_v2.v2_effective_unit_price(
           '00000000-0000-4000-8000-000000122d01','00000000-0000-4000-8000-000000122e02',
           '00000000-0000-4000-8000-000000122c01', 1,
           '00000000-0000-4000-8000-000000122a01'),'FM990.00')

  ------------------------------------------------------------- THE SHAPE (113)
  -- 20-21. p_catalog_id is IGNORED, and must nonetheless still EXIST. Migration
  --        113 added a defaulted argument to v2_marketplace_feed, which created
  --        a second overload rather than replacing the first; PostgREST refused
  --        both with PGRST203 and the live feed broke until 114 dropped the old
  --        one. Deleting the ignored argument here would repeat that exactly.
  union all select 'the invoice function still ACCEPTS a shelf id (PGRST203)', 'present',
         (select case when count(*) = 1 then 'present' else 'CHANGED' end
            from information_schema.parameters
           where specific_schema='wholesale_v2'
             and specific_name like 'v2_effective_unit_price%'
             and parameter_name = 'p_catalog_id')
  union all select 'and there is exactly one of each pricing function', '1,1,1',
         (select string_agg(n::text, ',' order by nm) from (
            select p.proname as nm, count(*) as n
              from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname='wholesale_v2'
               and p.proname in ('v2_effective_unit_price','v2_buyer_discount_pct','v2_token_discount_pct')
             group by p.proname) q)
) r;

rollback;
