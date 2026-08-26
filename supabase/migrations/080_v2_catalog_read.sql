-- ============================================================================
-- 080 — Batch S / S1: v2_catalog_read()
--
-- THE DEFECT THIS EXISTS TO FIX
--
-- v2_catalog_products_by_token() returns a list of product IDs and nothing
-- else. The app then calls getCatalog(wid), which reads v2_products,
-- v2_product_variants and v2_inventory_by_variant DIRECTLY, for the whole
-- wholesaler, and filters down to those ids in the browser
-- (js/views/buyer.js:701-704).
--
-- So the token gate is real for WHICH PRODUCTS GET DRAWN, and absent for
-- WHICH PRODUCTS THE DATABASE WILL HAND OVER. Measured on production on
-- 25 Aug 2026, signed out, with the publishable key that ships in the app:
-- 23 products, 264 variants, 143 stock rows, across SIX DIFFERENT
-- WHOLESALERS. checks/check_anon_scope.sh is that measurement, kept.
--
-- THE FIX, IN ONE SENTENCE: the token function returns the rows, not the ids.
--
-- WHAT THIS MIGRATION DOES **NOT** DO
--
-- It revokes nothing. Not one grant changes here. This function goes live,
-- the app moves onto it, a real order is placed through it, and only THEN
-- does the revoke land (S7, its own migration). Revoking first would take
-- every catalogue on the platform blank in the same second, with no error a
-- buyer could report except "it's empty".
--
-- SECURITY DEFINER, AND WHY THE GATE IS RE-CHECKED INSIDE
--
-- Definer rights bypass RLS by definition -- that is the whole reason this
-- works for a caller who has no identity. A definer function that trusts its
-- caller is therefore a BIGGER hole than the one being closed. So the token
-- is re-resolved here, in this function, rather than trusted from the caller
-- having resolved it a moment ago. Someone who skips straight to this
-- function gains exactly nothing. Same reasoning, same shape, as
-- v2_catalog_products_by_token (056) and v2_public_wholesaler (042).
--
-- WHAT IS DELIBERATELY ABSENT FROM THE RETURN
--
--   cost          the wholesaler's buying price. Revoked from anon at COLUMN
--                 level by migration 031 and that revoke works. It must not
--                 come back in through the front door of a definer function
--                 that outranks the revoke.
--   wid           the buyer already knows whose link they opened; returning
--                 it per row adds nothing and invites a join.
--   supplier_id   who supplies it is the wholesaler's business, not the
--                 buyer's.
--   by_location   which warehouse holds what is internal. The buyer needs one
--                 number: can I have it.
--
-- ONE ROW PER VARIANT, WITH THE PRODUCT COLUMNS REPEATED
--
-- The client assembles the nested shape anyway (see getCatalog). A flat join
-- is one round trip instead of three, and PostgREST returns it directly.
--
-- ⚠️ LEFT JOIN on variants, on purpose. A catalog_only product, or one whose
-- colours have not been added yet, has NO variants -- an inner join would
-- make it VANISH from the buyer's catalogue, which is precisely the class of
-- silent disappearance this project keeps getting bitten by. Such a product
-- comes back with variant_id null and the card renders it as un-orderable,
-- which is the truth.
--
-- ⚠️ Availability comes from v2_inventory_by_variant, which migration 064
-- rebuilt to derive reserved stock from holds that are actually alive. Do NOT
-- "simplify" this to v2_inventory_balances: that table's qty_reserved counter
-- is never checked against expires_at, and reading it is how the reservation
-- leak comes back.
-- ============================================================================

create or replace function wholesale_v2.v2_catalog_read(
  p_token      text,
  p_account_id uuid default null
)
returns table (
  -- product
  product_id       uuid,
  product_name     text,
  description      text,
  category         text,
  created_at       timestamptz,
  selling_model    text,
  ratio_curve      jsonb,
  moq_qty          int,
  moq_reorder_qty  int,
  base_unit        int,
  moq_per_colour   int,
  catalog_only     boolean,
  highlighted      boolean,
  sort_order       int,
  -- variant (null for a product that has none yet -- see the LEFT JOIN note)
  variant_id       uuid,
  sku              text,
  price            numeric,
  compare_at_price numeric,
  retail_price     numeric,
  extra_attrs      jsonb,
  variant_moq_qty  int,
  barcode          text,
  image_url        text,
  images           jsonb,
  -- availability, live
  total_on_hand    numeric,
  total_reserved   numeric,
  total_available  numeric
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_cat_id uuid;
begin
  -- The gate, re-applied here. Not trusted from the caller.
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';

  -- No catalog, wrong tier, wrong wholesaler, dead link, or not logged in for
  -- a private one: all return nothing. An empty result cannot confirm that
  -- something was there, which is the same reason v2_catalog_by_token gives
  -- 'not_found' for a switched-off catalog as for one that never existed.
  if v_cat_id is null then
    return;
  end if;

  return query
  select
    p.id,
    p.name,
    p.description,
    p.category,
    p.created_at,
    p.selling_model,
    p.ratio_curve,
    p.moq_qty,
    p.moq_reorder_qty,
    p.base_unit,
    p.moq_per_colour,
    p.catalog_only,
    cp.highlighted,
    cp.sort_order,
    v.id,
    v.sku,
    v.price,
    v.compare_at_price,
    v.retail_price,
    v.extra_attrs,
    v.moq_qty,
    v.barcode,
    v.image_url,
    v.images,
    -- Cast, do not inherit. v2_inventory_by_variant aggregates an INTEGER
    -- column, so sum() hands back bigint; declaring numeric and returning
    -- bigint fails at run time with "structure of query does not match
    -- function result type", which is a deploy-day error, not a compile-time
    -- one. Casting here pins the contract to this function rather than to the
    -- view's internals, so a later change to the balance column's type cannot
    -- silently change what this returns.
    inv.total_on_hand::numeric,
    inv.total_reserved::numeric,
    inv.total_available::numeric
  from wholesale_v2.v2_catalog_products cp
  join wholesale_v2.v2_products p
    on p.id = cp.product_id
   and not p.archived
  left join wholesale_v2.v2_product_variants v
    on v.product_id = p.id
   and not v.archived
  left join wholesale_v2.v2_inventory_by_variant inv
    on inv.variant_id = v.id
  where cp.catalog_id = v_cat_id
  -- The ordering is the database's, not the client's: "no matter what order
  -- they put them in, always the highlighted items will be on the top" is a
  -- property of the catalog, and a second sort in JS is a second place for it
  -- to be wrong.
  order by cp.highlighted desc, cp.sort_order, cp.added_at, v.id;
end;
$fn$;

comment on function wholesale_v2.v2_catalog_read(text, uuid) is
  'Batch S/S1. Every product, buyer-safe variant column and live availability for EXACTLY ONE catalog, gate re-checked inside. Replaces the getCatalog(wid) table reads on the buyer path. Never returns cost, wid, supplier_id or by_location.';

revoke all on function wholesale_v2.v2_catalog_read(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_read(text, uuid) to anon, authenticated;
