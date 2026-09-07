# Gate Evidence — proof each gate has been seen to FAIL

**17 August 2026.** Recorded during the mobile-first pass.

## Why this file exists

A check that has never failed will eventually lie, and you will not find out
until it matters. This project already has three recorded cases:

- `check_pack_moq.sh` reported **7 green while the database function was
  crashing on every call** — every "rejection" it counted was a crash, not a
  rule being enforced.
- A feature check reported *"Full series: PRESENT"* — the match was inside
  `.git/hooks/*.sample`.
- The same check reported *"Product images: MISSING"* — the feature is real,
  implemented as `image_url`/`images` columns on variants, not a table called
  `product_images`. **It searched for a name and missed the shape.**

So the rule for this repository is: **a gate is not finished until it has been
proven to go RED.** Break the thing deliberately, watch it fail, restore it,
watch it pass. This file records that cycle, with the real output, for every
gate added during the mobile-first work.

If you add a gate and do not add its red-run evidence here, the gate is not
done.

---

## GATE 1 — `check_no_feature_loss.sh`

Zero deletions permitted in `js/views/`, `js/data/`, `js/components/`,
`js/lib/`. Six tests run.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Clean tree | PASS | ✅ PASS, exit 0 |
| 2 | Lines **added** to `js/views/buyer.js` | PASS | ✅ PASS, exit 0 |
| 3 | One line **deleted** from `js/views/buyer.js` | FAIL + name it | ✅ FAIL, exit 1 |
| 4 | Same deletion with `ALLOW_DELETIONS=1` | PASS + warn | ✅ PASS, exit 0, warning shown |
| 5 | Whole file `js/data/subscriptions.js` deleted | FAIL + name file | ✅ FAIL, exit 1 |
| 6 | Everything restored | PASS | ✅ PASS, exit 0 |

**Test 3, real output — note it prints the removed line, not just a count:**

```
  ✗ js/views/buyer.js
      +0 / -1   (1 line(s) removed)
      ---- the removed lines ----
      -export function toggleFavourite(wid, productId) {
------------------------------------------------------------
 ✗ FAIL — 1 line(s) removed from protected code.
```

**Test 5, real output:**

```
  ✗ FILES DELETED FROM A PROTECTED DIRECTORY:
      js/data/subscriptions.js
```

**Why test 2 matters as much as test 3:** a deletion gate that also fires on
additions would be useless — every commit would be red, and within a week
somebody would stop running it. It was verified to stay silent on pure
additions before it was trusted to catch deletions.

---

## GATE 2 — `check_nav_completeness.mjs`

Asserts `bar ∪ more === NAV_BY_ROLE[role]` for every role, that the bar never
overflows, that overflow always has a "More" door, and that the component
never hard-codes a route.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Before `splitNav()` existed | FAIL | ✅ FAIL, exit 1 |
| 2 | Before `bottomnav.js` existed | FAIL | ✅ FAIL, exit 1 |
| 3 | `splitNav()` silently drops the overflow | FAIL, name every lost screen | ✅ FAIL, exit 1 |
| 4 | A route hard-coded in `bottomnav.js` | FAIL | ✅ FAIL, exit 1 |
| 5 | Correct implementation | PASS | ✅ PASS, 20 assertions |

**Test 3 is the important one.** It simulates the exact mistake this gate was
built to prevent: picking "the important five" for the bar and quietly
abandoning the rest. Note that **Gate 1 stays green** through this — no code
is deleted — which is precisely why Gate 2 has to exist separately.

```
  ✗ FAIL — 2 of 18 assertions failed:

   • owner: 3 destination(s) UNREACHABLE on mobile —
     /owner/invites, /owner/exports, /owner/audit
   • wholesaler: 8 destination(s) UNREACHABLE on mobile —
     /wholesaler/catalogs, /wholesaler/team, /wholesaler/inventory,
     /wholesaler/intelligence, /wholesaler/receive-scan,
     /wholesaler/import, /wholesaler/integrations, /wholesaler/settings
```

**Test 4, real output** — this is the check that keeps the other four honest.
A gate validating a config the UI has stopped reading is worse than no gate:

```
   • bottomnav.js hard-codes 1 route(s) — /wholesaler/orders. It must derive
     every destination from NAV_BY_ROLE, or this gate is validating a config
     the UI no longer obeys.
```

**Passing state:**

```
  ✓ owner        7 items → bar 4 + more 3 = 7
  ✓ wholesaler  12 items → bar 4 + more 8 = 12
  ✓ sales        4 items → bar 4 + more 0 = 4
  ✓ buyer        5 items → bar 5 + more 0 = 5
  ✓ bottomnav.js derives routes from config (0 hard-coded found)
  ✓ bottomnav.js imports nav-config.js
 ✓ PASS — 20 assertions.
   All 28 destinations across 4 roles are reachable on mobile.
```

---

## GATE 3 — `check_bottomnav_render.mjs`

Real Chromium, real component, real config, at 360px and 375px. Asserts on the
DOM that exists rather than on the config that describes it.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Before `css/mobile.css` existed | FAIL (targets under 48px) | ✅ FAIL |
| 2 | Correct implementation, 360px + 375px | PASS | ✅ PASS, 37 assertions, 0 page errors |

```
  --- 360px ---
  ✓ owner       5 tabs + 3 in hub → 7/7 tappable
  ✓ wholesaler  5 tabs + 8 in hub → 12/12 tappable
  ✓ sales       4 tabs + 0 in hub → 4/4 tappable
  ✓ buyer       5 tabs + 0 in hub → 5/5 tappable
  --- 375px ---
  (identical)
 ✓ PASS — 37 assertions, 0 page errors.
```

**What Gate 3 catches that Gate 2 cannot:** Gate 2 proves the *configuration*
is complete. A component that threw on its first line would still pass it.
Gate 3 opens a browser and counts anchors in the rendered DOM, so "the config
is right but nothing renders" fails here. This is the same gap that let the
14 Aug deploy be declared verified — assets returned 200 with a clean console
while every database call was failing.

**A defect this gate did NOT catch, found by looking at the screenshot:** the
last rows of the More hub (`Integrations`, `Settings` for the wholesaler role)
sat flush against the bottom edge of the screen, awkward to tap and, on a
device with a home indicator, partly underneath it. No assertion covered it.
Fixed with bottom padding on `.bottomnav-hub-list`.

**This is worth recording as a limitation, not a footnote.** Automated gates
verify the properties somebody thought to assert. They do not verify that the
thing looks right. Screenshots are written to `checks/screenshots/` on every
run precisely so a human still looks.

---

## GATE 4 — `check_contrast.mjs`

WCAG 2.2 AA contrast on the real token file. 18 pairs.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | The OLD indigo palette | FAIL — it had real defects | ✅ FAIL, exit 1 |
| 2 | Primary button painted mint `#54E5A0` | FAIL | ✅ FAIL, exit 1 |
| 3 | OGGI "Eyes Everywhere" palette | PASS | ✅ PASS, 18/18 |

**Test 1 found three genuine defects in the palette that was already shipping,**
before any brand work started:

```
  ✗ tertiary text on card               3.27:1  (need 4.5)  #8A8DA3 on #FFFFFF
  ✗ tertiary text on sunken panel       2.90:1  (need 4.5)  #8A8DA3 on #F0F1F6
  ✗ strong border on card               1.71:1  (need 3.0)  #C3C5D6 on #FFFFFF
```

**Test 2 — the mistake this gate exists to prevent.** Painting the brand's
mint onto buttons is the single most obvious way to "make it look like OGGI":

```
  ✗ white on primary button             1.60:1  (need 4.5)  #FFFFFF on #54E5A0
  ✗ accent text on card                 1.60:1  (need 4.5)  #54E5A0 on #FFFFFF
  ✗ MINT RULE: --accent-600 = #54E5A0
```

Mint measures **1.60:1 on white** and **10.15:1 on the brand's ink**. That is
why the website uses it for the big numbers in its dark band and never for
text on white, and why the gate has a named MINT RULE that fails if mint is
ever assigned to a text-bearing token regardless of the measured pairs.

**Two deviations from the brand palette, both recorded rather than silent:**
`--muted #6A7A84` measures **4.44:1** — a near miss on AA — so app tertiary
text uses `#61727C` (4.99:1). `--line #E4EDE9` measures **1.19:1**, correct as
a decorative card border but unusable as `--border-strong`, which is `#76958A`
(3.26:1).

---

## GATE 5 — `check_token_completeness.mjs`

**This gate exists because of a failure I caused during this very session, and
that is the most useful thing about it.**

`css/tokens.css` was rewritten to carry the OGGI palette. The rewrite
reproduced the parts being thought about — colours, radius, type, motion — and
**silently dropped the entire spacing scale, `--space-1` through `--space-16`.**

Nothing errored. CSS does not warn about an undefined custom property; it
resolves to nothing. Every `padding: var(--space-5)` in the app collapsed to
zero and the whole UI went edge-to-edge. It was caught by **looking at a
screenshot** — far too thin a thread.

This is the same failure mode as the 2.0 rewrite dropping the size axis, and
the same one that cost Sonos "at least $100 million". Gate 1 could not catch
it: Gate 1 protects `js/`, because the mobile-first pass has to edit CSS
freely.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | tokens.css with the spacing scale dropped | FAIL, name every one | ✅ FAIL, exit 1 |
| 2 | Scale restored | PASS | ✅ PASS |

```
  ✗ 10 token(s) MISSING from css/tokens.css:
      --space-*  (10):  --space-1, --space-10, --space-12, --space-16,
                        --space-2, --space-3, --space-4, --space-5,
                        --space-6, --space-8

  ✗ 9 token(s) USED but never defined:
      --space-5  — used in animations.css, base.css, brand.css,
                   components.css, layout.css, mobile.css
      ... (8 more)
```

It checks both directions: a token in the manifest that vanished, and a
`var(--x)` in any stylesheet pointing at a token nobody defined. Adding tokens
is always allowed; removing one means editing `checks/token-manifest.json`,
which is a visible decision rather than an accident.

**The lesson worth keeping:** Gate 1 makes feature loss impossible in
JavaScript. Nothing was watching the stylesheet, and within an hour the
stylesheet lost something. Every "this can't happen here" has an
unwatched neighbour.

---

## GATE 6 — `check_touch_targets.mjs`

Measures every interactive control at 375px with a **coarse pointer**, against
a 44px threshold.

**First, what this gate does NOT claim.** The app never violated WCAG 2.2 AA on
target size. That floor is 24x24 (SC 2.5.8) and everything cleared it. Calling
this an accessibility violation would be overstating it, and a gate that cries
wolf gets switched off. What it measures is the **platform** guidance — Apple
HIG 44pt, Material 48dp, WCAG AAA 2.5.5 — which is the standard that matters
for someone counting stock on a warehouse floor with one hand on a carton.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Before the fix | FAIL, name every control | ✅ FAIL — 15 of 17 under 44px |
| 2 | After the fix | PASS | ✅ PASS — 15 controls, all ≥44px |
| 3 | Same page, **fine** pointer (desktop mouse) | UNCHANGED | ✅ 38 / 30 / 38 / 26px, gap 6px — identical to before |

**Test 1 output:**

```
  ✗ btn-primary            101 x  38 px
  ✗ btn-sm-secondary        34 x  30 px      <- an "S" size chip
  ✗ input-qty               72 x  38 px
  ✗ color-swatch            26 x  26 px
  ...
  ✓ bottomnav-item          75 x  54 px      <- the only one that passed
```

The bottom bar passed because it was built at 48px two commits earlier. Every
control that predates this work failed.

**Test 3 is the one that matters most,** and it is why the fix keys on
`@media (pointer: coarse)` rather than a width breakpoint. Width is a bad
proxy for input method — a touchscreen laptop at 1400px *is* a finger and
needs bigger targets; a mouse user with a narrow window is not, and inflating
their controls wastes space for nothing. Measured on a fine pointer after the
fix, every control is byte-for-byte its original size.

**Two things this gate caught that were not the point of it:**

1. **A false failure of its own making.** The sidebar item first measured
   0x0 and reported red — because `#sidenav` is `display:none` below 880px, so
   at 375px the gate was measuring a hidden element. The sidebar is not a phone
   target at all; it becomes one only on a touchscreen laptop. The gate now has
   a second pass at 1280px with a coarse pointer for exactly that device class.
   **A gate measuring the wrong context produces a confident wrong answer**,
   which is the same failure as the `product_images` name-search.

2. **Overlapping hit areas.** The colour swatches keep their 26px visible
   circle — a row of 44px dots would dominate the card — and gain a 44px tap
   area from a `::before` overlay. Expanding by 9px on each side while the row
   gap was 6px would have made adjacent areas overlap by 12px, so a tap between
   two swatches becomes ambiguous. **That is worse than a small but
   unambiguous target.** The gap goes to 18px, putting centres exactly 44px
   apart, and the gate asserts overlap ≤ 0 so this stays true if the numbers
   are ever changed.

---

## What these gates do NOT prove

Stated plainly so nobody over-trusts a green run:

1. **They do not prove any screen still works.** They cover navigation and
   deletions. A view that renders a broken table passes all three.
2. **Gate 1 permits a feature to be broken as long as no line is removed.** A
   changed line — an inverted condition, a wrong variable — passes. That is
   why the per-component CSS conversion still needs visual baselines.
3. **Gate 3 tests the component in isolation**, not inside a logged-in
   session. It proves the bar renders and every destination is tappable; it
   does not prove the app shell mounts it for a real user. That requires a
   real login per role, which is a separate check.
4. **Gate 4 checks TOKEN PAIRS, not rendered pixels.** A screen that puts
   `--text-tertiary` on a coloured card nobody anticipated is not covered.
   It also cannot see text over an image or a gradient.
5. **Gate 5 checks that tokens EXIST, not that they are used correctly.** A
   spacing token set to the wrong value passes.
6. **Gate 6 measures a GALLERY, not the live screens.** It uses the real
   classes and copies product-card.js's real inline styles, but a control
   somewhere with its own inline sizing is not covered.
7. **Nothing here has been walked by a human on a real phone.** Chromium at
   375px is not an iPhone in a warehouse. The screenshots are the closest
   substitute, and they are not a substitute.

---

# check_tenant_isolation.sql — assertions 7, 8, 9 (added 18 Aug 2026)

Three assertions were added after the wholesaler-roster leak. Each was proven
to go RED before being trusted.

## The bug they exist to catch

Verified live against production using only the publishable key that ships in
the public JS bundle — no login, no session, no token:

```
GET /rest/v1/v2_wholesalers?select=wid,brand,contact_phone,contact_email,owner_notes,price_amount,paid_until
→ 5 rows, including contact_phone "03141333" and contact_email
  "oggi.teamz@gmail.com", plus one customer's paid_until date.

GET /rest/v1/v2_wholesaler_billing?select=*
→ every wholesaler's subscription_status, price_amount, paid_until,
  days_remaining, status_label.
```

Two independent causes, and fixing either alone would have left the other open:

1. `anon` and `authenticated` held table-wide SELECT, INSERT, UPDATE, DELETE
   and TRUNCATE on `v2_wholesalers`, with a `using (true)` read policy.
2. `v2_wholesaler_billing` is a view created **without** `security_invoker`, so
   it runs with its owner's rights and bypasses RLS on the base table entirely.
   It does not appear in `pg_policies`. A policy audit would never have found it.

## Negative test — the assertions were made to fail on purpose

A throwaway table and view were built in the same shape as the bug. Nothing in
this test touched `v2_wholesalers`; the probe objects were dropped immediately
after and confirmed gone (`probe_objects_remaining: 0`).

```sql
create table wholesale_v2.zz_leak_probe (wid text primary key, brand text,
  contact_email text, contact_phone text, owner_notes text,
  price_amount numeric, paid_until date);
grant select on wholesale_v2.zz_leak_probe to anon, authenticated;
create view wholesale_v2.zz_definer_view as
  select wid, price_amount from wholesale_v2.zz_leak_probe;   -- no security_invoker
grant select on wholesale_v2.zz_definer_view to anon;
```

RED — all three fired:

```
A7_pii_columns_found      anon.contact_email, anon.contact_phone, anon.owner_notes,
                          anon.paid_until, anon.price_amount, authenticated.contact_email,
                          authenticated.contact_phone, authenticated.owner_notes,
                          authenticated.paid_until, authenticated.price_amount
A8_anon_privileges_count  21 privilege(s) held by anon
A9_definer_views_found    zz_definer_view
```

GREEN — same assertions, real objects, after migration 042:

```
A1 table-wide anon SELECT                     clean
A7 PII columns readable by a browser role     clean
A8 anon privileges on v2_wholesalers          0 (must be 0)
A8b v2_public_wholesaler exists               yes
A9 definer views readable by a browser role   clean
```

## Behaviour proven, not just permissions

Re-running the original anon requests after the fix:

| Request (anon, no login)                    | Before              | After |
|---------------------------------------------|---------------------|-------|
| `v2_wholesalers` PII columns                 | phone + email + dates | `42501 permission denied` |
| `v2_wholesalers` roster (wid, brand)         | 5 rows              | `42501 permission denied` |
| `v2_wholesaler_billing`                      | every price + expiry | `42501 permission denied for view` |
| `v2_wholesaler_brands`                       | readable            | `42501 permission denied` |
| `PATCH v2_wholesalers` (brand → "HACKED")    | granted             | `42501 permission denied` |
| `DELETE v2_wholesalers`                      | granted             | `42501 permission denied` |
| `rpc/v2_public_wholesaler {"p_wid":"mg"}`    | n/a                 | 1 row, public columns only |
| `rpc/v2_public_wholesaler {"p_wid":"%"}`     | n/a                 | `[]` — cannot be turned into a list |
| `rpc/v2_owner_billing_list`                  | n/a                 | `42501 permission denied for function` |

And the legitimate paths still work — checked by impersonating real profiles:

```
owner  (7fac8927…)  → 5 wholesalers, 5 billing rows, 8 brand rows
sq     (a315d124…)  → exactly 1 wholesaler row ("sq"), 1 wid in brands
sq  contact_email        blocked: permission denied for table v2_wholesalers
sq  contact_phone        blocked: permission denied for table v2_wholesalers
sq  price_amount         blocked: permission denied for table v2_wholesalers
sq  paid_until           blocked: permission denied for table v2_wholesalers
sq  owner_notes          blocked: permission denied for table v2_wholesalers
sq  v2_owner_billing_list()   blocked: Only the platform owner can read cross-wholesaler analytics
sq  v2_wholesaler_billing     blocked: permission denied for view
sq  brand (should work)       readable
```

## Gate 1 fired, and was overridden deliberately

`check_no_feature_loss.sh` went RED at 46 removed lines — correctly. The
removal is the point: the buyer app's "Suppliers" screen listed every
wholesaler on the platform. Re-run with the override, and the deletions are
confined to exactly four files:

```
+36  -6   js/data/catalog.js
+14  -1   js/data/subscriptions.js
+10  -2   js/lib/nav-config.js
+36  -37  js/views/buyer.js
```

All other gates green with the change in place: Gate 2 (20 assertions,
27 destinations), Gate 3 (37 assertions, 0 page errors — buyer now 4 tabs),
Gate 4 (18 contrast pairs), Gate 5 (86 tokens), Gate 6 (15 controls at 44px),
tag input (13), escaping (13), image downscale (8).

Screenshot of the replacement screen: `checks/screenshots/suppliers-mobile.png`.

---

# 29 Aug 2026 — `check_pack_moq.sh` was reporting 8/11 on a stale fixture

**This gate had not been able to test its own acceptance half for weeks, and
said so in a way that read like the opposite.**

