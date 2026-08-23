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
| 20 | **A product with no variants can still be given a ratio** — the panel offers "Add colours & sizes" and returns to the builder | `js/views/wholesaler.js` (`renderRatioSection`) | `check_packs_panel_reachable.mjs` — the four dead-end assertions | ✅ |

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
| 21 | Quantity breaks (tiers), aggregated across colourways | `migrations/010`, `js/data/pricing.js` | `check_price_agreement.mjs` (23) + `check_catalog_pricing.sql` | ✅ |
| 22 | Per-client negotiated prices | `js/data/client-pricing.js`, `migrations/048,049` | `check_price_override_isolation.mjs` | ✅ |
| 23 | Catalog + customer discount, three modes | `migrations/053` | `check_catalog_pricing.sql`, `check_price_agreement.mjs` | ✅ |
| 24 | **The cart total equals the invoice total** | `js/data/line-pricing.js` | `check_line_pricing.mjs` (48) + `check_line_pricing.sql` (6, against production) | ✅ |
| 25 | **Bulk reprice: preview, atomic, undoable** | `migrations/078`, `js/data/pricing-bulk.js` | `check_bulk_price_safety.sql` (9) | ✅ |

## Catalogue and stock

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 26 | **Colour × size variants** | `v2_product_variants.extra_attrs` | `check_data_invariants.sql` §2 | ✅ |
| 27 | No duplicate (product, colour, size) | — | `check_data_invariants.sql` §2 | ✅ |
| 28 | Multi-location stock | `v2_inventory_balances` | `check_data_invariants.sql` §3 | ✅ |
| 29 | Reservations cannot exceed stock | `v2_confirm_reservation` | `check_data_invariants.sql` §3 | ✅ |
| 30 | **Expired cart holds never suppress real stock** | `migrations/064,065` | `check_reservation_expiry.sql` (6) + `check_no_stale_reserved_reads.sh` | ✅ |
| 31 | Stock transfers between locations | `migrations/047` | `check_locations_transfer.mjs` | ✅ |
| 32 | Pack integrity (components, same product) | `migrations/011` | `check_data_invariants.sql` §4 | ✅ |
| 33 | **The stock movement ledger is visible** | `migrations/071`, `js/views/wholesaler.js` movements pane | `check_movement_ledger.sql` (8) | ✅ |
| 34 | **Movement partitions run to 2029** | `migrations/074` | `check_movement_partitions.sql` (4) | ✅ |
| 35 | **Stock valuation, with its own coverage** | `migrations/072,073,075` | `check_valuation_and_dead_stock.sql` (8) | ✅ |
| 36 | **Dead stock requires evidence of age** | `migrations/075` | `check_valuation_and_dead_stock.sql` | ✅ |
| 37 | **Reorder points and breakouts, tunable** | `migrations/066,067,068`, `js/data/inventory-signals.js` | `check_intelligence_zero_setup.sql` (11) + `check_single_low_stock_threshold.sh` — one definition of the threshold, no copies | ✅ |
| 38 | **Barcode labels: generated, printable, readable** | `migrations/076`, `js/lib/barcode-ean13.js` | `check_barcode_roundtrip.mjs` (9) + `check_barcode_decode.mjs` (18) | ✅ |
| 39 | **The buyer's product card shows a photo** | `js/components/product-card.js` | `check_buyer_product_card.mjs` (45) | ✅ |
| 40 | Product images / 360 viewer | `migrations/021,040`, `product-hologram.js` | `check_image_downscale.mjs` (8) | ✅ |
| 41 | Barcode lookup / camera scan | `js/data/barcode-lookup.js` | `check_barcode_decode.mjs` | ✅ |
| 42 | Kit assembly | `migrations/015`, `js/data/kits.js` | *(no assertion yet)* | ⚠️ |
| 43 | Landed cost on receipt | `js/data/landed-cost.js` | *(no assertion yet)* | ⚠️ |
| 44 | Cycle counts on an ABC schedule | `js/data/inventory-intelligence.js` | *(no assertion yet)* | ⚠️ |
| 45 | Suppliers | `migrations/050`, `js/data/suppliers.js` | *(no assertion yet)* | ⚠️ |
| 46 | **Product creation with colour picker and photos** | `js/components/product-form.js` | `check_product_creation.mjs` | ✅ |
| 47 | **Editing a product saves what the form showed** | `js/views/wholesaler.js`, `js/components/product-detail.js` | `check_edit_saves_what_it_shows.mjs` (18) | ✅ |
| 48 | **The wholesaler's tile, and View that cannot edit** | `js/components/admin-product-tile.js`, `product-detail.js` | `check_product_cards_and_detail.mjs` (49) — the load-bearing case is that View contains no input, select or textarea anywhere | ✅ |
| 49 | **Inventory holds Stock, Products and Pricing rules** | `js/components/sub-tabs.js`, `js/views/wholesaler.js` | `check_inventory_panes.mjs` (27) | ✅ |

