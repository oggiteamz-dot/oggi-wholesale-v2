# Outstanding — raise these before calling anything finished

**Last reconciled: 30 August 2026 (twice — see §7, added overnight).**

Written down because a thing agreed in conversation and not written down is a
thing that quietly does not happen.

And rewritten on 21 August because a thing written down and never checked is the
same thing, one step later. This file said the inventory revamp had NOT STARTED
while seven batches of it were shipping; it listed the billboard as still to do
in §4 and as built in §5, three lines apart. Nothing failed when it drifted,
which is exactly why it drifted. Its sibling, `FEATURE-MANIFEST.md`, now has
`checks/check_manifest_is_honest.mjs` holding it to the code. **This file cannot
be checked the same way — it is about things that do not exist yet, and there is
nothing to compare it against.** So it carries a date instead, and the rule is:
if the date is more than a batch old, do not trust a line of it without looking.

---

## 1. The inventory revamp — DONE, 20–21 August 2026

**Hadi, 19 Aug 2026:** *"We're going to go in and revamp the inventory to have
all the different features that I asked for… when I tell you we finished, you
remind me: hey, we still have the inventory."*

Delivered as batches 0–6 across the night of 20–21 August. What that involved:

| Batch | What shipped |
|---|---|
| 0 | The reservation leak — expired cart holds had been suppressing real stock permanently and silently |
| 1 | Reorder points, breakouts and dead-stock thresholds became per-wholesaler settings instead of hardcoded constants |
| 2 | The stock movement ledger, written since migration 001 and displayed nowhere, got a screen — and a cross-tenant read leak was closed on the way |
| 3 | Stock valuation with honest coverage, dead stock that requires evidence of age, and a partition runway that was eleven days from taking every wholesaler offline at once |
| 4 | Barcode label generation — v1 had it, the 2.0 rewrite kept only the reader |
| 5 | Per-piece pricing, the ×N multiplier, and the buyer's product card finally rendering a photo |
| 6 | Products folded into Inventory, and the bulk reprice rebuilt so it can be previewed and undone |

Migrations 064–078a. Every batch merged through its own PR with its own gates,
each proven red before green.

**What the revamp did NOT cover, and is therefore still open:** rows 4, 43, 44,
45 and 46 of `FEATURE-MANIFEST.md` (renumbered on 23 Aug when Batch 8 inserted
seven rows at 15–21) — reorder minimums, kit assembly, landed
cost, cycle counts and suppliers all exist and none of them has a gate. They
work today. Nothing would tell you if they stopped.

---

## 2. Client accounts — SPECIFIED, MOSTLY NOT BUILT

Full spec at the bottom of `docs/CATALOG-BUILDER-PLAN.md`, and a fuller one in
`[C] Client Accounts — Deep Research, Feature List & Action Plan (Aug 20 2026)`
— 40 features, CL-01 to CL-59.

Built so far: **the ban system** (migration 059 — per-wholesaler, never global,
enforced in three server-side places).

**Correction, 21 August 2026.** The session handoff of 20 August, and the copy
of it in `CLAUDE.md`, both say in bold: *"migration `060` (client profile fields
+ `v2_create_client`) is written and pushed but **NEVER APPLIED** to the
database."*

**That is false.** Checked directly: `supabase_migrations.schema_migrations`
holds `v2_client_profile_and_create`; `v2_clients` carries all seventeen profile
columns it adds (`owner_name`, `sells`, `city`, `area`, `address`, `country`,
`phone2`, `email`, `business_type`, `branches`, `years_in_business`,
`instagram`, `photo_url`, `language`, `heard_from`, `commercial_reg`,
`vat_number`); and both `v2_create_client` and `v2_reset_client_password` exist.

It is recorded here rather than quietly dropped, because a ⛔ that is wrong is
more expensive than one that is missing: somebody would have spent a session
applying a migration that was already live, and might have concluded from the
attempt that something deeper was broken.

So the real position on client accounts: the schema and the two RPCs are in
place. What is missing is the app around them — 35 or so of the 40 features in
the action plan, including anything that lets a wholesaler actually fill those
seventeen fields in.

