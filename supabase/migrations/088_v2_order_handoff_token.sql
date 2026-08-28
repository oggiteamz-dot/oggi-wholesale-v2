-- =============================================================================
-- 088 — THE ORDER HANDOFF                       Batch N step 4, 28 August 2026
-- =============================================================================
--
-- WHAT THIS IS FOR
--
-- An order exists in the app and nowhere else. The wholesaler can open it on
-- the order-detail screen (Batch N step 2), and that is the end of it. There is
-- no way to hand the order to anyone who is not signed in to this app:
--
--   * the warehouse, who need a picking sheet on paper;
--   * the driver, who needs the address and the lines on a phone;
--   * the buyer, who wants to re-read what they asked for;
--   * an accountant, who wants a PDF.
--
-- Today that handoff happens by screenshot. A screenshot of a scrolling order
-- is several screenshots, and it is stale the moment anything changes.
--
-- THE SHAPE, AND WHY IT MIRRORS 056 EXACTLY
--
-- This is the same problem the catalogue share link solved in 056/080, so it is
-- the same solution, deliberately: an unguessable token on the row, a single
-- SECURITY DEFINER reader that resolves that token INSIDE ITSELF, and no table
-- grant of any kind. Copying a proven shape is worth more here than inventing a
-- second one -- the audit surface stays one pattern instead of two.
--
-- THREE PROPERTIES CARRIED OVER FROM 056/080 ON PURPOSE:
--
--  1. THE FUNCTION TRUSTS NOTHING FROM ITS CALLER. It takes a token and nothing
--     else. There is no order id argument, no wid argument. 080's header states
--     the rule: "A definer function that trusts its caller is a BIGGER hole than
--     the one being closed." An order id is a uuid, and "hard to guess" has
--     never been an access rule in this schema.
--
--  2. A DEAD LINK AND A FAKE LINK ANSWER IDENTICALLY. Both get 'not_found'.
--     Distinguishing them tells a stranger whether an order exists.
--
--  3. THE TOKEN IS ROTATABLE. Rotating kills every link already sent -- which
--     is the only remedy that exists once a link has been forwarded to someone
--     it was not meant for, and links WILL be forwarded, because the whole
--     point is that they travel on WhatsApp.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN
--
--   cost, supplier_id, and the wholesaler's INTERNAL fulfilment note.
--
-- The last one is the important one. Migration 087 created `fulfil_note` as a
-- SEPARATE column from the buyer's note precisely so that an internal picking
-- instruction could never reach a customer, and its gate red-proved that by
-- adding the leak on purpose and watching the check fail. This link is the
-- widest audience any order row has ever had -- it is designed to be forwarded
-- to a driver, a warehouse and a buyer, and nobody controls where it stops.
-- So `fulfil_note` is not in the return type at all. Not filtered in the
-- client. Not selected and dropped. Absent from the signature.
--
-- WHY THERE IS NO PDF GENERATOR HERE
--
-- The PDF is the browser's own print-to-PDF, driven by print CSS. A server-side
-- PDF renderer would be a new dependency, a new failure mode, and a new thing
-- that renders differently from the screen. Every phone and every desktop
-- already has a correct one built in, and it produces a file the user chose the
-- name and location of.
-- =============================================================================

-- ---------------------------------------------------------------- the token --
alter table wholesale_v2.v2_orders
  add column if not exists order_token text;

update wholesale_v2.v2_orders
   set order_token = encode(extensions.gen_random_bytes(12), 'hex')
 where order_token is null;

alter table wholesale_v2.v2_orders
  alter column order_token set not null,
  alter column order_token set default encode(extensions.gen_random_bytes(12), 'hex');

create unique index if not exists v2_orders_order_token_uq
  on wholesale_v2.v2_orders (order_token);

comment on column wholesale_v2.v2_orders.order_token is
  '96 bits of randomness, hex, URL-safe. The unguessable half of /o/<token>. Rotating it kills every link already sent, which is the only remedy once a link has been forwarded to someone it was not meant for.';

