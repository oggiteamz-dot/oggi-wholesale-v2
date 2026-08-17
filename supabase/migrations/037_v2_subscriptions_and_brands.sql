-- OGGI Wholesale v2 — Migrations 037–038 (consolidated)
-- Subscriptions / paid-until, and many-brands-per-wholesaler.
-- 17 Aug 2026 · CR-0002
--
-- Applied live as 037_v2_wholesaler_subscriptions and
-- 038_v2_wholesaler_brands; saved here as one file so the repo can
-- rebuild the database. See 034_v2_owner_console_schema.sql for why
-- live-but-unsaved migrations are treated as a defect. Every statement
-- below is idempotent and safe to re-run.


-- ====================================================================
-- 037 — SUBSCRIPTIONS
--
-- OGGI is sold as a subscription: a wholesaler pays monthly, six-monthly
-- or yearly, and Hadi renews them by hand as the money arrives. v1 had
-- this (`plan` / `paid_until`); the v2 rebuild dropped it -- regression
-- #2 in the 25 Jul sweep. This restores it.
--
-- TWO RULES THAT SHAPE EVERYTHING BELOW:
--
-- 1. EXTENSIONS STACK. "+1 month" pressed three times gives three
--    months, and renewing someone already paid to December runs FROM
--    December, not from today. Hence GREATEST(paid_until, today).
--    Getting this wrong silently steals time from a paying customer --
--    the kind of bug nobody notices until they complain.
--
-- 2. CANCELLING IS NOT CUTTING OFF. Paid to March, cancels in January ->
--    they keep access to March. They paid for it. That is why cancel has
--    an `immediate` flag defaulting to FALSE; terminating today is a
--    separate, deliberate act.
--
-- Every change is recorded in an append-only trail. This is money:
-- "I think I renewed them in March" is not good enough.
-- ====================================================================

alter table wholesale_v2.v2_wholesalers
  -- NULL = never subscribed. A past date = lapsed.
  add column if not exists paid_until          date,
  -- Records INTENT (e.g. cancelled-but-still-inside-their-term).
  -- Whether they can actually use the product is computed from the date
  -- in the view below, never from this column alone.
  add column if not exists subscription_status text not null default 'trial',
  -- Per-wholesaler on purpose: a negotiated rate must never be silently
  -- overwritten by a global price.
  add column if not exists price_amount        numeric(12,2),
  add column if not exists price_currency      text default '$',
  -- 'monthly' | 'biannual' | 'yearly'. Descriptive only -- extensions are
  -- always counted in MONTHS so any mix stacks.
  add column if not exists billing_period      text,
  add column if not exists cancelled_at        timestamptz,
  add column if not exists cancel_reason       text;

alter table wholesale_v2.v2_wholesalers
  drop constraint if exists v2_wholesalers_subscription_status_known;
alter table wholesale_v2.v2_wholesalers
  add constraint v2_wholesalers_subscription_status_known
  check (subscription_status in ('trial','active','expired','cancelled'));

comment on column wholesale_v2.v2_wholesalers.paid_until is
  'Last day of paid access, inclusive. Extensions stack from GREATEST(paid_until, today) so renewing early never costs the customer time they already paid for.';

-- The money trail. Append-only: nothing in the app can edit history.
create table if not exists wholesale_v2.v2_subscription_events (
  id           uuid primary key default gen_random_uuid(),
  wid          text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  action       text not null check (action in ('extend','cancel','reactivate','price_change','terminate')),
  months_added int,
  amount       numeric(12,2),
  currency     text,
  paid_until_before date,
  paid_until_after  date,
  note         text,
  actor_label  text,
  actor_id     uuid,
  created_at   timestamptz not null default now()
);

create index if not exists v2_subscription_events_by_wid
  on wholesale_v2.v2_subscription_events (wid, created_at desc);

alter table wholesale_v2.v2_subscription_events enable row level security;

drop policy if exists v2_subscription_events_owner on wholesale_v2.v2_subscription_events;
create policy v2_subscription_events_owner on wholesale_v2.v2_subscription_events
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select, insert on wholesale_v2.v2_subscription_events to authenticated;


-- The "+1 month / +6 months / +1 year" button. Months, not periods, so
-- any combination stacks correctly.
create or replace function wholesale_v2.v2_extend_subscription(
  p_wid text, p_months int, p_amount numeric default null, p_note text default null
)
returns table (ok boolean, error text, paid_until date)
language plpgsql security definer
set search_path to 'wholesale_v2', 'public'
as $$
declare v_before date; v_after date; v_cur text; v_label text;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can change a subscription', null::date; return;
  end if;
  if p_months is null or p_months <= 0 or p_months > 120 then
    return query select false, 'Months must be between 1 and 120', null::date; return;
  end if;

  select w.paid_until, w.price_currency into v_before, v_cur
    from wholesale_v2.v2_wholesalers w where w.wid = p_wid;
  if not found then
    return query select false, format('No wholesaler with id "%s"', p_wid), null::date; return;
  end if;

  -- THE STACKING RULE.
  v_after := greatest(coalesce(v_before, current_date), current_date) + (p_months || ' months')::interval;

  select actor_label into v_label from wholesale_v2.v2_user_profiles where id = auth.uid();

  update wholesale_v2.v2_wholesalers
     set paid_until = v_after,
         subscription_status = 'active',
         -- Extending after a cancellation revives them, so the
         -- cancellation markers are cleared rather than left to
         -- contradict the new paid-up date.
         cancelled_at = null, cancel_reason = null,
         updated_at = now()
   where wid = p_wid;

  insert into wholesale_v2.v2_subscription_events
    (wid, action, months_added, amount, currency, paid_until_before, paid_until_after, note, actor_label, actor_id)
  values (p_wid, 'extend', p_months, p_amount, v_cur, v_before, v_after, p_note,
          coalesce(v_label,'Owner'), auth.uid());

  return query select true, ''::text, v_after;
