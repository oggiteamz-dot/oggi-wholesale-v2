# CR-0001 — Owner Console: create, invite, send, and drill into wholesalers

**Raised:** 17 Aug 2026 by Hadi · **Lane:** NORMAL (schema + code) · **Status:** AWAITING APPROVAL
**Target:** OGGI Wholesale v2 @ `90469b7` · **Section:** Owner console only. Nothing else is touched.

---

## What you asked for, in your words, numbered so none of it can quietly vanish

| # | Your ask | Type |
|---|---|---|
| R1 | "I don't have the ability to manually create any wholesalers" | Defect (v1 had it) |
| R2 | Wholesaler form: **name, industry, category (multiple), location** — presets I can click **and** free text | Change |
| R3 | Create a **username and password** for them in the same form | Defect (v1 had it) |
| R4 | One click → **send by WhatsApp**, or **copy** and send later | Defect (v1 had it) |
| R5 | **Automatically send by email** — and the sending email must be **changeable later** | Change (new) |
| R6 | "No way to connect it to a website so wholesalers can sign up and request an invite" | Change (new) |
| R7 | "I don't have the ability to create an invite and send people there" | Partial defect |
| R8 | Click any wholesaler → see **their products** | Defect (v1 had it) |
| R9 | → see **their clients and all their information** | Defect (v1 had it) |
| R10 | → see **their orders**, filtered **lifetime / today / this month / custom** | Defect (v1 had it) |
| R11 | Modular · nothing truncated · everything navigable · everything commented for a human | Standing rule |
| R12 | A manual backup of every file, not only GitHub | Standing rule |

**7 of the 12 are defects** — capabilities v1 had that the rebuild dropped. Under your own
defect-vs-change rule those are warranty work, not new scope.

---

## What the research changed about this plan

I checked the live database before planning, not after. Three things would have bitten us.

### ⚠️ 1. `v2_wholesalers` cannot hold anything you asked for

The whole table is six columns:

```
wid · brand · name · currency · active · updated_at
```

There is **no industry, no category, no location, no phone**. R2 is not "add a form" — it needs new
columns first. That is a schema change, so it follows expand → migrate → contract.

### ⚠️ 2. Creating a wholesaler writes to **two** tables, and one of them is v1's

`v2_wholesalers.wid` is a **foreign key to v1's `wholesalers` table**. You cannot insert a v2
wholesaler that doesn't already exist in v1. So "create wholesaler" is two inserts that must both
succeed or both fail — otherwise you get a half-created wholesaler and no way to finish it.

v1's `wholesalers` table also already carries **`logo`** and **`owner_phone`** — which is exactly the
phone number R4's WhatsApp send needs. We reuse those rather than inventing new ones.

### 🔴 3. You have two separate identity systems, and they have already drifted apart

| | v1 `public.profiles` | v2 `wholesale_v2.v2_user_profiles` |
|---|---|---|
| Rows today | **6** (owner + 5 wholesalers) | **2** (owner + SQUARE) |

Both map a login to a role independently. v1's security (`is_owner()` → `my_role()`) reads
**`public.profiles`**; v2's reads its own table. A wholesaler created in one is **invisible to the
other**.

This is why the "silent no-op" risk was real: if the new button wrote to `wholesalers` straight from
the browser and your login happened to be missing from `public.profiles`, v1's row-level security
would return **200 OK with zero rows changed** — a success message and no wholesaler. Migration 008's
own header documents that exact failure happening twice in this build.

I checked: your owner row **is** present in `public.profiles`, so it would work *for you, today*.
That is precisely the kind of thing that works until it doesn't. **The fix is to not depend on it** —
see D1 below.

---

## Decisions Hadi made, 17 Aug — locked

- **D0a — Login identity: OGGI-issued.** You type a short handle (`square`) and the system creates
  `square@oggiwholesale.app`. Matches how SQUARE and Milano already work, so no second pattern is
  introduced. You can onboard someone without having their email in hand.
  ⚠️ **Known consequence, accepted:** it is not a real inbox, so a "forgot password" email cannot
  reach them. Until they add a real address, **you** reset a wholesaler's password from the owner
  console. That reset button is therefore **required**, not optional — added to R3's scope.