-- The wholesaler needs to read their own token to build the link, and to write
-- a new one when they rotate it. Column-level, not table-level: migration 042's
-- lesson was that a table grant carries every column that will ever be added.
grant select (order_token) on wholesale_v2.v2_orders to authenticated;
grant update (order_token) on wholesale_v2.v2_orders to authenticated;

-- --------------------------------------------------------------- the reader --
create or replace function wholesale_v2.v2_order_by_token(p_token text)
returns table (
  status            text,
  order_id          uuid,
  order_status      text,
  buyer_label       text,
  subtotal          numeric,
  currency          text,
  buyer_order_note  text,
  created_at        timestamptz,
  wholesaler_name   text,
  items             jsonb
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_ord   wholesale_v2.v2_orders%rowtype;
  v_wname text;
  v_curr  text;
begin
  -- Resolved INSIDE the function from the token alone. Nothing the caller says
  -- about which order this is has any effect, because the caller says nothing.
  select * into v_ord
    from wholesale_v2.v2_orders o
   where o.order_token = p_token;

  if v_ord.id is null then
    -- A dead link and an invented link are the same answer, on purpose.
    return query select 'not_found'::text, null::uuid, null::text, null::text,
                        null::numeric, null::text, null::text, null::timestamptz,
                        null::text, null::jsonb;
    return;
  end if;

  -- NAME ONLY. The wholesaler's contact number is deliberately not read.
  --
  -- Migration 042 names that column as one of several that would ride along on
  -- a careless table grant, and closed it. Returning it here would
  -- reopen exactly that disclosure through a function instead of a grant -- and
  -- through the widest-audience surface in the schema, since this link exists
  -- to be forwarded. Anyone holding an order link already knows who they
  -- ordered from and how to reach them; the app is not the channel that
  -- introduces them.
  select w.name, coalesce(w.currency, '$')
    into v_wname, v_curr
    from wholesale_v2.v2_wholesalers w
   where w.wid = v_ord.wid;

  return query
  select
    'ok'::text,
    v_ord.id,
    v_ord.status,
    v_ord.buyer_label,
    v_ord.subtotal,
    v_curr,
    -- The BUYER's own words about the order. Migration 086.
    v_ord.notes,
    v_ord.created_at,
    v_wname,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'qty',         i.qty,
                   'unitPrice',   i.unit_price,
                   'lineTotal',   i.line_total,
                   'sku',         pv.sku,
                   'productName', coalesce(p.name, 'Product'),
                   'color',       pv.extra_attrs->>'color',
                   'colorHex',    pv.extra_attrs->>'colorHex',
                   'size',        pv.extra_attrs->>'size',
                   'imageUrl',    coalesce(pv.image_url, pv.images->>0),
                   'packId',      i.pack_id,
                   'packQty',     i.pack_qty,
                   -- The buyer's note on THIS LINE (086). Theirs, so it travels.
                   'buyerNote',   i.buyer_note
                   -- fulfil_note is deliberately ABSENT. See the header.
                 )
                 order by coalesce(p.name, 'Product'), pv.extra_attrs->>'color', pv.extra_attrs->>'size'
               )
          from wholesale_v2.v2_order_items i
          join wholesale_v2.v2_product_variants pv on pv.id = i.variant_id
          left join wholesale_v2.v2_products p on p.id = pv.product_id
         where i.order_id = v_ord.id
      ),
      '[]'::jsonb
    );
end;
$fn$;

revoke all on function wholesale_v2.v2_order_by_token(text) from public;
grant execute on function wholesale_v2.v2_order_by_token(text) to anon;
grant execute on function wholesale_v2.v2_order_by_token(text) to authenticated;

comment on function wholesale_v2.v2_order_by_token(text) is
  'One order, resolved from its token INSIDE this function. Takes no order id and no wid, so there is nothing a caller can claim. Deliberately never returns fulfil_note: 087 made that a separate column so an internal picking instruction could not reach a customer, and this link is the widest audience an order row has -- it is built to be forwarded.';

