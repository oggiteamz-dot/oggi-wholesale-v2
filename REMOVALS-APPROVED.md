# Removals, approved out loud

Gate 1 (`checks/check_no_feature_loss.sh`) fails on any deleted line in a
protected directory. That is deliberate: this product has lost working features
to rewrites before, every time because a deletion was a side effect nobody
noticed rather than a decision somebody made.

So a removal is allowed — and it has to be written here, by hand, with who
approved it and what replaced it. If a row below cannot name the replacement,
the removal was not approved; it was forgotten.

---

## 2026-08-25 · Batch S / S2 · the buyer's whole-tenant table read

**Approved by:** Hadi, 25 Aug 2026 — `Go — Batch S alone` on the plan in
`[C] BATCH S — PLAN, PROOF & FEATURE LIST (Aug 25 2026).md`, which names this
removal as S2 and shows the measurement that justifies it.

**Removed from `js/views/buyer.js` (15 lines):**

| Gone | Replaced by |
|---|---|
| `catalogProductsByToken()` call + the `order` Map + the `pinned` Set | the row order and the `highlighted` flag now arrive from `v2_catalog_read` |
| `const everything = await getCatalog(wid)` on the token route | `getCatalogByToken(token, accountId)` |
| `.filter(...).sort(...)` over the whole wholesaler's catalogue | the database's `order by highlighted desc, sort_order, added_at` |

**Removed from `js/data/catalog.js` (28 lines):** the inline variant-shaping
object literal and the inline product-shaping map body. **Neither was deleted —
both were EXTRACTED**, unchanged field for field, into `shapeVariant()` and
`shapeProduct()`, which both read paths now call. `checks/check_buyer_reads_are_gated.mjs`
asserts they are shared, and that assertion is red-proved by rewriting one call
site by hand.

**Why, in one line:** `getCatalog(wid)` read `v2_products`,
`v2_product_variants` and `v2_inventory_by_variant` **for the entire
wholesaler**, and the share-token gate had no say over any of it — measured
signed-out against production on 25 Aug, the same key that ships in the app
returned 23 products, 264 variants and 143 stock rows across **six different
wholesalers**.

**Nothing behind it was deleted.** `catalogProductsByToken()` and
`v2_catalog_products_by_token` are both untouched and still exported — the
wholesaler-side catalog builder uses the same gate. Only the buyer route stopped
calling it.

**One gate was REWRITTEN, not softened** — two assertions in
`check_billboard_and_highlights.mjs` named the control (`order.get(a.id) -
order.get(b.id)` and `pinned.has(product.id)`) rather than the capability, and
went red on a change that makes the guarantee *stronger*: the app now has no
sort to get wrong. Both were rewritten in this commit with the reason in the
file, and both re-proved red.

---

## 2026-08-26 · Batch S / S4 · the buyer's ungated pricing reads

**Approved by:** Hadi, 26 Aug 2026 — `Finish Batch S (S3–S9)`.

**Removed from `js/data/pricing.js`:**

| Gone | Replaced by |
|---|---|
| `supabase.from("v2_pricing_tiers")` — a direct, cross-tenant table read | `v2_catalog_tiers` / `v2_buyer_catalog_tiers` |
| `v2_catalog_discount_pct(catalogId, clientId)` — **both ids from the caller** | `v2_buyer_discount_pct(accountId, catalogId)` / `v2_token_discount_pct(token, accountId)` |

**⛔ The second line was a live leak.** That function is `SECURITY DEFINER`,
granted to `anon`, and checks nothing. Called from the app's own origin, signed
out, on 26 Aug:

| Asked for | Returned |
|---|---|
| AMANI Stores (`sq`) | **10.00** |
| CEDAR Shops (`sq`) | **5.00** |
| Boutique Farah (`test`) | **10.00** |
| catalogue `test432` | **−5.00** |

Real negotiated terms. And the last one is a **price increase** that this
project's own notes describe as *"invisible to the buyer by design"* — a buyer
holds their own client id in their session, so reading their own markup required
**no guessing at all**.

There was also an existence oracle: a real catalogue id returned `0.00`, a
made-up one returned `0`, which is how guessing a uuid stops being hopeless.

**`clientId` is still accepted by `getPricingContext`** because order submission
needs it downstream — but it no longer influences pricing and is not sent
anywhere. **`v2_catalog_discount_pct` itself is untouched and still granted**;
revoking it before the app has moved is the ordering mistake this batch exists
to avoid. It goes in S7 with the table grants.

**Two false greens in my own red-proofs, both caught, both mine:**

- A mutation that removed the account validation **never applied** — a quoting
  error made the string replace a silent no-op, so the check reported green
  while testing nothing. Every mutation is now verified by comparing the
  function's `md5(prosrc)` before and after.
