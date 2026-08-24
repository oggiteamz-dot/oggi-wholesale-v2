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
