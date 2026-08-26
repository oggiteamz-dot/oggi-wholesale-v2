# Feature Manifest — OGGI Wholesale v2

**Last reconciled: 23 August 2026** (previous: 15 August — six days and seven
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
| 104 | **A stranger with the app's own key gets nothing from the buyer tables** — products, variants, packs, pack components and stock all refuse an anonymous caller | the database's grants, not `js/**` | `check_anon_scope.sh` — asks production signed out with the key read out of `supabase-client.js`, so it follows a key rotation instead of testing a dead one. **RED as of 25 Aug: 23 products / 264 variants / 143 stock rows across 6 wholesalers.** Turns green at S7. ⚠️ **RED on purpose until then** — it is the measurement Batch S exists to change, and it is listed here precisely so that nobody reads its redness as a broken build | ⚠️ |
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

---

## Reconciliation — 26 August 2026 (Batch S, S0–S7)

| | |
|---|---|
| Features listed | **124** |
| Enforced and proven (✅) | **114** |
| Present but unproven (⚠️) | **10** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

**Row 104 is the one to read first, and it is still ⚠️ at the moment this line
was written.** It is the signed-out probe: what production hands a stranger who
has nothing but the key that ships inside the app. On 25 August the honest
answer was 23 products, 264 variants and 143 stock rows across **six different
wholesalers**. It flips to ✅ only when that probe has been re-run against
production after `085` and answered with nothing — not when `085` exists, and
not when the local replay is clean.

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