## Catalogs, clients, delivery

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 50 | **A catalog is a link you send** | `migrations/056` | `check_catalog_link_access.sql` | ✅ |
| 51 | **Customer tier gates who may open a link** | `migrations/053,055` | `check_buyer_catalog_access.sql` | ✅ |
| 52 | Catalog builder, picker, two add buttons | `js/views/wholesaler.js` catalogs | `check_catalog_builder.mjs` (44) | ✅ |
| 53 | Billboard + pinned highlight group | `migrations/057,058` | `check_billboard_and_highlights.mjs` (41) | ✅ |
| 54 | Wholesaler-chosen card facts | `migrations/054`, `js/lib/card-facts.js` | `check_card_facts.mjs` (37) | ✅ |
| 55 | Tag entry (categories, what a client sells) | `js/components/tag-input.js` | `check_tag_input.mjs` (13) | ✅ |
| 56 | **Client bans, per wholesaler, server-enforced** | `migrations/059` | `check_client_ban.sql` | ✅ |
| 57 | CSV import / export | `js/data/csv-import.js`, `csv-export.js` | *(no assertion yet)* | ⚠️ |
| 58 | AI catalogue import from image | `functions/extract-catalog-from-image` | *(no assertion yet)* | ⚠️ |
| 59 | Shopify / WooCommerce / WhatsApp integrations | `functions/*-webhook`, `migrations/018` | *(no assertion yet)* | ⚠️ |

## Roles, security, delivery

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 60 | Buyer / wholesaler / salesperson / owner / warehouse | `js/views/*` | `check_nav_completeness.mjs` (20), `check_post_login_landing.mjs` (9), `check_bottomnav_render.mjs` (37) | ✅ |
| 61 | Real auth, server-authoritative identity | `migrations/024` | `check_pack_moq.sh` preserves `p_account_id` | ✅ |
| 62 | Tenant-scoped RLS | `migrations/023,031,069` | `check_tenant_isolation.sql`, `check_movement_ledger.sql` §3 | ✅ |
| 63 | **User input cannot inject HTML** | `js/lib/utils.js` | `check_escaping.mjs` (13) | ✅ |
| 64 | **A deploy reaches installed users** | `sw.js` | `check_service_worker.mjs` (9) + `check_deploy_reaches_installed_client.mjs` (10) | ✅ |
| 65 | PWA installable, works offline | `manifest.json`, `sw.js`, `icons/` | `check_service_worker.mjs` offline cases | ✅ |
| 66 | Shipped CSP blocks inline script | `index.html` | `check_shipped_csp.mjs` | ✅ |
| 67 | 44px touch targets, AA contrast, complete tokens | `css/mobile.css`, `css/brand.css` | `check_touch_targets.mjs` (21), `check_contrast.mjs` (18), `check_token_completeness.mjs` | ✅ |
| 68 | Every module parses, imports resolve, no orphan calls | `js/**` | `check_module_syntax.mjs`, `check_imports_resolve.sh`, `check_cross_module_imports.mjs` | ✅ |
| 69 | **This repo can rebuild the database** | `supabase/migrations/*` | `check_migration_chain.mjs` (6) + `checks/replay_migrations.sh` | ✅ |
| 70 | **No change deletes a line without saying so** | `js/**` | `check_no_feature_loss.sh` — zero-deletion gate, overridable only with the reason in the commit message | ✅ |

---

## Reconciliation — 23 August 2026

| | |
|---|---|
| Features listed | **70** |
| Enforced and proven (✅) | **62** |
| Present but unproven (⚠️) | **8** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

Batch 8 (23 Aug) added rows 15–20. None of the three is a new capability:
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
