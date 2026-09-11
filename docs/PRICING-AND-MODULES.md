# How OGGI breaks into modules, and what each one is worth

**Written 11 September 2026, answering Hadi:**

> "Look at the full system and decide how can we actually price it and how many
> different modules can we break this into where each module is actually useful
> on its own and still cause necessity in other modules."

Measured against the system as it stands at `eb6bcab`: **33,570 lines of JS, 28,801
lines of SQL across 133 migrations, 587 proven features, 13 wholesalers in
production.**

---

## ⭐ THE ONE FINDING THAT DECIDES THE PRICING PAGE

Hadi's test has two halves — *useful on its own* **and** *creates necessity in
the others*. Applied honestly to every capability in the system:

**Only two blocks pass the first half.**

| Block | Useful with nothing else? | Why |
|---|---|---|
| **Catalogue** | ✅ **Yes** | A priced, photographed, shareable line sheet replaces a PDF and a WhatsApp price list on day one, with zero buyers on the platform. |
| **Inventory** | ✅ **Yes** | Multi-location stock, transfers, a movement ledger, receiving and barcodes is a complete WMS-lite. It needs no buyer, no order, no catalogue. |
| Orders | ❌ No | Needs something to order. |
| Warehouse desk | ❌ No | Needs orders to work on. |
| Finance desk | ❌ No | Needs orders to bill for. |
| Field/sales desk | ❌ No | Needs clients and a catalogue. |
| Insight | ❌ No | Needs *history* — from both orders and stock. |
| Marketplace | ❌ **No, and worse: worth exactly zero at one seller.** | It is literally a list of other companies. |
| Integrations | ❌ No | Needs stock to move. |

**This is not a defect. It is the shape of the product, and the pricing page has
to tell the truth about it.**

What it means commercially: there are **two doors in** and **one expansion
motion**. A pricing page that presents eight equal modules will be bounced off,
because six of them are unbuyable to a new customer. A pricing page that presents
two doors and a set of obvious next steps will convert.

---

## The necessity graph — what pulls what

This is the second half of Hadi's test, and it is where the money is. Each arrow
is a sentence a real customer says.

```
                    ┌──────────────┐
                    │   CATALOGUE  │◀────────────┐
                    │   (door 1)   │             │ "the stock list has
                    └──────┬───────┘             │  no photos and no prices"
                           │                     │
        "they can see it — │                     │
         now let them      │              ┌──────┴───────┐
         order it"         │              │  INVENTORY   │
                           ▼              │   (door 2)   │
                    ┌──────────────┐      └──────┬───────┘
           ┌────────│    ORDERS    │─────────────┘
           │        └──┬────────┬──┘  "I sold something I didn't have"
           │           │        │
 "who owes │           │        │ "I'm forwarding screenshots
  me money"│           │        │  to the warehouse"
           ▼           │        ▼
    ┌───────────┐      │  ┌───────────┐
    │  FINANCE  │      │  │ WAREHOUSE │
    │    DESK   │      │  │    DESK   │
    └─────┬─────┘      │  └─────┬─────┘
          │            │        │
          │  "margin   │        │ "the pick sheet is
          │   needs    │        │  wrong because the
          │   cost"    │        │  stock is wrong"
          └────────────┼────────┘
                       ▼
                 ┌───────────┐
                 │  INSIGHT  │   needs history from BOTH sides
                 └───────────┘
```

**Two of those arrows are not speculation.** Migration `088_v2_order_handoff_token.sql`
opens by naming the exact people this proposal now sells desks to:

> *"There is no way to hand the order to anyone who is not signed in to this app:
> the **warehouse**, who need a picking sheet on paper; the driver…; **an
> accountant**, who wants a PDF. Today that handoff happens by screenshot."*

And migration `087_v2_fulfil_note_wholesaler_track.sql` created `fulfil_note` —
*"the wholesaler's instruction to their own warehouse"* — **which to this day has
no reader.** The column has existed since 28 August and nobody has ever been able
to open it, because there is no warehouse account. The Warehouse Desk is not a new
idea being invented for a price list; it is the missing half of something already
built.

---

## The modules

Nine, and they are deliberately not nine equal things.

