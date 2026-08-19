# Catalog Builder — plan

**Status: for approval. Nothing below is built yet.**
19 Aug 2026.

---

## What the research turned up

Four findings that shape everything else. The first three are load-bearing;
the fourth is a live bug.

**1. The server is the price authority, and there is exactly one function.**
`v2_submit_order` does not trust any price the browser sends. It re-prices
every line itself through `v2_effective_unit_price(product, variant, client,
aggregate_qty)`, and writes *that* into `v2_order_items`. So both new discounts
have to land inside that one function. If they only go in the JavaScript, the
buyer sees a discounted cart and is then invoiced at full price — and nothing
would look broken until a customer complains about their invoice.

The JS `effectivePrice()` in `js/data/pricing.js` mirrors that function today.
It has to keep mirroring it exactly, so the plan treats the two as one change,
never one without the other.

**2. "Tier" already means something else in this codebase.**
`v2_pricing_tiers` is quantity breaks — buy 50+, pay this. What you're
describing is a *customer access level*. Two different things called tier in
one schema is how someone eventually applies the wrong one. Throughout this
plan the new one is **customer tier** and the column is `access_tier`; the
quantity ones keep the name they have.

**3. The buyer side has no idea catalogs exist.**
`getCatalog(wid)` returns every non-archived product the wholesaler owns.
Catalogs are currently wholesaler-side filing and nothing more — migration 045
says so explicitly and lists per-catalog pricing and client assignment as
deliberately deferred. So the tier gate is genuinely new work on the buyer
side, not a filter added to something that exists.

It also has to be a `SECURITY DEFINER` function. Buyers and reps run as `anon`
(they authenticate through `v2_portal_accounts`, so `auth.uid()` is NULL and
`v2_my_wid()` cannot identify them). There is no row policy that can scope an
anon read to "the catalogs my tier allows" — migration 045 wrote that warning
down in advance so the shortcut would not be taken later.

**4. `v2_clients.discount_pct` already exists — and does nothing.**
The column has been there since migration 006. The client form captures it,
the client list prints "10% discount", the owner console reports on it, and
the login RPC returns it into the session. **No pricing path anywhere reads
it.** A client set to 10% today pays full price, on screen and on the invoice.
That is a live bug and this work fixes it rather than adding a second
discount mechanism beside it.

---

## The features

### A. Catalog setup

Each catalog gains four things beyond the name and description it has now:

| Field | Meaning |
|---|---|
| **Customer tier** | Which customers may see it. A catalog at tier 2 is visible to tier-2 customers and everyone above. |
| **Discount %** | Applied silently to every product in it. Negative raises the price. |
| **Discount mode** | The switch below: how this catalog's discount and the customer's own preset combine. |
| Active / default | Already exist. |

The catalog discount is **invisible to the buyer**. No badge, no strikethrough,
no "5% off" — the adjusted number simply *is* the price they see. That is the
point of it: a margin dial per catalog, not a promotion.

A negative discount is a supported input, not an accident to guard against.
`-10` means this catalog sells at 110% of list.

### B. The discount mode — the switch

Every customer has one flat percentage of their own (`v2_clients.discount_pct`,
which already exists and is currently ignored by every pricing path — see
finding 4). Each catalog decides what happens when its own discount meets that
one:

| Mode | Result |
|---|---|
| **Combine** (default) | Catalog % **+** customer %. 5% catalog and 20% customer = **25% off**. |
| **Catalog only** | The customer's preset is skipped entirely. Everyone who can see this catalog pays the same. This is what a clearance range priced to the bone needs. |
| **Customer only** | The catalog's own discount is skipped and the customer's preset applies instead. |

One rule cuts across all three: **a customer with no preset discount still gets
the catalog's.** Under *Customer only* a customer sitting at 0% would otherwise
pay full list, which is never what was meant — so their 0% falls back to the
catalog's discount.

There is deliberately no per-product, per-customer price in this design. With a
thousand customers that is not a thing anyone can maintain by hand. (The schema
does still carry `v2_client_price_overrides` from an earlier batch, used by the
salesperson "Set price" screen. Where one of those exists it **wins outright**
and neither discount touches it — a hand-typed price is a promise someone made
to a customer, and nothing here should quietly move it.)

### C. Customer tiers

The wholesaler sets the tier on each customer by hand. Tiers run 1–5;
everything starts at 1, so on the day this ships every existing customer still
sees the Main Catalog and no storefront goes empty. Raising someone is a
deliberate act.

