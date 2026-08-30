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

---

## AC-03 — `isPublicPath` widened to admit the invitation route

**Date:** 29 Aug 2026
**File:** `js/views/public-order.js`
**Gate 1 report:** `+160 / -1`

The single removed line is:

```js
return /^\/o\/[^/]+$/.test(path || "") || /^\/c\/[^/]+$/.test(path || "");
```

replaced by:

```js
return /^\/o\/[^/]+$/.test(path || "")   // an order handed to a warehouse
    || /^\/c\/[^/]+$/.test(path || "")   // a catalogue share link
    || /^\/i\/[^/]+$/.test(path || "");  // an invitation to join a store
```

**Nothing was removed — a third route was added.** Both original patterns
survive verbatim, in the same order, with the same semantics; the line was
split across three so each public path could carry the note explaining *what
kind of link it is*, which is the thing a future reader needs and the
one-liner had nowhere to put.

This is a line-count artefact of Gate 1 comparing lines rather than behaviour.
The behaviour is strictly a superset: every path that was public before is
public now, plus `/i/:token`.

**Gated:** `check_order_handoff.mjs` asserts all three patterns individually
(60 assertions total). Red-proved by neutralising each arm in turn — rewriting
its regex to one that can never match, which leaves the file syntactically
valid. Each produces exactly one named failure:

| arm neutralised | failures | the assertion that fired |
|---|---|---|
| `/o/` | 1 of 60 | *an order link is a public path* |
| `/c/` | 1 of 60 | *a catalogue link is a public path* |
| `/i/` | 1 of 60 | *and an invitation is too — the person holding one has no account, which is the point* |

⚠️ **The first attempt at this proof was invalid and is recorded here because
the failure is instructive.** Deleting each arm's *line* took the `return`
keyword with it on the first arm, so Node threw `SyntaxError: Unexpected token
'||'` before the gate ran a single assertion — and a crashed gate printed zero
failures, which reads exactly like *"the gate does not cover this."* It nearly
went into this document as a discovered hole in the gate. It was not a hole;
it was a broken proof. **A red proof that produces no failures has not proven
the gate is blind — it has to be shown to have run at all first.**

---

## DR-01 — the directory replaces a placeholder, and a stale note

**Date:** 29 Aug 2026
**Gate 1 report:** `js/lib/nav-config.js +23/−9`, `js/views/buyer.js +11/−10`

**Nothing was lost. Two things that were no longer true were removed.**

### 1. `js/views/buyer.js` — a screen that promised a feature it now has

`suppliers()` rendered an empty state: *"One account, one supplier … Browsing
products across multiple suppliers is coming to OGGI as the Marketplace."*

That stopped being true the moment the directory shipped. The route is kept —
an installed PWA with the old tab cached must not land on a 404 — but it now
delegates to `directoryView()` rather than showing a promise the product has
already kept. It **delegates rather than duplicating**: two screens that must
stay identical are two screens that will not.

### 2. `js/lib/nav-config.js` — a comment that contradicted the product

The removed nine lines said the replacement for "Suppliers" would be *"the
Marketplace: products from many wholesalers, **no wholesaler names anywhere**,
all of it presented as OGGI."*

**Hadi reversed that on 28 Aug 2026.** Buyers see wholesalers by name, can
search for one, and can ask for access. It is the decision that makes a
marketplace possible at all — an anonymous grid of products cannot answer *"who
am I buying this from"*, which is the first question a shop asks.

The replacement comment is longer than what it replaced (hence +23/−9) because
it records **the reversal, who made it, and how the original objection is
answered rather than dismissed**. The 18 Aug worry was real: "OGGI's entire
client list, shown to every buyer." What is shown now is a name and the
categories they sell. Products, prices and even a product *count* are absent,
and migration 091 asserts there is nowhere in the return type to put one.

A comment that contradicts the code is how a false claim survives three
rewrites — this repo has already had to correct one such line in CLAUDE.md this
week. Leaving it in place while shipping the opposite would have been worse
than deleting it silently.