### Door 1 — **SHELF** (the catalogue)
*Products, colour × size variants, photography, the four selling models
(open stock / prepack / ratio / full series), pricing, MOQ, the discount stack,
shelves and billboards, categories and brands, CSV and AI catalogue import.*

`js/data/products-admin.js`, `js/components/product-form.js`,
`js/components/order-setup.js`, `js/data/{pricing,catalogs,catalog}.js`,
migrations 001, 009–012, 015, 029, 030, 045, 046, 053, 054, 061, 063, 079, 097

- **~13,500 lines. ~150 manifest rows.**
- **Alone it replaces:** a designed PDF line sheet, a WhatsApp price list, and the
  argument about which price was current.
- **The hard part nobody else has:** four selling models enforced *server-side*.
  Prepacks that collapse at order time, programmable size ratios, colour minimums,
  a series that builds its own pack. This is the single hardest thing in the
  system to replicate and it is the reason a clothing wholesaler cannot just use
  Shopify.

### Door 2 — **STOCK** (inventory)
*Multi-location balances, transfers, the movement ledger, reservations and expiry,
receiving and counting, landed cost, EAN-13 barcodes and label printing, kits,
the supplier book.*

`js/data/{inventory-admin,inventory-movements,locations,barcodes,suppliers,kits}.js`,
`js/components/receive-product.js`, migrations 001, 043, 047, 050–052, 064–065,
069–076, 121, 124, 125

- **~9,200 lines.**
- **Alone it replaces:** the stock spreadsheet, and the phone call to the other
  branch asking what they have.
- **Note:** partitioned movement ledger with runway to 2029, and every partition
  is RLS'd independently (migration 125 — that was a live cross-tenant leak found
  and closed).

### The connector — **ORDERS**
*Client records and bans, the three access doors (invite / request+approve /
direct add), share links in four kinds, the colour-down × size-across order sheet,
cart with real stock reservations, atomic submission, the buyer's note and the
wholesaler's fulfil note, order management, the public `/o/:token` handoff link.*

`js/views/{buyer,join,public-order,share-links-admin}.js`,
`js/data/{cart,orders,wholesaler-orders,clients,share-links,access-requests}.js`,
migrations 004–007, 056, 059, 060, 077, 086–089, 104–109, 127–129

- **~14,000 lines. ~160 manifest rows — the largest block in the product.**
- **Sold only with Shelf or Stock.** It is the connector, and pretending it stands
  alone would be a lie a customer discovers in week one.
- ⚠️ **Two open money defects live here** (manifest rows 465, 466): the same buyer
  can be charged two different prices depending which door they came through, and
  the store pricing dial is bounded by nothing. **Close these before raising the
  price of this module.**

### Desk 1 — **WAREHOUSE** *(building now)*
*A warehouse manager's own login, the order routed to them, a pick queue, the
fulfil note's first reader, scan-to-pick, packing confirmation.*

- **Alone:** no. Needs Orders.
- **Why it sells:** it removes the screenshot. Migration 088 wrote down that this
  is how the handoff happens today.
- **Design constraint that is also a selling point:** the warehouse desk never
  sees money. Not price, not subtotal, not cost. A picker does not need it, and a
  price on a pick sheet is a price on the warehouse floor.

### Desk 2 — **FINANCE** *(building now)*
*A finance manager's own login, what is owed and how old it is, margin and cost —
the one desk that sees them — receipts recorded against orders, and exports.*

- **Alone:** no. Needs Orders.
- **Hard constraint:** **no money is taken through this app** (`check_no_payment_path.mjs`,
  Hadi 24 Aug). Finance *records* what happened in the bank; it never *charges*.
  The distinction is gated, not merely intended.
- **Why it sells:** it is the only surface in the entire system that shows margin.

### Desk 3 — **FIELD** (the salesperson — already built, never packaged)
*`js/views/salesperson.js`, 331 lines: client coverage, visits, per-client price
overrides, order-taking on behalf of a shop.*

- **Already shipped and almost entirely ungated** (one manifest row). It is being
  given away inside the base product today. **This is revenue sitting on the floor.**