- A mutation that made the tier join ignore `product_id` **could not be
  detected**, because the fixture had only one product with breaks. A second
  product with different breaks now exists purely so that leak has somewhere to
  show up.

---

## 2026-08-26 · Batch S / S3 · the buyer's ungated pack reads

**Approved by:** Hadi, 26 Aug 2026 — `Finish Batch S (S3–S9)`.

**Removed from `js/views/buyer.js`:**

| Gone | Replaced by |
|---|---|
| `listPacksForProducts(...)` on the signed-in grid | `listPacksForBuyerCatalog(accountId, catalogId)` |
| `getPackById(...)` on the reorder path | `getBuyerPack(accountId, packId)` |
| **`packs: []`** on the share-link card | `linkPacks.get(product.id)` — real packs, through the gate |

**⛔ That last line was a live bug, not a placeholder.** A series/prepack/ratio
product with no packs takes the card's dead-end branch and prints *"This product
has no bundles set up yet, so it cannot be ordered. Ask the wholesaler to add
one."* Counted on production 26 Aug: **13 of 23 live products — 8 prepack, 4
ratio, 1 series — across five of the six wholesalers**, un-orderable on the
share link, and blamed on the wholesaler.

**Also not carried across: `flatPackPrice` / `isFlatPrice`.** Decision D4
(21 Aug) says the flat pack price is stored, never charged; a grep on 26 Aug
confirms nothing outside `prepacks.js` reads either field. It is also the
wholesaler's margin structure. The columns and the wholesaler-side functions are
untouched — only the buyer path stops carrying it.

**Nothing behind this was deleted.** `listPacksForProduct` (singular),
`listPacksForProducts` and `getPackById` all remain exported and are still used
by the wholesaler's own screens, which are `authenticated` with real RLS.

**A harness bug caught in my own gate, worth recording:** the first version of
the `flatPackPrice` assertion sliced `prepacks.js` from `assemblePackRows` to
end-of-file, swept in the legacy wholesaler readers that legitimately carry that
field, and reported a leak that did not exist. A check that fails on code it was
never meant to judge gets its assertion deleted rather than fixed. Now scoped,
and it says `HARNESS BROKEN — this is NOT a pass` if it cannot find the block.

---

## 2026-08-25 · Batch S / S2b · the signed-in buyer's whole-tenant read (and a live bug with it)

**Approved by:** Hadi, 25 Aug 2026 — `Go — Batch S alone`, then `go` on S2b.

**Removed from `js/views/buyer.js`:**

| Gone | Replaced by |
|---|---|
| `narrowTo()` and its `new Set(...)` / `.filter()` | `v2_buyer_catalog_read` returns this buyer's catalogue directly — there is no wider list left to narrow |
| `getCatalog(wid)` in `catalogView()` | `getBuyerCatalog(accountId, catalogId)` |
| `getCatalog(wid)` in `favouritesView()` | `getBuyerVisibleProducts(accountId, catalogIds)` — unions every catalogue the buyer may see, so a favourite starred in one does not vanish when another is active |
| the `buyerCatalogProductIds` import | the ids are no longer fetched separately at all |

**⛔ The `narrowTo` removal also fixes a LIVE PRODUCTION BUG, unrelated to
Batch S.** It read:

```js
const ids = new Set(await buyerCatalogProductIds(session.accountId, cat.id));
return catalog.filter((p) => ids.has(p.id));
```

`buyerCatalogProductIds` returns **objects** (`{id, highlighted}`), so the Set
held object references and `ids.has(p.id)` — a string — was **always false**.
**Every signed-in buyer's catalogue rendered empty.**

Dated from git: `c8f0ff8` (20 Aug) wrote the filter when that call returned
plain text ids and was correct; `978d415`, later the same day, changed the
return shape so the billboard page could read `highlighted`, and silently broke
this caller. Verified against production 25 Aug: the test buyer's Main Catalog
holds 4 products, none of which would have rendered. The `/c/:token` page was
never affected, which is why link testing looked fine.

Same class as the 2.0 rewrite losing the size axis: **the record SHAPE
changed**, and nothing checks shapes. The name was still there, the call still
ran, the data still arrived.

**Nothing behind it was deleted.** `buyerCatalogProductIds` and
`v2_buyer_catalog_products` are both untouched and still exported.
`getCatalog()` is also kept — now caller-less on purpose, with a header
explaining it is wholesaler-side only, and a gate that fails the build if
`buyer.js` names it.

