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
