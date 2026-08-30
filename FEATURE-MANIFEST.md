# Feature Manifest — OGGI Wholesale v2

**Last reconciled: 30 August 2026** (previous: 15 August — six days and seven
batches out of date, which is the problem this rewrite exists to stop repeating.)

One row per shipped feature, naming **the file it lives in** and **the assertion
that proves it still works**. This is the answer to "how do we never lose a
feature again."

`checks/check_manifest_is_honest.mjs` now checks this file against the `checks/`
directory in both directions, so a check named here that does not exist, or a
check that exists and is not named here, is a failure rather than a slow drift.
A document nothing verifies goes stale, and this one had.

## How to use it

Before and after any rewrite, migration, or significant change:

1. Run every check in `checks/`.
2. Compare the counts below. **The number of features must never go down
   silently.** If it does, that is the finding — not a detail to fix later.
3. If a feature is deliberately removed, delete its row *in the same commit*
   with the reason in the message. A feature that disappears from the code but
   stays in this table is a lie; a feature that disappears from both without a
   commit message is the exact failure this file exists to prevent.

## Why "file + assertion" and not just a list

Both real losses in this product were invisible to name-matching:

- The **2.0 rewrite dropped the colour × size axis.** Function names were all
  still there. The loss lived in the *shape of a record*.
- The **selling models survived migration as data and were then ignored by the
  code.** Every name still present, the data still correct, the behaviour gone.

A third kind was found on 21 August, and it is worth adding because it is the
one a manifest is least likely to catch: **the buyer's product card rendered no
`<img>` at all, from Batch 2 to Batch 19**, while `js/data/catalog.js` fetched
the photography on every request and discarded it one line later. Nothing was
named wrong. Nothing was shaped wrong. A feature was simply never wired to a
screen, and no row in any table said "and it is visible".

So a manifest row is only worth something if the "proven by" column names a
check that fails when the behaviour goes, not when a name changes.

**Status key:** ✅ enforced and gated · ⚠️ present, nothing would tell you if it
broke · ❌ not built

---

## Ordering rules — the things that make this wholesale, not retail

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 1 | Per-SKU minimum order quantity | `migrations/009,010` | `check_pack_moq.sh` — "honest order below the SKU minimum" | ✅ |
| 2 | Product-level minimum across colours/sizes | `migrations/010` | `check_pack_moq.sh` — accepted/rejected cases | ✅ |
| 3 | Wholesaler order minimum (qty and value) | `v2_submit_order` | `check_data_invariants.sql` §6 | ✅ |
| 4 | Reorder minimums differ from first order | `v2_products.moq_reorder_qty` | *(no assertion yet)* | ⚠️ |
| 5 | **MOQ cannot be disabled by the client** | `migrations/028` | `check_pack_moq.sh` — 8 rejection cases | ✅ |
| 6 | **Minimum pieces per colour** | `migrations/063`, `v2_enforce_selling_model` | `check_size_ratios.sql`; surfaced to the buyer and asserted by `check_buyer_product_card.mjs` | ✅ |

## Selling models

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 7 | Open stock | `js/data/cart.js` | `check_pack_moq.sh` — "ordinary order meeting the minimum" | ✅ |
| 8 | Prepack / fixed carton | `migrations/011,012,030` | `check_pack_moq.sh` + `check_data_invariants.sql` §5 | ✅ |
| 9 | **Ratio pack** | `migrations/030,061` | `check_data_invariants.sql` §5, `check_size_ratios.sql` | ✅ |
| 10 | **Full series** | `migrations/029` | `check_data_invariants.sql` §5 — series pack completeness | ✅ |
| 11 | Fixed box | *(prepack covers this — a fixed carton per colour)* | see row 8 | ✅ |
| 12 | **Programmable reusable size ratios** | `migrations/061`, `js/data/size-ratios.js` | `check_size_ratios.sql` | ✅ |
| 13 | **Base unit — one press of + is N pieces** | `v2_products.base_unit`, `js/components/product-card.js` | `check_buyer_product_card.mjs` — "+ adds a whole unit" | ✅ |
| 14 | Flat pack price (`pack_price`) | `migrations/011` | **DECIDED 21 Aug (D4): stored, never charged.** `check_line_pricing.sql` sets it to 50.00 and asserts the order still comes to 96.00 | ✅ |
| 15 | **The selling model is visible on the card** — Ratio / Prepack / Full series badge, with a hover saying what it does to the buyer | `js/lib/selling-model.js`, `js/views/wholesaler.js` | `check_packs_panel_reachable.mjs` — the four badge assertions | ✅ |
| 16 | **Packs & ratios can be reached** — the editor opens as a viewport-fixed drawer, not appended below the grid | `js/views/wholesaler.js` (`openProductPanel`), `css/components.css` (`.pdrawer`) | `check_packs_panel_reachable.mjs` (22) | ✅ |
| 17 | **The ratio builder is actually reached** — a product with colours and sizes gets the builder, on Catalogs as well as Products | `js/data/catalogs.js` (`getCatalogProducts` returns `variants`) | `check_ratio_builder_gets_variants.mjs` (10) | ✅ |
| 18 | **Choosing a selling model opens its builder** — "Set ratios" / "Set prepacks" appears at the foot of the product form and says buyers cannot order it until it exists | `js/components/product-form.js`, `js/views/wholesaler.js` (`openSellingSetup`) | `check_selling_model_setup.mjs` (19) | ✅ |
| 19 | **A series builds its own pack** — trigger keeps it as every live variant, one each | `migrations/079` (`v2_sync_series_pack`) | `check_selling_model_setup.mjs` — the series assertions; `replay_migrations.sh` | ✅ |
| 20 | **Every CSS rule we write is a rule the browser keeps** — brace balance, plus the real parser's own count of what survived | `css/*.css` | `check_css_parses.mjs` (32) | ✅ |
| 21 | **A product with no variants can still be given a ratio** — the panel offers "Add colours & sizes" and returns to the builder | `js/views/wholesaler.js` (`renderRatioSection`) | `check_packs_panel_reachable.mjs` — the four dead-end assertions | ✅ |

> **All four selling models are enforced end to end** (migrations 029 and 030,
> 15 Aug 2026). Before that day, `extra_attrs.sellMode` was read once by
> `js/data/catalog.js` and never acted on: 37 variants across three wholesalers
> were declared ratio or series and sold as loose open stock. One simplification
> is recorded rather than hidden: v1's ratio mode let a buyer switch individual
> sizes off within the curve; here a ratio pack is the whole curve for a chosen
> colour.

## Pricing

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 22 | Quantity breaks (tiers), aggregated across colourways | `migrations/010`, `js/data/pricing.js` | `check_price_agreement.mjs` (23) + `check_catalog_pricing.sql` | ✅ |
| 23 | Per-client negotiated prices | `js/data/client-pricing.js`, `migrations/048,049` | `check_price_override_isolation.mjs` | ✅ |
| 24 | Catalog + customer discount, three modes | `migrations/053` | `check_catalog_pricing.sql`, `check_price_agreement.mjs` | ✅ |
| 25 | **The cart total equals the invoice total** | `js/data/line-pricing.js` | `check_line_pricing.mjs` (48) + `check_line_pricing.sql` (6, against production) | ✅ |
| 26 | **Bulk reprice: preview, atomic, undoable** | `migrations/078`, `js/data/pricing-bulk.js` | `check_bulk_price_safety.sql` (9) | ✅ |

## Catalogue and stock

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 27 | **Colour × size variants** | `v2_product_variants.extra_attrs` | `check_data_invariants.sql` §2 | ✅ |
| 28 | No duplicate (product, colour, size) | — | `check_data_invariants.sql` §2 | ✅ |
| 29 | Multi-location stock | `v2_inventory_balances` | `check_data_invariants.sql` §3 | ✅ |
| 30 | Reservations cannot exceed stock | `v2_confirm_reservation` | `check_data_invariants.sql` §3 | ✅ |
| 31 | **Expired cart holds never suppress real stock** | `migrations/064,065` | `check_reservation_expiry.sql` (6) + `check_no_stale_reserved_reads.sh` | ✅ |
| 32 | Stock transfers between locations | `migrations/047` | `check_locations_transfer.mjs` | ✅ |
| 33 | Pack integrity (components, same product) | `migrations/011` | `check_data_invariants.sql` §4 | ✅ |
| 34 | **The stock movement ledger is visible** | `migrations/071`, `js/views/wholesaler.js` movements pane | `check_movement_ledger.sql` (8) | ✅ |
| 35 | **Movement partitions run to 2029** | `migrations/074` | `check_movement_partitions.sql` (4) | ✅ |
| 36 | **Stock valuation, with its own coverage** | `migrations/072,073,075` | `check_valuation_and_dead_stock.sql` (8) | ✅ |
| 37 | **Dead stock requires evidence of age** | `migrations/075` | `check_valuation_and_dead_stock.sql` | ✅ |
| 38 | **Reorder points and breakouts, tunable** | `migrations/066,067,068`, `js/data/inventory-signals.js` | `check_intelligence_zero_setup.sql` (11) + `check_single_low_stock_threshold.sh` — one definition of the threshold, no copies | ✅ |
| 39 | **Barcode labels: generated, printable, readable** | `migrations/076`, `js/lib/barcode-ean13.js` | `check_barcode_roundtrip.mjs` (9) + `check_barcode_decode.mjs` (18) | ✅ |
| 40 | **The buyer's product card shows a photo** | `js/components/product-card.js` | `check_buyer_product_card.mjs` (45) | ✅ |
| 41 | Product images / 360 viewer | `migrations/021,040`, `product-hologram.js` | `check_image_downscale.mjs` (8) | ✅ |
| 42 | Barcode lookup / camera scan | `js/data/barcode-lookup.js` | `check_barcode_decode.mjs` | ✅ |
| 43 | Kit assembly | `migrations/015`, `js/data/kits.js` | *(no assertion yet)* | ⚠️ |
| 44 | Landed cost on receipt | `js/data/landed-cost.js` | *(no assertion yet)* | ⚠️ |
| 45 | Cycle counts on an ABC schedule | `js/data/inventory-intelligence.js` | *(no assertion yet)* | ⚠️ |
| 46 | Suppliers | `migrations/050`, `js/data/suppliers.js` | *(no assertion yet)* | ⚠️ |
| 47 | **Product creation with colour picker and photos** | `js/components/product-form.js` | `check_product_creation.mjs` | ✅ |
| 48 | **Editing a product saves what the form showed** | `js/views/wholesaler.js`, `js/components/product-detail.js` | `check_edit_saves_what_it_shows.mjs` (18) | ✅ |
| 49 | **The wholesaler's tile, and View that cannot edit** | `js/components/admin-product-tile.js`, `product-detail.js` | `check_product_cards_and_detail.mjs` (49) — the load-bearing case is that View contains no input, select or textarea anywhere | ✅ |
| 50 | **Inventory holds Stock, Products and Pricing rules** | `js/components/sub-tabs.js`, `js/views/wholesaler.js` | `check_inventory_panes.mjs` (27) | ✅ |

## Catalogs, clients, delivery

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 51 | **A catalog is a link you send** | `migrations/056` | `check_catalog_link_access.sql` | ✅ |
| 52 | **Customer tier gates who may open a link** | `migrations/053,055` | `check_buyer_catalog_access.sql` | ✅ |
| 53 | Catalog builder, picker, two add buttons | `js/views/wholesaler.js` catalogs | `check_catalog_builder.mjs` (44) | ✅ |
| 54 | Billboard + pinned highlight group | `migrations/057,058` | `check_billboard_and_highlights.mjs` (41) | ✅ |
| 55 | Wholesaler-chosen card facts | `migrations/054`, `js/lib/card-facts.js` | `check_card_facts.mjs` (37) | ✅ |
| 56 | Tag entry (categories, what a client sells) | `js/components/tag-input.js` | `check_tag_input.mjs` (13) | ✅ |
| 57 | **Client bans, per wholesaler, server-enforced** | `migrations/059` | `check_client_ban.sql` | ✅ |
| 58 | CSV import / export | `js/data/csv-import.js`, `csv-export.js` | *(no assertion yet)* | ⚠️ |
| 59 | AI catalogue import from image | `functions/extract-catalog-from-image` | *(no assertion yet)* | ⚠️ |
| 60 | Shopify / WooCommerce / WhatsApp integrations | `functions/*-webhook`, `migrations/018` | *(no assertion yet)* | ⚠️ |

