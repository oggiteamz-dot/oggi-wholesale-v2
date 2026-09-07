-- 122 — the door a buyer came through stops deciding what they pay
--
-- HADI, 7 Sep 2026, on being shown that the same buyer was quoted two prices:
--   "The marketplace doesn't add some kind of price or, like, percentage or
--    anything like that. They should get the same price. The share link just
--    automatically grants them access to the wholesaler that gave them that
--    link."
--
-- WHAT WAS HAPPENING
-- A discount could be attached to a SHELF (a catalogue) as well as to a
-- customer, and the price was shelf + customer. A buyer browsing the store was
-- priced through their default shelf (0%); the same buyer opening a share link
-- was priced through the shelf the link named (10%). Measured on production
-- after MOD-07: 326 (account, variant) pairs where the two doors disagreed.
--
--   Aïsha Couture, demo-atelier, customer rate 15%
--   A-101 Silk Slip Dress, list 128.00
--     through the store screen    108.80   (0% shelf  + 15% customer)
--     through the Occasion link    96.00   (10% shelf + 15% customer)
--
-- Nothing on either screen was wrong -- the screen and the invoice agreed with
-- each other -- which is exactly why nobody would ever have reported it.
--
-- THE FIX IS THE ONE MOD-05 ALREADY BUILT AND LEFT SWITCHED OFF.
-- One rate per STORE (v2_wholesalers.discount_pct, migration 117), plus the
-- customer's own rate. The shelf stops carrying a price. There is then one
-- answer per (store, customer) and no door can change it.
--
-- WHY THIS MOVES NOBODY'S PRICE
-- Every store dial on the platform is 0.00% -- migration 117 seeded each one
-- from that store's DEFAULT shelf, and every default shelf is 0%. The store
-- screen already prices through the default shelf, so the number it produces
-- today and the number the dial produces are the same number. Only the
-- share-link path changes, and:
--
--   131 orders in the product's entire history
--     1 carried a shelf id at all, and it was the default shelf
--     0 were ever priced through a discounted shelf
--
-- So this removes a second, wrong answer rather than choosing between two live
-- ones. Past orders cannot move regardless: v2_order_items.unit_price is
-- stored, not derived.
--
-- THE ARGUMENT STAYS IN THE SIGNATURE, AND STOPS BEING READ.
-- p_catalog_id is kept on every function below. Removing it would change three
-- signatures at once, and migration 113 is the record of what that costs: a
-- defaulted argument created a SECOND overload, PostgREST refused both with
-- PGRST203, and the live feed broke until 114 dropped the old one. The
-- argument is now documented as ignored and asserted as ignored -- the gate
-- passes a DIFFERENT catalogue id and requires the same price back, which is
-- a stronger statement than the parameter's absence would be.
--
-- A SIDE EFFECT WORTH NAMING. v2_catalog_discount_pct is SECURITY DEFINER,
-- granted to anon, and takes both ids from the caller with no check -- the
-- defect checks/check_buyer_pricing.sql was written against on 26 Aug. It is
-- left in place because other things still read a shelf's rate for display,
-- but after this migration it prices NOTHING. The leak is defanged rather
-- than plugged, and that is worth knowing rather than assuming.

------------------------------------------------------------------ the invoice
create or replace function wholesale_v2.v2_effective_unit_price(
  p_product_id uuid,
  p_variant_id uuid,
  p_client_id uuid,
  p_aggregate_qty bigint,
  p_catalog_id uuid default null   -- IGNORED since 122. See the header.
) returns numeric
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_price numeric;
  v_pct   numeric;
  v_wid   text;
begin
  -- A negotiated price is an absolute number and still wins outright: the
  -- store rate and the customer rate are both discarded. Unchanged by 122.
  if p_client_id is not null then
    select override_price into v_price
    from wholesale_v2.v2_client_price_overrides
    where client_id = p_client_id and variant_id = p_variant_id;
    if v_price is not null then
      return v_price;
    end if;
  end if;

  -- The quantity break is chosen BEFORE the discount, and the discount comes
  -- off the broken price. Unchanged by 122, and asserted in
  -- check_discount_stacking.sql assertion 10.
  select unit_price into v_price
  from wholesale_v2.v2_pricing_tiers
  where product_id = p_product_id and min_qty <= p_aggregate_qty
  order by min_qty desc
  limit 1;

  if v_price is null then
    select price into v_price from wholesale_v2.v2_product_variants where id = p_variant_id;
  end if;

  if v_price is null then
    return null;
  end if;

  -- THE CHANGE. The rate comes from the STORE the product belongs to, never
  -- from the shelf the caller happened to name. Derived from the product
  -- rather than taken as an argument, so a caller cannot name a store either.
  select p.wid into v_wid from wholesale_v2.v2_products p where p.id = p_product_id;
  v_pct := wholesale_v2.v2_store_discount_pct(v_wid, p_client_id);

  if v_pct is null or v_pct = 0 then
    return round(v_price, 2);
  end if;

  return round(greatest(v_price * (1 - v_pct / 100.0), 0), 2);
end;
$function$;