Running the suite for the Door A branch, three cases failed:

```
  FAIL  a genuine pack IS accepted below per-SKU minimums    expected ACCEPTED
  FAIL  3 genuine packs (quantities scale correctly)         expected ACCEPTED
  FAIL  ordinary order meeting the minimum                   expected ACCEPTED
```

Read at face value that says **the MOQ rule is refusing legitimate orders** —
about as alarming as this product gets. It was not true. The fixture had
fallen behind the schema in three separate places, each one killing the order
*before* any MOQ logic was consulted:

| # | what the server actually said | why |
|---|---|---|
| 1 | `null value in column "location_id"` | migration 047 made every order carry a location; the check still passed `null` |
| 2 | `reservation not active or not found` | `v2_submit_order` confirms a reservation per line; the check never made one |
| 3 | `null value in column "unit_price"` | the seeded SKUs had no price, so `v2_effective_unit_price` returned null |

Each was uncovered only by fixing the one before it — three failures wearing
one costume.

**Proven not to be a regression from this branch.** The chain was replayed to
087, without migrations 088 and 089, into a separate database, and produced
the *identical* 8 pass / 3 fail. The drift is older than this work.

**The fix does not touch the rules, only the fixture and the harness:**
`checks/seed.sql` gained a default location, stock balances of 1000/SKU, and a
price; `accepted_case()` now reserves each line inline (exactly the cart step a
real buyer performs before checkout) and passes the real location. The eight
rejection cases are untouched and still pass `null` deliberately — those orders
must die on the MOQ rule, and each asserts its exact reason string, so a
not-null error would surface as *"rejected for the WRONG reason"* rather than
sneaking through as a pass.

**Red-proved, twice, and the two proofs are complementary:**

| red proof | failures | which cases fell |
|---|---|---|
| per-SKU minimum raised to 9999 | 2 of 11 | *ordinary order meeting the minimum* (+ the reason string of the below-minimum case) — both pack cases stayed green, which is correct: **packs are exempt from per-SKU minimums, and that exemption is the feature** |
| pack composition corrupted by +1 | 2 of 11 | both *genuine pack* cases — the ordinary order stayed green, untouched by pack rules |

Neither proof moves the cases the other moves. That is the evidence that each
acceptance case is wired to the specific rule it names, rather than to "an
order can be submitted at all".

**The general lesson, which is the same one this file keeps recording:** a gate
that cannot distinguish *"the rule is broken"* from *"I could not ask the
question"* is worse than no gate. The preflight added in Batch 7 catches a
missing database. It did not catch a database that was present and answering,
but whose fixture no longer satisfied constraints added after it was written.

**Two further defects were found in this gate while repairing it, both of the
same family — a check that quietly stops checking:**

1. **The fixture is consumable.** A confirmed reservation decrements
   `qty_on_hand` permanently, so each run of this file eats ~64 units. Seeded
   once at 1000, it would have worked about fifteen times and then begun
   reporting `SETUP FAILED` — a fuse lit by the check itself, which would have
   gone off weeks later with nothing in the output to connect it to its cause.
   `preflight()` now tops the balances up to a known level before asserting.
   Proven by running the file three times consecutively (11/11 each) where the
   third run would previously have started from depleted stock.

2. **The top-up must not become the mask.** A blind `update` would make the
   stock assertion unfalsifiable. It is written so that it touches zero rows
   when the balances do not exist at all: deleting every row from
   `v2_inventory_balances` still exits 2 with *"lowest SKU stock: 0"*. Proven.

---

## SR-07 — `check_ranking_config_versioned.sql` (30 August 2026)

Nineteen assertions. **Ten deliberate breaks**, each applied to a replayed
database, the gate run, then restored and re-run green.

| # | Break | Expected | Result |
|---|---|---|---|
| 1 | `drop trigger trg_v2_ranking_config_record` | 2, 3, 10, 11 fail | ✅ 4 failures, each named |
| 2 | `drop trigger trg_v2_rch_no_rewrite` | 5a, 5b fail | ✅ 3 failures — and 6 too, because the UPDATE 5a then succeeded really did break the chain |
| 3 | `grant select on the history to authenticated` | 1 fails | ✅ "the browser roles hold 1 grant(s)" |
| 4 | verifier replaced with one that always returns empty | 7 fails | ✅ "a row inserted with a forged hash verified clean" |
| 5 | reason requirement removed from `v2_ranking_config_set` | 9a fails | ✅ 9a **and 9b** — the naive rewrite also accepted a typo'd key while returning `ok=true` |
| 6 | no-op guard removed from the recorder | 4 fails | ✅ "a no-op update added 1 history row(s)" |
| 7 | `as_of` rewritten to read the CURRENT table | 11, 12 fail | ✅ returned 45 for a date before the change, and 8 rows for the year 2000 |
| 8 | one line added inside `v2_similar_products`, not snapshotted | 13 fails | ✅ names the function and prints the command that fixes it |
| 9 | `v2_oggi_promoted` referenced from a ranking function | 14 fails | ✅ "paid placement has entered a shelf that claims to be earned" |
| 10 | `v2_ranking_config_list` returns nothing to the owner | 8 fails | ✅ "the owner cannot read the ranking numbers" |

### ⚠️ THREE BREAKS PRODUCED ZERO FAILURES, AND NONE OF THEM WAS A BLIND GATE

Recorded because this is the failure the sentinel exists for, and it happened
three times in one night:

1. **`comment on function v2_popular_now is '…'`** — a comment is not part of
   `pg_get_functiondef`, so the hash correctly did not move. **The break was a
   no-op.** Not a defect: comments are documentation, the hash covers behaviour.
2. **A rewrite that changed the return type** — Postgres refused it outright
   (*"cannot change return type of existing function"*). **Nothing was broken.**
3. **A textual patch of the function body** — produced a syntax error and the
   `create or replace` never ran. **Nothing was broken.** The hash before and
   after was byte-identical, which is what proved it.

In all three the sentinel line printed, so the gate had run. Without it, all
three would have read as *"the gate is blind"* — and the tempting next move is
to "fix" a gate that is working. **A red proof that produces no failures has
proven nothing until you have proven, separately, that the break happened.**
The cheapest proof is a value the break must move: here, the source hash before
and after.

## SR-07 — `check_ranking_client.mjs` (30 August 2026)

Twenty-five assertions. **Seven deliberate breaks.**

| # | Break | Expected | Result |
|---|---|---|---|
| A | client stops requiring a reason | 3 fail | ✅ including "the refusal happens BEFORE the round trip" |
| B | the note stops being rendered | 1 fails | ✅ "THE EXPLANATION IS RENDERED" |
| C | `esc()` dropped from the note and the reason | 1 fails | ✅ the injected `<img>` reached the DOM |
| D | integrity line hidden when nothing is wrong | 1 fails | ✅ |
| E | mapper spreads the row instead of naming fields | 2 fail | ✅ 16 keys instead of 9, and the foreign column arrived |
| F | screen dropped from the owner nav | 1 fails | ✅ "a route nobody can reach is a route that does not exist" |
| G | "could not check" collapsed into "nothing is wrong" | 1 fails | ✅ |

---

## SR-05 — `check_ranking_policy.mjs` (30 August 2026)

Twenty-seven assertions. **Eight deliberate breaks.** This gate guards a page of
promises made to suppliers, so every break below is a way that page could have
quietly become untrue.

| # | Break | Expected | Result |
|---|---|---|---|
| A | the numbers typed into the page instead of read live | 4 fail | ✅ including the absurd-values assertion |
| B | `PROMO_CAP` raised 3 → 8, page still says three | 1 fails | ✅ names the found value (8) |
| C | popular shelf switched to rank on order count | 2 fail | ✅ the page's central claim to suppliers |
| D | policy dropped from the wholesaler navigation | 1 fails | ✅ |
| E | the "what cannot be traded for position" section removed | 1 fails | ✅ |
| F | a failed fetch returns `{}` instead of `null` | 1 fails | ✅ blanks vs an admission |
| G | `esc()` dropped from the published values | 1 fails | ✅ the injected `<img>` reached the DOM |
| H | an internal note leaked onto the published page | 1 fails | ✅ **on the second attempt** — see below |

### ⚠️ BREAK H PRODUCED ZERO FAILURES THE FIRST TIME

Written as a *fallback* that only rendered when a parameter had no public
explanation — and every parameter in the test fixture has one, so the fallback
never ran. **The break did not happen.** Rewritten to leak the note
unconditionally, the gate caught it on the first run.

Third time in one night. The tell each time was the same: before believing a
gate is blind, find a value the break must have moved and check that it moved.
Here it was one `grep -c` on the edited file.

---

## AC-07 / AC-11 / PB-01 — `check_access_request_standing.sql` (30 August 2026)

Thirteen assertions, all of which hold on an **empty** database as well as a
full one. **Three deliberate breaks**, and the second one had to be re-aimed.

| # | Break | Expected | Result |
|---|-------|----------|--------|
| A | `v2_my_access_requests` given a `p_person_id` argument | ≥1 fails | ✅ **5 fail** — the signature assertion, plus every assertion that then read another person's rows |
| B | one global `48` hardcoded in place of the wholesaler's own number | 2 fail | ✅ assertions 5 and 7 — **on the second attempt, see below** |
| C | the owner check removed from `v2_overdue_access_requests` | 1 fails | ✅ assertion 8 |

### ⚠️ BREAK B PRODUCED ZERO FAILURES THE FIRST TIME

The first version of the break replaced the global default `48` — the column
default — rather than the value the function reads. The gate's own fixture sets
an explicit per-wholesaler time on every row it creates, so **not one row in the
test ever fell back to the default.** The break did not happen.

Re-aimed at the expression the function actually evaluates, it fired twice on
the first run.

Same tell as every previous time: before believing a gate is blind, find a value
the break must have moved and prove it moved. Here it was `grep -c '48'` on the
extracted function body — unchanged, which was the whole answer.

---

## AC-07 / AC-11 / PB-01 — `check_access_request_standing_client.mjs` (30 August 2026)

Twenty-seven assertions. **One deliberate break**, aimed at the exact thing the
feature exists to remove.

| # | Break | Expected | Result |
|---|-------|----------|--------|
| A | the dead-end sentence `"Waiting for them to approve you."` restored | 1 fails | ✅ names the line and the file |

That is the whole feature stated as a gate: if those six words ever come back,
the build fails. It is also the only line this change removed, and it is
accounted for in `REMOVALS-APPROVED.md`.

---

## DR-05 restated — `check_wholesaler_directory.mjs` (30 August 2026)

Extended from 33 assertions to 34 when the directory gained a seventh column.
**Adding a column to the directory is precisely the moment a price or a product
count gets added by accident**, so the exact-set assertion was widened to seven
fields rather than relaxed, and a new assertion was added that fails on anything
matching price / product / stock in the returned shape.

Confirmed still live: re-running the old price-leak break against the widened
gate still fires. A gate that stops catching what it used to catch is a gate
that was loosened, not extended.

---

## ⚠️ THE 30 AUGUST HALF-BUILD — `check_access_request_standing_client.mjs`, section 7b

**A 27-assertion gate reported a clean pass on a feature that was half built,
and the half it missed was the important half.**

`js/views/directory.js` contained the dead-end sentence *twice*:

1. the **confirmation**, shown for a moment after pressing "Ask for access" — 
2. the **card**, shown whenever `access === "pending"`, which is what the same
   buyer sees on **every visit afterwards**

Only (1) was fixed. The gate asserted only about (1) — it sliced forward from
`if (res.ok)`, which is the confirmation path and nothing else — so it passed,
the PR merged, and the sentence deployed to production.

### How it was found

Not by the gate. By a `grep -c` for the removed sentence against the **live,
deployed file**, run as the last step of the push:

```
=== the removed sentence must NOT be served:
2
```

Two, where the expected answer was zero. The whole finding is in that number.

### What was wrong with the gate, precisely

It asked *"is the sentence gone from this code path?"* when the feature's
promise is *"the sentence is gone from the product."* Those are different
questions, and the narrower one is the one that is easy to write.

### The fix

Section 7b asserts the sentence appears **nowhere in live code**, on a copy of
the file with comments stripped — because both branches now quote the old
sentence in a comment to explain themselves, and a comment must be able neither
to satisfy nor to break an assertion about behaviour. It then asserts the card
branch independently: names the wholesaler, names that wholesaler's own stated
time, points at where the answer will appear.

| # | Break | Expected | Result |
|---|-------|----------|--------|
| A | dead-end sentence restored **on the card branch** | ≥1 fails | ✅ **4 fail** — and the old section-7 assertions all still passed, which is the proof that the old gate could not have caught this |

Value-moved check, per the standing rule: `grep -c "humanHours("` on the edited
file went 2 → 1 and back.

### The lesson, stated so it survives

**A gate that slices to one code path cannot speak for the feature.** When the
promise is an absence — "this sentence is gone", "no price is returned", "this
column is never published" — assert the absence over the whole artefact first,
and only then narrow to a path for the positive assertions.

The tell here was available and was nearly skipped: the deployed-bytes check at
the end of the push was treated as a formality. It was the only thing in the
night that asked the whole-file question.

---

## AC-10 — `check_access_reapply.sql` (30 August 2026)

**The question:** *"a wholesaler turned a shop down. What happens the next time
that shop asks — and can the wholesaler see they have asked before?"*

18 assertions. Rolls itself back; a pass raises `ROLLBACK_WITH_REPORT`, so a
runner reading only the exit code will call a pass a failure (§7.1).

### Red-proved eleven ways

| Break | Result |
|---|---|
| A — the cooldown branch deleted from `v2_access_reapply_standing` | **5 red** (3, 4, 5, 6, 10) |
| B — `v2_submit_signup_request` restored to its pre-106 body | **1 red** (10) |
| C — `supersedes`/`attempt` dropped from the directory door's insert | **2 red** (6, 12) |
| D — `existing_account` made re-appliable | **1 red** (7) |
| E — the "note must be new" comparison deleted | **2 red** (5, 6) |
| F — the `__unknown__` policy row deleted | **first: ZERO. See below.** then **1 red** (9b) |
| G — `anon` granted `select` on the policy table | **1 red** (15) |
| H — the standing computed for every row, not the newest | **1 red** (13) |
| I — `v2_shop_key` made an identity function | **1 red** (10) |
| J — `max_attempts` raised out of reach | **1 red** (8) |
| K — the queue's join to the superseded row removed | **1 red** (12) |

### ⚠️ BREAK F PRODUCED ZERO FAILURES, AND THE REASON WAS A DEFECT

Deleting the `__unknown__` policy row was expected to turn assertion 9 red.
Nothing happened. The gate was blind — and the thing it was blind to was worse
than a blind gate.

With no policy row, `v_pol` is an all-NULL record, and every guard in the
function is a comparison against NULL:

```
not v_pol.reappliable          -> NULL -> branch does not fire
v_used >= v_pol.max_attempts   -> NULL -> branch does not fire
now() < v_next                 -> NULL -> branch does not fire   (v_next is NULL too)
```

So the function fell through all three and returned `ok`. **A missing policy row
silently permitted everything.** Delete the `existing_account` row — the one
applicant this feature refuses outright — and they would have been let straight
in, with nothing anywhere saying a word.

Assertion 9 could not see it because `ok` was also the right answer for the
right reason. **Two different causes, one observable outcome, is the definition
of a blind assertion.**

**Both halves were fixed.** The function now writes out an explicit fallback
instead of leaving the answer to three-valued logic (migration 106 §3), and
assertion **9b** proves the ROW is what decides by moving its number and
watching the answer follow. 9b goes red on break F, and would go red on any
future change that replaced the table with constants in a function body.

**Sixth time this weekend that "no failures" meant "the break did not happen",
and the third time the break itself was the finding.**

### ⚠️ AND THE FIRST DRAFT OF ASSERTION 7 IN THE MIGRATION FAILED — CORRECTLY

Migration 106's self-assertion 7 originally read: *there is exactly ONE
anon-callable function that inserts into `v2_signup_requests`.* It failed
against production, and that failure is the reason section 6 of the migration
exists.

`v2_submit_signup_request` (migration 024) is a second one, granted to `anon`,
live behind "Don't have an account? Request access" on the sign-in screen
(`js/views/login.js:306`). A buyer inside a cooldown could sign out and use it.
Every rule in the feature was one sign-out from meaningless.

**Counting the doors was the wrong question.** The assertion now says that
EVERY anon-callable function which inserts an access request must reference
`v2_access_reapply_standing` — a property of all of them, which stays correct
when a third door is added. Same shape as §7b's lesson, one level up: assert the
property over the whole artefact, not over the instance you happened to write.

### The known gap, asserted rather than hidden

Assertion **11** passes when a DIFFERENT typed shop name is treated as a
different applicant by the anonymous door. That is a limitation, and it is
written as a passing assertion on purpose: a limitation nothing checks is a
limitation that quietly becomes a surprise. Anyone who later makes name matching
cleverer will find this line red and will have to decide deliberately.

The anonymous door has one handle — a typed name — because there is no account
behind it. The point of AC-10 is that **no wholesaler reviews the same shop
blind**, not that a determined applicant cannot be determined.

---

## AC-10 — `check_access_reapply_client.mjs` (30 August 2026)

46 assertions, run against a real DOM.

### The properties, in the order they would hurt

1. **The browser never decides whether a shop may ask again.** Every branch
   switches on the server's `reapply_state`. The gate forbids date arithmetic
   and cooldown constants in both client files, because two answers to "may I
   ask again" means the one the buyer sees is the one developer tools can edit.
2. **No declined row is a dead end** — five states, five real sentences.
3. **One "Ask again" button per wholesaler**, on the newest attempt only.
4. **Asking again uses the same `requestAccess` as a first application.**
5. **Both review screens share one history component.**

### Red-proved seven ways

| Break | Result |
|---|---|
| the "must wait" sentence returns `""` | **2 red** |
| the standing rendered on superseded rows too | **1 red** |
| the view computes the cooldown itself (`new Date(x) < new Date()`) | **2 red** |
| the data module computes it instead (`Date.now() > …`) | **1 red** |
| the view invents a second `v2_reapply_for_access` RPC | **2 red** |
| a first application gets an empty history box | **1 red** |
| the buyer's note written with `innerHTML` | **1 red** |
| the owner console grows its own history markup | **1 red** |
| the wholesaler queue reverts to a raw `select` | **2 red** |

### ⚠️ THE DATE ASSERTION WAS WRONG TWICE, IN OPPOSITE DIRECTIONS

**First draft — too narrow.** It read
`/Date\.now\(\)|new Date\(\)\s*[<>]|getTime\(\)\s*[<>+-]/` and a red proof
written as `new Date(r.reapplyAt) < new Date()` walked straight past it. The
comparison was right there; the bare `new Date()` was on the RIGHT of the
operator and the pattern only looked at the left. **A regex that asks about one
side of an operator is the same mistake as a gate that asks about one code
path.**

**Second draft — too wide.** Widening `[<>]` to `[<>=]` made
`const d = new Date(iso);` inside `formatDay` match on the ASSIGNMENT, and the
gate went red on correct code. Relational operators mean "deciding a cooldown";
`=` means "parsing a date in order to print it", which the presentation helper
is allowed to do.

**What it reads now** matches both operand orders and only relational operators:

```
/Date\.now\(\)|new Date\([^)]*\)\s*[<>]|[<>]\s*=?\s*new Date\(|getTime\(\)\s*[<>+-]/
```

Red-proved in both orders and in both files afterwards.

---

## DR-05 / AC-07 restated — `check_access_request_standing_client.mjs` widened 11 → 18 (30 August 2026)

