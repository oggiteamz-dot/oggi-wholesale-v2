-- =============================================================================
-- 135 — THE WAREHOUSE DESK, AND IT NEVER SEES MONEY    Block 7, 11 September 2026
-- =============================================================================
--
-- ==== ⭐ THE CLAIM THIS MIGRATION EXISTS TO MAKE TRUE ========================
--
--        NO FUNCTION A PICKER CAN CALL RETURNS A PRICE, A TOTAL OR A COST.
--
-- Not hidden by CSS. Not omitted by the screen. NOT IN THE RETURN TABLE, so
-- there is nothing on the wire for a screen to accidentally render, for a
-- browser extension to read, or for the next person to "just add to the header
-- while I'm here".
--
-- WHY, PLAINLY. A picker does not need a price in order to pick. What a price on
-- a pick sheet IS, is a price on the warehouse floor -- on a tablet that sits on
-- a bench all day, readable by everyone who walks past it, including the casual
-- staff and the driver from another company waiting for a collection. The
-- wholesale margin on a garment is the single most commercially sensitive number
-- a wholesaler has, and 031/032 already strip `cost` from every browser role for
-- exactly that reason.
--
-- This is the same instinct as DR-05 (the directory carries a name and a
-- category and NOWHERE TO PUT a product count) and as 088 (the handoff link
-- deliberately does not return cost, supplier_id or the fulfilment note). The
-- pattern this repo keeps arriving at: THE SAFEST COLUMN IS THE ONE THAT IS NOT
-- IN THE SIGNATURE.
--
-- The self-test at the bottom asserts it MECHANICALLY -- it reads the function's
-- own declared OUT parameters and fails on any name that looks like money. A
-- comment saying "no prices here" is a wish; that is a fact.
--
-- ==== ⭐ AND fulfil_note FINALLY HAS A READER ===============================
--
-- Migration 087 created `fulfil_note`, quoting Hadi: when the wholesaler wants
-- to send the order "to their warehouse ... they can add in either a voice note
-- or a written comment telling the people what to do."
--
-- That was 28 August. THE COLUMN HAS NEVER BEEN READ BY ANYBODY, because there
-- has been no warehouse account in this system. Every order written since then
-- has carried an instruction to a department that could not open it.
--
-- This is the reader. 087 also insists that `fulfil_note` and `buyer_note` never
-- share a surface with the customer -- and they do not: `buyer_note` reaches the
-- picker here because the picker is exactly who "send the darker blue" is for,
-- while `fulfil_note` still appears in no buyer-facing function anywhere.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ================================================================== THE QUEUE
create or replace function wholesale_v2.v2_warehouse_queue(p_staff_id uuid)
returns table(
  order_id        uuid,
  reference       text,
  buyer_label     text,
  placed_at       timestamptz,
  state           text,
  sent_at         timestamptz,
  line_count      integer,
  unit_count      integer,
  picked_count    integer,
  has_fulfil_note boolean,
  has_buyer_note  boolean,
  location_name   text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text;
begin
  -- THE ONE GATE (133). Null means: wrong desk, no such account, suspended, or
  -- a closed store -- and the caller cannot tell which, on purpose.
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'warehouse');
  if v_wid is null then return; end if;

  return query
  select
    o.id,
    -- The first eight characters of the uuid. A picker needs to say an order
    -- out loud across a room; a 36-character uuid is not sayable and a
    -- sequential number would leak how many orders the business takes.
    upper(substr(o.id::text, 1, 8)),
    o.buyer_label,
    o.created_at,
    a.state,
    a.sent_at,
    (select count(*)::integer from wholesale_v2.v2_order_items i where i.order_id = o.id),
    (select coalesce(sum(i.qty),0)::integer from wholesale_v2.v2_order_items i where i.order_id = o.id),
    (select coalesce(sum(p.picked_qty),0)::integer from wholesale_v2.v2_order_pick_items p where p.order_id = o.id),
    coalesce(trim(o.fulfil_note),'') <> ''
      or exists (select 1 from wholesale_v2.v2_order_items i
                  where i.order_id = o.id and coalesce(trim(i.fulfil_note),'') <> ''),
    coalesce(trim(o.notes),'') <> ''
      or exists (select 1 from wholesale_v2.v2_order_items i
                  where i.order_id = o.id and coalesce(trim(i.buyer_note),'') <> ''),
    l.name
  from wholesale_v2.v2_order_desk_assignments a
  join wholesale_v2.v2_orders o on o.id = a.order_id
  left join wholesale_v2.v2_locations l on l.id = o.location_id
  where a.wid = v_wid            -- the tenant, from the GATE, never from the caller
    and a.desk = 'warehouse'
    and a.state in ('sent','accepted')
  order by a.sent_at asc;        -- oldest first. A queue that reorders itself is not a queue.