end; $$;


-- Cancel keeps their paid time; terminate (p_immediate) ends it today.
create or replace function wholesale_v2.v2_cancel_subscription(
  p_wid text, p_reason text default null, p_immediate boolean default false
)
returns table (ok boolean, error text, paid_until date)
language plpgsql security definer
set search_path to 'wholesale_v2', 'public'
as $$
declare v_before date; v_after date; v_label text;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can change a subscription', null::date; return;
  end if;

  select w.paid_until into v_before from wholesale_v2.v2_wholesalers w where w.wid = p_wid;
  if not found then
    return query select false, format('No wholesaler with id "%s"', p_wid), null::date; return;
  end if;

  v_after := case when p_immediate then current_date else v_before end;

  select actor_label into v_label from wholesale_v2.v2_user_profiles where id = auth.uid();

  update wholesale_v2.v2_wholesalers
     set subscription_status = 'cancelled', paid_until = v_after,
         cancelled_at = now(), cancel_reason = nullif(trim(coalesce(p_reason,'')), ''),
         updated_at = now()
   where wid = p_wid;

  insert into wholesale_v2.v2_subscription_events
    (wid, action, paid_until_before, paid_until_after, note, actor_label, actor_id)
  values (p_wid, case when p_immediate then 'terminate' else 'cancel' end,
          v_before, v_after, p_reason, coalesce(v_label,'Owner'), auth.uid());

  return query select true, ''::text, v_after;
end; $$;


create or replace function wholesale_v2.v2_set_wholesaler_price(
  p_wid text, p_amount numeric, p_currency text default '$', p_period text default 'monthly'
)
returns table (ok boolean, error text)
language plpgsql security definer
set search_path to 'wholesale_v2', 'public'
as $$
declare v_label text;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can set a price'; return;
  end if;
  if p_amount is null or p_amount < 0 then
    return query select false, 'Price cannot be negative'; return;
  end if;
  if p_period not in ('monthly','biannual','yearly') then
    return query select false, 'Billing period must be monthly, biannual or yearly'; return;
  end if;
  if not exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = p_wid) then
    return query select false, format('No wholesaler with id "%s"', p_wid); return;
  end if;

  select actor_label into v_label from wholesale_v2.v2_user_profiles where id = auth.uid();

  update wholesale_v2.v2_wholesalers
     set price_amount = p_amount, price_currency = coalesce(p_currency,'$'),
         billing_period = p_period, updated_at = now()
   where wid = p_wid;

  insert into wholesale_v2.v2_subscription_events
    (wid, action, amount, currency, note, actor_label, actor_id)
  values (p_wid, 'price_change', p_amount, coalesce(p_currency,'$'),
          'Price set to ' || p_amount || ' ' || p_period, coalesce(v_label,'Owner'), auth.uid());

  return query select true, ''::text;
end; $$;


-- ONE definition of "are they currently paid up", shared by the console,
-- any future access gate and any report. Computed from the date, so it
-- can never go stale the way a stored flag does.
create or replace view wholesale_v2.v2_wholesaler_billing as
select w.wid, w.brand, w.paid_until, w.subscription_status,
       w.price_amount, w.price_currency, w.billing_period,
       w.cancelled_at, w.cancel_reason,
       (w.paid_until is not null and w.paid_until >= current_date) as is_paid_up,
       case when w.paid_until is null then null else (w.paid_until - current_date) end as days_remaining,
       case
         when w.paid_until is null                then 'Never subscribed'
         when w.paid_until <  current_date        then 'Expired'
         when w.subscription_status = 'cancelled' then 'Cancelled — access until ' || to_char(w.paid_until,'DD Mon YYYY')
         when w.paid_until - current_date <= 7    then 'Expiring in ' || (w.paid_until - current_date) || ' days'
         else 'Active until ' || to_char(w.paid_until,'DD Mon YYYY')
       end as status_label
from wholesale_v2.v2_wholesalers w;

grant select on wholesale_v2.v2_wholesaler_billing to authenticated;

