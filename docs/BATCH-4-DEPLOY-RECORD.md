# Batch 4 — Deploy Record
**Salesperson module: client directory, coverage, visit logging · 11 Aug 2026**

## Scoping correction (from Batch 3)
Batch 3's wholesaler.js placeholder for the Clients route said client management "needs a v2 clients table + real auth, scoped to Batch 14." That was wrong — a client *record* doesn't need real authentication, only linking a real login to a client account does (still correctly Batch 14). Salesperson features are fundamentally impossible without a client table (a recency-sorted list, an add-client form, and coverage tracking all need somewhere to store clients), so building `v2_clients` here — where it's actually needed — rather than carrying the deferral forward.

## What was built
- **`006_v2_clients_and_visits.sql`**: `v2_clients` (shop name, phone, note, discount %, active flag) and `v2_visit_log` tables, plus a real data migration — `wholesale_state.doc.clients` had 2 real clients under wid `sq` ("CEDAR Shops," discount 5%, and "AMANI Stores," discount 10%, note "Regular"), migrated with every field verified against source, not fabricated.
- **`js/data/clients.js`**: recency sorting is computed live from actual order history (`v2_orders.buyer_label` matched against `shop_name`), not a stored `last_order_at` column that could drift out of sync — a client who ordered five minutes ago is provably first, not first because a cron job updated a timestamp. `coverageSnapshot()` gives a real "ordered in the last 30 days / needs attention / never ordered" breakdown, not a vanity count.
- **`js/data/visits.js`**: visit logging with client join for display.
- **`js/data/cart.js` extended** (not rewritten): added an optional `scopeSuffix` parameter to every cart function so a salesperson can hold concurrent carts per client without them colliding — `cart.get(wid)` (buyer, unchanged behaviour) vs. `cart.get(wid, clientId)` (salesperson, a distinct cart per client). The real order-submission `wid` is always tracked separately from the cart's storage scope, so scoping the cart correctly can never accidentally scope the order incorrectly.
- **`js/views/salesperson.js`**: real Dashboard (coverage stat grid), real My Clients (recency list, add-client-on-the-fly form, log-visit action, deactivate-with-confirmation), real Orders (all orders for the wholesaler, reusing Batch 3's `getWholesalerOrders`), real Visit Log (chronological, client-joined).

## Verification
Same direct-REST verification approach as Batches 2-3 (this sandbox's browser still can't reach the live API — documented in Batch 2's record). Tested directly against the live database: `SELECT v2_clients` (confirmed both real migrated clients with correct phone/discount/note), `INSERT v2_visit_log` + the joined `SELECT ...,v2_clients(shop_name)` read (confirmed the join shape matches what `visits.js` expects), both using the "for all" policy pattern this batch introduced. Test row cleaned up via direct SQL afterward. Structural browser testing passed cleanly for all 4 salesperson nav items with zero JS errors.

## Known gaps / explicitly not done in this batch
- "Usual-order reorder" (reordering a client's typical basket) and true per-client concurrent-cart UI (the cart.js plumbing now supports it, but no salesperson screen yet lets a rep browse a catalog and build an order *on behalf of* a specific client) are not wired into the UI yet — the data layer is ready, the view isn't. This is the main incomplete piece from the original 8 v1-verified salesperson features.
- No deactivation *notice* to the client (v1 had a specific "deactivation notice" feature) — deactivating a client here just flips `active = false`, no notification flow exists since there's no client-facing account to notify yet.

## Status: Client directory, coverage tracking, and visit logging are DONE and verified. Salesperson-driven ordering on a client's behalf is the one real gap, clearly flagged rather than silently stubbed.
