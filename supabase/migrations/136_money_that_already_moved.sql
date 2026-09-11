-- =============================================================================
-- 136 — MONEY THAT ALREADY MOVED                       Block 7, 11 September 2026
-- =============================================================================
--
-- ==== 🛑 READ THIS BEFORE ADDING ANYTHING TO THIS TABLE =====================
--
-- HADI, 24 August 2026, recorded in checks/check_no_payment_path.mjs:
--   "we're not going to be selling anything here. This is just an ordering
--    system. NO MONEY WILL BE PAID THROUGH THIS APP at the moment."
--
-- This table does not change that and must never be the thing that does.
--
--   A ROW HERE IS A RECORD OF SOMETHING THAT ALREADY HAPPENED IN A BANK.
--
-- The finance manager types "the shop paid us 4,200 by transfer on the 9th"
-- AFTER the transfer. That is the same category as the "payment terms" memo on a
-- supplier record, which that gate explicitly allows as "a memo rather than a
-- transaction". It is bookkeeping, not a till.
--
-- THE LINE, DRAWN MECHANICALLY so it does not depend on anybody remembering:
--
--   * no processor, no card field, no charge -- check_no_payment_path.mjs
--     already bans those across all of js/ and keeps doing so
--   * ⛔ NO BUYER MAY EVER REACH THIS. Not the table, not the function, not a
--     screen. A buyer who can record their own payment has been handed a "pay"
--     button with extra steps. Only an authenticated wholesaler or a FINANCE
--     desk may write here, and checks/check_finance_records_not_charges.mjs
--     asserts no buyer-facing module imports it.
--   * it is called `v2_money_received`, not `v2_payments`. The name is part of
--     the design: it is past tense, and it says money arrived rather than that
--     we took it.
--
-- ==== WHY NOT `v2_order_receipts` ===========================================
--
-- Because `v2_receipt_costs` (migration 121) already exists and means the
-- landed cost of GOODS RECEIVED INTO A WAREHOUSE. Two unrelated meanings of
-- "receipt" one migration apart is the "suppliers" trap again -- js/views/buyer.js
-- calls the wholesalers it buys FROM "suppliers", while js/data/suppliers.js
-- means the wholesaler's own vendors, and that collision has confused every
-- person who has read both. One word, one meaning, or a new word.
-- =============================================================================

set search_path = wholesale_v2, public;

create table if not exists v2_money_received (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references v2_orders(id) on delete cascade,
  wid           text not null references v2_wholesalers(wid) on delete cascade,

  amount        numeric(12,2) not null check (amount > 0),
  currency      text not null default '$',

  -- How it actually arrived. 'other' exists so nobody has to lie; a free-text
  -- reference carries the rest.
  method        text not null default 'bank'
                check (method in ('cash','bank','cheque','card_offline','other')),

  -- The date the money moved, which is NOT the date somebody typed it in. An
  -- accountant reconciling a statement needs the bank's date; `recorded_at`
  -- keeps ours separately rather than overwriting theirs.
  received_on   date not null default current_date,
  reference     text,                    -- transfer ref, cheque number, slip no.
  note          text,

  recorded_at   timestamptz not null default now(),
  recorded_by_staff uuid references v2_staff_accounts(id) on delete set null,
  recorded_by_user  uuid,                -- the wholesaler, when they record it themselves
  -- Exactly one author. A row with neither is unattributable and a row with both
  -- is a lie about who did it.
  constraint v2_money_received_has_one_author
    check ((recorded_by_staff is not null) <> (recorded_by_user is not null))
);

comment on table v2_money_received is
  'A RECORD OF MONEY THAT ALREADY MOVED, somewhere else. Migration 136. This app '
  'takes no money (check_no_payment_path.mjs, Hadi 24 Aug); a row here is '
  'bookkeeping entered after the fact by the finance desk or the wholesaler. '
  'NO BUYER MAY EVER REACH IT -- a buyer recording their own payment is a "pay" '
  'button with extra steps. Not to be confused with v2_receipt_costs (121), '
  'which is the landed cost of goods received into a warehouse.';

comment on column v2_money_received.received_on is
  'The date the money moved in the real world, which is deliberately separate '
  'from recorded_at. An accountant reconciling a bank statement needs the '
  'bank''s date, not ours.';

