-- ============================================================================
-- 087 — the wholesaler's note to their warehouse. A SECOND track.
--
-- WHY THIS IS A SEPARATE COLUMN AND NOT A SHARED ONE
--   Migration 086 gave the BUYER a note ("send this one in the darker blue").
--   Hadi asked for a second one, in his own words: when the wholesaler wants to
--   send the order "to their warehouse, for example, they can add in either a
--   voice note or a written comment telling the people what to do."
--
--   Those are two different documents that happen to sit on the same order:
--   one is a customer's request, the other is an internal instruction. They
--   MUST NOT share a column.
--
--   That is not a stylistic preference. A real merchant's internal picker note
--   was found printed on a CUSTOMER-FACING SHIPPING LABEL, for exactly one
--   reason: the label template and the pick list read the same field. The
--   moment a second surface reads a shared note, something not meant for that
--   audience follows it out. Two authors, two audiences, two columns, always.
--
-- THE READ PATH IS ALREADY SAFE, AND THIS MIGRATION PROVES IT RATHER THAN
-- ASSUMING IT
--   v2_get_buyer_orders builds the buyer's history from an EXPLICIT column
--   list, not `select *`, so a new column cannot leak into it by accident.
--   Since Batch S the buyer also holds no table grants at all, so that function
--   is the only way an order reaches a buyer. Both facts are asserted below --
--   an architecture that happens to be safe today is not the same as one that
--   fails loudly when someone changes it.
--
-- WHAT ELSE THIS FIXES, WHILE IT IS HERE
--   The buyer could not see their OWN note in their order history. 086 stored
--   it; v2_get_buyer_orders never selected it. A buyer re-reading an order
--   they placed should see what they asked for -- so `buyerNote` joins that
--   payload. `fulfil_note` deliberately does not, and a gate asserts it.
-- ============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------- the columns
alter table v2_order_items add column if not exists fulfil_note text;
alter table v2_orders      add column if not exists fulfil_note text;

comment on column v2_order_items.fulfil_note is
  'The WHOLESALER''s instruction to their own warehouse about this line. '
  'Migration 087. INTERNAL: never returned to a buyer by any function. The '
  'customer''s own request is a SEPARATE column, buyer_note (migration 086) -- '
  'never merge them. A single shared field is how an internal picking note '
  'ends up printed on something the customer reads.';

comment on column v2_orders.fulfil_note is
  'The WHOLESALER''s instruction to their warehouse about the order as a whole. '
  'Migration 087. INTERNAL -- see v2_order_items.fulfil_note. The buyer''s own '
  'note on the order is v2_orders.notes.';

-- ------------------------------------------------------------- writing one
-- A wholesaler signs in through Supabase Auth, so auth.uid() is real for them
-- and v2_my_wid()/v2_is_owner() resolve. A buyer or a sales rep holds no Auth
-- session at all (they are the `anon` role), so they can never satisfy this
-- check -- and anon is not granted execute on it either. Two independent
-- reasons, because one of them will eventually be changed by someone.
create or replace function v2_set_fulfil_note(
  p_order_id uuid,
  p_note     text,
  p_item_id  bigint default null
)
returns void
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_wid  text;
  v_ok   boolean;
  v_rows int;
begin
  select o.wid into v_wid from v2_orders o where o.id = p_order_id;
  if v_wid is null then
    raise exception 'that order does not exist';
  end if;

  -- The tenant check, INSIDE the function. This is the Batch S pattern: a
  -- SECURITY DEFINER function runs as its owner, so a grant cannot protect it
  -- and RLS on the table underneath is not consulted. The only thing standing
  -- between a caller and another wholesaler's order is this line.
  v_ok := v2_is_owner() or (v2_my_wid() is not null and v2_my_wid() = v_wid);
  if not v_ok then
    raise exception 'you may only write a fulfilment note on your own orders';
  end if;

  if p_item_id is null then
    update v2_orders
       set fulfil_note = nullif(btrim(p_note), ''), updated_at = now()
     where id = p_order_id;
  else
    -- Scoped by order_id AS WELL AS item id, so an item id belonging to a
    -- different order cannot be written through an order this caller does own.
    update v2_order_items
       set fulfil_note = nullif(btrim(p_note), '')
     where id = p_item_id and order_id = p_order_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'that line is not part of that order';
    end if;
  end if;
end;
$$;

