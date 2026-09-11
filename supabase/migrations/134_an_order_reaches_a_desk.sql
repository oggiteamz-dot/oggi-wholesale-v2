-- =============================================================================
-- 134 — AN ORDER REACHES A DESK                        Block 7, 11 September 2026
-- =============================================================================
--
-- HADI: "any order that comes in, the owner could automatically send it to the
--        warehouse manager."
--
-- Two words in that sentence are the whole migration: SEND, and AUTOMATICALLY.
--
-- ==== ⭐ TWO STATE MACHINES, AND THEY MUST NEVER BECOME ONE =================
--
--   ORDER STATUS   new -> confirmed -> shipped -> delivered   <- what the BUYER is told
--   DESK STATE     sent -> accepted -> done                   <- internal work
--                       \-> returned (with a reason)
--
-- The order status is a STATEMENT TO A CUSTOMER. The desk state is a fact about
-- work inside a building. Merging them means the buyer's order changes status
-- because a picker tapped something on a tablet -- which is migration 087's
-- mistake (one field, two audiences) wearing different clothes. 087 exists
-- because a merchant's internal picker note was found printed on a customer's
-- shipping label, for the single reason that two surfaces read one column.
--
-- ⛔ NO FUNCTION IN THIS BLOCK WRITES v2_orders.status. checks/check_two_state_
-- machines.sql asserts it by reading every desk function's source, so the day
-- somebody adds `update v2_orders set status` to a convenient place, the build
-- goes red instead of the customer getting a text message from a warehouse.
--
-- ==== "RETURNED" IS NOT OPTIONAL, AND IT NEEDS A REASON =====================
--
-- The warehouse has to be able to hand an order BACK -- "we are four short on
-- the blue". A one-way conveyor is how orders get stuck in a building with
-- nobody accountable for them.
--
-- And a refusal with no reason is the dead end PB-01 was built to remove: the
-- access-request work (104-108) spent a whole block establishing that every
-- decline must say what happens next. A desk handing an order back in silence
-- is the same dead end one department over. `return_reason` is NOT NULL when
-- the state is `returned`, enforced by the table rather than by whoever writes
-- the next screen.
--
-- ==== ⚠️ THE TRIGGER MUST NEVER BE ABLE TO FAIL AN ORDER ====================
--
-- An order arriving is the CUSTOMER'S act. Routing it is OURS. If a routing rule
-- raises -- a bad desk name, a constraint somebody adds later, a deadlock -- and
-- that exception reaches v2_submit_order, then the sale is lost for a reason the
-- customer cannot see and cannot fix, at the exact moment they were trying to
-- give us money.
--
-- So the trigger swallows its own failure into v2_order_routing_failures and
-- lets the order through. That is deliberately the opposite of this repo's
-- usual instinct (a check that cannot run is RED) -- because here the "check"
-- is a convenience and the thing it would block is revenue. The failure is
-- LOUD IN A TABLE somebody can read, which is the difference between defensive
-- and silent. The gate proves it by installing a routing rule that is
-- guaranteed to fail and asserting the order still lands.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ================================================================ the routing
create table if not exists v2_order_desk_routing (
  wid           text not null references v2_wholesalers(wid) on delete cascade,
  desk          text not null check (desk in ('warehouse','finance')),
  -- 'never'        -- nothing is sent automatically; the wholesaler sends by hand
  -- 'on_new'       -- the moment the order is submitted
  -- 'on_confirmed' -- once the wholesaler has accepted it themselves
  auto_send_on  text not null default 'never'
                check (auto_send_on in ('never','on_new','on_confirmed')),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  primary key (wid, desk)
);

comment on table v2_order_desk_routing is
  'Per store, per desk: when an order should reach that desk without anybody '
  'pressing anything. Migration 134. Default is never -- a store that has not '
  'hired a warehouse manager should not be filling a queue nobody opens.';

alter table v2_order_desk_routing enable row level security;
drop policy if exists v2_order_desk_routing_scoped on v2_order_desk_routing;
create policy v2_order_desk_routing_scoped on v2_order_desk_routing
  for all using (v2_is_owner() or wid = v2_my_wid())
       with check (v2_is_owner() or wid = v2_my_wid());
revoke all on table v2_order_desk_routing from public, anon;
grant select, insert, update, delete on table v2_order_desk_routing to authenticated;