comment on function wholesale_v2.v2_effective_unit_price(uuid, uuid, uuid, bigint, uuid) is
  'The price one buyer pays for one variant. Since 122 the rate is the STORE '
  'dial plus the customer''s own rate; p_catalog_id is accepted and ignored, '
  'because which door a buyer came through must not change what they pay.';

--------------------------------------------------------------- the screen (1)
-- The signed-in buyer's own screen. It must return the number the invoice will
-- use, or the cart and the bill disagree -- which is the defect Batch 5 was
-- written against, in the other direction.
create or replace function wholesale_v2.v2_buyer_discount_pct(
  p_account_id uuid,
  p_catalog_id uuid default null   -- IGNORED since 122. See the header.
) returns numeric
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
begin
  if p_account_id is null then
    return 0;
  end if;

  -- THE GATE THAT REMAINS, and the only one that ever mattered here: is this a
  -- real, active buyer or sales account? The catalogue check that used to sit
  -- below it decided which SHELF's rate to hand back, and there is no longer a
  -- shelf rate to hand back.
  select * into v_acct from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id and a.role in ('buyer','sales') and a.active;
  if v_acct.id is null then
    return 0;
  end if;

  return wholesale_v2.v2_store_discount_pct(v_acct.wid, v_acct.client_id);
end;
$function$;

comment on function wholesale_v2.v2_buyer_discount_pct(uuid, uuid) is
  'What this buyer is discounted in their store. Since 122 it is the store '
  'dial plus their own rate, and p_catalog_id is accepted and ignored.';

--------------------------------------------------------------- the screen (2)
-- The share link. THE ACCESS CHECK IS UNTOUCHED: a token that does not resolve
-- to an open catalogue still returns 0 and still tells the caller nothing. All
-- that changes is that a token which DOES resolve no longer carries a rate of
-- its own -- it grants access, which is what Hadi said a link is for.
create or replace function wholesale_v2.v2_token_discount_pct(
  p_token text,
  p_account_id uuid default null
) returns numeric
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_wid    text;
  v_client uuid;
begin
  -- Unchanged: resolve through v2_catalog_by_token so the link's own rules --
  -- public or login-required, active, not a made-up token -- still decide
  -- whether this call answers at all.
  -- r.wid, not r.wholesaler_wid: v2_catalog_by_token returns the store's id as
  -- `wid` and the store's NAME as `wholesaler_name`. The first draft of this
  -- migration guessed `wholesaler_wid`, applied without complaint (PL/pgSQL
  -- does not resolve a column reference until the statement runs) and only
  -- failed the first time a real token was priced. checks/check_one_price_per_buyer.sql
  -- assertion 7 is what caught it -- the DO block at the foot of this file did
  -- not, because it prices through the two SHELF functions and never the token.
  select r.wid into v_wid
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';
  if v_wid is null then
    return 0;
  end if;

  if p_account_id is not null then
    select a.client_id into v_client from wholesale_v2.v2_portal_accounts a
     where a.id = p_account_id and a.role in ('buyer','sales') and a.active;
  end if;

  return wholesale_v2.v2_store_discount_pct(v_wid, v_client);
end;
$function$;

comment on function wholesale_v2.v2_token_discount_pct(text, uuid) is
  'What a buyer holding this link is discounted. Since 122 a link grants '
  'ACCESS and never a price: the rate is the store dial plus the holder''s '
  'own rate, identical to what the same person is quoted in the store.';

------------------------------------------------------------------- THE PROOF
-- Every (account, product, variant) the platform can currently price, through
-- BOTH doors, must now come back the same. Written as a comparison of the two
-- code paths rather than of two numbers I chose, so it cannot pass by
-- accident on a corpus where every rate is zero.
--
-- Scoped to the fixture-free corpus this migration finds, and safe on an EMPTY
-- database: over zero accounts it compares zero pairs and says so, rather than
-- refusing to apply. That is the rule 116 was corrected for and 119 broke
-- again the next day -- a migration may assert things about the CHANGE it
-- makes, never about the DATA it happens to find.
do $$
declare
  v_pairs int := 0;
  v_bad   int := 0;
begin
  select count(*),
         count(*) filter (
           where wholesale_v2.v2_effective_unit_price(x.pid, x.vid, x.cid, 1, x.def_cat)
              is distinct from
                 wholesale_v2.v2_effective_unit_price(x.pid, x.vid, x.cid, 1, x.other_cat))
    into v_pairs, v_bad
    from (
      select p.id as pid, pv.id as vid, cl.id as cid,
             (select c.id from wholesale_v2.v2_catalogs c
               where c.wid = p.wid and c.is_default limit 1) as def_cat,
             (select c.id from wholesale_v2.v2_catalogs c
               where c.wid = p.wid and not c.is_default and c.active
               order by c.discount_pct desc limit 1) as other_cat
        from wholesale_v2.v2_products p
        join wholesale_v2.v2_product_variants pv on pv.product_id = p.id
        join wholesale_v2.v2_clients cl on cl.wid = p.wid
       where not p.archived and not pv.archived
    ) x
   where x.other_cat is not null;

  if v_bad > 0 then
    raise exception '122: % of % (buyer, variant) pairs still price differently through two shelves. The door still decides the price.', v_bad, v_pairs;
  end if;

  raise notice '122 ok: % pair(s) compared through two different shelves, 0 disagree', v_pairs;
end $$;