---

## 3. The customer side — DELIBERATELY NOT DESIGNED YET

Hadi, 19 Aug: *"We will talk about the customer side when we get to it."*

A catalog LINK works today and shows the catalog. What has not been designed and
must not be guessed at:

- **Guest checkout on a public catalog** — "the second they click order, they
  just have to put in their name and phone number". Nothing collects that yet.
  A catalog can be marked public; a guest still cannot complete an order.
- What a returning customer lands on when they open the app without a link.
- Whether the buyer dashboard as it stands (browse everything, favourites)
  survives at all.
- **The link page has no chrome of its own.** It renders inside whatever shell
  the visitor already has, so opening a link while signed in as a wholesaler
  shows the wholesaler sidebar around it. A customer following a link from
  WhatsApp is not signed in as anything and does not see that, so it is not
  broken today — but a page whose whole job is to be opened by strangers should
  carry its own minimal frame rather than borrowing one.

---

## 4. Known, logged, not fixed

- **The tier gate is not a hard boundary.** `v2_products` and
  `v2_product_variants` still carry an `auth.uid() is null` read policy, so the
  `anon` role can read every product row directly. A buyer sees only the
  catalogs their tier allows *in the app*, and the catalog they order through is
  validated server-side — but somebody with developer tools could still query the
  product table. Closing it means revoking anon on both tables and routing every
  buyer read through SECURITY DEFINER functions, which touches the whole buyer
  app and deserves its own batch rather than being smuggled into another one.
- `v2_pricing_tiers` still has a permissive read policy.
- **`js/data/catalog.js` keeps its own `LOW_STOCK_THRESHOLD = 15`**, separate
  from the per-wholesaler setting Batch 1 introduced. It is allowlisted in
  `check_single_low_stock_threshold.sh` rather than hidden: the buyer catalogue
  reads as `anon` and cannot see `v2_inventory_settings`, so making it honest
  means a public RPC that exposes one number per wholesaler. Small, but it is a
  new public surface and it belongs in its own change.
- **The cart snapshots pack composition at add-to-cart time.** Editing a pack
  while it sits in a buyer's cart fails checkout — correctly, since migration
  028 — with an unhelpful message. Needs a "this pack changed, please review
  your cart" path.
- **`v2_create_wholesaler` writes to v1's `public.wholesalers` and
  `public.profiles`.** Ten foreign keys point out of `wholesale_v2` into v1's
  schema. `supabase/migrations/000_v1_prerequisites.sql` now documents and
  satisfies that coupling so the repo can rebuild, but the coupling itself is
  still there. Untangling it — repointing the FKs at `v2_wholesalers` — is a
  real migration against a live v1, and it is named here rather than attempted.

---

## 5. Gates that do not exist yet

Every ⚠️ in `FEATURE-MANIFEST.md` is a feature that works and would fail
silently. In rough order of what it would cost if it broke:

1. **Reorder minimums** (row 4) — a buyer's second order is allowed to be
   smaller than their first. Nothing asserts the distinction survives.
2. **Landed cost** (row 44) — feeds the valuation numbers a wholesaler might
   take to a bank, and is still two unreconciled numbers with `variants.cost`.
3. **CSV import/export** (row 58) — already caused one silent loss, when the
   importer hardcoded `sellMode: "open"` over every wholesaler's selling model.
4. **Kit assembly, cycle counts, suppliers, AI import, integrations** (43, 45,
   46, 59, 60).

---

## 5a. DEFERRED TO AFTER LAUNCH — advertising, run by Hadi himself

**Hadi, 30 August 2026:** *"give me the ability to set and create ads through
the owner's console."*

**And an hour later, same day — DEFERRED BY HADI:** *"scrap the ads thing until
we fully launch this. This is going to be part of the update feature."*

So this is not the next thing, and it is not a gap in the launch. It is a
POST-LAUNCH item, and it is written down in full below anyway — the request was
specific, the reasoning behind the eight open decisions does not expire, and a
thing agreed in conversation and not written down is a thing that quietly does
not happen. When the update set is planned, this section is the starting point
and does not need to be re-derived from memory.