-- ------------------------------------------------------------- rotate a link --
create or replace function wholesale_v2.v2_rotate_order_token(p_order_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
  v_new text;
begin
  -- Re-checked inside, exactly like v2_set_fulfil_note (087). The caller's
  -- claim about who they are is not consulted; v2_my_wid() is.
  select o.wid into v_wid from wholesale_v2.v2_orders o where o.id = p_order_id;
  if v_wid is null then
    raise exception 'order not found';
  end if;
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_wid) then
    raise exception 'not your order';
  end if;

  v_new := encode(extensions.gen_random_bytes(12), 'hex');
  update wholesale_v2.v2_orders set order_token = v_new, updated_at = now()
   where id = p_order_id;
  return v_new;
end;
$fn$;

revoke all on function wholesale_v2.v2_rotate_order_token(uuid) from public;
-- anon is deliberately NOT granted. Buyers and reps ARE anon (085), and a buyer
-- must never be able to invalidate their wholesaler's link.
grant execute on function wholesale_v2.v2_rotate_order_token(uuid) to authenticated;

comment on function wholesale_v2.v2_rotate_order_token(uuid) is
  'Issues a new token, killing every link already sent for this order. SECURITY DEFINER and re-checks the tenant inside itself. anon is NOT granted execute, because buyers and sales reps run as anon.';

-- =============================================================================
-- SELF-ASSERTING. Same discipline as 085: this migration proves it landed, in
-- its own transaction, rather than leaving anyone to believe it did.
-- =============================================================================
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_orders' and column_name='order_token';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: v2_orders.order_token does not exist'; end if;

  select count(*) into n from wholesale_v2.v2_orders where order_token is null;
  if n <> 0 then raise exception 'ASSERT 2 FAILED: % existing orders have no token', n; end if;

  select count(*) into n from (
    select order_token from wholesale_v2.v2_orders group by order_token having count(*) > 1
  ) d;
  if n <> 0 then raise exception 'ASSERT 3 FAILED: % duplicate tokens', n; end if;

  -- The leak this whole migration is written around.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_order_by_token'
     and pg_get_function_result(p.oid) ilike '%fulfil_note%';
  if n <> 0 then raise exception 'ASSERT 4 FAILED: v2_order_by_token returns fulfil_note -- the wholesaler''s internal note would reach whoever the link was forwarded to'; end if;

  -- 042 closed the wholesaler's contact number. A function must not reopen it.
  -- NOTE: this searches prosrc for the literal column name, so the prose above
  -- deliberately does NOT spell it -- the first version of this migration did,
  -- and this assertion failed on its own comment. That is the assertion working
  -- correctly and the comment being careless, not the other way round; the fix
  -- was to reword the comment, never to loosen the check.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_order_by_token'
     and (pg_get_function_result(p.oid) ilike '%phone%' or p.prosrc ilike '%contact_phone%');
  if n <> 0 then raise exception 'ASSERT 4b FAILED: v2_order_by_token touches contact_phone -- migration 042 closed that column and this link is built to be forwarded'; end if;

  -- anon may READ an order by token, and may NOT rotate one.
  if not has_function_privilege('anon', 'wholesale_v2.v2_order_by_token(text)', 'execute')
    then raise exception 'ASSERT 5 FAILED: anon cannot read an order by token, so no buyer or rep can open a link'; end if;
  if has_function_privilege('anon', 'wholesale_v2.v2_rotate_order_token(uuid)', 'execute')
    then raise exception 'ASSERT 6 FAILED: anon can rotate an order token -- buyers and reps ARE anon, so a buyer could kill their wholesaler''s links'; end if;

  raise notice '088 OK: order_token present, unique, non-null; reader cannot expose fulfil_note; anon reads but cannot rotate.';
end $$;