create index if not exists idx_v2_money_received_order on v2_money_received (order_id);
create index if not exists idx_v2_money_received_wid   on v2_money_received (wid, received_on desc);

alter table v2_money_received enable row level security;
drop policy if exists v2_money_received_scoped on v2_money_received;
create policy v2_money_received_scoped on v2_money_received
  for all using (v2_is_owner() or wid = v2_my_wid())
       with check (v2_is_owner() or wid = v2_my_wid());

-- anon holds nothing: the finance desk writes through the definer function
-- below, which checks the desk. A buyer is also anon, and this is the table a
-- buyer must never be near.
revoke all on table v2_money_received from public, anon;
grant select, insert, update, delete on table v2_money_received to authenticated;

-- ================================================== recording it, from a desk
create or replace function wholesale_v2.v2_record_money_received(
  p_staff_id uuid, p_order_id uuid, p_amount numeric,
  p_method text default 'bank', p_received_on date default null,
  p_reference text default null, p_note text default null)
returns table(ok boolean, msg text, receipt_id uuid)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text; v_order_wid text; v_id uuid; v_cur text;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'finance');
  if v_wid is null then
    return query select false, 'Not authorized', null::uuid; return;
  end if;

  select o.wid into v_order_wid from wholesale_v2.v2_orders o where o.id = p_order_id;
  if v_order_wid is null or v_order_wid <> v_wid then
    -- Same answer for "no such order" and "somebody else's order".
    return query select false, 'Not authorized', null::uuid; return;
  end if;

  if p_amount is null or p_amount <= 0 then
    return query select false, 'An amount above zero is required', null::uuid; return;
  end if;
  if p_method not in ('cash','bank','cheque','card_offline','other') then
    return query select false, 'Unknown method', null::uuid; return;
  end if;
  if coalesce(p_received_on, current_date) > current_date then
    -- Money does not arrive in the future, and a forward-dated receipt is how a
    -- ledger quietly stops reconciling.
    return query select false, 'That date is in the future', null::uuid; return;
  end if;

  select coalesce(w.currency,'$') into v_cur
    from wholesale_v2.v2_wholesalers w where w.wid = v_wid;

  insert into wholesale_v2.v2_money_received
    (order_id, wid, amount, currency, method, received_on, reference, note, recorded_by_staff)
  values (p_order_id, v_wid, p_amount, coalesce(v_cur,'$'), p_method,
          coalesce(p_received_on, current_date),
          nullif(trim(coalesce(p_reference,'')),''),
          nullif(trim(coalesce(p_note,'')),''),
          p_staff_id)
  returning id into v_id;

  return query select true, 'Recorded', v_id;
end;
$fn$;

revoke all on function wholesale_v2.v2_record_money_received(uuid,uuid,numeric,text,date,text,text) from public;
grant execute on function wholesale_v2.v2_record_money_received(uuid,uuid,numeric,text,date,text,text) to anon, authenticated;

create or replace function wholesale_v2.v2_money_received_for_order(p_staff_id uuid, p_order_id uuid)
returns table(
  id uuid, amount numeric, currency text, method text,
  received_on date, reference text, note text, recorded_at timestamptz, recorded_by text)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'finance');
  if v_wid is null then return; end if;
  return query
  select r.id, r.amount, r.currency, r.method, r.received_on, r.reference, r.note,
         r.recorded_at,
         coalesce(s.actor_label, s.username, 'the wholesaler')
    from wholesale_v2.v2_money_received r
    left join wholesale_v2.v2_staff_accounts s on s.id = r.recorded_by_staff
   where r.order_id = p_order_id and r.wid = v_wid
   order by r.received_on desc, r.recorded_at desc;
end;
$fn$;

revoke all on function wholesale_v2.v2_money_received_for_order(uuid,uuid) from public;
grant execute on function wholesale_v2.v2_money_received_for_order(uuid,uuid) to anon, authenticated;