**Gated:** `check_wholesaler_directory.mjs` asserts the old placeholder text is
gone, that `/buyer/suppliers` renders the real directory, and that the reversal
is recorded in `nav-config.js` — so a future editor cannot quietly restore the
stale claim.

---

## ID-03 — the buyer login screen opens on the OGGI door, not the store door

**Approved by:** Hadi, 30 Aug 2026 — *"Make the client bound to us, to the main
market. And then each wholesaler gives them access."* Then, on the plan for it:
*"as you see fit"*, and *"go"*.

**Two lines removed from `js/views/login.js`. Both are MODIFICATIONS, and this
row exists to say so rather than to let a `-2` in a diff go unexplained.**

| Gone | Replaced by |
|---|---|
| `let buyerMode = "login";` | `let buyerMode = "oggi";` — plus the two new panel states (`"oggi"`, `"stores"`) and a comment naming all four |
| `#req-back` returning to `buyerMode = "login"` | `#req-back` returning to `buyerMode = "oggi"` |

**Nothing was removed from the product.** The per-store panel — wholesaler code,
username, password — is untouched, still rendered by the same code, and reachable
in one tap from the new panel via *"Sign in with a wholesaler code instead"*. The
only change is which of the two is shown first.

**Why the default moved.** The first field on that screen was **Wholesaler code**,
and a buyer arriving at a marketplace has no way to produce one for a shop they
have not met yet. A door that cannot be opened by the people it was built for is
not a door. `v2_buyer_login` is unchanged, undeprecated and still live (GP-02),
and `check_marketplace_login.sql` asserts on every run that it still works.

**Proof the old door survives:** `check_marketplace_client.mjs` asserts the
per-store panel is still reachable, and `check_marketplace_login.sql` signs a
fixture buyer in through `v2_buyer_login` *after* the marketplace migration has
run, plus both of an ambiguous person's original store passwords afterwards.

---

## 30 August 2026 — AC-08/AC-17, declining an access request

**33 lines removed across five files. Every one is a MODIFICATION, and this row
exists so that a `-33` in a diff is not something the next reader has to
reconstruct.** Hadi's instruction for the night was *"don't stop working until
everything is built"*; that is not permission to lose anything on the way.

| File | Gone | Replaced by |
|---|---|---|
| `js/data/owner.js` | `rejectSignupRequest(requestId, reviewerLabel)` — a raw `.from("v2_signup_requests").update({status:"rejected"})` and its four-line comment | the same function name, now calling `v2_decline_signup_request` with a required reason |
| `js/data/wholesaler-admin.js` | `rejectMySignupRequest(...)` — the same raw write, plus `.eq("wid", wid)` and the session lookup that fed it | the same function name calling the same RPC |
| `js/views/owner.js` | the `confirmAction` "Reject request?" dialog and its one-line call | a two-step dialog that asks WHY first, then declines |
| `js/views/wholesaler.js` | the one-line call and its toast | the same two-step dialog, from the same shared reason list |
| `js/components/ask.js` | the unconditional `<input>` markup, the parameter line, and a bare `input.select()` | a conditional select-or-input, a `choices` parameter, and a guarded `input.select()` |

### Nothing was removed from the product

- **The text-input dialog still exists.** `ask()` renders exactly the same
  `<input>` when no `choices` are passed — it is the `else` branch of one
  ternary — and `input.select()` still runs for it, now guarded because a
  `<select>` element has no `.select()` method. Every existing caller is
  untouched and `check_module_syntax.mjs` and the 95-gate sweep both pass.
- **The `.eq("wid", wid)` guard was not dropped, it MOVED** — into
  `v2_decline_signup_request`, which checks
  `v2_is_owner() OR v2_my_wid() = the request's wid`. A guard in the client is
  a guard the client can drop; the same guard in a `SECURITY DEFINER` function
  is one nobody can route around. `check_access_decisions.sql` assertion 3
  proves the refusal.
