# Batch 1 — Deploy Record
**Core data & inventory architecture + real v1 data migration · 11 Aug 2026**

## Critical finding (read this first)
The live v1 app does **not** primarily read/write the `products` / `wholesalers` / `clients` / `orders` SQL tables. It reads and writes **one row**, `wholesale_state` where `id='main'`, as a single ~2MB JSON document — confirmed directly from v1's own source (`sb.from('wholesale_state').upsert({id:'main', doc:collectData()})`, plus the code's own comment: "business data lives in one row (wholesale_state/main) so it's shared across..."). The SQL tables contain leftover/parallel data the live app never reads — e.g. wid `WS-001` has **zero** references anywhere in the 6,248-line v1 `index.html`, confirmed by direct grep, yet it has 4 "products" sitting in the `products` table. If Batch 1 had migrated from the SQL tables instead of the JSON doc, the migration would have been quietly wrong — pulling orphaned test data and missing the real live catalog entirely. This was caught before any write happened, by inspecting both sources and grepping v1's actual source for which one the app truly uses.

## What was built
1. **`001_v2_inventory_core.sql`** (applied earlier this session): normalized variant schema, partitioned append-only inventory ledger, atomic RPC-only stock-write functions, soft TTL reservations, internal webhook infrastructure — full detail in that file's own header comments. Fixed one FK bug on first apply (`wholesalers`' primary key is `wid` text, not `id` — corrected before re-applying) and one RLS gap (the first monthly partition didn't inherit RLS enablement — enabled explicitly).
2. **`002_v2_data_migration.sql`**: migrates every real product from `wholesale_state.doc.products` into the new schema. Reads directly from the live JSON via SQL (`jsonb_each`/`jsonb_array_elements`) rather than hand-transcribing numbers into INSERT statements — eliminates transcription-error risk entirely, since every value the script writes is computed from the source document itself, not retyped by hand.
3. **Security hardening pass** (`v2_security_hardening_pass1`): found and fixed via `get_advisors` after Batch 1 landed — added missing read policies on 6 tables that had RLS enabled with no policy at all (would have blocked the app's own reads), set `security_invoker = true` on the `v2_inventory_by_variant` view (it was silently bypassing RLS on its base table via Postgres's default view-owner-permissions behavior), and pinned `search_path = public` on all 6 `SECURITY DEFINER` RPC functions (standard hardening against search-path hijacking). None of this is Security-batch (14) work — no real tenant authorization was added, that's still correctly deferred — this is just closing gaps that cost nothing to close now.

## Key migration decisions (each traced to a specific finding, not a guess)
- **Colour palette**: legacy products reference colours by a 0-3 palette index. Found the actual palette hardcoded in v1's source (`var COLOURS = [...]`, index.html ~line 460) — Midnight Blue `#24467a`, Crimson Red `#b23046`, Sand `#c9b18a`, Forest `#2f6b4f` — and used those exact names/hex values, not placeholders. These names also appear verbatim in real order line-items in `doc.orders`, confirming the mapping.
- **Stock granularity**: v1's own source code comment (index.html ~line 572) states outright that `p.stock[i]` is per-colour and "there is no size [tracking]." This is confirmed, not inferred — and it's exactly the regression class this whole rebuild exists to fix. Since there's no real per-size number to migrate, each colour's known total was evenly split across that product's sizes (remainder to the first size) and written through the real `v2_receive_stock` RPC — a logged, auditable movement, not a silent balance write — with a note on every row explaining the approximation. This is demo/test-scale data (order totals in the hundreds of dollars, placeholder shop names like "AMANI Stores"), so this is a reasonable stand-in until real per-size counts are entered via a cycle count (Batch 9).
- **Wholesaler roster gap**: `omni` ("Omni Access") has real products in `doc.products` and appears in `doc.wholesalers`, but has no row in the `wholesalers` SQL table (that table is incomplete, not authoritative — see the finding above). Added one additive row for it (`insert ... on conflict do nothing`) — did not touch, modify, or remove any existing row. This was necessary for the FK on `v2_products.wid` to resolve, and it's arguably a pre-existing inconsistency in v1's own data that this fixes rather than a risk this introduces.
- **Batch scope discipline**: only products/variants/inventory were migrated, matching Batch 1's own schema. Clients, orders, catalogs and requests exist in the source JSON too but are correctly left for Batches 2/3/5 to migrate once their own v2 tables exist — not invented ad hoc here just because the data was sitting right there.

## Verification (numbers, not just "it ran")
Queried `wholesale_state.doc` directly and cross-checked every migrated total against the source before calling this done:

| Wholesaler | Product | Variants created | Migrated stock total | Source stock array | Match |
|---|---|---|---|---|---|
| mg | Merino Crew Knit | 16 | 143 | [40,55,18,30] | ✅ |
| mg | Wool Overshirt | 16 | 72 | [35,12,5,20] | ✅ |
| sq | Denim Utility Jacket | 16 | 268 | [120,80,8,60] | ✅ |
| sq | Boxy Cotton Tee | 16 | 870 | [300,240,180,150] | ✅ |
| sq | Cargo Pant | 16 | 310 | [90,110,40,70] | ✅ |
| sq | Hooded Sweat | 16 | 119 | [60,8,6,45] | ✅ |
| omni | Classic Crew Tee | 16 | 2000 | [500,500,500,500] | ✅ |
| omni | Canvas Tote Bag | 16 | 960 | [240,240,240,240] | ✅ |
| w1785168930020 | "B" | 5 | 50 | [50] | ✅ |

9 products, 133 variants, 133 inventory movements, 133 balance rows — every total matches its source exactly, zero discrepancy.

**v1 tables confirmed untouched**: `products` (4 rows, unchanged), `clients` (2 rows, unchanged), `orders` (0 rows, unchanged), `wholesale_state` (unchanged — read-only source, never written). The only change to any pre-existing v1 table was the single additive `omni` wholesaler row described above.

## Known gaps / explicitly not done in this batch
- Clients, orders, catalogs, requests: real data exists in `wholesale_state.doc` for these (2 clients, 3 orders, catalogs, 1 signup request) but migrating them is scoped to Batches 2/3/5 per the batch plan, not done here.
- `pg_partman` for automatic monthly partition rollover on `v2_inventory_movements` is not installed/configured — only the first partition (Aug 2026) exists. Flagged in the original schema's own comments as a later step, not regressed here.
- `v2_stock_reservations` and the webhook tables intentionally have no read policy yet (deny-all) — real per-buyer reservation scoping needs actual auth (Batch 14); webhooks have no consumer yet (Batch 12). Documented in the hardening migration's own comments, not an oversight.

## Status: DONE. Migration verified byte-accurate against source. Zero regressions to v1. Security advisor re-run clean for everything in this batch's scope. Proceeding to Batch 2 (Buyer module).
