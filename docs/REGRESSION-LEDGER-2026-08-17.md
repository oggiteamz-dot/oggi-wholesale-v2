# Wholesale v2 — Regression Ledger

**17 August 2026.** The comparison nobody had run: **v1 (2.0) → v2**.

Hadi's words that triggered this: *"go through the code and what I asked for in the
past and make sure nothing else is gone. There's a lot of stuff that I noticed that
you removed."* He was right. 21 confirmed regressions, 4 of which fail silently.

---

## Why this pass was needed even though five audits already ran

Every prior audit compared a **different pair**, and the v1 → v2 pair was never done:

| Audit | Compared | Verdict |
|---|---|---|
| Jul 17 Feature Audit | `wholesale-apps/` → 2.0 | ~60 items, mostly since restored |
| Jul 17 STILL MISSING | all old versions → 2.0 | 9 gaps |
| Jul 25 Regression Sweep | pre-2.0 standalone apps → 2.0 | 7 confirmed |
| Aug 2 OLD APPS → 2.0 LEDGER | `wholesale-apps/` → 2.0 | 6 confirmed, 5 falsified |
| Aug 14 Feature Verification | ledger → v2, **20 files read** | 1 gap found |

The Aug 14 pass is the only one that touched v2, and it read **20 of 113 files**,
scoped to the three capabilities Hadi named from memory. It never opened the owner,
salesperson or buyer-history views. That is why it reported v2 as "mostly yes."

### 🔴 The structural cause: the must-keep list does not exist

`[C] FEATURE LEDGER — FINAL (Aug 3 2026).md` — the document the v2 PRD, the 14-batch
build plan, and the Aug 14 audit all cite as authoritative — does not contain the
list of v1 features. Its Part One says the list is "not reproduced here to avoid
duplicating a document already delivered" and points to **`FEATURE-LEDGER-REBUILT.md`**.

**That file does not exist anywhere in the workspace.** Verified: the only file that
mentions its name is the Aug 3 ledger itself.

So the standing instruction — *"nothing in that ledger's ✅ BUILT column gets lost or
silently dropped"* — has never been checkable by anyone, including the Aug 14 audit
that declared it complete. v2 was built against a pointer to a missing document.
**This is the root cause, and it outranks every individual finding below.**

---

## Method (re-runnable)

- **New side:** `github.com/oggiteamz-dot/oggi-wholesale-v2` @ `90469b7` (15 Aug, 50
  commits) — cloned fresh and read, **not** the local disk copy, because the repo is
  what Cloudflare deploys. 54 JS + 36 SQL + 6 edge functions.
- **Old side:** v1 capability truth taken from `[C] OGGI Wholesale — CODE-TRUTH PASS
  (Aug 2 2026).md` (read from the **active** definitions of `deploy-2026-07-25/index.html`,
  503 functions, duplicate-copy trap accounted for) — the only doc that verified v1
  against code rather than against other docs. Buyer 13/13, Wholesaler 10/10,
  Salesperson 8/8, Owner 3 of 6.
- **Extraction, not reading.** Routes, nav entries, functions, SQL columns and
  constraints machine-extracted from both sides.
- **Every candidate re-checked in both directions** before being called a regression.
- **Independent adversarial verifier** run afterwards, instructed to *refute* the
  findings and default to "refuted" when uncertain. It overturned 3 of my findings and
  added 9 I had missed. Both directions of its corrections are recorded below.
- `.git` and `js/lib/vendor/` excluded from every search.

### Substring traps that produced false findings in this pass

Recorded because they will recur:

- **`voice` matches inside `invoice`.** A raw count said "voice notes: 17 PRESENT."
  Every one was `invoice`. Voice notes are absent.
- **`ratio` matches inside `integration`.** A raw count said "ratio pack: 453 PRESENT."
  Real count is 47; the rest were `migration`/`integration`.
- **`timeline`** matched prose in an animation file's comment.
- **`broadcast`** matched `BroadcastChannel` in the vendored Supabase bundle.
- **`blocked`** matched a code comment in `register-sw.js`.

Any of those five, reported unchecked, would have been a false alarm — and a gate that
cries wolf gets switched off.

---

## FALSIFIED — claimed missing, actually present. Never re-report these.