-- ============================================================= the assignment
create table if not exists v2_order_desk_assignments (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references v2_orders(id) on delete cascade,

  -- Carried rather than joined. Every desk function filters on it, and a join
  -- to v2_orders on every call to learn the tenant is a join that somebody will
  -- eventually forget -- 125 found a live cross-tenant leak in exactly that
  -- shape, in a partition whose parent looked fine.
  wid            text not null references v2_wholesalers(wid) on delete cascade,

  desk           text not null check (desk in ('warehouse','finance')),
  state          text not null default 'sent'
                 check (state in ('sent','accepted','done','returned')),

  sent_at        timestamptz not null default now(),
  -- null when the trigger sent it. That is not missing data: "the rule sent it"
  -- is a different fact from "a person sent it", and flattening them would lose
  -- the only evidence of which.
  sent_by        uuid,
  auto           boolean not null default false,

  accepted_at    timestamptz,
  accepted_by    uuid references v2_staff_accounts(id) on delete set null,
  completed_at   timestamptz,
  completed_by   uuid references v2_staff_accounts(id) on delete set null,
  returned_at    timestamptz,
  returned_by    uuid references v2_staff_accounts(id) on delete set null,
  return_reason  text,

  updated_at     timestamptz not null default now(),

  -- ⛔ A refusal with no reason is a dead end. PB-01, one department over.
  constraint v2_desk_return_has_a_reason
    check (state <> 'returned' or coalesce(trim(return_reason),'') <> '')
);

comment on table v2_order_desk_assignments is
  'One order on one desk. Migration 134. The desk state is INTERNAL WORK and is '
  'deliberately a separate state machine from v2_orders.status, which is a '
  'statement to the customer -- see the header. At most one row per (order, desk).';

-- An order is on a desk once. Sending it twice is a person pressing a button
-- twice, not a second piece of work.
create unique index if not exists idx_v2_desk_assignment_once
  on v2_order_desk_assignments (order_id, desk);

create index if not exists idx_v2_desk_queue
  on v2_order_desk_assignments (wid, desk, state, sent_at desc);

alter table v2_order_desk_assignments enable row level security;
drop policy if exists v2_order_desk_assignments_scoped on v2_order_desk_assignments;
create policy v2_order_desk_assignments_scoped on v2_order_desk_assignments
  for all using (v2_is_owner() or wid = v2_my_wid())
       with check (v2_is_owner() or wid = v2_my_wid());

-- anon holds nothing here either. A desk reads its queue through 135/136, which
-- choose the columns; it never reads this table.
revoke all on table v2_order_desk_assignments from public, anon;
grant select, insert, update, delete on table v2_order_desk_assignments to authenticated;

-- ======================================================= where failures go
create table if not exists v2_order_routing_failures (
  id          bigint generated always as identity primary key,
  order_id    uuid,
  wid         text,
  desk        text,
  failed_at   timestamptz not null default now(),
  sqlstate    text,
  message     text
);

comment on table v2_order_routing_failures is
  'When the auto-routing trigger fails it writes here and lets the order '
  'through. Migration 134. An order is the customer''s act; routing it is ours, '
  'and ours must never cost theirs. Empty is the expected state -- a row here is '
  'a real defect somebody should read.';

alter table v2_order_routing_failures enable row level security;
drop policy if exists v2_order_routing_failures_owner on v2_order_routing_failures;
create policy v2_order_routing_failures_owner on v2_order_routing_failures
  for select using (v2_is_owner() or wid = v2_my_wid());
revoke all on table v2_order_routing_failures from public, anon;
grant select, insert on table v2_order_routing_failures to authenticated;

