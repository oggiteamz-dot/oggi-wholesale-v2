# Batch 14 follow-up: dedicated schema + Cloudflare Workers hosting

Applied after Batch 14 was delivered, in response to Hadi's explicit
instructions on hosting and database isolation. This record covers two
changes:

1. Moving all of v2's database objects from `public` into a new,
   dedicated `wholesale_v2` Postgres schema (same Supabase project).
2. Rebuilding the Cloudflare deployment to use Workers directly (not
   Pages, not a proxy in front of an external host).

Neither change touches v1's code, schema, RLS, or hosting in any way.

## 1. Why

Hadi's instruction, verbatim: *"Okay. So when it comes to hosting, it's
gonna be Cloudflare. Don't do pages. Do workers. Pages don't work...
Also, in Supabase, there's already a schema made for the wholesale
apps. Don't touch that at all... Just add a new schema, new
deployment, don't touch anything in the old app."*

When asked to clarify what "new schema" meant, Hadi's own words were:
*"What I want is for these two apps, both wholesale apps to be
independent from each other so they don't break each other."* Given
three concrete options, Hadi chose: **"Separate schema, same Supabase
project."**

v2 had already been using a `v2_` table-name prefix convention inside
`public` (documented in `js/lib/supabase-client.js` since Batch 2) as a
lightweight isolation mechanism. That convention is **kept** on every
object name (for clarity/defense-in-depth), but it shared one Postgres
namespace with v1's own tables. A dedicated schema is real structural
isolation: v1 and v2 can no longer collide on an object name, a
`GRANT`, a `search_path` resolution, or a `SELECT *` typo the way two
apps sharing one schema always can, no matter how careful the naming
convention is.

## 2. Database change: `wholesale_v2` schema

**Migrations:** `supabase/migrations/026_v2_move_to_dedicated_schema.sql`
and `027_v2_move_partition_to_wholesale_v2.sql` (a same-day follow-up
correction — see below). Both applied live via Supabase MCP
`apply_migration` against project `olaipgdckbgjediddloj`.

**Approach:** `ALTER ... SET SCHEMA` on every existing object, not
drop-and-recreate. This was a deliberate choice:

- Table data, indexes, constraints, and RLS policies are preserved
  automatically. Zero data was copied, exported, or re-inserted.
- RLS policies reference helper functions like `v2_is_owner()`
  internally by **OID**, not by name — so moving a function to a new
  schema does not break any of migration 023's ~60 existing RLS
  policies, and none of them needed to be touched.
- Every function keeps its OID across the move, so every trigger and
  every cross-function call kept working with no changes needed beyond
  each function's own `search_path` setting (see below).

**What moved:** 33 tables (34 including the partitioned parent
`v2_inventory_movements` itself), 1 view (`v2_inventory_by_variant`),
30 functions, and — automatically, as a side effect of moving their
owning tables — all 7 `GENERATED ... AS IDENTITY` sequences.
Confirmed live, post-migration: **zero** `v2_*` tables, views,
sequences, or functions remain anywhere in `public`; all 14 of v1's own
`public` tables are untouched.

**Function `search_path`:** each function's own `search_path` GUC
(used to resolve unqualified table/function names inside the function
body at execution time — this is separate from which schema the
function itself lives in) was explicitly updated from `public` to
`wholesale_v2`, preserving whichever extra schemas it already needed
(`extensions` for the auth/invite functions, `net` for
`v2_dispatch_integration_event`, `vault` for the two integration-secret
functions). Verified live via `pg_get_functiondef` on `v2_my_wid()`
post-move — its body correctly resolves the unqualified
`v2_user_profiles` reference through the new `search_path`.

**Two real issues found and fixed while applying this migration** (both
corrected before/immediately after the live apply, not left for a
later cleanup):

1. **Sequence-ownership assumption was wrong.** The original migration
   plan included explicit `ALTER SEQUENCE ... SET SCHEMA` statements
   for all 7 bigint-PK sequences, based on a `pg_depend` check that
   found no `'a'` (auto/serial) dependency and concluded the sequences
   would not move automatically. That check missed dependency type
   `'i'` (internal) — the actual dependency type for
   `GENERATED ... AS IDENTITY` columns, which Postgres treats the same
   as serial for schema-move purposes. The first live attempt failed
   with `relation "public.v2_inventory_movements_id_seq" does not
   exist` (it had already moved automatically along with its table one
   step earlier in the same transaction). The failed attempt was fully
   atomic and rolled back cleanly — verified via `pg_class` that
   nothing had changed — so this cost a retry, not a partial-state
   cleanup. The corrected migration simply omits the now-redundant
   explicit sequence moves.
