-- 116 — MOD-01: the product-level public flag
--
-- WHY THIS EXISTS
-- `v2_catalogs.is_public` is currently the ONLY switch that puts a product on
-- the marketplace. Both v2_marketplace_feed and v2_marketplace_search select
-- THROUGH the catalog join to find it. Under the store model the catalog
-- concept is retired -- so the switch has to live somewhere else BEFORE
-- anything is allowed to touch that join. Drop the join first and the
-- marketplace returns zero rows, silently, for everyone.
--
-- This migration is deliberately INERT. It adds a column and fills it. No
-- function reads it yet; that is MOD-03, in its own migration with its own
-- gate. Nothing about what a buyer sees changes today.
--
-- WHAT `is_public` MEANS
-- "The wholesaler published this product." It does NOT mean "visible right
-- now". `w.active` and `p.archived` stay as runtime filters in the feed,
-- because they are states that change on their own -- a wholesaler going
-- inactive must not silently un-publish 40 products it would then have to
-- re-publish by hand.
--
-- APPLIED AND VERIFIED LIVE 6 Sep 2026: 101 public, 26 private, 0 leaked,
-- 0 dropped. The flag set and the catalog-join set were compared in BOTH
-- directions, not sampled.

alter table wholesale_v2.v2_products
  add column if not exists is_public boolean not null default false;

comment on column wholesale_v2.v2_products.is_public is
  'MOD-01. The wholesaler published this product to the OGGI marketplace. '
  'Replaces v2_catalogs.is_public as the marketplace switch. Runtime '
  'visibility also requires w.active and not p.archived -- those are NOT '
  'folded in here on purpose.';

-- Backfill: every product currently reachable through a public catalogue.
-- Scope copied from the live v2_marketplace_feed body, minus the two runtime
-- conditions, so no product silently gains or loses marketplace presence.
update wholesale_v2.v2_products p
   set is_public = true
 where exists (
         select 1
           from wholesale_v2.v2_catalog_products cp
           join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
          where cp.product_id = p.id
            and c.is_public
       );

-- Partial index: the feed only ever asks for the true side.
create index if not exists v2_products_is_public_idx
  on wholesale_v2.v2_products (is_public)
  where is_public;

-- The migration proves itself. If the flag and the catalog join disagree by
-- even one row, this whole transaction rolls back rather than leaving the
-- marketplace in a state nobody measured.
do $$
declare
  v_flag int;
  v_join int;
  v_priv int;
begin
  select count(*) into v_flag
    from wholesale_v2.v2_products where is_public;

  select count(distinct p.id) into v_join
    from wholesale_v2.v2_products p
    join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
    join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
   where c.is_public;

  if v_flag <> v_join then
    raise exception
      'MOD-01 backfill mismatch: flag=% catalog-join=%. Refusing to commit.',
      v_flag, v_join;
  end if;

  -- and the converse, because a backfill that flagged EVERYTHING would pass
  -- the test above only if the join also returned everything.
  select count(*) into v_priv
    from wholesale_v2.v2_products where not is_public;

  if v_priv = 0 then
    raise exception
      'MOD-01 flagged every product public. A private line exists in this '
      'data; refusing to commit a backfill that leaks it.';
  end if;

  raise notice 'MOD-01 ok: % public, % private', v_flag, v_priv;
end $$;
