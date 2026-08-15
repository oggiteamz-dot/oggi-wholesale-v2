-- OGGI Wholesale v2 — Migration 028: validate pack lines server-side
-- 15 Aug 2026
--
-- WHAT WAS WRONG
-- --------------
-- v2_submit_order SKIPS the per-SKU minimum-order-quantity check for any
-- order line carrying a pack_line_id. The business rule behind that skip is
-- correct: a pack is the sellable unit, so a pack containing 1xS is
-- legitimately allowed even when the S SKU's own minimum is 12.
--
-- The defect is that nothing ever opened v2_pack_definitions or
-- v2_pack_components. The server took the CLIENT'S WORD that a line came
-- from a pack. Anything that can call the API -- including a modified
-- browser -- could attach an invented pack_line_id to an ordinary line and
-- switch the SKU minimum off.
--
-- Reproduced on a real Postgres before this fix: an order for 1 unit of a
-- SKU with a 12-unit minimum was ACCEPTED and written to v2_order_items,
-- using pack_line_id 9999...9999, which matches no pack at all.
--
-- Minimum order quantity is the wholesale business model. A minimum a
-- customer can turn off from their own browser is not a rule, it is a
-- suggestion.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Adds one validation block before the MOQ checks. A line only earns the
-- per-SKU skip if it is a real pack line, proven server-side:
--   1. pack_id and pack_line_id must be supplied together.
--   2. pack_qty must be a whole number of packs, 1 or more.
--   3. Every line sharing a pack_line_id must name the same pack and qty.
--   4. The pack must exist, not be archived, and belong to THIS wholesaler.
--   5. The lines must match the pack's real composition EXACTLY -- same
--      variants, each qty = qty_per_pack x pack_qty. No missing components,
--      no extra variants, no altered quantities.
--
-- BASED ON MIGRATION 024, NOT 012  -- read this before editing
-- ----------------------------------------------------------
-- The first draft of this migration was built on migration 012's copy of
-- v2_submit_order and would have caused real damage if applied:
--   * 012's function takes 5 parameters. The LIVE one takes 6 -- migration
--     024 added p_account_id, which makes the server take wid/client_id/
--     buyer_label from the authenticated account instead of the caller's
--     claims. Rebuilding from 012 would have DELETED that protection and
--     reopened the "submit an order as any buyer" gap.
--   * 012 declares `search_path = public`. Migration 026 moved every v2
--     object into the `wholesale_v2` schema. An unqualified create would
--     have written a stray function into `public` and left the live,
--     vulnerable one untouched -- a fix that appears applied and is not.
--
-- So: this file is migration 024's function, verbatim, plus the block
-- marked "NEW IN MIGRATION 028", retargeted to the wholesale_v2 schema.
-- Any future edit must rebase on the CURRENT live definition, not on
-- whichever older migration is easiest to find.
--
-- VERIFIED
-- --------
-- checks/check_pack_moq.sh -- 11 assertions, negative-tested: green on this
-- version, RED (7 failures) when the pre-fix function is restored, green
-- again when reapplied. The 3 acceptance cases confirm the legitimate rule
-- still works: a genuine pack IS still allowed below per-SKU minimums.
--
-- NOT CHANGED HERE (flagged for a separate decision):
--   v2_pack_definitions.pack_price is still never applied at checkout --
--   every line is priced individually by v2_effective_unit_price, so a flat
--   pack price is stored and displayed but does not affect what a buyer is
--   charged. That is a pricing decision, not a security fix.
--
-- KNOWN BEHAVIOUR CHANGE:
--   The cart stores a pack's composition as a snapshot at add-to-cart time.
--   If a wholesaler edits a pack while it sits in a buyer's cart, checkout
--   now fails with "quantities do not match the composition" instead of
--   silently ordering the stale composition. Rejecting is the safer
--   behaviour, but the message is unhelpful to a buyer -- worth a friendlier
--   "this pack changed, please review your cart" path in the UI.

