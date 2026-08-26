-- ============================================================================
-- 084 — Batch S / S5 (the last one): the cart's price lookup
--
-- The very last table read the buyer app makes.
--
-- js/data/catalog.js -> getVariantListPrices(variantIds) reads
-- v2_product_variants directly. The CART needs it: a cart line stores the price
-- it was priced AT -- discount and quantity break already applied -- so
-- re-pricing from that number would apply them twice. The list price is the
-- only correct input, and the authoritative copy is the variant row.
--
-- Everything else on the buyer path moved in S1-S4. This is what is left, and
-- S7 cannot revoke the table grants until it is gone: the cart would price
-- every line from a stale localStorage figure instead.
--
-- Gated on the variant belonging to a product in a catalogue this account may
-- see. A variant they may not see is simply ABSENT from the result, which the
-- caller already handles -- it falls back to the line's own stored listPrice.
-- Silence is the honest answer here, not an error.
-- ============================================================================

create or replace function wholesale_v2.v2_buyer_list_prices(
  p_account_id  uuid,
  p_variant_ids uuid[]
)
returns table (variant_id uuid, price numeric)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  if p_account_id is null or p_variant_ids is null or array_length(p_variant_ids, 1) is null then
    return;
  end if;

  return query
  select distinct v.id, v.price
    from wholesale_v2.v2_product_variants v
    join wholesale_v2.v2_products p
      on p.id = v.product_id and not p.archived
    join wholesale_v2.v2_catalog_products cp
      on cp.product_id = p.id
    join wholesale_v2.v2_buyer_catalogs(p_account_id) bc
      on bc.id = cp.catalog_id
   where v.id = any(p_variant_ids)
     and not v.archived;
end;
$fn$;

comment on function wholesale_v2.v2_buyer_list_prices(uuid, uuid[]) is
  'Batch S/S5. List prices for cart lines, scoped to variants this account may actually see. The last buyer-side table read to move; S7 could not revoke the variant grant until this existed.';

revoke all on function wholesale_v2.v2_buyer_list_prices(uuid, uuid[]) from public;
grant execute on function wholesale_v2.v2_buyer_list_prices(uuid, uuid[]) to anon, authenticated;