### D. Adding products — two buttons

- **Create new product** — the existing builder, filed into this catalog. Works today.
- **Pick from inventory** — new. A picker listing every product the wholesaler
  owns, with photo, name, colours/sizes and price. Multi-select, one "Add N
  products" button. Products already in this catalog show as already-in rather
  than failing on the click.

### E. A product inside a catalog can be opened and edited

Clicking a product opens the same View/Edit the rest of the app uses. Edits are
global — the product is one object. The catalog's own lever is its discount,
not a second copy of the product.

### E2. What the buyer sees

- The catalog discount is **silent**: it just is the price.
- The customer's own discount **is shown**: catalog price struck through, their
  price beside it. They should know they are getting their rate.
- If the customer's discount does not apply (mode *Catalog only*, or they are
  at 0%), there is no strikethrough at all — one price, no theatre.

Worked example, list 100.00, catalog −5%, customer −20%, mode *Combine*:

```
list price                100.00
after catalog discount     95.00   ← struck through (the buyer's "before")
after customer discount    75.00   ← 25% off 100, additive
```

100.00 never appears on the buyer's screen. Showing it would leak the catalog
discount, which is meant to be invisible.

### E3. A product in two catalogs at once

Summer at −5% and Clearance at −20%, both visible to one customer. **The price
follows the catalog they are browsing**, and the order records which catalog it
came from. It is the only rule that stays explainable six months later when
someone asks why a line was 75.00 — and it stops Clearance pricing leaking into
Summer for anyone who can see both. Flagging it as my call, since it was the
one question left unanswered.

### F. Everything downstream that has to agree

- `v2_effective_unit_price` — both discounts, server side, authoritative.
- `js/data/pricing.js` `effectivePrice()` — the same arithmetic, so the cart
  agrees with the invoice.
- The buyer catalog read — a new `SECURITY DEFINER` function returning only
  products in catalogs this account's tier permits.
- `v2_orders` — gains `catalog_id`, so an order records which catalog it was
  placed from. Without it there is no way to answer "why was this line 75.00"
  six months later, and no way to price a product that sits in two catalogs.

---

## What I am NOT proposing to build in this pass

Stated so they are decisions rather than things I forgot:

- Assigning specific customers to specific catalogs by hand. Tier does that job
  for now; named assignment is a different feature and can sit on top later.
- Public/shareable catalog links.
- Per-catalog product *pricing* set individually per product (as opposed to
  one discount for the whole catalog).
- Scheduling a catalog to go live or expire on a date.

---

## Order of work

1. Migration: `access_tier`, `discount_pct` and `discount_mode` on catalogs,
   `access_tier` on customers, `catalog_id` on orders — plus the column grants,
   which migration 045 deliberately wrote out one column at a time.
2. `v2_effective_unit_price` rewritten, with the stacking rule, plus a SQL
   check that proves the arithmetic against a table of worked examples.
3. The buyer-side `SECURITY DEFINER` catalog read, tier-gated.
4. `effectivePrice()` in JS brought into line, plus a check that runs the same
   worked examples through both and fails if they ever disagree.
5. Catalog setup UI (tier, discount).
6. The inventory picker.
7. Buyer-side display: silent catalog price, struck-through client discount.
8. Checks red-proven, pushed, verified live.

Steps 1–4 before any UI, deliberately. The pricing rule is the part that is
expensive to get wrong and cheap to test, and building screens on top of an
unproven price is how you end up with a beautiful catalog that invoices the
wrong number.

---

## Next after the builder: proper client accounts

Decided 19 Aug 2026, to be built once the builder screen is done.

Every client gets a real login — no contacts-without-access. Password is
**generated by default and shown exactly once**, with the option to type one
instead. The generated path reuses what `v2_approve_signup_request` already
does (migration 024): the password comes back in that one response, is never
stored in readable form, and cannot be retrieved again — only reset.

Fields on the client record:

| Group | Fields |
|---|---|
| Who | Shop name, owner/contact name, phone |
| Where | Address, city, country |
| Login | Username, password (generated or typed) |
| Commercial | Discount %, customer tier, payment terms, credit limit |
| Trade | Wholesaler or retailer, and what categories they sell |

The last row is the customer-side mirror of what suppliers already carry
(`sells`, `brands` on `v2_suppliers`, migration 052) — same idea pointed the
other way, and worth the same shape rather than a second invention.
