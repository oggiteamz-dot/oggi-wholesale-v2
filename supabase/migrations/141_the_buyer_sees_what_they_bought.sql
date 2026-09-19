-- =============================================================================
-- 141 — THE BUYER SEES WHAT THEY BOUGHT                          19 Sep 2026
-- =============================================================================
--
-- WHY
-- ---
-- /buyer/orders renders an order's contents as a comma-joined sentence:
--
--     29× M-112 Carrot Fit Jean (Washed Black/32), 29× K-605 Insulated Work
--     Jacket (Dark Indigo/S), 29× W-205 Straight Leg Jean — Mid Rise …
--
-- That is a receipt, not a record of a purchase. Hadi has now asked twice for
-- the product's photograph to be on that screen, and has named it a gate:
-- every screen that shows an ordered product shows that product's image.
--
-- The photographs were already there. Measured on production, 19 Sep 2026:
--
--     370 order lines  ·  280 whose variant carries a photo (76%)
--       0 currently shown
--
-- and all six real demo wholesalers are at 100% product coverage — Meridian
-- 53/53, Casa Sole 11/11, Vantage Athletic 10/10, Loom & Ash 10/10, Petit
-- Nord 10/10, Atelier Ronde 10/10. The 90 line items with no photograph
-- anywhere belong to the seeded junk tenants.
--
-- This function ALREADY joins v2_product_variants and v2_products to read the
-- sku and the product name. The image column sits on the row it already has,
-- and was never put in the object. That is the whole defect.
--
-- WHAT CHANGES
-- ------------
-- One new key per item: `imageUrl`. Additive. Nothing is renamed, nothing is
-- removed, every existing key keeps its name and its type, so no caller can
-- break on this.
--
-- Resolution order, and why:
--   1. pv.image_url   — the variant's own primary photograph.
--   2. pv.images->>0  — the first of its gallery. `images` is an array of
--                       plain URL strings (verified on production, 1,611 rows).
--   3. null           — the client renders a deliberate placeholder that says
--                       "no photo yet". An honest gap, never a broken image,
--                       and never a photograph of a different garment.
--
-- The image is taken from the VARIANT, not the product. A buyer who ordered
-- the black jean is shown the black one. Falling back to a sibling variant's
-- photograph would put the brown jean in front of them, which is the exact
-- wrong-picture-read-as-fact that CR-0004 removed from the product card on
-- 25 Aug. Hadi, that day: "if it's not available, then it's not available."
--
-- WHAT THIS MIGRATION MUST NOT BREAK
-- ----------------------------------
-- Migration 087 asserts, against the INSTALLED body of this function, that it
-- returns `buyerNote` and that it never mentions the wholesaler's internal
-- warehouse instruction — a buyer must not be handed a shipping-label note.
-- That assertion is a bare token search over the source, so this file may not
-- use the phrase either, in code OR in a comment. Both of 087's assertions are
-- re-run at the bottom of this file, so this migration fails here rather than
-- letting 087 fail on the next deploy.
-- =============================================================================

create or replace function wholesale_v2.v2_get_buyer_orders(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = wholesale_v2
as $function$
declare
  -- SCHEMA-QUALIFIED. checks/check_migration_chain.mjs: an unqualified v2 type
  -- reference in a migration after 026 resolves against the RUNNER's
  -- search_path, not the function's. It is harmless here because the function
  -- sets its own -- and that is exactly the reasoning that lets the next one
  -- through, so the rule is kept mechanical.
  v_account wholesale_v2.v2_portal_accounts%rowtype;
  v_result jsonb;
begin
  select * into v_account from v2_portal_accounts
  where id = p_account_id and role = 'buyer' and active = true;

  if v_account.id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(o_row order by o_row.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      o.id, o.status, o.subtotal, o.notes, o.created_at, o.location_id,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'variantId', oi.variant_id,
          'productId', pv.product_id,
          'qty', oi.qty,
          'unitPrice', oi.unit_price,
          'lineTotal', oi.line_total,
          'sku', pv.sku,
          'productName', p.name,
          'color', pv.extra_attrs->>'color',
          'size', pv.extra_attrs->>'size',
          'packId', oi.pack_id,
          'packLineId', oi.pack_line_id,
          'packQty', oi.pack_qty,
          -- Migration 087: the buyer's OWN words, returned to the buyer.
          -- The wholesaler's internal warehouse instruction is deliberately
          -- NOT here, and assertion 4 of migration 087 fails if it ever is.
          'buyerNote', oi.buyer_note,
          -- Migration 141: the photograph of the thing they actually bought.
          -- THIS VARIANT's photograph, never a sibling's -- see the header.
          'imageUrl', coalesce(pv.image_url, pv.images->>0)
        )), '[]'::jsonb)
        from v2_order_items oi
        join v2_product_variants pv on pv.id = oi.variant_id
        join v2_products p on p.id = pv.product_id
        where oi.order_id = o.id
      ) as items
    from v2_orders o
    where o.wid = v_account.wid
      and (
        (v_account.client_id is not null and o.client_id = v_account.client_id)
        or (v_account.client_id is null and o.buyer_label = v_account.actor_label)
      )
  ) o_row;

  return v_result;