## Roles, security, delivery

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 61 | Buyer / wholesaler / salesperson / owner / warehouse | `js/views/*` | `check_nav_completeness.mjs` (20), `check_post_login_landing.mjs` (9), `check_bottomnav_render.mjs` (37) | ✅ |
| 62 | Real auth, server-authoritative identity | `migrations/024` | `check_pack_moq.sh` preserves `p_account_id` | ✅ |
| 63 | Tenant-scoped RLS | `migrations/023,031,069` | `check_tenant_isolation.sql`, `check_movement_ledger.sql` §3 | ✅ |
| 64 | **User input cannot inject HTML** | `js/lib/utils.js` | `check_escaping.mjs` (13) | ✅ |
| 65 | **A deploy reaches installed users** | `sw.js` | `check_service_worker.mjs` (9) + `check_deploy_reaches_installed_client.mjs` (10) | ✅ |
| 66 | PWA installable, works offline | `manifest.json`, `sw.js`, `icons/` | `check_service_worker.mjs` offline cases | ✅ |
| 67 | Shipped CSP blocks inline script | `index.html` | `check_shipped_csp.mjs` | ✅ |
| 68 | 44px touch targets, AA contrast, complete tokens | `css/mobile.css`, `css/brand.css` | `check_touch_targets.mjs` (21), `check_contrast.mjs` (18), `check_token_completeness.mjs` | ✅ |
| 69 | Every module parses, imports resolve, no orphan calls | `js/**` | `check_module_syntax.mjs`, `check_imports_resolve.sh`, `check_cross_module_imports.mjs` | ✅ |
| 70 | **This repo can rebuild the database** | `supabase/migrations/*` | `check_migration_chain.mjs` (6) + `checks/replay_migrations.sh` | ✅ |
| 71 | **No change deletes a line without saying so** | `js/**` | `check_no_feature_loss.sh` — zero-deletion gate, overridable only with the reason in the commit message | ✅ |
| 72 | **The app never loses your place** — every catalog is its own route (`/wholesaler/catalogs/:id`), so creating one lands you in it and a reload keeps you there | `js/views/wholesaler.js`, `js/lib/router.js` | `check_route_state.mjs` (20) | ✅ |
| 73 | **A route change closes every open dialog** — one modal stack, so no dialog can be orphaned over an unrelated screen, and none of the next ones written has to remember | `js/lib/modal-stack.js` + 6 call sites | `check_route_state.mjs` — opens two dialogs, navigates, asserts the DOM is empty and both scroll locks released | ✅ |
| 74 | **No native browser dialogs** — every question is asked in the app, so it can be styled, used on a phone, and tested | `js/components/ask.js`, `js/components/receive-dialog.js` | `check_no_undeclared_identifiers.mjs` — `prompt`/`confirm`/`alert` are banned globals | ✅ |
| 75 | **Nothing is used that was never declared** — a name used without an import is a ReferenceError that only fires when someone clicks the thing | `js/**` | `check_no_undeclared_identifiers.mjs` — real parse, real scope walk, 97 files | ✅ |
| 76 | **Inventory is one module** — nav 15 → 9; Movements, Labels, Locations, Suppliers, Scan and Insights are sub-tabs, not separate places | `js/lib/nav-config.js`, `js/views/wholesaler.js` | `check_inventory_module.mjs` (32) | ✅ |
| 77 | **Every retired route still resolves** — the six absorbed screens keep their ORIGINAL paths, so bookmarks and cached PWA navigation work by construction rather than through a redirect layer | `js/views/wholesaler.js` | `check_inventory_module.mjs` — asked of the real router | ✅ |
| 78 | **Nine tabs survive a phone** — the strip scrolls, says it scrolls, and scrolls the active tab into view | `css/brand.css`, `js/components/sub-tabs.js` | `check_inventory_module.mjs` — asserts the fade and the reveal | ⚠️ |
| 79 | **One question decides how a product is ordered** — "any amount" or "only in boxes". The ratio / prepack / series split is gone from the screen, because the server never made it: migration 063 rejects loose lines for all three with identical logic | `js/components/order-setup.js` | `check_order_setup.mjs` (16) | ✅ |
| 80 | **Three kinds of pack, mixable on one product** — **Full box** (every colour, one size ratio), **By colour** (one colour, its sizes), **By size** (one size, every colour). A full box seeds every colour with the same ratio and any single colour can be overridden | `js/components/order-setup.js` | `check_order_setup.mjs` (27) — asserts all three exist, that they mix on one product, and that each says what the buyer receives | ✅ |
| 81 | **The wholesaler is told what the buyer will receive**, in a sentence, as they type | `js/components/order-setup.js` | `check_order_setup.mjs` — asserts the sentence names the sizes and the total | ✅ |
| 82 | **No money is taken through this app** — no processor, no card field, no charge, no "pay now"; the buyer's final button says "Submit order" | absence, across `js/**` | `check_no_payment_path.mjs` (3) — the one rule enforced by code that does NOT exist, so it needs a gate more than the others | ✅ |
| 83 | **The colour is visible, not just spelled** — a swatch, or the product photo for that colour, on every grid row and every box summary | `js/components/order-setup.js` | `check_order_setup.mjs` — asserts a swatch or image exists on the row head, with the name still present | ✅ |
| 84 | **Each colour carries its OWN photograph** — a wholesaler taps the photos that belong to a colour and only those reach that colour's variants | `js/components/product-form.js`, `js/data/products-admin.js` (`attachPhotos`) | `check_colour_photos.mjs` (20) — Parts B and D read what is actually written to each variant | ✅ |
| 85 | **A colour may hold several photographs**, and one photograph may belong to several colours — a flat-lay showing two colourways is tagged to both | `js/components/product-form.js` | `check_colour_photos.mjs` — B3 asserts Red carries both of its own and none of Blue's | ✅ |
| 86 | **A colour with no photograph is written none** — it never inherits a sibling's, on create or on edit | `js/data/products-admin.js` | `check_colour_photos.mjs` — B5, D6 | ✅ |
| 87 | **The buyer sees an honest empty frame, never the wrong garment** — the `primaryImage` borrow in the buyer card is gone; the colour stays fully orderable | `js/components/product-card.js` | `check_colour_photos.mjs` — C1 | ✅ |
| 88 | **A failed upload leaves a hole, not a shift** — one failed photo can never slide the next colour's photograph onto the previous colour | `js/data/products-admin.js` | `check_colour_photos.mjs` — F1, F2. Added *because* a red-proof failed to go red without it | ✅ |
| 89 | **Callers that send no colour mapping keep the old behaviour** — the CSV importer and AI catalog import still get one gallery on every variant | `js/data/products-admin.js` (`attachPhotos`) | `check_colour_photos.mjs` — E1 | ✅ |
| 90 | **The wholesaler is told which colours have no photograph**, in the form, as they build | `js/components/product-form.js`, `css/components.css` | `check_css_parses.mjs` — `.pb-colour-photos` / `.pb-photo-tag` survive parsing | ✅ |
| 91 | **The buyer's order sheet** — colours down, sizes across, one cell per colour x size | `js/components/product-card.js`, `css/components.css` | `check_buyer_card_capabilities.mjs` (36), `check_buyer_product_card.mjs` (46) | ✅ |
| 92 | **Sizes are named once**, in a header row, not reprinted under every colour | `js/components/product-card.js` | `check_buyer_card_capabilities.mjs` — 31 | ✅ |
| 93 | **A running total per colour**, on its own row, amber when under the per-colour minimum | `js/components/product-card.js` | `check_buyer_card_capabilities.mjs` — 33 | ✅ |
| 94 | **A total per SIZE along the bottom** — forty 32s against twelve 36s, visible without adding up | `js/components/product-card.js` | `check_buyer_card_capabilities.mjs` — 34 | ✅ |
| 95 | **One control at the foot** that never moves, aimed at whichever cell was tapped | `js/components/product-card.js` | `check_buyer_card_capabilities.mjs` — 15, 17, 18 | ✅ |
| 96 | **The colour column is frozen** while sizes scroll sideways | `css/components.css` | `check_css_parses.mjs` — `.os-grid` survives parsing | ✅ |
| 97 | **A part-unit cannot be typed in** — there is no free-text quantity box on the sheet at all | `js/components/product-card.js` | `check_buyer_product_card.mjs` — the structural assertion | ✅ |
| 98 | **An out-of-stock cell is shown but unaimable** — visible, hatched, never silently orderable | `js/components/product-card.js` | `check_buyer_card_capabilities.mjs` — 14 | ✅ |
| 99 | **Opening stock splits across several warehouses** — one item, this many here, that many there | `js/components/product-form.js`, `js/data/products-admin.js` (`allocationsFor`) | `check_multi_warehouse.mjs` (12) — WH-02, WH-06 | ✅ |
| 100 | **A split that does not add up is REFUSED** — named item, both numbers, before anything is written | `js/data/products-admin.js` (`validateStockSplit`) | `check_multi_warehouse.mjs` — WH-03, red-proved two ways | ✅ |
| 101 | **One warehouse ⇒ the step never appears** — nothing changes for anyone who does not need it | `js/components/product-form.js` (`paintWarehouses`) | `check_multi_warehouse.mjs` — WH-04 | ✅ |
| 102 | **The step comes AFTER the grid**, as a second pass over numbers that already exist | `js/components/product-form.js` | `check_css_parses.mjs` — `.pb-wh-item` survives parsing | ✅ |
| 103 | **A variant absent from the split keeps its stock** at the default warehouse — absent is not empty | `js/data/products-admin.js` | `check_multi_warehouse.mjs` — WH-05, red-proved | ✅ |
| 104 | **A stranger with the app's own key gets nothing from the buyer tables** — products, variants, packs, pack components and stock all refuse an anonymous caller | the database's grants, not `js/**` | `check_anon_scope.sh` — asks production signed out with the key read out of `supabase-client.js`, so it follows a key rotation instead of testing a dead one. **RED 25 Aug: 23 products / 264 variants / 143 stock rows across 6 wholesalers. GREEN 28 Aug after `085`: all seven denied outright, HTTP 401, and a stranger can enumerate no wholesaler's products.** ⛔ Never read alone — see row 125 | ✅ |
| 105 | **One catalogue's worth of data, and no more** — `v2_catalog_read` returns products, buyer-safe variant columns and live availability for exactly the catalogue the token names, gate re-checked inside the function | `supabase/migrations/080_v2_catalog_read.sql` | `check_catalog_read.sql` (12) — every row red-proved by five mutations; the refused catalogues in the fixture are deliberately STOCKED, because empty ones passed while the gate was ripped out | ✅ |
| 106 | **`cost` cannot come back in through a definer function** — asserted against the function's return type, not against a row | `supabase/migrations/080_v2_catalog_read.sql` | `check_catalog_read.sql` — row 9, red-proved by adding `cost` back | ✅ |
| 107 | **A product with no variants still appears to the buyer** — a catalogue-only product, or one whose colours are not added yet, is shown un-orderable rather than vanishing | `supabase/migrations/080_v2_catalog_read.sql` (the LEFT JOIN) | `check_catalog_read.sql` — row 10, red-proved by making it an inner join | ✅ |
| 108 | **The buyer's link route reads no tables at all** — every product, price and stock number on `/c/:token` arrives through the gated function | `js/data/catalog.js` (`getCatalogByToken`), `js/views/buyer.js` | `check_buyer_reads_are_gated.mjs` (4) — all four red-proved. Structural on purpose: until S7 the grants are still open, so a missed table read still WORKS and nothing else goes red | ✅ |
| 109 | **Both read paths build the same buyer object from one place** — `shapeVariant`/`shapeProduct` are shared, so the wholesaler path and the buyer path cannot drift apart | `js/data/catalog.js` | `check_buyer_reads_are_gated.mjs` — assertion 4. ⚠️ Its first version counted the function's own DECLARATION as a call site and could not go red — the identical mistake made on 23 Aug | ✅ |
| 110 | **A buyer holding a LINK can see a product's packs** — for a series, prepack or ratio product the pack *is* the buy button, so this is the difference between orderable and not | `supabase/migrations/082_v2_catalog_packs.sql`, `js/data/prepacks.js` (`listPacksByToken`) | `check_catalog_packs.sql` — row 1, and `check_buyer_reads_are_gated.mjs` asserts `packs: []` never returns. ⛔ **Regression guard for a live bug**: the link view passed an empty list unconditionally, so 13 of 23 production products said *"ask the wholesaler to add one"* when they already had | ✅ |
| 111 | **Packs come through the gate, on both buyer routes** — link and signed-in, one catalogue's worth, gate re-checked inside | `082`, `js/data/prepacks.js` | `check_catalog_packs.sql` (15) — every assertion red-proved by four mutations | ✅ |
| 112 | **`pack_price` never reaches a buyer** — the flat pack price is stored, never charged (D4), never rendered, and is the wholesaler's margin structure | `082` — absent from every gated return type | `check_catalog_packs.sql` — row 5, asserted on the **return type**, because a definer function outranks the grants that protect it | ✅ |
| 113 | **Reorder re-reads the CURRENT pack**, gated on the product still being in a catalogue this buyer may see — a product the wholesaler has pulled stops reordering, the same answer they'd get browsing | `082` (`v2_buyer_pack`), `js/views/buyer.js` | `check_catalog_packs.sql` — rows 12–14 | ✅ |
| 114 | **A pack with no components still appears** — as an empty pack, never vanishing, because a vanished pack is indistinguishable from feature 110's bug | `082` (LEFT JOIN) | `check_catalog_packs.sql` — row 11, red-proved by making it an inner join | ✅ |
| 115 | **A buyer's discount is derived from their account, not asked for** — `v2_buyer_discount_pct` takes **no client id at all**, so there is no different question to ask | `supabase/migrations/083_v2_buyer_pricing.sql` | `check_buyer_pricing.sql` — row 2 asserts the parameter **does not exist**, red-proved by re-introducing it. ⛔ Replaces `v2_catalog_discount_pct`, which took both ids from the caller and returned real negotiated terms to a signed-out stranger | ✅ |
| 116 | **A catalogue markup still reaches the buyer it applies to** — a negative discount is real pricing; hiding it from the app would make the cart disagree with the invoice. What changed is that only that buyer can read it | `083` | `check_buyer_pricing.sql` — row 4 | ✅ |
| 117 | **One arithmetic rule for the discount** — the gated function delegates to the same `v2_catalog_discount_pct` the server uses, with ids the database resolved itself | `083` | `check_buyer_pricing.sql` — row 9 asserts the two agree exactly | ✅ |
| 118 | **Quantity breaks come through the gate**, scoped to one catalogue and to the products on screen | `083`, `js/data/pricing.js` | `check_buyer_pricing.sql` (16) — incl. a second product whose breaks must never appear, added *because* a one-product fixture could not detect an unscoped join | ✅ |
| 119 | **A deactivated buyer account prices at zero** — not at their old terms | `083` | `check_buyer_pricing.sql` — row 6, red-proved by removing the account validation | ✅ |
| 120 | **The cart's price lookup is gated too** — a cart line stores the price it was priced AT, discount and break already applied, so re-pricing from that number would apply them twice; the list price is the only correct input and it now arrives scoped to variants this account may actually see | `supabase/migrations/084_v2_buyer_list_prices.sql`, `js/data/catalog.js` (`getVariantListPrices`) | verified in production: `md5(prosrc)` matches the repo byte-for-byte, `prosecdef` true, anon may execute. A variant the buyer may not see is ABSENT rather than an error — the caller already falls back to the line's stored price | ✅ |
| 121 | **anon holds no table, view, column or sequence privilege anywhere in the schema** — buyers and sales reps get a browser-local session and no Supabase one, so `auth.uid()` is null for them and RLS cannot scope them; the grant is the only lock they have, and it is now shut | `supabase/migrations/085_v2_anon_loses_the_tables.sql` | `check_anon_grants.sql` — reads `pg_class.relacl` **and** `pg_attribute.attacl`, red-proved with a table grant, a column grant, a view grant and a sequence grant | ✅ |
| 122 | **The rule that opened every new table is gone** — `026:173` set `alter default privileges … grant select, insert, update, delete on tables to anon`, so every table created since arrived readable AND writable by a stranger on its first day, before anyone wrote a policy for it. That standing rule, not seven forgotten grants, is what S0 was measuring | `085` | `check_anon_grants.sql` — red-proved by re-adding the default privilege and watching the gate fail. ⛔ **This is the half that matters in six months**: revoking today's grants without this makes the next `create table` reopen the leak silently, with every gate green | ✅ |
| 123 | **The ungated discount oracle is unreachable signed out** — `v2_catalog_discount_pct(catalog, client)` took both ids from the caller and answered any stranger with a real percentage; it also told you whether an id existed (real → `0.00`, invented → `0`) | `085` revokes EXECUTE from anon; `083` supplies the gated replacements | `check_anon_grants.sql`. `authenticated` KEEPS execute — a wholesaler is allowed to know their own discounts — and the arithmetic still lives in one function, reached with ids the database resolved itself | ✅ |
| 124 | **The grant gate can see a COLUMN grant** — a table-level grant lands in `pg_class.relacl`, a column-level one in `pg_attribute.attacl`, and a check that reads only the first calls the schema clean while every price and SKU is still readable | `checks/check_anon_grants.sql` | ⚠️ **Found the hard way**: the first draft read only `relacl`, and a deliberate `grant select (price) on v2_product_variants to anon` sailed straight past it. Migration `032` uses exactly that form — fourteen columns granted back after a table-level revoke — so the blind spot was aimed directly at the real defect | ✅ |
| 125 | **With the door shut, the buyer can still shop** — signed-in catalogues, products, prices, the discount, the share link and the cart's price lookup all answer over REST with nothing but the key that ships in the app | `080`–`084`, `js/data/*.js` | `check_buyer_path_survives.sh` (S8) — the **pair** to row 104 and never to be read without it. A shut door and a shut shop are indistinguishable from outside; only this gate tells them apart. Measured 28 Aug: 4 catalogues, 74 catalogue rows, 44 rows through the link, 3 cart prices | ✅ |
| 126 | **None of it crosses a tenant boundary** — the same buyer, pointed at another wholesaler's share link, another wholesaler's catalogue id, or another wholesaler's variant id, gets **nothing** back; and an invented token gets nothing too | `080`–`084` | `check_buyer_path_survives.sh` — four negative assertions, red-proved by pointing the gate at the buyer's OWN link and watching it report *RETURNED 44 ROWS ACROSS A TENANT BOUNDARY*. Silence rather than an error is deliberate: an error is an existence oracle | ✅ |
| 127 | **A variant the buyer may not see is ABSENT from the cart's prices, not an error** — so a cart that somehow holds a foreign line still renders, falling back to that line's own stored price instead of throwing | `084` | `check_buyer_path_survives.sh` — measured: her own three variants priced, another wholesaler's variant returns `[]` | ✅ |
| 128 | **A buyer can leave a note on any single item** — free text, no length limit, on a loose line and on a pack line alike. The requirement in Hadi's words: *"every product, every item will have a place to write whatever they want, unlimited amount of text"* | `086`, `js/data/cart.js` (`setLineNote`), `js/views/buyer.js` (`noteEditor`) | `check_order_notes.sql` — submits a REAL order through `v2_submit_order` and reads back what the server stored. Red-proved by dropping the note on ingest (3 cases failed) | ✅ |
| 129 | **One buyer's note per ORDER, and `v2_orders.notes` is finally written** — the column has existed since migration `004` and **nothing had ever written to it**; `v2_get_buyer_orders` has been faithfully returning `null` for it ever since. Adopted rather than dropped, because dropping it breaks every buyer's order history | `086`, `js/views/buyer.js` | `check_order_notes.sql` case 3. ⚠️ Same shape as `v2_clients.discount_pct`, dead from `006` to `058` while a 10% client paid full price on screen **and** on the invoice for two months | ✅ |
| 130 | **A note stays on its own line and does not bleed into the others** — one shared note field serving two lines (or two audiences) is the documented real-world failure: a merchant's internal picker note reached a customer-facing shipping label because both surfaces read one column | `086` | `check_order_notes.sql` case 2, **red-proved** by making every line take the order-level note and watching it report *line 1 note is `deliver before Thursday please`, expected the darker-blue note* | ✅ |
| 131 | **A pack's note is stored once, not once per component** — a pack is one line to the buyer and N rows in `v2_order_items`; the note rides on the first component only, so the warehouse sheet cannot print the same sentence N times | `js/data/cart.js` | `check_order_notes.sql`. The alternative (write to all N, de-duplicate on read) fails the moment one reader forgets the de-dup | ✅ |
| 132 | **An empty or whitespace-only note is stored as no note at all** — otherwise a buyer who taps into the box and back out puts a blank grey box on the warehouse's sheet. Normalised on BOTH sides, because a client-side-only rule is not a rule | `086`, `js/data/cart.js` | `check_order_notes.sql` cases 5 and 6 | ✅ |
| 133 | **Notes survive a page reload** — they live in the same `localStorage` cart as the quantities, and the order-level note beside it under its own key | `js/data/cart.js` | ⚠️ *(no automated assertion yet — the cart's persistence is covered, the note's is not. Marked unproven on purpose rather than claimed.)* | ⚠️ |
| 134 | **The checkout signature did not lose a security parameter while gaining the note** — `p_account_id` (migration `024`, closes "submit an order as any buyer") and `p_catalog_id` (closes "name the deepest-discounted catalogue") both survive | `086` | `check_order_notes.sql` case 4 + five in-migration assertions. ⛔ **This is why `086` reads the installed body out of `pg_proc` instead of pasting a copy**: the newest `create or replace function v2_submit_order` in this repo declares SIX parameters and the live one has SEVEN — `p_catalog_id` was added by a body patch, invisible to grep. Anchoring on any file here would have silently dropped catalogue scoping, exactly as the 15 Aug draft would have dropped `p_account_id` | ✅ |
| 135 | **The wholesaler can open ONE order and see all of it** — route `/wholesaler/orders/:id`, reached from an *Open order* button on each card. Before this the Orders tab was summary cards with **nothing to click**: name, date, status, total, and one comma-joined string | `js/views/wholesaler.js` `orderDetailView()`, `js/data/wholesaler-orders.js` `getWholesalerOrder()` | `check_order_detail.mjs` (20) | ✅ |
| 136 | **A pack is shown as a pack AND exploded into the pieces to pick** — a warehouse cannot pick "2 × Boutique Pack"; it picks 2 small, 4 medium, 4 large. Both forms are rendered, always | `js/views/wholesaler.js` | `check_order_detail.mjs` — **red-proved** by replacing the component list with "(pack contents hidden)" and watching the gate fail | ✅ |
| 137 | **Each buyer note renders against ITS OWN LINE**, never pooled at the bottom of the order. A note detached from the thing it is about is a note nobody acts on | `js/views/wholesaler.js` | `check_order_detail.mjs` | ✅ |
| 138 | **The orders LIST shows the note's WORDS, not a badge saying one exists** — capped at three, then "+ N more". ⛔ Two separate documented failures are being avoided here: a Cin7 user asking verbatim for comments "on the list of SO's so that we don't have to open up each invoice", and the recurring Shopify complaint *"the icon is there but no note shown"* | `js/views/wholesaler.js` `ordersView()` | `check_order_detail.mjs` — asserts the text appears and that no bare has-a-note indicator is relied on | ✅ |
| 139 | **The note survives the pack collapse** — a pack is one line to the buyer and N rows underneath, and the cart writes the note on the FIRST component only. `groupPackLines()` had no idea the field existed, so the note was **stored correctly and delivered nowhere** — the exact shape of the Batch-19 bug where the buyer's card fetched photography on every request and discarded it one line later | `js/data/prepacks.js` | `check_order_detail.mjs` — **red-proved** by deleting the carry line; also asserts the note is found when it sits on the SECOND row, so component order cannot lose it | ✅ |
| 140 | **One order is read scoped by WID as well as by id** — an order id is a uuid, but "hard to guess" is not an access rule. Same shape as S10 and the discount defect S4 fixed: a caller-supplied id that nothing scoped to a tenant | `js/data/wholesaler-orders.js` | `check_order_detail.mjs` — **red-proved** by removing `.eq("wid", wid)` and watching the filter assertion fail | ✅ |
| 141 | **The wholesaler can write an instruction to their own warehouse, per item and per order** — Hadi's words: when they send the order *"to their warehouse, for example, they can add in either a voice note or a written comment telling the people what to do"* | `087`, `js/views/wholesaler.js` `fulfilEditor()`, `js/data/wholesaler-orders.js` `setFulfilNote()` | `check_fulfil_note.sql` (7) + `check_order_detail.mjs` | ✅ |
| 142 | ⛔ **THE BUYER NEVER SEES IT.** `fulfil_note` is a SEPARATE column from `buyer_note`, and `v2_get_buyer_orders` is asserted — against its INSTALLED body — never to mention it. A real merchant's internal picker note reached a **customer-facing shipping label** for exactly one reason: two surfaces read one field | `087` | `check_fulfil_note.sql` case 2, **red-proved** by adding `fulfil_note` to the buyer's payload and watching it report *"the wholesaler's internal note reached the BUYER's order history"*. Migration assertion 4 is a bare token search on purpose — an alias or a computed expression could leak the value without the column name appearing | ✅ |
| 143 | **Only a signed-in wholesaler can write one** — and the refusal is asserted **by its reason**, not merely that something failed. `check_pack_moq` once reported 7 green while the function under test crashed on every call | `087` | `check_fulfil_note.sql` case 4, **red-proved** by replacing the tenant check with `true` | ✅ |
| 144 | **A fulfilment note on a line is scoped by order id as well as line id** — so a line belonging to another order cannot be written through an order this caller does own | `087` | `check_fulfil_note.sql` case 5 — asserts the refused write left the row unchanged | ✅ |
| 145 | **Writing one does not touch the buyer's note** — two columns, never one | `087` | `check_fulfil_note.sql` case 6 | ✅ |
| 146 | **The buyer can see their OWN note back in their order history** — `086` stored it and `v2_get_buyer_orders` never selected it, so a buyer re-reading their order could not see what they had asked for | `087` patches `v2_get_buyer_orders` from its INSTALLED body | `check_fulfil_note.sql` case 3 | ✅ |

| 147 | **A product with NO COLOURS can still be ordered** — `product.colors` filters out falsy colours, and every row of the order sheet was drawn by iterating it, so a colourless product rendered a header, a footer and **not one row**. The card drew its name, its price and its photo frame and looked finished; there was simply nothing to press, and no error anywhere. The approved mockup names this case explicitly: *"the last product genuinely has no colours, so it shows none"* | `js/components/product-card.js` `sheetRows` / `hasColours` | `check_buyer_product_card.mjs` — **red-proved**, 6 named failures against the shipped file. ⚠️ Its first version crashed instead of reporting, and one assertion went green vacuously because `[].every()` is `true`; both fixed before the fix was written | ✅ |
| 148 | **The colour column disappears with the colours** rather than being left blank and headed. A blank first column headed "Colour" reads as data that failed to load, which is the confusion an honest empty state exists to prevent. The per-size footer goes too — with one row it is that row printed twice | `js/components/product-card.js` | `check_buyer_product_card.mjs` | ✅ |
| 149 | **A running money total under the sheet** — the mockup's *"48 pieces (4 × 12) = $456.00"*, live on every press. The sheet gave piece counts and priced only the ONE cell the foot control was aimed at, so a buyer filling sixteen cells watched a number climb that was not money and learned the cost only after leaving for the cart | `js/components/product-card.js` `renderTotals()`, `.os-total` | `check_buyer_product_card.mjs` — asserts $24.00 in a 25% catalog where the list price says $32.00, and that the multiplication is written out only when a base unit makes it mean something | ✅ |
| 150 | **Tapping a colour's thumbnail opens it full size** — the mockup's *"thumbnails click to expand"*. It set the hero and stopped, so the only routes to a big picture were the "+N more" badge and the 360° button, both at the top of the card and neither where the thumb is when reading down the colour column. Keyboard-reachable | `js/components/product-card.js` | `check_buyer_product_card.mjs` — **red-proved** | ✅ |
| 151 | **An order bar pinned to the bottom of the catalogue** — pieces, money, and the way onward, visible the whole time. The only running count was a topbar badge, out of thumb reach (~85% of phone touches are thumb-driven) and adding packs and pieces together, so two boxes of twelve and two loose shirts both read "2" | `js/components/order-bar.js`, `js/views/buyer.js` | `check_order_bar.mjs` (12) | ✅ |
| 152 | **The bar counts PIECES and prices through `priceCart()`** — the same function whose subtotal must equal `v2_orders.subtotal`, so the bar cannot disagree with the invoice by construction. It stops listening when destroyed, so a stale bar cannot leak | `js/components/order-bar.js` `piecesInCart()` | `check_order_bar.mjs` | ✅ |
| 153 | ⛔ **CR-0008 — EVERY PACK LINE IN EVERY REAL CART PRICED AT $0.00.** `cart.addPack()` writes components as `{variantId, qtyPerPack, sku, color, size, reservationId, expiresAt}` — no price — and `linePieces()` read `basePrice: Number(c.price ?? 0)`. `0` is not `null`, so the `basePriceFor` fallback was never reached. The server derives its own prices, so the **invoice was right and the screen was wrong**: a buyer approved a subtotal with their packs missing and was invoiced for them anyway. Same disagreement as the Batch-5 pack bug, opposite direction | `js/data/line-pricing.js` `linePieces()` + `js/views/buyer.js` list-price lookup (both halves needed; either alone still prices a pack at nothing) | `check_line_pricing.mjs` — **red-proved**, and its fixture is copied field-for-field from `cart.addPack()` and **must never gain a `price`** | ✅ |
| 154 | ⚠️ **The lesson of CR-0008: `check_line_pricing.mjs` was green throughout** because every one of its pack fixtures adds a `price` to each component — **a shape the application does not produce**. It was found only because the order bar's own new gate displayed `USD0.00` beside a piece count it *had* been told to assert. A gate that asserts the count and not the money is a gate looking straight at the defect and not seeing it | — | This row is the record, not a feature | ⚠️ |