**One gate was WIDENED, not softened:** `check_buyer_reads_are_gated.mjs`
asserted only that *the token route* stopped reading tables. Scoped that way it
would have stayed green while the signed-in route and favourites kept reading
the whole wholesaler forever — and there turned out to be **three** such reads
in that file, not one. It now judges the whole file. Two of its own assertions
were also found to be unfalsifiable and fixed: one counted a function's own
declaration as a call site, and one was satisfied by a **comment** mentioning
the function's name.

---

## 2026-08-24 · CR-0001 · `renderRatioSection()` and the 64-row pack builder

**Approved by:** Hadi, 24 Aug 2026 — *"if you want merge the ratio and prepack
and series into a prepack only and give the wholesaler the ability to choose"*,
then `go` on CR-0001.

**Removed from `js/views/wholesaler.js`:**

| Gone | Lines | Replaced by |
|---|---|---|
| `renderRatioSection()` — base unit, saved-ratio library, mandatory name field, stepper row, starter curves, "save ratio and apply to all colours" | 253 | `js/components/order-setup.js` |
| The per-variant pack builder inside `renderPacksPanel()` — pack name, colour, flat price, and **one row per variant** (64 rows on an 8×8 product) | ~90 | the colour × size grid in the same component |

**Why, in one line:** Hadi's own approved Aug-20 spec said *"Kill the 64-row
list"* and *"Never make the wholesaler re-enter a ratio per colour or per
product — this is the entire complaint."* The ratio row shipped **above** the
64-row list instead of replacing it, so both were on screen and the complaint
stood. This removal is what that spec asked for.

**Nothing behind it was deleted.** `js/data/size-ratios.js` and
`js/data/prepacks.js` are untouched and still fully exported. The two features
that lived only inside the removed UI were carried across, not dropped:

- **"Suggest ratio from sell-through"** → now the "Suggest from what sells"
  shortcut, same `suggestPackRatio()` call.
- **The saved-ratio library** → now an optional "start from a mix you saved
  before" row, same `listRatios()` call. It is no longer a gate: you can set a
  box up without naming or saving anything, which is the wall Hadi hit.

**No migration, no data change.** `v2_enforce_selling_model` (migration 063)
already rejects loose lines for `series`, `prepack` and `ratio` with identical
logic — three names for one rule. Existing products keep their `selling_model`
and are never re-classified.

**Also removed:** imports in `js/views/wholesaler.js` left with no user —
`listRatios`, `createRatio`, `applyRatio`, `ratioUsage`, `archiveRatio`,
`ratioTotal`, `ratioShorthand`, `productSizes`, `productColors`, `setBaseUnit`,
`STARTER_RATIOS`, `suggestPackRatio`, `listPacksForProduct`, `createPack`,
`archivePack`, `closeAllModals`, `modalDepth`, and four that were already dead
before this change (`addClient`, `adjustStock`, `getWholesaler`,
`INVENTORY_SETTING_DEFAULTS`). Every one verified unused by
`checks/check_no_undeclared_identifiers.mjs`, which fails if a name is read
without being bound.


---

## 2026-08-24 (later) · A removal I made by accident, and put back

Not an approved removal — a **regression**, recorded here because this file is
where losses are supposed to become visible and it would be dishonest to log
only the deliberate ones.

The builder deleted above could create **any number of arbitrary packs**, one
at a time. The grid that replaced it could express exactly two shapes: one
mixed box, or one box per colour. That is strictly less, and it shipped to
production.

`check_order_setup.mjs` passed throughout, because I wrote it to match the new
design instead of to preserve the old capability. **A gate written around your
own intention will go green on a feature loss.**

Hadi found it within the hour: *"can I pick one colour per box... I want the
most amount of flexibility... give me a way to tell the system that I'm giving
box A in this style, box B in this style, box C in this style."*

Restored as a list of boxes, each with its own name and grid. The gate now
asserts that adding boxes is unbounded and that boxes are independent, and was
proven red by capping the panel at one box.

---

## CR-0004 — the buyer card no longer borrows another colour's photograph

**Approved by:** Hadi, 25 August 2026
**Removed:** the `product.primaryImage` fallback in `photosFor()`,
`js/components/product-card.js`.

**His words:**

> "Each color to have its own corresponding image. And if it's not available,
> then it's not available from my client's side."

**What the line did.** When a colour had no photography of its own, the card
showed the product's first photograph instead — with the reasoning, written at
the time, that *"a partly-photographed range still shows a picture rather than a
gap."*

**Why it goes.** That was true only while every colour of a product carried an
identical gallery, which is exactly what both save paths did until today. Now
that a colour can genuinely have its own photograph, the same line becomes the
bug that shows a buyer the BLACK jean while they are ordering the BROWN one. A
wrong picture is read as fact; an empty frame is read as a fact about the
product. The second is recoverable and the first is not.

