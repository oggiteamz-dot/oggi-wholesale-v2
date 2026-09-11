-- =============================================================================
-- 138 — A DESK DOES ITS WORK                           Block 7, 11 September 2026
-- =============================================================================
--
-- 135 and 137 let the two desks READ. This is everything they may WRITE, and it
-- is a short list on purpose: four verbs, each one a thing a person at a desk
-- actually does.
--
--   ACCEPT    "I've got it"        -- so the wholesaler can see it was picked up
--   COMPLETE  "done"               -- picked and packed / reconciled
--   RETURN    "we're short, here's why"
--   PICK      one line, n units    -- the warehouse only
--
-- ==== ⛔ NONE OF THEM WRITES v2_orders.status ===============================
--
-- The order status is a statement to the CUSTOMER. The desk state is a fact
-- about work inside a building. 134's header explains why they are two state
-- machines; this is where it would be easiest to quietly make them one, because
-- "the warehouse finished, so mark it shipped" sounds helpful right up until a
-- buyer gets told their order shipped by somebody who only put it on a shelf.
--
-- checks/check_two_state_machines.sql reads every function in this block and
-- fails on any `update ... v2_orders`. The self-test below asserts the same
-- thing at apply time.
--
-- ==== WHY THE WHOLESALER STILL DRIVES THE ORDER =============================
--
-- The desks report; the wholesaler decides. When the warehouse marks an order
-- done, the wholesaler sees "warehouse: done" on their order screen and moves
-- the order to `shipped` themselves, because they are the ones who know whether
-- it actually left. That is one extra tap and it keeps the promise to the buyer
-- in the hands of the person who made it.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ============================================================ accept / return
create or replace function wholesale_v2.v2_desk_accept(p_staff_id uuid, p_order_id uuid, p_desk text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_state text;
begin
  if p_desk not in ('warehouse','finance') then
    return query select false, 'Not authorized'; return;
  end if;
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, p_desk);
  if v_wid is null then return query select false, 'Not authorized'; return; end if;

  update wholesale_v2.v2_order_desk_assignments
     set state = 'accepted', accepted_at = now(), accepted_by = p_staff_id, updated_at = now()
   where order_id = p_order_id and wid = v_wid and desk = p_desk and state = 'sent'
  returning state into v_state;

  if v_state is null then
    -- Either it is not on this desk, or somebody already accepted it. Both are
    -- "nothing for you to do here", and neither is worth a different sentence.
    return query select false, 'That order is not waiting on this desk'; return;
  end if;
  return query select true, 'Accepted';
end;
$fn$;

create or replace function wholesale_v2.v2_desk_complete(p_staff_id uuid, p_order_id uuid, p_desk text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_state text;
begin
  if p_desk not in ('warehouse','finance') then
    return query select false, 'Not authorized'; return;
  end if;
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, p_desk);
  if v_wid is null then return query select false, 'Not authorized'; return; end if;

  update wholesale_v2.v2_order_desk_assignments
     set state = 'done', completed_at = now(), completed_by = p_staff_id, updated_at = now()
   where order_id = p_order_id and wid = v_wid and desk = p_desk
     and state in ('sent','accepted')
  returning state into v_state;

  if v_state is null then
    return query select false, 'That order is not open on this desk'; return;
  end if;
  return query select true, 'Marked done';
end;
$fn$;

create or replace function wholesale_v2.v2_desk_return(
  p_staff_id uuid, p_order_id uuid, p_desk text, p_reason text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_state text; v_reason text := nullif(trim(coalesce(p_reason,'')),'');
begin
  if p_desk not in ('warehouse','finance') then
    return query select false, 'Not authorized'; return;
  end if;
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, p_desk);
  if v_wid is null then return query select false, 'Not authorized'; return; end if;

  -- ⛔ The reason is refused HERE as well as by the table constraint. The
  -- constraint stops a bad row from being stored; this stops a person from
  -- getting an unexplained database error when what they actually need is to be
  -- told to type a sentence. PB-01's rule: every refusal says what to do next.
  if v_reason is null then
    return query select false, 'Say what is wrong, so the office can fix it'; return;
  end if;

  update wholesale_v2.v2_order_desk_assignments
     set state = 'returned', returned_at = now(), returned_by = p_staff_id,
         return_reason = v_reason, updated_at = now()
   where order_id = p_order_id and wid = v_wid and desk = p_desk
     and state in ('sent','accepted')
  returning state into v_state;

  if v_state is null then
    return query select false, 'That order is not open on this desk'; return;
  end if;
  return query select true, 'Handed back';
end;
$fn$;

-- =================================================================== picking
-- Picking already exists (016/017, Batch 10) and is a VERIFICATION CHECKLIST,
-- not a stock write: v2_submit_order already converted the reservation into a
-- sale, so the units left the ledger before the picker touched anything
-- (js/data/picking.js header says so). This wrapper exists only so the warehouse
-- desk can reach it through the same gate as everything else -- the existing
-- RPCs assume a wholesaler session.
create or replace function wholesale_v2.v2_desk_pick(
  p_staff_id uuid, p_order_id uuid, p_order_item_id bigint, p_picked_qty integer)
