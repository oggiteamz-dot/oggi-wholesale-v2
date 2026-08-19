-- =============================================================================
-- 053 — CUSTOMER TIERS, CATALOG DISCOUNTS, AND THE ONE PLACE PRICE IS DECIDED
-- =============================================================================
-- 19 Aug 2026. Hadi, on the catalog builder: "they will create the title and
-- they will create the tier... what kind of customer can see this catalog, and
-- anyone above that tier gets it. In addition to that they will create the
-- discount level... they can even put in a negative discount, basically
-- increase the price."
--
-- And on how it meets the customer's own rate: "there's a button that allows
-- them to say, combine their preset discount and the catalog discount, or
-- apply only the catalog discount, or apply only the customer's preset
-- discount. And if there's a customer that doesn't have a preset discount,
-- it's basically 0%, then it automatically activates the catalog's discount."
--
-- -----------------------------------------------------------------------
-- WHY THE PRICE RULE IS A FUNCTION AND NOT A FEW LINES OF JAVASCRIPT
-- -----------------------------------------------------------------------
-- v2_submit_order does not trust any price the browser sends. It re-prices
-- every line itself through v2_effective_unit_price and writes THAT into
-- v2_order_items. So a discount implemented only in the front end produces a
-- cart that disagrees with the invoice, and nothing looks broken until a
-- customer queries their bill. The rule therefore lives here, once, and the
-- JavaScript mirrors it under a check that runs the same worked examples
-- through both.
--
-- -----------------------------------------------------------------------
-- "TIER" ALREADY MEANT SOMETHING ELSE IN THIS SCHEMA
-- -----------------------------------------------------------------------
-- v2_pricing_tiers is QUANTITY BREAKS -- buy 50+, pay this. What is being
-- added here is a customer ACCESS LEVEL. Two different things called "tier" in
-- one schema is how someone eventually applies the wrong one, so the new
-- column is access_tier and the quantity ones keep the name they have.
--
-- -----------------------------------------------------------------------
-- v2_clients.discount_pct HAS EXISTED SINCE MIGRATION 006 AND DONE NOTHING
-- -----------------------------------------------------------------------
-- The client form captures it, the client list prints "10% discount", the
-- owner console reports on it, and the login RPC returns it into the session.
-- No pricing path has ever read it. A customer set to 10% has been paying full
-- price, on screen and on the invoice, for the life of v2. This migration is
-- where that column starts being true.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. What a catalog now carries
-- ---------------------------------------------------------------------
alter table wholesale_v2.v2_catalogs
  add column if not exists access_tier smallint not null default 1,
  -- Negative is a supported input, not an accident to defend against: -10
  -- means this catalog sells at 110% of list. The bound is -100..100 because
  -- -100 already doubles the price and +100 already gives it away; anything
  -- outside that is a typo, and a typo in a price column is expensive.
  add column if not exists discount_pct numeric(6,2) not null default 0,
  add column if not exists discount_mode text not null default 'combine';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_catalogs_access_tier_range') then
    alter table wholesale_v2.v2_catalogs
      add constraint v2_catalogs_access_tier_range check (access_tier between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'v2_catalogs_discount_range') then
    alter table wholesale_v2.v2_catalogs
      add constraint v2_catalogs_discount_range check (discount_pct between -100 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'v2_catalogs_discount_mode_known') then
    alter table wholesale_v2.v2_catalogs
      add constraint v2_catalogs_discount_mode_known
      check (discount_mode in ('combine', 'catalog_only', 'customer_only'));
  end if;
end $$;

comment on column wholesale_v2.v2_catalogs.access_tier is
  'Customer access level required to SEE this catalog. A catalog at tier 2 is visible to tier-2 customers and everyone above. Nothing to do with v2_pricing_tiers, which is quantity breaks.';
comment on column wholesale_v2.v2_catalogs.discount_pct is
  'Applied silently to every product in this catalog. Never shown to the buyer as a discount -- the adjusted number simply IS the price they see. Negative raises the price.';