| 155 | **A wholesaler can approve the shops asking to buy from them** — the buyer's side of this has worked since Batch 14 (table `007`, anon submit RPC and `v2_approve_signup_request` in `024`), and that RPC has **always** authorised the wholesaler: `v2_is_owner() or v2_my_wid() = v_req.wid`. The only review screen was in the OWNER console, so in practice **OGGI had to approve every buyer for every wholesaler by hand.** The server was ready; the door had no handle | `js/views/wholesaler.js` `requestsView()`, route `/wholesaler/requests`, `js/data/wholesaler-admin.js` | `check_wholesaler_onboarding.mjs` (16) — **red-proved, 14 of 14 failing** against the shipped file | ✅ |
| 156 | **The queue is scoped by `wid` IN THE QUERY, not only by RLS** — `listSignupRequests` in the owner console selects with no `wid` filter at all and trusts the policy. That is correct today and one dropped policy away from being a cross-tenant list; this project has already been bitten once by a view that quietly bypassed RLS (`v2_wholesaler_billing`, migration `042`) | `js/data/wholesaler-admin.js` `listMySignupRequests()` | `check_wholesaler_onboarding.mjs` | ✅ |
| 157 | **Approving PROVISIONS; it is never a status flip** — a bare `update({status:'approved'})` would mark a shop approved while creating no login at all, and both sides would believe it worked. Routes through the RPC that creates the client row and the portal account in one transaction | `js/data/wholesaler-admin.js` `approveMySignupRequest()` | `check_wholesaler_onboarding.mjs` — asserts the RPC is called **and** that no direct status write exists | ✅ |
| 158 | **The one-time password is rendered on the page and says it will not return** — there is no email anywhere in this system (`024` says so in its own comment), and the generated password is unrecoverable. The card is **replaced**, not toasted: a notification that fades is the wrong container for a string nothing can recover | `js/views/wholesaler.js` | `check_wholesaler_onboarding.mjs` — asserts it is NOT inside a toast | ✅ |
| 159 | **Declining is a STATE, never a deletion** — Shopify's reject *is* "delete the company"; B2B Wave's is "click X to decline and delete the request". Both lose the history, so the same applicant loops forever and nobody can see they were here before. The row is kept, `reviewed_by` is stamped, and the confirmation says out loud that **the shop is not told automatically** — NuORDER verbatim: *"If you Decline or Archive a connection request, the buyer doesn't receive a rejection email"* | `js/data/wholesaler-admin.js` `rejectMySignupRequest()`, `js/views/wholesaler.js` | `check_wholesaler_onboarding.mjs` — asserts confirmation is asked and nothing on the screen deletes | ✅ |
| 160 | **Reached from Clients, and the sidebar is still nine entries** — the first version of this shipped a tenth nav item and `check_inventory_module.mjs` failed it within the minute. The nine-entry cap is Hadi's requirement (*"fifteen was two screens' worth of scrolling"*); raising it to fit my own screen would have been the 25 Aug mistake again — writing the gate to match my design instead of his requirement. **The gate was retargeted from "has a nav entry" to "is reachable", which is the actual rule.** A live head-only count of who is waiting appears on Clients only when somebody is | `js/lib/nav-config.js` (entry deliberately absent, with the reason), `js/views/wholesaler.js` `clientsView()` | `check_wholesaler_onboarding.mjs` asserts reachability **and** that the sidebar is still exactly 9; `check_inventory_module.mjs` (34) | ✅ |

| 161 | ⛔ **EVERY PUBLIC LINK IN THIS APP WAS UNREACHABLE WHILE SIGNED OUT — since 19 August.** `js/app.js` rendered the login screen and **returned before registering a single route**, and `registerBuyerRoutes()` — which owns `/c/:token` — was called further down. So the catalogue share link, the entire delivery mechanism a catalogue exists for and the whole reason migration `056` was written, opened to nothing for exactly the person it was built for: someone with no account. Every `login_required`, `not_found` and public-catalogue branch inside `catalogLinkView` was unreachable code | `js/app.js` — a public-path branch **before** the login gate, rendering into a bare outlet with no topbar, sidebar, bottom nav or cart badge | `check_order_handoff.mjs` — **red-proved** by moving the branch back after the gate, and again by deleting `registerBuyerRoutes` from inside it. ⚠️ The second red proof initially passed: the assertion sliced too widely and caught the *other* registration block further down. Scoped to the branch | ✅ |
| 162 | **An order can be handed to someone outside the app** — `/o/:token`. Until now an order existed here and nowhere else, and the warehouse got a screenshot; a screenshot of a scrolling order is several screenshots, each stale the moment anything changes | `088_v2_order_handoff_token.sql`, `js/views/public-order.js`, `js/data/order-handoff.js` | `check_order_handoff.sql` (17) + `check_order_handoff.mjs` (39) | ✅ |
| 163 | ⛔ **THE LINK NEVER CARRIES THE WAREHOUSE NOTE.** `087` made `fulfil_note` a separate column so an internal picking instruction could not reach a customer. This link is the **widest audience an order row has ever had** — it is built to be forwarded to a driver, a picker and a buyer, and nobody controls where it stops. So `v2_order_by_token` does not return it: not filtered in the client, not selected and dropped, **absent from the signature** | `088` | `check_order_handoff.sql` case 4 — **red-proved** by adding `fulfilNote` to the returned jsonb and watching it fail; plus a migration-time assertion on `pg_get_function_result` | ✅ |
| 164 | **The reader takes NOTHING from its caller but the token** — no order id, no wid. `080`'s rule: *"A definer function that trusts its caller is a BIGGER hole than the one being closed."* An order id is a uuid, and "hard to guess" has never been an access rule in this schema | `088` `v2_order_by_token(text)` | `check_order_handoff.sql` case 10 — asserts `pronargs = 1` | ✅ |
| 165 | **A dead link and an invented link answer identically** — both `not_found`, and the page says the same words. Telling them apart tells a stranger whether an order exists | `088`, `js/views/public-order.js` | `check_order_handoff.sql` case 7; `check_order_handoff.mjs` asserts the page never says "not found" | ✅ |
| 166 | **The link is rotatable, and rotating actually kills the old one** — the only remedy once a link has been forwarded to someone it should not have reached. `anon` is deliberately **not** granted execute: buyers and sales reps ARE `anon` (`085`), so a buyer could otherwise invalidate their own wholesaler's links | `088` `v2_rotate_order_token(uuid)` | `check_order_handoff.sql` cases 8a/8b/8c and 9b, plus a migration-time `has_function_privilege` assertion | ✅ |
| 167 | ⛔ **The wholesaler's contact number never travels.** Migration `042` closed that column deliberately; a link built to be forwarded must not be what reopens it | `088` returns the wholesaler's **name only** | `check_order_handoff.sql` case 6 — asserts on a **planted sentinel value**, after the first version asserted on a phone-number-*shaped* regex and failed on the order's own timestamp. Guessing at shapes lies in both directions | ✅ |
| 168 | **No table grant was handed out on the way** — `085` revoked every `anon` privilege on `v2_orders` and this feature does not restore one. The link works entirely through a definer function | `088` | `check_order_handoff.sql` case 11 | ✅ |
| 169 | **The sheet prints row-atomically** — `break-inside: avoid` on every line. A picking sheet that splits a size from its quantity across a page break gets picked wrong, and nobody notices until the box arrives. Save-as-PDF is the browser's own dialog: already correct on every phone, renders exactly what was on screen, and the person names the file | `css/components.css` `@media print` | `check_order_handoff.mjs`; `check_css_parses.mjs` asks a real Chromium what it kept | ✅ |
| 170 | **A pack is shown as a pack AND exploded into the pieces to pick** — the same rule the wholesaler's own order screen follows (row 136). A warehouse cannot pick "2 × box" | `js/views/public-order.js` `groupLines()` | `check_order_handoff.mjs` | ✅ |
| 171 | **WhatsApp gets text and a link, never an attachment.** `wa.me` cannot carry a file, and the Web Share API's file support is absent on most of the budget Android this app runs on — roughly a fifth of Lebanese mobile traffic is 2–4GB hardware. A share button that silently does nothing on the phones your buyers own is worse than a link they can paste. The message carries the wholesaler's name so it reads as a sentence, not as spam | `js/data/order-handoff.js` `whatsappHref()` | `check_order_handoff.mjs` — asserts no attachment scheme appears | ✅ |
| 172 | **Copy-link survives an in-app browser** — `clipboard.writeText` needs a secure context and a permission Instagram's and Facebook's in-app browsers refuse, and an in-app browser is exactly where a WhatsApp link gets opened. Falls back to `execCommand`, and shows the raw link if even that fails | `js/views/public-order.js`, `js/views/wholesaler.js` | — the fallback path has no automated assertion; behaviour is real, proof is not | ⚠️ |
| 173 | **`orderToken` is carried through the mapper** — `select("*")` was already fetching it and this mapper dropped it one line later. That is the third instance of fetched-and-discarded in this codebase: the buyer card's photography (Batch 19) and the pack's price (CR-0008). Named in a comment so the next person adding a column to `v2_orders` comes down here | `js/data/wholesaler-orders.js` | Exercised by `check_order_handoff.mjs` via the share panel | ✅ |

| 174 | ⛔ **THE QUANTITY CONTROL MOVED OFF THE FOOT AND ONTO THE ROW.** Hadi, 28 Aug, having chosen the matrix as the ordering screen: *"I don't like the idea that when they click, the number change appears at the bottom, because there's a very high chance that it might not be seen."* He is right, and the reason is worse than that: on a six-colour product the foot sits ~250–300px below the tapped cell with the running total in between — **frequently below the fold on a phone.** The buyer taps a number, nothing visibly happens, and the honest conclusion is that the app is broken. The original reasoning (*"a control that never moves, so the thumb never hunts"*) was **right about the thumb and wrong about the eye** | `js/components/product-card.js` — the pad mounts into an `.os-editrow` beneath the aimed colour | `check_buyer_product_card.mjs` (77) — **red-proved** by putting it back at the foot: 6 named failures | ✅ |
| 175 | **The control is asserted ADJACENT, not merely present** — "there is a stepper on the card" was already true when Hadi complained, so a check asserting only that would have been green throughout. The gate proves the control row is the **immediate next sibling** of the row being edited, on the **second** colour row (the first would pass even if the control were still at the top), and that only one is ever open | `check_buyer_product_card.mjs` | ⚠️ The assertion first failed against **working code**: it held a `<tr>` reference from before the click, and `renderSizes()` rebuilds the tbody, so it pointed at a detached node. Re-queried from `.os-cell.os-aim` after the repaint | ✅ |
| 176 | **The control is left-sticky inside the horizontal scroller** — on a product with more sizes than fit, which is the case this grid exists for, scrolling sideways to reach a size must not scroll the control off the screen | `css/components.css` `.os-editstick` | `check_buyer_product_card.mjs`; `check_css_parses.mjs` | ✅ |
| 177 | **The idle instruction is one quiet line, not a permanent bar** — furniture the eye learns to skip is furniture that goes unread on the one occasion it matters. It hides the moment the control opens | `js/components/product-card.js` `.os-hint` | `check_buyer_product_card.mjs` | ✅ |
| 178 | ⚠️ **A correction to an existing gate, recorded because the temptation was to weaken it.** `check_buyer_card_capabilities.mjs` proved "one row per colour" by counting `tbody tr`, which the inserted edit row took from 2 to 3. **The intent was unchanged; the proxy was wrong.** It now counts `tr:not(.os-editrow)` and cross-checks `tr[data-colour]` — stating the intent directly, and unable to be satisfied by rows that are not colours. Logged as CR-0009 | `checks/check_buyer_card_capabilities.mjs` (37) | This row is the record | ✅ |

