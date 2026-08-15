-- OGGI Wholesale v2 — Batch 4: clients + visit log
-- 11 Aug 2026
--
-- Salesperson features (recency-sorted client list, usual-order reorder,
-- add-client-on-the-fly, visit logging) cannot exist without a real client
-- record -- this was wrongly deferred to "needs real auth" in Batch 3's
-- wholesaler.js placeholder text; a client table itself needs no auth, only
-- v2_orders.buyer_label linking to a real login system does (correctly
-- still Batch 14). Fixing that scoping mistake here rather than carrying
-- it forward.
--
-- Real data: doc.clients has 2 real clients under wid 'sq' -- "CEDAR
-- Shops" and "AMANI Stores", with real phone/discount/note fields --
-- migrated below, not fabricated.

create table if not exists v2_clients (
  id          uuid primary key default gen_random_uuid(),
  wid         text not null references wholesalers(wid) on delete cascade,
  shop_name   text not null,
  phone       text,
  note        text,
  discount_pct numeric(5,2) not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (wid, shop_name)
);
create index if not exists idx_v2_clients_wid on v2_clients(wid) where active;

create table if not exists v2_visit_log (
  id          bigint generated always as identity primary key,
  wid         text not null references wholesalers(wid) on delete cascade,
  client_id   uuid references v2_clients(id) on delete set null,
  rep_label   text not null,
  note        text,
  visited_at  timestamptz not null default now()
);
create index if not exists idx_v2_visit_log_wid on v2_visit_log(wid, visited_at desc);

alter table v2_clients enable row level security;
alter table v2_visit_log enable row level security;

-- Same temporary/permissive-during-build posture as everything else this
-- build. Hardened for real in Batch 14.
create policy v2_clients_all on v2_clients for all using (true) with check (true);
create policy v2_visit_log_all on v2_visit_log for all using (true) with check (true);

-- Real data migration from wholesale_state.doc.clients (same
-- source-of-truth as Batches 1-2 -- see 002_v2_data_migration.sql header
-- for why the JSON doc, not the SQL clients table, is authoritative).
insert into v2_clients (wid, shop_name, phone, note, discount_pct)
select kv.key as wid, c.key as shop_name,
       c.value->>'phone' as phone,
       nullif(c.value->>'note', '') as note,
       coalesce((c.value->>'discount')::numeric, 0) as discount_pct
from wholesale_state ws,
     jsonb_each(ws.doc->'clients') kv,
     jsonb_each(kv.value) c
where ws.id = 'main'
on conflict (wid, shop_name) do nothing;