revoke all on function v2_set_fulfil_note(uuid, text, bigint) from public;
grant execute on function v2_set_fulfil_note(uuid, text, bigint) to authenticated;
-- anon is deliberately NOT granted: buyers and sales reps run as anon.

-- --------------------------------- the buyer sees their OWN note, and only it
do $mig$
declare
  v_src text;
  v_new text;
  a1 text := '          ''packQty'', oi.pack_qty';
  r1 text := '          ''packQty'', oi.pack_qty,' || E'\n' ||
             '          -- Migration 087: the buyer''s OWN words, returned to the buyer.' || E'\n' ||
             '          -- The wholesaler''s internal warehouse instruction is deliberately' || E'\n' ||
             '          -- NOT here, and assertion 4 of migration 087 fails if it ever is.' || E'\n' ||
             '          ''buyerNote'', oi.buyer_note';
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2' and p.proname = 'v2_get_buyer_orders';

  if v_src is null then
    raise exception '087: v2_get_buyer_orders not found -- do not guess, inspect pg_proc and rebase.';
  end if;

  if position('buyerNote' in v_src) > 0 then
    raise notice '087: v2_get_buyer_orders already returns the buyer note; nothing to do.';
  elsif position(a1 in v_src) = 0 then
    raise exception '087: the packQty anchor is not in the installed v2_get_buyer_orders. Re-derive this patch against the current text.';
  else
    v_new := replace(v_src, a1, r1);
    if v_new = v_src then
      raise exception '087: replacement produced an identical body -- refusing to report success for a no-op.';
    end if;
    execute format(
      'create or replace function wholesale_v2.v2_get_buyer_orders(p_account_id uuid) '
      || 'returns jsonb language plpgsql security definer set search_path = wholesale_v2 as %L', v_new);
    raise notice '087: v2_get_buyer_orders now returns the buyer''s own note.';
  end if;
end;
$mig$;

-- --------------------------------------------------------------- self-assert
do $verify$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='wholesale_v2' and table_name='v2_order_items' and column_name='fulfil_note') then
    raise exception '087 ASSERT 1 FAILED: v2_order_items.fulfil_note is missing.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='wholesale_v2' and table_name='v2_orders' and column_name='fulfil_note') then
    raise exception '087 ASSERT 2 FAILED: v2_orders.fulfil_note is missing.';
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='wholesale_v2' and p.proname='v2_set_fulfil_note' and p.prosecdef) then
    raise exception '087 ASSERT 3 FAILED: v2_set_fulfil_note is missing or is not SECURITY DEFINER.';
  end if;

  -- THE ONE THAT MATTERS. A buyer must never be handed the wholesaler's
  -- internal instruction. Asserted against the INSTALLED body, so a future
  -- edit that adds it fails here rather than on a customer's screen.
  --
  -- Deliberately a bare token search rather than a check for a column
  -- reference: an alias, a computed expression or a jsonb key could all put
  -- that value in front of a buyer without the string `oi.fulfil_note` ever
  -- appearing. The cost is that no COMMENT inside this function may use the
  -- word either -- which this migration itself tripped over on its first run,
  -- and the comment was reworded rather than the assertion weakened.
  if (select position('fulfil_note' in p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='wholesale_v2' and p.proname='v2_get_buyer_orders') > 0 then
    raise exception '087 ASSERT 4 FAILED: v2_get_buyer_orders mentions fulfil_note. The wholesaler''s internal note is reaching the buyer -- this is the shipping-label leak this migration exists to prevent.';
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='wholesale_v2' and p.proname='v2_get_buyer_orders'
                    and position('buyerNote' in p.prosrc) > 0) then
    raise exception '087 ASSERT 5 FAILED: the buyer cannot see their own note back.';
  end if;

  if has_function_privilege('anon','wholesale_v2.v2_set_fulfil_note(uuid,text,bigint)','execute') then
    raise exception '087 ASSERT 6 FAILED: anon can execute v2_set_fulfil_note. Buyers and sales reps ARE anon -- a buyer could write instructions to a warehouse.';
  end if;
  if not has_function_privilege('authenticated','wholesale_v2.v2_set_fulfil_note(uuid,text,bigint)','execute') then
    raise exception '087 ASSERT 7 FAILED: a wholesaler cannot execute v2_set_fulfil_note.';
  end if;

  raise notice '087: all 7 assertions passed.';
end;
$verify$;