| 179 | **DOOR A — a wholesaler can invite a shop by link.** The third of the three ways into a locked store, and the only one genuinely missing. `v2_invites` (`022`) is NOT this: it is authenticated-only, writes `v2_user_profiles`, and invites an OWNER or WHOLESALER. Reusing it would make one table mean two things — which is how `v2_suppliers` came to mean the opposite of "supplier" here | `089_v2_buyer_invites.sql`, `js/data/buyer-invites.js`, `js/views/public-order.js` `inviteView()`, route `/i/:token` | `check_buyer_invites.sql` (20) + `check_order_handoff.mjs` (60) | ✅ |
| 180 | **There is no send button, deliberately.** No transactional email exists (`024` says so in its own comment), and the 28 Aug research found the same failure on every platform surveyed — MUST-NOT #10, *"do not rely on an activation email arriving."* The wholesaler gets a **copyable link** and sends it in the WhatsApp thread they are already having with that shop, which is how every credential in this product is already relayed | `js/views/wholesaler.js`, `js/data/buyer-invites.js` `inviteLink()` | — the copy fallback has no automated assertion | ⚠️ |
| 181 | ⛔ **An invite is SINGLE-USE, under concurrency.** A link sent on WhatsApp **will** be forwarded — that is what WhatsApp is for. Redeeming takes a row lock, so two people opening the same forwarded link at the same moment cannot both get an account. Single-use has to mean single-use while someone is racing, or it is only single-use when nobody is | `089` `v2_redeem_buyer_invite` — `select … for update` | `check_buyer_invites.sql` case 6 — **red-proved** by removing the guard: *"the same invitation was redeemed TWICE"* | ✅ |
| 182 | **Withdrawn, used and expired are told apart — the OPPOSITE of the order link, on purpose.** An order link may be in a stranger's hands, so a dead one and a fake one must read alike. An invitation is held by someone the wholesaler chose to contact: *"this was withdrawn"* is something they can act on, where *"not found"* sends them back to ask a question the product could have answered | `089` `v2_invite_by_token`, `js/views/public-order.js` | `check_buyer_invites.sql` cases 7a–7e; `check_order_handoff.mjs` asserts the four pages read differently and that **none of them says "error"** — **red-proved** by collapsing them into one message | ✅ |
| 183 | **Thirty days, not a day.** MUST-NOT #12: *"do not expire an invite so fast that a real buyer misses it."* A shop owner in a market does not read WhatsApp on our schedule, and an invite that dies before it is opened costs the wholesaler a relationship **and** makes the product look broken. The caller's `p_days` is clamped 1–180 rather than trusted — 36500 would be no expiry at all | `089` | `check_buyer_invites.sql` case 8 | ✅ |
| 184 | ⛔ **The public projection carries no phone and no private note.** The wholesaler types both when creating an invite; neither reaches whoever is holding the link | `089` `v2_invite_by_token` returns three columns | `check_buyer_invites.sql` case 3 — **red-proved** by adding `note` to the return type — plus a migration-time assertion on `pg_get_function_result` | ✅ |
| 185 | **`anon` may open and redeem, and may NOT issue or revoke.** The person accepting has no account — that is the point — so the token is the authorisation and it is resolved inside the function. But buyers and sales reps **are** `anon` (`085`), so if they could issue, anyone could mint access to a store; if they could revoke, a buyer could withdraw their wholesaler's invitations | `089` grants | `check_buyer_invites.sql` cases 9a–9d, plus four migration-time `has_function_privilege` assertions | ✅ |
| 186 | **Redeeming creates the shop record AND a working login in one transaction**, and the password they chose actually verifies. A client who cannot sign in is not a client — the same gap that left SQUARE authenticating into nowhere on 17 Aug | `089` | `check_buyer_invites.sql` cases 4, 4b, 4c and 5 (5 re-runs `crypt()` against the stored hash) | ✅ |
| 187 | **The acceptance form asks three things and refuses by name.** Cartona's number from the research: before they moved verification after login, only **14.24%** of installs became registrations and **99%** of the rest left. Every field is a place to leave. The username field is `autocapitalize="none"` — a phone keyboard would otherwise capitalise it and the login would fail later, silently | `js/views/public-order.js` | `check_order_handoff.mjs` — **red-proved** by removing the attribute | ✅ |
| 188 | ⚠️ **A name collision, caught by a gate rather than by a person.** This module's redeem was first called `redeemInvite` — and `js/lib/dev-auth.js` already has one, for the OWNER invite, a different object with a different table. `check_cross_module_imports.mjs` reported it immediately. Renamed `redeemBuyerInvite`. **One name meaning two things is how `v2_suppliers` came to mean the opposite of "supplier" here**, which its own migration header now has to warn every reader about | `js/data/buyer-invites.js` | `check_cross_module_imports.mjs` | ✅ |
| 189 | ⚠️ **A CSS token that did not exist, carried by its own fallback.** `var(--danger, #b42318)` — this design system defines `--danger-700`, never `--danger`. `check_token_completeness.mjs` caught it. A fallback that works today is a colour that **stops tracking the theme** the moment anyone changes the palette, and nobody finds out because it never breaks loudly | `css/components.css` | `check_token_completeness.mjs` | ✅ |
| 190 | **The invitation form uses explicit field lookups, not `form.shop`.** Named form access is real, but a field named `submit` or `action` shadows the form's own method and the failure is silent — and jsdom does not implement it, so **no gate could ever reach that code.** Code no check can reach is code that drifts | `js/views/public-order.js` | `check_order_handoff.mjs` now exercises all three fields | ✅ |
| 191 | **One person can hold access to many stores.** `v2_people` + `v2_person_channels` + `v2_person_memberships`. Until now a login belonged to exactly one wholesaler — `wid NOT NULL`, and half the username index — so one human buying from three wholesalers was three unrelated rows nothing joined. **"The wholesalers you have access to" was a sentence that could not be written in SQL** | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` | ✅ |
| 192 | **A phone or an email is a CHANNEL on a person, never the person.** Two columns cannot hold "this number used to be theirs and this one is theirs now, both verified on these dates" — which is the whole of ID-08. Three rows can | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` | ✅ |
| 193 | **Normalisation may split a person; it must never merge two.** Matching on a phone number means a normalisation bug does not produce a glitch, it hands one shop another shop's store access. Every rule fails toward "two different people": under 7 digits → NULL, malformed email → NULL, an already-international number is never re-interpreted | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` — red-proved by removing the guard, which merged two unrelated shops | ✅ |
| 194 | **The backfill is a FUNCTION, not an inline `do` block.** An inline block can only be tested by a gate that reimplements it, and a gate testing a *copy* of the logic is the exact shape of a check that passes while the real thing is broken — twice recorded in `GATE-EVIDENCE.md`. The migration and the gate now call the same code | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` calls `v2_backfill_person_identity()` directly | ✅ |
| 195 | **The identity migration is additive only, and the gate proves it.** Both username indexes are asserted still present, because GP-02 is "never force existing buyers to re-register" and the cheapest way to honour it is to make the change invisible until the screens are ready | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` asserts both indexes survive | ✅ |
| 196 | **A wholesaler cannot learn that their buyer also buys elsewhere.** `v2_people` and `v2_person_channels` are owner-only; a wholesaler sees only membership rows for their own store. A per-wholesaler policy on the person row would let any store enumerate its buyers' other stores | `supabase/migrations/090_v2_person_identity.sql` | `check_person_identity.sql` asserts no `v2_my_wid` policy on `v2_people` | ✅ |
| 197 | **"Browse our wholesalers" — every active wholesaler on OGGI, by name.** The first screen that shows a buyer a business that has not let them in, and the first thing that makes this a marketplace rather than one catalogue with a login | `js/views/directory.js`, `supabase/migrations/091_v2_wholesaler_directory.sql` | `check_wholesaler_directory.mjs` (33), `check_wholesaler_directory.sql` (21) | ✅ |
| 198 | **A name and the categories they sell — and nothing else.** No products, no prices, and deliberately no product COUNT. The count is not a product and would make the directory more useful; it is left out because "this one lists 4,000 SKUs and that one lists 12" is competitive intelligence about a business that never agreed to publish it | `supabase/migrations/091_v2_wholesaler_directory.sql` | migration self-assertion 1 + `check_wholesaler_directory.mjs` — red-proved by spreading the server row through the mapper, which named all five leaked fields | ✅ |
| 199 | **Categories come from two sources, declared and derived.** `v2_wholesaler_categories` holds 3 rows across 9 wholesalers, so a directory built on it alone would have launched showing six blank cards — and a blank directory teaches a buyer the feature is broken. Declared is unioned with categories derived from live products; archived products do not speak for a business | `supabase/migrations/091_v2_wholesaler_directory.sql` | `check_wholesaler_directory.sql` asserts both sources and that an archived product contributes nothing | ✅ |
| 200 | **The access state on every card is a fact about a PERSON, not an account** — member, pending, or neither, joined through `v2_person_memberships`. This is the payoff of 090 and the reason ID-01 had to come first | `supabase/migrations/091_v2_wholesaler_directory.sql` | `check_wholesaler_directory.sql` + `.mjs` | ✅ |
| 201 | **Asking for access reuses Door B's queue rather than inventing a second one.** `v2_signup_requests`, the same object the wholesaler already reviews on Clients (PR #32), plus one nullable `person_id` so the directory can say "you already asked". Two tables meaning "someone wants in" is how `v2_suppliers` came to mean the opposite of supplier here | `supabase/migrations/091_v2_wholesaler_directory.sql` | `check_wholesaler_directory.sql` — red-proved by allowing a duplicate request | ✅ |
| 202 | **The button never lies about what pressing it does.** A member gets a way in, someone who has already asked gets no button at all, and a stranger gets one that works. Asserted on `data-access`, not on the words, so improving the wording cannot break the check | `js/views/directory.js` | `check_wholesaler_directory.mjs` — red-proved by offering the button to a pending card | ✅ |
| 203 | ⚠️ **A reversed product decision, recorded rather than silently contradicted.** `nav-config.js` said the marketplace would show "no wholesaler names anywhere"; Hadi reversed that on 28 Aug. The note now records the reversal, who made it, and how the original objection is *answered* by DR-05 rather than dismissed. A comment that contradicts the code is how a false claim survives three rewrites | `js/lib/nav-config.js` | `check_wholesaler_directory.mjs` asserts the reversal is recorded | ✅ |
| 204 | ⚠️ **A vacuous assertion, caught by red-proving and rewritten.** The first DR-05 block rendered a polluted row and asserted nothing leaked to the page. It passed even when the view was rewritten to print the entire row into every category chip — because the mapper had already dropped the pollution. It was testing the mapper while claiming to test the screen, and could not fail. DR-05 is now asserted at the mapper, where the property lives | `checks/check_wholesaler_directory.mjs` | itself — red-proved by spreading the row, which fails 5 | ✅ |
| 205 | **SR-01 — item search across every store this buyer has, and none they do not.** The scope is computed from `v2_person_memberships` FIRST, before anything is searched, and the function takes **no wid** — there is nothing a caller can claim. Proven on live production: a buyer in `test` searching "pant" gets nothing, while `demo` holds a "Cargo Pant" | `supabase/migrations/092_v2_cross_store_search.sql`, `js/views/search.js` | `check_cross_store_search.sql` (20), `check_cross_store_search.mjs` (25) — red-proved by removing the scope, which reported "LEAK: 1 product(s) from a forbidden store" | ✅ |
| 206 | **Every result names the wholesaler it came from.** Not decoration: a buyer comparing two similar products at two prices is deciding *who* to buy from, and a card that hides the seller makes that decision impossible | `js/views/search.js` | `check_cross_store_search.mjs` — red-proved by blanking the seller name | ✅ |
| 207 | **The price is labelled "from", and that word is load-bearing.** The exact price depends on the buyer's client record in that store — discount, tiers, catalogue overrides. A search result that quotes a price the order does not honour is a complaint, not a rounding error | `js/views/search.js`, migration 092 | `check_cross_store_search.mjs` — red-proved by dropping the word | ✅ |
| 208 | **Arabic search that actually works for how people type.** Diacritics stripped, the four alef forms folded, teh marbuta to heh, alef maqsura to yeh, Arabic-Indic digits to ASCII — applied to BOTH sides so the comparison is symmetric. A shop owner typing قميص finds قَمِيص | `supabase/migrations/092_v2_cross_store_search.sql` | `check_cross_store_search.sql` — red-proved by disabling the folding | ✅ |
| 209 | ⚠️ **A production self-assertion caught a bug the local replay passed.** The first version stripped diacritics with the range U+0610–U+0670, which **spans the Arabic-Indic digits** at U+0660–U+0669 — so a query of ٣ was deleted before it could become 3. Production refused the migration and rolled back entirely; PostgreSQL 16 locally had passed it. Fixed by folding digits FIRST and enumerating the diacritics instead of using a range. **A range is a compact way to write a set whose membership you have not checked** | `supabase/migrations/092_v2_cross_store_search.sql` | `check_cross_store_search.sql` now asserts the digit case end to end, so the local gate is no longer blind to it | ✅ |
| 210 | **SR-10 — every search that found nothing is logged, from day one.** The queries a catalogue cannot answer are buyers telling you, in their own words, what they came for and did not find. It costs one insert and cannot be reconstructed retroactively. The RAW query is kept alongside the normalised one, because when a normalisation rule is later found wrong the raw text is the only way to tell a bad rule from an absent product | `supabase/migrations/092_v2_cross_store_search.sql` | `check_cross_store_search.sql` — red-proved by disabling the insert; also asserts a SUCCESSFUL search is not logged as a miss | ✅ |
| 211 | **The empty result explains that the search was scoped.** "No products matched in the wholesalers you have access to — ask another wholesaler on the Wholesalers tab." A buyer who does not know the search is scoped reads an empty result as "OGGI has nothing" | `js/views/search.js` | `check_cross_store_search.mjs` | ✅ |
| 212 | **Cost, supplier and the wholesaler's internal note cannot reach a buyer through search.** The mapper keeps exactly eight fields and drops everything else, so a future server change that starts returning cost stops at the client boundary | `js/data/search.js` | `check_cross_store_search.mjs` — red-proved by spreading the row, which named every leaked field including cost | ✅ |
| 213 | **SR-02 — an "OGGI product" is a COMMISSION ARRANGEMENT, not a brand.** OGGI builds nothing; it sells other people's products for a cut. So promotion is a row *about someone else's product* carrying a rate and a date — not a boolean on `v2_products` where the wholesaler could see and edit it | `supabase/migrations/093_v2_promoted_slot.sql` | `check_promoted_slot.sql` (11) | ✅ |
| 214 | **SR-03 — promotion CANNOT touch the organic ranking, and that is asserted as a property.** Promoted products are a separate, capped, flagged selection; the organic set is computed without reference to promotion at all. The gate captures the organic order, turns promotion on, and requires the order to be **byte-identical** | `supabase/migrations/093_v2_promoted_slot.sql` | `check_promoted_slot.sql` — red-proved by adding the obvious rank boost, which reported *"SELF-PREFERENCING: organic order changed"* and showed Delta jumping 4th → 1st | ✅ |
| 215 | **The shelf is CAPPED at three, not a percentage.** A slot whose size floats with how many products OGGI has arranged commission on grows quietly until it is the whole page. A fixed number is the difference between a shelf and a takeover, and a wholesaler can be told what it is | `supabase/migrations/093_v2_promoted_slot.sql` | `check_promoted_slot.sql` — red-proved by uncapping | ✅ |
| 216 | **A promoted product still appears organically, in its honest position.** Removing it from the results would also be a distortion, just in the other direction, and would make the shelf a substitute for the results rather than an addition | `supabase/migrations/093_v2_promoted_slot.sql`, `js/views/search.js` | `check_promoted_slot.sql` + `check_cross_store_search.mjs` | ✅ |
| 217 | **The shelf says it is paid for.** "Featured by OGGI — we earn a commission on these." *Featured* alone is a euphemism; a buyer is entitled to know a placement was bought. This is the disclosure half of SR-05 | `js/views/search.js` | `check_cross_store_search.mjs` asserts the word *commission* — red-proved by shortening the label to "Featured" | ✅ |
| 218 | **The commission RATE never reaches a buyer.** The label discloses that a placement is paid for; what OGGI earns on it is not a buyer's business, and publishing it would rank the results by price-to-us in the buyer's head | `supabase/migrations/093_v2_promoted_slot.sql`, `js/data/search.js` | migration self-assertion 2 + `check_cross_store_search.mjs` | ✅ |
| 219 | **SR-04 — the data wall, stated mechanically.** Search must never read `v2_orders`: no wholesaler's sales figures may inform what OGGI chooses to promote. Asserted against the function's own source, so a future edit that joins orders fails the migration | `supabase/migrations/093_v2_promoted_slot.sql` | migration self-assertion 5 + `check_promoted_slot.sql` | ✅ |
| 220 | **Promotion cannot carry a product across the access boundary.** A promoted product in a store the buyer cannot enter stays invisible — promotion is a shelf inside what they can already see, never a key | `supabase/migrations/093_v2_promoted_slot.sql` | `check_promoted_slot.sql` | ✅ |
| 221 | **SR-06 — the visibility mirror: 093's fairness promise, made checkable by the person it was made to.** A wholesaler sees their own impressions, distinct searches, average organic position, and — the number that earns the screen — **how often somebody else's paid placement appeared alongside one of their products** | `supabase/migrations/094_v2_visibility_mirror.sql`, `js/views/wholesaler.js` | `check_visibility_mirror.sql` (13) | ✅ |
| 222 | **The impression log CANNOT identify who searched, because the column does not exist.** Wholesalers read this table. Carrying a person_id would mean either leaking which of a competitor's buyers are shopping, or not leaking because a filter is correct today and one careless join from being wrong tomorrow. **Not collecting is a stronger guarantee than not exposing**, and it costs nothing: no question SR-06 asks needs to know who | `supabase/migrations/094_v2_visibility_mirror.sql` | `check_visibility_mirror.sql` — red-proved by adding a `person_id` column, which fails immediately | ✅ |
| 223 | **Neither visibility function takes a wid.** The wholesaler is resolved server-side from their own session. A wid argument would be one careless call from letting one wholesaler read a competitor's numbers — the single worst thing this data could do | `supabase/migrations/094_v2_visibility_mirror.sql` | `check_visibility_mirror.sql` — red-proved by dropping the wid filter, which showed a rival 3 impressions instead of 1 | ✅ |
| 224 | **A wholesaler who WAS promoted is not counted as having been outranked by it.** They were the one being promoted. The join is `p.wid <> v_wid`, and the gate proves the distinction | `supabase/migrations/094_v2_visibility_mirror.sql` | `check_visibility_mirror.sql` — red-proved by removing the inequality | ✅ |
| 225 | **The mirror reports THAT a wholesaler was outranked, never BY WHAT.** Counts only, no product detail. They are entitled to know a paid placement beat them; they are not entitled to a feed of what competitors sell | `supabase/migrations/094_v2_visibility_mirror.sql` | migration self-assertion 6 + `check_visibility_mirror.sql` | ✅ |
| 226 | **Only the first 20 results of a search are logged as impressions.** A buyer does not see row 47, so counting it would flatter the impression total and damage the average position at the same time — a number wrong in two directions at once | `supabase/migrations/094_v2_visibility_mirror.sql` | `check_visibility_mirror.sql` asserts positions and averages | ✅ |
| 227 | **The screen is reached from the dashboard, not from a tenth nav entry.** The wholesaler navigation is at the nine-entry cap, which is Hadi's requirement and was not raised for this — the same call made for the access-requests screen | `js/views/wholesaler.js` | `check_route_state.mjs`, `check_nav_*` | ✅ |

---

| 228 | **RC-01 — the reorder shelf is recomputed from ACTIVE memberships on every call.** Never stored, never cached. A stored "your reorder list" would be a snapshot of who a buyer WAS a customer of, and a revoked store would keep offering products they can see, want and cannot buy | `supabase/migrations/095_v2_buy_it_again.sql` | `check_buy_it_again.sql` (26) | ✅ |
| 229 | **A revoked store falls off the shelf on the very next call.** The gate revokes inside its own transaction, calls again, and requires the products to be gone | `supabase/migrations/095_v2_buy_it_again.sql` | `check_buy_it_again.sql` — red-proved by deleting `and m.active` | ✅ |
| 230 | ⚠️ **A VACUOUS ASSERTION, CAUGHT BY RED-PROVING AND REWRITTEN — the second of its kind.** Removing the client-scope filter produced ZERO failures, because every out-of-scope row in the fixture was ALSO out of scope by wid: the two filters covered for each other and neither could be shown to be load-bearing. The fixture now carries a rival shop INSIDE a store the buyer is in, and the leak it catches is the worse one — **one shop reading what a competitor reorders from the same wholesaler** | `checks/check_buy_it_again.sql` | itself — red-proved by removing the client filter alone, which now fails 4 | ✅ |
| 231 | ⚠️ **A second vacuous assertion in the same file.** The 50-row clamp was asserted against a 3-product fixture, so deleting the clamp entirely changed nothing. The fixture now builds 58 products, and removing the clamp reports *"limit 9999 returned 58 rows"* | `checks/check_buy_it_again.sql` | itself — red-proved | ✅ |
| 232 | **`times_ordered` counts distinct ORDERS, not line items.** Two shirts on one order is one order | `supabase/migrations/095_v2_buy_it_again.sql` | red-proved by swapping to `count(*)` | ✅ |
| 233 | **The reorder shelf can never read the promotion table or search telemetry.** It is the buyer's own receipts read back to them; the day a paid placement can enter it, the label is a lie. Asserted against the function's own source, so an edit that joins `v2_oggi_promoted` fails the migration rather than shipping | `supabase/migrations/095_v2_buy_it_again.sql` | migration self-assertion 7 + `check_buy_it_again.sql` — red-proved by adding the join | ✅ |
| 234 | **The mapper returns exactly nine fields and cannot grow a tenth silently.** A mapper that spreads the row is how a column added for one screen appears on another unnoticed | `js/data/reorder.js` | `check_buy_it_again.mjs` — red-proved by adding `...r` | ✅ |
| 235 | **The rail renders NOTHING when there is nothing to show** — no empty card, no "you haven't ordered yet". As of 30 Aug this is the only state on production, since no account that can log in has ever ordered, so the empty case is the shipping case | `js/components/product-rail.js` | `check_buy_it_again.mjs` — red-proved by rendering on empty | ✅ |
| 236 | **The order the database chose is the order rendered.** No client-side sorting: 095 ranks by most-recent then frequency and a gate proves that ranking, so a second opinion in the browser would make that proof describe nothing anybody sees | `js/components/product-rail.js` | `check_buy_it_again.mjs` — red-proved by sorting alphabetically | ✅ |
| 237 | **Every tile names its own store.** The rail is cross-store, so "who am I buying this from" is answerable without a tap — DR-05's reasoning running the other way | `js/components/product-rail.js` | `check_buy_it_again.mjs` — red-proved by removing the name | ✅ |
| 238 | **A paid rail cannot be rendered without its disclosure.** Passing the label IS the disclosure; there is no code path that produces a promoted rail without one, and the gate requires the word *commission* | `js/components/product-rail.js` | `check_buy_it_again.mjs` | ✅ |
| 239 | ⛔ **MIGRATION 095's FILE WAS LOST AND WAS RECOVERED FROM PRODUCTION, NOT REWRITTEN.** Applied 29 Aug; the machine it was written on is gone. Recovered from `pg_proc` and proven faithful two ways: a 97-migration replay reproduced production's shape hash exactly, and the normalised function body matched on both sides (`7d352319ccea320f3f09485a0a5065ad`, 1831 chars). The comparison was negative-tested in BOTH directions — it moves on a code change and does not move on a comment-only change | `supabase/migrations/095_v2_buy_it_again.sql` | `checks/replay_migrations.sh` | ✅ |
| 240 | **ID-03 — a buyer signs in to OGGI, not to a shop.** `v2_marketplace_login` takes a phone or email and **no wholesaler code**. Hadi, 30 Aug: *"Make the client bound to us, to the main market. And then each wholesaler gives them access."* Scope is derived inside the database, never supplied — the same rule as SR-01 and RC-01 | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` (34) | ✅ |
| 241 | 🔴 **THE ENUMERATION RULE. An unknown number, a wrong password, and a person with no marketplace password yet fail IDENTICALLY.** The identifiers are phone numbers out of wholesalers' client lists; a login that distinguishes those cases is a free tool for asking "is this shop on OGGI?" about any number in Lebanon, one request at a time | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` — red-proved by making the messages differ, which prints all three | ✅ |
| 242 | **GP-02 held: nobody was forced to re-register.** A person with one account ADOPTS that account's existing bcrypt hash and signs in with the password they already had. A person with several accounts and different passwords is deliberately given no credential — guessing one would silently break the others — and sets one by proving an existing store password. `v2_buyer_login` is not modified, not deprecated, not removed | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` asserts both doors still open and both old store passwords still work | ✅ |
| 243 | **ID-02 (partial) — the buyer session now EXPIRES and can be REVOKED.** Pulled out of Phase 7 deliberately: a person-level session that can switch stores turns a leaked value from "one store, forever" into "every store they can enter", which the 28 Aug feature matrix predicted in one line. A 32-byte secret, stored only as its SHA-256 | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` — red-proved by removing the expiry check and the revocation check separately | ✅ |
| 244 | ⚠️ **WHAT ID-02 DOES NOT YET DO, WRITTEN DOWN RATHER THAN IMPLIED.** This delivers expiry and revocation. It does **not** deliver per-request proof of possession: once `v2_session_account` returns a store's account id, that id is still a bearer value for the ~26 functions that take one. Closing that means signing every request and remains a Phase 7 job. What changed is that the long-lived thing on the buyer's phone now expires and can be killed | `supabase/migrations/096_v2_marketplace_login.sql` header | — (a stated limit, not a claim) | ⚠️ |
| 245 | **ID-09 — one session, many stores, and the membership is re-checked on every entry.** A buyer revoked an hour after signing in cannot keep entering that store for the remaining 30 days of their session | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` — red-proved by trusting the membership from login | ✅ |
| 246 | **The new front door is rate-limited by the same table and the same limits as the old one.** Ten wrong attempts lock the identifier out, and the correct password is refused while locked. A new door with no rate limit would be worse than the one it stands beside | `supabase/migrations/096_v2_marketplace_login.sql` | `check_marketplace_login.sql` — red-proved by removing the throttle | ✅ |
| 247 | ⛔ **A MIGRATION THAT CREATED TEST DATA IN PRODUCTION, CAUGHT BEFORE IT WAS APPLIED.** 096's assertions are behavioural — they log a real person in, because reading the source and concluding "that looks right" is how the enumeration rule would ship broken. But a `do` block does NOT roll back when it succeeds, so the fixture would have left a person with a working password and a live phone channel in production, permanently reserving a real Lebanese number against a fake identity. The block now deletes its own fixture and asserts the deletion worked | `supabase/migrations/096_v2_marketplace_login.sql` | migration self-assertion 11, plus a fresh replay that counts the rows afterwards | ✅ |