Nothing in the launch build depends on it. The recommendation shelves already
shipped (RC-01, RC-02) are asserted NEVER to read the promotion table, and
those assertions stay exactly as they are: advertising, when it comes, gets its
own labelled surface rather than being mixed into a shelf that claims to be
earned.

Written here the hour it was said, because the paid feed is currently a
half-decision that lives in two places and neither of them is a screen.

### What exists today

- `v2_oggi_promoted` — the promotion table. It exists. **Nothing writes to it
  through any interface**, and nothing in the owner console mentions it.
- Every recommendation shelf built so far (RC-01, and RC-02 as planned) is
  asserted to NEVER read that table. That is deliberate and stays true: paid
  placement is a separate, labelled thing, and the moment "popular" can be
  bought, the word stops meaning anything and every other shelf inherits the
  doubt. Advertising does not change those rules — it gets its own surface.
- The paid ratio (how much of the home feed may be paid) was discussed on
  30 August and provisionally set at one-in-six with a config row. **It has
  never been formally answered by Hadi and is still open.**

### What "create an ad" has to mean before it can be built

Not one feature. At least these, and each is a decision Hadi owns:

1. **WHO is advertised** — a whole store, or specific products, or both.
2. **WHERE it appears** — the buyer home feed only, or search results, or the
   category browse. Search is the dangerous one: SR-04's data wall exists so
   search telemetry cannot leak between wholesalers, and a paid slot in search
   is a new way to ask the same question.
3. **WHO SEES IT** — every buyer, or only buyers who do NOT already have
   access to that store. Advertising a store to its own existing customers is
   spending the wholesaler's money to show them a door they already have.
4. **HOW MUCH INVENTORY** — the ratio above, and whether it is per screen,
   per session or per day.
5. **HOW IT IS PAID FOR** — flat fee for a period, or per impression, or per
   click. This decides whether the system needs counting it can be billed on,
   which is a much bigger build than a flag on a row.
6. **HOW IT IS LABELLED to the buyer** — and it must be labelled. An unlabelled
   paid placement inside a shelf of earned ones is the thing that makes every
   other shelf untrustworthy.
7. **WHO CAN CREATE ONE** — Hadi only, from the owner console, is the ask.
   Whether a wholesaler can later buy one self-serve is a different product.
8. **START AND END DATES**, and what happens to a live ad when the store it
   points at is deactivated, or the product is archived, or it goes out of
   stock. An advert for something nobody can buy is worse than no advert.

### Where it sits in the order

AFTER LAUNCH, by Hadi's own instruction on 30 August. Within the pre-launch
order he gave that day, the paid-feed items (PB-01/02/03) sat after the
access-control work and before Phase 7; that whole group now moves behind the
launch, and this request is the owner-console half of it. It is written
here so that when PB-01 comes up, it comes up as "Hadi asked to run these
himself from the console", not as a table nobody can reach.

**Do not build any of it until questions 1–8 have actual answers.** A promotion
system built on guesses about who pays for what is the one kind of feature that
is expensive to be wrong about, because the money is real.

---

## 6. How to keep this file true

- `FEATURE-MANIFEST.md` is checked against the code by
  `checks/check_manifest_is_honest.mjs`. Run it.
- This file is not checkable. Re-read it at the end of every batch and change
  the date at the top, or delete the date so the next reader knows it is stale.
- **When Hadi asks what is left, read this file out loud — do not answer from
  memory.** Answering from memory is how §1 stayed wrong for two days while the
  work it described was being finished.

---

## 7. Found on the way to SR-07, overnight 30 August 2026

Three things the documents asserted and the database contradicted. Recorded
here the hour they were found, because a finding that lives only in a session
log is a finding the next session re-discovers.

### 7.1 "11 of 92 gates fail and they are all environmental" — wrong twice over

Measured on a fresh clone at `f07536c`, replayed into an empty Postgres 16.