2. **Partitions do not move with their partitioned parent.** After
   migration 026 succeeded, verification found that
   `v2_inventory_movements` (the partitioned parent) had moved to
   `wholesale_v2` as expected, but its one partition,
   `v2_inventory_movements_2026_08`, had NOT — it is a distinct
   relation from its parent, and `ALTER TABLE ... SET SCHEMA` on a
   partitioned parent does not cascade to partitions the way it
   cascades to identity sequences. Fixed via migration 027, applied
   immediately after. The partition's own indexes moved automatically
   with the partition once the partition itself moved. This is worth
   flagging for any future partitioned-table work: verify partitions
   explicitly rather than assuming they follow the parent.

**Post-migration verification performed (live, against the real
database):**

- Zero `v2_*` objects remain in `public`; all 14 v1 tables in `public`
  are present and untouched.
- All 33 base tables' worth of RLS policies (30 tables carry at least
  one policy) are present under `pg_policies` for `schemaname =
  'wholesale_v2'`.
- Grant-hygiene fix from `025_v2_fix_batch14_grant_hygiene.sql`
  survived the move: `set local role = 'anon'; select
  wholesale_v2.v2_create_invite(...)` still correctly fails with
  `permission denied for function v2_create_invite`.
- The stale 5-arg `v2_submit_order` overload (found and dropped
  separately during this same work session — see below) did not
  reappear; only the correct 6-arg `(p_wid, p_buyer_label,
  p_location_id, p_lines, p_client_id, p_account_id)` signature exists
  under `wholesale_v2`.
- `get_advisors` (security) shows no new findings introduced by the
  schema move itself — the only `wholesale_v2`-scoped findings are
  `rls_enabled_no_policy` INFO-level notices on 4 internal-only tables
  (`v2_login_throttle`, `v2_rate_limit_hits`, `v2_webhook_deliveries`,
  `v2_webhook_endpoints`) plus the moved partition, which is the same
  intentional deny-all-by-default pattern v1 already uses for its own
  `public.login_throttle` table (these tables are written only by
  `SECURITY DEFINER` functions, never read/written directly by client
  roles).

### Separately found and fixed during this work: stale `v2_submit_order` overload