| Suspected missing | Actually in v2 as |
|---|---|
| Bulk price update | `bulkUpdatePrice` — `products-admin.js:52`, wired `wholesaler.js:230` |
| Duplicate as template | `duplicateAsTemplate` — `products-admin.js:78`, wired `wholesaler.js:159` |
| Client list by recency | `getClientsByRecency` — `clients.js:8`, 3 call sites |
| Rep sets client discount | add-client form + `renderClientPricingPanel` — `salesperson.js:163` |
| Catalog search + colour/size filter | `catalog-toolbar.js:35,63-105` + `catalog-filter.js:62-75` — richer than v1 |
| **"Fixed box" selling model** | **prepack IS fixed box** — `030:52-99` generates a carton per colour and rejects loose lines; `product-card.js:81-99` hides the size stepper |
| Ratio pack | migration `030`, seeded from v1's real `RATIO_CURVE 2/3/5/2` |
| Colour × size variant stock | `extra_attrs.color/.size` per variant, balances per variant × location |
| MOQ / landed cost / ABC / reorder points / barcode scanning / per-product sizes | all real and reachable |

**All four selling models are in the constraint** (`029:79-80`: open, prepack, series,
ratio). The Aug 11 handoff and the 15 Aug CLAUDE.md note saying "series = 0 matches"
are **stale** — migrations 029 and 030 landed in the last two commits. Correct the
record rather than acting on it.

---

# CONFIRMED REGRESSIONS — ranked by consequence

## Tier 1 — silent failures (feature looks present, does nothing)

These outrank everything else: they pass every static check, and nothing tells anyone.

### 1. 🔴 Client order stats join on the wrong key — corrupts both dashboards
`clients.js:11-27` matches orders to clients on `order.buyer_label === client.shop_name`.
But `v2_submit_order` sets `buyer_label := v_account.actor_label` (`024:131`) — a
**person's display name** ("Hadi Hamza"), not a shop name. `v2_orders.client_id` exists
(`009:44`) and is populated authoritatively (`024:130`) — and is ignored.

**Consequence:** for every real buyer account, "orders", "lifetime value" and "last
ordered" read **0 / never**. That feeds `coverageSnapshot`, the "Needs attention" and
"Never ordered" tiles on both the wholesaler and salesperson dashboards, and the
client-recency sort. The screens render confidently and are wrong. This is the exact
class of defect the forensics method cannot see (Step 7) and it was found by reading
the join, not by a capability probe.

### 2. 🔴 Favourites is a permanent dead end
Nav item and `/buyer/favourites` route exist. `isFavourite`/`toggleFavourite` are
exported from `buyer.js:464,469` and **no file imports them**; `product-card.js` has no
star control. The empty state reads "Star products from the catalog" — and nothing in
the catalog can star anything. v1 had working favourites (Buyer 13/13).

### 3. 🔴 Order notes are readable but unwritable
`v2_orders.notes` exists (`004:22`) and is read back in three places. `cart.submit()`
destructures `notes` (`cart.js:255`) and **never passes it**; `v2_submit_order` has no
notes parameter. Every order's note is permanently empty.

### 4. 🔴 "Full series" enforcement cannot be rebuilt from the repo
`v2_enforce_selling_model` is *defined* in `029:142` / `030:85`. The block that **calls**
it inside `v2_submit_order` exists only as a **commented-out sample** (`029:168-186`);
the working version was applied live out-of-band and never saved as a file. The newest
`v2_submit_order` in the repo (`028:77`) does not call it.

**Consequence:** a database rebuilt from the repo has **zero selling-model enforcement**
while the live one has it. This is the "a fix that looks applied and is not" failure the
15 Aug session wrote a standing rule about, recurring in the opposite direction.

### 5. 🟠 `orderedTimesCount` is dead code
Defined `orders.js:40`, imported `buyer.js:9`, called nowhere. v1's "ordered N times"
line does not render.

### 6. 🟠 Concurrent per-client rep carts are dead code
`scopeSuffix` is threaded through all seven `cart` methods — and **no caller passes it**
(all 12 call sites omit it). v1's `STATE.salesCarts` was real and the role research
called it "a gap even the vendor tools don't solve."

---

## Tier 2 — blocking gaps (a real business cannot be operated)

### 7. 🔴 No way to create a wholesaler — onboarding is impossible
No code path inserts into `v2_wholesalers`. UI: the owner's Wholesalers screen is a
read-only list plus Deactivate/Reactivate (`owner.js:117-167`). Invites only offer a
**dropdown of wholesalers that already exist** (`owner.js:292`), and `v2_create_invite`
rejects a wid that doesn't exist. DB: **zero functions** insert into the table
(verified live via `pg_proc`). Only `008:49` and `checks/seed.sql` ever insert.

