# Feature Manifest — OGGI Wholesale v2

**Last reconciled: 15 August 2026**

One row per shipped feature, naming **the file it lives in** and **the assertion
that proves it still works**. This is the answer to "how do we never lose a
feature again."

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

So a manifest row is only worth something if the "proven by" column names a
check that fails when the behaviour goes, not when a name changes.

**Status key:** ✅ enforced · ⚠️ present but not enforced · ❌ not built

---

## Ordering rules — the things that make this wholesale, not retail

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 1 | Per-SKU minimum order quantity | `migrations/009,010` | `check_pack_moq.sh` — "honest order below the SKU minimum" | ✅ |
| 2 | Product-level minimum across colours/sizes | `migrations/010` | `check_pack_moq.sh` — accepted/rejected cases | ✅ |
| 3 | Wholesaler order minimum (qty and value) | `v2_submit_order` | `check_data_invariants.sql` §6 | ✅ |
| 4 | Reorder minimums differ from first order | `v2_products.moq_reorder_qty` | *(no assertion yet)* | ⚠️ |
| 5 | **MOQ cannot be disabled by the client** | `migrations/028` | `check_pack_moq.sh` — 8 rejection cases | ✅ |

## Selling models

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 6 | Open stock | `js/data/cart.js` | `check_pack_moq.sh` — "ordinary order meeting the minimum" | ✅ |
| 7 | Prepack / fixed carton | `migrations/011,012,030` + generated per-colour packs | `check_pack_moq.sh` + `check_data_invariants.sql` §5 | ✅ |
| 8 | **Ratio pack** | `migrations/030` + per-colour packs on the wholesaler's ratio curve | `check_data_invariants.sql` §5 | ✅ |
| 9 | **Full series** | `migrations/029` + generated series pack | `check_data_invariants.sql` §5 — series pack completeness | ✅ |
| 10 | Fixed box | *(prepack covers this — a fixed carton per colour)* | see row 7 | ✅ |
| 11 | Flat pack price (`pack_price`) | `migrations/011` (stored, never applied) | *(no assertion yet)* | ⚠️ |

> **All four selling models are now enforced end to end** (migrations 029 and 030,
> 15 Aug 2026). Before that day, `extra_attrs.sellMode` was read once by
> `js/data/catalog.js` and never acted on: 37 variants across three wholesalers
> were declared ratio or series and sold as loose open stock. Composition values
> come from v1's working source (`RATIO_CURVE` 2/3/5/2, `PACK_UNIT` 12), not from
> guesswork. One simplification is recorded rather than hidden: v1's ratio mode
> let a buyer switch individual sizes off within the curve; here a ratio pack is
> the whole curve for a chosen colour.

## Catalogue and stock

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 12 | **Colour × size variants** | `v2_product_variants.extra_attrs` | `check_data_invariants.sql` §2 | ✅ |
| 13 | No duplicate (product, colour, size) | — | `check_data_invariants.sql` §2 | ✅ |
| 14 | Multi-location stock | `v2_inventory_balances` | `check_data_invariants.sql` §3 | ✅ |
| 15 | Reservations cannot exceed stock | `v2_confirm_reservation` | `check_data_invariants.sql` §3 | ✅ |
| 16 | Stock transfers between locations | `migrations/001` | *(no assertion yet)* | ⚠️ |
| 17 | Pack integrity (components, same product) | `migrations/011` | `check_data_invariants.sql` §4 | ✅ |
| 18 | Product images / 360 viewer | `migrations/021`, `product-hologram.js` | *(no assertion yet)* | ⚠️ |
| 19 | Barcode lookup | `js/data/barcode-lookup.js` | *(no assertion yet)* | ⚠️ |
| 20 | Kit assembly | `migrations/015`, `js/data/kits.js` | *(no assertion yet)* | ⚠️ |
| 21 | Inventory intelligence (dead stock, ABC) | `js/data/inventory-intelligence.js` | *(no assertion yet)* | ⚠️ |
| 22 | Landed cost | `js/data/landed-cost.js` | *(no assertion yet)* | ⚠️ |

## Roles, security, delivery

| # | Feature | Lives in | Proven by | Status |
|---|---|---|---|---|
| 23 | Buyer / wholesaler / salesperson / owner / warehouse | `js/views/*` | *(no assertion yet)* | ⚠️ |
| 24 | Real auth, server-authoritative identity | `migrations/024` | `check_pack_moq.sh` preserves `p_account_id` | ✅ |
| 25 | Tenant-scoped RLS | `migrations/023` | *(no assertion yet — production gate)* | ⚠️ |
| 26 | Per-client pricing | `js/data/client-pricing.js` | *(no assertion yet)* | ⚠️ |
| 27 | CSV import / export | `js/data/csv-import.js`, `csv-export.js` | *(no assertion yet)* | ⚠️ |
| 28 | AI catalogue import from image | `functions/extract-catalog-from-image` | *(no assertion yet)* | ⚠️ |
| 29 | Shopify / WooCommerce / WhatsApp integrations | `functions/*-webhook` | *(no assertion yet)* | ⚠️ |
| 30 | **User input cannot inject HTML** | `js/lib/utils.js` | `check_escaping.mjs` — 13 assertions | ✅ |
| 31 | **A deploy reaches installed users** | `sw.js` | `check_service_worker.mjs` — 9 assertions | ✅ |
| 32 | PWA installable, works offline | `manifest.json`, `sw.js`, `icons/` | `check_service_worker.mjs` offline cases | ✅ |

---

## Reconciliation — 15 August 2026

| | |
|---|---|
| Features listed | **32** |
| Enforced and proven (✅) | **17** |
| Present but unproven or unenforced (⚠️) | **15** |
| Not built (❌) | **0** |
| **Features lost since the last count** | **0** |

**A ⚠️ is not a bug.** It means: this exists, and nothing would tell you if it
stopped existing. That is the backlog — every ⚠️ turned into a ✅ is one more
thing that cannot silently disappear.

The honest headline: **17 of 32 features currently have a gate. All four selling models are now enforced.** Before today
it was zero.

## Known silent-loss vectors

1. ~~`js/data/csv-import.js` hardcoded `sellMode: "open"` on every imported
   row, silently overwriting the wholesaler's selling model.~~ **Fixed 15 Aug** —
   variant imports no longer express an opinion about the selling model, which
   now lives on the product.
2. **`pack_price` is stored and never applied.** A wholesaler can set a flat
   pack price, see it saved, and it will not change what a buyer is charged.
3. **The cart snapshots pack composition at add-to-cart time.** Editing a pack
   while it sits in a cart now fails checkout (correct since migration 028) with
   an unhelpful message.