| 248 | **ID-03 on screen — the buyer signs in with a phone number and no wholesaler code**, and that panel is offered FIRST. The per-store panel is kept underneath, reachable in one tap, because everyone signs in that way today | `js/views/login.js` | `check_marketplace_client.mjs` (31) | ✅ |
| 249 | **The login screen never elaborates on the server's refusal.** One message covers an unknown number, a wrong password and a person who has not set a marketplace password yet. A friendlier client-side message would rebuild, in the browser, the enumeration oracle the database was careful not to be | `js/data/marketplace.js` | `check_marketplace_client.mjs` — red-proved by inventing *"We could not find an account with that phone number"* | ✅ |
| 250 | **A buyer with several shops is ASKED which one, never guessed for.** Picking one silently is how an order goes to the wrong wholesaler | `js/views/login.js` | `check_marketplace_client.mjs` | ✅ |
| 251 | **ID-09 — the store switcher, and switching is a SERVER round trip.** Every switch calls `v2_session_account`, which re-checks the membership. A local toggle would let a buyer revoked an hour ago walk back into that store on a list fetched before the revoke | `js/components/store-switcher.js` | `check_marketplace_client.mjs` — red-proved by replacing the call with `{ok:true}`, which fails 3 | ✅ |
| 252 | **A refused switch says so, and the store is removed from the list.** Almost always a revoke; silence looks like a broken button, and leaving it in the list leaves the buyer tapping a door that will never open | `js/components/store-switcher.js` | `check_marketplace_client.mjs` | ✅ |
| 253 | **The switcher renders NOTHING for a buyer with one store, and nothing at all for the per-store door.** Same rule as the reorder rail: a control with nothing to switch to is a permanent question about a decision that does not exist | `js/components/store-switcher.js` | `check_marketplace_client.mjs` | ✅ |
| 254 | **The store list and the account id are NEVER kept on the phone.** Both are re-fetched on every boot and every switch, so a wholesaler who revokes at 3pm cannot be entered at 4pm from a stale copy. Caching the answer would be a way of disagreeing with the database that re-checks it | `js/data/marketplace.js` | `check_marketplace_client.mjs` — red-proved by caching the list | ✅ |
| 255 | **Signing out REVOKES the session server-side.** Clearing localStorage alone would leave a token valid for the rest of its 30 days — "I logged out" has to mean the token is dead, not that this browser stopped presenting it | `js/lib/dev-auth.js` `logout()` | `check_marketplace_client.mjs` | ✅ |
| 256 | **The marketplace door writes the SAME buyer session shape used since Batch 0**, so none of the ~15 call sites that read it can tell which door was used. Two doors, one app, and no second copy of the buyer screens | `js/lib/dev-auth.js` `adoptBuyerSession()` | `check_marketplace_client.mjs` | ✅ |
| 257 | ⛔ **SR-11 — SEARCH RESULTS WERE NOT CLICKABLE, FROM THE DAY SR-01 SHIPPED UNTIL 30 AUGUST.** `resultCard()` rendered a photo, a name, the wholesaler and a price and attached **no click handler of any kind**: a buyer could search across every store they had and then had no way to open anything they found. Nothing caught it because every assertion in `check_cross_store_search.mjs` was about what the card SHOWS — a screen can be correct in every visible detail and still be a dead end, and *"is there any way out of this screen"* is the question none of them asked | `js/views/search.js` `resultCard()` | `check_marketplace_client.mjs` — red-proved by removing the handler again | ✅ |
| 258 | **A search result is reachable by keyboard, not only by mouse.** `role="button"`, `tabindex`, and Enter/Space. A div made clickable and not focusable is a control that exists only for people using a pointer | `js/views/search.js` | `check_marketplace_client.mjs` | ✅ |
| 259 | **MK-01 — a product route that works across stores**, `#/buyer/s/:wid/p/:productId`. This is the destination the directory, cross-store search and the reorder rail had all been pointing at and missing since the day each shipped | `js/views/buyer.js` | `check_marketplace_client.mjs` | ✅ |
| 260 | **The cross-store route cannot be used to walk into a store by typing its id.** It calls `enterStore`, which is a server round trip that re-checks the membership; a revoked buyer gets the refusal screen, not the catalogue | `js/views/buyer.js` | `check_marketplace_client.mjs` — asserted against the route's own source | ✅ |
| 261 | **A buyer on the per-store door is told the product belongs to another wholesaler**, rather than failing blankly at a route they have no way to satisfy | `js/views/buyer.js` | `check_marketplace_client.mjs` | ✅ |
| 262 | **Landing on a product that has since left the catalogue says so.** The focus flag is cleared whether or not the card is found, so a departed product cannot re-trigger the scroll on every later visit | `js/views/buyer.js` | `check_marketplace_client.mjs` | ⚠️ |
| 263 | **The reorder rail is mounted on the buyer home, and does not block the catalogue.** It is fetched without being awaited: the shelf is a convenience and the catalogue is the screen a buyer came for, so a slow reorder query must never hold it up | `js/views/buyer.js` | `check_buy_it_again.mjs` covers the rail; the mount point is `check_marketplace_client.mjs` | ⚠️ |

| 264 | **SR-09 — NORMALISATION ADDS A FIELD, IT NEVER OVERWRITES ONE.** "Crimson Red" (37 variants), "Crimson" (2) and "Red" (11) are three wholesalers' own words for one colour. A derived `colour_family` is added beside each; the wholesaler's text is untouched, so a buyer still reads "Crimson Red" on the shelf and still finds it when filtering by red. Migration 090 made the same promise about people — *normalisation may split a person, it must never merge two* | `supabase/migrations/097_v2_attribute_normalisation.sql` | `check_attribute_normalisation.sql` — red-proved R1 by making the trigger rewrite `extra_attrs` (fails 2) | ✅ |
| 265 | **The taxonomy is a TABLE, not a case statement.** Which colours form a family, and what that family is called, is a product decision about a Lebanese wholesale market — editable without a migration. 100 seeded rows, drawn from the values actually in production | `wholesale_v2.v2_attribute_aliases` | `check_attribute_normalisation.sql` | ✅ |
| 266 | **An unknown value gets NO family — never a guess.** "hgfds" (7 variants) and "kjh" (7) are not colours; "gfhjbk" is not a category. 250 of 264 variants resolved and the remaining 14 stayed NULL. A facet that silently contains every typo is a facet nobody can filter by | `supabase/migrations/097_v2_attribute_normalisation.sql` `v2_normalise_attribute()` | `check_attribute_normalisation.sql` — red-proved R3 by falling back to the raw value (fails 2) | ✅ |
| 267 | ⛔ **THE DERIVED COLUMN CANNOT BE MADE TO LIE.** The first draft fired the trigger `before insert or update OF extra_attrs`, which left a door open: `update … set colour_family = 'purple'` does not touch `extra_attrs`, so the trigger would not fire and the lie would stick. A derived column that disagrees with the column it is derived from is worse than no column. Now it fires on **every** update | `supabase/migrations/097_v2_attribute_normalisation.sql` | `check_attribute_normalisation.sql` — red-proved R2 by restoring the narrow form (fails 2) | ✅ |
| 268 | **Normalisation runs in a TRIGGER, not in the three client ingest paths.** The CSV importer, the AI catalogue import and the product form are three chances to forget, plus a fourth the day somebody adds an API. A trigger cannot be forgotten by a caller that does not know it exists, which is the only version of *"at ingest"* that stays true | `supabase/migrations/097_v2_attribute_normalisation.sql` | `check_attribute_normalisation.sql` — red-proved R8 by dropping the product trigger (fails 2) | ✅ |
| 269 | **Ingest and search agree by construction.** The alias key is `v2_search_normalise()` — the same function the search box uses — so "the same word" means the same thing at write time and at query time, Arabic included. An alias key not already in normal form would sit in the table looking correct and match nothing | `supabase/migrations/097_v2_attribute_normalisation.sql` | `check_attribute_normalisation.sql` — red-proved R6 by seeding a mis-cased key | ✅ |
| 270 | **Sizes sort, and only within their own system.** One text column holds two systems (28–47 and S/M/L/XL) plus "One size". As text, "10" sorts before "2" and S/M/L sort L, M, S. `size_system` + `size_rank` fix the order and keep the systems apart, so nothing can put them on one axis and claim 38 is bigger than XL. Letter ranks are spaced by 10 so a size can be inserted without renumbering | `supabase/migrations/097_v2_attribute_normalisation.sql` `v2_size_shape()` | `check_attribute_normalisation.sql` — red-proved R4 by reading every size as a letter (fails 5) | ✅ |
| 271 | **A colour family can be browsed by anyone and rewritten by nobody through the API.** RLS on, SELECT to `anon`/`authenticated`, INSERT/UPDATE/DELETE revoked — one buyer who could write it would rename every wholesaler's colours at once | `wholesale_v2.v2_attribute_aliases` | `check_attribute_normalisation.sql` — red-proved R5 by granting write to the browser roles | ✅ |
| 272 | ⛔ **A MIGRATION ASSERTION THAT ONLY HOLDS WHERE THE DATA HAPPENS TO BE IS NOT A GUARANTEE.** 097's first draft asserted the three reds collapsed by counting rows in `v2_product_variants` — and stopped the replay dead, because an empty database has no reds in it. It would have failed on every fresh Supabase project. The assertion now tests the function unconditionally and the rows only when rows exist | `supabase/migrations/097_v2_attribute_normalisation.sql` | `checks/replay_migrations.sh` — this was found by the replay, not by review | ✅ |

| 273 | ⛔ **097 HANDED anon A TABLE KEY, AND GATE S7 CAUGHT IT — NOT REVIEW.** 097 ended `grant select on v2_attribute_aliases to anon, authenticated`, reasoning that the facet list is not a secret. True, and the wrong conclusion: migration 085 took every table grant away from anon because *a grant plus `using (true)` is a standing door*, not because each table held a secret. `check_anon_grants.sql` passed on the database before 097 and raised on the database after it. Migration 098 revoked the grant and dropped the read policy with it | `supabase/migrations/098_v2_attribute_aliases_no_anon_key.sql` | `check_anon_grants.sql` (gate S7) and `check_attribute_normalisation.sql` — red-proved R9 by restoring the grant | ✅ |
| 274 | **The replay's shape hash does not cover ACLs, which is why S7 exists as a separate gate.** 097 and 098 both left `ad9d026c…` untouched: the hash is over relations and function signatures. A schema can be byte-identical in shape and have handed a stranger a key, so the two checks are not redundant and neither replaces the other | `checks/replay_migrations.sh`, `checks/check_anon_grants.sql` | run together in the sweep; the divergence was measured on both sides | ✅ |
| 275 | **Normalisation survives having no browser grant.** `v2_normalise_attribute` is SECURITY DEFINER and reads the taxonomy as its owner, so closing the table to `anon` and `authenticated` is invisible to the triggers. That is an argument, and an argument is not a check — so it is asserted, in 098 and in the gate | `supabase/migrations/098_v2_attribute_aliases_no_anon_key.sql` | `check_attribute_normalisation.sql` | ✅ |

| 276 | ⛔ **RC-02 COULD NOT BE BUILT AS WRITTEN, AND THE DATA SAID SO BEFORE ANY CODE DID.** "Best seller in this category" assumes categories. Production holds ONE — `apparel`, on 6 of 23 live products. It also holds 45 orders from **3 distinct buyers** across 2 of 7 stores. Ranked by order count, five of the six "best sellers" are ONE shop ordering the same thing repeatedly. Shipped instead as **"Popular right now"**, one honest degree less specific and working today | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` (21) | ✅ |
| 277 | **POPULAR MEANS "MANY SHOPS BOUGHT IT", NOT "IT WAS BOUGHT MANY TIMES."** The rank is `count(distinct buyer)`. One shop reordering weekly is loyalty — RC-01 already has a shelf for it. Fifty shops ordering once is a trend. Ranking on order count makes the loudest single customer the editor of everyone else's shelf, and it is the version a later "simplification" reaches for | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R1 by ranking on orders, R8 by ranking on units | ✅ |
| 278 | **A MINIMUM-BUYER FLOOR, AND NOTHING BELOW IT.** Under 3 distinct buyers a product does not qualify; if nothing qualifies the rail renders nothing. "Popular" backed by one buyer is a false claim wearing a confident label, and this shelf asks a buyer to spend money on it. On today's data the rail is empty for almost everyone — that is the feature working | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R2 by removing the floor | ✅ |
| 279 | **Cancelled orders are not evidence of popularity.** Production holds two. An order called off is a signal in the other direction, and counting it lets the shelf be filled by orders nobody ever paid for | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R3, on a fixture where 4 shops cancelled 50 units each | ✅ |
| 280 | **The shelf never repeats the shelf above it.** Anything the caller ordered inside the window is on the reorder rail directly above; two shelves showing one product is one wasted shelf. It is also what stops this being a mirror — the caller's own orders can never lift a shown product's buyer count | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R5 | ✅ |
| 281 | ⛔ **A DEAD FILTER WAS FOUND BY A RED PROOF THAT PRODUCED ZERO FAILURES.** 099 shipped with a second exclusion removing the caller's own order ROWS, which read like careful defence in depth. Red proof R5 removed it and nothing failed — which under the standing rule proves nothing, so it was worth asking why. Every row it removed belonged to a product the other filter had already excluded: it could never fire. A dead filter in a position that looks like protection is worse than none, because the next reader counts two guarantees where there is one | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — R5 now fails when the ONE load-bearing filter goes | ✅ |
| 282 | **A recency window, so the shelf can change.** All-time totals ossify: whatever sold in the first month wins forever and nothing new can reach the shelf | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R6, on a fixture bought by 4 shops 400 days ago | ✅ |
| 283 | **A revoked store falls off the popular shelf on the very next call.** Scope is derived from ACTIVE memberships every call and the function takes NO wid — the rule from SR-01, RC-01 and ID-09. A rail advertising a product behind a door that no longer opens is worse than an empty rail, because the buyer can see it and cannot have it | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R4, and the gate revokes mid-transaction and asks again | ✅ |
| 284 | **The category NARROWS and never gates.** Requiring a category would leave 17 of 23 products dark forever waiting on a data-entry job. The function reports which question it answered, and the probe that decides carries the SAME exclusions as the query it predicts — a looser probe would head the rail "Popular in Tops" over a widened list | `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` — red-proved R7 by claiming narrowed when it widened | ✅ |
| 285 | **The heading is derived from the ANSWER, never from the question.** `popularTitle(rows)` reads what came back, not what was asked for. A rail titled "Popular in Tops" over a list that widened past Tops is a lie the list underneath will not contradict, and no screenshot catches it | `js/data/popular.js` `popularTitle()` | `check_popular_client.mjs` — red-proved C2 | ✅ |
| 286 | **The subtitle says what the number MEANS.** "Ordered by several different shops" is a claim a buyer can weigh; "popular" alone is one they must take on trust while spending money | `js/data/popular.js` | `check_popular_client.mjs` | ✅ |
| 287 | **Ten fields, no row spread.** The RC-01 rule again: a column added to `v2_popular_now` for one screen must not surface on another because nobody was looking | `js/data/popular.js` `POPULAR_FIELDS` | `check_popular_client.mjs` — red-proved C1 by spreading the row | ✅ |
| 288 | **The popular rail carries NO paid disclosure, because it is not paid.** 099 is asserted twice never to read `v2_oggi_promoted` or `v2_search_impressions`. The day a paid rail ships it passes `paidLabel` and says so. The moment "popular" can be bought, the word stops meaning anything and every other shelf inherits the doubt | `js/views/buyer.js`, `supabase/migrations/099_v2_popular_now.sql` | `check_popular_now.sql` and `check_popular_client.mjs` | ✅ |
| 289 | ⛔ **A GATE ASSERTION THAT CONFIRMED THE HAPPY PATH INSTEAD OF FORBIDDING THE BAD ONE.** `check_popular_client.mjs` asserted the popular shelf was fetched with `.then(...)` — and `await listPopularNow(...).then(...)` has one too, and blocks the catalogue identically. Red proof C6 walked straight past it. The assertion now forbids the `await`, which is the thing actually being prevented | `checks/check_popular_client.mjs` | itself — C6 fails now and did not before | ✅ |
| 290 | **The ranking thresholds are configuration, not constants.** `v2_ranking_config` holds the floor, the window and the row ceiling. "How many shops make a trend" is a product judgement about a Lebanese market that will be wrong the first time. Created in the shape SR-07 wants, and closed to `anon` and `authenticated` from the first line — the lesson 098 had to learn | `wholesale_v2.v2_ranking_config` | `check_popular_now.sql`, `check_anon_grants.sql` | ✅ |

| 291 | ⛔ **RC-03 WAS SPECIFIED AS ATTRIBUTE SIMILARITY, AND THE ATTRIBUTES DO NOT DISCRIMINATE.** The colour-family, size-system and category columns were built the day before, in 097. Measured against the live catalogue: **eight of 23 products carry EVERY colour family** — mg, omni and sq each stock beige, blue, green and red — size system is binary, and category exists on 6 products, all `apparel`, all one store. A score built on those returns nearly everything for nearly every product, wearing the label of a recommendation | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` (17) | ✅ |
| 292 | **NAME OVERLAP IS THE MATCH. ATTRIBUTES ONLY RANK.** "Cargo Pant" exists in `demo` AND `sq`; "Merino Crew Knit" in `demo` AND `mg`. The same item from a second supplier is the most useful thing a wholesale marketplace can show a buyer, and no attribute column in this schema knows it. Nothing reaches the shelf on attributes alone | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — red-proved S1 by qualifying on colour overlap, S2 by removing the floor | ✅ |
| 293 | **A DECOY THAT SHARES EVERY COLOUR FAMILY AND THE SIZE SYSTEM AND NO WORD IS NOT SIMILAR.** The fixture builds exactly that product, because under the specified design it ranks first. It must not appear at all | `checks/check_similar_products.sql` | itself — this is the assertion the file exists for | ✅ |
| 294 | **pg_trgm was AVAILABLE AND DECLINED.** It would catch "Hooded Sweat" ≈ "Oversized Hoodie". Refused for the rule 097 was built on: the alias key is `v2_search_normalise()`, the same function search uses, so "the same word" means the same thing at ingest and at query time. A second notion of text similarity eventually disagrees with the first, and the symptom is a product similar on one screen and not on another | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — asserts `v2_name_words('T-Shirt')` equals `v2_name_words('t shirt')` | ✅ |
| 295 | **Stop words and single characters are removed, and it is not decoration.** The `test` store holds products named `j`, `dff`, `err`, `guyhj`. Without the length rule they become similar to each other and the shelf fills with keyboard mash. Asking what resembles `j` returns nothing | `supabase/migrations/100_v2_similar_products.sql` `v2_name_words()` | `check_similar_products.sql` | ✅ |
| 296 | **NO SINGLE STORE FILLS THE RAIL.** A per-store cap of 3. Without it "more like this" quietly becomes one supplier's catalogue — which is the store page the buyer is already looking at, and cross-store comparison is the reason the marketplace exists | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — red-proved S3 by removing the cap, which then let one store contribute 4 | ✅ |
| 297 | ⛔ **THE ANCHOR IS SCOPE-CHECKED TOO, NOT JUST THE RESULTS.** Without it a buyer could pass any product id and learn what the marketplace considers similar to it — a small read across a wall the rest of the schema keeps closed. Passing a product from a store they cannot enter returns nothing | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — red-proved S6, which returned 5 rows for an out-of-scope anchor | ✅ |
| 298 | **Price ORDERS results and never removes them.** A $3 equivalent to a $29.50 anchor still appears: a cheaper equivalent is exactly what a wholesale buyer is hunting for, and filtering it out would hide the best answer | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — red-proved S7 by making price a filter | ✅ |
| 299 | **A revoked store falls off the similar shelf on the very next call**, and the function takes NO wid. Same rule as RC-01, RC-02 and ID-09 | `supabase/migrations/100_v2_similar_products.sql` | `check_similar_products.sql` — red-proved S5, and the gate revokes mid-transaction and asks again | ✅ |
| 300 | ⛔ **`RETURNS TABLE` COLUMNS ARE VARIABLES INSIDE THE FUNCTION BODY.** The first draft named a CTE column `wid`, which is also an OUT parameter, and `partition by wid` was ambiguous between the two. Postgres refused to run it. Every CTE column is now renamed, with the reason written where the next person will hit it | `supabase/migrations/100_v2_similar_products.sql` | `checks/replay_migrations.sh` — the replay is what stopped | ✅ |
| 301 | **The rail is mounted ONLY where "this" has a referent** — inside the pending-product-focus branch. A "more like this" shelf on the plain catalogue is a rail about nothing, and it looks identical in a screenshot | `js/views/buyer.js` | `check_similar_client.mjs` — red-proved D6 by moving the mount out of the branch | ✅ |
| 302 | **The subtitle counts DISTINCT other suppliers, and claims none when there are none.** Reaching another store is the marketplace's whole value and is invisible from the tiles unless a buyer reads every store name; claiming it when it did not happen is the same lie in reverse | `js/data/similar.js` `similarSubtitle()` | `check_similar_client.mjs` — red-proved D2 by counting the buyer's own store, D3 by counting tiles | ✅ |
| 303 | **No anchor means no call at all.** "More like this" with no "this" is not a question worth asking the server | `js/data/similar.js` | `check_similar_client.mjs` — red-proved D4 | ✅ |
| 304 | **Ten fields, no row spread**, and the shelf is fetched without being awaited | `js/data/similar.js` `SIMILAR_FIELDS`, `js/views/buyer.js` | `check_similar_client.mjs` — red-proved D1 and D5 | ✅ |
| 305 | **The stop list and every similarity threshold live in `v2_ranking_config`**, which gained a `text_value` column. Which words carry no meaning in a Lebanese wholesale catalogue is a product decision, not a constant to freeze into a function — the same argument as SR-09's alias table. Still closed to `anon` and `authenticated` | `wholesale_v2.v2_ranking_config` | `check_similar_products.sql`, `check_anon_grants.sql` | ✅ |
| 306 | **Every change to a ranking number is recorded, and the recorder is a TRIGGER rather than the app.** Until this shipped, nothing in the application had ever written to `v2_ranking_config` — every change ever made to those eight numbers was hand-typed in the Supabase SQL editor, which is exactly the path an application-level audit cannot see. An audit written in JavaScript would have recorded nothing while looking perfectly healthy | `supabase/migrations/101_v2_ranking_config_history.sql` | `check_ranking_config_versioned.sql` (assertions 2, 3) | ✅ |
| 307 | **The old value is kept, not just the new one.** `updated_at` was overwritten in place: it said a change had happened and destroyed the evidence of what it was. Old and new are stored side by side and typed — not as a jsonb blob, because reconstructing "what was every number on 4 March" out of jsonb is the fragile query nobody gets right under pressure | `wholesale_v2.v2_ranking_config_history` | `check_ranking_config_versioned.sql` (assertion 2) | ✅ |
| 308 | **A change made against the database is recorded as having NO named human, rather than being attributed to a convenient one.** `actor_source` is `app` or `database`, and a row claiming `app` must name an actor — enforced by a check constraint, not a comment | `wholesale_v2.v2_ranking_config_history` | `check_ranking_config_versioned.sql` (assertion 3) | ✅ |
| 309 | **A no-op update is not an event.** Touching a row without changing a value records nothing, so the timeline stays readable — and a timeline nobody can read is the same thing as not having one | `v2_ranking_config_record()` | `check_ranking_config_versioned.sql` (assertion 4) | ✅ |
| 310 | **The record is append-only, enforced twice.** A `before update or delete` trigger raises, AND the grants are revoked. Neither alone is enough: a future `disable trigger` leaves only the grant, a future `grant` leaves only the trigger | `v2_rch_no_rewrite()` | `check_ranking_config_versioned.sql` (assertions 5a, 5b) | ✅ |
| 311 | **The record is hash-chained, and the verifier is proven to DETECT a planted row** — not merely to return "fine". The gate switches the chaining trigger off, inserts a forged row, and asserts the verifier names it. A verifier that has only ever said "intact" is not a verifier | `v2_ranking_history_verify()` | `check_ranking_config_versioned.sql` (assertions 6, 7) | ✅ |
| 312 | **Appends are serialised with an advisory lock.** Two transactions reading the chain head before either inserts would fork the chain — the specific concurrency failure of every naive hash-chained audit | `v2_rch_chain()` | `check_ranking_config_versioned.sql` (assertion 6) | ⚠️ |
| 313 | **Every setting has a baseline row from the moment the record began.** Without it an as-of query for any date before the first *change* returns nothing, which reads as "there were no rules" rather than "the rules were these and nobody had touched them" | `supabase/migrations/101_v2_ranking_config_history.sql` | `check_ranking_config_versioned.sql` (assertion 12), migration 101 assertion 4 | ✅ |
| 314 | **`v2_ranking_config_as_of(when)` — what every ranking number WAS on a given day**, rebuilt from the history and never from the current table. This is the whole point: storage without it is a filing cabinet nobody can open, and reading the current table would be right by luck and wrong the moment it mattered | `v2_ranking_config_as_of()` | `check_ranking_config_versioned.sql` (assertions 11, 12) | ✅ |
| 315 | **A ranking number cannot be changed without a stated reason**, refused server-side and again in the client before the round trip. The same argument already made and won for deactivating a wholesaler in Batch 8A | `v2_ranking_config_set()` | `check_ranking_config_versioned.sql` (9a), `check_ranking_client.mjs` | ✅ |
| 316 | **A typo'd key is refused outright rather than quietly inserted.** A ninth row nothing reads would leave the shelf using its old value with a plausible-looking config row sitting beside it — a change that looks applied and is not | `v2_ranking_config_set()` | `check_ranking_config_versioned.sql` (9b) | ✅ |
| 317 | **The STRUCTURAL half: the ranking functions' own source is versioned too.** Git holds their history but git is not the database — it cannot say which version was LIVE on a given date, and a commit is not a deploy. `pg_get_functiondef`, not `prosrc`, so a change to the signature, return type, volatility or search_path changes the hash | `v2_ranking_model_snapshot`, `v2_ranking_model_hash()` | `check_ranking_config_versioned.sql` (assertion 13) | ✅ |
| 318 | **Forgetting to record a structural change is LOUD.** Change a ranking function in a future migration without snapshotting it and the gate names the function and prints the one command that fixes it | `check_ranking_config_versioned.sql` | itself (assertion 13, red-proved by editing an installed function body) | ✅ |
| 319 | **The owner console screen renders the EXPLANATION as prominently as the number.** `popular_min_buyers = 3` means nothing alone; a screen that shows eight numbers and hides their meaning invites a wrong edit | `js/views/owner-ranking.js` | `check_ranking_client.mjs` | ✅ |
| 320 | **The integrity line is shown whether or not anything is wrong.** A tamper check you only ever see on failure is one nobody knows exists, and its silence cannot be told from it never having run. "Could not check" is a third answer, distinct from "nothing is wrong" | `js/views/owner-ranking.js`, `verifyRankingHistory()` | `check_ranking_client.mjs` | ✅ |
| 321 | **No ranking function reads the promotion table** — restated inside the SR-07 gate rather than left to the RC gates, because this is the file somebody will open when asked whether ranking was neutral, and the answer must not depend on a different file having been run | `v2_popular_now`, `v2_similar_products`, `v2_buy_it_again` | `check_ranking_config_versioned.sql` (assertion 14) | ✅ |

