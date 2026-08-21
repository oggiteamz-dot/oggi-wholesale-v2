-- OGGI Wholesale v2 — Migration 038: a wholesaler can carry many brands
-- 17 Aug 2026 · CR-0002 (Hadi: "some clients might sell multiple brands...
-- instead of brand, brands, and I can add an infinite amount")
--
-- WHY THE OLD `brand` COLUMN STAYS
-- `v2_wholesalers.brand` is read in a lot of places -- the buyer catalog,
-- the supplier directory, the owner list, the invite screen. Renaming or
-- removing it would mean changing every one of them in a single step, and
-- any one missed becomes a blank name in front of a buyer.
--
-- So instead: `brand` remains as the PRIMARY / display brand (what a buyer
-- sees at the top of the catalog), and this table holds the full list.
-- Nothing that works today changes behaviour. That is the "expand" step;
-- the display code can start reading the full list whenever we choose,
-- one screen at a time, each proven separately.
--
-- The primary brand is mirrored into this table too, so "all the brands
-- they carry" is answerable from ONE place rather than "the column, plus
-- the table, and don't forget to merge them" -- which is exactly the kind
-- of two-sources-of-truth split that has bitten this codebase before.
--
-- ---------------------------------------------------------------------
-- RECOVERED 21 Aug 2026 (Batch 7), together with 035 and 036. Applied on
-- 17 Aug, file never committed. Text below is exactly what the database
-- recorded in supabase_migrations.schema_migrations, not a reconstruction.
--
-- NOTE the `update public.wholesalers` near the end: this is one of the
-- places where v2 reaches into v1's schema. See 000_v1_prerequisites.sql.
-- ---------------------------------------------------------------------

create table if not exists wholesale_v2.v2_wholesaler_brands (
  id         uuid primary key default gen_random_uuid(),
  wid        text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  name       text not null,
  -- Exactly one row per wholesaler should be primary; it mirrors
  -- v2_wholesalers.brand and is what a buyer sees.
  is_primary boolean not null default false,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

-- The same brand twice under one wholesaler is always a mistake.
create unique index if not exists v2_wholesaler_brands_unique
  on wholesale_v2.v2_wholesaler_brands (wid, lower(name));

-- Enforces "at most one primary per wholesaler" in the database rather
-- than hoping the UI behaves.
create unique index if not exists v2_wholesaler_brands_one_primary
  on wholesale_v2.v2_wholesaler_brands (wid) where is_primary;

create index if not exists v2_wholesaler_brands_by_wid
  on wholesale_v2.v2_wholesaler_brands (wid, sort_order);

alter table wholesale_v2.v2_wholesaler_brands enable row level security;

-- Readable by anyone signed in (buyers will want to see "which brands do
-- they carry"); writable by the owner, or by the wholesaler themselves
-- for their own record.
drop policy if exists v2_wholesaler_brands_read on wholesale_v2.v2_wholesaler_brands;
create policy v2_wholesaler_brands_read on wholesale_v2.v2_wholesaler_brands
  for select using (true);

drop policy if exists v2_wholesaler_brands_write on wholesale_v2.v2_wholesaler_brands;
create policy v2_wholesaler_brands_write on wholesale_v2.v2_wholesaler_brands
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select on wholesale_v2.v2_wholesaler_brands to anon, authenticated;
grant insert, update, delete on wholesale_v2.v2_wholesaler_brands to authenticated;

-- Backfill: every existing wholesaler's current brand becomes their
-- primary, so the new table is complete from the moment it exists rather
-- than starting empty and quietly disagreeing with the column.
insert into wholesale_v2.v2_wholesaler_brands (wid, name, is_primary, sort_order)
select w.wid, w.brand, true, 0
from wholesale_v2.v2_wholesalers w
where coalesce(trim(w.brand),'') <> ''
on conflict do nothing;

-- Sets the whole brand list in one call: first entry is the primary and
-- is mirrored back into v2_wholesalers.brand, so the two can never drift.
create or replace function wholesale_v2.v2_set_wholesaler_brands(
  p_wid text, p_brands text[]
)
returns table (ok boolean, error text, primary_brand text)
language plpgsql security definer
set search_path to 'wholesale_v2', 'public'
as $$
declare v_name text; v_i int := 0; v_primary text;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can change brands', null::text; return;
  end if;
  if p_brands is null or array_length(p_brands,1) is null then
    return query select false, 'At least one brand is required', null::text; return;
  end if;
  if not exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = p_wid) then
    return query select false, format('No wholesaler with id "%s"', p_wid), null::text; return;
  end if;

  delete from wholesale_v2.v2_wholesaler_brands where wid = p_wid;

  foreach v_name in array p_brands loop
    if coalesce(trim(v_name),'') = '' then continue; end if;
    insert into wholesale_v2.v2_wholesaler_brands (wid, name, is_primary, sort_order)
    values (p_wid, trim(v_name), v_i = 0, v_i)
    on conflict do nothing;
    if v_i = 0 then v_primary := trim(v_name); end if;
    v_i := v_i + 1;
  end loop;

  if v_primary is null then
    return query select false, 'At least one brand is required', null::text; return;
  end if;

  -- Keep the legacy column in step -- this is what buyers still read.
  update wholesale_v2.v2_wholesalers set brand = v_primary, updated_at = now() where wid = p_wid;
  update public.wholesalers          set brand = v_primary                       where wid = p_wid;

  return query select true, ''::text, v_primary;
end; $$;

revoke all on function wholesale_v2.v2_set_wholesaler_brands(text,text[]) from public, anon;
grant execute on function wholesale_v2.v2_set_wholesaler_brands(text,text[]) to authenticated;