AC-10 added seven fields to the same mapped row, so the fixed-field assertion in
that gate was widened with the new names written out.

**The assertion is not about the number.** It is about `js/data/access-requests.js`
declaring an explicit field list rather than spreading the row, so a column added
for one screen cannot surface on another because nobody was looking. Widening it
deliberately is how that property is kept; deleting it is how it is lost. Same
decision, same reasoning, as widening `check_wholesaler_directory.mjs` 33 → 34
the same night.

---

## AC-01 / ID-03 — `check_approval_grants_access.sql` (30 August 2026)

**The question:** *"a wholesaler pressed Approve. Can that shop now actually buy
from them?"*

It sounds too obvious to test. It was **false in production for the whole life
of the marketplace front door**, and nothing said so, because the path had never
once run — production has zero approved requests and every membership that
exists came from a one-off backfill.

17 assertions. Rolls itself back; a pass raises `ROLLBACK_WITH_REPORT` (§7.1).

### Red-proved eight ways

| Break | Result |
|---|---|
| A — the membership insert removed (the pre-107 defect, restored) | **4 red** (2, 3, 4, 5) |
| B — the membership written `active = false` | **4 red** (2, 3, 4, 5) |
| C — a password minted for the marketplace buyer too | **1 red** (6) |
| D — the anonymous path loses its password | **2 red** (8, 8b) |
| E — the membership written unconditionally, with no person | **the gate dies on a NOT NULL violation** — red |
| F — the marketplace account given `crypt('')` as its hash | **first: ZERO. See below.** then **1 red** (6b) |
| G — the marketplace-record check removed | **1 red** (10) — it raises on a foreign key instead of refusing in words |
| H — `decided_at` / `reviewed_by` dropped from the person path | **1 red** (12) |

Break A is the important row: it restores exactly what production did before
this migration, and **four assertions fire**. That is the measurement that says
this gate would have caught the original defect.

### ⚠️ BREAK F PRODUCED ZERO FAILURES — ASSERTION 6b WAS BLIND

6b meant to prove that the account minted behind a membership cannot be signed
into. It read:

```sql
select b.ok from wholesale_v2.v2_buyer_login(wB, 'gate_appr', '') b;
```

`gate_appr` is the fixture's username **at store A**. There is no such user at
store B, so the login failed for the wrong reason and the assertion passed no
matter what password the store-B account carried. Replacing the random hash with
`crypt('')` — a hash of the empty string, which anyone could sign in with —
changed nothing at all.

It now looks the username **up** from the account the membership actually points
at, and tries the three passwords a broken hash would accept: the empty string,
the username itself, and `password`. Break F then fires immediately.

**Seventh time this weekend that "no failures" meant "the break did not
happen", and the second time the blind assertion was testing the wrong object
rather than the wrong property.**

### ⚠️ AND ASSERTION 7 WAS WRONG WHILE THE CODE WAS RIGHT

7 read `msg !~* 'password to send.*[A-Za-z0-9]{8}'`, meaning "the success
message does not contain an actual password". It fired on the correct message,
because ordinary prose after the words *"password to send"* is also eight
alphanumerics.

Guessing at the SHAPE of a credential inside free text is not a check. Whether a
credential was returned is a **structural** question and assertion 6 already
answers it. 7 now asserts the real behavioural difference between the two paths:
the legacy one returns an empty `msg` and expects a password box, this one
returns a sentence.

### Two assertions that exist because a fixture can lie

- **Assertion 1** checks the store is NOT in the switcher *before* approval. An
  end-state assertion with no before-state can pass on a fixture that was
  already correct.
- **Assertion 8b** proves the anonymous applicant's password works by **signing
  in with it**, not by observing that a string came back. Half of migration 107
  is a promise that nothing was taken from the person with no OGGI account, and
  the only honest way to keep that promise is to use the credential.

---

## AC-01 / ID-03 — `check_approval_grants_access_client.mjs` (30 August 2026)

29 assertions against a real DOM. Red-proved six ways: the credentials box
rendered with nothing in it, the password hidden when there is one, half a
response treated as credentials, the panel written with `innerHTML`, the owner
console given its own copy back, and the data module dropping the server's
message.

### The assertion that had to be rewritten to be about structure

`!/Username|Password/i.test(text)` looked like a fine way to say "there is no
credentials box". It went red on correct code, because the sentence for the
OTHER outcome contains the word: *"there is no password to send"*.

The box now carries `data-creds` and the assertion reads the DOM. **Same lesson
as the `data-access` attributes on the directory cards, learned again: an
assertion that greps for the words on a screen breaks the moment the wording
improves, which teaches people to stop improving wording.**

---

## `check_token_completeness.mjs` widened to `js/` (30 August 2026)

The gate read `css/` only. This app writes a great deal of style inline from
JavaScript — `style.cssText`, and `style=""` inside template literals — and the
gate had never looked there.

**`--surface-sunken` was referenced in five inline styles across four view
files, has never been defined anywhere in this repo, and had been falling back
to a hardcoded `#f7f7f5` for weeks.** It was found because two hand-rolled
approval panels were being replaced by one component, and this was *how* the two
copies had drifted: one used `var(--bg-sunken)`, the other `var(--surface-sunken)`.

Pointing the same scan at `js/` found **ten more**, across twenty files.

### The eleven are allowlisted by name, and the allowlist cannot rot

Rewriting eleven colours across twenty files is a visual change to most of the
application, made overnight, that nobody can review until morning — and this
gate exists to stop colour changes nobody decided. So they are named, dated, and
the gate is green on exactly them.

Three separate ways it stays honest, each red-proved:

| Break | Result |
|---|---|
| a new undefined token in an inline `js/` style | **red** |
| an allowlisted token used in a **stylesheet** rather than inline | **red** |
| an allowlist entry no longer used anywhere | **red** |
| a token deleted from `tokens.css` (the original behaviour) | **red** |

The third is what stops the list becoming a graveyard: it shrinks as the tokens
get fixed, and an entry that has stopped being true fails the gate.

`--surface-sunken` was a twelfth entry and came straight off, because all five
of its uses were repointed at `--bg-sunken` in the same change.

---

## ⚠️ THE SHAPE HASH WAS TRUNCATING EVERY SIGNATURE TO 63 CHARACTERS (30 August 2026)

The largest instrument failure found this weekend, and it was in the gate that
exists to catch instrument failures.

`checks/replay_migrations.sh` describes its shape hash as *"the sharper half: an
md5 over every table, view and function SIGNATURE in the schema. A substitution
that happens to preserve the counts still moves it."*

**It did not.** Migration 108 changed three function signatures and added a
column, and the script printed:

```
   tables=104 views=4 functions=161 policies=96
   shape=61d82639528d44bfaa0ab9ebed42a7c4
   MATCHES the 30 Aug 2026 production baseline exactly, shape included.
```

### The mechanism

```sql
select c.relname as nm from pg_class ...      -- type: pg_catalog.name
union all
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
```

`relname` is of type `name`, a **fixed 64-byte type**. In a UNION, Postgres
resolves the result column to it — so every function signature in the second
branch was silently cut to 63 characters before being hashed:

```
[v2_submit_signup_request(p_wid text, p_buyer_name text, p_locat]  len=63
[v2_access_reapply_standing(p_person uuid, p_wid text, p_name te]  len=63
```

Any change past character 63 of a signature was invisible. In this schema that
is **most of them**: adding, removing or retyping a parameter on any function
whose name and argument list run past about fifty characters moved nothing at
all. The hash had only ever moved when functions were **added or removed**,
because that changes the short leading text — which is why it looked healthy for
weeks and was quoted as evidence in three baseline moves.

### Proven, not argued

Two replays, identical object counts, two differing signatures:

| | old (truncating) | corrected (`::text`) |
|---|---|---|
| replay at 107 | `61d82639528d44bfaa0ab9ebed42a7c4` | `e656498f00a42358245a1f830ea0cc1a` |
| replay at 108 | `61d82639528d44bfaa0ab9ebed42a7c4` | `7801271d40a7d164eaec52bb2a8c3ab3` |
| | **identical — blind** | **different — visible** |

### The baseline move is legitimate because both sides were measured first

```
corrected hash, replay at 107 ...... e656498f00a42358245a1f830ea0cc1a
corrected hash, PRODUCTION at 107 .. e656498f00a42358245a1f830ea0cc1a   <- identical
corrected hash, replay at 108 ...... 7801271d40a7d164eaec52bb2a8c3ab3
```

The first two agreeing is what proves the repo and production had not diverged
under the corrected instrument, and that 108 is precisely the one migration
outstanding. Moving a baseline without that comparison is just silencing an
alarm — the script says so itself, and this move obeys it.

### The canary, red-proved

If the `::text` cast is ever lost, every long signature collapses to exactly 63
characters. The script now measures `max(length)` over the same set and refuses
to print a hash at all if it is 63 or less:

```
!! THE SHAPE HASH IS TRUNCATING. Longest hashed signature is 63 characters,
   which means the union column resolved to pg_catalog.name (63 bytes) again.
```

Red-proved by removing the cast: it fires, and the script exits before printing
a hash that cannot be trusted. **This exact condition was true for weeks and
nothing said so**, which is the argument for a canary rather than a comment.

---

## ⚠️ AND THE RED-PROOF RUNNER REPORTED ZERO FAILURES TWICE (30 August 2026)

Worth recording because it is the same failure one level up, and it nearly
banked two blind assertions as proven.

The throwaway harness used to apply breaks took the gate to run from a variable
edited by `sed` between rounds. Twice the `sed` pattern matched nothing, the
harness kept running the **previous** gate, and every break against the new one
came back "ZERO FAILURES" — for breaks it had never applied to the gate under
test.

Both times the giveaway was the same: a break that obviously should fire,
producing nothing. It is now passed the gate name as an argument, and it
sentinels on the gate's own `passed:` line — if the gate did not run at all,
that is reported as "GATE DID NOT RUN", not as a pass.

**An instrument that reports on something other than what you think it is
reporting on is exactly the defect this whole file exists for, and the tooling
around the gates is not exempt from it.**

### And one genuinely blind assertion it caught

`/r\.phone/` tested against a whole view file to ask "does this screen show the
number". It matched the line that **computes** the number, so deleting the line
that **renders** it changed nothing. Computing a value and putting it on the
screen are different claims. Each screen is now asserted against the thing it
actually interpolates into the card, named separately rather than swept into one
loop with one loose regex — and red-proved on each.

---

## AC-05 — `check_bulk_invite.sql` (30 August 2026)

**The question:** *"a wholesaler pastes in forty existing customers. Does each
one get exactly one working link, and does the fortieth behave like the first?"*

18 assertions. Rolls itself back; a pass raises `ROLLBACK_WITH_REPORT` (§7.1).

### The assertion that took two attempts to make meaningful

Assertion 8 counts audit entries — one per invitation. It looked like the proof
that bulk really delegates to `v2_issue_buyer_invite` rather than inserting for
itself.

**It is not, and a red proof showed why.** Migration 104's recorder is a trigger
**on the table**, so a direct insert fires it too. A bulk path that reproduced
the insert would audit correctly, scope correctly, and pass every other
assertion in the file.

The one behaviour that lives *only* inside `v2_issue_buyer_invite` is the expiry
clamp — *"a caller-supplied 36500 would be an invite that never dies, which is
the same as no expiry at all"*, in its own words. So **assertion 11** asks for
9999 days and requires the answer back to be under 181. A path that inserted for
itself would honour 9999.

That is what turns *"bulk is a loop over the single-invite function"* from a
sentence in a migration header into something a machine checks. Red-proved with
a working, valid bulk path that inserts directly: **7 assertions fire.**

### Red-proved six ways

| Break | Result |
|---|---|
| bulk inserts for itself instead of delegating | **7 red** (incl. 11) |
| the duplicate guard removed — a second live token per shop | **4 red** |
| failed rows dropped instead of returned | **1 red** (6) |
| the 200-row cap removed | **2 red** (9, 9b — 209 invitations minted) |
| dedupe on the raw phone instead of the shared normaliser | **3 red** |
| a revoked invitation counted as live — withdrawing becomes a ban | **3 red** |

### And one assertion whose number came from memory

Assertion 8 first expected **7** invitations; the fixture makes **8**. The gate
went red and was right to: an assertion whose count is remembered rather than
derived from the fixture is an assertion about the author's memory. The number
is now written out with its arithmetic beside it.

---

## AC-05 — `check_bulk_invite_client.mjs` (30 August 2026)

28 assertions. Red-proved five ways.

### The two that protect real work

**The parser finds the number at the END of the line**, not by splitting on the
comma. Red-proved with a comma split, which turns

```
Rita, Beirut, 03 111 222   ->   shopName "Rita",  phone "Beirut"
```

A shop name may contain a comma; a phone number may not.

**The bulk handler must NOT repaint the card.** `paintInvites()` rebuilds the
card's `innerHTML`, which would destroy every link it just produced in order to
refresh the list of previous invitations sitting underneath it. The links are
the deliverable. This was a real bug in the first draft of the handler, caught
while writing the gate, and it is now asserted **twice** — that the repaint is
absent, and that the comment explaining why is present, so the next person does
not helpfully add it back.

Same family as the single-invite path showing its link rather than toasting it,
and the approval panel replacing its card: **in this product, a generated
credential is never put somewhere that can be swept away by a refresh.**

---

## GATE — `check_size_order.mjs`

**31 August 2026.** Added after a live demo catalogue rendered a trucker
jacket's order-sheet columns as **`XL  S  L  XXL  M`**, and the filter chips as
**`L  M  S  XL  XXL`**.

Both lists held exactly the right contents. Every existing check passed. That is
the point: this directory asserts *what is in* a list and had nothing that
asserted *what order it is in* — the same blindness that let the 2.0 rewrite
drop the size axis with the shape still looking right.

16 assertions over four size vocabularies: alpha (`XS…3XL`, both spellings of
the doubled sizes), numeric (denim waists, EU shoe sizes), childrenswear ages
(`0-3M … 9-10Y`), and one-size labels.

### Red-proved three ways, each in a different place

| # | Deliberate break | Expected | Result |
|---|---|---|---|
| 1 | `sortSizes` replaced with the old `localeCompare(…, {numeric:true})` | FAIL on the ladders | ✅ FAIL, **6 of 16**, `got: L M S XL XXL` |
| 2 | The `ageInMonths` branch deleted from `size-order.js` | FAIL on ages only | ✅ FAIL, **2 of 16**, `got: 3-4Y 0-3M 18-24M …` |
| 3 | `sortSizes` filters out labels it cannot classify | FAIL on totality | ✅ FAIL, **3 of 16**, `in 10, out 7` |
| 4 | Restored | PASS | ✅ PASS, 16 assertions |

### Why break 3 is the assertion that matters

Breaks 1 and 2 fail loudly on ordering, which is what the gate is obviously
for. Break 3 — silently dropping an unrecognised size — leaves **every ordering
assertion green** and loses a whole column of the buyer's grid. A wholesaler
who writes `TAILLE UNIQUE` or `36/38` would find that size simply gone from the
order sheet, with nothing anywhere reporting a problem.

So the gate asserts **totality** as well as order: the output is a permutation
of the input — same length, same multiset of labels — and an unrecognised label
survives at the end in its original relative order. A sort in this product is
never allowed to be a filter.

---

## GATE — `check_login_doors.mjs`

**31 August 2026.** Added with the separate sign-in links for the wholesalers,
the clients and the control centre (`#/login/wholesaler`, `#/login/client`,
`#/login/control`).

These are links a person pastes into WhatsApp, retypes by hand and bookmarks,
so two things have to hold — and only the first is obvious:

1. the right link opens the right tab;
2. **every other string still opens the ordinary login page.**

47 assertions. The interesting ones are all in (2).

### Red-proved three ways

| # | Deliberate break | Expected | Result |
|---|---|---|---|
| 1 | `DOORS[key] \|\| null`, i.e. drop the `hasOwnProperty` guard | FAIL on inherited keys | ✅ FAIL, **1 of 47**, `"constructor" is not a door — got undefined` |
| 2 | `client` pointed back at the `admin` tab | FAIL on separation | ✅ FAIL, **3 of 47**, `both are "admin"` |
| 3 | a door pointing at a tab that does not exist | FAIL on the tab check | ✅ FAIL, **1 of 47**, `got tab "salesteam"` |
| 4 | Restored | PASS | ✅ PASS, 47 assertions |

### What break 1 actually proved, which is not what I expected

I added the prototype-key assertions expecting `toString`, `valueOf`,
`hasOwnProperty` and `__proto__` to be live holes. They are not: the suffix
pattern is `[a-z-]+`, which excludes the underscores in `__proto__`, and the
key is lower-cased before lookup, so `toString` becomes `tostring` and misses.

**Exactly one inherited key is all lower case and all letters: `constructor`.**
So `#/login/constructor` was the single real hole — `DOORS["constructor"]`
returns the Object constructor, which is truthy, `activeTab` becomes
`undefined`, and the screen renders a card with no tab selected and no panel.
A blank login page, from a link that was only ever a typo.

The gate goes red on that one and stays green on the other four, which is the
useful shape: it is measuring the actual hole rather than agreeing with the
guess that produced it.

### Break 2 is the one that guards the request

A careless edit to `DOORS` that sends the client link back to the admin tab
leaves the links working, the labels correct and every other assertion green —
and quietly undoes the entire reason the doors were built. Assertion group 5
compares the tabs against each other rather than against a constant, so the
separation itself is what is asserted.

---

## GATE — `check_marketplace_feed.mjs`

**1 September 2026.** Added with `v2_marketplace_feed`, the first piece of the
marketplace: products from every catalogue a wholesaler chose to make public,
woven together so the page reads as one shop front rather than six catalogues
stacked end to end.

14 assertions. The one that matters is not "the feed returns products" — it is
that **a private catalogue never appears in it, for anybody, member or not.**

### Red-proved twice

| # | Deliberate break | Expected | Result |
|---|---|---|---|
| 1 | Drop the `c.is_public` condition — the exact mistake a careless widening of scope makes | FAIL on privacy | ✅ FAIL, **2 of 14**, naming all three Atelier gowns for the anonymous caller *and* the member |
| 2 | Reserve organic space against the ad PERCENTAGE instead of actual ad SUPPLY | FAIL on page length | ✅ FAIL, **2 of 14**, `page 0 had 15, page 1 had 15, …` |
| 3 | Restored | PASS | ✅ PASS, 14 assertions |

### Why the privacy check names products instead of deriving them

The obvious implementation reads `v2_catalogs`, splits public from private and
compares. **It cannot:** `anon` has no `SELECT` on that table — correctly, the
catalogue list is not public — so the gate has to *name* what it protects.

It pins `A-102`, `A-109` and `A-110`: Atelier Ronde's made-to-order archive
gowns, which live only in `Occasion Private Edit` (tier 4) and
`Archive & Made to Order` (tier 5). Confirmed against the database that day as
the complete population of private-only products in the demo data.

A pinned list can rot, so the gate also asserts the converse: **Atelier's
public products must be present.** Without it, a feed that returned nothing at
all would pass the leak test perfectly.

### The green proof that isn't one

Raising `feed_pct_ads` from 20 to 25 with zero ads available leaves every page
full — which *looks* like proof the backfill works, and is not. It only shows
the config is read. The break that mattered was in the function, not the
config, and it took changing one line (`v_org_now := p_limit - v_ad_slots`) to
see the assertion fail. Worth remembering: turning a knob is not the same as
breaking the mechanism the knob feeds.

---

## GATE — `check_product_reference.mjs`

