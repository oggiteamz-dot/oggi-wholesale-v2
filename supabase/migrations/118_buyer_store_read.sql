-- 118 — MOD-04: a granted buyer sees the whole STORE, not one catalogue
--
-- THE BUG, MEASURED ON PRODUCTION
-- js/views/buyer.js:100 takes visibleCatalogs[0] and there is no switcher, so
-- a buyer sees exactly ONE of the catalogues they are entitled to. Account
-- `nadia` at demo-atelier is entitled to 10 products and can reach 7. The
-- three she cannot reach are A-102, A-109 and A-110 -- Atelier's hand-beaded
-- made-to-order gowns, the most valuable line in that store. Unreported
-- because nobody has walked that account.
--
-- WHAT THIS DOES NOT DO, DELIBERATELY
-- Only the product LIST widens. Packs, price tiers, the discount lookup and
-- v2_submit_order all keep taking the catalogue the client already sends, so
-- NO PRODUCT THAT IS ORDERABLE TODAY CHANGES PRICE. That is the whole safety
-- argument, and it holds because v2_buyer_catalogs orders `is_default desc`
-- -- visibleCatalogs[0] is the DEFAULT catalogue, whose dial is 0.00% on every
-- wholesaler on the platform.
--
-- THE GATE IS NOT WIDENED EITHER. This calls v2_buyer_catalogs(p_account_id),
-- the same function the per-catalogue read gates on, which applies the account
-- check AND the tier ceiling (c.access_tier <= client tier). A buyer can only
-- ever see the union of catalogues they could already open one at a time.
-- Dropping the tier gate is a separate, deliberate decision (D2) and is NOT
-- smuggled in here.
--
-- DEDUPE. A product in two catalogues must appear ONCE. The row kept is the
-- one from the EARLIEST catalogue in v2_buyer_catalogs order -- i.e. the
-- default -- so its sort_order and `highlighted` are the merchandising the
-- wholesaler set on their main shelf, not whatever a secondary catalogue said.
--
-- Verified on production for account nadia/demo-atelier before this was
-- written: 150 raw rows -> 90 after dedupe, 10 products (was 7), and all 60
-- rows she sees today are preserved verbatim from the default catalogue.

create or replace function wholesale_v2.v2_buyer_store_read(p_account_id uuid)
returns table(
  product_id uuid, product_name text, description text, category text,
  created_at timestamp with time zone, selling_model text, ratio_curve jsonb,
  moq_qty integer, moq_reorder_qty integer, base_unit integer,
  moq_per_colour integer, catalog_only boolean, highlighted boolean,
  sort_order integer, variant_id uuid, sku text, price numeric,
  compare_at_price numeric, retail_price numeric, extra_attrs jsonb,
  variant_moq_qty integer, barcode text, image_url text, images jsonb,
  total_on_hand numeric, total_reserved numeric, total_available numeric
)
language plpgsql stable security definer
set search_path to 'wholesale_v2','public'
as $function$
begin
  -- Same guard shape as v2_buyer_catalog_read: a null account returns nothing
  -- rather than raising, so a signed-out caller looks like an empty store
  -- instead of confirming that anything is there.
  if p_account_id is null then
    return;
  end if;

  return query
  with cats as (
    -- THE GATE. Not re-implemented here on purpose -- re-deriving "which
    -- catalogues may this account see" in a second place is how the two
    -- answers drift apart, and the day they do, the wider one wins silently.
    select bc.id, row_number() over () as rk
      from wholesale_v2.v2_buyer_catalogs(p_account_id) bc
  ),
  raw as (
    select r.*, c.rk
      from cats c
      cross join lateral wholesale_v2.v2__catalog_rows(c.id) r
  ),
  dedup as (
    select distinct on (raw.product_id, raw.variant_id) raw.*
      from raw
     order by raw.product_id, raw.variant_id, raw.rk
  )
  select d.product_id, d.product_name, d.description, d.category, d.created_at,
         d.selling_model, d.ratio_curve, d.moq_qty, d.moq_reorder_qty,
         d.base_unit, d.moq_per_colour, d.catalog_only, d.highlighted,
         d.sort_order, d.variant_id, d.sku, d.price, d.compare_at_price,
         d.retail_price, d.extra_attrs, d.variant_moq_qty, d.barcode,
         d.image_url, d.images, d.total_on_hand, d.total_reserved,
         d.total_available
    from dedup d
   order by d.rk, d.sort_order nulls last, d.product_name, d.variant_id;
end;
$function$;

comment on function wholesale_v2.v2_buyer_store_read(uuid) is
  'MOD-04. Every product across every catalogue this buyer may see, deduped, '
  'default catalogue winning. Gated by v2_buyer_catalogs -- same account check '
  'and same tier ceiling as the per-catalogue read.';

grant execute on function wholesale_v2.v2_buyer_store_read(uuid) to anon, authenticated;

-- The production run of this migration also asserted, for every active buyer
-- and sales account, that the store read is a strict SUPERSET of what that
-- account can see today and contains no duplicated (product, variant). That
-- loop is NOT repeated here: on a fresh replay there are no accounts, so it
-- would pass over zero rows and read as evidence when it is none. The claim is
-- earned in checks/check_buyer_store_read.sql, which brings its own fixture.
--
-- Live result at apply time: 6 accounts gained products, 0 rows lost,
-- 0 duplicated.
