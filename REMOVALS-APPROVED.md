# Removals, approved out loud

Gate 1 (`checks/check_no_feature_loss.sh`) fails on any deleted line in a
protected directory. That is deliberate: this product has lost working features
to rewrites before, every time because a deletion was a side effect nobody
noticed rather than a decision somebody made.

So a removal is allowed — and it has to be written here, by hand, with who
approved it and what replaced it. If a row below cannot name the replacement,
the removal was not approved; it was forgotten.

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
