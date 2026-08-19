-- =============================================================================
-- 057 — THE BILLBOARD, AND THE GROUP THAT ALWAYS SITS ON TOP
-- =============================================================================
-- 19 Aug 2026.
--
-- Hadi: "In the catalog, I want like a billboard essentially. Like there's a
-- main screen that is basically either an advertisement for a specific product,
-- where they click on a button and they move to that specific item inside that
-- specific catalog, or just a normal poster, and it's toggleable on and off."
--
-- And: "I want them to be able to highlight as many items as they want, so it's
-- in the catalog as a highlight, and basically no matter what order they put
-- them in, always the highlighted items will be on the top. And they can choose
-- any name for it... not a ribbon, like a header. Basically, there's a header
-- for new arrivals or featured items, top selling, favorites, whatever they
-- choose to name it. And then there's the rest of the catalog."
--
-- TWO SHAPES, ONE NULL
-- --------------------
-- billboard_product_id null IS the "just a poster" case. It is a null rather
-- than a separate mode column because one of the two shapes he described is
-- literally the absence of the other, and a mode flag that can disagree with
-- the product id is a third state nobody asked for.
--
-- THE ORDER IS THE DATABASE'S
-- ---------------------------
-- "No matter what order they put them in, always the highlighted items will be
-- on the top" is a property of the catalog, not a rendering preference. So the
-- ordering lives in the query, and both the wholesaler's own catalog screen and
-- the buyer's link page read it from there. A second sort in JavaScript would
-- be a second place for it to be got wrong, and the two sides would eventually
-- disagree about a promise only one of them could see.
-- =============================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_catalogs
  add column if not exists billboard_enabled boolean not null default false,
  add column if not exists billboard_image_url text,
  add column if not exists billboard_product_id uuid
    references wholesale_v2.v2_products(id) on delete set null,
  add column if not exists billboard_cta text,
  add column if not exists highlight_label text not null default 'Featured';

alter table wholesale_v2.v2_catalog_products
  add column if not exists highlighted boolean not null default false;

-- Partial: the pinned handful, not the whole catalog.
create index if not exists v2_catalog_products_highlighted
  on wholesale_v2.v2_catalog_products (catalog_id) where highlighted;

comment on column wholesale_v2.v2_catalogs.billboard_enabled is
  'Whether the billboard shows at the top of this catalog. Off by default: a catalog with no poster uploaded must not render an empty panel.';
comment on column wholesale_v2.v2_catalogs.billboard_image_url is
  'An uploaded poster, deliberately not a product photo. The point is designed artwork with the wholesaler own words on it.';
comment on column wholesale_v2.v2_catalogs.billboard_product_id is
  'Optional. When set the billboard carries a button that jumps to this product inside this catalog. When null it is just a poster.';
comment on column wholesale_v2.v2_catalogs.highlight_label is
  'What the wholesaler calls their pinned group: New Arrivals, Top Selling, Favourites, anything. Rendered as a header above the group, never as a ribbon on each card.';
comment on column wholesale_v2.v2_catalog_products.highlighted is
  'Pinned to the top of this catalog. Any number of products may be highlighted; they sort above everything else whatever order the rest are in.';

grant select (billboard_enabled, billboard_image_url, billboard_product_id, billboard_cta, highlight_label)
  on wholesale_v2.v2_catalogs to authenticated;
grant insert (billboard_enabled, billboard_image_url, billboard_product_id, billboard_cta, highlight_label)
  on wholesale_v2.v2_catalogs to authenticated;
grant update (billboard_enabled, billboard_image_url, billboard_product_id, billboard_cta, highlight_label)
  on wholesale_v2.v2_catalogs to authenticated;

grant select (highlighted) on wholesale_v2.v2_catalog_products to authenticated;
grant insert (highlighted) on wholesale_v2.v2_catalog_products to authenticated;
grant update (highlighted) on wholesale_v2.v2_catalog_products to authenticated;

-- The return TYPE gains a column, and create-or-replace cannot change a return
-- type. Dropped explicitly so this fails here rather than as a confusing
-- "cannot change return type of existing function" mid-deploy.
drop function if exists wholesale_v2.v2_catalog_products_by_token(text, uuid);

create function wholesale_v2.v2_catalog_products_by_token(
  p_token text,
  p_account_id uuid default null
)
returns table (product_id uuid, sort_order int, highlighted boolean)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_cat_id uuid;
begin
  -- The gate is re-applied here rather than trusted from the caller having
  -- resolved the token. A caller that skipped straight to this would walk in.
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';

  if v_cat_id is null then
    return;
  end if;

  return query
  select cp.product_id, cp.sort_order, cp.highlighted
    from wholesale_v2.v2_catalog_products cp
    join wholesale_v2.v2_products p on p.id = cp.product_id
   where cp.catalog_id = v_cat_id and not p.archived
   order by cp.highlighted desc, cp.sort_order, cp.added_at;
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_products_by_token(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_products_by_token(text, uuid) to anon, authenticated;

-- NOTE: v2_catalog_by_token also gains the billboard columns. It is defined in
-- 058 rather than here, because 058 adds billboard_media_type to the same
-- return type and defining it twice in two migrations would leave the
-- intermediate version in the repo for no reason.