revoke all on function wholesale_v2.v2_extend_subscription(text,int,numeric,text)   from public, anon;
revoke all on function wholesale_v2.v2_cancel_subscription(text,text,boolean)       from public, anon;
revoke all on function wholesale_v2.v2_set_wholesaler_price(text,numeric,text,text) from public, anon;
grant execute on function wholesale_v2.v2_extend_subscription(text,int,numeric,text)   to authenticated;
grant execute on function wholesale_v2.v2_cancel_subscription(text,text,boolean)       to authenticated;
grant execute on function wholesale_v2.v2_set_wholesaler_price(text,numeric,text,text) to authenticated;


-- ====================================================================
-- 038 — MANY BRANDS PER WHOLESALER
--
-- "Some clients might sell multiple brands... instead of brand, brands,
-- and I can add an infinite amount."
--
-- WHY THE OLD `brand` COLUMN STAYS: it is read by the buyer catalog, the
-- supplier directory, the owner list and the invite screen. Removing it
-- would mean changing every one of those in a single step, and any one
-- missed becomes a blank name in front of a buyer. So `brand` remains the
-- PRIMARY/display brand and this table holds the full list -- the
-- "expand" step. Display code can start reading the list one screen at a
-- time, each proven separately.
--
-- The primary is mirrored INTO this table too, so "all their brands" is
-- answerable from one place rather than "the column, plus the table, and
-- remember to merge them" -- the two-sources-of-truth split that has
-- bitten this codebase before.
-- ====================================================================

create table if not exists wholesale_v2.v2_wholesaler_brands (
  id         uuid primary key default gen_random_uuid(),
  wid        text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  name       text not null,
  is_primary boolean not null default false,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

-- The same brand twice under one wholesaler is always a mistake.
create unique index if not exists v2_wholesaler_brands_unique
  on wholesale_v2.v2_wholesaler_brands (wid, lower(name));

-- "At most one primary per wholesaler", enforced by the database rather
-- than by hoping the interface behaves.
create unique index if not exists v2_wholesaler_brands_one_primary
  on wholesale_v2.v2_wholesaler_brands (wid) where is_primary;

create index if not exists v2_wholesaler_brands_by_wid
  on wholesale_v2.v2_wholesaler_brands (wid, sort_order);

alter table wholesale_v2.v2_wholesaler_brands enable row level security;

drop policy if exists v2_wholesaler_brands_read on wholesale_v2.v2_wholesaler_brands;
create policy v2_wholesaler_brands_read on wholesale_v2.v2_wholesaler_brands
  for select using (true);

drop policy if exists v2_wholesaler_brands_write on wholesale_v2.v2_wholesaler_brands;
create policy v2_wholesaler_brands_write on wholesale_v2.v2_wholesaler_brands
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select on wholesale_v2.v2_wholesaler_brands to anon, authenticated;
grant insert, update, delete on wholesale_v2.v2_wholesaler_brands to authenticated;

-- Backfill so the table is COMPLETE from the moment it exists, rather
-- than starting empty and quietly disagreeing with the column.
insert into wholesale_v2.v2_wholesaler_brands (wid, name, is_primary, sort_order)
select w.wid, w.brand, true, 0
from wholesale_v2.v2_wholesalers w
where coalesce(trim(w.brand),'') <> ''
on conflict do nothing;

-- Sets the whole list in one call. First entry is the primary and is
-- mirrored back into BOTH brand columns, so they cannot drift.
create or replace function wholesale_v2.v2_set_wholesaler_brands(
  p_wid text, p_brands text[]
)
returns table (ok boolean, error text, primary_brand text)
language plpgsql security definer
set search_path to 'wholesale_v2', 'public'
as $$
declare v_name text; v_i int := 0; v_primary text;
begin
  if not wholesale_v2.v2_is_owner() then
    return query select false, 'Only the owner can change brands', null::text; return;
  end if;
  if p_brands is null or array_length(p_brands,1) is null then
    return query select false, 'At least one brand is required', null::text; return;
  end if;
  if not exists (select 1 from wholesale_v2.v2_wholesalers w where w.wid = p_wid) then
    return query select false, format('No wholesaler with id "%s"', p_wid), null::text; return;
  end if;

  delete from wholesale_v2.v2_wholesaler_brands where wid = p_wid;

  foreach v_name in array p_brands loop
    if coalesce(trim(v_name),'') = '' then continue; end if;
    insert into wholesale_v2.v2_wholesaler_brands (wid, name, is_primary, sort_order)
    values (p_wid, trim(v_name), v_i = 0, v_i)
    on conflict do nothing;
    if v_i = 0 then v_primary := trim(v_name); end if;
    v_i := v_i + 1;
  end loop;

  if v_primary is null then
    return query select false, 'At least one brand is required', null::text; return;
  end if;

  -- Keep the legacy columns in step -- buyers still read these.
  update wholesale_v2.v2_wholesalers set brand = v_primary, updated_at = now() where wid = p_wid;
  update public.wholesalers          set brand = v_primary                       where wid = p_wid;

  return query select true, ''::text, v_primary;
end; $$;

revoke all on function wholesale_v2.v2_set_wholesaler_brands(text,text[]) from public, anon;
grant execute on function wholesale_v2.v2_set_wholesaler_brands(text,text[]) to authenticated;