-- =============================================================================
-- SELF-TEST
-- =============================================================================
do $$
declare n integer; bad text; v_loc uuid; v_order uuid; v_staff uuid; v_ok boolean;
begin
  -- 1. anon holds no grant on the table itself
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_money_received'
     and grantee in ('anon','public');
  if n <> 0 then raise exception 'ASSERT 1 FAILED: anon holds % grant(s) on v2_money_received', n; end if;

  -- 2. ⭐ the recording function passes through the FINANCE gate and no other
  if pg_get_functiondef('wholesale_v2.v2_record_money_received(uuid,uuid,numeric,text,date,text,text)'::regprocedure)
     not like '%v2_staff_wid(p_staff_id, ''finance'')%' then
    raise exception 'ASSERT 2 FAILED: money can be recorded without passing the finance gate';
  end if;

  -- 3. behaviour, on probes
  begin
    insert into public.wholesalers (wid,name,active) values ('zz136a','zz136 probe',false);
    insert into wholesale_v2.v2_wholesalers (wid,name) values ('zz136a','zz136 probe');
    insert into wholesale_v2.v2_locations (wid,name) values ('zz136a','dock') returning id into v_loc;
    insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,status,subtotal)
      values ('zz136a','probe shop',v_loc,'new',100) returning id into v_order;
    insert into wholesale_v2.v2_staff_accounts (wid,desk,username,password_hash)
      values ('zz136a','finance','books','x') returning id into v_staff;
    insert into wholesale_v2.v2_order_desk_assignments (order_id,wid,desk)
      values (v_order,'zz136a','finance');

    select ok into v_ok from wholesale_v2.v2_record_money_received(v_staff, v_order, 40, 'bank');
    if not coalesce(v_ok,false) then raise exception 'ASSERT 3 FAILED: finance could not record a real receipt'; end if;

    -- a WAREHOUSE account must not be able to record money
    declare v_wh uuid;
    begin
      insert into wholesale_v2.v2_staff_accounts (wid,desk,username,password_hash)
        values ('zz136a','warehouse','picker','x') returning id into v_wh;
      select ok into v_ok from wholesale_v2.v2_record_money_received(v_wh, v_order, 10, 'cash');
      if coalesce(v_ok,false) then
        raise exception 'ASSERT 4 FAILED: a WAREHOUSE account recorded money -- the desks are not separated';
      end if;
    end;

    -- a future date is refused
    select ok into v_ok from wholesale_v2.v2_record_money_received(v_staff, v_order, 10, 'bank', current_date + 1);
    if coalesce(v_ok,false) then raise exception 'ASSERT 5 FAILED: money was recorded as arriving in the future'; end if;

    -- a negative amount is refused
    select ok into v_ok from wholesale_v2.v2_record_money_received(v_staff, v_order, -5, 'bank');
    if coalesce(v_ok,false) then raise exception 'ASSERT 6 FAILED: a negative receipt was accepted'; end if;

    -- an order at ANOTHER store is refused, and says only "Not authorized"
    declare v_other uuid; v_msg text;
    begin
      insert into public.wholesalers (wid,name,active) values ('zz136b','other',false);
      insert into wholesale_v2.v2_wholesalers (wid,name) values ('zz136b','other');
      insert into wholesale_v2.v2_locations (wid,name) values ('zz136b','dock2') returning id into v_loc;
      insert into wholesale_v2.v2_orders (wid,buyer_label,location_id,status,subtotal)
        values ('zz136b','someone else',v_loc,'new',50) returning id into v_other;
      select ok, msg into v_ok, v_msg from wholesale_v2.v2_record_money_received(v_staff, v_other, 10, 'bank');
      if coalesce(v_ok,false) then
        raise exception 'ASSERT 7 FAILED: finance at store A recorded money against store B''s order';
      end if;
      if v_msg <> 'Not authorized' then
        raise exception 'ASSERT 8 FAILED: the refusal distinguishes "somebody else''s order" from "no such order" (said: %)', v_msg;
      end if;
    end;

    raise exception 'zz136 rollback';
  exception
    when others then
      if sqlerrm like 'ASSERT%' then raise; end if;
      if sqlerrm not like 'zz136 rollback%' then
        raise exception '136 SELF-TEST FAILED unexpectedly: %', sqlerrm;
      end if;
  end;

  if exists (select 1 from public.wholesalers where wid like 'zz136%') then
    raise exception '136: the probes left rows behind';
  end if;
  raise notice '136 OK: money can be recorded by finance only, never in the future, never for another store.';
end $$;
