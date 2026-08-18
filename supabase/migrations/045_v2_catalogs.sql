-- =============================================================================
-- 045 — CATALOGS BECOME A REAL THING
-- =============================================================================
-- 18 Aug 2026. Hadi: "there's an actual catalog, and inside of the actual
-- catalog builder, create new products."
--
-- WHAT EXISTED BEFORE THIS
-- ------------------------
-- Nothing. /wholesaler/catalogs registered a literal stub reading
-- "multi-catalog/white-label, scheduled later in the batch plan"
-- (wholesaler.js:1237), and there was no catalog table of any kind in the
-- schema -- all 39 tables were checked. "Catalog" in v2 meant precisely "every
-- non-archived product belonging to this wholesaler", which is a query, not an
-- object. Multi-catalog shipped in v1; it is regression #13 in the ledger.
--
-- WHAT A CATALOG IS HERE
-- ----------------------
-- A named, ordered selection of a wholesaler's own products. Nothing more
-- ambitious than that on purpose. The obvious next features -- give this
-- catalogue to that client, publish it under a different brand, price it
-- differently -- are all real and all deliberately absent, because each needs
-- its own decisions and half-building them now means guessing at those
-- decisions in a schema that is expensive to change later.
--
-- Deliberately NOT in this migration, stated so they are decisions rather than
-- oversights:
--   * client <-> catalog assignment (white-label per buyer)
--   * per-catalog pricing
--   * public/shareable catalogue links
--
-- SCOPING IS DONE UP FRONT, NOT RETROFITTED
-- -----------------------------------------
-- Migration 042 existed because v2_wholesalers shipped with a table-wide grant
-- and a `using (true)` read policy, and OGGI's whole client list plus contact
-- details and subscription prices were readable by anyone holding the
-- publishable key. That is the third table in this schema to have needed that
-- treatment after the fact.
--
-- So these two tables start where the others ended up:
--   * no blanket GRANT ALL -- explicit column lists only
--   * `anon` gets nothing at all
--   * row policies are owner-or-own-wid from the first line, never `true`
--
-- WHY anon GETS NOTHING, given that buyers browse catalogues
-- ---------------------------------------------------------
-- Buyers and sales reps run as `anon` (they authenticate through
-- v2_portal_accounts, so auth.uid() is NULL and v2_my_wid() cannot identify
-- them). There is therefore no row predicate that can scope an anon read to
-- "their own wholesaler's catalogues", exactly as with v2_wholesalers. When
-- the buyer-facing catalogue view is built it gets an exact-id SECURITY
-- DEFINER function, the way v2_public_wholesaler(p_wid) works -- NOT a table
-- grant. Writing that down here so the shortcut is not taken later.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. The catalogs
-- ---------------------------------------------------------------------
create table if not exists wholesale_v2.v2_catalogs (
  id          uuid primary key default gen_random_uuid(),
  wid         text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  name        text not null,
  description text,
  -- Every wholesaler has exactly one default catalogue. It is what the
  -- Catalogs screen opens on, and what a product created from Inventory (with
  -- no catalogue in mind) is filed under, so a product can never exist in no
  -- catalogue at all and quietly become unfindable.
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint v2_catalogs_name_not_blank check (length(trim(name)) > 0)
);

-- Two catalogues with the same name under one wholesaler is always a mistake,
-- and case is not a meaningful difference: "Summer 26" and "summer 26" are the
-- same catalogue to the person reading the list.
create unique index if not exists v2_catalogs_unique_name
  on wholesale_v2.v2_catalogs (wid, lower(name));

-- At most one default per wholesaler, enforced here rather than by hoping the
-- interface behaves. Same shape as v2_wholesaler_brands' one-primary index,
-- and the same reason: migration 043 had to repair wholesalers whose default
-- LOCATION was missing or ambiguous, which a partial unique index would have
-- prevented outright.
create unique index if not exists v2_catalogs_one_default
  on wholesale_v2.v2_catalogs (wid) where is_default;

create index if not exists v2_catalogs_by_wid
  on wholesale_v2.v2_catalogs (wid, active, name);

-- ---------------------------------------------------------------------
-- 2. What is in them
-- ---------------------------------------------------------------------
create table if not exists wholesale_v2.v2_catalog_products (
  catalog_id uuid not null references wholesale_v2.v2_catalogs(id)   on delete cascade,
  product_id uuid not null references wholesale_v2.v2_products(id)   on delete cascade,
  sort_order int  not null default 100,
  added_at   timestamptz not null default now(),
  primary key (catalog_id, product_id)
);

create index if not exists v2_catalog_products_by_catalog
  on wholesale_v2.v2_catalog_products (catalog_id, sort_order);
create index if not exists v2_catalog_products_by_product
  on wholesale_v2.v2_catalog_products (product_id);

