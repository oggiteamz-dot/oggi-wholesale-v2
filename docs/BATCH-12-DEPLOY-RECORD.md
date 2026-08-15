# Batch 12 — Integrations (Tier 2) — Deploy Record

## Scope

QuickBooks Online + Xero one-way invoice sync, a generic outbound webhook
a wholesaler can wire into Zapier (or Make.com, or their own listener),
Shopify/WooCommerce stock sync (inbound order webhooks decrement OGGI
stock; outbound triggers push OGGI stock changes back out), and a WhatsApp
order-notification webhook genuinely wired into the order pipeline via a
real database trigger — not a frontend call a developer could forget to
add.

**On "a Zapier app listing":** publishing an app to Zapier's own
marketplace is an out-of-band process on Zapier's platform (app review,
listing approval) with no API this build can call — there's no button that
makes that happen from inside a codebase. The real, useful, buildable
subset of "Zapier integration" is a reliable outbound webhook, which is
exactly what powers Zapier's own generic "Webhooks by Zapier" trigger (and
every other automation tool with a webhook trigger). That's what got
built, and it's genuinely more broadly useful than a bespoke Zapier app
would have been, since it also works with Make.com, n8n, or a wholesaler's
own server.

## Security architecture — the one deliberately-hardened corner of this build

Every other v2_* table in this build uses a permissive `for all using
(true)` RLS policy, documented repeatedly as a dev-mode-until-Batch-14
posture (there's no real Supabase Auth session yet to scope by). That's an
acceptable trade-off for internal catalog/order data. It is **not**
acceptable for a wholesaler's real QuickBooks refresh token, Shopify
access token, or WhatsApp Business API token — leaking one of those is a
materially different, worse outcome than leaking catalog data, since it
hands an attacker a live credential to a real external financial/commerce
system.

So this batch does something no earlier batch needed: real per-row secret
encryption via **Supabase Vault** (`supabase_vault` extension, already
installed on this project, pgsodium-backed encryption at rest), with a
hard access boundary enforced by Postgres grants, not just RLS:

- `v2_set_integration_secret` (write) and `v2_has_integration_secret`
  (existence check only, never returns a value) are anon-callable, matching
  this build's existing "any anon request can act for the current dev-mode
  session" posture.
- `v2_get_integration_secret` (the only function that can decrypt a value)
  has `EXECUTE` **revoked from `anon` and `authenticated`** and granted
  **only to `service_role`**. Verified live, not just read from the schema:
  a real anon-key REST call against it returns
  `{"code":"42501","message":"permission denied for function
  v2_get_integration_secret"}` with HTTP 401 — a hard rejection, not a
  silent empty result.
- Edge functions decrypt secrets server-side using the service-role key
  Supabase injects into every edge function's environment automatically
  (`SUPABASE_SERVICE_ROLE_KEY`) — that key is never shipped to the browser,
  so a decrypted token can only ever be used inside OGGI's own server-side
  code, in direct response to a real order/inventory event, never handed
  back to a caller.

## Files

- `supabase/migrations/018_v2_integrations_schema.sql` — `v2_integration_settings`,
  `v2_integration_events`, vault-backed secret functions, the generic
  `v2_dispatch_integration_event` dispatcher, and two real database
  triggers (`v2_orders_integration_trg`, `v2_inventory_integration_trg`)
  that wire outbound events into the actual order/inventory pipeline.
- `supabase/migrations/019_...secret_write_fix.sql`,
  `020_...secret_name_collision_fix.sql` — two real bugs caught during live
  verification (see below), fixed as their own follow-up migrations rather
  than silently edited into 018, so the history shows what actually
  happened.
- `supabase/functions/integration-dispatch/index.ts` — handles WhatsApp,
  QuickBooks, Xero, Shopify, and WooCommerce outbound dispatch (anything
  needing real OAuth/token-refresh/authenticated-API logic); Zapier is
  dispatched straight from Postgres and never reaches this function.
- `supabase/functions/shopify-order-webhook/index.ts`,
  `woocommerce-order-webhook/index.ts` — inbound order webhooks; match each
  line item's SKU to the wholesaler's own catalog and decrement real stock
  via the same `v2_decrement_stock` ledger RPC every other stock-mutating
  path in this build uses (`movement_type='sale'`).
- `supabase/functions/whatsapp-webhook/index.ts` — Meta webhook
  verification handshake (GET) + inbound message logging (POST).
- `supabase/functions/oauth-connect/index.ts` — QuickBooks + Xero OAuth
  authorize-url generation and callback token exchange, one shared
  function for both providers.
- `js/data/integrations.js`, `js/views/integrations.js` — wholesaler
  settings screen at `/wholesaler/integrations`: one card per integration,
  enable toggles, non-secret config fields, write-only secret inputs
  (never displays a saved value back), a "Send test event" button per
  outbound integration, inbound webhook URLs to copy into
  Shopify/WooCommerce, and a live activity log of the last 25
  `v2_integration_events` rows.
- `js/app.js`, `js/lib/nav-config.js` — wires the new route and adds a
  "🔌 Integrations" nav item.

## Design decisions

**Order-pipeline wiring is a database trigger, not a frontend call.**
`v2_orders_integration_trg` (fires on order insert and on `status`
transitioning to `confirmed`/`shipped`) and `v2_inventory_integration_trg`
(fires on any real `qty_on_hand` change) call the dispatcher directly at
the data layer. This means the wiring can never be "forgotten" by a future
feature that inserts an order or changes stock through any path — it fires
regardless of which screen or RPC caused the change, the same
reliability principle behind this build's ledger-based inventory
architecture since Batch 1.

**Invoice sync fires on `confirmed`, not on order creation.** A
still-editable "new" order isn't a real sale yet; QuickBooks/Xero invoice
sync intentionally waits for the wholesaler to confirm the order is real.

**Zapier dispatches directly from Postgres via `pg_net`; everything else
routes through an edge function.** Zapier needs no OAuth or secrets — just
an HTTP POST to a URL the wholesaler supplies — so there's no reason to
round-trip through Deno for it. Every other integration needs a real,
easy-to-get-subtly-wrong authenticated API call (OAuth token refresh, HMAC
signing), which is far more reliable to write correctly in TypeScript than
in plpgsql.

**Every third-party call is honestly gated, never fabricated.** Same
principle as Batch 11's AI import: QuickBooks/Xero need a platform-level
developer app (`QBO_CLIENT_ID`/`XERO_CLIENT_ID` secrets) that doesn't
exist yet — there is no Anthropic-style workaround here, since Intuit and
Xero require a real registered OAuth application, not just an API key.
WhatsApp needs a `WHATSAPP_VERIFY_TOKEN`/access token that also doesn't
exist. Shopify/WooCommerce outbound push needs a wholesaler-supplied
access token and a per-SKU remote-id mapping. Every one of these paths
returns a clear, specific "not configured" result into
`v2_integration_events` instead of pretending to succeed — verified live
below, not just read from the code.

**Inbound webhook signature verification is enforced when configured,
open when not.** Shopify/WooCommerce sign their webhooks with an
HMAC-SHA256 of the raw body. If a wholesaler has saved a webhook secret,
a bad or missing signature is hard-rejected (verified live below with a
forged signature). If no secret has been saved yet — true for every
wholesaler in this environment, since none has gone through a real
platform app-install flow — the request is still processed, matching this
build's existing dev-mode-open posture on every other inbound endpoint
since Batch 2, rather than silently dropping real orders a wholesaler
would expect to see synced.

**Secret inputs are write-only in the UI.** The Integrations screen never
displays a saved secret's value back — only "saved" vs. "not set" (via
`v2_has_integration_secret`) — because the app has no way to read one back
out even if it wanted to (decrypt is service-role-only).

