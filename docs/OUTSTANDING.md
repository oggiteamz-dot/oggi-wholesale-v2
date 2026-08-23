# Outstanding — raise these before calling anything finished

**Last reconciled: 21 August 2026.**

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

**What the revamp did NOT cover, and is therefore still open:** rows 4, 42, 43,
44 and 45 of `FEATURE-MANIFEST.md` (renumbered on 23 Aug when Batch 8 inserted
six rows at 15–20) — reorder minimums, kit assembly, landed
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
2. **Landed cost** (row 43) — feeds the valuation numbers a wholesaler might
   take to a bank, and is still two unreconciled numbers with `variants.cost`.
3. **CSV import/export** (row 57) — already caused one silent loss, when the
   importer hardcoded `sellMode: "open"` over every wholesaler's selling model.
4. **Kit assembly, cycle counts, suppliers, AI import, integrations** (42, 44,
   45, 58, 59).

---

## 6. How to keep this file true

- `FEATURE-MANIFEST.md` is checked against the code by
  `checks/check_manifest_is_honest.mjs`. Run it.
- This file is not checkable. Re-read it at the end of every batch and change
  the date at the top, or delete the date so the next reader knows it is stale.
- **When Hadi asks what is left, read this file out loud — do not answer from
  memory.** Answering from memory is how §1 stayed wrong for two days while the
  work it described was being finished.
