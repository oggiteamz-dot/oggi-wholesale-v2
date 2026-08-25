-- ============================================================================
-- 081 — Batch S / S2b: the SIGNED-IN buyer reads through the gate too
--
-- WHY THIS EXISTS, AND WHY THE 23 AUG RESEARCH MISSED IT
--
-- Batch S was written around the share token, because that is the path
-- everybody talks about. There is a second one. A buyer signed into a portal
-- account browses through v2_buyer_catalogs + v2_buyer_catalog_products --
-- and those return PRODUCT IDS, exactly like the token pair did, feeding the
-- same getCatalog(wid) whole-tenant table read.
--
-- Measured on production 25 Aug 2026: ALL TEN catalogs are private and none
-- is public. So this is not the minor path. It is the one every buyer on the
-- system actually uses. Revoking at S7 without moving it would take every
-- signed-in buyer blank.
--
-- ONE QUERY, NOT TWO
--
-- 080 put the SELECT inside v2_catalog_read. Copying it here would leave two
-- copies of the buyer's view of a product, in two functions, gated
-- differently -- and the one nobody is looking at would drift. So the SELECT
-- moves into v2__catalog_rows() and both entry points call it. This mirrors
-- what shapeVariant()/shapeProduct() do on the JS side, for the same reason.
--
-- ⛔ v2__catalog_rows TAKES A CATALOG ID AND CHECKS NOTHING.
--
-- That is deliberate, and it is why it is granted to NOBODY. It is reachable
-- only from inside the two gated functions, which run as the definer and can
-- therefore call it when anon cannot. The double underscore marks it as
-- internal.
--
-- **If a future migration grants execute on v2__catalog_rows to anon or
-- authenticated, it hands every catalog on the platform to anyone who can
-- guess a uuid, and undoes this entire batch in one line.** There is no
-- legitimate reason to grant it. checks/check_catalog_read.sql asserts it
-- stays ungranted.
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. The shared body. Internal. No grants. See the warning above.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2__catalog_rows(p_catalog_id uuid)
returns table (
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
  total_on_hand    numeric,
  total_reserved   numeric,
  total_available  numeric
)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select
    p.id, p.name, p.description, p.category, p.created_at,
    p.selling_model, p.ratio_curve, p.moq_qty, p.moq_reorder_qty,
    p.base_unit, p.moq_per_colour, p.catalog_only,
    cp.highlighted, cp.sort_order,
    v.id, v.sku, v.price, v.compare_at_price, v.retail_price,
    v.extra_attrs, v.moq_qty, v.barcode, v.image_url, v.images,
    -- Cast, do not inherit: v2_inventory_by_variant aggregates an INTEGER
    -- column, so sum() returns bigint. See 080 for the full note.
    inv.total_on_hand::numeric,
    inv.total_reserved::numeric,
    inv.total_available::numeric
  from wholesale_v2.v2_catalog_products cp
  join wholesale_v2.v2_products p
    on p.id = cp.product_id and not p.archived
  -- ⚠️ LEFT JOIN: a catalog_only product, or one whose colours are not added
  -- yet, must still APPEAR (un-orderable) rather than vanish. See 080.
  left join wholesale_v2.v2_product_variants v
    on v.product_id = p.id and not v.archived
  -- ⚠️ v2_inventory_by_variant, never v2_inventory_balances -- the table's
  -- qty_reserved counter ignores expires_at. That is the 20 Aug leak.
  left join wholesale_v2.v2_inventory_by_variant inv
    on inv.variant_id = v.id
  where cp.catalog_id = p_catalog_id
  order by cp.highlighted desc, cp.sort_order, cp.added_at, v.id;
$fn$;

comment on function wholesale_v2.v2__catalog_rows(uuid) is
  'INTERNAL. Batch S. The buyer view of one catalog, WITH NO GATE. Granted to nobody on purpose: it is callable only from inside v2_catalog_read and v2_buyer_catalog_read, which run as definer. Granting this to anon or authenticated hands every catalog on the platform to anyone who can guess a uuid.';

revoke all on function wholesale_v2.v2__catalog_rows(uuid) from public;
revoke all on function wholesale_v2.v2__catalog_rows(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The token entry point, now delegating. Behaviour is unchanged --
--    check_catalog_read.sql's twelve rows must still pass untouched.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_catalog_read(
  p_token      text,
  p_account_id uuid default null
)
returns table (
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
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';

  if v_cat_id is null then
    return;
  end if;

  return query select * from wholesale_v2.v2__catalog_rows(v_cat_id);
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_read(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_read(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. The signed-in entry point. NEW.
--
-- Takes ONLY the account id and the catalog the buyer says they are looking
-- at. There is no wid parameter and no token, because the strongest question
-- a signed-in buyer can ask is "what may I see", and the gate answers it from
-- the validated account row. Same shape and same reasoning as
-- v2_buyer_catalog_products (055) and v2_buyer_price_overrides.
--
-- The gate is v2_buyer_catalogs(p_account_id) -- the identical test 055
-- applies -- so a buyer who guesses a catalog id gets nothing, exactly as
-- they do today.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_buyer_catalog_read(
  p_account_id uuid,
  p_catalog_id uuid
)
returns table (
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
  total_on_hand    numeric,
  total_reserved   numeric,
  total_available  numeric
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  -- The gate is re-applied HERE, not assumed from the caller having been
  -- shown the catalog. Copied in intent, not by trust, from 055.
  if p_account_id is null or p_catalog_id is null then
    return;
  end if;

  if not exists (
    select 1 from wholesale_v2.v2_buyer_catalogs(p_account_id) bc
     where bc.id = p_catalog_id
  ) then
    return;
  end if;

  return query select * from wholesale_v2.v2__catalog_rows(p_catalog_id);
end;
$fn$;

comment on function wholesale_v2.v2_buyer_catalog_read(uuid, uuid) is
  'Batch S/S2b. What a SIGNED-IN buyer may see in one catalog, gate re-checked from the validated account row. The path the 23 Aug research missed -- and with every catalog on production private, the path buyers actually use.';

revoke all on function wholesale_v2.v2_buyer_catalog_read(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_catalog_read(uuid, uuid) to anon, authenticated;
