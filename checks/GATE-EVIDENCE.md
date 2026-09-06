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