returns table(ok boolean, msg text, picked_qty integer)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_expected integer; v_variant uuid;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'warehouse');
  if v_wid is null then return query select false, 'Not authorized', 0; return; end if;

  -- On this desk, at this store, and the line really belongs to that order.
  select i.qty, i.variant_id into v_expected, v_variant
    from wholesale_v2.v2_order_items i
    join wholesale_v2.v2_orders o on o.id = i.order_id
    join wholesale_v2.v2_order_desk_assignments a
      on a.order_id = o.id and a.desk='warehouse' and a.wid = v_wid
   where i.id = p_order_item_id and i.order_id = p_order_id and o.wid = v_wid
     and a.state in ('sent','accepted');
  if v_expected is null then
    return query select false, 'That line is not on this desk', 0; return;
  end if;

  if p_picked_qty is null or p_picked_qty < 0 then
    return query select false, 'A picked count cannot be negative', 0; return;
  end if;
  -- Over-picking is refused rather than clamped. A picker who scans one too many
  -- has made a real mistake and silently rounding it down hides it until the
  -- box is short at the other end.
  if p_picked_qty > v_expected then
    return query select false, 'That is more than the order asks for (' || v_expected || ')', 0; return;
  end if;

  insert into wholesale_v2.v2_order_pick_items (order_id, order_item_id, variant_id, expected_qty, picked_qty, picked_at, updated_at)
  values (p_order_id, p_order_item_id, v_variant, v_expected, p_picked_qty,
          case when p_picked_qty > 0 then now() else null end, now())
  -- The unique index is on order_item_id alone (017). And note the table
  -- already CHECKs picked_qty <= expected_qty, so the friendly refusal above is
  -- the message, not the enforcement -- the backstop was there before this desk.
  on conflict (order_item_id) do update
     set picked_qty = excluded.picked_qty,
         expected_qty = excluded.expected_qty,
         picked_at = case when excluded.picked_qty > 0 then now() else null end,
         updated_at = now();

  return query select true, 'Saved', p_picked_qty;
end;
$fn$;

-- ================================== the warehouse writes back to the office
-- The one thing a picker should be able to say in writing: a note on the order
-- for the wholesaler. It writes v2_order_desk_assignments, NOT the order.
create or replace function wholesale_v2.v2_desk_note(
  p_staff_id uuid, p_order_id uuid, p_desk text, p_note text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_n integer;
begin
  if p_desk not in ('warehouse','finance') then
    return query select false, 'Not authorized'; return;
  end if;
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, p_desk);
  if v_wid is null then return query select false, 'Not authorized'; return; end if;

  update wholesale_v2.v2_order_desk_assignments
     set desk_note = nullif(trim(coalesce(p_note,'')),''), updated_at = now()
   where order_id = p_order_id and wid = v_wid and desk = p_desk;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select false, 'That order is not on this desk'; return; end if;
  return query select true, 'Saved';
end;
$fn$;

alter table v2_order_desk_assignments add column if not exists desk_note text;
comment on column v2_order_desk_assignments.desk_note is
  'What the desk wants the office to know. Migration 138. A FOURTH note column, '
  'and the fourth audience: buyer_note is the customer to everyone, fulfil_note '
  'is the office to the warehouse, notes is the customer on the order as a '
  'whole, and this is the desk back to the office. Merging any two of them is '
  'how an internal remark reaches a customer -- see 087.';