**1 September 2026.** Added with the marketplace tile, which prints the product
reference above the name — "send me 12 of SG3286B" is how a wholesale order
actually gets placed, and the reference app Hadi sent gives it its own labelled
field on the product page and under every card.

42 assertions.

### The bug this was written after, not before

The first version accepted a bare leading NUMBER as a reference, so
**"24 Hour Tee" rendered as a small bold `24` above a product called
"Hour Tee"**. Not a crash and not a blank — a product that simply looks
mis-catalogued, on the most public screen in the product. Caught by trying the
function on adversarial names before wiring it to anything.

### Red-proved twice

| # | Deliberate break | Expected | Result |
|---|---|---|---|
| 1 | Remove the "must contain a letter" rule — i.e. restore the original bug | FAIL on bare numbers | ✅ FAIL, **6 of 42**, `"24 Hour Tee" … got ref "24"` |
| 2 | Make the splitter drop a word from the remainder | FAIL on totality | ✅ FAIL, **19 of 42**, `got {"ref":"L-137","rest":"Pima Tee"}` |
| 3 | Restored | PASS | ✅ PASS, 42 assertions |

### Totality again, and why it keeps earning its place

Break 2 is the same shape as the size-order gate's third break: a function that
silently *loses* part of its input while every other assertion stays green. Here
it costs a word out of the product's name on every card in the marketplace, and
nothing anywhere reports a problem. So the gate reconstructs the input from the
output for a whole corpus of names and requires it back exactly:
`ref ? ref + " " + rest : rest`.

Two gates now, written weeks apart in different parts of this codebase, have
both been saved by asserting that a transform is a permutation rather than a
filter. It is worth reaching for by default.

### Why the module has no imports

`js/data/marketplace-feed.js` imports `supabase-client`, which touches `window`
at module load, so a Node gate cannot import anything defined in there — the
same wall `login-doors.js` hit. Pure string logic that a gate should exercise
lives in its own import-free module. That is now the second time this pattern
has been needed; treat it as the default for anything testable.

---

## `check_pack_breakdown.mjs` — 44 assertions, red-proved 3 ways
### 1 September 2026, MK-03

**What was wrong.** `Packing content` — the line that tells a buyer what is in
the carton — was built by walking `pack.components` in Postgres row order:

    pack.components.map(c => `${c.qtyPerPack}×${c.size || c.sku}`).join("/")

A **ratio** pack has one component per size, so that read correctly and had
read correctly for weeks. A **series** pack has one component per **colour ×
size**, and the colour is not in the label. C-117 Byblos Ballet Flat has 24
components over 6 sizes and printed:

    1x39/1x40/1x39/1x38/1x41/1x40/1x37/1x41/1x36/…

Six sizes, each four times, in no order. Casa Sole (C-101/103/105, 21
components / 7 sizes) and Vantage (V-149, same) are identical in shape. All
four are on screen for the demo.

**Nobody reported this.** It came out of a sweep counting components per pack
against distinct sizes per pack — the kind of query that finds display bugs a
screenshot walks past, because every number on the screen was correct. There
were just four times too many of them.

| # | Break | Expected | Result |
|---|---|---|---|
| 1 | Restore the row-order map — i.e. the original bug | FAIL on aggregation | ✅ FAIL, **11 of 44**, `got 1×39/1×40/1×38/1×41/…` (24 entries) |
| 2 | Aggregate, but keep the FIRST quantity per label instead of summing | FAIL on totality | ✅ FAIL, **4 of 44**, `C-117 … got 1×36/1×37/…`, `corpus[0] printed total preserved` |
| 3 | Drop the size sort, leave first-seen order | FAIL on order | ✅ FAIL, **4 of 44**, `got 4×39/4×40/4×38/4×41/4×37/4×36` |
| 4 | Restored | PASS | ✅ PASS, 44 assertions |

### Break 2 is the one that mattered

Break 1 is the bug that was already shipping, and it is loud: the line looks
wrong, so somebody questions it. Break 2 is quiet. It produces
`1×36/1×37/1×38/1×39/1×40/1×41` — a plausible, tidy, correctly ordered size run
that is **six pieces where the carton holds twenty-four**. It looks right and
gets ordered short, and the first anyone hears about it is a delivery dispute.

Only two assertions catch it: `units` against the plain sum, and the sum of the
printed quantities against the same. Both are totality assertions, and this is
the **third** gate in this codebase saved by asserting that a transform is a
permutation rather than a filter (after `check_size_order` and
`check_product_reference`). It is no longer a pattern worth noticing — it is the
default, and a gate over any aggregation that does not assert its total is
incomplete.

### Junk that had to be decided rather than guarded

A component with a quantity but **no size and no sku** is labelled `—` and
kept, not skipped. Skipping it is a silent short count, which is break 2 by
another route. A non-numeric `qtyPerPack` contributes 0 rather than `NaN`,
because one `NaN` turns the whole total into `NaN` and prints a carton
containing "NaN pieces".

---

## `check_marketplace_search.mjs` — 41 assertions, red-proved 3 ways
### 1 September 2026, MK-04

**What this is for.** One search bar at the top of the marketplace, per Hadi's
spec: *"a normal search bar that ... gives them the ability to decide, I want a
product or I want a wholesaler or a brand."* The wholesaler half already
existed (`v2_directory_list` has taken a `p_search` since DR-01); migration 115
is the product half.

**Why the assertion that matters is the SCOPE.** A search box is the easiest
place in a marketplace to leak a private catalogue, because a search gets
written as *"find anything matching"* and a feed gets written as *"show what is
published"* — and the first sentence is one word away from the second. So this
gate does not check that search finds things. It fetches the feed's entire
universe and asserts **containment**: the set search can reach is exactly the
set the feed can show, for an anonymous caller and for a buyer who is a member
of all six shops.

| # | Break | Expected | Result |
|---|---|---|---|
| 1 | `v_like := v_q` — LIKE escaping removed | FAIL on wildcards | ✅ FAIL, **4 of 41**, `"%" is a literal … got 97` |
| 2 | `c.is_public` dropped from `eligible` | FAIL on containment | ✅ FAIL, **17 of 41**, `"gown" … A-102 Beaded Column Gown (Made to Order), A-109 …` |
| 3 | the empty-query guard removed | FAIL on empty | ✅ FAIL, **3 of 41**, `empty query "" returns nothing … got 97` |
| 4 | Restored | PASS | ✅ PASS, 41 assertions |

### Break 2 is the one this gate exists for

Seventeen assertions fell, and the three that name Atelier's made-to-order gowns
are the point: `A-102`, `A-109` and `A-110` live only in a private catalogue,
and one deleted `and c.is_public` made all three findable by name — including
by a buyer who *is* a member of Atelier, which is the case a careless widening
gets right by accident and a deliberate one gets wrong. Nothing on screen would
have looked broken. A private line would simply have been in the results.

### A defaulted argument is a new function — obeyed, not just recorded

`v2_marketplace_search` is a separate function rather than a `p_query` on
`v2_marketplace_feed`. Migration 113 added a defaulted `p_sort` to the feed,
which created a **second overload** instead of replacing the first; PostgREST
refused both with PGRST203 and the live feed broke until 114 dropped the
4-argument signature. That lesson is in `CLAUDE.md`, and this is the first
change made after it.

### Repo and database agree, and it was checked rather than assumed

The normalised body of `supabase/migrations/115_v2_marketplace_search.sql`
(comments stripped, whitespace collapsed) hashes to
`642223c6cbeb78a959fc33d3704ea927`, and so does `pg_proc.prosrc` for the live
function. The file the repo would replay is the function the database is
running — not a file that looks like it.

---

## check_product_public_flag.sql — MOD-01, migration 116

10 assertions. **Red-proved three ways**, each break caught by the assertions
written for it, green again on restore:

| # | Break | Result |
|---|---|---|
| 1 | Publish a product that lives only in a PRIVATE catalogue | **2 of 10 red** — `FAIL 4: LEAK` and `FAIL 7: 1 product(s) flagged public with no public catalogue` |
| 2 | Un-publish a product that lives in a public catalogue | **2 of 10 red** — `FAIL 3` and `FAIL 8: 1 public-catalogue product(s) were dropped from the feed` |
| 3 | `alter column is_public set default true` | **1 of 10 red** — `FAIL 1: a new product did not default to private` |

### The draft of this gate that would have lied

The first version **re-ran the migration's backfill** before asserting. Pointed
at a production snapshot that had drifted, that `UPDATE` silently repairs the
drift inside its own transaction and then every assertion passes — a check that
fixes the defect it exists to find. It is the same failure `check_pack_moq.sh`
was written about, wearing different clothes: seven green while the function
crashed on every call.

The flags are now set explicitly in the fixture and the invariant is measured,
never re-derived. The file is safe to point at production for that reason.

### Why break 3 matters more than it looks

Nothing on any screen would look wrong if `is_public` defaulted to true. Every
product a wholesaler created from that day on would publish itself to the entire
marketplace the instant they pressed save — including the private couture lines
that are the whole reason the flag exists. There is no error state, no warning
and nothing red. Assertion 1 is checked **before** the fixture is flagged, on a
row nobody has touched, because that is the only moment the default is visible.

### Containment, not sampling — the third gate to reach for it by default

Assertions 7 and 8 are the same shape `check_marketplace_search` and
`check_marketplace_feed` arrived at: assert only "nothing leaked" and a backfill
that flagged NOTHING passes perfectly; assert only "nothing was dropped" and a
backfill that flagged EVERYTHING passes perfectly. Assertion 9 exists solely to
close the second hole — the private side of the platform must not be empty.

### Verified against production, read-only, 6 Sep 2026

`101` flagged public, `26` private, `0` leaked, `0` dropped, default `false`,
`NOT NULL` enforced. Atelier's `A-102`, `A-109` and `A-110` — the three
made-to-order gowns the feed gate already protects by name — are in the private
set, and Atelier's 7 published products are still public, so the result cannot
be a shelf that is simply empty.

---

## check_store_pricing_dial.sql — MOD-05, migration 117

14 assertions. **Red-proved three ways:**

| # | Break | Result |
|---|---|---|
| 1 | Remove the `customer_only` 0% fallback | **1 of 14 red** — `FAIL 8: customer_only + 0% customer gave 0, expected the 10% store fallback` |
| 2 | `combine` stops adding the customer discount | **2 of 14 red** — `FAIL 4` **and `FAIL 13: 2 (store, client) pairs would be repriced`** |
| 3 | Create a second overload of the function | **1 of 14 red** — `FAIL 12: 2 overloads — PostgREST will refuse all of them` |

### Break 2 is the one to read

It was caught **twice** — by the direct arithmetic assertion and by the
**parity** assertion. Parity is the whole safety argument for MOD-04: for every
store × every client, the store dial must return exactly what that store's
default catalogue returns today. If that holds, merging the catalogues into one
store provably is not a price change. Break 2 shows the parity assertion
actually bites rather than decorating the file.

### Why this gate exists at all, and what it found first

MOD-04 was next in the build order and **could not safely be built.**
`v2_effective_unit_price` takes a `p_catalog_id` — the catalogue is part of the
PRICE, not just a shelf. Measured on production: **23 products sit in two or
more catalogues and all 23 have conflicting discount percentages.** Merging the
catalogues first would have given those 23 products two prices with no rule to
choose between them. The plan's order was wrong and the data said so.

### The migration's own assertion is vacuous on replay — deliberately

117 compares the same two functions, but a fresh replay into an empty database
has no wholesalers and no clients, so it passes over **zero pairs**. Correct for
replay, useless as evidence. This file is where the parity claim is earned,
because it brings its own corpus — and **assertion 14 exists solely to prove the
corpus is not all zeros**, since parity over an all-zero corpus proves nothing.
That is the same hole assertion 9 closes in `check_product_public_flag`.

### Verified against production, 6 Sep 2026

**767 (wholesaler × client) pairs, 0 repriced**, and **520 of those pairs carry a
non-zero discount** — so the result is not the artefact of an all-zero corpus.
Exactly 1 overload of `v2_store_discount_pct`. Past orders cannot move:
`v2_order_items.unit_price` is stored, not derived.

---

## check_buyer_store_read.sql — MOD-04, migration 118

10 assertions. **Red-proved three ways:**

| # | Break | Result |
|---|---|---|
| 1 | Remove the dedupe | **3 of 10 red** — a product in two catalogues appeared twice |
| 2 | **Bypass the gate** — read every catalogue instead of the granted ones | **1 of 10 red** — `FAIL 6: an ungranted account read 3 rows` |
| 3 | Dedupe prefers the LAST catalogue instead of the default | **2 of 10 red** — `FAIL 4` (sort_order 99, expected 1) and `FAIL 8` |

### Break 2 is the reason this file exists

`v2_buyer_store_read` deliberately does **not** re-derive "which catalogues may
this account see" — it calls `v2_buyer_catalogs`, the same function the
per-catalogue read gates on. Re-implementing that in a second place is how two
answers drift apart, and **the day they do, the wider one wins silently** and a
buyer sees a catalogue nobody granted them. Assertion 6 asserts the delegation
by making the gate return nothing and requiring the store read to return
nothing too — a behaviour, not a spelling.

### Why stubs

The fixture stubs `v2_buyer_catalogs` and `v2__catalog_rows` so the **real body**
of `v2_buyer_store_read` runs against data the test controls. Rebuilding the
whole catalogue stack would have been hundreds of lines that mostly test the
fixture.

---

## Two gates that had been RED on `main`, found 6 Sep

Neither was caused by the change being made. Both were found by running the
suite before pushing, which is the only reason anyone knew.

### 1. The buyer order sheet had no protection for five days

PR #53 (1 Sep) renamed four CSS class families in `js/components/product-card.js`
from `.os-*` to `.bs-*` — the fix for the stepper collision. It did not update
the two gates that query those classes. `check_buyer_product_card` (75
assertions) and `check_buyer_card_capabilities` (37) both went red immediately
and **nobody ran them**, so from 1 Sep the buyer's order sheet — the screen
being actively reported as broken — had no automated cover at all.

Bisected to be sure: `9d4f48f~1` PASS, `9d4f48f` 23 of 75 failed.

**The code was never at fault.** Correcting the four selectors turns both green
(77 and 37). But that is exactly what makes it dangerous: a stale gate and a
broken feature look identical from a distance, and the fix for one is the
opposite of the fix for the other.

### 2. `replay_migrations.sh` was measuring the calendar and the collation

Red since 30 Aug for two reasons, both instrument error rather than drift:

- **Partitions.** `v2_ensure_movement_partitions(p_months_ahead)` creates the
  inventory-ledger partitions counted forward from **today**, so a September
  replay makes 43 where production holds 42. Real tables were 61 = 61 all along.
- **Collation.** The shape hash mixes bare relation names with `name(args)`
  signatures and sorts the union. Those interleave differently depending on the
  database's collation, because of where `(` falls relative to letters. Proven:
  the relation-only hash and the function-only hash were **identical** on both
  sides while the combined hash differed, and ordering by the UTF8 bytes made
  the replay reproduce production's hash exactly.

This is the same family as the `::text` truncation bug already recorded in that
file — the repo's sharpest structural instrument quietly measuring the wrong
thing. **A gate that cries wolf gets switched off, and then the real difference
walks in.**

Now green and meaningful: 120 migrations replay into an empty Postgres and match
production on tables, views, functions, policies **and** shape hash
(`ba1c3dcdb9c538e85e32e881a2e64b42`).

---

## A defect I shipped this morning, caught the same day

Migration **116** (MOD-01) carried an assertion that raised when no private
product existed. On a fresh replay into an empty database the seed data can
legitimately have every product in a public catalogue, so **116 refused to
apply and the replay stopped there** — the repo could no longer rebuild
production, which is the one thing the migration set exists to do.

It was also redundant: a backfill that flagged everything is already caught by
the assertion above it. The real property — *a private line must exist in the
corpus* — belongs to a corpus, not to a migration, and lives in
`check_product_public_flag` assertion 9, which brings a fixture that guarantees
one. Corrected in place the same day, with the reasoning left in the file.


---

## `check_marketplace_reads_product_flag` — MOD-03, migration 119

**12 assertions. Green against production. Red-proved two ways, both by putting
the real defect back rather than by breaking the check.**

### Why the assertions are behavioural

The structural test — *does the body still say `v2_catalog_products`* — is the
easy half, and it is the half that lies. Grepping for `is_public` passes
happily on a function reading the **catalogue's** `is_public`, which is the
exact bug MOD-03 exists to remove. So the fixture builds two products that the
old rule and the new rule **disagree** about, and asks the live functions which
one they obey:

| fixture | `p.is_public` | catalogue | old rule says | new rule says |
|---|---|---|---|---|
| `pFlag` | true | one PRIVATE catalogue only | hidden | **shown** |
| `pJoin` | false | a PUBLIC catalogue | **shown** | hidden |

There is no way to pass both while reading the wrong column, and no way to pass
either by accident. Assertion 11 (the grep) is last on purpose: it is the
weakest thing in the file and catches only the edit that adds the join back.

### Red proof A — both functions reverted to the catalogue join

Both live definitions were fetched with `pg_get_functiondef`, `where
p.is_public` was replaced by the old two-join form at all three sites (2 in the
feed, 1 in the search — the site count is asserted before the revert, so a
silent partial revert aborts rather than producing a weak proof), and the
unchanged gate was run against them.

**7 passed, 5 FAILED:**

```
1 feed hides a flagged product | 2 LEAK in the feed |
6 search hides a flagged product | 7 LEAK in the search |
11 2 function(s) still join the catalogue
```

### Red proof B — only the SEARCH reverted

The half-done refactor: one function moved to the flag, the other left behind.
This is the failure the file was really written against, because it is the one
that looks fine on screen.

**8 passed, 4 FAILED:**

```
6 search hides a flagged product | 7 LEAK in the search |
8 DRIFT feed vs search | 11 1 function(s) still join the catalogue
```

Assertion 8 fires **only** in proof B — in proof A both functions were wrong in
the same direction and agreed with each other perfectly. That is the point:
agreement is not correctness, and correctness is not agreement. The file needs
both kinds of assertion.

### Everything ran inside one DO block, so the DDL rolled back too

Reverting a live function on production is not a safe thing to do casually.
Both proofs did the `CREATE OR REPLACE` with `EXECUTE` **inside** the same
`DO` block as the assertions and ended on a deliberate `RAISE EXCEPTION`, so
Postgres rolled the function definitions back with the fixture — a `DO` block
is a single statement, and DDL in Postgres is transactional. Verified after:
`zz_m3` rows 0, catalogue joins remaining 0, and the feed and search hashes
still `f920f6d2…` and `d885bf0a…`.

### What this gate deliberately does NOT assert

Migration 119 proved at apply time that the flag and the catalogue join select
the identical set across the whole corpus — 0 gained, 0 lost. **That equality
is not repeated in the gate**, and the omission is the point: it was true of
one moment, the moment the rule moved. The store model exists so that a
wholesaler can publish a product belonging to no catalogue, and on that day
corpus equality is correctly false. A gate asserting it would go red the first
time the product did what it was built to do — and a gate that cries wolf gets
ignored, which is how `check_buyer_product_card` sat red on `main` for five
days.

Assertion 9 keeps the one corpus property that outlives catalogues: the
marketplace is not empty. Without it, "the feed and the search agree" is
satisfied perfectly by a marketplace that shows nothing to anyone.

### And it was proved against the REPO, not only against production

`replay_migrations.sh` was run with `KEEP_DB=1` and the gate was pointed at the
resulting scratch database — 121 migrations replayed into an empty Postgres 16,
no production data anywhere near it:

```
== 121 migrations applied, no errors
   tables=62 views=4 functions=166 policies=96
   shape=ba1c3dcdb9c538e85e32e881a2e64b42
   MATCHES the 6 Sep 2026 production baseline exactly, shape included.

check_marketplace_reads_product_flag: 12 passed, 0 failed
```

This matters more than the production run. The shape hash covers **signatures**,
not bodies, so it is unchanged by 119 by design and proves nothing about the new
rule; running the behavioural gate against the replayed database is what shows
that the repo — not the live database — is what produces functions obeying it.

---

## The same defect, twice: a corpus assertion inside a migration

Migration **119** was written with a converse guard: refuse to apply if no
product is public, because *0 gained, 0 lost* is satisfied perfectly by two
rules that both return nothing.

**It stopped the replay at file 121 of 121:**

```
!! STOPPED AT 119_marketplace_reads_product_flag.sql
ERROR:  MOD-03: no product is public. Refusing a silent empty marketplace.
   120 migration(s) applied before this one.
```

An empty database has no public products because it has no products. The
migration refused, and the repo could no longer rebuild production — the one
job the migration set has.

**This is the identical mistake migration 116 was corrected for the day
before**, recorded a few sections above in this same file. Writing that entry
did not stop me making it again, which is worth saying plainly rather than
quietly fixing: the lesson had been recorded as a story about 116 rather than
as a rule, and a story about one migration does not generalise on its own.

The rule, stated so it generalises:

> **A migration may assert things about the change it makes. It may not assert
> things about the data it happens to find.** The first is true on every
> database the file will ever run against. The second is true only where the
> author was standing.

The *gained/lost* comparison stays in 119 — it is a statement about the change,
trivially true on an empty database and a real brake on a populated one. The
converse moved to `check_marketplace_reads_product_flag` assertion 9, which
brings a fixture and therefore brings its own corpus.

Found by `replay_migrations.sh` — which had itself been red for five days on an
instrument fault, and was repaired the day before this. It caught a real defect
within 24 hours of being trustworthy again.

### Repo and database compared, not assumed

The corrected 119 file differs from the text that was applied to production by
one block — the removed guard, which creates no object. That is a claim, so it
was measured rather than reasoned about. `md5(pg_proc.prosrc)` for both
functions, on production and on the database replayed from the repo:

| function | production | replayed from repo |
|---|---|---|
| `v2_marketplace_feed` | `9ada08dab4492109d6f47c38209db2e0` (6595 ch) | `9ada08dab4492109d6f47c38209db2e0` (6595 ch) |
| `v2_marketplace_search` | `87ed3eb7077648aeb2f0ab2585a9240c` (3930 ch) | `87ed3eb7077648aeb2f0ab2585a9240c` (3930 ch) |

Byte-identical, so no re-apply is needed and the repo genuinely rebuilds what
is running.

### The before/after evidence for "nothing a buyer sees moved"

Captured on production immediately before applying 119 and re-measured with the
identical query immediately after. Each hash is over `product_id | slot |
access` in returned order.

| probe | hash | rows |
|---|---|---|
| feed, signed out, page 0 | `f920f6d2ad2f5e449ae3bfb58765a6d8` | 100 |
| feed, signed out, page 1 | `ccfc2c8ee2d39972aab847d6e13fd5cb` | 1 |
| feed, sort=new | `a6930cfab1cd718f71bb370832e60371` | 100 |
| feed, sort=popular | `e2cca706334b2a10b8bdebcd4cf278c6` | 32 |
| feed, member of all six stores | `2fec898c6aa3337b7ea7ee09a389ce6e` | 100 |
| search "boot" | `d885bf0a83ac94da0f519ab1cc1c3ea5` | 5 |
| search "shirt" | `757978ca0876f861ca40b7b5d024ebce` | 4 |
| search "A-102", signed out | — | **0** |
| search "A-102", Atelier member | — | **0** |

All seven hashes identical after; both leak probes still 0. `A-102` is one of
Atelier's hand-beaded made-to-order gowns and is the named leak case carried
through MK-04 and MOD-01 — it must return nothing to anyone, including a member
of that very wholesaler, and it still does.

The member row is included because `access` is computed from memberships rather
than from publicness. It is not something 119 touches, which is precisely why it
is worth measuring: an unchanged hash on a column the change should not reach is
what distinguishes "the rule moved" from "something else moved too".

---

## `check_tier_gate_removed` — MOD-07, migration 120

**15 assertions. Green on production and on a database replayed from this repo.
Red-proved two ways, and the two proofs do not overlap at all.**

### The two 'denied's

`v2_catalog_by_token` refused for two different reasons, four lines apart, with
the identical string:

```
v_acct.wid is distinct from v_cat.wid   -> 'denied'    THE TENANT BOUNDARY
v_tier < v_cat.access_tier              -> 'denied'    the tier gate
```

The first is which **shop** you belong to. The second was your **rank** inside
it. D2 removed the second. Removing the first instead opens every wholesaler's
private catalogues to every other wholesaler's customers — and the screen still
says "denied" to a stranger, still says "log in" to a signed-out visitor, and
only lets in a buyer who happens to belong to a *different shop*. It would not
look broken from any screen anybody checks.

So every "the gate is gone" assertion is paired with a "and this is still shut"
assertion, in **both directions**: A must not reach B, and B must not reach A.

### Red proof A — the tier gate put back

Both live definitions were fetched with `pg_get_functiondef` and the comparison
re-inserted inline, then the unchanged gate was run.

**FAILED: 1, 6, 8** — the tier-5 catalogue hidden from a tier-1 buyer of that
store, the product behind the old gate unreachable, the tier-5 link answering
`denied`. Every tenant assertion passed.

### Red proof B — the TENANT BOUNDARY deleted instead

`c.wid = v_acct.wid` → `true`, and `or v_acct.wid is distinct from v_cat.wid`
removed. This is the catastrophic edit, and it is the one worth proving.

**FAILED: 3, 4, 7, 9, 10** — every cross-tenant assertion, in both directions,
with assertions 9 and 10 returning **`ok`**: store B's buyer opening store A's
private catalogue by link.

**Assertions 1, 2, 6 and 8 passed under proof B.** A file that only proved the
tier gate was gone would have gone green on a build that had deleted the tenant
check. That is the entire reason the pairs exist.

The two proofs share **no** failing assertion. Each half of the file catches a
different mistake.

### Proof A also shows why the structural assertion is the weak one

Assertion 14 greps both bodies for a tier comparison. Under proof A it **passed**
— the sabotage restored the gate with an inline subquery rather than the
`v_tier` variable the grep looks for. The behavioural assertions caught it
anyway. This is the same lesson as MOD-03: the grep is last on purpose.

### Both proofs rolled back cleanly

`CREATE OR REPLACE` ran via `EXECUTE` **inside** the same `DO` block as the
assertions, ending on a deliberate `RAISE EXCEPTION`, so Postgres rolled the
function definitions back with the fixture. Verified after: `zz_t7*` rows 0, and
both normalised function bodies still hashing to their post-120 values.

### The fixture carries a product production does not have

On production, removing the gate moved **no product at all** — every gated
catalogue's contents were already reachable through another catalogue. So the
fixture brings a product that lives **only** behind the tier-5 catalogue, or
assertion 6 would be measuring today's data rather than the rule.

---

## Seven assertions turned around, and the control that proved which seven

MOD-07 turned five existing gates red. This is the `check_buyer_product_card`
situation from 1 September — a gate encoding a rule that has since changed —
except caught in the same session rather than five days later.

**The failures were isolated with a control, not by reading.** A second replay
database was built from `origin/main` and the whole `.sql` suite run against
both:

| | failing gates |
|---|---|
| with MOD-07 | 20 |
| control (`origin/main`) | 18 |
| **caused by MOD-07** | **2 files, 7 assertions** |

The other 18 fail on **both** and are nothing to do with this change: they
depend on production data and abort with things like *"fixture product 'Boxy
Cotton Tee' (wid sq) is missing"*. **Eighteen of the repo's SQL gates cannot run
against a replayed database at all** — a real blind spot, adjacent to CLEAN-09,
recorded here and not fixed tonight.

Without the control I would have been staring at twenty red gates with no way to
tell which two were mine.

### Turned around rather than deleted

Every affected row was **inverted**, not removed:

```
'a tier 1 buyer is NOT shown a tier 3 catalog'      0
'a tier 1 buyer IS now shown a tier 3 catalog'      1   (MOD-07)
```

The same function is still called with the same arguments, so the coverage
survives and reinstating the gate turns these files red again. Deleting the rows
would have thrown the coverage away with the obsolete expectation. The
superseded quote from Hadi that produced them is kept in each file's preamble
and marked superseded, because it is why the rows exist at all.

Rows about a **different wholesaler**, an inactive catalogue, a dead token and a
deactivated account were green before and after, and were not touched.

### A hazard this found and did not resolve

`check_buyer_pricing` failed on a **price**: a catalogue above the buyer's old
tier now contributes its discount. That is correct under D2, but it names a real
risk — MOD-05 recorded that **23 products sit in two or more catalogues with
conflicting discounts**, and `v2_buyer_store_read` picks a winner by catalogue
order (`is_default desc, name`). Widening the visible set can therefore change
*which* catalogue wins and, in principle, what a buyer pays.

**It did not happen.** Reconstructed on production, the old tier-filtered store
read and the new one were compared line by line for all 13 accounts:

```
lines_old = lines_new for every account;  price_changed_lines = 0 for every account
```

Zero price movement. But the rule now permits it where the data did not, so it
is written down here and raised with Hadi rather than left for an invoice to
discover. It belongs with MOD-06.

---

## MOD-06 — the discount stack, proven on an invoice (6 Sep 2026)

`checks/check_discount_stacking.sql`, 21 assertions, run against a database
rebuilt from this repo at `3c3260b` (122 migrations, shape hash
`ba1c3dcdb9c538e85e32e881a2e64b42`, matching the 6 Sep production baseline).

### Why a second pricing gate existed to be written

The build plan states MOD-06 as *"prove a store at 10% + a customer at 5% still
invoices correctly."* `check_store_pricing_dial` — written the day before —
already proved that `v2_store_discount_pct` **returns 15** for that case.

That is a number coming out of a function. It is not money.

Nothing in the repo asserted what a buyer is actually **charged** once two
discounts are in play. `check_line_pricing` comes closest and proves the *pack*
path with a single `catalog_only` shelf and **no client at all**, so no test
anywhere had ever stacked two rates and looked at the bill. Every assertion in
the new file is a number `v2_submit_order` wrote onto `v2_order_items`, or the
subtotal it wrote onto `v2_orders`.

### The assertion that paid for the file

Two discounts can stack two ways:

```
ADDITIVE      100 × (1 − (10+5)/100)      = 85.00     ← what the server does
COMPOUNDING   100 × (1 − .10) × (1 − .05) = 85.50
```

Fifty cents on a hundred. Not a crash, not a wrong screen — a slightly wrong
bill, which is the only kind of pricing bug that survives for months. Assertion
1 alone would have passed under either rule had the fixture been built the other
way round, so the rule is pinned **from both sides**: 85.00 is required *and*
85.50 is forbidden by name, in its own assertion, with its own failure message.

### Red-proved four ways

Each sabotage was a `create or replace` inside the same transaction as the
assertions, rolled back with them. What matters is not only that the file went
red but **which rows** went red: two of the four are caught by a single
assertion each, which is what says those rows are not redundant.

| Sabotage | Rows that fired |
|---|---|
| `v2_catalog_discount_pct` combines multiplicatively instead of adding | 1, 2, 7, 10, 11, 11b — **6 of 21** |
| the `v2_client_price_overrides` short-circuit is deleted | **9 only** |
| `greatest(…, 0)` removed from the price expression | 8, 8b — and 8b caught a **−5.00 unit price** on an invoice line |
| the quantity-break lookup is skipped | **10 only** |

### What was measured on production, not assumed

- **The stack is additive, live.** Cyprus Riviera Boutique (5%) against Atelier's
  *Occasion Private Edit* (10%) resolves to exactly `15.00` today — the literal
  MOD-06 case, already present in the data.
- **Every store dial on the platform is 0.00%.** MOD-05 seeded each store from
  its default shelf, and every default shelf is 0%. Every non-zero rate that
  exists — 5, 6, 8, 10, −5 — lives on a **secondary** shelf. So the MOD-06 case
  as written ("a store at 10%") does not occur anywhere yet; the 10% is a shelf.
- **19 price overrides across 5 clients**, and every one is already deeper than
  that customer's own percentage would have been. Override-wins therefore costs
  no buyer money today. It is still worth knowing that a wholesaler typing "the
  special price for this customer" gets exactly that and not that-less-15%.

### ⚠ Two doors, two prices — open, and it is money

Since MOD-04 a buyer **sees** the whole store but is **priced** through one
shelf: `js/views/buyer.js` resolves `activeCatalogId` to `visibleCatalogs[0]`,
which is the default shelf, and hands that to `v2_submit_order`. A share link,
meanwhile, is priced by `v2_token_discount_pct` through the shelf the link
names.

Measured on production after MOD-07: **326 (account, variant) pairs** where the
two doors disagree.

```
Aïsha Couture (demo-atelier, customer 15%)   A-101 Silk Slip Dress, list 128.00
  through the store screen  →  108.80        (0% shelf + 15% customer)
  through the Occasion link →   96.00        (10% shelf + 15% customer)
```

Same buyer, same shirt, same afternoon, 12.80 a unit apart. Nothing on either
screen is wrong — the screen and the invoice agree with each other, which is
precisely why nobody would report it. What disagrees is the two doors.

Assertions 15 and 15b record this **as it stands**, not as it should be, and say
in the file that whoever closes it must *invert* those rows rather than delete
them. Closing it moves prices on real orders, so it is Hadi's decision. This is
the same hazard MOD-07 raised from the other end — the 23 products in two or
more shelves with conflicting rates — and it now has a number and a name.

### ⚠ The store dial is bounded by nothing

`v2_catalogs.discount_pct` carries `v2_catalogs_discount_range` (−100…100), and
assertion 16 proves a shelf refuses 500%. Migration 117 added `discount_pct` to
`v2_wholesalers` with a check constraint on `discount_mode` **and none on the
percentage**. Assertion 17 sets a store to 500% and it is accepted.

It costs nothing today because nothing reads it. The moment MOD-05's switch-over
happens it is the number that prices every order in the store, and there is
nothing between a fat-fingered keypress and the invoice. A one-line migration
closes it; assertion 17 is written to be inverted when it does.

### A note on why this gate is replay-safe

Every assertion is scoped to the fixture's own `wid`. Nothing counts rows in the
corpus it happens to find, and nothing asserts a property of production data.
That is the rule migration 116 was corrected for and 119 broke again the
following day, applied here on the way in rather than after `replay_migrations.sh`
stopped.

---

## MOD-08 — the public checkbox stops lying, and the switch it lost gets a control (6 Sep 2026)

`checks/check_marketplace_switch_reachable.mjs`, 10 assertions, red-proved five
ways. Every sabotage was caught by **exactly one** assertion, which is what says
no row in the file is redundant.

### The lie had two halves, and only the first was written down

The build plan names the first: `v2_catalogs.is_public` was the only thing that
put a product on the OGGI marketplace, and its checkbox said *"Open to anyone
with the link. No login."* It never mentioned the marketplace. Wrong before any
of this refactor started.

MOD-01 put the flag on the product; MOD-03 pointed the feed and the search at
it. That ended the first half — and created a second, quieter one on the way
past: the marketplace now read a column **no screen could write**. No RPC, no
data-module writer, nothing. A wholesaler could not publish a new product and
could not take an old one down. The marketplace was frozen at whatever migration
116's backfill happened to produce, and no screen said so.

Nothing was red, because everything that existed worked.

### Which is `createRatio()` again

`createRatio()` is the only function in the codebase that creates a size ratio.
It has had no caller since 24 August, so every wholesaler onboarded since has an
empty ratio list forever; nine of that module's twelve exports are unreachable.
It has never been caught by anything.

So this gate does not assert that the new toggle is *correct*. It asserts that
it can be **reached**, as a chain:

```
a data module writes v2_products.is_public
  → the writer is exported
    → a view imports it
      → the view CALLS it            ← the assertion createRatio() never had
        → and the state is on screen  ← a toggle whose position you cannot see
```

Deleting the call site while leaving the import in place fires assertion 4 and
nothing else. That is the exact shape of the bug, reproduced.

### Red-proved five ways

| Sabotage | Row that fired |
|---|---|
| the call site is deleted, the import left in place | **4 only** — the `createRatio()` case |
| `setCatalogPublic` writes `v2_products` again | **8 only** — the two switches merged back into one |
| the "On the marketplace" badge is removed | **6 only** |
| the old marketplace rule creeps back into a comment | **9 only** |
| the writer is renamed out of the export list | **2 only** |

### The correction is on the screen, not only in the code

A control that silently *narrows* is its own kind of lie. Every wholesaler who
used that checkbox before today learned it published to the marketplace, and
nothing would have told them it had stopped. The label now says so in words, and
names where the switch that does now lives. Assertion 8 holds that sentence
there.

### Assertion 9 fired on the comment that was written to satisfy it

`js/data/marketplace-feed.js` is the only place in `js/` that says where the
marketplace's scope comes from, and it named the catalogue's flag — correct
until migration 119, wrong the moment it landed. Assertion 9 forbids that
sentence returning. It went red on the corrected comment's **first** run,
because the correction quoted the old wording in order to explain it. The
comment was reworded to describe the old rule rather than quote it. Worth
recording: the assertion caught the one file most likely to reintroduce the
sentence, on the first attempt, from the person who wrote the assertion.

### ⚠ And the eighth inverted assertion, found a day late

MOD-07's evidence in this file records a control replay that isolated *exactly
seven* failing assertions across five gates. That was wrong.

**The control ran only the SQL gates.** There were eight. The eighth is in
`check_catalog_builder.mjs`, which asserted `cat-tier … cat-discount … cat-mode`
were all present in that order — and MOD-07 took the tier control off that
screen. The gate was red on `main` for about an hour and nobody looked, which is
row 451's failure again: `check_os_namespace.mjs` sat red on `main` for five
days for the same reason.

The row is inverted rather than deleted, like the other seven: it now asserts
the two remaining settings in order **and** that the tier control is gone, so
putting it back turns the file red again.

The lesson is not "remember the .mjs gates." It is that **a control run must
cover every gate the repo has, or it measures its own blind spot instead of the
change.** The run that found this one was every `.mjs` gate, against a control
tree built from `main`, and it is the run that should have happened the first
time.

---

## CNT-00 — the count check, on the screen and in the database (6 Sep 2026)

Two gates, because it is two rules:

- `checks/check_receive_count.mjs` — 42 assertions, driving the real component
  in a real DOM. Red-proved **9 ways**.
- `checks/check_receive_count.sql` — 19 assertions against migration 121,
  every one the database refusing or the database having written exactly what
  it said. Red-proved **6 ways**.

### What was found in the code, not assumed

`js/components/receive-dialog.js` is 192 lines and takes **one variant and one
number**. Receiving 250 pieces of a style in 4 colours and 4 sizes means opening
it sixteen times and typing sixteen numbers — and nothing in the system adds
them up, and nothing compares the total to the vendor's invoice.

There is no screen on which a wholesaler can see what he has entered against
what he was billed. The error is not merely possible; **there is no mechanism by
which it could be caught.**

### Derive, do not reconcile