-- A product may only be filed in a catalogue belonging to the SAME wholesaler.
-- Enforced by a trigger rather than a foreign key because the wid lives one
-- join away on each side, and a composite FK would mean denormalising wid onto
-- the join table -- a second copy of the tenant id, which is a thing that can
-- disagree with itself. A trigger has one source of truth and fails loudly.
create or replace function wholesale_v2.v2_catalog_products_same_tenant()
returns trigger
language plpgsql
as $$
declare v_cat_wid text; v_prod_wid text;
begin
  select c.wid into v_cat_wid  from wholesale_v2.v2_catalogs  c where c.id = new.catalog_id;
  select p.wid into v_prod_wid from wholesale_v2.v2_products  p where p.id = new.product_id;
  if v_cat_wid is distinct from v_prod_wid then
    raise exception
      'Catalog belongs to wholesaler "%" but product belongs to "%" -- a product cannot be filed in another wholesaler''s catalog',
      v_cat_wid, v_prod_wid
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists v2_catalog_products_same_tenant_trg on wholesale_v2.v2_catalog_products;
create trigger v2_catalog_products_same_tenant_trg
  before insert or update on wholesale_v2.v2_catalog_products
  for each row execute function wholesale_v2.v2_catalog_products_same_tenant();

-- ---------------------------------------------------------------------
-- 3. Row-level security -- owner or own wid, never `true`
-- ---------------------------------------------------------------------
alter table wholesale_v2.v2_catalogs          enable row level security;
alter table wholesale_v2.v2_catalog_products  enable row level security;

drop policy if exists v2_catalogs_scoped on wholesale_v2.v2_catalogs;
create policy v2_catalogs_scoped on wholesale_v2.v2_catalogs
  for all
  using      (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid())
  with check (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

-- The join table has no wid of its own, so it reaches the tenant through its
-- catalogue. Written as EXISTS against v2_catalogs rather than duplicating the
-- wid column, for the same reason the trigger above exists.
drop policy if exists v2_catalog_products_scoped on wholesale_v2.v2_catalog_products;
create policy v2_catalog_products_scoped on wholesale_v2.v2_catalog_products
  for all
  using (exists (
    select 1 from wholesale_v2.v2_catalogs c
    where c.id = catalog_id
      and (wholesale_v2.v2_is_owner() or c.wid = wholesale_v2.v2_my_wid())
  ))
  with check (exists (
    select 1 from wholesale_v2.v2_catalogs c
    where c.id = catalog_id
      and (wholesale_v2.v2_is_owner() or c.wid = wholesale_v2.v2_my_wid())
  ));

-- ---------------------------------------------------------------------
-- 4. Grants -- explicit columns, and nothing for anon
-- ---------------------------------------------------------------------
-- No GRANT ALL. Deliberately verbose: adding a sensitive column to either
-- table in future must be a decision to publish it, not a side effect.
revoke all on wholesale_v2.v2_catalogs         from anon, authenticated;
revoke all on wholesale_v2.v2_catalog_products from anon, authenticated;

grant select (id, wid, name, description, is_default, active, created_at, updated_at)
  on wholesale_v2.v2_catalogs to authenticated;
grant insert (wid, name, description, is_default, active)
  on wholesale_v2.v2_catalogs to authenticated;
grant update (name, description, is_default, active, updated_at)
  on wholesale_v2.v2_catalogs to authenticated;
grant delete on wholesale_v2.v2_catalogs to authenticated;

grant select (catalog_id, product_id, sort_order, added_at)
  on wholesale_v2.v2_catalog_products to authenticated;
grant insert (catalog_id, product_id, sort_order)
  on wholesale_v2.v2_catalog_products to authenticated;
grant update (sort_order) on wholesale_v2.v2_catalog_products to authenticated;
grant delete on wholesale_v2.v2_catalog_products to authenticated;

-- ---------------------------------------------------------------------
-- 5. Back-fill: one default catalogue per wholesaler, holding what they have
-- ---------------------------------------------------------------------
-- So the Catalogs screen is never empty on first open, and so nothing changes
-- for anyone until they choose to build a second catalogue. A blank screen
-- reading "no catalogs" for a wholesaler with 64 live variants would look like
-- their products had gone missing.
insert into wholesale_v2.v2_catalogs (wid, name, description, is_default, active)
select w.wid, 'Main Catalog',
       'Everything you sell. Created automatically so nothing was left unfiled.',
       true, true
from wholesale_v2.v2_wholesalers w
where not exists (
  select 1 from wholesale_v2.v2_catalogs c where c.wid = w.wid and c.is_default
);

insert into wholesale_v2.v2_catalog_products (catalog_id, product_id, sort_order)
select c.id, p.id, 100
from wholesale_v2.v2_catalogs c
join wholesale_v2.v2_products p on p.wid = c.wid
where c.is_default
  and coalesce(p.archived, false) = false
on conflict (catalog_id, product_id) do nothing;

-- ---------------------------------------------------------------------
-- 6. Keep updated_at honest
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_catalogs_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists v2_catalogs_touch_trg on wholesale_v2.v2_catalogs;
create trigger v2_catalogs_touch_trg
  before update on wholesale_v2.v2_catalogs
  for each row execute function wholesale_v2.v2_catalogs_touch();

comment on table wholesale_v2.v2_catalogs is
  'A named, ordered selection of one wholesaler''s products. Scoped owner-or-own-wid from creation. anon holds nothing: buyers authenticate through v2_portal_accounts so auth.uid() is NULL for them and no row policy can scope their read -- the buyer-facing view gets an exact-id SECURITY DEFINER function, not a table grant.';
comment on table wholesale_v2.v2_catalog_products is
  'Which products are in which catalog. Cross-tenant filing is blocked by a trigger rather than a composite foreign key, so wid is not duplicated onto this table where it could drift.';
