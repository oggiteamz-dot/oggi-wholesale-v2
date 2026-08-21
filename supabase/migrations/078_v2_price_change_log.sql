-- =====================================================================
-- 078 — Bulk price changes become recorded, atomic and reversible
--
-- WHAT WAS THERE (found 21 Aug 2026, doing Batch 6)
-- ---------------------------------------------------------------------
-- The Products screen carried "Bulk price update (all products)": one
-- number, one button, no confirmation. It ran, in the BROWSER:
--
--     for (const u of updates) { await supabase...update({price}).eq(id) }
--
-- Three separate problems, each on its own enough to lose a catalogue.
--
--   1. NO RECORD. The previous price was overwritten and stored nowhere.
--      There is no undo, and no way to answer "what was this before".
--      A wholesaler who typed 100 meaning 10 doubled every price in
--      their catalogue, permanently, in one click. Measured on
--      production: for wid 'sq' that is 64 variants.
--
--   2. NOT ATOMIC. N sequential round trips from a browser. Close the
--      laptop at variant 30 of 64 and the catalogue is half repriced,
--      with nothing anywhere recording which half.
--
--   3. ARCHIVED ROWS INCLUDED. The list it worked from applies no
--      archived filter, to products or to variants, so things that are
--      deliberately not for sale got repriced too.
--
-- WHY A LOG TABLE RATHER THAN REUSING compare_at_price
-- ---------------------------------------------------------------------
-- compare_at_price is a BUYER-FACING "was" price. Overloading it to also
-- mean "what this cost before the last bulk run" would give one column
-- two meanings, which is this codebase's most expensive recurring bug --
-- the same shape as landed cost and `cost` being two unreconciled
-- numbers for one thing (R4), and as v2_clients.active nearly being made
-- to mean "banned" (see 059). One column, one meaning.
--
-- WHY THE REVERT IS CONDITIONAL, AND WHY THAT MATTERS MOST
-- ---------------------------------------------------------------------
-- v2_revert_price_batch restores a row ONLY IF that variant's price is
-- still exactly what this batch set it to. If the wholesaler bulk-updated,
-- then hand-corrected one product, then pressed undo, an unconditional
-- revert would silently destroy the hand correction -- an undo button that
-- eats deliberate work is worse than no undo button, because people trust
-- it. Rows that have moved on are skipped and REPORTED, not quietly
-- ignored: the function returns how many it restored and how many it left
-- alone, so the screen can say so.
--
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------
-- This does not log single-variant edits made in the product editor. It
-- could, and probably should later, but that means a trigger on
-- v2_product_variants and a decision about what to do with the several
-- import paths that write prices in bulk legitimately. Bounded on purpose:
-- this migration makes the DANGEROUS path safe and says plainly that the
-- ordinary path is still unlogged, rather than half-covering both.
-- =====================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. The log
-- ---------------------------------------------------------------------
create table if not exists wholesale_v2.v2_price_changes (
  id           bigint generated always as identity primary key,
  -- One id per bulk run, so a whole run can be reverted as a unit.
  batch_id     uuid        not null,
  wid          text        not null,
  variant_id   uuid        not null references wholesale_v2.v2_product_variants(id) on delete cascade,
  old_price    numeric(12,2),
  new_price    numeric(12,2),
  pct_delta    numeric,
  -- Free text so a later, non-bulk caller can say what it was ('import',
  -- 'supplier increase'). Defaults to the only writer that exists today.
  reason       text        not null default 'bulk',
  changed_by   uuid,
  changed_at   timestamptz not null default now(),
  -- Stamped, never deleted. The history of what a price used to be is the
  -- entire point; a revert that erased its own evidence would leave the
  -- same blind spot this table was created to fill.
  reverted_at  timestamptz
);

create index if not exists idx_v2_price_changes_batch
  on wholesale_v2.v2_price_changes (batch_id);
create index if not exists idx_v2_price_changes_wid_time
  on wholesale_v2.v2_price_changes (wid, changed_at desc);
create index if not exists idx_v2_price_changes_variant
  on wholesale_v2.v2_price_changes (variant_id, changed_at desc);

comment on table wholesale_v2.v2_price_changes is
  'Every bulk price change, one row per variant, with the price before and after. Written by v2_bulk_update_prices and read by v2_revert_price_batch. A revert stamps reverted_at and never deletes.';

alter table wholesale_v2.v2_price_changes enable row level security;