- **Declining still works from both screens**, and now does three things it did
  not do before: it carries a reason, it refuses to decline something already
  approved, and it leaves an audit entry.

### Why the old path had to go rather than be kept alongside

Its own comment said *"a plain status flip is fine here since nothing gets
provisioned"*. True about provisioning. But a status word has nowhere to put a
reason (AC-08), leaves no audit entry (AC-17), and put the rule about who may
decide inside a browser. Leaving it in place as a second path would mean a
decline could still happen with no reason — which is the feature not existing.

**Proof:** `check_access_decisions.sql` (16 assertions, red-proved six ways) and
`check_access_decisions_client.mjs` (25 assertions, red-proved three ways),
including one assertion that fails specifically if either screen starts writing
to `v2_signup_requests` directly again.

---

## 30 Aug 2026 — migration 105 (AC-07, AC-11, PB-01): one line

### The line

```
js/views/directory.js
-      p.textContent = "Waiting for them to approve you.";
```

That is the whole removal. One line, one file, replaced by 58.

### Why it had to go rather than stay

It is the dead end. A shop asks a wholesaler for access, and the only thing the
product has ever said back is those six words — not that the request arrived,
not how long the wholesaler usually takes, not what to do if nothing happens,
and, when the answer finally comes, not that there was an answer at all. The
complaint this feature is built from names exactly this:

> "Without confirmation that suppliers have even seen the request, it makes it
> nearly impossible to move forward with any certainty, which delays potential
> sales."

The sentence could not be kept alongside the new one, because the new one
occupies the same place on the screen and says the same thing better. Two
sentences in one slot is not a fallback, it is a bug.

### What stands in its place

The card now says what happened, how long that wholesaler says they take, and
where the answer will appear — and once the request exists it is joined by a
**"Your requests"** list above the grid, carrying all four states:

- **waiting** — with that wholesaler's own stated time, in plain words ("about
  2 days", never "48 hours")
- **waiting too long** — past that wholesaler's own number, so the shop can
  chase rather than assume it was ignored
- **approved** — with the way in
- **declined** — *with the reason*, in buyer wording, never the internal code

None of the four is blank. That is asserted, not hoped:
`check_access_request_standing_client.mjs` walks all four states and fails on a
blank, on an `undefined`, and on a reason code leaking through as itself.

### Proof the replacement is real, not a rename

`check_access_request_standing_client.mjs` (27 assertions) contains an assertion
that fails **if the old sentence comes back** — it was red-proved by restoring
that exact line, which made the gate fire, and then undoing it.
`check_access_request_standing.sql` (13 assertions) proves the server half,
red-proved three ways, including by hardcoding a single global answer time,
which makes assertions 5 and 7 fire.

Verified against production on live data before the push: a shop sees its own
requests and none of another shop's; twelve hours against a stated six reads
late while a hundred hours against a stated two-forty does not (one global
number could not produce both); a declined request reaches the buyer with its
reason; the overdue list stays empty for a non-owner *while a genuinely overdue
request exists*; and the recreated directory kept both of its grants.

**ALLOW_DELETIONS=1 — approved, one line, accounted for above.**

---

## 30 Aug 2026 — the SECOND dead end (the one the first pass missed)

### The line

```
js/views/directory.js
-    p.textContent = "Waiting for them to approve you.";
```

Yes — again. **The same sentence, in a different place**, and this is the more
important of the two.

### Why there were two

The entry above removed the sentence from the **confirmation**, shown for a
moment after pressing "Ask for access". The sentence also lived on the **card
itself**, rendered whenever `access === "pending"` — which is what the same
buyer sees on **every visit afterwards**, forever, until someone answers them.

The first pass removed the momentary one and left the permanent one. A
27-assertion gate reported a clean pass, because it asked its question about one
code path — it sliced forward from `if (res.ok)` — and the feature's promise is
about the product, not about a code path.

### How it was caught