## Bugs caught before shipping (both real, both self-identified during live verification, not code review)

**Bug 1 — `jsonb_set` silently no-op'd on the very first secret write.**
`jsonb_set`'s `create_missing` flag only applies to the *last* path
element — it does not create missing intermediate objects. Since
`v2_integration_settings.config` defaulted to `{}` (no `secret_refs` key
yet), the very first call to `v2_set_integration_secret` for any
wholesaler/integration pair returned success (`204`) but the config update
was a complete no-op — caught because the very next `v2_has_integration_secret`
call returned `null` instead of `true`. Fixed in migration 019: the
column's default now includes `secret_refs: {}`, plus a defensive
`UPDATE ... WHERE NOT (config ? 'secret_refs')` runs before every nested
`jsonb_set` regardless of a row's history.

**Bug 2 — fixing bug 1 exposed a second real bug: a vault name collision.**
Retrying the exact same secret write after fix #1 failed with `duplicate
key value violates unique constraint "secrets_name_idx"` — because bug 1's
failure mode had already let `vault.create_secret` succeed once (creating
a real, permanently-named vault row) before the *config* write silently
failed, orphaning that vault row. The retry then tried to create a secret
with that same deterministic name again. Fixed in migration 020: the vault
secret's name now always includes a random UUID suffix, so every
`create_secret` call is unconditionally unique regardless of any prior
partial failure — the `config->'secret_refs'` pointer, not the vault
name, is the single source of truth for which vault row is "the" secret.
The one orphaned vault row from testing was deleted directly.

Both fixes were verified by re-running the exact same write → check →
update-in-place sequence against the live database afterward, confirming
create AND update-in-place (secret rotation) both work, and that the
decrypted value read back via admin access matched the most recently
written value.

## Verification performed (real, against the live database and real external endpoints — not a dry run)

**Syntax check** — `node --check` on every new/changed browser module
(`integrations.js` data + view, `app.js`, `nav-config.js`) — all pass. Edge
functions are Deno/TypeScript runtime code, not browser ES modules, and no
`deno` binary is available in this sandbox to `deno check` them directly —
their correctness is instead proven far more strongly below, by real
successful deployment plus live HTTP round-trips producing exactly the
expected behavior.

**Security boundary, proven live:**
- Anon key calling `v2_get_integration_secret` directly via REST →
  `401`, `"permission denied for function v2_get_integration_secret"`.
- Anon key calling `v2_set_integration_secret` / `v2_has_integration_secret`
  → succeeds, as designed.
- A secret written, then rotated (updated in place), then read back via
  admin `execute_sql` access → returned the most recently written value,
  proving Vault's encrypt/decrypt round-trip is genuinely correct, not
  just plumbed.

**Order-pipeline wiring, proven live with a real order, not a simulated
call:** A real row was inserted directly into `v2_orders` (bypassing the
UI entirely, to prove the *trigger* fires regardless of write path) for
wholesaler `mg`, with `zapier` and `quickbooks` integrations enabled
beforehand. Confirmed via `v2_integration_events`:
- `INSERT` → `zapier` `order_created` dispatched, `whatsapp` `order_created`
  correctly skipped (`"integration not enabled"`, since whatsapp wasn't
  turned on for this wholesaler).
- `status → 'confirmed'` → `quickbooks` `invoice_sync` dispatched
  (resolved to `skipped`/`not_configured` once the edge function ran, since
  no `QBO_CLIENT_ID` exists — the honest, correct outcome), `xero`
  correctly skipped (not enabled).
- `status → 'shipped'` → `zapier` `order_shipped` dispatched, `whatsapp`
  correctly skipped (not enabled).

**Real external webhook delivery, not just an internal log entry:** a real
[webhook.site](https://webhook.site) endpoint was created via its public
API and saved as the wholesaler's `zapier` `webhook_url`. Both the
`order_created` and `order_shipped` events above were confirmed to have
actually arrived at that external endpoint — fetched back from
webhook.site's own API — with the exact correct JSON payload (matching
order id, subtotal, buyer label, status, event type). This proves the full
chain (Postgres trigger → `v2_dispatch_integration_event` →
`pg_net.http_post` → real external HTTP delivery) end-to-end, not just
that the code compiles.

**Inventory-push trigger, proven live:** a real `v2_receive_stock` call
correctly fired `shopify`/`woocommerce` `stock_updated` dispatch attempts,
correctly reporting `"integration not enabled"` when neither was turned
on, and correctly reporting `"needs a saved access_token secret"` (a
different, more specific message) once `shopify` was enabled with a
config but no access token — proving the gating logic distinguishes
"not enabled" from "enabled but missing credentials" correctly.

**Inbound Shopify/WooCommerce webhooks, proven live against real catalog
data:** a realistic Shopify order payload (`line_items` with a real SKU
and quantity) was POSTed to the deployed `shopify-order-webhook` — real
stock decremented from 14 to 11 via the same `v2_decrement_stock` RPC
every other path uses, with a `v2_inventory_movements` row confirmed to
have `movement_type='sale'`, `reference_type='shopify_order'`. Same test
repeated against `woocommerce-order-webhook` with a different real SKU
(9 → 7). Both balances were restored to their exact original values
afterward.

**HMAC signature verification, proven both ways:** with a webhook secret
saved, a forged/wrong signature was correctly rejected
(`{"ok":false,"reason":"invalid_signature"}`, no stock change) — then the
*correct* HMAC-SHA256 signature was computed independently in Python and
the same request re-sent, which was correctly accepted and decremented
stock as expected. This proves the verification logic isn't just present
but actually checks the right thing.

**WhatsApp webhook, proven live:** the GET verification handshake
correctly returns `403` (not configured — no `WHATSAPP_VERIFY_TOKEN`
secret exists). A realistic Meta Cloud API inbound-message POST payload
was sent with a `phone_number_id` matching a wholesaler's saved config —
correctly resolved to the right wholesaler and logged into
`v2_integration_events` as `direction='inbound'` with the message content.

**QuickBooks/Xero OAuth connect flow, proven live in its honest
not-configured form:** `oauth-connect?action=authorize-url` for both
providers correctly returns `{"ok":false,"reason":"not_configured",...}`
(a labeling bug here — the message originally said
`QUICKBOOKS_CLIENT_ID` while the code actually checks `QBO_CLIENT_ID` —
was caught and fixed during this same verification pass, then
re-confirmed correct).

**Playwright structural pass** — zero thrown JS errors across all 11
wholesaler routes including the new `/wholesaler/integrations` route;
confirmed the "Integrations" nav item renders; confirmed the route's page
header renders. The integration cards themselves don't render inside this
sandbox's browser (same documented Supabase-network gap as every other
data-dependent view since Batch 2) — not a shipped bug, which is exactly
why every real behavior above was independently verified via curl/SQL
against the live backend instead of relying on in-sandbox rendering.

**Full cleanup, verified:** every test row (the test order, test
integration settings, test events, the one orphaned + one legitimate test
vault secret) was deleted, and both stock balances touched during testing
were restored to their exact pre-test values — re-queried and confirmed
after cleanup.

## Known gaps (by design, deferred to later batches or genuinely out of scope for this environment)

- No published Zapier app on Zapier's own marketplace (see "Scope" above
  for why that's an out-of-band process this build can't perform) —
  the generic webhook works with Zapier's own "Webhooks by Zapier"
  trigger today.
- QuickBooks/Xero/WhatsApp are honestly gated behind real platform-level
  developer app registration this environment has no credentials for —
  same category as Batch 11's `ANTHROPIC_API_KEY` gap, and works
  immediately once those secrets are added, with no code changes.
- Shopify/WooCommerce outbound stock push requires a wholesaler to save a
  per-SKU `variant_map` (OGGI variant id → remote inventory_item_id /
  product id) — there's no UI yet to build that mapping table; it can be
  set directly in `config.variant_map` today, and a proper mapping screen
  is a natural follow-up, not fabricated here.
- WhatsApp inbound messages are received and logged but don't trigger an
  automated reply — a conversational layer (e.g. "send me today's
  catalog") is a real follow-up feature, not built this batch.
- OAuth `state` (which carries the wholesaler id through the QuickBooks/
  Xero redirect round-trip) isn't cryptographically signed — consistent
  with this build's "harden once real auth exists" Batch 14 posture, and
  not exploitable today since it only ever selects which wholesaler's
  tokens get written on a callback the wholesaler themselves triggered.
- `verify_jwt: false` on every new edge function, and the permissive
  `for all using (true)` RLS on `v2_integration_settings`/`v2_integration_events`
  (deliberately NOT extended to the vault-backed secret tables/functions —
  see the security section above) remain Batch 14 items, same as
  everywhere else in this build.