> **Rows 306–321 are SR-07 — the ranking record.** Two migrations (`101`, `102`),
> two new gates (`check_ranking_config_versioned.sql`, 19 assertions;
> `check_ranking_client.mjs`, 25 assertions), each red-proved: ten deliberate
> breaks for the SQL gate, seven for the client one.
>
> **The finding that shaped the design:** nothing in the application had ever
> written to `v2_ranking_config`. Every change to those eight numbers had been
> hand-typed in the Supabase SQL editor. An application-level audit — the
> obvious build, and the one Supabase's own published pattern describes — would
> therefore have recorded **nothing at all**, while looking entirely healthy.
> The recorder is a trigger for that reason.
>
> **Row 312 is deliberately ⚠️.** The advisory lock that stops two concurrent
> appends forking the chain is real and correct, but nothing here demonstrates
> a race — proving it would need two concurrent sessions inside one gate, and
> marking it ✅ on the strength of reading the code is exactly the claim this
> file exists to stop.
>
> **Red proofs worth keeping:** three of the ten deliberate breaks for the SQL
> gate produced ZERO failures, and in every case the break itself had silently
> failed — a comment change that `pg_get_functiondef` does not cover, and two
> statements Postgres rejected outright. The sentinel assertion is what
> distinguished "the gate is blind" from "nothing was actually broken". Without
> it, all three would have read as a blind gate.

| 322 | **The ranking rules are published to the wholesalers they affect** — a page describing what actually decides the order their products appear in, on all four surfaces, in plain language. Reached from the dashboard and from the visibility screen **in both of its states, including the empty one** — a wholesaler with no search data yet is exactly the person most likely to want to read the rules | `js/views/ranking-policy.js` | `check_ranking_policy.mjs` | ✅ |
| 323 | **The published numbers are read live from the database, never typed into the page.** A policy page carrying its own copy is wrong the first time somebody changes a value, and nothing would notice — which turns a page written to build trust into a written misrepresentation. Proven by feeding the page absurd values through the RPC and asserting they render | `v2_ranking_parameters_published()`, `js/data/ranking-policy.js` | `check_ranking_policy.mjs` (red-proved by hardcoding the numbers) | ✅ |
| 324 | **The internal notes are NOT published.** `popular_min_buyers`' own note explains that 3 "is a starting guess for a market with 3 buyers in it" — publishing it would tell every supplier our buyer count. The RPC returns exactly three columns and the assertion reads its declared OUTPUT COLUMNS, not its source text | `supabase/migrations/103_v2_ranking_parameters_published.sql` | migration 103 assertion 2, `check_ranking_policy.mjs` | ✅ |
| 325 | **The page states the narrow true claim about paid placement, not the broad false one.** Search *does* read the promotions table — it is what returns the promoted slot. What cannot happen is paid placement moving an *ordinary* result, and that is what is claimed and what is checked | `js/views/ranking-policy.js` | `check_ranking_policy.mjs` + `check_promoted_slot.sql` | ✅ |
| 326 | **The cap on paid placement is asserted against the constant, not against the sentence.** Raise `PROMO_CAP` and the build fails naming the page that still says three | `supabase/migrations/093_v2_promoted_slot.sql` | `check_ranking_policy.mjs` (red-proved by raising the cap to 8) | ✅ |
| 327 | **"Popular" counting shops rather than sales is asserted from the policy's side too.** The page makes that its central claim to suppliers, so the gate that guards the page checks the ORDER BY as well — a later simplification cannot break the behaviour while leaving the promise standing | `supabase/migrations/099_v2_popular_now.sql` | `check_ranking_policy.mjs` (red-proved by switching to order count) | ✅ |
| 328 | **The indirect question is answered: nothing can be traded for position.** No exclusivity, volume commitment or subscription tier moves an ordinary result. Stated because being told what can be *bought* tells a supplier nothing if position can also be *traded* | `js/views/ranking-policy.js` | `check_ranking_policy.mjs` | ✅ |
| 329 | **Failure to load the numbers says so rather than showing blanks.** "Could not load" and "there are none" are different answers and must not render alike on a page whose whole value is being trustworthy | `js/data/ranking-policy.js` returns `null`, never `{}` | `check_ranking_policy.mjs` (red-proved) | ✅ |

> **Rows 322–329 are SR-05 — publishing how ranking works.** One migration
> (`103`), one new gate (`check_ranking_policy.mjs`, 27 assertions, red-proved
> eight ways), one page in the wholesaler's own navigation.
>
> **The design decision that carries it:** the page holds the prose and the
> database holds the numbers, read live on every render. A ranking policy that
> has drifted from the code is not a stale document — it is a false statement
> made in writing to a supplier about how their livelihood is ordered, which is
> precisely the exposure the 28 August research identified as the one that
> actually reaches a company this size. Self-inflicted, and avoidable in about
> forty lines.
>
> **It did NOT get a navigation entry, and that is the point.** The first draft
> added one; `check_inventory_module.mjs` and `check_wholesaler_onboarding.mjs`
> both went red within seconds — *"the wholesaler sidebar has nine entries (got
> 10)"*. Nine is Hadi's decision from Batch 8B and two gates exist to hold it.
> Bumping them at four in the morning would have been overriding a requirement
> rather than meeting one, so the policy is linked from the dashboard and from
> the visibility screen instead, exactly as SR-06 already does, and the gate now
> asserts the harder property — that the link is there in the EMPTY state too.
>
> **The gate found a real imprecision in its own subject.** Its first draft
> asserted that no ranking function mentions the promotions table. Three do not;
> `v2_search_products` does, because it is the function that returns the
> promoted slot. The true claim is narrower — paid placement cannot move an
> *ordinary* result — and that is now what both the page and the gate say.
> Grepping a whole migration file to ask a question about a function is the same
> mistake as searching for a name to ask a question about a shape.
>
> **And a second red proof produced zero failures.** The break — leaking an
> internal note onto the page — was written as a fallback that the test data
> never triggered. Re-run unconditionally, the gate caught it immediately. That
> is now three times in one night; the pattern is always the same and the
> sentinel, or a value the break must move, is always what settles it.
| 330 | **Every access decision is recorded — and the recorder is a TRIGGER on the tables, not an insert added to the four functions.** One of the four paths was a browser writing to a table with no function to edit at all, and it was the most-used path. Proven by a gate assertion that performs the raw browser UPDATE and requires the log to have caught it | `supabase/migrations/104_v2_access_decision_record.sql` | `check_access_decisions.sql` (assertion 4, red-proved by rebuilding the audit inside the decline function instead) | ✅ |
| 331 | **A request ARRIVING is an event too**, not only its answer. Without the arrival time the log can say who was declined but not how long they waited — which is the number AC-11's SLA needs | `v2_audit_access_request()` | `check_access_decisions.sql` (assertion 1) | ✅ |
| 332 | **Editing a pending request is not an access decision** and records nothing. A timeline nobody can read is the same thing as not having one | `v2_audit_access_request()` | `check_access_decisions.sql` (assertion 2) | ✅ |
| 333 | **A decline REQUIRES a reason**, refused in the database and again in both screens before the round trip. A decline nobody can explain is the complaint that comes back | `v2_decline_signup_request()` | `check_access_decisions.sql` (3), `check_access_decisions_client.mjs` | ✅ |
| 334 | **The reason vocabulary is the database's, not the screen's** — six codes, and `other` cannot be used to get round the requirement | `v2_signup_requests_reason_known`, `..._other_needs_text` | `check_access_decisions.sql` (6a, 6b, red-proved by dropping both constraints) | ✅ |
| 335 | **⭐ The screen's reason list and the database's constraint are asserted to be the same set.** They live in two files nothing else connects; drift means a wholesaler clicks Decline and gets a raw constraint violation they cannot read, with a stranger waiting on the answer | `js/data/decline-reasons.js` ↔ migration 104 | `check_access_decisions_client.mjs` (red-proved by renaming one code) | ✅ |
| 336 | **The reason reaches the LOG, not only the row.** A reason visible only on the request row stops answering "why did we decline this shop in March" the moment AC-10 lets that row be re-used by a re-application | `v2_audit_access_request()` | `check_access_decisions.sql` (assertion 7) | ✅ |
| 337 | **Reject is still a state, never a deletion** — now asserted from the audit side as well. Shopify's reject deletes the company; deleting loses the history and lets the same applicant loop forever | `v2_decline_signup_request()` | `check_access_decisions.sql` (assertion 5) | ✅ |
| 338 | **Declining something already APPROVED is refused**, and the message names the action that actually closes the login. Silently declining it would leave a working buyer login sitting behind a rejected request | `v2_decline_signup_request()` | `check_access_decisions.sql` (assertion 9) | ✅ |
| 339 | **Issuing, revoking and redeeming an invitation are access decisions and are recorded as such.** Invitations are the other way into a locked store and were writing nothing at all | `v2_audit_buyer_invite()` | `check_access_decisions.sql` (10a, 10b) | ✅ |
| 340 | **⭐ The invite TOKEN never reaches the audit log** — it is the credential, and the log is read by more people, and for longer, than the invitation is valid. The shop name and the last four digits of the phone go in instead, so the row still means something to a human | `v2_audit_buyer_invite()` | `check_access_decisions.sql` (11, 11b, red-proved by logging the token) | ✅ |
| 341 | **The decline reason a BUYER is shown is never the internal code.** Telling a shop it was marked `not_a_retailer` in those words is precisely what choosing gentler wording was for; an unknown code still produces a sentence rather than a blank | `declineWordingForBuyer()` | `check_access_decisions_client.mjs` | ✅ |
| 342 | **There is a decline reason that is not the applicant's fault.** Without "not taking new clients right now", a wholesaler at capacity has to pick between telling a real shop "we could not verify you" and "you are not a retailer" — and the buyer reads a judgement nobody made | `js/data/decline-reasons.js` | `check_access_decisions_client.mjs` | ✅ |
| 343 | **Neither screen writes to `v2_signup_requests` any more.** Asserted directly, so the raw path cannot creep back in beside the RPC | `js/data/owner.js`, `js/data/wholesaler-admin.js` | `check_access_decisions_client.mjs` (red-proved by adding the raw write back) | ✅ |
| 344 | **The card is only removed when the decline actually succeeded.** Removing it optimistically tells the wholesaler it worked when the database refused | `js/views/owner.js`, `js/views/wholesaler.js` | `check_access_decisions_client.mjs` (red-proved) | ✅ |
| 345 | **`ask()` gained a `choices` mode instead of the product gaining a second modal.** Escape handling, the focus trap and the resolve-exactly-once rule stay in one place — they were got wrong once already | `js/components/ask.js` | `check_module_syntax.mjs`, and every existing `ask()` caller unchanged | ⚠️ |

> **Rows 330–345 are the access decision record** — AC-08, AC-09 and AC-17. One
> migration (`104`), two new gates (`check_access_decisions.sql`, 16 assertions;
> `check_access_decisions_client.mjs`, 25), red-proved nine ways between them.
>
> **The finding:** three of the four ways a shop gets into a store wrote nothing
> to the audit log. Banning and unbanning a client DO write to it, which is what
> made the gap look like an oversight rather than a decision. And declining was
> not a function at all — it was a browser writing `status = 'rejected'`
> straight to the table, with nowhere to put a reason and nothing to audit.
>
> **Why a trigger and not four function edits.** Red proof B rebuilt the audit
> the obvious way — an insert inside the decline function — and the gate went
> red on assertion 4, because the browser's raw table write produced no audit
> row. That is the argument the migration header makes, demonstrated rather
> than asserted.
>
> **Row 345 is deliberately ⚠️.** The new `choices` mode on `ask()` is exercised
> by both decline screens and every existing caller still works, but nothing
> asserts the select renders and resolves correctly in isolation. Marking it ✅
> on the strength of "the callers pass" is the kind of claim this file exists
> to stop.
>
> **33 lines were removed** from five files, every one a replacement with a
> named successor. Accounted for line by line in `REMOVALS-APPROVED.md`.
| 346 | **A buyer can see where every access request they have made stands** — waiting, waiting too long, approved, or declined with the reason. Until now the answer to "did they even get it?" was nothing at all, in either direction | `v2_my_access_requests()`, `js/views/directory.js` | `check_access_request_standing.sql`, `check_access_request_standing_client.mjs` | ✅ |
| 347 | **⭐ One buyer cannot see another buyer's requests**, at the same wholesaler or anywhere else. The function takes NO person and NO wid — scope is derived inside it — because a rejection is the most private thing in this flow, and a `person_id` argument would let anyone read anyone's | `v2_my_access_requests()` | `check_access_request_standing.sql` (assertions 2, 3, red-proved by adding a `p_person_id` argument) | ✅ |
| 348 | **⭐ Each wholesaler states their own answer time, and it is theirs.** A single platform-wide number would be OGGI promising something a wholesaler never agreed to, and the first slow wholesaler would make OGGI look dishonest | `v2_wholesalers.access_sla_hours` | `check_access_request_standing.sql` (assertion 7, red-proved by hardcoding one global number) | ✅ |
| 349 | **It is shown as an expectation, never a guarantee** — "they usually answer within 2 days", and 48 hours reads as "2 days" rather than "48 hours" | `humanHours()`, `requestStanding()` | `check_access_request_standing_client.mjs` | ✅ |
| 350 | **⭐ None of the four states is a dead end.** Waiting, late, approved and declined each produce a real sentence saying what is happening and what to do. A blank row here is the exact complaint the feature was built from | `requestStanding()` | `check_access_request_standing_client.mjs` (all four asserted, plus no `undefined`/`null` leaking in) | ✅ |
| 351 | **A late request tells the buyer it is late** and that it is worth chasing, rather than leaving them to assume they were ignored | `requestStanding()`, `v2_my_access_requests()` | `check_access_request_standing.sql` (5), `check_access_request_standing_client.mjs` | ✅ |
| 352 | **The buyer never sees the internal reason code** — the wording comes from the one shared list, and a code this build has never heard of still produces a sentence rather than a blank | `js/data/access-requests.js` | `check_access_request_standing_client.mjs` | ✅ |
| 353 | **PB-01: asking for access no longer ends in a dead end.** "Waiting for them to approve you" is replaced by what happens next, how long that wholesaler usually takes, and where to look for the answer | `js/views/directory.js` | `check_access_request_standing_client.mjs` (red-proved by restoring the old sentence) | ✅ |
| 353a | **⭐ …and that holds on the RETURN visit, not only in the second after pressing the button.** The card a buyer sees every time they come back to a wholesaler they already asked carries the same stated time and the same pointer. This shipped half-built on 30 Aug and was caught by grepping the deployed file, not by the gate | `js/views/directory.js` | `check_access_request_standing_client.mjs` §7b (4 assertions, red-proved on the card branch; see GATE-EVIDENCE.md) | ✅ |
| 354 | **The standing list renders ABOVE the directory grid.** A buyer who already asked came back for the answer, not to scroll past their own question | `js/views/directory.js` | `check_access_request_standing_client.mjs` | ✅ |
| 355 | **…and renders nothing at all on a first visit**, rather than an empty box labelled "Your requests" | `js/views/directory.js` | `check_access_request_standing_client.mjs` | ✅ |
| 356 | **AC-11's escalation: the owner can list every request that has aged past its own wholesaler's stated time.** There is no transactional email in this build, so "escalation" is this list and nothing more — claiming a notification would be the overclaim this project keeps a file about | `v2_overdue_access_requests()` | `check_access_request_standing.sql` (8), `check_access_request_standing_client.mjs` | ✅ |
| 357 | **⭐ The overdue list renders BEFORE the onboarding queue's early return.** These requests sit with a wholesaler, not with the owner, so "queue is empty" is true of the owner's queue and false of the buyer's experience — returning early would have hidden every shop being kept waiting | `js/views/owner.js` | `check_access_request_standing_client.mjs` | ✅ |
| 358 | **The overdue list is owner-only.** It is a list of who is keeping shops waiting, and that is not the other wholesalers' business | `v2_overdue_access_requests()` | `check_access_request_standing.sql` (8, red-proved by removing the owner check) | ✅ |
| 359 | **The directory carries each wholesaler's stated time**, so the confirmation can name a real number without one round trip per card — and DR-05 still holds: no price, no product, no count in that projection | `v2_directory_list()` | migration 105 assertion 6, `check_wholesaler_directory.sql`, `check_wholesaler_directory.mjs` | ✅ |
| 360 | **The directory mapper is still an EXACT field set** — seven now, not six. Adding the answer time could not be used as cover for a price slipping in beside it | `js/data/directory.js` | `check_wholesaler_directory.mjs` (red-proved by adding `price_from`) | ✅ |

