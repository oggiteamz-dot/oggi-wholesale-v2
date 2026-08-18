-- OGGI Wholesale v2 — Batch 17: suppliers (who the WHOLESALER buys from)
--
-- A naming hazard first, because it will bite whoever reads this next. The word
-- "supplier" already appears throughout this codebase meaning THE WHOLESALER,
-- as seen by a buyer: buyer.js has a suppliers() screen for "switch supplier",
-- 042's comment talks about a buyer needing "their supplier's display name",
-- and 034 mentions a buyer supplier directory. All of that is the buyer looking
-- up at the wholesaler.
--
-- This table points the other way: it is the wholesaler looking DOWN their own
-- supply chain at the factories and vendors they buy stock from. It is never
-- buyer-facing and must never be confused with the directory. Hence the
-- explicit table comment, and hence anon getting nothing here at all.
--
-- Fields are exactly what Hadi asked for and no more: name, contact person,
-- phone, email, address, country, his own reference code, notes. Payment terms
-- and lead time were offered and declined, so they are not here -- a column
-- nobody fills is a column that makes every form longer and every list emptier.
--
-- Scoped from line one. Migration 023 spent itself undoing `using (true)`
-- starters, 048 was still cleaning one of them up 25 migrations later, and the
-- table it cleaned up had been readable by anyone holding the publishable key
-- the entire time. A table that is never permissive cannot need that migration.

set search_path = wholesale_v2, public;

create table if not exists wholesale_v2.v2_suppliers (
  id           uuid primary key default gen_random_uuid(),
  wid          text not null references public.wholesalers(wid) on delete cascade,
  name         text not null,
  contact_name text,
  phone        text,
  email        text,
  address      text,
  country      text,
  ref_code     text,
  notes        text,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_v2_suppliers_wid on wholesale_v2.v2_suppliers(wid) where not archived;

-- Unique per wholesaler, case-insensitively, and only among the live ones --
-- "Zhejiang Textiles" typed twice is one supplier with two histories, which is
-- the failure that makes a supplier list useless. Archived rows are excluded so
-- a name can be retired and later reused.
create unique index if not exists v2_suppliers_name_uq
  on wholesale_v2.v2_suppliers (wid, lower(name)) where not archived;

comment on table wholesale_v2.v2_suppliers is
  'Who a WHOLESALER buys from. Note the direction: everywhere else in this codebase "supplier" means the wholesaler as seen by a buyer (buyer.js suppliers(), the buyer-facing directory). This table is the other way round and is never buyer-facing.';

alter table wholesale_v2.v2_products add column if not exists supplier_id uuid
  references wholesale_v2.v2_suppliers(id) on delete set null;
create index if not exists idx_v2_products_supplier on wholesale_v2.v2_products(supplier_id);

comment on column wholesale_v2.v2_products.supplier_id is
  'Nullable on purpose: products created before suppliers existed have none, and a wholesaler who does not track sourcing should never be forced to invent one. on delete set null, not cascade -- removing a supplier must not delete the products bought from them.';

alter table wholesale_v2.v2_suppliers enable row level security;

create policy v2_suppliers_read_scoped on wholesale_v2.v2_suppliers
  for select using (v2_is_owner() or wid = v2_my_wid());
create policy v2_suppliers_insert_scoped on wholesale_v2.v2_suppliers
  for insert with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_suppliers_update_scoped on wholesale_v2.v2_suppliers
  for update using (v2_is_owner() or wid = v2_my_wid())
              with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_suppliers_delete_scoped on wholesale_v2.v2_suppliers
  for delete using (v2_is_owner() or wid = v2_my_wid());

-- Supplier records carry a wholesaler's sourcing -- who makes their product.
-- anon (buyers and sales reps) has no business here, and unlike price overrides
-- there is no buyer-facing read to preserve, so this is simply closed rather
-- than routed through a SECURITY DEFINER function.
revoke all on wholesale_v2.v2_suppliers from anon;
grant select, insert, update, delete on wholesale_v2.v2_suppliers to authenticated;

-- Refuse to land quietly if any of that did not take.
do $$
declare v_open int; v_anon int;
begin
  select count(*) into v_open from pg_policies
  where schemaname='wholesale_v2' and tablename='v2_suppliers' and qual='true';
  if v_open > 0 then
    raise exception 'v2_suppliers shipped with a using(true) policy.';
  end if;

  select count(*) into v_anon from information_schema.role_table_grants
  where table_schema='wholesale_v2' and table_name='v2_suppliers' and grantee='anon';
  if v_anon > 0 then
    raise exception 'anon holds % grant(s) on v2_suppliers.', v_anon;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='wholesale_v2' and table_name='v2_products' and column_name='supplier_id'
  ) then
    raise exception 'v2_products.supplier_id was not created.';
  end if;
end $$;