The reference ERP lets two numbers exist and offers a **Sync** button to argue
between them: `Invoice Qty 2.999` beside `Selected Qty 3`, and nothing blocks
Done. That is the wrong shape. Any two numbers a person can type separately will
eventually disagree. So the quantity is never typed twice: the billed figure is
typed once, the grid holds pieces, and the total is the sum of the grid.

### Why the rule is in the database as well

CNT-03 says *blocked, not warned*. A disabled button is a UI state; it is not a
rule. It survives exactly as long as this one screen is the only way in — and
this codebase already has a CSV import path and a barcode path that write stock
without going near it.

`v2_receive_product` therefore adds the breakdown up itself and refuses if it
does not equal the billed figure. It also does the whole delivery in **one
transaction**: `js/data/size-ratios.js` already states this rule for
`v2_apply_ratio` — *"not a loop in this file… that would be several round-trips
that can half-fail"* — and stock is worse than packs, because every other number
is derived from it.

**Assertion 3b is the one that matters.** Not "it raised an exception" — that is
easy and proves little. 3b is that after a refused receipt the warehouse holds
*exactly* what it held before: no nine boxes of a sixteen-box delivery, which is
worse than a refusal because nothing anywhere records that it happened.

### Red proofs — the database

| Sabotage | Rows that fired |
|---|---|
| the count check is deleted | 3, 3b, 4, 5 — and 13, 14, because stock that gets in also breaks the ledger |
| the tenant boundary is deleted | 7 |
| the variant-ownership check is deleted | 6 |
| the duplicate-line check is deleted | 9 |
| granted to `anon` | 15 |
| an `p_override` argument is added | 17 |

### Red proofs — the screen

Nine sabotages. Eight went red. **One did not, and that is the finding.**

| Sabotage | Rows that fired |
|---|---|
| the button never disables | "Save is BLOCKED at 270" |
| a generic "Save" label | the CNT-04 row |
| a missing variant treated as an empty box | 1, 2, and the fixture total |
| sizes in entry order | 3 |
| `type="number"` with spinners | 4 |
| spread evenly drops the remainder | 8 |
| undo keeps a stack | the one-level row |
| the carton multiplier is ignored | the pieces row |
| **the curve fills by POSITION, not by NAME** | **nothing — see below** |

### ⭐ The sabotage that went undetected

Every curve assertion applied a curve whose sizes were the screen's own, where
matching by name and matching by position agree. A saved curve for **M-L**
applied to a product with **S-M-L-XL** would have put the 4 on S and the 6 on M:
the total right, the boxes wrong, and nothing on screen to notice.

The fix was not to add an assertion around the existing code. The by-name path
was only *defensive* — nothing ever called `applyCurve` with a size list
different from the screen's — so it was made **reachable and useful**: a "Fill
now" button beside each saved curve, which is the spec's *"next delivery of that
style is one tap"*, and which is the only caller that hands the fill a different
size list. The same sabotage now fires two assertions and prints the 4 landing
on S and the 6 on M.

**A sabotage that does not go red is a finding about the gate, not a clean bill
of health.**

### ⚠ v2_receive_stock is granted to anon and checks nothing

`v2_receive_stock` is `SECURITY DEFINER`, granted to `anon`, and takes a variant
id and a location id from the caller with no tenant check at all. Anyone holding
the anon key that ships in the bundle can inflate any wholesaler's inventory.

**It is not fixed here.** Revoking a grant that the live CSV-import and barcode
paths may depend on is not a change to make unattended, and the fix needs
somebody to establish which callers run signed in. Migration 121 refuses to
repeat it: `v2_receive_product` is `authenticated` only, and every variant must
belong to the warehouse's own store. Assertion 15 holds the new door shut.
Raised for Hadi.

### ⚠ CNT-02 and CNT-10 are not built, and are marked ⚠️ rather than left to look done

CNT-02 stores `billed_qty` on the line; CNT-10 lets a short delivery through
with a typed reason written to the audit log. Both need a receipt header row
that does not exist — receiving writes one movement per variant with nothing to
hang an invoice figure on — and CNT-10 is a decision only Hadi can make. There
is deliberately **no override argument** on `v2_receive_product`: a parameter
added "for later" is one somebody uses today, and then the count check is
advisory.

### Two smaller things, both worth writing down

**A separator nobody can see was load-bearing.** The grid keys cells
`colour + separator + size`. A space is wrong — a colour "Navy Blue" with size
"S" collides with a colour "Navy" and a size "Blue S", and the two silently
share one box. U+0000 is right and cannot be typed into a collision, but it had
been written as a **literal NUL byte**, which made `grep` report "binary file
matches" and would have made the file unreadable to git and to review. It is now
an escape, exported as `cellKey()` so the gate builds keys the way the module
does. It was found because the four paste assertions failed while the other
thirty-eight passed.

**Production drifted from the repo by a comment, and that was fixed too.**
Migration 121 was first applied to production from a copy with the comments
stripped. The SQL was identical and `md5(prosrc)` was not, which makes the
repo-rebuilds-production proof quietly false — and the comments are the part a
future reader needs most. Re-applied as `121a`; production and a database
replayed from this repo now both hash to `5a226bab8b1177b201709d6e7c84e054`.

---

## 122 / 123 / 124 — the door stops deciding the price, the dial gets limits, and a signed-out stranger stops writing stock (7 Sep 2026)

Three fixes Hadi authorised in one reply, built and proven together because
they touch the same two functions. His words on each, verbatim:

- the two prices — *"why is that happening? It shouldn't. No. The marketplace
  doesn't add some kind of price or, like, percentage or anything like that.
  They should get the same price. The share link just automatically grants them
  access to the wholesaler that gave them that link."*
- the security hole — *"I did not understand that, so I don't know what to do,
  how to fix it. Do as you see it."*
- the dial's limit — *"I guess... yes. I don't know what the dial is and
  what... what's the right limit for it."*

### The control run is a database built from `origin/main`

Every claim below is measured twice: once against `oggi_r2` (this branch's
migrations) and once against `oggi_ctl`, a **fresh replay of `main`** on the
same Postgres. That removes the usual weakness of a red-proof — a sabotage I
invented, which can be a sabotage the gate happens to be shaped to catch. Here
the "sabotage" is the product as it shipped yesterday.

| gate | on the fixed database | on `origin/main` |
|---|---|---|
| `check_one_price_per_buyer.sql` (new, 21 assertions) | 0 fail | **14 fail** |
| `check_anon_cannot_write_stock.sql` (new, 10 assertions) | 0 fail | **7 fail** |
| `check_discount_stacking.sql` (28, was 21) | 0 fail | **10 fail** |
| `check_buyer_pricing.sql` (17, was 16) | 0 fail | **6 fail** |
| `check_catalog_pricing.sql` (15, was 10) | 0 fail | **9 fail** |

### `check_one_price_per_buyer.sql` — red-proved five ways

The fixture's numbers are all different on purpose — store dial 7.00, customer
11.00, shelves at 10.00 / −5.00 / 20.00 — so **every wrong answer any earlier
version of this code could give is a different number from every right one.**
A fixture where the rates are all zero would make "the shelf contributed
nothing" and "nothing contributed anything" the same green.

```
baseline FAIL rows: 0
=== SABOTAGE: the store screen goes back to reading the SHELF        FAIL rows: 7  → restored 0
=== SABOTAGE: the share link goes back to carrying its own rate      FAIL rows: 3  → restored 0
=== SABOTAGE: the invoice goes back to reading the shelf named       FAIL rows: 5  → restored 0
=== SABOTAGE: the store dial is dropped, only the customer survives  FAIL rows: 6  → restored 0
=== SABOTAGE: the token function stops checking access               FAIL rows: 2  → restored 0
```

The fourth matters most. Without assertion 6 — *"the STORE dial is in the
number, not just the customer's rate"* — a function that returned the
customer's own rate alone would satisfy every other row in the file.

### `check_anon_cannot_write_stock.sql` — and a sabotage that did NOT go red

```
=== SABOTAGE: the anon grant comes back on v2_receive_stock            FAIL rows: 4  → restored 0
=== SABOTAGE: the anon grant comes back on assemble_kit ONLY           FAIL rows: 3  → restored 0
=== SABOTAGE: a 'tidy up the grants' pass closes the signed-out cart   FAIL rows: 0  ← ⚠
=== SABOTAGE: somebody grants to PUBLIC instead of to a role           FAIL rows: 5  → restored 0
=== SABOTAGE: the revoke takes the warehouse screens with it           FAIL rows: 1  → restored 0
```

**The third one is recorded because it failed to fail.** `revoke execute ...
from anon` left the privilege intact, because `v2_reserve_stock` was granted to
**PUBLIC**, and `anon` inherits from PUBLIC. So the gate was telling the truth
and my sabotage was a no-op — a fault in the test of the test. Redone properly:

```
=== SABOTAGE 3 (redone): revoke from anon, public                     FAIL rows: 2
  the signed-out buyer can still RESERVE stock|allowed|REFUSED — the signed-out cart is broken|FAIL
  the signed-out cart keeps all three reservation calls|3|2|FAIL
                                                                       → restored 0
```

That accident is also *why* migration 124 revokes from `public` as well as from
`anon`: a grant to PUBLIC is a grant to every role that will ever exist, and it
is how the `anon` grant got there in the first place.

### A migration that applied cleanly, asserted itself, and was still wrong

122's first draft read `r.wholesaler_wid` from `v2_catalog_by_token`. The column
is `wid`; `wholesaler_name` is the store's name. PL/pgSQL does not resolve a
column reference until the statement runs, so:

- the migration applied with no error,
- **its own closing DO block passed**, because that block prices through the
  two shelf functions and never through the token,
- and the first real share link priced would have raised
  `column r.wholesaler_wid does not exist`.

`check_one_price_per_buyer.sql` assertion 7 caught it on the gate's first run.
The lesson is written into the migration next to the fix: **a migration's own
DO block tests the paths its author remembered.** That is why the closing
assertion is not the gate.

### Blast radius, measured on production before and after

Before:

```
 dial vs default shelf, all 13 stores : identical rate AND identical mode
 orders in the product's history      : 131
   carrying a shelf id at all         :   1  (the default shelf)
   ever priced through a discounted shelf : 0
```

So the store screen's price is provably unchanged for every store on the
platform — the dial and the default shelf hold the same number and the same
mode in all 13 — and the only path that moved is the share link, which now
agrees with the store screen. After applying:

```
 (client, variant) pairs priced through two different shelves : 11,238
 pairs that still disagree                                    :      0
```

### Shape and byte-identity

The three pricing function bodies hash identically in production and in the
repo replay:

```
v2_buyer_discount_pct    1e21931e497d99a6f4fe3179045c5b9d
v2_effective_unit_price  a4c7706978be1b5a3eff527e680cb23d
v2_token_discount_pct    ead437a9eeed14b583f7577164adbe58
```

The replay baseline in `checks/replay_migrations.sh` moved from
`62/4/166/96 · ba1c3dcd…` to `62/4/167/96 · 2ebab640…`, and **in that order**:
the replay produced the new hash, the baseline was *not* touched on that
evidence, production was then measured with the identical query and produced
exactly the same five values, and only then was the number changed. 121 is what
moved it (one new function). 122, 123 and 124 moved it by nothing at all —
122 keeps every signature, 123 adds check constraints, 124 changes grants, and
this hash sees none of those. **That is a real limit of that check, not a clean
bill of health**, and the three gates above are what actually watch them.

### Rows turned around rather than deleted

Five gates carried assertions that recorded the OLD behaviour as today's truth,
each with a comment saying to invert it when the decision was made. All five
were inverted in this commit, none deleted:

- `check_discount_stacking.sql` 15/15b — the two doors. Now submits the same
  order through both and requires one answer; 15c compares the default shelf
  against the deepest one; 95.00, the old store-screen answer, is forbidden by
  name.
- `check_discount_stacking.sql` 17 — the unbounded dial, plus new 17b (the
  markup direction) and 17c (the customer rate, which had never been checked at
  all). 17d is **new today's-truth**: the SUM is still unbounded, on purpose,
  and says where the reasoning is written down.
- `check_discount_stacking.sql` 14 — the MOD-05 bridge. It used to require the
  dial and the default shelf to agree, because the crossing had not happened.
  It now moves the dial to 25%, a number no shelf in the fixture carries, and
  requires the invoice to follow it.
- `check_buyer_pricing.sql` 4 and 5 — the shelf's hidden −5.00 markup and the
  tier-5 shelf's 20.00. Row 5 has now been turned around **twice** (MOD-07,
  then 122) and is still not deleted, which is the point of the practice: two
  different regressions turn it red and neither can be mistaken for the other.
  New row 9b requires that a shelf's rate is no longer the server's rule.
- `check_catalog_pricing.sql` — every expected number is unchanged, because the
  arithmetic did not move, only the source of the rate. The shelves are kept as
  **decoys**: each case is still priced *through* a shelf carrying its own rate
  and mode, and rows 4–6 name the wrong answers (70.00, 95.00, 85.00) that a
  shelf which had started pricing again would produce.

### The cart followed without a line of JavaScript changing

`js/data/pricing.js` asks the server for the discount percentage rather than
working it out, so 122 corrected the browser and the invoice in one statement.
A browser that computed the rate itself would have shown the old price in the
cart and been invoiced the new one. Its comment claiming both functions
"DELEGATE to `v2_catalog_discount_pct`" was true until 122 and is now corrected
— four comment lines removed, `ALLOW_DELETIONS=1`, no behaviour touched.
`check_price_agreement.mjs` gained a sixth mirror entry so that deleting the
decoy rows from the SQL gate fails there too.

---

## ⚠ A CORRECTION to the section above, and the leak the correction uncovered (7 Sep 2026, later)

### The number I reported was never measured

The section above ends with:

> Full sweep on a clean replay of all 126 migrations: **47/47 SQL gates green,
> 69/69 mjs green, 6/7 sh green**

**The 47/47 is wrong. It was measured against a database that had already been
dropped**, and it is in the merged description of PR #62.

`checks/replay_migrations.sh` drops its scratch database at the end unless
`KEEP_DB=1` — the flag exists precisely because this was got wrong once before,
by hand, in August, and the script's own comment says so. The sweep was written
inline that evening, in the same shell call, *after* the replay had finished and
therefore after the drop. Every subsequent `psql` printed

```
psql: error: connection to server ... FATAL: database "oggi_final" does not exist
```

and the detector was grepping for `ERROR:` and `|FAIL`. **"FATAL" is neither.**
So all 47 files produced no matching line and all 47 counted as green.

The mjs (69/69) and sh (6/7) numbers were real — those gates do not touch the
database.

### What the true state was

Re-measured properly, against a database that exists, with a runner that has
been shown a red run before it is allowed to report a green one:

```
== SQL gates on a replay of main
   36 proved, 6 red, 5 could not run for want of seed data, of 47
```

Two of those findings are worth more than the correction:

- **Nine of the 47 SQL gates cannot run on a clean replay at all.** They were
  written against production data — they want wholesaler `sq`, or a product
  called "Boxy Cotton Tee", or simply "an active wholesaler to hang a fixture
  on". `checks/seed.sql` does not supply it (that seed is the WS-001 fixture for
  the MOQ gate and nothing else). They say so honestly and refuse. So the
  replay has never been a complete test bed, and any past claim of the form
  "the whole suite is green on a replay" could not have been true.
- **`check_tenant_isolation.sql` was failing, with 44 problems, and had been for
  some time.** It reports through `raise exception 'check_tenant_isolation
  FAILED with 44 problem(s)'` — a shape the ad-hoc detector also did not match.
  Nobody had run it because **there has never been a runner for the SQL gates**:
  `checks/package.json` has had `npm test` for the .mjs gates since Batch 7, and
  the 47 SQL files have only ever been run one at a time, by whoever remembered.

### `checks/run_sql_gates.sh` — the runner, and why it self-tests

It classifies on the failure signatures the gates themselves emit, catalogued by
running all 47 and reading the output rather than guessing. Three rules matter:

1. "Could not connect" and "database does not exist" are **RED**, loudly. That
   is the sentence this whole section exists for.
2. A gate that honestly reports a missing fixture is counted in its own
   category and **never as green** — nothing was proven, so it cannot be green;
   nothing is broken, so calling it red would train people to skim the red list.
3. **A gate it cannot classify is RED.** If a new gate speaks a dialect the
   runner does not know, the suite goes red and somebody teaches it the dialect.

And it refuses to report anything at all until `--self-test` has shown it all
four outcomes on the spot — a passing gate, a fabricated failing gate, an
unrecognised gate, and a database that is not there:

```
== self-test: the runner must see a red before it may report a green
  ok  a passing gate reads GREEN
  ok  a failing gate reads RED:assertions-failed
  ok  a missing database reads RED:cannot-run
  ok  an unrecognised gate reads RED:unclassified
== self-test passed -- the runner can see all four outcomes
```

The third line is the 7 Sep false green, and it now fails the runner rather than
passing the suite. A detector that has never been shown a red is itself a check
that has never failed, which is the sentence at the top of this file.

The first draft of the runner then had to be corrected in the other direction:
it matched a bare "does not exist" anywhere in the output, and
`check_approval_grants_access.sql` asserts *"...no membership was invented for a
person who does not exist"* — so a **passing** gate read as unreachable. Both
directions cost the same thing.

---

## 125 — a partition is a door, and 41 of them were unlocked

Found by the runner above, on its first honest run. This is the finding, not the
correction.

### What was open

`v2_inventory_movements` is the stock ledger for every wholesaler on the
platform. It is partitioned by month. Its tenant policy is correct and it is on
the **parent**. Postgres evaluates a parent's policies for queries on the parent,
and a partition's own policies when a partition is named directly — and
`create table ... partition of` does **not** inherit row security, because
`relrowsecurity` is per-relation and a new partition starts OFF.

Migration 074 creates partitions with a bare `create table`. `authenticated`
holds SELECT on all of them. So:

```
select * from wholesale_v2.v2_inventory_movements          -- your rows
select * from wholesale_v2.v2_inventory_movements_2026_09  -- EVERYONE'S
```

**41 of 41 partitions were open**, over a ledger of 3,081 rows. The second query
is one HTTP request with the same logged-in token any wholesaler already holds.

### Measured, not reasoned about

On a replay, as a real wholesaler — a `v2_user_profiles` row and a
`request.jwt.claims`, role `wholesaler` and deliberately never `owner`, because
an owner passes every tenant check and would make the file green for the wrong
reason:

