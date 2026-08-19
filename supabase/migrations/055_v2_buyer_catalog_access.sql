-- =============================================================================
-- 055 — BUYERS CAN FINALLY SEE CATALOGS, AND ONLY THE ONES THEY MAY
-- =============================================================================
-- 19 Aug 2026. Hadi chose "only catalogs their tier allows".
--
-- Until this migration the buyer side had NO idea catalogs existed:
-- getCatalog(wid) returned every non-archived product the wholesaler owned,
-- and catalogs were wholesaler-side filing and nothing more. Migration 045
-- said so and deferred this deliberately.
--
-- WHY THESE ARE FUNCTIONS AND NOT POLICIES
-- ----------------------------------------
-- Buyers and reps authenticate through v2_portal_accounts, so they run as
-- `anon` with auth.uid() NULL and v2_my_wid() unable to identify them. There
-- is no row predicate that can scope an anon read to "the catalogs my tier
-- allows". 045 wrote that warning down in advance so the shortcut would not be
-- taken later; this is the promised SECURITY DEFINER function.
--
-- Both take ONLY an account id. No wid, no client id, no tier -- all three are
-- read off the validated account row. The strongest question a buyer can ask
-- is "what may I see", and there is deliberately no argument through which to
-- ask a different one. Same shape as v2_buyer_price_overrides (migration 048).
--
-- A guessed catalog id returns ZERO ROWS rather than an error, so it looks
-- exactly like an empty catalog. An error would confirm that something is
-- there, which is a small oracle and not one worth handing out.
--
-- HONEST LIMITATION, recorded rather than glossed
-- -----------------------------------------------
-- v2_products and v2_product_variants have carried an `auth.uid() is null`
-- read policy since long before this work, so `anon` can still read product
-- rows directly. The tier gate is therefore real in the app and real at order
-- time (see v2_submit_order below), but it is not yet a hard boundary against
-- someone with developer tools. Closing that means revoking anon on both
-- tables and routing every buyer read through functions like these -- a whole
-- batch, tracked in docs/OUTSTANDING.md, not something to smuggle in here.
-- =============================================================================

set search_path = wholesale_v2, public;

create or replace function wholesale_v2.v2_buyer_catalogs(p_account_id uuid)
returns table (id uuid, name text, description text, is_default boolean, access_tier smallint)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
  v_tier smallint;
begin
  select * into v_acct from wholesale_v2.v2_portal_accounts
  where v2_portal_accounts.id = p_account_id
    and role in ('buyer', 'sales') and active;

  -- No error: an unknown or deactivated account simply sees nothing.
  if v_acct.id is null then
    return;
  end if;

  select c.access_tier into v_tier
  from wholesale_v2.v2_clients c where c.id = v_acct.client_id;
  -- A buyer with no client row (a rep browsing, a half-provisioned account)
  -- lands on tier 1, the bottom rung. Defaulting UP would hand the most
  -- restricted catalogs to exactly the accounts we know least about.
  v_tier := coalesce(v_tier, 1);

  return query
  select c.id, c.name, c.description, c.is_default, c.access_tier
  from wholesale_v2.v2_catalogs c
  where c.wid = v_acct.wid
    and c.active
    and c.access_tier <= v_tier
  order by c.is_default desc, c.name;
end;
$fn$;

revoke all on function wholesale_v2.v2_buyer_catalogs(uuid) from public;
grant execute on function wholesale_v2.v2_buyer_catalogs(uuid) to anon, authenticated;

create or replace function wholesale_v2.v2_buyer_catalog_products(p_account_id uuid, p_catalog_id uuid)
returns table (product_id uuid, sort_order int)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  -- The gate is re-applied HERE, not assumed from the caller having been shown
  -- the catalog. A buyer who guessed an id would otherwise get its contents
  -- without ever having been offered it.
  if not exists (
    select 1 from wholesale_v2.v2_buyer_catalogs(p_account_id) bc where bc.id = p_catalog_id
  ) then
    return;
  end if;

  return query
  select cp.product_id, cp.sort_order
  from wholesale_v2.v2_catalog_products cp
  join wholesale_v2.v2_products p on p.id = cp.product_id
  where cp.catalog_id = p_catalog_id
    and not p.archived
  order by cp.sort_order, cp.added_at;
end;
$fn$;