Not by the gate. By the last step of the push, a `grep -c` for the removed
sentence against the **live, deployed file**, which answered `2` where the only
acceptable answer was `0`.

### What stands in its place

The card now says the same two true things the confirmation says, in the
register of a return visit rather than a send:

> Asked. Milano Garments usually answers within about 2 days — where it stands
> is under "Your requests" at the top of this page.

The two sentences deliberately do not share wording — one means *"I have just
sent this"*, the other *"this is still out"* — but they share the same stated
time and the same pointer.

### Proof

`check_access_request_standing_client.mjs` §7b, four new assertions, which
assert the sentence appears **nowhere in live code** (on a comment-stripped copy
of the file, so that quoting it in an explanatory comment can neither satisfy
nor break the check) and then assert the card branch on its own terms.
Red-proved by restoring the sentence on the card branch: **4 assertions fire,
and every section-7 assertion still passes** — which is the proof that the
earlier gate could not have caught this.

Full write-up in `checks/GATE-EVIDENCE.md`.

**ALLOW_DELETIONS=1 — approved, one line, accounted for above.**

---

## 30 Aug 2026 — AC-10, applying again after a decline: four lines

**Approved by:** the standing instruction of 30 August — *"continue building
everything that needs to be built on your end that doesn't need me"* — under the
rule this file exists for: every removal names its replacement, or it was not
approved, it was forgotten.

All four are **replacements, in place, of a line by a line that does more**.
None removes a behaviour. Each is accounted for on its own below rather than as
a group, because "four small ones" is how a fifth gets in.

### 1. `js/data/wholesaler-admin.js` — a one-line docblock

```
-/** Access requests addressed to THIS wholesaler. */
```

**Replaced by** a docblock opening with that exact sentence and then explaining
why the pending queue is now `v2_pending_access_requests` and why every other
status still reads the table. The sentence it removed is its own first line.

### 2. `js/views/directory.js` — the import line

```
-import { listMyAccessRequests, requestStanding, humanHours }
```

**Replaced by** the same import widened with `reapplyStanding`. A widened import
is a delete-plus-add to a line-based gate and there is no way to write it that
is not; the gate is right to show it and this is the whole of it.

### 3. `js/views/directory.js` — the loop header

```
-    rows.forEach((r) => {
```

**Replaced by** `live.forEach((r) => {`, where `live` is
`rows.filter((r) => !r.superseded)`. **This is the one worth reading twice.** It
is not a rename: iterating every row would render a buyer TWO live entries for
one wholesaler once they have applied twice — each with its own sentence, one of
them out of date, and both carrying an "Ask again" button of which only one
works. The rows are not lost; they are rendered below, folded into an
`<details>` the buyer can open, because "have I asked this store before?" is
their question to answer.

**Proof:** `check_access_reapply.sql` 13 and 13b assert that exactly one row per
wholesaler carries a standing and that the older one is flagged `superseded`;
`check_access_reapply_client.mjs` asserts the filter is present and that an
older row produces no sentence. Red-proved by removing the `superseded` guard
from `reapplyStanding` — one assertion fires.

### 4. `js/views/wholesaler.js` — the decline confirmation

```
-        body: "They will not get access, and they are not told automatically — there is no email in the system yet. They can ask again later, and you will see it as a new request.",
```

**Replaced by** a sentence that is true in a way the old one was not. *"They can
ask again later"* was written when "later" meant "immediately, as many times as
they like, and you will not know they were here before". It now depends on the
reason the wholesaler is about to pick, and the re-application arrives with this
decision attached — so the copy says that:

> They will not get access, and they are not told automatically — there is no
> email in the system yet. They can ask again later — how soon depends on the
> reason you pick next — and it will arrive with this decision attached to it.

Nothing was removed from what the buyer or the wholesaler can DO. The sentence
was made accurate about something that changed underneath it.

**ALLOW_DELETIONS=1 — approved, four lines, each accounted for above.**

---

## 30 Aug 2026 — migration 107 (approval grants access): thirty lines, three groups

