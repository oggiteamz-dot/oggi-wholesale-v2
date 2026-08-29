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

## Reconciliation — 28–29 August 2026 (Batch S, Batch N 1–4, the Client View gaps, AC-01, Door A, ID-01)

| | |
|---|---|
| Features listed | **227** |
| Enforced and proven (✅) | **214** |
| Present but unproven (⚠️) | **13** |
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