comment on column wholesale_v2.v2_catalogs.discount_mode is
  'How this catalog meets the customer own rate: combine (additive), catalog_only (ignore the customer preset), customer_only (ignore this catalog discount, unless the customer sits at 0%).';

-- ---------------------------------------------------------------------
-- 2. What a customer now carries
-- ---------------------------------------------------------------------
-- Default 1, deliberately. Every existing customer lands on the bottom rung
-- and every existing catalog is a tier 1 catalog, so on the day this ships
-- nobody sees more OR less than they saw yesterday. Raising someone is an act,
-- not a side effect of a migration.
alter table wholesale_v2.v2_clients
  add column if not exists access_tier smallint not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_clients_access_tier_range') then
    alter table wholesale_v2.v2_clients
      add constraint v2_clients_access_tier_range check (access_tier between 1 and 5);
  end if;
end $$;

comment on column wholesale_v2.v2_clients.access_tier is
  'Set by hand by the wholesaler. Decides which catalogs this customer can see: their tier and everything below it.';

-- ---------------------------------------------------------------------
-- 3. Which catalog an order came through
-- ---------------------------------------------------------------------
-- A product can sit in two catalogs at different discounts, so "what was this
-- line worth" has no answer without knowing which catalog the buyer was
-- looking at. on delete set null rather than cascade: deleting a catalog must
-- never delete the orders placed through it.
alter table wholesale_v2.v2_orders
  add column if not exists catalog_id uuid
  references wholesale_v2.v2_catalogs(id) on delete set null;

create index if not exists v2_orders_by_catalog
  on wholesale_v2.v2_orders (catalog_id) where catalog_id is not null;

comment on column wholesale_v2.v2_orders.catalog_id is
  'The catalog this order was placed through. Recorded because the catalog decides the discount, so without it a past line total cannot be explained.';

-- ---------------------------------------------------------------------
-- 4. Grants — one column at a time, as migration 045 established
-- ---------------------------------------------------------------------
-- 045 revoked the blanket grants on v2_catalogs and named every column, so
-- that adding a sensitive column later would be a decision to publish it
-- rather than a side effect. That only holds if new columns are added to the
-- list deliberately -- which is what this block is. anon still gets nothing.
grant select (access_tier, discount_pct, discount_mode) on wholesale_v2.v2_catalogs to authenticated;
grant insert (access_tier, discount_pct, discount_mode) on wholesale_v2.v2_catalogs to authenticated;
grant update (access_tier, discount_pct, discount_mode) on wholesale_v2.v2_catalogs to authenticated;

grant select (access_tier) on wholesale_v2.v2_clients to authenticated;
grant insert (access_tier) on wholesale_v2.v2_clients to authenticated;
grant update (access_tier) on wholesale_v2.v2_clients to authenticated;

-- ---------------------------------------------------------------------
-- 5. THE STACKING RULE — one function, so it cannot be two rules
-- ---------------------------------------------------------------------
-- Returns the total percentage to take off the price. Positive discounts,
-- negative raises.
--
--   combine        catalog + customer, ADDITIVE. 5% and 20% is 25% off the
--                  original, not 5% then 20% of what is left. That was
--                  explicit: "they combine into 25%."
--   catalog_only   the customer's preset is skipped. What a clearance range
--                  priced to the bone needs.
--   customer_only  the catalog's own discount is skipped -- EXCEPT for a
--                  customer sitting at 0%, who would otherwise pay full list.
--                  "If there's a customer that doesn't have a preset discount,
--                  it's basically 0%, then it automatically activates the
--                  catalog's discount."
--
-- SECURITY DEFINER because buyers run as anon and cannot read v2_catalogs or
-- v2_clients at all (045 revoked anon entirely). It takes ids and returns a
-- number -- it exposes no row, and no name, to the caller.
create or replace function wholesale_v2.v2_catalog_discount_pct(
  p_catalog_id uuid,
  p_client_id  uuid
) returns numeric
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_cat_pct  numeric;
  v_mode     text;
  v_cust_pct numeric;
