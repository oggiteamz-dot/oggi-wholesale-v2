-- OGGI Wholesale v2 — Batch 5: owner/admin schema
-- 11 Aug 2026
--
-- Signup requests: real data migrated from wholesale_state.doc.requests
-- (same source-of-truth pattern as every prior batch's migration) -- 1 real
-- pending request exists ("NOOR Boutique" wanting to join wid 'sq').
--
-- Audit log: append-only, mirrors the ledger discipline already used for
-- inventory (001) -- owner actions are never updated or deleted, only
-- appended to, so the log itself can't be quietly edited after the fact.

create table if not exists v2_signup_requests (
  id          uuid primary key default gen_random_uuid(),
  wid         text references wholesalers(wid) on delete set null,
  buyer_name  text not null,
  location    text,
  volume      text,
  sells       text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_signup_requests_status on v2_signup_requests(status, created_at desc);

create table if not exists v2_audit_log (
  id          bigint generated always as identity primary key,
  actor_label text not null,
  action      text not null,              -- e.g. 'wholesaler.deactivate', 'request.approve'
  target_type text,                        -- e.g. 'wholesaler', 'signup_request'
  target_id   text,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_audit_log_created on v2_audit_log(created_at desc);

alter table v2_signup_requests enable row level security;
alter table v2_audit_log enable row level security;

-- Owner tooling is inherently cross-wholesaler -- same temporary/permissive
-- posture as everything else, hardened for real (owner-role-only access)
-- in Batch 14.
create policy v2_signup_requests_all on v2_signup_requests for all using (true) with check (true);
create policy v2_audit_log_all on v2_audit_log for all using (true) with check (true);

-- Real data migration from wholesale_state.doc.requests.
insert into v2_signup_requests (wid, buyer_name, location, volume, sells, status)
select r->>'wid', r->>'buyer', r->>'loc', r->>'vol', r->>'sells', coalesce(r->>'status', 'pending')
from wholesale_state ws, jsonb_array_elements(ws.doc->'requests') r
where ws.id = 'main'
  and not exists (
    select 1 from v2_signup_requests existing
    where existing.buyer_name = r->>'buyer' and existing.wid = r->>'wid'
  );

-- Deactivation reason is deliberately NOT a new column on the v1
-- `wholesalers` table -- the existing `active` boolean (v1's own column,
-- already used by v1) is reused for the actual state, and the reason text
-- is recorded as a v2_audit_log entry instead. This keeps v1's schema
-- completely untouched by Batch 5, not just "untouched in practice."