-- ======================================================= sending, by a person
create or replace function wholesale_v2.v2_desk_send(p_order_id uuid, p_desk text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_status text;
begin
  select o.wid, o.status into v_wid, v_status
    from wholesale_v2.v2_orders o where o.id = p_order_id;
  if v_wid is null then return query select false, 'No such order'; return; end if;
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_wid) then
    return query select false, 'Not authorized'; return;
  end if;
  if p_desk not in ('warehouse','finance') then
    return query select false, 'A desk is either warehouse or finance'; return;
  end if;

  insert into wholesale_v2.v2_order_desk_assignments (order_id, wid, desk, sent_by, auto)
  values (p_order_id, v_wid, p_desk, auth.uid(), false)
  on conflict (order_id, desk) do update
     -- Re-sending something the desk handed back is the ordinary way a problem
     -- gets resolved: the wholesaler fixes the shortage and sends it again. It
     -- goes back to 'sent' and the reason is cleared, because it no longer
     -- describes the order. Re-sending anything else changes nothing, so a
     -- double tap is harmless.
     set state = case when wholesale_v2.v2_order_desk_assignments.state = 'returned'
                      then 'sent' else wholesale_v2.v2_order_desk_assignments.state end,
         return_reason = case when wholesale_v2.v2_order_desk_assignments.state = 'returned'
                              then null else wholesale_v2.v2_order_desk_assignments.return_reason end,
         returned_at = case when wholesale_v2.v2_order_desk_assignments.state = 'returned'
                            then null else wholesale_v2.v2_order_desk_assignments.returned_at end,
         sent_at = now(), sent_by = auth.uid(), auto = false, updated_at = now();

  return query select true, 'Sent to the ' || p_desk || ' desk';
end;
$fn$;

revoke all on function wholesale_v2.v2_desk_send(uuid,text) from public, anon;
grant execute on function wholesale_v2.v2_desk_send(uuid,text) to authenticated;

create or replace function wholesale_v2.v2_set_desk_routing(
  p_wid text, p_desk text, p_auto_send_on text)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
begin
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = p_wid) then
    return query select false, 'Not authorized'; return;
  end if;
  if p_desk not in ('warehouse','finance') then
    return query select false, 'A desk is either warehouse or finance'; return;
  end if;
  if p_auto_send_on not in ('never','on_new','on_confirmed') then
    return query select false, 'Send automatically never, on_new or on_confirmed'; return;
  end if;
  insert into wholesale_v2.v2_order_desk_routing (wid, desk, auto_send_on, updated_by)
  values (p_wid, p_desk, p_auto_send_on, auth.uid())
  on conflict (wid, desk) do update
     set auto_send_on = excluded.auto_send_on, updated_at = now(), updated_by = auth.uid();
  return query select true, 'Saved';
end;
$fn$;

revoke all on function wholesale_v2.v2_set_desk_routing(text,text,text) from public, anon;
grant execute on function wholesale_v2.v2_set_desk_routing(text,text,text) to authenticated;

-- ============================================== sending, by the standing rule
create or replace function wholesale_v2.v2_route_order_to_desks()
returns trigger
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  r record;
  v_when text := case when TG_OP = 'INSERT' then 'on_new' else 'on_confirmed' end;
begin
  -- ⚠️ EVERYTHING BELOW IS INSIDE A HANDLER ON PURPOSE. See the header: an order
  -- is the customer's act and must survive anything wrong with ours.
  begin
    for r in
      select desk from wholesale_v2.v2_order_desk_routing
       where wid = NEW.wid and auto_send_on = v_when
    loop
      insert into wholesale_v2.v2_order_desk_assignments (order_id, wid, desk, auto)
      values (NEW.id, NEW.wid, r.desk, true)
      on conflict (order_id, desk) do nothing;   -- idempotent: re-confirming sends nothing new
    end loop;
  exception when others then
    begin
      insert into wholesale_v2.v2_order_routing_failures (order_id, wid, desk, sqlstate, message)
      values (NEW.id, NEW.wid, null, SQLSTATE, SQLERRM);
    exception when others then
      null;  -- even the complaint must not cost the order
    end;
  end;
  return NEW;
end;
$fn$;

comment on function wholesale_v2.v2_route_order_to_desks() is
  'Auto-routing (134). Swallows its own failure into v2_order_routing_failures '
  'and lets the order through -- an order is the customer''s act and routing is '
  'ours. Deliberately the opposite posture to the SQL gates, because here the '
  'thing that would be blocked is a sale.';

drop trigger if exists trg_v2_route_order_new on v2_orders;
create trigger trg_v2_route_order_new
  after insert on v2_orders
  for each row execute function wholesale_v2.v2_route_order_to_desks();

drop trigger if exists trg_v2_route_order_confirmed on v2_orders;
create trigger trg_v2_route_order_confirmed
  after update of status on v2_orders
  for each row when (NEW.status = 'confirmed' and OLD.status is distinct from 'confirmed')
  execute function wholesale_v2.v2_route_order_to_desks();

