-- =============================================================================
-- 136 — THE FINANCE DESK                               Block 7, 11 September 2026
-- =============================================================================
--
-- HADI: "And another one for the accountant or the finance manager as well."
--
-- Migration 088 named this person two weeks ago as somebody the product could
-- not serve: "an accountant, who wants a PDF". This is the account they never
-- had.
--
-- ==== ⭐ THE ONLY DESK THAT SEES MARGIN =====================================
--
-- `v2_product_variants.cost` is the most commercially sensitive number a
-- wholesaler holds, and 031/032 stripped it from every browser role. This
-- function is the ONE place it reaches a screen, and it does so through a
-- SECURITY DEFINER function with a column list rather than through a grant --
-- so "finance can see cost" never becomes "anon can see cost" by way of a
-- policy somebody edits later. check_tenant_isolation.sql keeps the grant shut
-- and is not weakened by this migration.
--
-- ==== ⛔ AND THE FINANCE DESK NEVER SEES THE FLOOR ==========================
--
--   no bin, no location, no pick progress, and NO fulfil_note.
--
-- The last one deserves its sentence. 087 exists because a merchant's internal
-- picker note was found printed on a CUSTOMER-FACING shipping label, for the
-- single reason that two surfaces read one field. `fulfil_note` is written by
-- one department TO ANOTHER DEPARTMENT. Finance is a third. It does not stop
-- being somebody else's mail because the reader has a bigger job title.
--
-- `buyer_note` DOES reach finance -- it is the customer's own words, and
-- finance is the department that talks to the customer about their order.
-- Two authors, two audiences, two columns, all the way down.
--
-- ==== ⚠️ NULL COST IS "WE DO NOT KNOW", NEVER ZERO =========================
--
-- Not every variant carries a cost. Treating a missing cost as 0 turns "we have
-- no idea what this cost us" into "this was free", which reports 100% margin and
-- is the most flattering possible lie. So the functions return the cost and the
-- COUNT OF LINES THAT HAVE ONE separately, and the screen says how much of the
-- order the margin actually covers. This repo has made this exact mistake
-- before: "Number(null) is 0, and 'from $0.00' is a different claim from 'we do
-- not know what this costs'" -- js/data/popular.js, and three others.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ================================================================== THE QUEUE
create or replace function wholesale_v2.v2_finance_queue(p_staff_id uuid)
returns table(
  order_id        uuid,
  reference       text,
  buyer_label     text,
  client_id       uuid,
  placed_at       timestamptz,
  order_status    text,
  state           text,
  sent_at         timestamptz,
  subtotal        numeric,
  received        numeric,
  outstanding     numeric,
  days_old        integer,
  currency        text
)
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
  select
    o.id,
    upper(substr(o.id::text,1,8)),
    o.buyer_label,
    o.client_id,
    o.created_at,
    o.status,
    a.state,
    a.sent_at,
    o.subtotal,
    coalesce(m.received, 0),
    o.subtotal - coalesce(m.received, 0),
    greatest(0, (current_date - o.created_at::date))::integer,
    coalesce(w.currency, '$')
  from wholesale_v2.v2_order_desk_assignments a
  join wholesale_v2.v2_orders o on o.id = a.order_id
  join wholesale_v2.v2_wholesalers w on w.wid = a.wid
  left join lateral (
    select sum(r.amount) as received
      from wholesale_v2.v2_money_received r
     where r.order_id = o.id
  ) m on true
  where a.wid = v_wid
    and a.desk = 'finance'
    and a.state in ('sent','accepted')
  order by o.created_at asc;     -- oldest debt first
end;
$fn$;

comment on function wholesale_v2.v2_finance_queue(uuid) is
  'The finance desk''s queue, oldest first. Migration 136. Carries money because '
  'finance is the desk money belongs to; carries NO location, pick progress or '
  'fulfil_note, because those belong to the warehouse.';

revoke all on function wholesale_v2.v2_finance_queue(uuid) from public;
grant execute on function wholesale_v2.v2_finance_queue(uuid) to anon, authenticated;