-- Same scoping as every other tenant table: the owner, or the wholesaler
-- whose prices these are. Buyers must never see this -- it is a record of
-- what someone used to charge.
drop policy if exists v2_price_changes_scoped on wholesale_v2.v2_price_changes;
create policy v2_price_changes_scoped on wholesale_v2.v2_price_changes for all
  using (
    exists (select 1 from wholesale_v2.v2_user_profiles p
             where p.id = auth.uid()
               and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_price_changes.wid)))
  )
  with check (
    exists (select 1 from wholesale_v2.v2_user_profiles p
             where p.id = auth.uid()
               and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_price_changes.wid)))
  );

revoke all on wholesale_v2.v2_price_changes from anon;
grant select on wholesale_v2.v2_price_changes to authenticated;

-- ---------------------------------------------------------------------
-- 2. Who is allowed to reprice this wid
-- ---------------------------------------------------------------------
-- Pulled out so the preview, the apply and the revert cannot drift into
-- three slightly different answers to one question.
create or replace function wholesale_v2.v2_can_manage_prices(p_wid text)
returns boolean
language sql stable security definer set search_path = wholesale_v2
as $$
  select exists (
    select 1 from wholesale_v2.v2_user_profiles p
     where p.id = auth.uid()
       and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = p_wid))
  );
$$;