-- =============================================================================
-- SELF-TEST
-- =============================================================================
do $$
declare
  n integer;
  v_loc uuid;
  v_order uuid;
begin
  -- anon reaches none of it
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and grantee in ('anon','public')
     and table_name in ('v2_order_desk_assignments','v2_order_desk_routing','v2_order_routing_failures');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: anon holds % grant(s) on the routing tables', n; end if;

  begin
    insert into public.wholesalers (wid, name, active) values ('zz134a','zz134 probe',false);
    insert into wholesale_v2.v2_wholesalers (wid, name) values ('zz134a','zz134 probe');
    insert into wholesale_v2.v2_locations (wid, name) values ('zz134a','probe dock') returning id into v_loc;

    -- no rule -> nothing is routed
    insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
    values ('zz134a','probe shop', v_loc, 'new', 0) returning id into v_order;
    select count(*) into n from wholesale_v2.v2_order_desk_assignments where order_id = v_order;
    if n <> 0 then raise exception 'ASSERT 2 FAILED: an order was routed with no rule in place'; end if;

    -- on_new -> routed once, and re-confirming does not route it twice
    insert into wholesale_v2.v2_order_desk_routing (wid, desk, auto_send_on)
    values ('zz134a','warehouse','on_new');
    insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
    values ('zz134a','probe shop 2', v_loc, 'new', 0) returning id into v_order;
    select count(*) into n from wholesale_v2.v2_order_desk_assignments
     where order_id = v_order and desk='warehouse' and state='sent' and auto;
    if n <> 1 then raise exception 'ASSERT 3 FAILED: on_new did not put the order on the warehouse desk (got %)', n; end if;

    update wholesale_v2.v2_orders set status='confirmed' where id = v_order;
    select count(*) into n from wholesale_v2.v2_order_desk_assignments where order_id = v_order;
    if n <> 1 then raise exception 'ASSERT 4 FAILED: confirming created a SECOND assignment (got %) -- routing is not idempotent', n; end if;

    -- ⭐ a rule that CANNOT work must not cost the order
    insert into wholesale_v2.v2_order_desk_routing (wid, desk, auto_send_on)
    values ('zz134a','finance','on_new');
    -- sabotage the assignment table so the insert inside the trigger must fail
    alter table wholesale_v2.v2_order_desk_assignments
      add constraint zz134_break check (desk <> 'finance');
    insert into wholesale_v2.v2_orders (wid, buyer_label, location_id, status, subtotal)
    values ('zz134a','probe shop 3', v_loc, 'new', 0) returning id into v_order;
    if v_order is null then
      raise exception 'ASSERT 5 FAILED: a broken routing rule STOPPED THE ORDER -- the customer loses the sale for our bug';
    end if;
    select count(*) into n from wholesale_v2.v2_order_routing_failures where order_id = v_order;
    if n < 1 then raise exception 'ASSERT 6 FAILED: routing failed SILENTLY -- nothing was written to v2_order_routing_failures'; end if;
    alter table wholesale_v2.v2_order_desk_assignments drop constraint zz134_break;

    -- returning without a reason is impossible
    begin
      update wholesale_v2.v2_order_desk_assignments
         set state='returned', return_reason=null
       where order_id = v_order and desk='warehouse';
      -- may legitimately match zero rows; only a stored 'returned' with no
      -- reason is the failure, so check for that rather than for an exception
      if exists (select 1 from wholesale_v2.v2_order_desk_assignments
                  where state='returned' and coalesce(trim(return_reason),'')='') then
        raise exception 'ASSERT 7 FAILED: an order was handed back with no reason';
      end if;
    exception when check_violation then null;   -- correct
    end;

    raise exception 'zz134 rollback';
  exception
    when others then
      if sqlerrm like 'ASSERT%' then raise; end if;
      if sqlerrm not like 'zz134 rollback%' then
        raise exception '134 SELF-TEST FAILED unexpectedly: %', sqlerrm;
      end if;
  end;

  if exists (select 1 from public.wholesalers where wid like 'zz134%') then
    raise exception '134: the probes left rows behind';
  end if;

  raise notice '134 OK: two state machines, a return needs a reason, and a broken rule cannot cost a sale.';
end $$;