- **D0b — Email: built now, dormant.** Full path plus a settings screen. Ships switched off, reports
  "not configured", never pretends to send. You turn it on yourself when you have an address.
- **D0c — Public signup: standalone embeddable file.** A single self-contained HTML file for your own
  website, not an in-app page.
  ⚠️ **Known consequence, accepted:** it is a second place the form lives. Mitigation — the file is
  generated from the same field list as the owner form and carries a version stamp in an HTML comment,
  so a drift between them is visible rather than silent. It talks to the same rate-limited
  `v2_submit_wholesaler_signup` RPC; **no credentials are embedded in the file** (publishable key only,
  same posture as the app).

## Design decisions

**D1 — One `SECURITY DEFINER` RPC does the whole creation, atomically.**
`v2_create_wholesaler(...)` inserts the v1 row, the v2 row, and both profile rows in a single
transaction, with its own explicit owner check inside the function (the same pattern
`v2_create_invite` already uses). Either everything is created or nothing is. No browser-side
multi-table write, no dependence on two RLS systems agreeing.

**D2 — Categories are a real table, not a hard-coded list.**
`v2_categories` (seeded with a starter list you can edit) + `v2_wholesaler_categories` (many-to-many,
because a wholesaler sells several). Typing a new one creates it. This is why it's a table: a
hard-coded array would put you back to asking me every time you want a new category — the exact
class of request that should never reach code.

**D3 — Messaging is one dispatcher with pluggable channels.**
`credential-delivery.js` exposes `sendCredentials(wholesaler, {channel})`. Channels: `whatsapp`
(`wa.me` link — works today, zero setup), `copy` (clipboard), `email` (dormant until configured).
Adding SMS later = one new file, nothing else changes.

**D4 — Email settings live in a database table, never in code.**
`v2_outbound_email_settings`: from-address, from-name, provider, API key (vault-backed, write-only),
plus a per-event on/off toggle. You change the sending address in the UI, not by asking me. Until a
key is entered it reports **"email not configured"** rather than pretending to send — the same
honesty rule the AI-import path already follows.

**D5 — Message templates are editable text, not strings in code.**
`v2_message_templates`, one row per event, with `{{brand}}`-style placeholders. R5 says "I can change
what email sends out when" — that only stays true if the wording lives in the admin console.

**D6 — Public signup reuses the buyer pattern that already works.**
`v2_submit_wholesaler_signup` — anonymous, rate-limited, forces `status='pending'` server-side —
modelled line-for-line on the existing `v2_submit_signup_request`. Requests land in the Onboarding
Queue you already have. **No new security surface is invented.**

---

## Files — every one new, except three surgical edits