v1 had full create/edit including login provisioning (Jul 12 refit). The DB even grants
the owner INSERT (`023:79-87`) — the permission is there, the code is not.

*Correction to my first finding:* I initially reported "no create **or edit**." The edit
half is wrong — deactivate/reactivate, wholesaler self-service settings
(`wholesaler-settings.js:23-29`) and order minimums (`pricing-admin.js:115`) all write
`v2_wholesalers`. What's missing is **create**, plus editing a wholesaler's identity and
login. The verifier caught this; reporting it inflated would have been the kind of false
alarm that gets a whole audit dismissed.

### 8. 🔴 No product or variant creation UI at all
Products can only enter v2 via CSV/AI import or `duplicateAsTemplate`. There is no form
to create a product, add a variant, or set a price, colour or selling model. **Nothing in
`js/` ever writes `selling_model`** — so the four selling models are enforceable but not
choosable.

### 9. 🔴 No colour can ever be set — every v2 product is grey
`colorHex` is written by exactly **one statement in the repo**: `002_v2_data_migration.sql:191`,
the one-time v1 import. CSV import writes `extra_attrs {color, size}` only
(`csv-import.js:200`), so every product created in v2 falls back to `"#999"`
(`catalog.js:88`) — grey swatches on the buyer card and in the filter toolbar. v1 had
custom colours (name + hex), a 37-site refactor, plus an eyedropper.

### 10. 🔴 No image upload path
v1 uploaded to a Supabase bucket (up to 50 photos/product). v2 accepts **pasted URLs
only**, by its own admission (`wholesaler.js:388-396`). No `storage.from(` call exists
anywhere in the repo.

### 11. 🟠 A rep cannot place an order
`salesperson.js:8` imports `cart` and never uses it. There is no `/sales/order*` route.
`v2_submit_order` accepts only a buyer account (`024:123 role = 'buyer'`), so a rep
cannot author an order even in principle. Order-on-behalf was the entire point of v1's
rep mode.

### 12. 🟠 An order can never be cancelled
`STATUS_FLOW = ["new","confirmed","shipped","delivered"]` is forward-only
(`wholesaler-orders.js:60`). `cancelled` exists in the enum and in three badge maps and
**nothing can ever set it**. Also no edit-while-`new` and no change request — v1 had both.

### 13. 🟠 `/wholesaler/catalogs` is a placeholder in the live nav
`wholesaler.js:1237` renders a literal "scheduled later" stub. Multi-catalog / white-label
shipped in v1.

---

## Tier 3 — real losses, felt daily

| # | Lost capability | Evidence |
|---|---|---|
| 14 | 🔴 **Voice note per order item** — *Hadi's explicit Jul-17 ask*, live in v1 on bucket `order-voice` | zero `MediaRecorder`/audio/storage; every "voice" string is `invoice` |
| 15 | 🔴 **Written comment per line item** — *the same ask, same breath* | `v2_order_items` = id, order_id, variant_id, qty, unit_price, line_total. No note column in any of 36 migrations |
| 16 | 🟠 **Order status timeline + the `packed` stage + per-line partial shipment** | enum is `new/confirmed/shipped/delivered/cancelled`; `packed` appears only in comments; buyer sees one flat badge (`buyer.js:407-419`). Partial shipping isn't just missing, it's **forbidden**: `mobile-ops.js:244` disables Ship until every line is scanned. v1 had the 4-stage ladder + `toggleLineShipped` |
| 17 | 🟠 **Stock transfer between locations** | the only `transfer` tokens in the entire repo are the enum values `transfer_out`/`transfer_in` on one line (`001:96`). No function, RPC or UI. **No UI writes `v2_locations` either — a wholesaler cannot create a second location.** ⚠️ `FEATURE-MANIFEST.md` row 16 calls this "present but not enforced." That row is false; an enum value is not a feature |
| 18 | 🟠 **Order date-range filter** (Today / Week / Month / Custom) | zero hits; all three order views render unfiltered lists |
| 19 | 🟠 **Manual WhatsApp send** — "send this client their catalog link + login", and any one-to-many blast | `broadcast` occurs only in the vendor bundle. *Nuance:* automated WhatsApp **is** real — `integration-dispatch/index.ts:69-90` posts via the Cloud API on `order_created`/`order_shipped`. What's gone is the manual/bulk send |
| 20 | 🟡 **Buyer order-history search** and **buyer activity feed** | `buyer.js:394-457` contains no input element; only `type="search"` in the codebase is the catalog toolbar |
| 21 | 🟡 **Salesperson client search**; **rep-scoped orders** | `salesperson.js:241` calls `getWholesalerOrders(wid)` — every order for the tenant. No `rep_id`/`placed_by` column exists, so "my orders / my revenue" is not computable |
| 22 | 🟡 **"Was $X" price-change badge** | `compare_at_price` is a real column (`001:57`), duplicated, importable, loaded as `compareAtPrice` — and **never rendered**. Dead data |
| 23 | 🟡 **Barcode label generation / printing** | v2 stores and scans barcode strings but has no Code128/QR renderer. v1 printed per-colour labels |
| 24 | 🟡 **`pack_price` never charged** | self-reported in `FEATURE-MANIFEST.md`; every line priced by `v2_effective_unit_price` |