| 361 | **A shop turned down by a wholesaler can ask again**, and is told so on the screen where they came to find out what happened. Before this, re-applying already worked — instantly, unlimited times — and nothing anywhere said so, so only the buyers who kept clicking got through | `v2_directory_request_access()`, `js/views/directory.js` | `check_access_reapply.sql` (1, 6), `check_access_reapply_client.mjs` | ✅ |
| 362 | **⭐ …and the wholesaler sees the previous application ATTACHED.** This is what AC-10 is for. Blocking a re-application is the lesser half; reviewing the same shop blind for the third time is the complaint | `v2_pending_access_requests()`, `js/components/prior-application.js` | `check_access_reapply.sql` (12), `check_access_reapply_client.mjs` (red-proved by unlinking the chain) | ✅ |
| 363 | **⭐ THE SECOND DOOR WAS FOUND AND CLOSED.** `v2_submit_signup_request` — the sign-in screen's "Don't have an account? Request access" — is also granted to `anon` and also inserts an access request. A buyer inside a cooldown could sign out and use it. Every rule in this block was one sign-out from meaningless | `v2_submit_signup_request()` | `check_access_reapply.sql` (10, red-proved by restoring the old body), migration 106 assertion 7 | ✅ |
| 364 | **⭐ …and the assertion asks the RIGHT question.** The first draft asserted there is exactly ONE anon-callable inserter, which is how the second door was found — by the assertion failing. Counting doors was wrong; the assertion now says every door must walk through the check, and stays right when a third is added | migration 106 assertion 7 | `check_access_reapply.sql`, red-proved | ✅ |
| 365 | **The cooldown depends on WHY they were declined**, not on one number for everything. "We could not verify you" is the buyer's to fix, so it has no cooldown at all — making a shop wait sixty days before sending the details we asked for is punishing them for the thing we asked for | `v2_access_reapply_policy` | `check_access_reapply.sql` (4), migration 106 assertion 4 | ✅ |
| 366 | **"Not taking new clients" is treated as what it is — about us, not them.** Thirty days, no note needed, and more attempts allowed than any other reason | `v2_access_reapply_policy` | `check_access_reapply.sql` (9b) | ✅ |
| 367 | **"You already have an account under another name" refuses with what would ACTUALLY help**, rather than a date. A fourth request does not recover an account; contacting the store does | `v2_access_reapply_standing()` | `check_access_reapply.sql` (7, red-proved by making it re-appliable) | ✅ |
| 368 | **The numbers live in a table, not in a function body.** Migration 101's rule: a number that decides behaviour and is typed into a function is a number nobody can read and nothing records changing | `v2_access_reapply_policy` | `check_access_reapply.sql` (9b — moves the row's number and watches the answer follow) | ✅ |
| 369 | **⭐ A MISSING POLICY ROW NO LONGER PERMITS EVERYTHING.** Found by a red proof that produced zero failures: with no row the whole record is NULL, every guard is a NULL comparison, and the function fell through all three to `ok`. Deleting the `existing_account` row would have let the one refused applicant straight in, silently | `v2_access_reapply_standing()` | `check_access_reapply.sql` (9b), migration 106 §3 | ✅ |
| 370 | **Every decline made before reasons existed is still re-appliable.** Every pre-104 row has `reason_code = null`; without the `__unknown__` policy row, every one of those shops would have been locked out permanently and nothing would have said so | `v2_access_reapply_policy` | `check_access_reapply.sql` (9), migration 106 assertion 3 | ✅ |
| 371 | **Sending the same words again is refused as what it is.** Compared case-insensitively with whitespace collapsed — "the same thing again" is a claim about words, not spacing | `v2_directory_request_access()` | `check_access_reapply.sql` (5, red-proved by deleting the comparison) | ✅ |
| 372 | **A re-application is a NEW row linked to the one it replaces**, never an edit of it. AC-09's rule: the decline stays a state, so the history survives and the same applicant cannot loop forever with nobody able to see it | `v2_signup_requests.supersedes`, `.attempt` | `check_access_reapply.sql` (6, red-proved by dropping both from the insert) | ✅ |
| 373 | **There is an attempt cap, and past it the app says so plainly** rather than offering another date that will not help | `v2_access_reapply_policy.max_attempts` | `check_access_reapply.sql` (8, red-proved by raising the cap out of reach) | ✅ |
| 374 | **⭐ The browser never decides whether a shop may ask again.** Every branch switches on the server's state; the gate forbids date arithmetic and cooldown constants in both client files. Two answers to "may I ask again" means the one the buyer sees is the one developer tools can edit | `js/data/access-requests.js`, `js/views/directory.js` | `check_access_reapply_client.mjs` (red-proved both operand orders) | ✅ |
| 375 | **No declined row is a dead end either.** May ask now, must wait until a date, asking will not help, out of attempts — each produces a real sentence. A decline with nothing after it is PB-01's dead end one step later | `reapplyStanding()` | `check_access_reapply_client.mjs` (all five states, plus no `undefined`/`Invalid Date` leaking in) | ✅ |
| 376 | **One "Ask again" button per wholesaler, on the newest attempt only**, and the older ones fold into history the buyer can still open. Two live buttons for one relationship is one button that lies | `js/views/directory.js`, `v2_my_access_requests()` | `check_access_reapply.sql` (13, 13b), `check_access_reapply_client.mjs` (red-proved by ignoring `superseded`) | ✅ |
| 377 | **Asking again goes through the SAME function as a first application.** One door in the database and one in the browser — a second client helper would be a second place for the note rules to drift | `js/views/directory.js` | `check_access_reapply_client.mjs` (red-proved by inventing a second RPC) | ✅ |
| 378 | **Both review screens share ONE history component.** The wholesaler's queue and the owner console both review access requests; two copies would drift, and the way anyone would find out is one screen deciding without history the other shows | `js/components/prior-application.js` | `check_access_reapply_client.mjs` (red-proved by giving the owner console its own) | ✅ |
| 379 | **…and it renders BEFORE the approve/decline buttons**, so a thumb and a screen reader both meet the context on the way to the decision rather than after it | `js/views/wholesaler.js`, `js/views/owner.js` | `check_access_reapply_client.mjs` | ✅ |
| 380 | **A buyer-typed note cannot inject markup into the wholesaler's queue.** Every line of the history component is `textContent`, which is a stronger guarantee than remembering to call an escape helper | `js/components/prior-application.js` | `check_access_reapply_client.mjs` (red-proved with `<img onerror>`) | ✅ |
| 381 | **The pending queue is an RPC that derives its own scope**, for the wholesaler's screen and the owner console alike. The owner module used to select with no `wid` filter at all and trust RLS by itself — correct today, one dropped policy from being a cross-tenant list | `v2_pending_access_requests()` | `check_access_reapply.sql` (12, 14), `check_access_reapply_client.mjs` | ✅ |
| 382 | **The re-apply policy is not readable by any browser role.** "We decline for X and let you back after N days" is an operating rule, and a shop that can read it picks the reason that comes back soonest | `v2_access_reapply_policy` | `check_access_reapply.sql` (15, red-proved by granting `anon`) | ✅ |
| 383 | **The standing helper is granted to nobody at all.** It takes an identity, so only the definer functions that have already established who is asking may call it — migration 105's rule, kept | `v2_access_reapply_standing()` | `check_access_reapply.sql` (15b), migration 106 assertion 5 | ✅ |
| 384 | **⚠️ THE KNOWN GAP IS ASSERTED, NOT HIDDEN.** The anonymous door matches on a typed shop name, so a different name is a different applicant. Stated as a passing assertion rather than a comment: if somebody makes name matching cleverer, it goes red and they have to decide deliberately | `v2_shop_key()` | `check_access_reapply.sql` (11), migration 106 assertion 13 | ✅ |
| 385 | **…and the normaliser is deliberately dumb.** No stemming, no fuzzy distance. A normaliser that guesses eventually tells a wholesaler they declined somebody they have never seen | `v2_shop_key()` | `check_access_reapply.sql`, migration 106 assertion 13 (both directions) | ✅ |
| 386 | **The "Your requests" list has styles of its own.** It shipped on 30 Aug rendering as a run of unstyled elements — legible, and not a screen. State is on the row as `data-status`/`data-reapply` so a gate need not read the copy | `css/components.css` | `check_contrast.mjs`, `check_token_completeness.mjs` | ✅ |

> **Rows 361–386 are AC-10** — applying again after a decline. One migration
> (`106`), two new gates (`check_access_reapply.sql`, 18 assertions;
> `check_access_reapply_client.mjs`, 46), red-proved **fourteen** ways.
>
> **The finding that reshaped it.** The first draft's own assertion 7 — "there
> is exactly ONE anon-callable function that inserts an access request" — failed
> against production. `v2_submit_signup_request` is a second one, and it is live
> behind a button on the sign-in screen. Every rule in this block would have
> been one sign-out away from meaningless. The assertion was then rewritten to
> ask the right question: not *how many* doors there are, but that **every** door
> walks through the check — which stays true when a third is added.
>
> **The red proof that produced zero failures, again.** Deleting the
> `__unknown__` policy row changed nothing, and the reason was worse than a
> blind gate: with no row the policy record is NULL, all three guards are NULL
> comparisons, and the function fell through to `ok`. **A missing policy row
> silently permitted everything.** Row 369. Sixth time this weekend that "no
> failures" meant "the break did not happen" — and the third time the break
> itself was the finding.
>
> **What is deliberately NOT closed.** The anonymous door can only match a typed
> shop name, so somebody who types a different one gets a fresh request. That is
> row 384, asserted rather than hidden: the point of AC-10 is that no wholesaler
> reviews the same shop blind, not that a determined applicant cannot be
> determined.

> **Rows 346–360 are AC-07, AC-11 and PB-01** — the requester's side. One
> migration (`105`), two new gates (`check_access_request_standing.sql`, 13
> assertions; `check_access_request_standing_client.mjs`, 27), red-proved four
> ways.
>
> **On the registry code.** These are AC-07 and AC-11, and row 353 is also
> **PB-01**. The overnight prompt of 30 August called PB-01/02/03 "the paid
> feed" and deferred them; the 28 August matrix, which is where those codes come
> from, defines PB as *pending buyer*. The paid feed is genuinely deferred by
> Hadi ("scrap the ads thing until we fully launch this") and is untouched.
> PB-01 is the same feature as AC-07 and is built here. **PB-02 and PB-03 are
> not built — they need Hadi**, and that is written into the inventory he was
> given rather than decided quietly.
>
> **The gate needed correcting twice, and the code neither time.** Once because
> an assertion sliced a source file from `indexOf("} else {")` with no start
> offset — finding a match two thousand characters *before* the block it meant
> to read, and failing two assertions about code that was correct. And once
> because a red proof that set every wholesaler's answer time to one value was
> undone by the gate's own fixture, which sets them explicitly; re-aimed at the
> function, it fired immediately. **Fourth and fifth time this weekend that the
> answer to "no failures" was "the break did not happen".**

| 387 | **⭐ APPROVING A SHOP NOW ACTUALLY LETS THEM IN.** `v2_approve_signup_request` never wrote a membership, and a membership is the only thing that puts a store in the buyer's switcher, opens it, or makes the directory say "you have access". Approval granted nothing | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (2, red-proved by restoring the pre-107 body) | ✅ |
| 388 | **…and the buyer's OWN SESSION can open the store**, proven through `v2_session_account` with a real token rather than by observing that a row exists. A membership that does not open the door is the same defect one layer down | `v2_session_account()` | `check_approval_grants_access.sql` (3, red-proved by writing the membership inactive) | ✅ |
| 389 | **…and it appears in their store switcher**, which is where they will actually look for it | `v2_session_stores()` | `check_approval_grants_access.sql` (4) | ✅ |
| 390 | **⭐ The directory and "Your requests" now AGREE.** Before 107 one said "Approved — you can shop here now" and the other offered the Ask button again, three days after that sentence shipped | `v2_directory_list()` | `check_approval_grants_access.sql` (5) | ✅ |
| 391 | **⭐ No second credential for somebody who already signs in to OGGI.** Two logins for one human at one company is how "who is this shop" stops having one answer | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (6, 6b — red-proved with a hash of the empty string) | ✅ |
| 392 | **…and the account behind that membership cannot be signed into at all** — a bcrypt hash of a random secret nobody ever sees, not a sentinel, because `crypt()` RAISES on an invalid salt and a junk value would turn every login attempt into a 500 instead of a refusal | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (6b, tries the empty password, the username, and "password") | ✅ |
| 393 | **⭐ The applicant with NO OGGI account keeps exactly what they had** — a store-scoped login and a one-time password — because there is nobody to grant a membership to. Proven by *signing in with the password the function just issued*, not by seeing a string come back | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (8, 8b, 8c — red-proved by removing the password) | ✅ |
| 394 | **A store that exists in v1 with no marketplace record refuses in words**, rather than dying on a foreign key in front of a wholesaler | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (10, red-proved by deleting the check — it raises) | ✅ |
| 395 | **Approving twice is refused**, so a double click cannot mint a second account and a second client row | `v2_approve_signup_request()` | `check_approval_grants_access.sql` (9) | ✅ |
| 396 | **Migration 104's decision recorder survived the rewrite.** AC-17 asks "who let this shop in", and 107 rewrote the function that answers it | `v2_audit_access_request()` | `check_approval_grants_access.sql` (11, 12) | ✅ |
| 397 | **No backfill was attempted, and the migration refuses to install quietly where the defect has already bitten.** Nothing records which portal account belongs to which approved request, so a repair would have to guess by matching a shop name — and a fragile repair is how a wrong membership gets written to somebody's account | migration 107 assertion 7 | migration 107, self-asserting | ✅ |
| 398 | **⭐ One approval panel, both review screens**, replacing two hand-rolled copies that had already drifted in wording, in labels, and in the surface token one of them used | `js/components/approval-result.js` | `check_approval_grants_access_client.mjs` (red-proved by giving the owner console its own back) | ✅ |
| 399 | **No empty password box**, ever. When there is nothing to send the panel says so, instead of rendering `Username: null` and sending a wholesaler hunting for a string that was never minted | `js/components/approval-result.js` | `check_approval_grants_access_client.mjs` (red-proved by rendering it unconditionally) | ✅ |
| 400 | **…and no silent drop the other way.** When there IS a password this is the only time it will ever be visible — the database keeps its hash | `js/components/approval-result.js` | `check_approval_grants_access_client.mjs` (red-proved by hiding it) | ✅ |
| 401 | **Half a response is not a credentials outcome.** A username with no password is the shape a partial failure takes, and a box with one field filled is worse than no box | `js/components/approval-result.js` | `check_approval_grants_access_client.mjs` (both halves asserted, red-proved) | ✅ |
| 402 | **The panel is built entirely with `textContent`** and imports no escape helper — a sink that cannot parse markup beats one somebody has to remember to call. Both copies it replaces used `innerHTML`, and a generated username is derived from a shop's own name | `js/components/approval-result.js` | `check_approval_grants_access_client.mjs` (red-proved with `<script>` and `<img onerror>`) | ✅ |
| 403 | **⭐ The token gate now reads `js/` as well as `css/`.** This app writes a great deal of style inline from JavaScript, and the gate had never looked there. `--surface-sunken` was referenced in five inline styles across four files, has never been defined, and had been falling back to a hardcoded grey for weeks | `checks/check_token_completeness.mjs` | itself, red-proved four ways | ✅ |
| 404 | **…and the eleven it found are allowlisted by name, not hidden.** A twelfth fails; so does any of them appearing in a stylesheet; so does an allowlist entry no longer used anywhere, so the list shrinks as they are fixed and cannot rot | `checks/check_token_completeness.mjs` | itself (red-proved: a new token, a stale entry, a stylesheet use, a deleted definition) | ✅ |

> **Rows 387–404 are the approval fix and the token gate** — migration `107`,
> two new gates (`check_approval_grants_access.sql`, 17 assertions;
> `check_approval_grants_access_client.mjs`, 29), red-proved **eighteen** ways.
>
> **This was not on the plan.** It was found doing a code census for AC-12
> (auto-approve rules) and AC-12 was stopped for it, because auto-approve means
> approving with nobody in the room and wiring a rule to that function would
> have multiplied the defect across every buyer, silently.
>
> **Two assertions in these gates were wrong, and the code was right both
> times.** One guessed at the SHAPE of a credential inside free text and fired
> on ordinary prose. The other signed in with a username belonging to a
> different store, so it failed for the wrong reason and would have passed with
> the account's password set to a hash of the empty string — found by a red
> proof that produced zero failures, the **seventh** time this weekend that "no
> failures" meant "the break did not happen".
>
> **Row 397 is a deliberate absence.** Production has zero approved requests, so
> there is nothing to repair; anywhere else, the migration stops and gets a
> person looking rather than guessing which account belongs to which request.

| 405 | **⭐ A REQUEST CAN NOW BE ANSWERED.** The public "Request access" form collected no phone and no email, so a wholesaler could approve a shop and then had nobody to send the minted password to. Live since Batch 4; never noticed, because production has zero approved requests | `js/views/login.js`, `v2_submit_signup_request()` | `check_access_reapply.sql` (10c), `check_access_reapply_client.mjs` (red-proved by removing the field, the refusal, and the argument) | ✅ |
| 406 | **The number is VALIDATED, not merely collected**, through the same `v2_normalise_channel` the rest of the schema uses — so "12" and "call me" are refused rather than stored as a contact detail that is not one. One definition of "is this a phone number" in the schema, not two | `v2_submit_signup_request()` | `check_access_reapply.sql` (10d, red-proved) | ✅ |
| 407 | **⭐ The normalised key is a GENERATED COLUMN**, not something a function remembers to compute. `v2_normalise_channel` is IMMUTABLE, so Postgres holds it — and no second insert path, no hand-typed UPDATE, and no future function can make the key disagree with the raw value | `v2_signup_requests.phone_key` | migration 108 assertion 1 | ✅ |
| 408 | **⭐ …and it narrows the gap AC-10 had to leave open eight hours earlier.** A re-application through the anonymous door now matches on the number, so renaming the shop no longer escapes the cooldown. Precedence is person, then phone, then name | `v2_access_reapply_standing()` | `check_access_reapply.sql` (10b, red-proved by dropping the phone from the precedence) | ✅ |
| 409 | **The residual gap is still asserted rather than hidden.** A different name AND a different number is a different applicant, and that line is a passing assertion so the next person to make matching cleverer has to decide deliberately | `v2_access_reapply_standing()` | `check_access_reapply.sql` (11) | ✅ |
| 410 | **An unusable number does not silently become a match key.** "12" normalises to null and falls back to the name, rather than matching every other applicant who also typed nonsense | `v2_access_reapply_standing()` | migration 108 assertion 5, red-proved | ✅ |
| 411 | **Both review screens show the number, as something you can press to call**, and a request made before 108 says why it has none rather than rendering a blank that reads like a fault | `js/views/wholesaler.js`, `js/views/owner.js` | `check_access_reapply_client.mjs` (red-proved separately on each screen) | ✅ |
| 412 | **The buyer-typed number is stripped before it reaches a `tel:` href.** It is a string a stranger typed, going into an HTML attribute | `js/views/wholesaler.js`, `js/views/owner.js` | `check_access_reapply_client.mjs` (red-proved) | ✅ |
| 413 | **⭐ THE SHAPE HASH HAD BEEN TRUNCATING EVERY SIGNATURE TO 63 CHARACTERS.** `c.relname` is of type `pg_catalog.name`, a fixed 64-byte type, and in a UNION Postgres resolved the whole column to it — so every function signature was cut before hashing. The repo's sharpest structural instrument was blind to any change past character 63, which in this schema is most of them | `checks/replay_migrations.sh` | itself, and the measurement below | ✅ |
| 414 | **…proven, not argued.** Two replays with identical object counts (104/4/161/96) and two differing function signatures produced the SAME old hash (`61d82639…`) and DIFFERENT corrected hashes (`e656498f…` vs `7801271d…`) | `checks/replay_migrations.sh` | measured on both databases | ✅ |
| 415 | **…and a canary stops it coming back.** If the cast is ever lost, every long signature collapses to exactly 63 characters, so `max(length)` drops to 63 and the script refuses to print a hash at all rather than printing one that cannot be trusted | `checks/replay_migrations.sh` | red-proved by removing the cast — it fires | ✅ |
| 416 | **The baseline was re-measured on both sides before being moved.** Corrected hash of the repo at 107 and of PRODUCTION at 107 are identical (`e656498f…`), which is what proves the two had not diverged and that 108 is precisely the one migration outstanding | `checks/replay_migrations.sh` | measured on the replay and on production with the same query | ✅ |

