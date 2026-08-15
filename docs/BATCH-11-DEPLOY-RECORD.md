# Batch 11 — Migration & Onboarding Tools — Deploy Record

## Scope

Gives a wholesaler two independent ways to bulk-load or update their catalog
without hand-entering every SKU, feeding into ONE shared preview/review/commit
pipeline so nothing is ever written silently:

1. **CSV import** — upload a file or paste CSV text. Real quoted-field-aware
   parsing (not `.split(',')`), duplicate detection (existing SKU updates
   attributes only; existing product name adds a variant; new name creates a
   product; in-file duplicate SKUs are flagged as errors, not silently
   overwritten).
2. **AI-assisted photo/PDF import** — upload a photo of a price list or a PDF
   catalog page; a genuinely deployed Supabase Edge Function
   (`extract-catalog-from-image`) calls Anthropic's Messages API server-side
   (using a wholesaler-supplied `ANTHROPIC_API_KEY` secret) to extract rows in
   the exact same shape the CSV path produces, so it flows through the same
   preview/commit code — one review-before-commit flow, not two.

No new database tables were needed — this batch is entirely an ingestion
layer over the existing `v2_products`/`v2_product_variants`/inventory RPCs
built in earlier batches, so there is no new migration file this batch.

## Files

- `js/data/csv-import.js` — `parseCsv`, `planImport`, `commitImport`.
- `js/data/ai-catalog-import.js` — `extractCatalogFromImage`, normalizes the
  edge function's response into the exact row shape `planImport` expects.
- `js/views/import-catalog.js` — `/wholesaler/import` screen; two entry
  sections (CSV, AI photo/PDF) sharing one `renderPreview()` helper.
- `supabase/functions/extract-catalog-from-image/index.ts` — Deno edge
  function, deployed with `verify_jwt: false` (consistent with this whole
  build's dev-mode-until-Batch-14 posture — see Known Gaps).
- `js/app.js` — wires `registerImportRoutes(router)`.
- `js/lib/nav-config.js` — adds "Import Catalog" (⬆️) to the wholesaler nav,
  between "Scan to Receive" and "Settings".

## Design decisions

**No true binary `.xlsx` parsing.** Excel's `.xlsx` format is a zipped XML
bundle; parsing it correctly (shared-string tables, multiple sheets, styled
cells) needs a real dependency, and pulling one in this late in an unattended
build — with no way to sanity-check it against a live wholesaler's real file
— was judged riskier than the honest workaround: every spreadsheet tool
(Excel, Google Sheets, Numbers, LibreOffice) has a native "Save/Export as
CSV," so CSV is the supported path and the UI says so explicitly rather than
silently failing on an `.xlsx` upload.

**AI import never fabricates data.** This build has no Anthropic API key of
its own to give a wholesaler, and hardcoding one — or faking an extraction
response to *look* like it worked — would be actively dishonest. The edge
function checks for a wholesaler-supplied `ANTHROPIC_API_KEY` secret at
request time and returns a clear, actionable `{ok:false, reason:"not_configured", message:...}`
when it's absent (verified below — this is the current, honest, real state).
The moment a wholesaler adds their own key in Supabase's dashboard (Project
Settings → Edge Functions → Secrets), the same deployed code starts doing
real extraction with zero further changes needed.

**Both images AND PDFs, natively.** The edge function branches on
`mimeType === "application/pdf"` and uses Anthropic's `document` content
block (native PDF understanding) rather than rasterizing a PDF page to an
image as a workaround — genuinely handles both input kinds the function's
UI promises.

**Stock is only ever received on a brand-new SKU.** `commitImport`'s
`on_hand_qty` column is applied via `v2_receive_stock` ONLY when creating a
variant for the first time — re-importing a file that includes an existing
SKU updates its price/cost/MOQ/retail/barcode but never touches stock. This
is deliberate: an importer that also tried to "sync" stock on every re-run
would silently double-count inventory the moment the same file (or an
updated export containing old rows) was imported twice.

**Shared preview pipeline.** Both CSV and AI-photo paths funnel into the
same `planImport()` → `renderPreview()` → `commitImport()` chain. A
wholesaler always sees a full per-row breakdown (new product / new variant on
an existing product / update to an existing SKU / error) and an explicit
"Commit N row(s)" button before anything is written — there is no
auto-commit path from either entry point.

## Bugs caught before shipping (self-identified during code review)

