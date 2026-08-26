-- ============================================================================
-- 082 — Batch S / S3: packs through the gate
--
-- WHY PACKS ARE NOT AN OPTIONAL EXTRA
--
-- Three of the four selling models — series, prepack and ratio — can ONLY be
-- ordered as a pack. v2_enforce_selling_model refuses loose lines for them, and
-- since 15 Aug the product card hides the per-size stepper entirely for such a
-- product, because offering a control the server will reject is worse than
-- offering none.
--
-- So for those products the pack IS the buy button. Move the read path without
-- moving packs and 13 of the 23 products live on production today become
-- unbuyable.
--
-- ⛔ A BUG THIS ALSO FIXES, found 26 Aug while writing it.
--
-- js/views/buyer.js:745 — the SHARE LINK view — passed `packs: []` to every
-- product card. Not "the packs it could find": an empty list, always. The card
-- then took its documented branch for a bundle-only product with no packs and
-- printed:
--
--     "This product has no bundles set up yet, so it cannot be ordered.
--      Ask the wholesaler to add one."
--
-- The wholesaler had added one. The link view never asked. Counted against
-- production the same day: 13 of 23 live products (8 prepack, 4 ratio,
-- 1 series) across FIVE of the six wholesalers, un-orderable on the one
-- channel the whole product is built around — "there is just a custom link for
-- each catalog". And it read as the wholesaler's own mistake, not the app's.
--
-- WHAT IS DELIBERATELY ABSENT: pack_price.
--
-- Decision D4 (21 Aug): a flat pack price is STORED, never CHARGED.
-- v2_submit_order has never read it; every line is priced as
-- qty x v2_effective_unit_price. No buyer-facing screen may render it, and a
-- grep on 26 Aug confirms nothing in js/ reads flatPackPrice or isFlatPrice
-- outside the module that produces them.
--
-- It is also the single most sensitive number in this batch. From the Batch S
-- research: pack_price is the wholesaler's margin structure, and it is
-- currently readable cross-tenant by anyone with the shipped key. A field that
-- is never used and must never leak has no business crossing this boundary, so
-- the gated path does not return it. The column is untouched; the wholesaler
-- keeps their data. The buyer path simply stops carrying it.
--
-- SHAPE: one row per pack COMPONENT, pack columns repeated. Same reasoning as
-- 080 — the client rebuilds the nesting, and one round trip beats three.
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. Internal. No gate, no grants. Same contract as v2__catalog_rows:
--    callable only from inside the gated wrappers, which run as definer.
--    ⛔ Granting this to anon or authenticated exposes every pack, and its
--    composition, for any catalog id a caller can guess.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2__catalog_pack_rows(p_catalog_id uuid)
returns table (
  pack_id       uuid,
  pack_name     text,
  pack_color    text,
  source        text,
  product_id    uuid,
  component_id  uuid,
  variant_id    uuid,
  qty_per_pack  int,
  sku           text,
  unit_price    numeric,
  extra_attrs   jsonb
)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select
    d.id, d.name, d.color, d.source, d.product_id,
    c.id, c.variant_id, c.qty_per_pack,
    v.sku, v.price, v.extra_attrs
  from wholesale_v2.v2_catalog_products cp
  join wholesale_v2.v2_products p
    on p.id = cp.product_id and not p.archived
  join wholesale_v2.v2_pack_definitions d
    on d.product_id = p.id and not d.archived
  -- LEFT JOIN on components for the same reason 080 left-joins variants: a
  -- pack whose components have not been written yet must come back as a pack
  -- with nothing in it, not vanish. A vanished pack looks exactly like the bug
  -- above -- "cannot be ordered" -- and would be indistinguishable from it.
  left join wholesale_v2.v2_pack_components c
    on c.pack_id = d.id
  left join wholesale_v2.v2_product_variants v
    on v.id = c.variant_id and not v.archived
  where cp.catalog_id = p_catalog_id
  -- Packs newest first (matching the order the app has always shown), then
  -- components by size so a box reads S/M/L rather than in insertion order.
  order by d.created_at desc, d.id, (v.extra_attrs->>'size'), c.id;