While inventorying every v2 function ahead of the schema move (a
necessary step to build the migration's function list), a live,
actively-exploitable security bug was found — unrelated to the schema
migration itself, but caught because of the careful inventory it
required. Batch 14's migration 024 added a 6th parameter
(`p_account_id`) to `v2_submit_order` using `CREATE OR REPLACE
FUNCTION`. Postgres identifies functions by name **and** parameter type
list, not name alone — so this created a **second overload** rather
than replacing the original 5-parameter function. The old, unprotected
5-arg version remained fully callable by both `anon` and
`authenticated` the entire time, meaning any caller could simply omit
`p_account_id` from an RPC call and PostgREST would resolve to the old
overload — completely bypassing the anti-order-spoofing fix that was
the whole point of adding that parameter in Batch 14.

Fixed via `drop function if exists public.v2_submit_order(text, text,
uuid, jsonb, uuid);`, applied live before the schema migration.
Verified only the 6-arg version remained, then checked for the same
duplicate-overload pattern across every other `v2_*` function via a
`GROUP BY proname HAVING count(*) > 1` query — zero other instances
found.

## 3. REQUIRED MANUAL STEP — Supabase Dashboard ("Exposed schemas")

**This is the one part of this change that cannot be done via SQL or
any available MCP tool, and the app will not work until it's done.**

Supabase's REST API (PostgREST) only serves schemas that are
explicitly added to the project's exposed-schema list. Right now that
list is `public` (and possibly `graphql_public`) only — `wholesale_v2`
is not on it, so every `supabase.from()` / `supabase.rpc()` call from
the v2 app will fail with a schema-not-exposed error until this is
done.

**Steps for Hadi:**

1. Open the Supabase Dashboard for the `oggi-wholesale`
   (`olaipgdckbgjediddloj`) project.
2. Go to **Project Settings → API → Data API**.
3. Find **Exposed schemas** and add `wholesale_v2` to the list
   (alongside the existing `public`).
4. Save.

No other manual database step is required — everything else in this
change was applied via migration.

## 4. Frontend change

`js/lib/supabase-client.js`'s `createClient()` call now passes
`db: { schema: "wholesale_v2" }`, so every `supabase.from()` /
`supabase.rpc()` call from the app targets the new schema by default.
No other frontend file needed to change — the entire v2 data layer
(`js/data/*.js`) already calls `supabase.from("v2_tablename")` /
`supabase.rpc("v2_function_name")` using the same object names, which
still resolve correctly since only the *schema* moved, not any object's
name.

## 5. Hosting change: Cloudflare Workers (not Pages)

The Batch 14 build included a placeholder Cloudflare deployment
(`cloudflare-worker/csp-worker.js` + `wrangler.toml`) designed as a
reverse-proxy Worker sitting in front of an undetermined external
static host (`ORIGIN` was a literal placeholder — v2 had never actually
been deployed anywhere). Per Hadi's explicit instruction — *"Don't do
Pages. Do Workers. Pages don't work."* — this has been rebuilt from
scratch as a real Cloudflare Workers deployment, not a proxy:

- **`wrangler.toml`** (project root) now configures an `[assets]`
  binding pointing at the project root itself (`directory = "."`),
  using Cloudflare's "Workers with static assets" feature —
  `index.html`, `css/`, and `js/` are served directly by the Worker,
  with no external origin involved at all. `run_worker_first = true`
  guarantees the Worker's `fetch` handler runs on every request
  (including ones that match a static file), and `not_found_handling =
  "single-page-application"` is set defensively even though v2 uses
  hash-based routing (`#/path`, see `js/app.js`) and the server
  realistically only ever sees requests for `/` and real static files.
- **`worker.js`** (project root, replaces
  `cloudflare-worker/csp-worker.js`) serves assets via the bound
  `env.ASSETS.fetch(request)` and then explicitly sets the same CSP +
  security headers Batch 14 defined (`Content-Security-Policy`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) on
  every response using `.set(...)` (not `.append`, so there's no
  header-duplication risk even with `_headers` also present — see
  below).
- **`.assetsignore`** (project root, new) excludes `supabase/`
  (migrations), `docs/`, and the deployment config files themselves
  (`wrangler.toml`, `worker.js`) from the publicly-served asset bundle
  — same `.gitignore`-style syntax Cloudflare uses. Verified this is
  the correct, currently-documented mechanism for excluding
  non-public files from a Workers static-assets deployment (checked
  against Cloudflare's current docs, not assumed from training data).
- **`_headers`** (project root) is **kept**, not removed. Checked
  Cloudflare's current documentation: `_headers` and `_redirects` files
  are natively supported by Workers static-assets serving, using the
  exact same format Pages used — this is not a Pages-only mechanism.
  It's kept as a second, native layer of defense carrying the identical
  policy, in case a future config change ever bypasses `worker.js`'s
  fetch handler (e.g. `run_worker_first` being flipped back to
  `false`). `worker.js`'s explicit header-setting is the authoritative
  source; keep both in sync by hand if the CSP policy ever changes.
- The old `cloudflare-worker/` subfolder (proxy design, placeholder
  `ORIGIN`) has been deleted entirely — nothing in it was ever
  deployed, so there is no live config to migrate away from.

**One-time deploy setup for Hadi**, once ready to go live:

```
npx wrangler login      # one-time, opens a browser to authorize
npx wrangler deploy     # run from the project root
```

Local preview before deploying: `npx wrangler dev`. Once a production
domain exists, uncomment and edit the `routes` block at the bottom of
`wrangler.toml`.

## 6. What was NOT touched

- v1's schema, tables, functions, RLS policies, and Supabase Auth setup
  — zero statements in migrations 026/027 reference anything outside
  `wholesale_v2` other than the `public.v2_*` objects being moved out
  of `public`.
- v1's own hosting/deployment, wherever it currently lives — nothing in
  this change removes or modifies any existing hosting configuration.
- Any of the 15 already-delivered v2 batches' functionality — this is a
  structural relocation of existing objects, not a feature or schema
  change to any table's columns, constraints, or business logic.
