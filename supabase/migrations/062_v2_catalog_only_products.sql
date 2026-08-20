-- =====================================================================
-- 062 — Catalog-only products, and the line between Inventory and Catalogs
--
-- Hadi, 20 Aug 2026, describing how the two tabs relate:
--   "The inventory influences the catalog by literally providing it with
--    optional products. Also it influences the catalog by causing it to
--    have a base price. And the catalog influences the inventory by
--    creating new products and putting it there. However, I want you to
--    create a toggle... whenever they click it, they're telling you: hey,
--    this is a catalog-only product. Don't put it in the inventory."
--
-- So the relationship is a two-way street with ONE deliberate exit:
--
--   Inventory  -> Catalog : supplies the products you may add, and the
--                           base price they carry.
--   Catalog    -> Inventory: a product created while building a catalog
--                           lands in inventory like any other.
--   catalog_only            : ...unless the wholesaler says otherwise.
--
-- WHY THIS IS A REAL FLAG AND NOT "JUST DON'T RECEIVE ANY STOCK"
-- ---------------------------------------------------------------------
-- Leaving stock at zero looks identical to a product that HAS run out.
-- That matters because zero drives real behaviour: low-stock alerts, the
-- reorder report, "out of stock" ribbons, dead-stock reports. A made-to-
-- order jacket, a service line, a drop-shipped item or a placeholder
-- would sit in every one of those reports forever, and the wholesaler
-- would learn to ignore the reports -- which is worse than not having
-- them.
--
-- "I do not stock this" and "I have run out of this" are different
-- statements. The database should be able to tell them apart.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------
-- It does not hide the product from buyers, block ordering, or change
-- price. A catalog-only product is fully sellable. The flag answers one
-- question -- "does this thing participate in stock control?" -- and
-- nothing else. Overloading it with visibility or pricing meaning is how
-- a boolean becomes unexplainable six months later.
-- =====================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_products
  add column if not exists catalog_only boolean not null default false;

comment on column wholesale_v2.v2_products.catalog_only is
  'True = this product is sold from catalogs but is NOT stock-controlled: it is excluded from Inventory, from low-stock and reorder reports, and never shows an out-of-stock ribbon. Distinct from "in stock, quantity 0" -- "I do not stock this" and "I have run out" are different facts. Set by the wholesaler (Hadi, 20 Aug 2026: "this is a catalog-only product, don''t put it in the inventory").';

-- Every existing product keeps stock control. A migration must never
-- quietly opt anything out of the reports its owner relies on.
-- (The default above already guarantees this; stated so the intent is
-- readable without diffing.)

create index if not exists idx_v2_products_stocked
  on wholesale_v2.v2_products (wid) where not catalog_only and not archived;

comment on index wholesale_v2.idx_v2_products_stocked is
  'Inventory reads "products I actually stock" on every load; this keeps that the cheap path rather than a filter over everything.';

-- ---------------------------------------------------------------------
-- Is this product out of stock, and does that even mean anything for it?
-- ---------------------------------------------------------------------
-- Returns one row per product so a catalog screen can paint an
-- out-of-stock ribbon without N queries, and so it can tell the
-- difference between "0 left" and "not stock-controlled".
--
-- stock_state is a WORD, not a number, because the caller should never
-- have to re-derive the rule. Three callers deriving "is it out" three
-- ways is how two of them end up disagreeing.
create or replace function wholesale_v2.v2_catalog_stock_state(p_wid text)
returns table(product_id uuid, stock_state text, on_hand numeric)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $$
  select p.id,
         case
           when p.catalog_only then 'not_tracked'
           when coalesce(sum(b.qty_on_hand), 0) <= 0 then 'out'
           else 'in'
         end,
         coalesce(sum(b.qty_on_hand), 0)
    from wholesale_v2.v2_products p
    left join wholesale_v2.v2_product_variants v
           on v.product_id = p.id and not v.archived
    left join wholesale_v2.v2_inventory_balances b
           on b.variant_id = v.id
   where p.wid = p_wid
     and (wholesale_v2.v2_is_owner() or p.wid = wholesale_v2.v2_my_wid())
   group by p.id, p.catalog_only;
$$;
revoke all on function wholesale_v2.v2_catalog_stock_state(text) from public, anon;
grant execute on function wholesale_v2.v2_catalog_stock_state(text) to authenticated;

comment on function wholesale_v2.v2_catalog_stock_state is
  'Per-product stock state for a wholesaler: in / out / not_tracked. One query for a whole catalog screen, and one place that decides what "out of stock" means -- a catalog-only product is never "out", it is simply not tracked.';