begin
  if p_catalog_id is not null then
    select discount_pct, discount_mode into v_cat_pct, v_mode
    from wholesale_v2.v2_catalogs where id = p_catalog_id;
  end if;

  if p_client_id is not null then
    select discount_pct into v_cust_pct
    from wholesale_v2.v2_clients where id = p_client_id;
  end if;

  -- A missing row leaves these NULL, and NULL arithmetic would silently
  -- swallow the whole discount rather than failing. Migration 049 was written
  -- because a NULL read as "not false" at a call site; the lesson generalises.
  v_cat_pct  := coalesce(v_cat_pct, 0);
  v_cust_pct := coalesce(v_cust_pct, 0);
  v_mode     := coalesce(v_mode, 'combine');

  if v_mode = 'catalog_only' then
    return v_cat_pct;
  elsif v_mode = 'customer_only' then
    return case when v_cust_pct = 0 then v_cat_pct else v_cust_pct end;
  else
    return v_cat_pct + v_cust_pct;
  end if;
end;
$$;

revoke all on function wholesale_v2.v2_catalog_discount_pct(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_discount_pct(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. The price itself
-- ---------------------------------------------------------------------
-- The old 4-argument version is DROPPED, not replaced. `create or replace`
-- does not replace a function whose parameter list changed -- Postgres treats
-- a different signature as a separate overload and leaves both in place, which
-- is exactly what happened in migration 010 and broke every call with a
-- PostgREST "ambiguous overload" error. The new parameter carries a default,
-- so existing 4-argument callers keep resolving to this one and simply get no
-- catalog discount.
drop function if exists wholesale_v2.v2_effective_unit_price(uuid, uuid, uuid, bigint);

create or replace function wholesale_v2.v2_effective_unit_price(
  p_product_id    uuid,
  p_variant_id    uuid,
  p_client_id     uuid,
  p_aggregate_qty bigint,
  p_catalog_id    uuid default null
) returns numeric
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_price numeric;
  v_pct   numeric;
begin
  -- 1. A hand-typed negotiated price wins outright, and NOTHING here touches
  --    it. That is a number somebody agreed with a customer; a catalog-level
  --    margin dial has no business quietly moving it. (This mechanism is not
  --    part of the catalog design -- per-product-per-customer pricing does not
  --    scale past a few dozen customers -- but it exists in the schema and on
  --    the salesperson's screen, so it needs a stated position, not silence.)
  if p_client_id is not null then
    select override_price into v_price
    from wholesale_v2.v2_client_price_overrides
    where client_id = p_client_id and variant_id = p_variant_id;
    if v_price is not null then
      return v_price;
    end if;
  end if;

  -- 2. Otherwise the best quantity break for what is actually in the order,
  --    else the variant's list price.
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

  -- 3. Then the discounts, on whatever price that turned out to be. Hadi:
  --    "no matter what the price is on the actual product, it will apply a 5%
  --    discount."
  v_pct := wholesale_v2.v2_catalog_discount_pct(p_catalog_id, p_client_id);

  if v_pct is null or v_pct = 0 then
    return round(v_price, 2);
  end if;

  -- greatest(..., 0) because combine mode can add two large discounts past
  -- 100% and a negative unit price is not a thing that should ever reach an
  -- invoice. It is a floor, not a rounding trick: hitting it means somebody
  -- typed two discounts that together give the goods away, which is a
  -- decision they made, and free is where it stops.
  return round(greatest(v_price * (1 - v_pct / 100.0), 0), 2);
end;
$$;

revoke all on function wholesale_v2.v2_effective_unit_price(uuid, uuid, uuid, bigint, uuid) from public;
grant execute on function wholesale_v2.v2_effective_unit_price(uuid, uuid, uuid, bigint, uuid) to anon, authenticated;