### **INSIGHT**
*Reorder points, dead-stock detection with age evidence, sell-through, GMROI,
valuation, the commercial and operational dashboards.*

- **Alone:** no. It is a function of history from both doors, which is exactly
  what makes it the stickiest thing here — its value compounds monthly and
  resets to zero if the customer leaves.

### **MARKETPLACE** — *and this one is not for sale*
*The wholesaler directory, cross-store search (Arabic-aware), the feed, Buy it
again / Popular now / More like this, person identity across stores, the published
ranking policy with hash-chained config history, the visibility mirror, first-party
labelling.*

- **~7,400 lines, ~170 manifest rows — 29% of the manifest — and worth $0 to a
  single wholesaler.**
- **Charging for it early would kill it.** A network priced per member at low
  density has the demand curve exactly backwards.
- **It is the moat, not the SKU.** Give it away; monetise the *scarcity inside it*
  (promoted placement, capped at three, commission already implemented and
  server-side only).

### **CONNECT** (integrations)
*Shopify, WooCommerce and WhatsApp webhooks, OAuth, dispatch.*

- One manifest row, ungated, and the screen is honest that OGGI has not registered
  the developer apps yet. **Do not price this until it works.**

---

## The pricing

### Three structural facts that constrain any answer

**1. Per-seat pricing is actively wrong for this product.**
The entire point of the two new desks is to give the warehouse manager and the
accountant *their own login*. Per-seat pricing taxes exactly the behaviour the
product exists to cause — Brandboom charges $99–179 **per user per month**, which
is precisely why brands there ration logins and share passwords.

Price **per store, flat, unlimited seats.** The schema already does this: migration
037 stores one `price_amount` per `wid`. That was an accident and it is the right
one. **No schema change is needed to price this way.**

**2. There is no take-rate available.** No money moves through the app by explicit
decision. So revenue is subscription + promoted-placement commission. GMV pricing
is not on the table and should not be faked.

**3. The marketplace inverts the usual logic.** Normally you charge more for the
network. Here the network does not exist yet, so the cheapest way to make every
paid module more valuable is to **give the catalogue away** and get density.
A free Shelf tier is not a discount — it is marketplace inventory acquisition.

### What the market charges

| Product | Price | Model |
|---|---|---|
| **Brandboom** Startup / Business | **$99 / $179 per user per month** | per seat, free tier exists |
| **NuORDER** (Lightspeed) | **~$7,000/yr** entry, **+ ~$7,500** one-time implementation | annual contract, per-seat add-ons |
| **JOOR** | multi-thousand annual, per-seat add-ons | enterprise/luxury |
| **Faire** | commission on orders | marketplace take-rate |
| **LINESHEET** | free to start, then **flat per brand**, 0% on direct orders | month-to-month |
| Wholesale inventory SaaS (general) | **$199–$999/mo** flat, unlimited staff | flat-rate is the norm here |

Functionally OGGI sits where NuORDER crossed with an inventory system sits —
$10–20k/yr in the US. **It is not selling in the US.** The product's own evidence
says otherwise: Arabic search normalisation built in (four alef forms folded, teh
marbuta → heh), WhatsApp as the assumed handoff channel, `$` as the schema
default, and Hadi collecting subscriptions by hand.

⚠️ **I could not find reliable published data on what Lebanese/MENA wholesale SMBs
actually pay for software.** The numbers below are anchored to the international
comparables above and to what the product replaces — **they need validating
against your existing 13 wholesalers before they go on a page.** The fastest
validation is not a survey: raise two existing customers to the new price at
renewal and watch.

### Recommended structure — per store, per month, unlimited seats