---

## Pre-existing — missing in v1 too. NOT caused by the v2 rebuild.

Listed so they aren't double-counted as new damage, and aren't forgotten:

- Rename a colour (Aug 2 ledger #3) · Owner per-wholesaler profile drill-down (Jul 25 #1)
  · `plan`/`paid_until` billing fields (Jul 25 #2) · Client block/unblock after approval
  (Jul 25 #3) · Per-wholesaler module gating (Aug 2 ledger #4) · Barcode "find this
  product while ordering" (Jul 25 #5) · Bulk comma-separated colour entry (Jul 25 #6)
  · Owner at-risk flag O11 (never built) · Credit terms / net-30 (scoped out by design).

---

## Suggested fix order

1. **Write the missing must-keep list first.** Reconstruct `FEATURE-LEDGER-REBUILT.md`
   from the CODE-TRUTH PASS + this ledger and commit it. Until that file exists, every
   future "nothing was lost" claim is unverifiable — which is how we got here.
2. **#1, the client-stats join** — a one-line change (`client_id`, not `buyer_label`) that
   stops two dashboards lying. Highest damage-per-character in the list.
3. **#4, commit the live `v2_submit_order`.** Dump the live definition
   (`select prosrc from pg_proc`) and save it as a migration. Today the repo cannot
   rebuild the product's own enforcement.
4. **#7 create-wholesaler + #8 product/variant editor + #9 colour + #10 image upload** —
   these four together are what "can actually be operated" means. Nothing else matters
   until a real wholesaler can be onboarded and put a product in with a photo and a colour.
5. **#3 order notes, #2 favourites, #5, #6** — small wiring fixes for features that already
   exist and merely aren't connected. Cheap, and each one removes a visible lie.
6. **#14/#15 voice + line comment** — Hadi asked for these explicitly once already.
7. **#12 cancel, #16 status ladder, #11 rep ordering** — real workflow gaps.
8. Tier 3 remainder as builder/catalog work comes up.
9. **Delete `FEATURE-MANIFEST.md` row 16** or correct it. A manifest that claims a
   feature exists is worse than silence.

---

## Limits of this pass — stated so nobody over-trusts it

- **This method finds features that vanished. It does not find features that still exist
  but behave differently.** A narrowed filter, a silently changed calculation, a dropped
  edge case all pass a capability check. Finding #1 is exactly that class and was caught
  by reading a join by hand, not by the method — so assume more of its kind remain.
- **Scope:** v1 (`deploy-2026-07-25`, via the Aug 2 CODE-TRUTH PASS) → v2 (`90469b7`).
  **Not** re-diffed: `Hosted Apps/`, `Supabase Apps/`, `Inventory System/`, and the
  pre-2.0 standalone apps — those were covered by the Jul 25 and Aug 2 passes and are
  carried forward here by citation, not re-verified.
- **v1's own truth is second-hand.** I trusted the Aug 2 CODE-TRUTH PASS rather than
  re-reading v1's 5,270 lines. That doc explicitly corrected two of its own earlier
  probe errors, which is why I trust it — but it is a document, not the code.
- **Nothing here was verified by clicking the live app.** Every finding is code- and
  schema-level. A screen that loads real data is still the only proof of behaviour, and
  as of today only the buyer order path has ever been walked by a human.
- Counts of "21 regressions" depend on where you split an item; the tiers matter, the
  total does not.

## Change log

- **2026-08-17** — Created. First v1 → v2 comparison. 60+ capabilities probed;
  9 candidates falsified and recorded; 24 regressions confirmed and ranked; 9 items
  added and 3 of my own findings corrected by an independent adversarial verifier;
  the missing `FEATURE-LEDGER-REBUILT.md` identified as the structural root cause.