revoke all on function wholesale_v2.v2_can_manage_prices(text) from public, anon;
grant execute on function wholesale_v2.v2_can_manage_prices(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Preview — what WOULD happen, from the same query that will do it
-- ---------------------------------------------------------------------
-- The preview and the apply select their rows with identical predicates.
-- Two different definitions of "which variants" is how a preview ends up
-- describing a different change from the one that runs.
create or replace function wholesale_v2.v2_bulk_price_preview(
  p_wid              text    default null,
  p_pct              numeric default 0,
  p_include_archived boolean default false
)
returns table (
  variant_count   int,
  min_before      numeric,
  max_before      numeric,
  min_after       numeric,
  max_after       numeric,
  total_before    numeric,
  total_after     numeric,
  skipped_archived int
)
language plpgsql stable security definer set search_path = wholesale_v2
as $$
declare
  v_wid text := coalesce(p_wid, wholesale_v2.v2_my_wid());
begin
  if v_wid is null or not wholesale_v2.v2_can_manage_prices(v_wid) then
    raise exception 'not allowed to preview price changes for this wholesaler';
  end if;

  return query
  with candidate as (
    select v.id, v.price, (p.archived or v.archived) as is_archived
      from wholesale_v2.v2_product_variants v
      join wholesale_v2.v2_products p on p.id = v.product_id
     where p.wid = v_wid and v.price is not null
  ), chosen as (
    select * from candidate where p_include_archived or not is_archived
  )
  select
    (select count(*) from chosen)::int,
    (select min(price) from chosen),
    (select max(price) from chosen),
    (select min(round(price * (1 + p_pct / 100.0), 2)) from chosen),
    (select max(round(price * (1 + p_pct / 100.0), 2)) from chosen),
    (select round(coalesce(sum(price), 0), 2) from chosen),
    (select round(coalesce(sum(round(price * (1 + p_pct / 100.0), 2)), 0), 2) from chosen),
    (select count(*) from candidate where is_archived and not p_include_archived)::int;
end;
$$;

revoke all on function wholesale_v2.v2_bulk_price_preview(text, numeric, boolean) from public, anon;
grant execute on function wholesale_v2.v2_bulk_price_preview(text, numeric, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Apply — one statement, one transaction, fully logged
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_bulk_update_prices(
  p_wid              text    default null,
  p_pct              numeric default 0,
  p_include_archived boolean default false,
  p_reason           text    default 'bulk'
)
returns table (batch_id uuid, variant_count int)
language plpgsql volatile security definer set search_path = wholesale_v2
as $$
declare
  v_wid   text := coalesce(p_wid, wholesale_v2.v2_my_wid());
  v_batch uuid := gen_random_uuid();
  v_count int;
begin
  if v_wid is null or not wholesale_v2.v2_can_manage_prices(v_wid) then
    raise exception 'not allowed to change prices for this wholesaler';
  end if;

  -- A 0% change writes nothing. Without this the log fills with runs that
  -- did not do anything, and "revert the last batch" starts landing on one
  -- of them and appearing to do nothing.
  if p_pct is null or p_pct = 0 then
    raise exception 'a bulk price change of 0%% would do nothing -- enter a percentage';
  end if;

  -- Floors at zero. A -150%% entry is a typo, not an instruction to invent
  -- negative prices that every downstream sum would then quietly carry.
  with target as (
    select v.id, v.price as old_price,
           greatest(round(v.price * (1 + p_pct / 100.0), 2), 0) as new_price
      from wholesale_v2.v2_product_variants v
      join wholesale_v2.v2_products p on p.id = v.product_id
     where p.wid = v_wid
       and v.price is not null
       and (p_include_archived or not (p.archived or v.archived))
  ), upd as (
    update wholesale_v2.v2_product_variants v
       set price = t.new_price, updated_at = now()
      from target t
     where v.id = t.id
    returning v.id, t.old_price, t.new_price
  )
  insert into wholesale_v2.v2_price_changes (batch_id, wid, variant_id, old_price, new_price, pct_delta, reason, changed_by)
  select v_batch, v_wid, upd.id, upd.old_price, upd.new_price, p_pct, coalesce(p_reason, 'bulk'), auth.uid()
    from upd;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'nothing to reprice -- this wholesaler has no priced variants matching that selection';
  end if;

  return query select v_batch, v_count;
end;
$$;

revoke all on function wholesale_v2.v2_bulk_update_prices(text, numeric, boolean, text) from public, anon;
grant execute on function wholesale_v2.v2_bulk_update_prices(text, numeric, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Revert — restores only what has not moved on since
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_revert_price_batch(p_batch_id uuid)
returns table (restored int, skipped int)
language plpgsql volatile security definer set search_path = wholesale_v2
as $$
declare
  v_wid       text;
  v_restored  int;
  v_total     int;
begin
  select pc.wid into v_wid
    from wholesale_v2.v2_price_changes pc
   where pc.batch_id = p_batch_id
   limit 1;

  if v_wid is null then
    raise exception 'no such price change batch';
  end if;
  if not wholesale_v2.v2_can_manage_prices(v_wid) then
    raise exception 'not allowed to revert price changes for this wholesaler';
  end if;

  select count(*) into v_total
    from wholesale_v2.v2_price_changes
   where batch_id = p_batch_id and reverted_at is null;

  -- The condition that makes this safe: v.price = pc.new_price. A variant
  -- edited by hand since the batch ran no longer matches, so it is left
  -- exactly as the wholesaler last set it.
  with restorable as (
    select pc.id as change_id, pc.variant_id, pc.old_price
      from wholesale_v2.v2_price_changes pc
      join wholesale_v2.v2_product_variants v on v.id = pc.variant_id
     where pc.batch_id = p_batch_id
       and pc.reverted_at is null
       and v.price = pc.new_price
  ), upd as (
    update wholesale_v2.v2_product_variants v
       set price = r.old_price, updated_at = now()
      from restorable r
     where v.id = r.variant_id
    returning v.id
  ), mark as (
    update wholesale_v2.v2_price_changes pc
       set reverted_at = now()
      from restorable r
     where pc.id = r.change_id
    returning pc.id
  )
  select count(*) into v_restored from mark;

  return query select v_restored, (v_total - v_restored);
end;
$$;

revoke all on function wholesale_v2.v2_revert_price_batch(uuid) from public, anon;
grant execute on function wholesale_v2.v2_revert_price_batch(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Recent batches, for the screen's "undo the last one" affordance
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_recent_price_batches(p_wid text default null, p_limit int default 10)
returns table (
  batch_id     uuid,
  changed_at   timestamptz,
  pct_delta    numeric,
  reason       text,
  variant_count int,
  reverted     boolean
)
language plpgsql stable security definer set search_path = wholesale_v2
as $$
declare
  v_wid text := coalesce(p_wid, wholesale_v2.v2_my_wid());
begin
  if v_wid is null or not wholesale_v2.v2_can_manage_prices(v_wid) then
    raise exception 'not allowed to read price history for this wholesaler';
  end if;

  return query
  select pc.batch_id,
         max(pc.changed_at)                      as changed_at,
         max(pc.pct_delta)                       as pct_delta,
         max(pc.reason)                          as reason,
         count(*)::int                           as variant_count,
         bool_and(pc.reverted_at is not null)    as reverted
    from wholesale_v2.v2_price_changes pc
   where pc.wid = v_wid
   group by pc.batch_id
   order by max(pc.changed_at) desc
   limit greatest(coalesce(p_limit, 10), 1);
end;
$$;

revoke all on function wholesale_v2.v2_recent_price_batches(text, int) from public, anon;
grant execute on function wholesale_v2.v2_recent_price_batches(text, int) to authenticated;