create or replace function wholesale_v2.v2_submit_order(
  p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb,
  p_client_id uuid default null, p_account_id uuid default null
)
returns v2_orders
language plpgsql
security definer
set search_path = wholesale_v2
as $$
declare
  v_order v2_orders;
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
  v_account v2_portal_accounts%rowtype;
  -- New in 028: used by the pack-line validation block.
  v_pack_line record;
  v_pack v2_pack_definitions%rowtype;
  v_mismatch int;
begin
  if p_account_id is not null then
    select * into v_account from v2_portal_accounts
    where id = p_account_id and role = 'buyer' and active = true;
    if v_account.id is null then
      raise exception 'invalid or inactive buyer session -- please log in again';
    end if;
    -- Authoritative values come from the account row, not the caller's
    -- own claims, from this point on.
    p_wid := v_account.wid;
    p_client_id := v_account.client_id;
    p_buyer_label := v_account.actor_label;
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

  -- ===================================================================
  -- NEW IN MIGRATION 028 -- prove every claimed pack line is a real one.
  --
  -- Runs BEFORE the MOQ checks, because it decides which lines are
  -- entitled to skip the per-SKU minimum. Everything above and below is
  -- migration 024's function, unchanged -- including the p_account_id
  -- authority override, which must not be lost.
  -- ===================================================================

  -- Step 1: the two pack identifiers travel together or not at all.
  -- A line with one but not the other is malformed input, not a pack.
  if exists (
    select 1 from tmp_order_lines
    where (pack_id is null) <> (pack_line_id is null)
  ) then
    raise exception 'malformed pack line: pack_id and pack_line_id must both be supplied';
  end if;

  -- Step 2..5: check each claimed pack line against the real definition.
  for v_pack_line in
    select
      pack_line_id,
      -- array_agg(...)[1] rather than min(): Postgres has no min() for uuid.
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
    -- One pack line must describe exactly one pack, bought a fixed number
    -- of times. Mixed values here mean the payload was hand-edited.
    if v_pack_line.distinct_pack_ids <> 1 or v_pack_line.distinct_pack_qtys <> 1 then
      raise exception 'invalid pack line: all lines in one pack must share the same pack and pack quantity';
    end if;

    if v_pack_line.pack_qty is null or v_pack_line.pack_qty < 1 then
      raise exception 'invalid pack line: pack quantity must be 1 or more';
    end if;

    -- The same variant twice inside one pack line would let a tampered
    -- payload hide an extra quantity from the set comparison below.
    if v_pack_line.line_count <> v_pack_line.distinct_variants then
      raise exception 'invalid pack line: a variant may appear only once per pack line';
    end if;

    -- The pack must be real, live, and this wholesaler's. Note p_wid here
    -- is the authoritative one: if p_account_id was supplied, the block at
    -- the top of this function already replaced it with the account's own
    -- wid, so a buyer cannot reach another wholesaler's packs.
    select * into v_pack
    from v2_pack_definitions
    where id = v_pack_line.pack_id and wid = p_wid and not archived;

    if not found then
      raise exception 'invalid pack line: pack % does not exist for this wholesaler (or is archived)', v_pack_line.pack_id;
    end if;

    -- The decisive check: submitted lines must equal the pack's real
    -- composition, scaled by how many packs were ordered. EXCEPT in both
    -- directions catches missing components, extra variants and altered
    -- quantities in one comparison.
    --
    -- Parentheses matter: EXCEPT and UNION ALL share precedence and bind
    -- left to right, so without them this computes ((A-B) u B) - A, which
    -- is not the symmetric difference and would silently pass bad payloads.
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

  -- =============== end of migration 028 additions ====================

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

  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal)
  values (p_wid, p_buyer_label, p_client_id, p_location_id, 'new', 0)
  returning * into v_order;

  for v_line in
    select tol.*, agg.agg_qty
    from tmp_order_lines tol
    join (select product_id, sum(qty) as agg_qty from tmp_order_lines group by product_id) agg
      on agg.product_id = tol.product_id
  loop
    perform v2_confirm_reservation(v_line.reservation_id, v_order.id, null);

    v_unit_price := v2_effective_unit_price(v_line.product_id, v_line.variant_id, p_client_id, v_line.agg_qty);
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
$$;