**Cross-tenant SKU-collision risk (real, fixed).** The first draft of
`commitImport`'s `update_variant` action updated a matched row via
`.eq("sku", row.sku)` — a bare SKU string match with no further scoping.
SKU uniqueness is only enforced within a single wholesaler's own catalog (no
global-uniqueness constraint across every wholesaler on the platform), so a
sufficiently common SKU string could, in theory, collide with a *different*
wholesaler's SKU and silently overwrite their row from someone else's
import. Fixed by having `planImport` resolve and carry the real
`existingVariantId` (the actual primary key, captured from the query already
scoped to `wid`'s own products during duplicate detection) and having
`commitImport` update `.eq("id", row.existingVariantId)` instead of ever
matching on the mutable, non-globally-unique SKU string. Verified via the
live test below (Row A) — the update reliably targets one specific row by
primary key.

## Verification performed (real, against the live database — not a dry run)

**Syntax check** — `node --check` (ESM-shim pattern) on every new/changed
browser module: `csv-import.js`, `ai-catalog-import.js`, `import-catalog.js`,
`app.js`, `nav-config.js` — all pass. (The edge function is Deno/TypeScript
runtime code, not a browser ES module, and was reviewed directly rather than
run through `node --check`.)

**Pure-logic unit tests** (`parseCsv`, `planImport`'s action-resolution and
duplicate-detection branching) — run directly in Node against the real
module with a minimal fake Supabase client returning fixed existing-catalog
data, asserting real computed results:
- Quoted CSV fields with embedded commas and escaped `""` quotes parse
  correctly (not a naive `.split(',')`).
- An existing SKU resolves to `update_variant` with the correct
  `existingVariantId`/`existingProductId`.
- A new SKU on an existing product name resolves to `add_variant` against
  the correct `existingProductId`.
- A brand-new product name resolves to `create_product`.
- An in-file duplicate SKU is flagged as an `error` row (not silently
  processed twice).
- A row missing `product_name` and `price` is flagged with both specific
  error messages.
- A CSV missing a required header (`color`, `size`, `price`) is rejected
  up front with a clear message, before any row-level work happens.
- All assertions passed with no `FAIL` lines.

**Live end-to-end verification against the real database** (wholesaler
`mg` / Milano Garments), replicating `commitImport`'s exact REST/RPC call
shapes via curl (this sandbox's browser cannot reach Supabase's REST/RPC
endpoints directly — the same confirmed network-policy gap documented since
Batch 2 — curl can):
- **`update_variant`**: PATCH by `existingVariantId` on a real existing SKU
  (`KN-330-MidnightBlue-38`) correctly updated price/cost/moq/barcode and
  left every other column (including the SKU itself and `extra_attrs`)
  untouched.
- **`add_variant`**: POST a new SKU with an existing product's id correctly
  created a new variant attached to that product, not a duplicate product.
- **`create_product`**: POST created a new product, then a variant under
  its real returned id, then a real `v2_receive_stock` RPC call for the
  `on_hand_qty` — confirmed via `v2_inventory_balances` (qty_on_hand: 5) and
  `v2_inventory_movements` (one real `receive` row,
  `reference_type: "catalog_import"`) that stock was correctly created
  through the SAME ledger-based RPC every other stock-adding path in this
  build uses, not a second inventory-mutation path.
- **Cleanup**: all three test rows were reverted/deleted after verification.
  The `update_variant` test target was PATCHed back to its exact original
  values. The two newly-created test variants and the test product hit the
  same silent-no-op-on-DELETE RLS characteristic already documented in the
  Batch 10 record (`v2_product_variants`/`v2_products` DELETE via the
  anon/publishable key returns success but deletes nothing because there is
  no anon `DELETE` RLS policy) — cleanup was completed via the Supabase MCP
  admin `execute_sql` path instead, and the final state was re-queried and
  confirmed byte-identical to the pre-test state (same 2 products for `mg`,
  the modified variant's row values restored exactly).

**Edge function verification** — real curl calls against the deployed
function: `OPTIONS` preflight returns `200 ok`; a `POST` with real body
shape correctly returns the honest
`{ok:false, reason:"not_configured", message:"AI-assisted import isn't set up yet..."}`
response (confirmed this is the true current state — no Anthropic API key
exists for this project, and none is hardcoded anywhere in this codebase).

**Playwright structural pass** (own sandbox Chromium against
`python3 -m http.server`, dev-mode session in `localStorage`) — zero thrown
JS errors (`pageerror` + console `error` listeners) across all 10 wholesaler
routes and all 3 buyer routes, including the new `/wholesaler/import` route;
confirmed the new "Import Catalog" nav item renders in the sidenav; confirmed
the import route's page header renders correctly. The CSV/AI-photo sections
inside the import view do not render inside this sandbox's browser, because
`importCatalogView` awaits a real `getLocations()` Supabase call before
building them, and this sandbox's Chromium cannot reach Supabase's REST
endpoint (same documented gap as every other data-dependent view in this
build back to Batch 2) — this is a sandbox-only limitation, not a shipped
bug, and is exactly why the logic itself was independently verified against
the live database via curl above rather than relying on in-sandbox
rendering.

## Known gaps (by design, deferred to later batches)

- No true `.xlsx` binary parsing — CSV export is the supported workaround
  (see Design decisions above).
- AI-assisted import requires the wholesaler to supply their own
  `ANTHROPIC_API_KEY` Supabase secret; until then it honestly reports
  "not configured" rather than fabricating results.
- `verify_jwt: false` on the edge function and permissive anon-key RLS
  access remain consistent with this whole build's dev-mode-until-Batch-14
  posture — real Supabase Auth, RLS hardening, and turning `verify_jwt`
  back on are explicitly scoped to Batch 14 (Security & authentication),
  the last batch in the plan, alongside every other `for all using(true)`
  policy flagged throughout this build.
- No CSV column-mapping UI for files whose headers don't match the expected
  names exactly (case-insensitive exact match only) — a wholesaler with a
  differently-named export would need to rename headers first.
