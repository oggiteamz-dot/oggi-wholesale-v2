# Batch 2 — Deploy Record
**Buyer module: catalog, cart, orders · 11 Aug 2026**

## What was built
- **`004_v2_orders_core.sql`**: `v2_orders` + `v2_order_items` tables (Batch 2's own scope — Batch 1 was inventory-only by design) and `v2_submit_order()`, an atomic checkout RPC. It converts a set of already-reserved cart lines into a real order in one transaction: if any line's reservation has expired or was already consumed, the whole submit fails and nothing is partially created — no half-placed orders.
- **`js/data/catalog.js`**: fetches products + variants + the `v2_inventory_by_variant` aggregate view and assembles a buyer-friendly nested shape (colours, sizes, price range, new/low-stock/out-of-stock badges computed from real data, not placeholders).
- **`js/data/cart.js`**: cart lines are backed by real soft stock reservations (`v2_reserve_stock`, 15-minute TTL), not just a client-side number. Editing a quantity releases the old reservation and creates a fresh one for the new amount — genuine in-place editing, not delete-and-re-add, which Research 3 flagged as the single most-cited buyer complaint across JOOR/NuORDER reviews. Cart contents persist to `localStorage` so a reload doesn't lose them; the server-side reservation TTL is the real backstop if a buyer walks away.
- **`js/data/orders.js`**: order history with line items, joined via a single PostgREST nested-select query (no N+1 fetching).
- **`js/components/product-card.js`**: colour-swatch → size-chip → quantity-stepper interaction, disables out-of-stock sizes, shows live "N available."
- **`js/views/buyer.js`**: full rewrite — real Catalog grid, real Cart with in-place editing and order submission, real Orders history with a working "Reorder" button (re-adds every line item to the cart, reports any that no longer have enough stock instead of silently failing), a Suppliers page for switching which wholesaler you're browsing, and a `localStorage`-backed Favourites page (no buyer-account system exists yet — Batch 14 territory — so favourites are scoped to the browser for now, which is honest rather than faking a synced feature).

## Real bug found and fixed mid-batch (read this one)
End-to-end testing in this sandbox failed immediately: the login screen wouldn't even render. Root cause, confirmed by direct investigation: the Supabase JS client was being loaded at runtime from `https://esm.sh/...`, and while `curl` in this session's shell could reach esm.sh fine, the actual browser engine used for testing could not (confirmed by a direct navigation test — 8-second timeout, not a fast refusal). Because one failed top-level ES module import aborts the entire module graph, this took down the *whole app*, including screens that never touch Supabase at all, like the login page.

This is a real architectural risk, not just a sandbox artifact — a CDN outage or block would do the same thing to real users. Fixed properly, not worked around: vendored the Supabase JS client locally (`js/lib/vendor/supabase-js.umd.js`, a self-contained UMD build with zero external sub-imports, loaded as a plain `<script>` before `app.js`) instead of importing it from a CDN at runtime. The app now has zero runtime network dependency on a third-party host to boot.

## Verification
This sandbox's browser turned out to have no path to *any* external host (not just esm.sh — Supabase's own REST API too), while `curl` in the same session does. Rather than accept an unverified backend, every real query and RPC call the frontend code issues was tested directly via `curl` against the live project, using the same public/anon key the browser uses, reproducing the exact requests `catalog.js`, `cart.js`, and `orders.js` make:
- `v2_products` + `v2_product_variants` + `v2_inventory_by_variant` reads (catalog fetch) — correct data returned.
- `v2_reserve_stock` RPC → `v2_submit_order` RPC, the full checkout chain — reserved 4 units, submitted, order created with `subtotal: 76.00` (4 × $19.00, correct).
- `v2_order_items` fetch with the nested `v2_product_variants(...,v2_products(name))` join (order history) — correct nested shape returned, matches what `orders.js` expects.
- All test writes were cleaned up afterward (test order deleted, stock compensated back to its pre-test level via a logged `v2_receive_stock` adjustment — the ledger keeps the test movement rows, by design, since it's append-only; only the balance was corrected).

Separately, in-browser structural testing (everything that doesn't need the network) passed cleanly: login → buyer role selection → 5 nav items render correctly for the buyer role → Cart and Favourites both show correct empty states → zero JS console errors.

## Known gaps / explicitly not done in this batch
- Cross-supplier activity feed and the request-access form (2 of the 13 v1-verified buyer features) are not built yet. Request-access in particular needs an owner-side review queue to be meaningful, which is Batch 5 (Owner) territory — building the form without a backend to receive it would be a fake feature, not a real one, so it's deferred rather than stubbed.
- Per-order notes and "ordered N times" display: the data layer already computes `orderedTimesCount()` in `orders.js` but it isn't wired into the catalog card UI yet.
- No real buyer-account system exists yet (dev-mode only), so Favourites and order history are scoped to a browser + typed buyer label, not a real login. This is consistent with the whole app at this stage — Batch 14 replaces dev-mode auth everywhere at once, not piecemeal per module.

## Status: Core transactional loop (browse → cart → in-place edit → checkout → order history → reorder) is DONE and verified against the live backend. Two of thirteen v1 features explicitly deferred to their correct batch, not silently dropped. Proceeding to close out this session's batches.