|  | through the PARENT (theirs) | naming a PARTITION (everyone's) |
|---|---|---|
| before 125 | **1** | **2** |
| after 125 | **1** | **0** |

The left column is why this was safe to apply: switching row security on for a
partition does not disturb reads through the parent. The partitions get RLS and
**no policy**, which is the right shape — every legitimate read goes through the
parent, so a direct read of a partition should return nothing at all, not
something filtered. Nothing in `js/` names a partition; that was checked, not
assumed.

### `check_partition_isolation.sql` — 7 assertions, every one seen to fail

The strongest red proof available was not a sabotage I invented — it was the
product as it shipped. Run against a replay of `origin/main`:

```
 a wholesaler still reads their OWN ledger through the parent | 1         | 1    | PASS
 naming the live partition directly returns nothing (was 2)   | 0         | 2    | FAIL
 the default partition is closed too                          | 0         | 0    | PASS
 EVERY partition of the ledger has row security on            | none open | ...42 names... | FAIL
 the partition creator switches row security on               | yes       | NO — OCTOBER REOPENS IT | FAIL
 the parent still carries the tenant policy                   | 1         | 1    | PASS
 v2_live_holds is still an aggregate and still definer-rights | aggregate only | aggregate only | PASS
```

Rows 1, 6 and 7 stay green there — the file is not simply failing everything —
so they were red-proved separately:

```
=== SABOTAGE: the parent's tenant policy is dropped              FAIL rows: 2 (rows 1 and 6) → restored 0
=== SABOTAGE: v2_live_holds starts revealing WHO is holding      FAIL rows: 1 (row 7)        → restored 0
=== SABOTAGE: one month's partition is reopened                  FAIL rows: 3 (rows 2 and 4) → restored 0
```

**Assertion 1 is the one that stops a bad fix.** Without it, "revoke everything
from `authenticated`" would turn every leak row green and take the movement
history, the valuation report and the dead-stock report blank with it.

**Row 6 caught a mistake while it was being written.** A restore step in the
sabotage script created a *second* policy on the parent instead of restoring the
first; the row asserts `count = 1`, not `>= 1`, and went red immediately. A gate
that only checked "a policy exists" would have said nothing.

**Row 3 is weaker than it looks and is left in anyway.** The default partition
reads 0 on an unfixed database too — because nothing lands in it, not because it
is closed. Row 4 is what actually binds it, by naming every open partition
rather than the three somebody remembered.

**Row 7 is today's truth, not an endorsement.** `v2_live_holds` is a
definer-rights view readable by `anon`. Migration 064 chose that deliberately
and wrote down why: an invoker view reports zero holds to a buyer, who then
oversells stock someone else is already holding. It exposes an aggregate
quantity and nothing about *who*. The row asserts that it stays that way.

### ⚠ THE GRANT DRIFT — found here, NOT fixed, and it is the reason 125 uses RLS

While reproducing the leak, the fixture would not run on a replay: `authenticated`
lacked SELECT on `v2_products` and `v2_product_variants`, which the parent's own
policy reads. On **production** it holds them. Measuring the gap:

> On production, `authenticated` holds SELECT/INSERT/UPDATE/DELETE on **nearly
> every table in `wholesale_v2`** — v2_clients, v2_orders, v2_portal_accounts,
> v2_people, v2_person_channels, v2_signup_requests, v2_audit_log,
> v2_login_throttle, and about fifty more. **A replay of all 126 migrations in
> this repo produces almost none of it.**

Something granted that on production out of band. It is not in any file here.

RLS is still doing its job on the tables that have it — a blanket grant plus a
scoped policy is survivable, and the deliberately fail-locked tables
(`v2_person_credentials`, `v2_buyer_sessions`, `v2_access_reapply_policy`) were
checked and are still locked. But it is exactly how 41 partitions with **no**
policy became readable, and it is why 125 switches row security on rather than
revoking a grant: **a fix that depends on a grant staying revoked is a fix the
next blanket grant undoes silently.**

The wider consequence is worth stating plainly, because `replay_migrations.sh`'s
banner claims the opposite:

> **This repo can rebuild the product's tables, views and functions — the shape
> hash proves it on every run. It cannot rebuild its privileges, and nothing
> checks them.**

That is unfixed and is a decision for Hadi: either bring the grants into a
migration and make the replay reproduce them, or add a privilege check that
compares production against the repo the way the shape hash compares structure.
Recorded here rather than guessed at.

---

## LINK-00 — a person on every way in (migration 126)

**The claim.** Both doors that create a buyer now create a marketplace identity:
a person, a phone channel, a credential and a membership. Before 126 both
inserted a `v2_portal_accounts` row with `person_id NULL` and stopped there.

**Gate:** `checks/check_person_on_every_way_in.sql` — 16 assertions.
**Matched pair:** `checks/check_approval_grants_access.sql` 8c (inverted) and 8d (new).

### The control replay — the strongest evidence here, and none of it is invented

A database was built from a replay of **`origin/main`** (127 migrations,
62/4/167/96, shape `2ebab640…` — the pre-126 production baseline exactly), and
the NEW gates were run against it unchanged. This is worth more than any
sabotage I could write, because the "before" state is the product as it actually
shipped rather than a state I damaged on purpose.

```
check_person_on_every_way_in.sql vs origin/main .......... 11 of 16 RED
  and the account it created belongs to a PERSON       yes  → STILL A DEAD END
  a membership exists, so the store appears in the switcher 1 → 0
  they can sign in to OGGI with that phone and password true → false
  and their new store is in the list that session can open 1 → -1
  and THAT account belongs to a person too             yes  → STILL A DEAD END
  the one-time password works on the marketplace       true → false
  the same number written differently reaches the SAME person → A SECOND PERSON WAS CREATED
  one human, two stores, two memberships                 2  → 0
  a link can never overwrite an existing marketplace password → (function absent)
  an applicant with no phone still gets a person and a membership 1 → 0
  and the wholesaler is TOLD they cannot sign in yet    told → SILENTLY HALF DONE

check_approval_grants_access.sql vs origin/main ........... 2 RED
  8c  memberships=0 person=NULL   (it required 0 before 126, and 1 after)
  8d  the new person has 0 phone channel(s), expected exactly 1
```

Against the 126 database both gates are fully green: **16/16** and **17/17**.

### The five rows the control CANNOT prove, and the sabotages that do

A control replay proves the rows that describe new behaviour. It cannot prove
the rows that describe things that must **never** happen, because on `main`
those things are absent rather than forbidden — row 12 reads "none" on `main`
only because the function it is asking about does not exist yet. Passing
vacuously is not passing. Each was made to go red on purpose:

```
=== SABOTAGE: v2_ensure_person stops reading the CHANNEL and reuses any
              person it finds -- "merge the platform into one human"
    rows 4, 5, 8 FAIL, and row 10 reads TWO PEOPLE WERE MERGED

=== SABOTAGE: the find-or-create becomes a plain INSERT and
              v2_person_channels_uq is dropped with it
    rows 8, 9 FAIL, and row 11 reads 2 phone numbers claimed by two people

=== SABOTAGE: grant execute on v2_ensure_person to anon
    row 12 FAIL -- got `v2_ensure_person`, expected `none`

=== SABOTAGE: v2_ensure_person_credential grows `on conflict do update`
    row 13 FAIL -- IT CAN OVERWRITE ONE
```

**Two of those four had to be rewritten before they were true, and both
corrections are worth keeping.**

The first attempt at the merge sabotage returned "the first person in the
table" unconditionally. On the gate's own fixture the table is empty at the
first call, so it returned NULL and the gate **crashed** on
`v2_person_memberships.person_id`'s not-null constraint instead of reporting a
failed row. That is still a red — `run_sql_gates.sh` classifies a gate it
cannot read as RED, which is rule 3 and the reason that rule exists — but it
proves the constraint, not the assertion. Rewritten to reuse a person when one
exists and create one otherwise, it reaches row 10 and fails there, which is
what was claimed.

The second attempt dropped `v2_person_channels_uq` and nothing went red, and
for a while that looked like a hole in the gate. It is not: `v2_ensure_person`
LOOKS UP the channel before inserting, so removing the index alone cannot
produce a duplicate — the index is the second line of defence, not the first.
The sabotage that matters is the one a real person would commit: "simplify"
the find-or-create into a plain insert. With the index still there that raises;
with the index dropped as well it silently mints a second person for a number
the platform already knows, and rows 8, 9 and 11 all turn red. **The
one-sabotage version would have been recorded as a gate weakness that was not
there.**

**Assertion 4 is the headline and it is deliberately not a row count.** It takes
the phone the wholesaler typed into the invitation and the password the buyer
chose at redemption, calls the app's own `v2_marketplace_login`, and requires a
session back. `person_id is not null` would pass on a person with no channel, no
credential or no membership — three half-states 126 can produce, each of which
is a buyer who still cannot log in.

**Assertion 8c was inverted rather than deleted.** It required `0` memberships
for the anonymous applicant, which was right while that branch minted a null
person. It now requires exactly one, naming a real person. That is stronger than
the original in both directions: `0` also passes on a database where the whole
anonymous branch has been removed.

### Production and the replay were compared before the baseline moved

```
replay of all 128 migrations, empty Postgres .. 62/4/169/96  5108b500f802f20bad5560488f00e36d
PRODUCTION, measured with the same query ...... 62/4/169/96  5108b500f802f20bad5560488f00e36d
```

The shape hash cannot see the half of 126 that matters — `v2_redeem_buyer_invite`
and `v2_approve_signup_request` keep their signatures exactly — so the four
function bodies were compared directly, which is the lesson migration 121 left:

```
v2_ensure_person(text,text,text) .............. 849d86c21a3e9ca9669407459a15fcf9
v2_ensure_person_credential(uuid,text) ........ 7c7bb26a6e676d7ac452f4996da98994
v2_redeem_buyer_invite(text,text,text,text) ... 51f8478ce38d7e6914e3928b0dbca5b8
v2_approve_signup_request(uuid,text) .......... 10c2f1ef427a3b51434765106ebb9202
```

Identical on both sides.

### The whole SQL suite, on the 126 replay, through the runner

```
== self-test passed -- the runner can see all four outcomes
== SQL gates on oggi_link
   40 proved, 0 red, 9 could not run for want of seed data, of 49
```

The nine are row 493's: written against production data a clean replay does not
have. Nothing was proven by them and nothing is broken.

---

## LINK-01 — a link is a row (migration 127)

**The claim.** `v2_share_links` holds all four link kinds, and every combination
the model forbids is impossible to *store* — not merely hard to create through
a form. Nothing in 127 decides who gets into a store; redemption is 128.

**Gate:** `checks/check_a_link_is_a_row.sql` — 21 assertions.

### Every constraint red-proved by dropping it

Not by inventing a wrong value and watching it bounce — by removing the rule and
watching the gate notice. Each ran against a `template oggi_link` copy so the
sabotages could not contaminate one another:

```
=== drop v2_share_links_cap_matches_kind ............ 2 red (rows 6, 7)
=== drop v2_share_links_one_time_needs_a_person ..... 1 red (row 8)
=== drop v2_share_links_discount_only_on_one_time ... 1 red (row 9)
=== drop v2_share_links_discount_range .............. 1 red (row 10)
=== drop v2_share_links_uses_within_cap ............. 1 red (row 11)
=== drop v2_share_links_token_shape ................. 1 red (row 12)
=== drop v2_share_links_expiry_window ............... 1 red (row 13)
=== drop v2_share_links_revocation_has_an_actor ..... 1 red (row 14)
=== drop v2_share_links_catalog_same_store .......... 2 red (rows 15, 21)
=== drop index v2_share_links_token_uq .............. 1 red (row 17)
=== disable row level security ...................... 1 red (row 19: RLS IS OFF)
=== add an open read policy (RLS on, but using(true)) 1 red (row 19: rls on, 1 policies)
=== grant select to anon ............................ 1 red (row 20: anon:SELECT)
=== grant select to PUBLIC .......................... 1 red (row 20: PUBLIC:SELECT)
=== drop trigger trg_v2_share_links_touch ........... 1 red (row 18)
=== alter column invitee_phone_key drop expression .. 2 red (rows 4, 5)
=== alter column token drop default ................. RED as a CRASH, see below
```

**The PUBLIC sabotage is there on purpose.** Granting to `anon` and granting to
PUBLIC are two different failures and only one of them is the one this codebase
has actually made: migration 124's first sabotage did not go red because `anon`
held the privilege *through* PUBLIC rather than directly. A gate that only
checks the named roles would have said nothing.

**Row 16 is what stops a bad fix.** Assertion 15 requires a link naming another
store's shelf to be refused; assertion 16 requires the store's *own* shelf to
still be storable. Without 16, "make `catalog_id` reject every catalogue" turns
15 green and breaks the feature.

### The one sabotage that goes red as a crash rather than a row

Dropping the token DEFAULT does not produce a failed assertion — the first
insert dies on the NOT NULL constraint and the transaction aborts, so no report
is printed at all. `run_sql_gates.sh` classifies that RED under rule 3 ("a gate
it cannot classify is RED"), which is the correct outcome, but it is worth
naming: the gate proves the default through assertion 3 reading `pg_attrdef`,
and it is that row, not the crash, that would notice a default quietly changed
to something weaker.

### Control replay

```
check_a_link_is_a_row.sql vs a replay of origin/main .. RED
  ERROR: relation "wholesale_v2.v2_share_links" does not exist
  classified RED:unclassified
```

Classified RED rather than `RED:cannot-run` because `is_unreachable`'s pattern
is `relation "[a-z_0-9]+"` and this error names the relation schema-qualified.
Both are red and the outcome is correct either way; recorded so the next person
reading the runner's categories is not surprised by it.

### ⚠️ A FINDING THAT WAS NOT REAL, AND WHY IT IS WRITTEN DOWN ANYWAY

While red-proving assertion 3 I concluded that a NULL `got` produces an EMPTY
verdict cell — neither `PASS` nor `FAIL` — and therefore that any verdict-table
gate in this repo could report GREEN with an assertion unanswered. I changed the
gate's verdict expression to `is not distinct from`, added a fifth rule to
`run_sql_gates.sh` to catch blank cells, and added a fifth self-test case.

**The premise is false.** A CASE whose condition is NULL is not true, so the
ELSE branch fires:

```
label                            | expected | got | verdict
a rule whose answer went missing | present  |     | FAIL
```

The runner change was reverted, the self-test case removed, and the gate went
back to a plain `=`. What was kept is `coalesce(got, '(no answer)')`, because an
empty cell next to the word FAIL tells the reader nothing about what was found.

It is recorded rather than deleted for two reasons. The first is that "there is
no hole in the verdict expression" is worth an hour of somebody's time — the
reasoning is plausible enough that I acted on it. The second is the sharper one:
**a runner rule added to guard a hazard that does not exist is a grep that can
only ever cry wolf**, and this file already records what happens to a gate that
cries wolf. The negative test that caught it was cheap and should be habit —
remove the new rule, and check whether the thing it was added for still fails.
It did not.

### Production and the replay were compared before the baseline moved

```
replay of all 129 migrations, empty Postgres .. 63/4/170/96  29ac81e8e81ce2d141024985b99a3827
PRODUCTION, measured with the identical query . 63/4/170/96  29ac81e8e81ce2d141024985b99a3827
```

The shape hash sees one new table and one new function, which is what a
migration adding a single empty table would look like. Eleven CHECK constraints,
a composite foreign key, three indexes and a trigger — the entire substance of
127 — are invisible to it. So the table's full structure was fingerprinted on
both sides: every column with its type, nullability, generated expression and
default; every constraint definition on `v2_share_links` *and* `v2_catalogs`;
every index; the RLS flag; the policies; the browser-role grants; the trigger
definition; and the trigger function's body.

```
structural fingerprint, replay ....... 9c058884a045ed3de1390b102bb6f6b2  (53 parts)
structural fingerprint, PRODUCTION ... 9c058884a045ed3de1390b102bb6f6b2  (53 parts)
```

That comparison exists because 127 had to be handed to the apply tool with its
comments stripped — the same step that cost migration 121 its in-body comments.

### And the gate was run against production itself

Eighteen of the twenty-one assertions were re-run directly on production inside
a transaction that raises at the end, so the fixture rolls back:

```
ERROR: PRODUCTION LINK-01 PROBE: ALL 18 ASSERTIONS HELD (rolled back)
```

The three not carried over are the two that read `pg_attrdef`/`pg_attribute`
metadata already covered by the structural fingerprint above, and the
own-shelf-still-works row, which the probe folds into its cross-tenant check.

---

## LINK-06/03/04/07/08/09 — redeeming a link (migration 128)

**The claim.** Every successful redemption ends with a marketplace account and a
live session. Only the store access varies: `joined`, `requested`, `already`.

**Gates:** `checks/check_redeeming_a_link.sql` (26 assertions) and
`checks/check_link_cap_under_concurrency.sh` (5, across real connections).

### ⭐ THE GATE FOUND A DEFECT IN CODE THIS FEATURE DID NOT WRITE

`v2_rate_limit_check` has never been safe under concurrency:

```
select * into v_row from v2_rate_limit_hits where key = p_key for update;
if v_row.key is null then
  insert into v2_rate_limit_hits(key, hits, window_start) values (p_key, 1, now());
```

`for update` locks a row that EXISTS. On a key nobody has used yet there is
nothing to lock, so every concurrent caller takes that branch and all but one
gets

```
ERROR: duplicate key value violates unique constraint "v2_rate_limit_hits_pkey"
CONTEXT: PL/pgSQL function v2_rate_limit_check(text,integer,integer) line 8
```

raised straight out of the RPC at whoever was unlucky.

**It was not found by reading.** The concurrency gate races eight sign-ups down
one link, and the link token is the rate-limit key, so all eight hit a
brand-new key at the same instant. The first run:

```
joined=3 requested=4 errors=1 uses_count=3 sessions=7
```

Three joined, four asked, and **one got a Postgres error**. The cap was right;
the limiter was not.

**Blast radius, measured rather than assumed.** Production carries the identical
body (`md5 30e9a0381c38ab395132936ede8cf0f3`, byte-identical to the replay) and
three live callers, all of them anonymous public forms:

```
v2_submit_signup_request      the "request access" form on the login screen
v2_directory_request_access   asking a store in the directory for access
v2_redeem_invite              redeeming a buyer invitation
```

The window is the FIRST hit of any key — which for a form meant to be shared is
not exotic. Rewritten as one atomic upsert, with the allow/deny boundary
preserved exactly (p_max calls allowed, the next denied) and asserted at that
boundary rather than at "eventually says no".

### The concurrency gate, and the two attempts that did not measure anything

**Attempt 1** launched eight background `psql` processes and hoped. It did not
race: spawn, connect and parse cost tens of milliseconds each while the
redemption takes about one. The proof that this mattered is that with the row
lock REMOVED the race still let in exactly the cap. *A negative test that passes
on sabotaged code is not a negative test.* Fixed with a starting gun: every
racer connects first, then sleeps to one shared wall-clock instant.

**Attempt 2**, with the gun, also let in exactly the cap — and this one is not a
scheduling artefact:

> ⚠ **The cap currently survives a race for a reason that is not the row lock.**
> The rate limiter is keyed on the TOKEN, and now that it is an atomic upsert,
> that upsert takes a row lock on one key which every redeemer of one link
> contends for. Redemptions of a single link are already serialised there,
> several statements before the link row is read.

That is a coincidence of two unrelated keys agreeing, not a design. Change the
rate-limit key — to include a phone, an IP, anything — and the serialisation
disappears silently while every gate stays green. `for update` stays because it
is the guard a person can read, and the note stays so nobody deletes it later on
the evidence of a green race.

**Attempt 3** removes both, and the result is better evidence than an overshoot:

```
shipped:   joined=3 requested=5 errors=0 uses_count=3 sessions=8   ← all 8 signed up
sabotaged: joined=3 requested=0 errors=5 uses_count=3 sessions=3
```

The cap still holds, because migration 127's `v2_share_links_uses_within_cap`
CHECK refuses the row — **the constraint is the backstop.** But the refusal
arrives as a raw check violation: five of eight people get an error instead of
an answer and are turned away from OGGI entirely, which is the one thing this
feature is built never to do. The lock is the difference between "please wait
for approval" and a stack trace.

Stable across three consecutive runs, green and red both.

The gate refuses to report a green it has not earned: if the sabotaged run
behaves correctly it prints **INCONCLUSIVE and fails**, rather than concluding
the lock is unnecessary.

### The SQL gate — 26 assertions, and the sessions are spent, not counted

`session_token is not null` passes on a token that resolves to nothing. Every
session in this gate is handed to `v2_session_person`, and a joined redeemer's
is also handed to `v2_session_stores` — the call the app makes to draw the store
switcher. Assertion 23 goes further and signs in through `v2_marketplace_login`
with the password the redeemer chose.

Rows worth naming:

- **5** — the discounted link does not undo migration 122. The same variant is
  priced through the buyer's default shelf and through a decoy shelf carrying
  40%, and both must return 85.00.
- **17/18** — a token that never existed, one withdrawn and one expired give
  *one distinct answer*, and it names no store.
- **22** — a refused redemption wrote **nothing at all**: no person, no channel,
  no session. Asserted by looking for the phone afterwards and finding zero.
- **13** — `uses_count` spends a slot on a grant, not on an arrival.

### A fixture detail that is migration 127 doing its job

The expired-link row could not be fabricated: `v2_share_links_expiry_window`
requires `expires_at > created_at`, so an expiry cannot be shoved into the past.
The fixture ages BOTH timestamps instead, which is what really happens to a link
somebody sent last month.

### Control replay

```
check_redeeming_a_link.sql vs a replay of origin/main .... RED
  ERROR: relation "wholesale_v2.v2_share_links" does not exist
check_link_cap_under_concurrency.sh vs origin/main ....... refuses to run, and says why
  SETUP FAILED — v2_redeem_share_link is not in 'oggi_main' (migration 128 not applied).
  This is NOT a finding about the cap. Nothing was tested.
```

The shell gate exiting 2 with that sentence rather than 1 is deliberate: a gate
that cannot run must not look like a gate that failed, and must not look like
one that passed either.

### Production and the replay were compared before the baseline moved

```
replay of all 130 migrations, empty Postgres .. 63/4/171/96  c7ce0e83bd86731941b17a763e9a643d
PRODUCTION, measured with the identical query . 63/4/171/96  c7ce0e83bd86731941b17a763e9a643d
```

The hash moved by one function. It did **not** move for the rate-limiter rewrite
— a same-signature body replacement, invisible to it, exactly as migration 107's
rewrite of `v2_approve_signup_request` was — and it cannot see
`v2_signup_requests.share_link_id` either. So the bodies were compared directly:

```
v2_rate_limit_check(text,integer,integer) ................ 5d0055fc05182e9550a3b23110d89a8d
v2_redeem_share_link(text,text,text,text,text,text,jsonb) . 9148908f6926dc1b8678c50e2eaba7ec
```

Identical on both sides.

### Suite on the 128 replay

```
42 SQL gates proved, 0 red, 9 could not run for want of seed data, of 51
76 JS gates pass
```

---

## LINK-02/11/05 — making, listing and peeking at a link (migration 129)

**Gate:** `checks/check_making_and_reading_a_link.sql` — 21 assertions.

Migration 127 gave a link a shape and 128 gave it a redemption. Nothing could
CREATE one: the only way a share link existed was an INSERT typed by hand.

### The two rows that carry the file

**Assertion 12 — what the screen promises is what redemption does.** The hint
is computed in `v2_share_link_peek` and the outcome in `v2_redeem_share_link`:
two functions, the same two facts, the branches written out twice. Two copies of
one rule is how a screen ends up promising *"you're straight in"* to somebody
the server is about to file an approval request for. The gate calls **both** for
all four kinds — including a capped link before and after it fills up, so the
row also proves that both change their minds at the same moment.

**Assertion 6 — the peek never names the person the link was sent to.** A
one-person link travels by WhatsApp and WhatsApp messages get forwarded. A
screen that opens with *"Hi Rita"* publishes, to whoever the message reaches, a
fact the wholesaler told exactly one person. Proven by BEHAVIOUR: the fixture
uses a name and a number nothing else in the schema could produce
(`Zzqx Secret Shopfront`, `03 818 191`) and requires them to appear nowhere in
anything peek returns. Assertion 20 proves the same rule structurally, by
reading the function's source — which is what turns red the day somebody adds
the column back for a friendlier greeting.

### Sabotages, each on its own `template` copy

```
=== the peek greets them by name ...................... 3 red (6, 12, 20)
=== a dead link names its store ....................... 3 red (10, 11, 12)
=== the peek always promises immediate access ......... 1 red (12: 3 disagreements)
=== grant the link list to anon ....................... 1 red (18)
=== the list stops scoping to the caller .............. 3 red (13, 14, 16 — 6 rows leak)
=== revoke stops checking whose link it is ............ 1 red (17: THEY WITHDREW SOMEBODY ELSE'S LINK)
=== D-2's lookup neutered in the SHIPPED body ......... 1 red (15: IT WAS ACCEPTED)
```

The D-2 sabotage is worth naming. The first attempt replaced the whole function
with a stripped version — which broke four earlier assertions before ever
reaching row 15, and told us nothing about D-2 specifically. Rewritten to take
the function's own `prosrc` from the database and neuter exactly one statement
(`select c.shop_name into v_clash` → `select null::text into v_clash`), it turns
**one** row red. A sabotage that breaks five things has not isolated anything.

### Control replay

```
check_making_and_reading_a_link.sql vs a replay of origin/main .. RED
  ERROR: function wholesale_v2.v2_create_share_link(unknown, text, text, numeric) does not exist
```

### ⚠️ A MIGRATION SHOULD NOT WRITE TO `auth.users` TO TEST ITSELF

129's probe was originally written to exercise `v2_create_share_link` end to
end. That needs a wholesaler identity, and `v2_user_profiles.id` references
`auth.users` — so the probe inserted a row into **Supabase's own auth table**.
It worked, and every gate in `checks/` does the same thing, which is why it did
not look wrong at first.

The difference is where each runs. A gate runs against a scratch replay inside a
transaction that is rolled back. A migration runs against **production**, where
`auth.users` is the real user table with real triggers on it. A migration that
writes to auth to test itself is a migration nobody should feel comfortable
applying, and "it deletes the row afterwards" is not the reassurance it sounds
like — the delete only runs if nothing before it raised.

The behavioural half moved to the gate, which does more of it (create, refuse,
list, withdraw, the tenant boundary, D-2, and the peek/redeem agreement) and
rolls back. The migration keeps only assertions about the change it makes: four
functions, one overload each, the peek's source, and the grants. That is the
rule migration 116 was corrected for — *a migration may assert things about the
CHANGE it makes, never about the DATA it happens to find* — applied to the
migration's own test fixture.

### Production and the replay were compared before the baseline moved

```
replay of all 131 migrations, empty Postgres .. 63/4/175/96  14ddb0643bc17d4eb1a94440458860d1
PRODUCTION, measured with the identical query . 63/4/175/96  14ddb0643bc17d4eb1a94440458860d1

v2_create_share_link ... 97759012a8600e898df823fbeab53427
v2_my_share_links ...... 90d2dfc9a70699739c800964b2847660
v2_revoke_share_link ... 9039f993d6d3646bc023c57168730eca
v2_share_link_peek ..... 6c3c3c9f9875b6d5fdeddc0231071ced
```

All four bodies identical on both sides.

### Suite on the 129 replay

```
43 SQL gates proved, 0 red, 9 could not run for want of seed data, of 52
76 JS gates pass
check_link_cap_under_concurrency.sh green, and red under SABOTAGE=1
```

---

## LINK-05 — the stranger's screen, and two dead ends that had been live for weeks

**Gate:** `checks/check_join_screen.mjs` — 34 assertions, jsdom.

### The rule the screen is arranged around

> **Nobody who opens a real link is ever turned away from OGGI.**

So the interesting assertions are not the happy path. All three hints —
`immediate`, `phone_must_match`, `needs_approval` — must render **the same
form**. A used-up link is not a dead end; it is the same form with a different
ending. Red-proved by adding a wall on `needs_approval`.

### ⭐ It never greets them by name

The database will not return `invitee_name` (migration 129), and this gate
proves the browser does not invent a substitute — on the **rendered HTML** and
on the **source**. A one-person link is sent to one number on WhatsApp and
WhatsApp messages get forwarded; *"Hi Rita"* on a forwarded link publishes, to
whoever it reaches, a fact the wholesaler told exactly one person.

The source assertion strips comments first. Without that, a file **explaining**
why it must not read the invitee fails the check for reading it — which would
push the next person to delete the explanation to make the gate pass, and the
explanation is the more valuable half.

### Two dead ends found while wiring this, both live for weeks

**1. `sessionStorage["v2:after-login"]` had been written since 29 August and
never read.** `js/views/buyer.js:1020` writes it when somebody clicks "Sign in"
on a catalogue link that needs one, under this comment:

```js
// Come back here afterwards rather than dumping them on a dashboard --
// they clicked a link to see a catalog, not to arrive somewhere.
```

The comment described the intention. Nothing implemented it. Every one of those
clicks did exactly what the comment says not to do. `app.js` now reads it, uses
it only if it still resolves to a real route, and clears it either way — a stale
destination that survives a session is a link that reopens itself days later,
long after the person who set it forgot clicking anything.

**2. A route registered without `isPublicPath` is a route nobody signed out can
reach.** That is the bug that left `/c/:token` unreachable for three weeks:
`app.js` renders the login screen and RETURNS before a single route is
registered. The gate therefore checks the **pairing** — every registered public
route must also appear in `isPublicPath` — rather than the two facts separately.
Red-proved by registering `/j/` and leaving it out.

### Red proofs

```
=== the screen greets them by name ................. 2 red
=== a used-up link shows a wall .................... 2 red
=== a network failure is called a dead link ........ 2 red
=== redemption stops adopting the session .......... 1 red
=== /j/ registered but NOT public .................. 2 red
=== app.js stops reading the return destination .... 1 red
```

**Two of those sabotages were rewritten before they proved anything**, and both
corrections are the same shape: the first attempt did not actually remove the
thing under test. `if (false) adoptMarketplaceSession({…})` leaves the call text
in the file, so a source-level assertion still passes — the sabotage had to
delete the call. And the `isPublicPath` edit had to be made with an exact-string
replacement that asserts its own anchor, because a regex that silently matches
nothing is a sabotage that never happened.

### ⚠️ A trap inside the gate, recorded because the next person will hit it

`import()` of a `data:` URL is **cached by URL**. Two `loadView` calls built
from identical source returned the SAME module — with the first test's stubs
still bound:

```js
const peekShareLink = globalThis.__peek;   // binds ONCE, at module evaluation
```

The symptom was baffling rather than obvious: the refusal test reported *"cannot
read properties of null"* on the message slot, because it had silently re-run
the previous test's success path and replaced the outlet. Fixed by forwarding
through a function so the stub is read on every call. Busting the cache with a
unique comment per load would also work and is worse — it hides the sharp edge
instead of removing it, and the next person writes the binding version again.

### `ALLOW_DELETIONS=1`, and exactly what it covered

`check_no_feature_loss.sh` flagged one removed line in
`js/views/public-order.js`. It is not a removal:

```diff
-      || /^\/i\/[^/]+$/.test(path || "");  // an invitation to join a store
+      || /^\/i\/[^/]+$/.test(path || "")   // an invitation to join a store
+      || /^\/j\/[^/]+$/.test(path || "");  // a share link: joining a store
```

The `/i/` clause is unchanged except that its terminating `;` moved to the new
last clause. **No feature was removed**, and the whole diff for that file is
four added lines plus one import. The flag is named here and in the commit
message per the standing rule.

### Suite

76 JS gates pass, 6 of 8 shell gates (the other two want a database or a
`wtest` fixture and say so), 43 SQL gates proved / 0 red on the 129 replay.

---

## LINK-02/11 — the wholesaler's side of the link (8 Sep 2026)

`checks/check_share_link_screen.mjs` — **35 assertions, ten sabotages, all ten
proved red.**

### What the ten sabotages proved, and how many assertions each moved

| # | Sabotage | Went red |
|---|---|---|
| S1 | Toast D-2's refusal instead of showing it | 4 |
| S2 | Toast the finished link instead of showing it | 5 |
| S3 | Fold the approval queue into the used count | 2 |
| S4 | Recompute the link's state in the browser | 2 |
| S5 | Drop the `approval` kind | 1 |
| S6 | Offer the discount box on every kind | 1 |
| S7 | Take a tenth sidebar entry | 3 |
| S8 | Remove the door to the screen from Clients | 1 |
| S9 | Lose one state's word (`revoked`) | 1 |
| S10 | Repaint the form after making a link, destroying it | 4 |

Each sabotage names an **exact string** and the runner fails loudly if that
string is not found exactly once. That check is not decoration: on
`check_join_screen.mjs`, two sabotages passed while proving nothing — `if
(false) adopt(...)` leaves the call text in the file, so a source-level
assertion still matched. A sabotage that silently matches nothing is a green
gate with no evidence behind it.

S4 and S9 both moved the assertion *"every state the database can return has a
word a wholesaler reads"*, which is what that assertion is for: it fails whether
the browser invents a state or loses one.

### The nine-entry cap, and a counting mistake worth recording

The first version of the cap assertion counted `{ icon:` in `nav-config.js` and
got **13**. Six of those are inside the comment recording the entries Batch 8B
folded into Inventory — **a regex over source counts the history as well as the
list.** Replaced with an import of the real `NAV_BY_ROLE.wholesaler` array, the
way `check_inventory_module.mjs` has done it since 23 August. Two gates now
assert the same cap from the same source of truth rather than from two
different readings of the file.

### One thing the gate made me change in the code

`share-links-admin.js` had two multi-line imports. The gate loads a view with
its imports stripped by `startsWith("import ")`, which leaves the continuation
line behind and fails to parse — the error names a `}` and not the cause. The
imports are one line each now, with a comment saying why, because the next
person to add an import to that file will otherwise break the gate in a way
that does not explain itself. `join.js` has the same property for the same
reason.

### Suite

77 JS gates pass (`check_manifest_is_honest.mjs` was red until rows 535–543
were written — which is the gate doing its job, and the same way row 451 was
found). `check_no_feature_loss.sh`: **zero deletions**, no `ALLOW_DELETIONS`
needed. `check_imports_resolve.sh`: 380 specifiers, all resolve.

---

## LINK-13 — what a share link may never do (8 Sep 2026)

`checks/check_what_a_link_may_never_do.sql` — **32 assertions, thirteen
sabotages, all thirteen proved red.** Written across migrations 126–129 rather
than against any one of them, because every property it asserts is a property
of the seam between two, and a seam is what a per-migration gate cannot see.

### The thirteen

| # | Sabotage | Result |
|---|---|---|
| S1 | The peek names the store on a dead token | 3 red |
| S2 | A used one-person link is shown a wall | 1 red |
| S3 | The links table granted to `anon`, RLS off | 2 red |
| S4 | `v2_my_share_links` granted to `anon` | 2 red |
| S5 | Rate limit keyed on a constant, not the token | 2 red |
| S6 | The membership written into another store | 1 red |
| S7 | The cap is ignored | **gate aborts** — red |
| S8 | A withdrawn link is redeemable | 3 red |
| S9 | The link's discount never reaches the customer | **gate aborts** — red |
| S10 | The peek names the invitee | 1 red |
| S11 | A redemption writes stock | 1 red (the census) |
| S12 | The cross-store catalogue key dropped | 2 red |
| S13 | The cap constraint dropped | 1 red |

### ⚠️ Four things this gate got wrong before it got them right

**1. It demanded that a used one-person link answer like a dead one.** The
first draft put `used`, `revoked`, `expired` and an invented token in one set
and required a single answer. It went red — and the gate was wrong, not the
code. A used link is **alive**: LINK-05's whole promise is that there is no
state of that screen where somebody holding a real link is shown a wall, and
Hadi's sentence is *"either way, they get access and they are logged in."* The
no-oracle rule of migration 056 is about tokens a **guesser** holds — dead or
invented — not about a real token that has been spent. Had that assertion
shipped, the gate would have demanded the removal of the feature the block
exists for. It is now two assertions that pull in opposite directions
(assertion 1 and assertion 6), so neither half can be quietly dropped.

**2. It compared a share-link token against catalogue pricing and called the
answer a defect.** `v2_token_discount_pct` resolves `#/c/<token>` catalogue
links; a share link is `#/j/<token>`; no screen passes one to the other, and it
correctly returned 0. Replaced with the security assertion that is actually
worth making and is stronger: **a share-link token must buy no discount on the
catalogue pricing path.** If it ever resolved, the link's rate would be
readable by anyone holding the token without redeeming it and without an
account — the "a door decides the price" shape migration 122 exists to prevent.

**3. The row census was written from memory and named seven tables. It is
nine.** The three it missed are the three worth naming: `v2_people` and
`v2_person_channels` are migration 126's entire subject, and `v2_rate_limit_hits`
moves because redemption is rate limited. A census written from memory
certifies whatever the code happens to do; this one went red, and the red was
right.

**4. It asserted a rate-limit key string I had invented.** The first version
required `'share:' || p_token`; migration 128 writes `'link|' || coalesce(p_token, '')`.
It now asserts that `p_token` appears **inside** the key expression, which is
the property that matters and does not go red on a rename that changes nothing.

Also: `v2_share_links_touch` matched the "no other share-link function is open
to a stranger" assertion, because Postgres grants EXECUTE on trigger functions
to PUBLIC by default. It is excluded **by return type**, not by name — calling a
trigger function directly raises *"trigger functions can only be called as
triggers"*, and excluding by name would have let a real function called
`v2_share_links_touch_v2` through.

### ⭐ And one mistake in the sabotage harness, which is the more useful finding

**S7 and S9 were reported GREEN on the first run, and both were red.**

Sabotaging the cap makes the redemption bump `uses_count` past `max_uses`,
which violates **127's `v2_share_links_uses_within_cap`** — so the transaction
aborts and the gate emits **no verdict rows at all**. The throwaway harness
driving these sabotages counted `| FAIL` lines, found none, and printed *"did
not go red"*.

That is precisely the failure `checks/run_sql_gates.sh` was written for on
7 September, repeated in a scratch script four days later. The real runner,
pointed at the same sabotaged database, classified it correctly:

```
RED   check_what_a_link_may_never_do.sql  (unclassified)
```

because its rule 4 is *a gate it cannot classify is RED*. The harness now
treats an aborted or rowless run as red.

**The system was right in both cases** — the table refused to hold a link that
had let more shops in than it was set to, before the function's branch mattered
at all. The gate was proving the branch and not the floor the branch stands on,
so assertion 32 now gates the constraint itself, and S13 proves that assertion
red by dropping it.

### Verification against production

The gate applies no migration, so what has to be true is that it asserts on
**production's own function bodies**. All nine `prosrc` md5s match exactly:

```
v2_buyer_discount_pct    1e21931e497d99a6f4fe3179045c5b9d
v2_create_share_link     97759012a8600e898df823fbeab53427
v2_effective_unit_price  a4c7706978be1b5a3eff527e680cb23d
v2_my_share_links        90d2dfc9a70699739c800964b2847660
v2_rate_limit_check      5d0055fc05182e9550a3b23110d89a8d
v2_redeem_share_link     9148908f6926dc1b8678c50e2eaba7ec
v2_revoke_share_link     9039f993d6d3646bc023c57168730eca
v2_share_link_peek       6c3c3c9f9875b6d5fdeddc0231071ced
v2_token_discount_pct    ead437a9eeed14b583f7577164adbe58
```

and the five security facts were measured on production directly, not inferred
from the replay — which matters because the **grant drift is still open**:

```
anon-callable link fns      v2_redeem_share_link, v2_share_link_peek
links table RLS closed      closed
links table browser grants  none
cap constraint              present
cross-store catalogue key   present
```

### Suite

`bash checks/run_sql_gates.sh oggi_link13` on a clean replay of all 131
migrations (shape `14ddb0643bc17d4eb1a94440458860d1`, matching production):
**44 proved, 0 red, 9 could not run for want of seed data, of 53.**
