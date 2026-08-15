-- OGGI Wholesale v2 — Batch 5: v2-owned wholesaler directory mirror
-- 11 Aug 2026
--
-- REAL BUG FOUND DURING BATCH 5 VERIFICATION, FIXED HERE:
-- v1's `wholesalers` table has real, already-applied RLS: every policy
-- (SELECT/INSERT/UPDATE/DELETE) is scoped to the `authenticated` role only
-- (`wholesalers_read_authed`, `wholesalers_write_scoped`, etc., using
-- `is_owner()`/`my_wid()` helpers that read real JWT claims). v2 is still
-- on dev-mode auth (Batch 0 stub, no real Supabase session, replaced for
-- real in Batch 14) and talks to Postgres as the `anon` role via the
-- publishable key. Under `anon`, every one of those policies evaluates to
-- false, so ALL v2 reads/writes against `wholesalers` return empty/no-op —
-- confirmed directly: `select * from wholesalers` via the anon key returns
-- `content-range: */0` (RLS silently filtering, not erroring), and a PATCH
-- returns `200 OK` with an empty array (0 rows matched — the same "silent
-- no-op instead of a loud error" failure mode already found twice this
-- build, in Batches 1 and 3).
--
-- This has been silently broken since BATCH 2: js/data/catalog.js's
-- getWholesaler() and listWholesalers() (buyer brand/currency lookup and
-- the Suppliers tab) query `wholesalers` directly and have been returning
-- null/[] the whole time. Found now via the same curl-verification
-- discipline used every batch, fixed now rather than shipped again.
--
-- FIX: v1's `wholesalers` table and its real RLS are NOT touched — per
-- the standing instruction, v1's schema and security posture stay exactly
-- as they are. Instead v2 gets its own mirror table, `v2_wholesalers`,
-- populated from the real source (a join of v1's `wholesalers` table,
-- service-role-read at migration time, restricted to the wids confirmed
-- live via `wholesale_state.doc.wholesalers` — mg, omni, sq,
-- w1785168930020 — the same real-roster set every prior migration this
-- build has used, excluding orphaned test rows like `WS-001` and
-- `w1784990095973` that have zero references anywhere in real data).
-- Permissive dev-mode RLS, same posture as every other v2_ table, hardened
-- for real in Batch 14.

create table if not exists v2_wholesalers (
  wid        text primary key references wholesalers(wid) on delete cascade,
  brand      text,
  name       text,
  currency   text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table v2_wholesalers enable row level security;
create policy v2_wholesalers_all on v2_wholesalers for all using (true) with check (true);

insert into v2_wholesalers (wid, brand, name, currency, active)
select w.wid, w.brand, w.name, w.currency, w.active
from wholesalers w
where w.wid in (
  select d->>'id' from wholesale_state ws, jsonb_array_elements(ws.doc->'wholesalers') d where ws.id = 'main'
)
on conflict (wid) do nothing;