-- ⛔ All five are callable by anon, because a desk IS anon. Each one re-checks
-- the desk inside itself; none of them trusts the id it was handed.
do $$
declare f text;
begin
  foreach f in array array[
    'wholesale_v2.v2_desk_accept(uuid,uuid,text)',
    'wholesale_v2.v2_desk_complete(uuid,uuid,text)',
    'wholesale_v2.v2_desk_return(uuid,uuid,text,text)',
    'wholesale_v2.v2_desk_pick(uuid,uuid,bigint,integer)',
    'wholesale_v2.v2_desk_note(uuid,uuid,text,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- =============================================================================
-- SELF-TEST
-- =============================================================================
do $$
declare
  n integer; bad text; v_loc uuid; v_order uuid; v_wh uuid; v_fin uuid;
  v_ok boolean; v_msg text; v_item bigint; v_var uuid; v_prod uuid;
begin
  -- ⭐ 1. NOT ONE FUNCTION IN THIS BLOCK WRITES v2_orders.
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_desk_%'
     and pg_get_functiondef(p.oid) ~* 'update\s+(wholesale_v2\.)?v2_orders';
  if bad is not null then
    raise exception 'ASSERT 1 FAILED: desk function(s) write the ORDER status -- %. The buyer would be told something by a picker.', bad;
  end if;

  -- 2. every desk function passes THE ONE GATE
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_desk_%'
     and p.proname <> 'v2_desk_send'          -- 134's, and it is the WHOLESALER's
     and pg_get_functiondef(p.oid) not like '%v2_staff_wid(%';
  if bad is not null then
    raise exception 'ASSERT 2 FAILED: desk function(s) skip v2_staff_wid -- %', bad;
  end if;

  begin
    insert into public.wholesalers (wid,name,active) values ('zz138a','zz138 probe',false);
    insert into wholesale_v2.v2_wholesalers (wid,name) values ('zz138a','zz138 probe');
    insert into wholesale_v2.v2_locations (wid,name) values ('zz138a','dock') returning id into v_loc;
    insert into wholesale_v2.v2_products (wid,name) values ('zz138a','Probe shirt') returning id into v_prod;
    insert into wholesale_v2.v2_product_variants (product_id,sku,extra_attrs)
      values (v_prod,'ZZ138-1','{"color":"Blue","size":"M"}'::jsonb) returning id into v_var;
    insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,status,subtotal)
      values ('zz138a','probe shop',v_loc,'new',100) returning id into v_order;
    insert into wholesale_v2.v2_order_items (order_id,variant_id,qty,unit_price,line_total)
      values (v_order,v_var,6,10,60) returning id into v_item;
    insert into wholesale_v2.v2_staff_accounts (wid,desk,username,password_hash)
      values ('zz138a','warehouse','picker','x') returning id into v_wh;
    insert into wholesale_v2.v2_staff_accounts (wid,desk,username,password_hash)
      values ('zz138a','finance','books','x') returning id into v_fin;
    insert into wholesale_v2.v2_order_desk_assignments (order_id,wid,desk)
      values (v_order,'zz138a','warehouse');

    -- accept
    select ok into v_ok from wholesale_v2.v2_desk_accept(v_wh, v_order, 'warehouse');
    if not coalesce(v_ok,false) then raise exception 'ASSERT 3 FAILED: the warehouse could not accept its own order'; end if;

    -- ⭐ the FINANCE account may not touch the WAREHOUSE's assignment
    select ok into v_ok from wholesale_v2.v2_desk_complete(v_fin, v_order, 'warehouse');
    if coalesce(v_ok,false) then
      raise exception 'ASSERT 4 FAILED: a FINANCE account completed a WAREHOUSE assignment';
    end if;

    -- returning with no reason is refused, and says what to do
    select ok, msg into v_ok, v_msg from wholesale_v2.v2_desk_return(v_wh, v_order, 'warehouse', '   ');
    if coalesce(v_ok,false) then raise exception 'ASSERT 5 FAILED: an order was handed back with no reason'; end if;
    if v_msg not ilike '%what is wrong%' then
      raise exception 'ASSERT 6 FAILED: the refusal does not say what to do next (said: %)', v_msg;
    end if;

    -- with a reason it works, and the reason is stored
    select ok into v_ok from wholesale_v2.v2_desk_return(v_wh, v_order, 'warehouse', 'four short on the blue');
    if not coalesce(v_ok,false) then raise exception 'ASSERT 7 FAILED: a reasoned hand-back was refused'; end if;
    select count(*) into n from wholesale_v2.v2_order_desk_assignments
     where order_id=v_order and desk='warehouse' and state='returned' and return_reason='four short on the blue';
    if n <> 1 then raise exception 'ASSERT 8 FAILED: the hand-back reason was not stored'; end if;

    -- ⭐ and the ORDER's own status never moved
    select count(*) into n from wholesale_v2.v2_orders where id=v_order and status='new';
    if n <> 1 then raise exception 'ASSERT 9 FAILED: a desk action changed the ORDER status -- the two state machines merged'; end if;

    -- picking: over-picking is refused, not clamped
    update wholesale_v2.v2_order_desk_assignments set state='accepted', return_reason=null, returned_at=null
     where order_id=v_order and desk='warehouse';
    select ok into v_ok from wholesale_v2.v2_desk_pick(v_wh, v_order, v_item, 7);
    if coalesce(v_ok,false) then raise exception 'ASSERT 10 FAILED: a picker recorded MORE than the order asks for'; end if;
    select ok into v_ok from wholesale_v2.v2_desk_pick(v_wh, v_order, v_item, 4);
    if not coalesce(v_ok,false) then raise exception 'ASSERT 11 FAILED: a valid partial pick was refused'; end if;
    select picked_qty into n from wholesale_v2.v2_order_pick_items where order_item_id = v_item;
    if n <> 4 then raise exception 'ASSERT 12 FAILED: the picked count was not stored (got %)', n; end if;
    -- and the finance account cannot pick at all
    select ok into v_ok from wholesale_v2.v2_desk_pick(v_fin, v_order, v_item, 1);
    if coalesce(v_ok,false) then raise exception 'ASSERT 13 FAILED: a FINANCE account picked stock'; end if;

    raise exception 'zz138 rollback';
  exception
    when others then
      if sqlerrm like 'ASSERT%' then raise; end if;
      if sqlerrm not like 'zz138 rollback%' then
        raise exception '138 SELF-TEST FAILED unexpectedly: %', sqlerrm;
      end if;
  end;

  if exists (select 1 from public.wholesalers where wid like 'zz138%') then
    raise exception '138: the probes left rows behind';
  end if;
  raise notice '138 OK: four verbs, neither desk reaches the other, a hand-back needs a reason, and the order status never moves.';
end $$;