end;
$fn$;

comment on function wholesale_v2.v2_warehouse_queue(uuid) is
  'The warehouse desk''s queue. Migration 135. Returns NO price, total or cost '
  'by construction -- see the header, and the self-test that reads this '
  'function''s own OUT parameters and fails on any money-shaped name.';

revoke all on function wholesale_v2.v2_warehouse_queue(uuid) from public;
grant execute on function wholesale_v2.v2_warehouse_queue(uuid) to anon, authenticated;

-- =================================================================== ONE ORDER
create or replace function wholesale_v2.v2_warehouse_order(p_staff_id uuid, p_order_id uuid)
returns table(
  order_item_id   bigint,
  variant_id      uuid,
  product_name    text,
  sku             text,
  colour          text,
  colour_hex      text,
  size            text,
  qty             integer,
  picked_qty      integer,
  -- The pack this line came from, so the screen can show a prepack AS a pack
  -- and ALSO exploded into pickable pieces -- manifest rows 136/170. A picker
  -- fetching a sealed prepack box wants to know it is one box; a picker
  -- checking it wants the pieces.
  pack_id         uuid,
  pack_qty        integer,
  buyer_note      text,     -- the customer's words. "Send the darker blue."
  fulfil_note     text,     -- ⭐ 087's column, reaching its audience at last
  image_url       text,
  qty_on_hand     integer,  -- at THIS order's location, so "is it even here?"
  barcode         text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_loc uuid;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'warehouse');
  if v_wid is null then return; end if;

  -- ⛔ The order must be ON THIS DESK, at THIS STORE. Both conditions, because
  -- an order id is a uuid and "hard to guess" has never been an access rule in
  -- this schema (088's rule 1). A warehouse manager may not read an order that
  -- was never sent to them, even at their own store.
  select o.location_id into v_loc
    from wholesale_v2.v2_orders o
    join wholesale_v2.v2_order_desk_assignments a
      on a.order_id = o.id and a.desk = 'warehouse'
   where o.id = p_order_id and o.wid = v_wid and a.wid = v_wid
     and a.state in ('sent','accepted','done');
  if not found then return; end if;

  return query
  select
    i.id,
    i.variant_id,
    coalesce(p.name, 'Product'),
    v.sku,
    nullif(v.extra_attrs->>'color',''),
    nullif(v.extra_attrs->>'colorHex',''),
    nullif(v.extra_attrs->>'size',''),
    i.qty,
    coalesce(pk.picked_qty, 0),
    i.pack_id,
    i.pack_qty,
    i.buyer_note,
    i.fulfil_note,
    coalesce(v.image_url, (case when jsonb_typeof(to_jsonb(v.images)) = 'array'
                                then (to_jsonb(v.images)->>0) else null end)),
    coalesce(b.qty_on_hand, 0),
    v.barcode
  from wholesale_v2.v2_order_items i
  join wholesale_v2.v2_product_variants v on v.id = i.variant_id
  left join wholesale_v2.v2_products p on p.id = v.product_id
  left join wholesale_v2.v2_order_pick_items pk
         on pk.order_id = i.order_id and pk.order_item_id = i.id
  left join wholesale_v2.v2_inventory_balances b
         on b.variant_id = i.variant_id and b.location_id = v_loc
  where i.order_id = p_order_id
  order by coalesce(p.name,''), nullif(v.extra_attrs->>'color',''), i.id;
end;
$fn$;

comment on function wholesale_v2.v2_warehouse_order(uuid,uuid) is
  'One order, for the warehouse desk. Migration 135. NO unit_price, line_total, '
  'subtotal or cost -- the return table has nowhere to put them. Reads '
  'fulfil_note (087), which until this migration had no reader anywhere in the '
  'product. Refuses an order that was never sent to this desk, even at the '
  'staff member''s own store.';

revoke all on function wholesale_v2.v2_warehouse_order(uuid,uuid) from public;
grant execute on function wholesale_v2.v2_warehouse_order(uuid,uuid) to anon, authenticated;

-- ============================================== the whole-order note, once
create or replace function wholesale_v2.v2_warehouse_order_head(p_staff_id uuid, p_order_id uuid)
returns table(
  order_id      uuid,
  reference     text,
  buyer_label   text,
  placed_at     timestamptz,
  state         text,
  order_note    text,     -- the buyer's note on the order as a whole
  fulfil_note   text,     -- the wholesaler's instruction for the order as a whole
  location_name text,
  return_reason text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'warehouse');
  if v_wid is null then return; end if;
  return query
  select o.id, upper(substr(o.id::text,1,8)), o.buyer_label, o.created_at,
         a.state, o.notes, o.fulfil_note, l.name, a.return_reason
    from wholesale_v2.v2_orders o
    join wholesale_v2.v2_order_desk_assignments a
      on a.order_id = o.id and a.desk='warehouse' and a.wid = v_wid
    left join wholesale_v2.v2_locations l on l.id = o.location_id
   where o.id = p_order_id and o.wid = v_wid;
end;
$fn$;

revoke all on function wholesale_v2.v2_warehouse_order_head(uuid,uuid) from public;
grant execute on function wholesale_v2.v2_warehouse_order_head(uuid,uuid) to anon, authenticated;

-- =============================================================================
-- SELF-TEST — ⭐ THE MONEY WALL, ASSERTED MECHANICALLY
-- =============================================================================
do $$
declare
  n integer;
  bad text;
begin
  -- ⭐ ASSERT 1. Read the three functions' OWN declared OUT parameters and fail
  -- on any name that looks like money. This is the assertion the whole migration
  -- is for: it survives a rewrite of the function bodies, it catches a column
  -- added in six months by somebody who never read this header, and it cannot be
  -- satisfied by a comment.
  select string_agg(p.specific_name || '.' || p.parameter_name, ', ')
    into bad
    from information_schema.parameters p
   where p.specific_schema = 'wholesale_v2'
     and p.parameter_mode = 'OUT'
     and p.specific_name like 'v2_warehouse_%'
     and (
          p.parameter_name ~* '(price|cost|total|subtotal|amount|margin|discount|value|revenue|invoice)'
     );
  if bad is not null then
    raise exception 'ASSERT 1 FAILED: a WAREHOUSE function returns money -- %. A price on a pick sheet is a price on the warehouse floor.', bad;
  end if;

  -- ASSERT 2. All three exist and all three are callable by anon (a desk IS anon).
  select count(distinct routine_name) into n
    from information_schema.role_routine_grants
   where routine_schema='wholesale_v2' and grantee='anon'
     and routine_name in ('v2_warehouse_queue','v2_warehouse_order','v2_warehouse_order_head');
  if n <> 3 then
    raise exception 'ASSERT 2 FAILED: % of 3 warehouse functions are reachable by a desk', n;
  end if;

  -- ⭐ ASSERT 3. Every warehouse function passes through THE ONE GATE. A new one
  -- that forgets is the whole tier's security model quietly gone.
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_warehouse_%'
     and pg_get_functiondef(p.oid) not like '%v2_staff_wid(%';
  if bad is not null then
    raise exception 'ASSERT 3 FAILED: warehouse function(s) do not call v2_staff_wid -- %', bad;
  end if;

  -- ASSERT 4. And none of them writes anything. A read desk that can write is a
  -- write desk nobody reviewed.
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_warehouse_%'
     and pg_get_functiondef(p.oid) ~* '(insert into|update |delete from)\s+wholesale_v2';
  if bad is not null then
    raise exception 'ASSERT 4 FAILED: a warehouse READ function writes -- %', bad;
  end if;

  raise notice '135 OK: the warehouse desk can read its queue and an order, and there is no money in the signature.';
end $$;