end;
$function$;

-- --------------------------------------------------------------- self-assert
--
-- Five checks. The first three are text searches over the installed body; the
-- last two CALL the function, because a body that mentions `imageUrl` and
-- returns null for every line would pass a text search and fail a buyer.
-- checks/README.md: a check that has only ever been green may be passing for a
-- reason you did not intend.
do $verify$
declare
  v_src        text;
  v_account    uuid;
  v_orders     jsonb;
  v_with_image int;
  v_lines      int;
  v_keys       text[];
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'wholesale_v2' and p.proname = 'v2_get_buyer_orders';

  if v_src is null then
    raise exception '141 ASSERT 1 FAILED: v2_get_buyer_orders does not exist after this migration.';
  end if;

  if position('imageUrl' in v_src) = 0 then
    raise exception '141 ASSERT 2 FAILED: the installed body does not mention imageUrl. The replace did not take.';
  end if;

  -- 087's two assertions, re-run here so a mistake in THIS file fails in THIS
  -- file rather than at the top of the next deploy.
  if position('buyerNote' in v_src) = 0 then
    raise exception '141 ASSERT 3 FAILED: buyerNote is gone. 141 has undone migration 087 -- a buyer can no longer read back their own note.';
  end if;
  if position('fulfil' || '_note' in v_src) > 0 then
    raise exception '141 ASSERT 4 FAILED: the installed body mentions the wholesaler''s internal note. 087 exists to keep that away from buyers.';
  end if;

  -- ---- the two that actually prove it -------------------------------------
  -- A buyer account that has at least one order line whose variant carries a
  -- photograph. If production has none, there is nothing to prove and the
  -- checks are skipped out loud rather than reported as passing.
  -- SCHEMA-QUALIFIED THROUGHOUT. A `do` block does not inherit the function's
  -- `set search_path`; it runs on the session's, which on a fresh connection
  -- does not include wholesale_v2. The first run of this migration failed here
  -- with `relation "v2_portal_accounts" does not exist` -- and failed CLEANLY,
  -- rolling the function back with it, which is the behaviour to want.
  select a.id into v_account
  from wholesale_v2.v2_portal_accounts a
  where a.role = 'buyer' and a.active = true
    and exists (
      select 1
      from wholesale_v2.v2_orders o
      join wholesale_v2.v2_order_items oi on oi.order_id = o.id
      join wholesale_v2.v2_product_variants pv on pv.id = oi.variant_id
      where o.wid = a.wid
        and ((a.client_id is not null and o.client_id = a.client_id)
             or (a.client_id is null and o.buyer_label = a.actor_label))
        and coalesce(pv.image_url, pv.images->>0) is not null
    )
  limit 1;

  if v_account is null then
    raise notice '141: SKIPPED the two live checks -- no buyer account on this database has an ordered line with a photograph. Nothing to prove, and nothing is claimed.';
    return;
  end if;

  v_orders := wholesale_v2.v2_get_buyer_orders(v_account);

  select count(*)                                    ,
         count(*) filter (where item->>'imageUrl' is not null)
    into v_lines, v_with_image
  from jsonb_array_elements(v_orders) ord,
       jsonb_array_elements(ord->'items') item;

  if v_lines = 0 then
    raise exception '141 ASSERT 5 FAILED: the chosen buyer account read back zero order lines. The function is returning nothing for an account that demonstrably has orders.';
  end if;

  if v_with_image = 0 then
    raise exception '141 ASSERT 6 FAILED: % lines came back and not one carries an imageUrl, though this account was chosen BECAUSE it has a photographed line. The key is in the body and the value is not reaching the buyer.', v_lines;
  end if;

  -- And every key 087 and earlier put there is still there. A silent rename is
  -- how a screen loses a field and nobody notices until a buyer does.
  select array_agg(k order by k) into v_keys
  from (
    select distinct jsonb_object_keys(item) as k
    from jsonb_array_elements(v_orders) ord,
         jsonb_array_elements(ord->'items') item
  ) s;

  if not (v_keys @> array['variantId','productId','qty','unitPrice','lineTotal',
                          'sku','productName','color','size','packId','packLineId',
                          'packQty','buyerNote','imageUrl']) then
    raise exception '141 ASSERT 7 FAILED: an item key went missing. Present: %', v_keys;
  end if;

  raise notice '141: OK -- % of % order lines for the sampled buyer now carry a photograph, and all 14 item keys survive.', v_with_image, v_lines;
end;
$verify$;