**What replaces it.** `renderPlaceholder()` — "No photo yet", tinted in that
colour's own hex. **The colour remains fully orderable.** A forgotten upload
must never quietly remove stock from sale, which is why the alternative — hiding
an unphotographed colour from buyers — was considered and rejected. The
wholesaler is told instead, in the product form, as they build.

**Proven by:** `checks/check_colour_photos.mjs` — C1 asserts the borrow is gone;
red-proved by putting it back and watching the gate fail.

---

## CR-0007 — the sales rep's product picker stops working, on purpose

**Approved by:** Hadi, 28 August 2026 — *"Every single wholesaler we have is a
test one. We don't have an actual wholesaler using the system yet. We're still
building it."* and, on the order of work, *"as you see fit."*

**Removed:** nothing from `js/**`. What is removed is a **grant**: migration
`085_v2_anon_loses_the_tables.sql` takes every table, view and sequence
privilege in `wholesale_v2` away from the `anon` role.

**What that breaks, precisely.** One function:
`listVariantsForPicker()` in `js/data/client-pricing.js`, which reads
`v2_product_variants` and `v2_products` directly. It is called from
`js/views/salesperson.js` when a rep sets a client-specific price override.
After 085 it returns nothing.

**Why that is the point and not a casualty.** That query has no wholesaler
filter of any kind. It was handing a rep — and, because reps are the `anon`
role, anyone at all — the variant list of **every wholesaler on the platform**.
It is the single worst read in the product and the one the S0 gate has been
pointing at since the batch began. Repairing it in place would mean keeping the table
open while a gated replacement is written; taking the grant away first means
S6 gets built once, against the doors as they will actually be.

**What is NOT lost.** Nothing else in the sales app changes state, because
nothing else in the sales app was working: clients, orders, order items and
visits already returned zero rows for a rep, for the same reason — `auth.uid()`
is null for them, so every `v2_is_owner() OR wid = v2_my_wid()` policy
evaluates false. The rep app has been inert since it shipped.

**Who is affected today: nobody.** There are zero salesperson accounts in the
database. Every wholesaler in the system is a test one. This is pre-launch
hardening, not incident response.

**What replaces it.** S6 — the salesperson app rebuilt on gated reads, R1–R12,
starting with a validated-account variant picker scoped to the rep's own
wholesaler. Creating the first test rep account is the step before it.

**Proven by:** `checks/check_anon_grants.sql` (anon holds nothing) and
`checks/check_anon_scope.sh` (production, signed out, with the app's own key).


---

## CR-0009 — the idle control bar at the foot of the order sheet
**29 August 2026 · approved by Hadi, 28 August**

**Two lines removed from `js/components/product-card.js`:**

```
sheet.appendChild(pad);
pad.innerHTML = `<div class="os-what"><b>Tap a box above</b><span>then use + and − here</span></div>`;
```

**Hadi's words, choosing the matrix as the ordering screen:** *"I don't like the
idea that when they click, the number change appears at the bottom, because
there's a very high chance that it might not be seen."*

He is right, and the reason is worse than "might not be seen." On a six-colour
product the foot of the sheet sits roughly 250–300px below the cell being
tapped, with the running total in between — frequently **below the fold on a
phone**. The buyer taps a number, nothing visibly happens, and the honest
conclusion to draw is that the app is broken.

The original reasoning — *"one large control at the foot, which never moves, so
the thumb never hunts"* — was **right about the thumb and wrong about the eye.**
A control the eye cannot find is not found by the thumb either.

**Nothing was lost.** The control is the same element with the same class names
and the same behaviour; only where it is mounted changed. It now appears as a
full-width row directly beneath the colour being edited, and is left-sticky so
that scrolling sideways on a wide size range cannot scroll it off screen.

The idle instruction it used to draw is now `.os-hint`, a single quiet line
under the grid rather than a permanent bar — furniture the eye learns to skip
is furniture that goes unread on the one occasion it matters.

**Gated:** `check_buyer_product_card.mjs` gained 13 assertions, red-proved by
putting the control back at the foot (6 named failures). They assert
**adjacency**, not merely that a control exists somewhere — "there is a stepper
on the card" was already true when the complaint was made, so a check asserting
only that would have been green throughout.

⚠️ **One existing assertion had to be corrected, not weakened.**
`check_buyer_card_capabilities.mjs` proved "one row per colour" by counting
`tbody tr`, which the inserted edit row took to 3. The intent was unchanged;
the proxy was wrong. It now counts `tr:not(.os-editrow)` and cross-checks
`tr[data-colour]`, which states the intent directly and cannot be satisfied by
rows that are not colours.