> **Rows 405–416 are migration 108 and the truncation defect.** One migration,
> no new gate files — the two AC-10 gates were extended instead, because the
> question "can this request be answered" belongs beside "may this shop ask
> again", and a third file asserting on the same two functions would drift.
>
> **Row 413 is the largest instrument failure found this weekend.** The shape
> hash is described in `replay_migrations.sh` as *"the sharper half… a
> substitution that happens to preserve the counts still moves it."* It did not.
> Migration 108 changed three function signatures and added a column, and the
> gate printed **"MATCHES the production baseline exactly, shape included."**
>
> **⚠️ 108 IS THE ONE MIGRATION THIS WEEKEND NOT APPLIED TO PRODUCTION FIRST.**
> It makes the phone required, and the deployed sign-in screen has no field to
> type one into, so applying it early would break that form for as long as the
> pull request sat unmerged. It goes on AFTER the code. Until then production
> will not match the baseline, and that is correct rather than a fault.

| 417 | **A wholesaler can invite a whole list of shops at once** — paste them one per line, however they are already written, and each gets its own link. Forty existing customers was forty separate presses and no export | `v2_issue_buyer_invites_bulk()`, `js/views/wholesaler.js` | `check_bulk_invite.sql` (2, 3), `check_bulk_invite_client.mjs` | ✅ |
| 418 | **⭐ Bulk is a LOOP OVER the function that already issues one**, never its own insert. That function clamps the expiry, stamps `created_by`, re-checks the wid inside itself and fires migration 104's audit trigger — a second insert path would drift on all four, and the audit is the one that would be missed silently | `v2_issue_buyer_invites_bulk()` | `check_bulk_invite.sql` (11 — a 9999-day request comes back clamped; red-proved with a bulk path that inserts for itself) | ✅ |
| 419 | **⭐ A shop already invited gets the SAME link back, not a second token.** Two live invitations for one shop means withdrawing the one you can see leaves the other working — the worst shape for a thing whose job is to let somebody in | `v2_issue_buyer_invites_bulk()` | `check_bulk_invite.sql` (4, red-proved by removing the guard) | ✅ |
| 420 | **…matched on the normalised NUMBER**, so a shop retyped with a different name is still the same shop — and on the same normaliser the rest of the schema uses, not a second idea of what one number is | `v2_normalise_channel()` | `check_bulk_invite.sql` (4b, red-proved by matching the raw string) | ✅ |
| 421 | **A withdrawn or expired invitation does not block a fresh one.** Withdrawing somebody is not a ban, and treating it as one would lock a shop out permanently by accident | `v2_issue_buyer_invites_bulk()` | `check_bulk_invite.sql` (5, red-proved) | ✅ |
| 422 | **⭐ Every pasted line comes back, in order, including the failures.** A bulk operation that silently drops rows is a wholesaler believing they invited forty shops when they invited thirty-eight, and never learning which two | `v2_issue_buyer_invites_bulk()`, `js/views/wholesaler.js` | `check_bulk_invite.sql` (6, 6b), `check_bulk_invite_client.mjs` (red-proved by rendering only the successes) | ✅ |
| 423 | **The batch is capped at 200, in the function rather than in the screen.** Ten thousand rows pasted by accident is a wholesaler's mistake; ten thousand live tokens is the product's | `v2_issue_buyer_invites_bulk()` | `check_bulk_invite.sql` (9, 9b — and the refused batch mints nothing) | ✅ |
| 424 | **The audit fires once per invitation, not once per batch.** Migration 104 made issuing one an access decision, and bulk must not be a way to issue many without a record | `v2_audit_buyer_invite()` | `check_bulk_invite.sql` (8), and 8b — no token reaches the log | ✅ |
| 425 | **⭐ The results are NOT destroyed to refresh a list.** Repainting the card rebuilds its innerHTML, which would take every link with it. The links are the deliverable; the list underneath is a convenience and is one page load out of date | `js/views/wholesaler.js` | `check_bulk_invite_client.mjs` (red-proved by adding the repaint back) | ✅ |
| 426 | **The pasted line is parsed with the number at the END, not by splitting on the comma.** A shop name may contain one ("Rita, Beirut") and a phone number may not — splitting puts half the shop name in the phone column | `parseInviteLines()` | `check_bulk_invite_client.mjs` (six shapes asserted; red-proved with a comma split, which yields phone="Beirut") | ✅ |
| 427 | **The exported CSV is quoted, and embedded quotes are doubled.** A shop name with a comma would otherwise shift every column after it, and the wrong shop would get the wrong link | `invitesCsv()` | `check_bulk_invite_client.mjs` (red-proved by removing the quoting) | ✅ |
| 428 | **The single-invite form finally collects the shop's phone.** `v2_issue_buyer_invite` has taken one since migration 089 and the column has existed just as long — the screen never asked, so `phone` is null on every invitation this product has ever issued | `js/views/wholesaler.js` | `check_bulk_invite_client.mjs` (red-proved by dropping it at the call site) | ✅ |
| 429 | **AC-06 was already built, and the registry was wrong.** It records "invited, not yet accepted" as ⚠️ *state exists, no resend button*. A waiting invitation has carried WhatsApp, Copy link and Withdraw since 29 August — and for an invitation "resend" IS the WhatsApp button, because the link never changed. Corrected here rather than built twice | `js/views/wholesaler.js` | `check_wholesaler_onboarding.mjs`, `check_bulk_invite_client.mjs` | ✅ |

> **Rows 417–429 are AC-05, and row 429 is AC-06 corrected rather than built.**
> One migration (`109`), two new gates (`check_bulk_invite.sql`, 18 assertions;
> `check_bulk_invite_client.mjs`, 28), red-proved eleven ways.
>
> **The census came first and changed the work.** AC-06 was listed as missing a
> resend button; it has had one since 29 August. Building it again would have
> produced a second control doing what an existing one already does. This is the
> same failure `docs/OUTSTANDING.md` §1 records — a document saying the
> inventory revamp had not started while seven batches of it were shipping — and
> the reason that file carries a date at the top.
>
> **Row 418 is the assertion worth understanding.** Nothing else in the gate
> could tell a delegating bulk path from one that inserts for itself: the audit
> trigger is on the TABLE, so it fires either way, and every other assertion
> still passes. The expiry clamp lives only inside `v2_issue_buyer_invite`, so
> asking for 9999 days and getting 180 back is the one observable difference —
> which turns "bulk is a loop over the single-invite function" from a comment in
> a header into something a machine checks.

## Reconciliation — 30 August 2026 (SR-07, SR-05, AC-08/09/17, AC-07/11 + PB-01) and 28–29 August 2026 (Batch S, Batch N 1–4, the Client View gaps, AC-01, Door A, ID-01)

| | |
|---|---|
| Features listed | **429** |
| Enforced and proven (✅) | **411** |
| Present but unproven (⚠️) | **18** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

> **Rows 147–154 are the Client View gap pass**, and they exist because a line
> in `CLAUDE.md` was wrong. It said the live buyer view "still shows one colour
> at a time and does not match the approved mockup"; it had been repeated in
> four consecutive session logs and it was **false** — every colour has been its
> own row since PR #21 on 25 Aug. The session that set out to rebuild it read
> the component instead of the note, found four real gaps, and then found a
> fifth thing nobody was looking for: **CR-0008, row 153, every pack line in
> every real cart priced at $0.00.** The false line is now corrected in
> `CLAUDE.md`. Full audit: `[C] CLIENT VIEW — Gap Audit, Plan & Feature List
> (Aug 28 2026).md`.
>
> **Still open and deliberately not built:** the mockup puts a `− 0 +` inside
> every size cell; what shipped is tap-a-cell-to-aim plus one control at the
> foot. That reversal was argued on 25 Aug for two real reasons — eight sizes ×
> a cell wide enough for `− 12 +` is 720px on a 412px phone, and writing on
> every press is ~48 server round trips per sheet. Row 149 delivers the
> immediacy the mockup was really providing (a live total) without either cost,
> so the rebuild waits until Hadi has walked it on a phone.

> **Rows 128–134 are Batch N step 1 — the buyer's note.** Seven features, one
> migration (`086`), one new gate (`check_order_notes.sql`, seven cases,
> red-proved twice). Row 133 is deliberately ⚠️: notes surviving a page reload
> is real behaviour with no automated assertion behind it yet, and marking it ✅
> would be the kind of claim this file exists to stop.

> **A note on the dates in this batch.** Everything above `085` — migrations
> `080`–`083`, their gates, and the CR-0007 entry as first written — carries
> *25/26 August* because the session clock was running behind. The real date of
> this reconciliation, and of the S7/S8/S9 measurements in it, is **28 August
> 2026**, confirmed against the machine clock, the container clock and an HTTP
> `Date` header from the database's own host, which agree. The earlier files are
> left as they are: rewriting merged history to chase a date does more damage to
> a ledger than a known-wrong date does, and this note is the correction.

**Row 104 is the one to read first, and it is now ✅.** It is the signed-out
probe: what production hands a stranger who has nothing but the key that ships
inside the app. On 25 August the honest answer was 23 products, 264 variants and
143 stock rows across **six different wholesalers**. On 28 August, after `085`
was applied to production, all seven tables answer **HTTP 401, denied outright**,
and a stranger can enumerate no wholesaler's products at all.

**It flipped only because the probe was re-run against production and answered
with nothing** — not because `085` exists, and not because the local replay was
clean. The replay could never have proved this: the repo's own migrations never
granted those tables, so the replay was green on them from the start while
production leaked. That gap between "the repo says" and "the database does" is
the whole reason row 104 is a live probe and not a code check.

**Row 125 is the other half and must never be separated from it.** A shut door
and a shut shop look identical from outside. `check_buyer_path_survives.sh` asks
the opposite question through the same front door — and answers it: 4 catalogues,
74 catalogue rows, 44 rows through a share link, 3 cart prices, and **nothing at
all** in every direction that crosses a tenant boundary.

**What S7 turned out to be about.** S0 read like seven forgotten `grant`
statements. It was not. Grep the whole migration folder and there is no
`grant select on v2_products to anon` — the repo never granted those tables.
`026_v2_move_to_dedicated_schema.sql:173` did, once, and not as a grant:

    alter default privileges in schema wholesale_v2
      grant select, insert, update, delete on tables to anon, authenticated;

That is a standing rule. Every table created in this schema since has arrived
readable **and writable** by a signed-out stranger on its first day, before
anyone wrote a policy for it. So `085` does two separate things — revoke what is
open today (row 121) and revoke the rule that opens tomorrow's table (row 122) —
and doing only the first would have been worse than useless: the next
`create table` reopens the leak with every gate still green.

**Rows 105–120 are the shop being rebuilt before the door was shut.** Every read
the buyer app makes — catalogue, packs, tiers, discounts, and finally the cart's
price lookup — moved onto a `SECURITY DEFINER` function that re-checks the share
token or the validated portal account inside itself. The revoke is last on
purpose: run it earlier and every catalogue on the platform goes blank in the
same second.

**Row 124 is the gate's own near-miss, kept because it was nearly a false
green.** The first draft of `check_anon_grants.sql` read only `pg_class.relacl`.
A deliberate `grant select (price) on v2_product_variants to anon` passed it
without a murmur — column grants live in `pg_attribute.attacl`, and migration
`032` uses precisely that form. A gate nobody has watched fail is not a gate;
this one has now been made to fail eight different ways, each undone before the
next was tried.

**One capability is deliberately removed and is recorded as CR-0007**: the sales
rep's product picker (`listVariantsForPicker`) read `v2_product_variants` with
no wholesaler filter at all and stops returning rows. Zero salesperson accounts
exist, and every wholesaler in the system is a test one. S6 rebuilds it gated.

## Reconciliation — 25 August 2026 (CV-01, the order sheet, superseded)

| | |
|---|---|
| Features listed | **98** |
| Enforced and proven (✅) | **89** |
| Present but unproven (⚠️) | **9** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

The order sheet replaced the chip-then-stepper on open-stock products. **Zero
capabilities were lost**, and that is a measured statement rather than a hope:
`check_buyer_card_capabilities.mjs` was written and made green against the OLD
card first, then re-run against the new one. It was red-proved three ways
before being trusted — dropping the next-tier nudge, letting an out-of-stock
size be ordered, and making the stepper forget the base unit — and each named
the capability it had lost.

Two existing gates went red on the rewrite and **neither was softened**.
`check_buyer_product_card.mjs` drove a size chip and read a number input;
`check_buyer_card_capabilities.mjs` asserted "a chip per size". Both described
the CONTROL rather than the capability, so both were rewritten in this same
commit, with the reason written into the file. One assertion was genuinely
retired: typing a part-unit and watching it round up. Typing is gone, and the
guarantee it gave is now structural — row 97.

## Reconciliation — 25 August 2026 (CR-0004, superseded)

| | |
|---|---|
| Features listed | **90** |
| Enforced and proven (✅) | **81** |
| Present but unproven (⚠️) | **9** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

CR-0004 added rows 84–90 and removed exactly one behaviour, deliberately and
with approval: the buyer card's fallback to `product.primaryImage` for a colour
with no photograph of its own. It is recorded in `REMOVALS-APPROVED.md` in
Hadi's words. It is a REMOVAL, not a loss, and the distinction is the whole
point of this file: the line was harmless only while every colour of a product
carried an identical gallery, and became the bug that shows a buyer the black
jean while they order the brown one the moment colours could genuinely differ.

Rows 84–89 are, strictly, the closing of a **v1 regression** this repository had
already logged against itself in `js/data/products-admin.js`: *"v1 attached one
photo per COLOUR, which is the better end state — noted rather than
half-built."* It stayed half-built for the reason the note gives, which had
stopped being true: the form had been recording the mapping all along.

Row 88 exists because a red-proof **failed to go red.** Collapsing the uploaded
urls with `.push()` instead of holding their position passed every assertion
here, because every fixture uploaded successfully. The bug only appears when one
upload fails mid-strip, and then it does not drop a photograph — it hands the
next colour's to the previous one. A fixture with a failing upload was added,
and only then did the red-proof bite.

## Reconciliation — 23 August 2026 (superseded)

| | |
|---|---|
| Features listed | **83** |
| Enforced and proven (✅) | **74** |
| Present but unproven (⚠️) | **9** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

Batch 8A (23 Aug, later the same day) added rows 72–75 and one finding worth
recording separately, because it is an instance of this file's own subject:

**`check_route_state.mjs` passed, all twenty assertions, while the code was
broken.** `router.go()` had been added inside `catalogsView()` and
`js/views/wholesaler.js` never imported `router` — the name only *looked*
bound because `registerWholesalerRoutes(router)` takes it as a parameter at
the bottom of the file. `check_imports_resolve.sh` passed too: it resolves the
paths of imports that exist, and this was an import that did not. At runtime
the catalog tab would have thrown ReferenceError and done nothing — the exact
symptom the batch was fixing. Row 75 is the gate written for it, red-proven by
deleting the import and watching it name both lines.

Batch 8B added rows 76–78. Row 78 is marked ⚠️ **deliberately**: the gate can
assert that the fade rule exists and that the reveal is called, and it cannot
assert that nine tabs are usable with a thumb. That is a judgement only a
person holding the phone can make, and it is Hadi's to make before this is
called finished. A green gate on row 78 means the mechanism is present, not
that the design works.

CR-0001 (24 Aug) added rows 79–82 and removed two builders — recorded in
`REMOVALS-APPROVED.md` rather than done quietly. Two things worth keeping:

**The whole suite stayed green while 253 lines of UI were deleted.** 37 of 37.
Not one gate covered the thing being removed, which is why `check_order_setup.mjs`
exists. **And the first draft of the replacement silently dropped the "Add
colours & sizes" way out of the empty state** — `check_packs_panel_reachable.mjs`
caught it, because its assertions were re-aimed at the new file instead of
deleted along with the old one. Re-aiming a gate rather than retiring it is the
difference between a replacement and a loss.

**Rows 80 and 83 were rewritten the same day, because the first version of
row 80 was a REGRESSION and Hadi found it within the hour.** The builder that
CR-0001 deleted could create any number of arbitrary packs. What replaced it
could express exactly two shapes — one mixed box, or one box per colour — and
`check_order_setup.mjs` passed, because it had been written to match the new
design rather than to preserve the old capability. Writing a gate around your
own intention is how a feature-loss check goes green on a feature loss. The
gate now asserts that adding boxes is unbounded, and was proven red by capping
the panel at one box.

**Row 80 was rewritten again the same day**, to the three kinds Hadi actually
names out loud — Full box, By colour, By size. "By size" (one size, every
colour) could not be expressed at all before, in any version of this screen.
The kinds are **not stored**: reopening a saved pack works out which editor to
show from the data — one colour means by-colour, one size means by-size — so
nothing needed migrating and packs built before today open in the right place.

**And the preservation check was tightened for the third time.** "Suggest from
what sells" and the saved-ratio library have now fallen out of three
consecutive rewrites of this panel. The check asked only whether the NAME
appeared in the file, which an unused `import` satisfies — so it stayed green
through a rewrite that dropped both. It now renders the panel and looks for the
button in the DOM, and was proven red by building the button and never
appending it.

Batch 8 (23 Aug) added rows 15–21. None of the three is a new capability:
the selling models have been enforced since 15 August and the ratio editor has
existed since 20 August. All three were **unreachable or invisible**, which the
manifest had no way to express — a feature can be present, gated, and still
impossible to use. Rows 15–18 exist so that stays checkable.

Row 18 was added the same day, hours later, because rows 15–17 were **not
enough**. The drawer opened correctly and the builder inside it was still
unreachable on Catalogs: `getCatalogProducts` fetched the variants and did not
return them, so the builder saw zero sizes on every product. Batch 8C's gate
tested the "no variants" branch and never the success path — the same
acceptance-cases-are-dead failure this file records about `check_pack_moq.sh`,
committed again three days after it was written down.

**A ⚠️ is not a bug.** It means: this exists, and nothing would tell you if it
stopped existing. That is the backlog — every ⚠️ turned into a ✅ is one more
thing that cannot silently disappear.

The honest headline: **56 of 64 features have a gate.** On 15 August it was 17
of 32. The count grew because seven batches shipped, not because the bar moved.

## Known silent-loss vectors

1. ~~`js/data/csv-import.js` hardcoded `sellMode: "open"`.~~ **Fixed 15 Aug.**
2. ~~`pack_price` is stored and never applied.~~ **Decided 21 Aug (D4):** it is a
   note, not a price. `js/data/prepacks.js` no longer folds it into `price`,
   the wholesaler's field says so on screen, and `check_line_pricing` asserts a
   pack with a flat price set is still charged per piece.
3. **The cart snapshots pack composition at add-to-cart time.** Editing a pack
   while it sits in a cart fails checkout (correct since migration 028) with an
   unhelpful message. Still true; still needs a "this pack changed, review your
   cart" path.
4. **Buyer-role RLS parity.** Any table the buyer catalogue or cart reads must
   carry the same `(auth.uid() is null)` read allowance that `v2_products` does,
   because buyers authenticate outside Supabase Auth and have no `auth.uid()`.
   A table that omits it is invisible to buyers with NO error — exactly how the
   pack-definitions gap hid until migration 033.
5. **A migration applied without its file.** Happened twice: 028/030/031/032
   (found and back-filled), then 035/036/038 (found 21 Aug, and the earlier
   back-fill had missed them). `check_migration_chain.mjs` now fails on a gap in
   the numbering, so a third time cannot be quiet.
6. **A migration applied with its comments stripped.** `pg_proc.prosrc` then
   differs from the repo file while behaving identically, so a naive md5
   comparison cries wolf and a careless one misses a real change. Compare
   normalised bodies (comments removed, whitespace collapsed). Seen on 078 and
   on 043's `v2_create_wholesaler`.

## Repo/DB drift — CLOSED 21 August 2026

The 15 August addendum said: *"The repo `supabase/migrations/` files stop at
`029` and skip `028`, `030`, `031`, `032`… Back-fill from the live DB so the
repo can rebuild the database from scratch."*

That back-fill happened, and **left three more behind** — 035, 036 and 038 —
which nothing noticed for four days. All three are now recovered verbatim from
`supabase_migrations.schema_migrations`, and four further replay blockers were
found and fixed (see `checks/check_migration_chain.mjs` for the full account).

**Proven, not asserted:** `checks/replay_migrations.sh` replays all 80 migrations
into an empty Postgres 16 and the result matches production exactly —
tables 89, views 4, functions 91, policies 89, and a shape hash over every table,
view and function signature of `cda9046cd410a2b39eb57ea7923b623d` on both sides.