| | Module | Monthly | Why this number |
|---|---|---|---|
| 🚪 | **Shelf — Free** | **$0** | Up to 50 products, marketplace listing, one share link. This tier's job is density, not revenue. |
| 🚪 | **Shelf** | **$49** | Unlimited products, all four selling models, billboards, custom shelves, unlimited share links, AI catalogue import. |
| 🚪 | **Stock** | **$49** | Multi-location, transfers, ledger, receiving, barcodes, suppliers, kits. |
| 🔗 | **Orders** | **$79** | Requires Shelf or Stock. The three access doors, the order sheet, reservations, the handoff link. Priced highest of the components because it is where the work actually happens. |
| 🖥 | **Warehouse desk** | **$39** | Requires Orders. |
| 🖥 | **Finance desk** | **$39** | Requires Orders. |
| 🖥 | **Field desk** | **$39** | Requires Orders. Already built — this is revenue currently being given away. |
| 📊 | **Insight** | **$49** | Requires Orders + Stock. |
| 🌐 | **Marketplace** | **free, always** | The moat. Monetised by promoted placement, not by subscription. |
| **=** | **Everything** | **$199** | vs **$343** à la carte — **42% off**. |

**The à la carte column exists to make the bundle obviously correct.** Expect
almost everyone to buy Everything; the modules are there so a customer who only
wants stock can start, and so the sales conversation has somewhere to go.

**Annual: pay for 10, get 12.** Migration 037 already stacks extensions in months,
so annual billing needs **no code at all** — `v2_extend_subscription(wid, 12, amount)`.

### The second revenue line
**Promoted placement.** Already built (migration 093): capped at **three** slots,
never touches organic ranking, labelled *"Featured by OGGI — we earn a commission
on these"*, and `commission_pct` never leaves the server. Turn it on when the
directory has enough sellers that a slot is scarce — **not before**, because a
promoted slot in a marketplace of twelve is not a product, it is an admission.

### The one honest one-time fee
**Catalogue onboarding — $250.** Loading a wholesaler's catalogue is the
highest-touch moment in the relationship and the AI/CSV import already exists to
make it fast. Charging for it filters out the tyre-kickers and pays for the hour.
Everything else should be subscription.

---

## ⚠️ What modularising actually costs in code

Today there is **no plan or module concept anywhere in the schema.** Migration 037
stores `price_amount`, `price_currency`, `billing_period` — one price per store,
and nothing that says what they bought.

To sell modules you need three things:

1. `v2_wholesaler_modules` — `(wid, module, active_from, active_until)`
2. `v2_has_module(wid, module)` — one SECURITY DEFINER function
3. **Every gated RPC calls it.** Not the nav. **The nav.**

> ### 🛑 The trap, and this repo has already fallen into it twice
>
> **Hiding a nav entry is not an entitlement.** `js/lib/router.js` has *no role
> awareness whatsoever* — any signed-in user can type `#/owner` and the view
> renders. The only thing that stops them is the database refusing. That is the
> correct design, and it means a module gated in the browser is **not sold, it is
> suggested**.
>
> The repo's own history: the `/c/:token` route was registered and unreachable for
> three weeks because two halves were each individually correct; `anon` held
> grants on tables whose policies looked perfect (migration 085). **An entitlement
> that lives only in `nav-config.js` is the same bug with an invoice attached.**

### My recommendation on sequencing: **do not build this yet**

With 13 wholesalers, Hadi sets one price per store by hand and the schema already
supports it. Module gating is roughly **2–3 days of careful work plus a gate that
proves a switched-off module is switched off *on the server***.

**Build it when a real customer asks to buy only part of the product.** Until
then, the module map above is a *pricing page and a roadmap* — worth having,
worth publishing, and not worth a migration.

The one exception: **package the Field desk now.** It is finished, it is being
given away, and putting it on the price list costs nothing.

---

## Summary

- **Two doors, not eight modules.** Shelf and Stock are the only things that stand
  alone. Say so on the page; it converts better than a false menu.
- **Price per store, flat, unlimited seats.** Per-seat pricing would tax the exact
  behaviour the two new desks exist to create.
- **$199/mo for everything**, $49 doors, $39 desks, annual = 10 months.
- **The marketplace stays free forever.** It is worth zero at N=1 and it is the
  moat at N=100. Monetise scarcity inside it, not access to it.
- **Two desks are already half-built in the schema and have never had a reader** —
  `fulfil_note` since 28 August, and migration 088 names the warehouse and the
  accountant by name as people the product cannot currently serve.
- **Close manifest rows 465 and 466 before raising the price of Orders.** Two
  prices for one buyer is a refund conversation, not a feature.
- **Don't build module entitlements until someone tries to buy one module.**