- **Two of the eleven actually PASS.** `check_intelligence_zero_setup.sql`
  (11/11) and `check_movement_partitions.sql` (4/4) signal success by raising
  `ROLLBACK_WITH_REPORT` — they roll themselves back on purpose, so psql exits
  non-zero **on a pass**. Any runner that reads the exit code alone marks them
  failed. They have been on the "known failures" list for days for that reason
  and nothing was ever wrong with them.
- **One of the eleven is a real gate reporting a real production condition.**
  `check_tenant_isolation.sql` needs no fixture at all. It ran, and reported
  43 problems. See 7.2.
- The corrected pre-change baseline is **83 pass / 9 fail** — 8 environmental,
  1 real. After SR-07: **85 pass / 9 fail of 94**, the failing set byte-identical.

**The eight genuinely environmental ones**, each for a stated reason rather than
by assumption: `check_pack_moq.sh` (says so itself — needs the `wtest` fixture
database), `check_client_ban.sql` (FK, needs a seeded wholesaler),
`check_line_pricing.sql` ("no active wholesaler to hang a fixture on"),
`check_reservation_expiry.sql` ("no variant with >= 3 on hand"),
`check_size_ratios.sql` (missing fixture product),
`check_bulk_price_safety.sql` (empty `request.jwt.claims` → `''::jsonb` raises),
`check_movement_ledger.sql` and `check_valuation_and_dead_stock.sql`
(permission denied — the replay does not reproduce production's
`authenticated` grants, which the shape hash does not cover either).

**Building the `wtest` fixture would retire seven of the eight.** It is a
legitimate piece of work and it is not a prerequisite for anything.

### 7.2 The movement-ledger partitions have RLS OFF on production

**Measured, not inferred.** 41 future monthly partitions of
`v2_inventory_movements` plus `_default` have `relrowsecurity = false`, while
`authenticated` holds SELECT/INSERT/UPDATE/DELETE on them directly — handed out
by the schema's standing `alter default privileges ... to authenticated`, the
`authenticated` twin of the `anon` rule migration 085 revoked.

**Demonstrated in a replay, not theorised:** wholesaler A querying the PARENT
table sees only their own movements; querying the PARTITION by name sees both
wholesalers' rows, and can DELETE the other wholesaler's ledger entries.
Postgres applies the policies of the relation actually named, and a partition
with RLS disabled has none.

**It is NOT reachable through the app's API, and that is the honest verdict.**
Probed against production with the app's own shipped publishable key:
`v2_inventory_movements_2026_09` returns `PGRST205 could not find the table in
the schema cache` — PostgREST does not expose partitions. **Sanity-checked in
both directions**, the lesson from Batch S: the parent table returns
`401 permission denied` and an invented table name returns the same 404 as the
partition, so the probe can tell a shut door from a shut shop.

So: **a latent defect, not a live breach.** Reaching it needs a direct Postgres
connection, which needs the database password. It is written down rather than
fixed tonight because Phase 7 — the security audit — is deliberately last by
Hadi's instruction, and this belongs to it. The fix when it comes is small:
enable RLS on every partition, and make whatever creates the next month's
partition do the same.

**And the gate that found it has been failing, correctly, for days.**
`check_tenant_isolation.sql` also flags `v2_live_holds` as a definer view
readable by a browser role — which is deliberate and documented in `CLAUDE.md`
(invoker rights would report zero holds to a buyer and let them oversell). One
known-and-accepted finding sitting inside a red gate is how the other 42 went
unread. **A gate that is allowed to stay red stops being a gate.**

### 7.3 The sandbox CAN reach Supabase

`CLAUDE.md` says *"the sandbox CAN'T reach Supabase (network-restricted) — run
SQL by DRIVING Hadi's logged-in Supabase in the browser"*. That is no longer
true. A plain HTTPS request to the REST API works from the session container,
and the Supabase MCP tools are connected and answering — migrations `101` and
`102` were applied through `apply_migration` rather than by driving the
dashboard. The browser is still the only write path for **GitHub**.