**New (nothing can be truncated in a file that didn't exist):**

```
supabase/migrations/034_v2_wholesaler_profile_fields.sql   R2  expand only
supabase/migrations/035_v2_categories.sql                  R2  categories + join table
supabase/migrations/036_v2_create_wholesaler_rpc.sql       R1  atomic create (D1)
supabase/migrations/037_v2_messaging_settings.sql          R5  email + templates (D4/D5)
supabase/migrations/038_v2_wholesaler_signup_rpc.sql       R6  public signup (D6)
js/data/wholesaler-admin.js                                R1  create/update data layer
js/data/categories.js                                      R2  list/create categories
js/data/credential-delivery.js                             R4  channel dispatcher (D3)
js/data/messaging-settings.js                              R5  settings + templates
js/views/owner-wholesaler-new.js                           R2  the create form
js/views/owner-wholesaler-detail.js                        R8/R9/R10  the drill-down
js/views/owner-messaging.js                                R5  email settings screen
js/components/category-picker.js                           R2  presets + free text
js/components/date-range-filter.js                         R10 reusable, fixes 3 other screens
public/join.html                                           R6  the public signup page
```

**Edited in place (diff must show additions only):**

```
js/views/owner.js        + "Add wholesaler" button; each row becomes a link to the detail page
js/lib/nav-config.js     + two nav entries (Messaging, and the detail route)
js/app.js                + register the new routes
```

`owner.js` keeps its existing Deactivate/Reactivate button, its audit logging, and its onboarding
checklist **exactly as they are**. I will show you the diff.

---

## R10's date filter is deliberately a shared component

The audit found **three** screens with no date filter (owner, wholesaler, salesperson orders).
Building `date-range-filter.js` as a component means R10 fixes your ask now and makes the other two a
one-line import later — instead of three copies that drift, which is how you ended up with 10 copies
of the escape helper.

---

## Impact table

| Area | Change | Risk | Mitigation |
|---|---|---|---|
| `v2_wholesalers` | +5 nullable columns | None — additive | Expand only; no rename, no drop |
| v1 `wholesalers` | New rows only | **Live v1 app reads this** | Insert-only; no schema change, no edits to existing rows |
| `public.profiles` | New rows only | Drift between the two systems | D1 writes both in one transaction |
| Existing owner screens | Additive | Losing the deactivate flow | `git diff` must show zero deletions |
| Invites | Reuses `v2_create_invite` | None | Not modified |
| Buyer / wholesaler / rep | **Untouched** | — | Not in scope this CR |

## Rollback

Code: revert the commit. Schema: every migration is additive, so old code runs unchanged against the
new schema — **no contract step in this CR**, nothing to un-migrate. The only irreversible artifacts
are wholesaler rows you deliberately created, which is data, not a deployment.

⚠️ Per the rollback rule: after 034–038 are applied, a code-only rollback is safe *because* nothing
is dropped. That is the reason for the no-contract-step design.

---

## R12 — the backup you asked for

Every file I write in this CR gets, in the same action:

1. Written to the repo working copy.
2. Saved to `Fashion Wholesale Order Catalog/_file-backups/2026-08-17/` on your disk, full text, plain
   `.txt`, timestamped, **never overwritten** — a new dated folder each run.
3. Delivered to you in chat as a downloadable file.

Three copies, none dependent on GitHub. This matters today: **the GitHub push is currently failing
with `403 Resource not accessible by integration`**, so the repo is *not* a reliable destination right
now. Backup is the primary, not the fallback.

---

## Proof — what "done" will mean

Not "the code is written." Each item gets a check that is **shown failing first**:

| # | Proof |
|---|---|
| R1 | Create "Test Brand" → it appears in `v2_wholesalers` **and** v1 `wholesalers` **and** both profile tables. Delete it. Confirm all four are clean. |
| R2 | Create with 3 categories + 1 typed-in new one → reopen the record, all 4 persist |
| R3/R4 | Log in as the created wholesaler with the generated password; WhatsApp link opens with the message pre-filled |
| R5 | With no key: says "not configured", does not pretend. With a key: sends. Change the from-address; next send uses the new one |
| R6 | Submit `/join.html` in a private window (logged out) → appears in the Onboarding Queue |
| R8/9/10 | Open SQUARE: 4 products, 2 clients, 0 orders — the real numbers from the live database, and the date filter changes the count |
| R11 | `git diff` shows zero deletions; every new file opens with a plain-English header |

---

## Sequence — one at a time, proven before the next

Your standing rule, and the audit is the argument for it.

1. **R1+R2+R3** — create a wholesaler (the blocker; nothing else matters until this works)
2. **R4** — WhatsApp + copy (no setup needed, immediate value)
3. **R8+R9+R10** — the drill-down page
4. **R6+R7** — public signup + send an invite
5. **R5** — email, dormant and configurable

---

## Out of scope — named so it is a decision, not an omission

Not in this CR, still open, tracked in `REGRESSION-LEDGER-2026-08-17.md`:
the client-stats join bug (#1 — I recommend doing this *before* R9, since the drill-down will display
those same wrong numbers), favourites dead-end, order notes unwritable, no product/variant editor, no
image upload, colours stuck grey, rep cannot order, orders cannot be cancelled.

**R9 depends on the join bug.** If we build the drill-down first, it will faithfully show
"0 orders, never ordered" for every real client. I would fix the one-line join as step 0.
