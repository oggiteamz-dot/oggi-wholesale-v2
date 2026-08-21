-- =====================================================================
-- 078a — re-create three of 078's functions from the FILE text, verbatim
--
-- 078 was applied from a copy of itself with the inline comments stripped,
-- so pg_proc held bodies that differed from what this repo says is
-- installed. Caught by hashing each function body parsed out of the
-- migration file and comparing it to prosrc:
--
--   v2_can_manage_prices      3d91a1a9...  matched
--   v2_bulk_price_preview     ec2fbce4...  matched
--   v2_bulk_update_prices     005c5da3...  DIFFERED (prod held 961fc0bb...)
--   v2_revert_price_batch     062d7068...  DIFFERED (prod held 1aef09bd...)
--   v2_recent_price_batches   df67a84e...  DIFFERED (prod held 989fb79a...)
--
-- Only comments differed, so nothing behaved differently -- which is
-- exactly why it would have gone unnoticed. It is fixed anyway, because
-- the standing rule is that this repo must be able to rebuild the
-- product, and a migration that does not reproduce what is installed is
-- a migration nobody can check. The same drift was found in Batch 3.
--
-- Kept as its own file rather than folded back into 078: the history of
-- what went wrong is worth more than a repo that looks like it never did.
-- =====================================================================


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

revoke all on function wholesale_v2.v2_bulk_update_prices(text, numeric, boolean, text) from public, anon;
grant execute on function wholesale_v2.v2_bulk_update_prices(text, numeric, boolean, text) to authenticated;
revoke all on function wholesale_v2.v2_revert_price_batch(uuid) from public, anon;
grant execute on function wholesale_v2.v2_revert_price_batch(uuid) to authenticated;
revoke all on function wholesale_v2.v2_recent_price_batches(text, int) from public, anon;
grant execute on function wholesale_v2.v2_recent_price_batches(text, int) to authenticated;