revoke all on function wholesale_v2.v2_buyer_catalog_products(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_catalog_products(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- v2_submit_order now records the catalog, and CHECKS THE CLAIM
-- ---------------------------------------------------------------------
-- The catalog decides the discount. Without validation, a buyer who could name
-- any catalog id could name the deepest-discounted one and pay its prices from
-- anywhere -- so the id is checked against v2_buyer_catalogs for that same
-- account before it is honoured.
--
-- The old 6-argument signature is DROPPED, not replaced: `create or replace`
-- does not replace a function whose parameter list changed, it adds an
-- overload, and PostgREST then refuses every call as ambiguous. That exact
-- mistake is documented in migration 010.
--
-- The whole body is reproduced below rather than referenced. It is long and
-- almost all of it is unchanged, which is exactly why it has to be here: a
-- migration file that describes a change instead of containing it cannot
-- rebuild the database, and the first person to find that out will be someone
-- restoring from scratch at the worst possible moment.
--
-- Three changes from the previous version, and nothing else:
--   1. p_catalog_id parameter, defaulted so older callers keep working
--   2. the "is this catalog yours to shop" check, right after the account check
--   3. catalog_id on the order insert, and p_catalog_id passed to pricing

drop function if exists wholesale_v2.v2_submit_order(text, text, uuid, jsonb, uuid, uuid);

create or replace function wholesale_v2.v2_submit_order(
  p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb,
  p_client_id uuid default null, p_account_id uuid default null,
  p_catalog_id uuid default null
)
 returns wholesale_v2.v2_orders
 language plpgsql
 security definer
 set search_path to 'wholesale_v2'
as $function$
declare
  v_order wholesale_v2.v2_orders;
  v_line record;
  v_product record;
  v_wholesaler record;
  v_subtotal numeric(12,2) := 0;
  v_line_total numeric(12,2);
  v_unit_price numeric(12,2);
  v_is_reorder boolean;
  v_effective_moq int;
  v_total_qty int := 0;
  v_line_count int;
  v_account wholesale_v2.v2_portal_accounts%rowtype;
  v_pack_line record;
  v_pack wholesale_v2.v2_pack_definitions%rowtype;
  v_mismatch int;
begin
  if p_account_id is not null then
    select * into v_account from v2_portal_accounts
    where id = p_account_id and role = 'buyer' and active = true;
    if v_account.id is null then
      raise exception 'invalid or inactive buyer session -- please log in again';
    end if;
    p_wid := v_account.wid;
    p_client_id := v_account.client_id;
    p_buyer_label := v_account.actor_label;
  end if;

  -- CHANGE 2 of 3. The catalog decides the discount, so a buyer who could name
  -- any catalog id could name the deepest-discounted one and pay it from
  -- anywhere. Checked against what this account is actually allowed to see, by
  -- the same function that decides what it is shown.
  if p_catalog_id is not null and p_account_id is not null then
    if not exists (
      select 1 from v2_buyer_catalogs(p_account_id) bc where bc.id = p_catalog_id
    ) then
      raise exception 'that catalog is not available to your account';
    end if;
  end if;

  if jsonb_array_length(p_lines) = 0 then
    raise exception 'cannot submit an empty order';
  end if;

  create temporary table tmp_order_lines on commit drop as
  select
    (l->>'variant_id')::uuid as variant_id,
    (l->>'qty')::integer as qty,
    (l->>'reservation_id')::bigint as reservation_id,
    (l->>'pack_id')::uuid as pack_id,
    (l->>'pack_line_id')::uuid as pack_line_id,
    nullif(l->>'pack_qty', '')::integer as pack_qty,
    pv.product_id as product_id,
    pv.moq_qty as variant_moq_qty,
    pv.sku as sku
  from jsonb_array_elements(p_lines) l
  join v2_product_variants pv on pv.id = (l->>'variant_id')::uuid;

  select jsonb_array_length(p_lines) into v_line_count;
  if (select count(*) from tmp_order_lines) <> v_line_count then
    raise exception 'one or more order lines reference an unknown product variant';
  end if;

  -- =============== MIGRATION 028 -- pack lines must be real ==========
  if exists (
    select 1 from tmp_order_lines
    where (pack_id is null) <> (pack_line_id is null)
  ) then
    raise exception 'malformed pack line: pack_id and pack_line_id must both be supplied';
  end if;

  for v_pack_line in
    select
      pack_line_id,
      (array_agg(pack_id))[1]    as pack_id,
      count(distinct pack_id)    as distinct_pack_ids,
      min(pack_qty)              as pack_qty,
      count(distinct pack_qty)   as distinct_pack_qtys,
      count(*)                   as line_count,
      count(distinct variant_id) as distinct_variants
    from tmp_order_lines
    where pack_line_id is not null
    group by pack_line_id
  loop
    if v_pack_line.distinct_pack_ids <> 1 or v_pack_line.distinct_pack_qtys <> 1 then
      raise exception 'invalid pack line: all lines in one pack must share the same pack and pack quantity';
    end if;

    if v_pack_line.pack_qty is null or v_pack_line.pack_qty < 1 then
      raise exception 'invalid pack line: pack quantity must be 1 or more';
    end if;

    if v_pack_line.line_count <> v_pack_line.distinct_variants then
      raise exception 'invalid pack line: a variant may appear only once per pack line';
    end if;

    select * into v_pack
    from v2_pack_definitions
    where id = v_pack_line.pack_id and wid = p_wid and not archived;

    if not found then
      raise exception 'invalid pack line: pack % does not exist for this wholesaler (or is archived)', v_pack_line.pack_id;
    end if;

    select count(*) into v_mismatch from (
      (
        select variant_id, qty
          from tmp_order_lines
         where pack_line_id = v_pack_line.pack_line_id
        except
        select pc.variant_id, (pc.qty_per_pack * v_pack_line.pack_qty)::int
          from v2_pack_components pc
         where pc.pack_id = v_pack_line.pack_id
      )
      union all
      (
        select pc.variant_id, (pc.qty_per_pack * v_pack_line.pack_qty)::int
          from v2_pack_components pc
         where pc.pack_id = v_pack_line.pack_id
        except
        select variant_id, qty
          from tmp_order_lines
         where pack_line_id = v_pack_line.pack_line_id
      )
    ) diff;

    if v_mismatch > 0 then
      raise exception 'invalid pack line: submitted quantities do not match the composition of pack "%"', v_pack.name;
    end if;
  end loop;
  -- =============== end of migration 028 ==============================

  -- =============== MIGRATION 029 -- selling model ====================
  for v_product in
    select tol.product_id,
           bool_and(tol.pack_line_id is not null) as all_lines_are_pack_lines
      from tmp_order_lines tol
     group by tol.product_id
  loop
    perform v2_enforce_selling_model(
      v_product.product_id,
      v_product.all_lines_are_pack_lines,
      (select name from v2_products where id = v_product.product_id));
  end loop;
  -- =============== end of migration 029 ==============================

  for v_line in select * from tmp_order_lines where qty < variant_moq_qty and pack_line_id is null loop
    raise exception 'SKU % requires a minimum of % units per order (you have %)', v_line.sku, v_line.variant_moq_qty, v_line.qty;
  end loop;

  for v_product in
    select product_id, sum(qty) as agg_qty
    from tmp_order_lines
    group by product_id
  loop
    if p_client_id is not null then
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.client_id = p_client_id and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    else
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.buyer_label = p_buyer_label and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    end if;

    select case when v_is_reorder then coalesce(moq_reorder_qty, moq_qty) else moq_qty end
    into v_effective_moq
    from v2_products where id = v_product.product_id;

    if v_product.agg_qty < v_effective_moq then
      raise exception 'Product requires a minimum of % units total across colours/sizes (% order, you have %)',
        v_effective_moq, case when v_is_reorder then 'reorder' else 'first' end, v_product.agg_qty;
    end if;
  end loop;

  select order_min_qty, order_min_value into v_wholesaler from v2_wholesalers where wid = p_wid;
  select sum(qty) into v_total_qty from tmp_order_lines;
  if v_wholesaler.order_min_qty is not null and v_total_qty < v_wholesaler.order_min_qty then
    raise exception 'This wholesaler requires a minimum order of % units total (you have %)', v_wholesaler.order_min_qty, v_total_qty;
  end if;

  -- CHANGE 3a of 3: the order records which catalog it came through.
  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal, catalog_id)
  values (p_wid, p_buyer_label, p_client_id, p_location_id, 'new', 0, p_catalog_id)
  returning * into v_order;

  for v_line in
    select tol.*, agg.agg_qty
    from tmp_order_lines tol
    join (select product_id, sum(qty) as agg_qty from tmp_order_lines group by product_id) agg
      on agg.product_id = tol.product_id
  loop
    perform v2_confirm_reservation(v_line.reservation_id, v_order.id, null);

    -- CHANGE 3b of 3: the catalog reaches the price rule.
    v_unit_price := v2_effective_unit_price(v_line.product_id, v_line.variant_id, p_client_id, v_line.agg_qty, p_catalog_id);
    v_line_total := v_line.qty * v_unit_price;
    v_subtotal := v_subtotal + v_line_total;

    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total, pack_id, pack_line_id, pack_qty)
    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total, v_line.pack_id, v_line.pack_line_id, v_line.pack_qty);
  end loop;

  if v_wholesaler.order_min_value is not null and v_subtotal < v_wholesaler.order_min_value then
    raise exception 'This wholesaler requires a minimum order value of % (this order totals %)', v_wholesaler.order_min_value, v_subtotal;
  end if;

  update v2_orders set subtotal = v_subtotal, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$function$;

revoke all on function wholesale_v2.v2_submit_order(text, text, uuid, jsonb, uuid, uuid, uuid) from public;
grant execute on function wholesale_v2.v2_submit_order(text, text, uuid, jsonb, uuid, uuid, uuid) to anon, authenticated;