-- ================================================================== ONE ORDER
create or replace function wholesale_v2.v2_finance_order(p_staff_id uuid, p_order_id uuid)
returns table(
  order_item_id   bigint,
  product_name    text,
  sku             text,
  colour          text,
  size            text,
  qty             integer,
  unit_price      numeric,
  line_total      numeric,
  unit_cost       numeric,     -- NULL means "we do not know", never zero
  line_cost       numeric,
  line_margin     numeric,
  buyer_note      text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text;
begin
  v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'finance');
  if v_wid is null then return; end if;

  -- On this desk, at this store. Same rule as the warehouse: a uuid is not a
  -- credential (088's rule 1).
  if not exists (
    select 1 from wholesale_v2.v2_orders o
      join wholesale_v2.v2_order_desk_assignments a
        on a.order_id = o.id and a.desk='finance' and a.wid = v_wid
     where o.id = p_order_id and o.wid = v_wid
  ) then return; end if;

  return query
  select
    i.id,
    coalesce(p.name,'Product'),
    v.sku,
    nullif(v.extra_attrs->>'color',''),
    nullif(v.extra_attrs->>'size',''),
    i.qty,
    i.unit_price,
    i.line_total,
    v.cost,
    case when v.cost is null then null else v.cost * i.qty end,
    case when v.cost is null then null else i.line_total - (v.cost * i.qty) end,
    i.buyer_note
  from wholesale_v2.v2_order_items i
  join wholesale_v2.v2_product_variants v on v.id = i.variant_id
  left join wholesale_v2.v2_products p on p.id = v.product_id
  where i.order_id = p_order_id
  order by coalesce(p.name,''), i.id;
end;
$fn$;

comment on function wholesale_v2.v2_finance_order(uuid,uuid) is
  'One order, priced and costed, for the finance desk. Migration 136. THE ONLY '
  'PLACE v2_product_variants.cost reaches a browser, and it does so through a '
  'definer function rather than a grant, so check_tenant_isolation stays '
  'unweakened. A null cost stays null: "we do not know" is not "it was free".';

revoke all on function wholesale_v2.v2_finance_order(uuid,uuid) from public;
grant execute on function wholesale_v2.v2_finance_order(uuid,uuid) to anon, authenticated;

create or replace function wholesale_v2.v2_finance_order_head(p_staff_id uuid, p_order_id uuid)
returns table(
  order_id       uuid,
  reference      text,
  buyer_label    text,
  shop_name      text,
  phone          text,
  email          text,
  placed_at      timestamptz,
  order_status   text,
  state          text,
  subtotal       numeric,
  received       numeric,
  outstanding    numeric,
  currency       text,
  order_note     text,
  lines_total    integer,
  lines_costed   integer,      -- ⚠️ how much of the margin below is real
  known_cost     numeric,
  known_margin   numeric,
  return_reason  text
)
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
  select
    o.id, upper(substr(o.id::text,1,8)), o.buyer_label,
    c.shop_name, c.phone, c.email,
    o.created_at, o.status, a.state,
    o.subtotal,
    coalesce(m.received,0),
    o.subtotal - coalesce(m.received,0),
    coalesce(w.currency,'$'),
    o.notes,
    (select count(*)::integer from wholesale_v2.v2_order_items i where i.order_id=o.id),
    (select count(*)::integer from wholesale_v2.v2_order_items i
       join wholesale_v2.v2_product_variants v on v.id=i.variant_id
      where i.order_id=o.id and v.cost is not null),
    (select sum(v.cost * i.qty) from wholesale_v2.v2_order_items i
       join wholesale_v2.v2_product_variants v on v.id=i.variant_id
      where i.order_id=o.id and v.cost is not null),
    (select sum(i.line_total - (v.cost * i.qty)) from wholesale_v2.v2_order_items i
       join wholesale_v2.v2_product_variants v on v.id=i.variant_id
      where i.order_id=o.id and v.cost is not null),
    a.return_reason
  from wholesale_v2.v2_orders o
  join wholesale_v2.v2_order_desk_assignments a
    on a.order_id=o.id and a.desk='finance' and a.wid = v_wid
  join wholesale_v2.v2_wholesalers w on w.wid = a.wid
  left join wholesale_v2.v2_clients c on c.id = o.client_id
  left join lateral (select sum(r.amount) received from wholesale_v2.v2_money_received r
                      where r.order_id = o.id) m on true
  where o.id = p_order_id and o.wid = v_wid;
end;
$fn$;

revoke all on function wholesale_v2.v2_finance_order_head(uuid,uuid) from public;
grant execute on function wholesale_v2.v2_finance_order_head(uuid,uuid) to anon, authenticated;

-- ====================================================================== AGING
-- What is owed, by shop, in buckets. The one screen an accountant opens first.
create or replace function wholesale_v2.v2_finance_aging(p_staff_id uuid)
returns table(
  client_id     uuid,
  shop_name     text,
  phone         text,
  orders        integer,
  outstanding   numeric,
  bucket_0_30   numeric,
  bucket_31_60  numeric,
  bucket_61_90  numeric,
  bucket_90_plus numeric,
  oldest_days   integer,
  currency      text
)
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
  with owed as (
    select o.id, o.client_id, coalesce(c.shop_name, o.buyer_label) as shop, c.phone as ph,
           o.subtotal - coalesce((select sum(r.amount) from wholesale_v2.v2_money_received r
                                   where r.order_id = o.id), 0) as due,
           greatest(0, (current_date - o.created_at::date))::integer as age
      from wholesale_v2.v2_orders o
      join wholesale_v2.v2_order_desk_assignments a
        on a.order_id = o.id and a.desk='finance' and a.wid = v_wid
      left join wholesale_v2.v2_clients c on c.id = o.client_id
     where o.wid = v_wid
       and o.status <> 'cancelled'
  )
  select
    owed.client_id, max(owed.shop), max(owed.ph),
    count(*)::integer,
    sum(owed.due),
    sum(case when owed.age <= 30 then owed.due else 0 end),
    sum(case when owed.age between 31 and 60 then owed.due else 0 end),
    sum(case when owed.age between 61 and 90 then owed.due else 0 end),
    sum(case when owed.age > 90 then owed.due else 0 end),
    max(owed.age),
    (select coalesce(w.currency,'$') from wholesale_v2.v2_wholesalers w where w.wid = v_wid)
  from owed
  where owed.due > 0
  group by owed.client_id
  order by sum(owed.due) desc;
end;
$fn$;

comment on function wholesale_v2.v2_finance_aging(uuid) is
  'What is owed, by shop, in 30-day buckets. Migration 136. Excludes cancelled '
  'orders. "Owed" means subtotal minus what v2_money_received records as having '
  'arrived -- this app takes no money, it only records money that moved '
  'elsewhere.';

revoke all on function wholesale_v2.v2_finance_aging(uuid) from public;
grant execute on function wholesale_v2.v2_finance_aging(uuid) to anon, authenticated;

-- =============================================================================
-- SELF-TEST — ⭐ THE FLOOR WALL, asserted the same mechanical way 135 asserts
-- the money wall, so the two desks are kept apart by facts rather than by care.
-- =============================================================================
do $$
declare n integer; bad text;
begin
  -- ⭐ 1. NO finance function returns anything belonging to the warehouse floor.
  -- fulfil_note especially: it is one department's instruction to another, and
  -- finance is a third (087's rule does not stop at the buyer).
  select string_agg(p.specific_name || '.' || p.parameter_name, ', ') into bad
    from information_schema.parameters p
   where p.specific_schema='wholesale_v2' and p.parameter_mode='OUT'
     and p.specific_name like 'v2_finance_%'
     and p.parameter_name ~* '(fulfil|pick|bin|on_hand|reserved|barcode)';
  if bad is not null then
    raise exception 'ASSERT 1 FAILED: a FINANCE function returns the warehouse floor -- %', bad;
  end if;

  -- 2. every finance function passes THE ONE GATE, naming the finance desk.
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_finance_%'
     and pg_get_functiondef(p.oid) not like '%v2_staff_wid(p_staff_id, ''finance'')%';
  if bad is not null then
    raise exception 'ASSERT 2 FAILED: finance function(s) do not pass the finance gate -- %', bad;
  end if;

  -- 3. none of them writes. Finance READS here; the one thing it writes is a
  --    receipt, and that lives in 136 behind its own function.
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname like 'v2_finance_%'
     and pg_get_functiondef(p.oid) ~* '(insert into|update |delete from)\s+wholesale_v2';
  if bad is not null then raise exception 'ASSERT 3 FAILED: a finance READ function writes -- %', bad; end if;

  -- 4. ⛔ AND COST IS STILL SHUT TO anon.
  --
  -- ⚠️ THIS ASSERTION SAID `in ('anon','authenticated','public')` FOR ABOUT AN
  -- HOUR, AND PRODUCTION REFUSED THE MIGRATION. That refusal was correct and it
  -- found something real -- see migration 139, which exists because of it.
  --
  -- The short version: `authenticated` LEGITIMATELY holds cost. It is the role
  -- a wholesaler signs in as, the RLS SELECT policy on v2_product_variants
  -- scopes rows to `v2_is_owner() or the product belongs to v2_my_wid()`, and
  -- js/data/products-admin.js reads and writes `cost` on that table to run the
  -- product editor. A wholesaler seeing their OWN buying prices is the product
  -- working.
  --
  -- `anon` is the one that matters, and it is a GRANT question rather than a
  -- policy question: the read policy begins `(auth.uid() is null) or ...`, which
  -- is TRUE for anon, so anon can reach every row of that table. Nothing but the
  -- column grant keeps cost out of a signed-out browser. Migration 032 says it
  -- in its own header: "A TABLE-level GRANT already permits every column, and a
  -- column-level REVOKE does not carve an exception out of it."
  select count(*) into n from information_schema.column_privileges
   where table_schema='wholesale_v2' and table_name='v2_product_variants'
     and column_name='cost' and grantee in ('anon','public');
  if n <> 0 then
    raise exception 'ASSERT 4 FAILED: v2_product_variants.cost is granted to anon/public (% grant(s)) -- every buying price on the platform is readable with the publishable key', n;
  end if;

  -- 5. the three reads plus aging are reachable by a desk (a desk IS anon)
  select count(distinct routine_name) into n from information_schema.role_routine_grants
   where routine_schema='wholesale_v2' and grantee='anon'
     and routine_name in ('v2_finance_queue','v2_finance_order','v2_finance_order_head','v2_finance_aging');
  if n <> 4 then raise exception 'ASSERT 5 FAILED: % of 4 finance functions are reachable by a desk', n; end if;

  raise notice '137 OK: finance sees money and margin, and nothing from the warehouse floor.';
end $$;