$fn$;

comment on function wholesale_v2.v2__catalog_pack_rows(uuid) is
  'INTERNAL. Batch S/S3. Packs and their components for one catalog, WITH NO GATE. Granted to nobody: callable only from v2_catalog_packs / v2_buyer_catalog_packs, which run as definer. Never returns pack_price (decision D4 — stored, never charged, and it is the wholesaler''s margin structure).';

revoke all on function wholesale_v2.v2__catalog_pack_rows(uuid) from public;
revoke all on function wholesale_v2.v2__catalog_pack_rows(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The share-link entry point.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_catalog_packs(
  p_token      text,
  p_account_id uuid default null
)
returns table (
  pack_id uuid, pack_name text, pack_color text, source text, product_id uuid,
  component_id uuid, variant_id uuid, qty_per_pack int,
  sku text, unit_price numeric, extra_attrs jsonb
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
  return query select * from wholesale_v2.v2__catalog_pack_rows(v_cat_id);
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_packs(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_packs(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. The signed-in entry point.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_buyer_catalog_packs(
  p_account_id uuid,
  p_catalog_id uuid
)
returns table (
  pack_id uuid, pack_name text, pack_color text, source text, product_id uuid,
  component_id uuid, variant_id uuid, qty_per_pack int,
  sku text, unit_price numeric, extra_attrs jsonb
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  if p_account_id is null or p_catalog_id is null then
    return;
  end if;
  if not exists (
    select 1 from wholesale_v2.v2_buyer_catalogs(p_account_id) bc
     where bc.id = p_catalog_id
  ) then
    return;
  end if;
  return query select * from wholesale_v2.v2__catalog_pack_rows(p_catalog_id);
end;
$fn$;

revoke all on function wholesale_v2.v2_buyer_catalog_packs(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_catalog_packs(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. One pack by id — the REORDER path.
--
-- Order history stores only the pack_id, and the definition may have changed
-- since, so reorder always re-reads the CURRENT composition rather than a
-- stale copy. That read has to be gated too, and it cannot be gated by catalog
-- because the buyer is coming from their order list, not from a catalog page.
--
-- So the question asked here is the honest one: **is this pack's product in
-- ANY catalog this account may currently see?** If the wholesaler has since
-- removed the product from every catalog the buyer can reach, the reorder
-- button stops working — which is correct, and the same answer they would get
-- browsing.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_buyer_pack(
  p_account_id uuid,
  p_pack_id    uuid
)
returns table (
  pack_id uuid, pack_name text, pack_color text, source text, product_id uuid,
  component_id uuid, variant_id uuid, qty_per_pack int,
  sku text, unit_price numeric, extra_attrs jsonb
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  if p_account_id is null or p_pack_id is null then
    return;
  end if;

  if not exists (
    select 1
      from wholesale_v2.v2_pack_definitions d
      join wholesale_v2.v2_catalog_products cp on cp.product_id = d.product_id
      join wholesale_v2.v2_buyer_catalogs(p_account_id) bc on bc.id = cp.catalog_id
     where d.id = p_pack_id and not d.archived
  ) then
    return;
  end if;

  return query
  select
    d.id, d.name, d.color, d.source, d.product_id,
    c.id, c.variant_id, c.qty_per_pack,
    v.sku, v.price, v.extra_attrs
  from wholesale_v2.v2_pack_definitions d
  left join wholesale_v2.v2_pack_components c on c.pack_id = d.id
  left join wholesale_v2.v2_product_variants v on v.id = c.variant_id and not v.archived
  where d.id = p_pack_id and not d.archived
  order by (v.extra_attrs->>'size'), c.id;
end;
$fn$;

comment on function wholesale_v2.v2_buyer_pack(uuid, uuid) is
  'Batch S/S3. One pack, current composition, for the reorder flow. Gated on the pack''s product being in a catalog this account may see. Never returns pack_price.';

revoke all on function wholesale_v2.v2_buyer_pack(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_pack(uuid, uuid) to anon, authenticated;