**Approved by:** the standing instruction of 30 August — *"continue building
everything that needs to be built on your end that doesn't need me"* — and,
for the first group, by the defect it fixes: approving a shop was telling them
they could buy and giving them nothing.

### Group 1 — the two hand-rolled approval panels (26 lines)

`js/views/wholesaler.js` and `js/views/owner.js` each carried their own copy of
the "approved, here are the credentials" panel. **Replaced by**
`js/components/approval-result.js`, one component, called by both.

This is not tidying. Approval now has TWO outcomes — a membership for somebody
who already signs in to OGGI, and a store-scoped login with a one-time password
for somebody who does not — and a screen that rendered the credentials panel
unconditionally would show a wholesaler `Username: null` and send them hunting
for a string that was never minted.

**And the two copies had ALREADY drifted, which is the argument for the
component made for us:**

| | wholesaler.js | owner.js |
|---|---|---|
| heading | "can now buy from you" | "approved — account created" |
| surface token | `var(--bg-sunken)` | `var(--surface-sunken,#f7f7f5)` — **a token that has never existed** |
| labels | "Username" | "Username:" |

Both wrote the credentials row with `innerHTML`. The component uses
`textContent` for every field, which is why it imports no escape helper: a sink
that cannot parse markup is stronger than one you must remember to escape into.
A generated username is derived from a shop's own name.

**Proof:** `check_approval_grants_access_client.mjs`, 29 assertions, red-proved
six ways — including rendering the box with nothing in it, hiding the password
when there is one, treating half a response as credentials, writing the panel
with `innerHTML`, and giving the owner console its own copy back.

### Group 2 — `var(--surface-sunken,#f7f7f5)`, four lines across four files

`js/views/owner.js`, `js/views/owner-wholesaler-new.js`, `js/views/salesperson.js`,
`js/views/wholesaler.js`. **Replaced by** `var(--bg-sunken)`, which is defined in
`css/tokens.css` and is what the rest of the app already uses for the same
surface.

`--surface-sunken` has never been defined anywhere in this repo. CSS answers an
undefined custom property with silence, so the hardcoded `#f7f7f5` fallback had
been rendering the whole time and nothing said a word.

It was invisible because `check_token_completeness.mjs` read `css/` only, and
this app writes a great deal of style inline from JavaScript. **That gate now
reads `js/` as well** — and doing so found ten more undefined tokens across
twenty files. Those are NOT swept in this change; see `docs/OUTSTANDING.md` §8.

### Group 3 — two `return` lines in the data modules (2 lines)

`js/data/owner.js` and `js/data/wholesaler-admin.js`. **Replaced by** the same
return widened with `message: row.msg`, which is how the server tells the panel
which of the two outcomes happened. The browser cannot know whether the
applicant had an OGGI account; migration 107 does.

**ALLOW_DELETIONS=1 — approved, thirty lines, each accounted for above.**

---

## 30 Aug 2026 — migration 108 (a request nobody can answer): two lines

**Approved by:** the defect they fix. The public "Request access" form collected
no phone number and no email address, so a wholesaler could approve a shop and
then had no way to send them the password the system had just minted. Both lines
below are widened signatures — the only shape this change can take.

| Gone | Replaced by |
|---|---|
| `async requestBuyerAccess(wid, buyerName, location, volume, sells) {` | the same, plus `phone` |
| `panel.querySelector("#req-sells").value.trim()` | the same line, plus `phone` as the sixth argument |

Nothing was taken away from either caller. A function that gains a parameter is
a delete-plus-add to a line-based gate and there is no way to write it that is
not; this is the whole of it.

**Proof:** `check_access_reapply_client.mjs` asserts the form asks for a number,
with a telephone keypad, refuses to send without one, and that the number
actually reaches the server — red-proved by removing the field, by removing the
client-side refusal, and by collecting the number and dropping it before the RPC.

**ALLOW_DELETIONS=1 — approved, two lines, both accounted for above.**
