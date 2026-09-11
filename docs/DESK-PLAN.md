# Block 7 — THE TWO DESKS

**Hadi, 11 September 2026:**

> "You're gonna be building a new view, which is the warehouse manager view.
> Because now any order that comes in, the owner could automatically send it to
> the warehouse manager. And another one for the accountant or the finance
> manager as well."

---

## ⭐ THIS IS NOT A NEW IDEA. IT IS THE MISSING HALF OF SOMETHING ALREADY BUILT.

Two things already in the repo say so in their own words.

**Migration `087_v2_fulfil_note_wholesaler_track.sql`, 28 August**, created a column
for *"the wholesaler's instruction to their own warehouse"* — quoting Hadi asking
for it. **That column has never had a reader.** It has been written for two weeks
into a screen nobody can open, because there is no warehouse account in this
system.

**Migration `088_v2_order_handoff_token.sql`** opens by naming, precisely, the two
people this block is for:

> *"There is no way to hand the order to anyone who is not signed in to this app:
> the **warehouse**, who need a picking sheet on paper; the driver…; **an
> accountant**, who wants a PDF. Today that handoff happens by screenshot."*

088 solved that with an unguessable link you send on WhatsApp. That was the right
answer for *a person who does not work here*. It is the wrong answer for a person
who does — a link has no queue, no accountability, no "I've got it", and no way to
hand the order back when the blue is short.

**So: 088 stays exactly as it is, for drivers and outsiders. This block is for
staff.**

---

## THE CENTRAL DECISION — where these two people live

There are two identity systems today and **neither one can hold a warehouse
manager.** This is the decision the whole block rests on.

### ❌ Option A — `v2_user_profiles` (real Supabase Auth; owner | wholesaler)

Widen `022:31`'s `check (role in ('owner','wholesaler'))` and give them a `wid`.

**Rejected, and not narrowly.** `v2_my_wid()` (`022:215-221`) is the sole tenant
predicate at **201 policy and function sites across 61 migrations**, and it
carries **no role information at all**. Every one of those sites asks *"are you the
platform owner, or are you staff of this wid?"* — nothing more.

> A warehouse manager added here would be **indistinguishable from the owner of
> the business** at all 201 sites. They could change prices, delete products, read
> cost, ban clients, issue share links. Not by a bug — by design, immediately,
> everywhere.

### ❌ Option B — `v2_portal_accounts` (buyer | sales, the salesperson's tier)

Widen `022:84` and reuse the salesperson pattern.

**Rejected on a privacy ground that is easy to miss.** `check_person_identity.sql:135`
is a **live gate**: every `v2_portal_accounts` row must have a `person_id`. So a
warehouse account would be forced to become a **marketplace person** — and
`v2_person_channels` carries `unique (kind, normalised)`, which migration 090 calls
*"THE join key of the whole marketplace."*

> A warehouse manager at one store who also owns a shop buying from another store
> would have their **staff login and their buyer account collapsed into one
> human** on their phone number. Migration 090's own invariant is *"normalisation
> may split a person. It must never merge two."* Putting staff into that channel
> space is an invitation to break it.

A picker is not *"one human shopping at many stores."* That is the entire meaning
of `v2_people`, and it is the opposite of what a warehouse manager is.

### ✅ Option C — a third tier: `v2_staff_accounts`

**Store staff. One store. No marketplace person. No wholesaler power.**

| Property | Consequence |
|---|---|
| Its own table | `check_person_identity.sql` and the nine-table share-link census stay green, untouched |
| Runs as PostgREST `anon` | **deny by default** — every read and every write must be an explicit `SECURITY DEFINER` RPC |
| No `person_id`, no channel | a staff phone number never becomes a marketplace join key |
| `v2_my_wid()` returns NULL for them | they inherit nothing from the 201 sites |
| A `desk` column, not a `role` column | warehouse ≠ finance is expressible, and each desk gets its own column allowlist |

The cost is honest and is the point: **one RPC per thing a desk may do.** That is
the salesperson precedent (`048:132`) applied deliberately rather than reluctantly.

---

## ⭐⭐ THE TWO COLUMN WALLS

Neither desk is "the wholesaler's order screen with things hidden". Each is its
own function with its own explicit column list. Hiding is a CSS decision; a column
list is a fact.

### The warehouse desk **never sees money**

| Sees | Never sees |
|---|---|
| order reference, buyer name, date | `unit_price` |
| product, SKU, colour, size, qty | `line_total` |
| the pack, **and** the pack exploded into pickable pieces | `subtotal` |
| `buyer_note` — *"send the darker blue"* | `cost`, margin |
| **`fulfil_note` — its first ever reader** | the client's contact details |
| location / bin, pick progress | anything belonging to another store |

**Why, stated once:** a picker does not need a price to pick, and a price on a pick
sheet is a price on the warehouse floor — readable by everyone who walks past a
tablet left unlocked on a bench. The fewer columns the function returns, the
smaller that is.

This is asserted **twice**: in SQL (the function's return table has no money
column) and in the rendered DOM (no currency symbol reaches the screen).

### The finance desk **never sees the floor**

| Sees | Never sees |
|---|---|
| order, client record, date, status | stock locations and bins |
| line prices, discounts applied, subtotal | pick progress |
| **cost and margin — the only desk that does** | **`fulfil_note`** |
| what is owed, and how old it is | anything belonging to another store |
| receipts recorded against an order | |

**Why `fulfil_note` is excluded, specifically:** it is an instruction written by
one department *to another department*. Migration 087 exists because a merchant's
internal picker note was found printed on a customer-facing shipping label, for
the single reason that two surfaces read one field. `buyer_note` — the customer's
own words — **does** reach finance, because finance talks to the customer. Two
authors, two audiences, two columns. The rule does not stop at the buyer.

### 🛑 And finance **records money; it never takes it**

`check_no_payment_path.mjs` records Hadi's decision of 24 August: *"No money will
be paid through this app at the moment."*

A finance desk that logs *"the customer paid $4,200 by bank transfer on the 9th"*
is a **ledger entry about something that already happened elsewhere** — the same
category as the "payment terms" memo on a supplier record, which that gate
explicitly allows. It is not a payment path and must never grow into one.

The line is drawn mechanically: **no processor, no card field, no charge, and no
control anywhere that a *buyer* could reach.** A new gate asserts it.

---

## THE ROUTING

### Two state machines, deliberately not one

```
ORDER STATUS      new ──▶ confirmed ──▶ shipped ──▶ delivered      ← what the BUYER is told
DESK STATE        sent ──▶ accepted ──▶ done                       ← internal work
                      └──▶ returned (with a reason)
```

**They must never be merged.** The order status is a statement to the customer.
The desk state is a fact about internal work. One state machine would mean the
buyer's status changes because a picker tapped something — the `buyer_note` /
`fulfil_note` mistake again, in a different column. A gate asserts that no desk
action writes `v2_orders.status`.

### "Returned" is required, and it needs a reason

The warehouse must be able to hand an order **back** — *"we are four short on the
blue."* A one-way conveyor is how orders get stuck in a building. A return with no
reason is the dead end PB-01 was built to remove, so `return_reason` is
`not null` when state is `returned`, enforced by a table constraint.

### "Automatically" — the standing rule

`v2_order_desk_routing` per store: for each desk, `auto_send_on` ∈
`{'never','on_new','on_confirmed'}`. A trigger creates the assignment.

> ⚠️ **The trigger must never be able to fail an order submission.** An order
> arriving is the customer's act; routing it is ours. If routing raises, the sale
> is lost for a reason the customer cannot see and cannot fix. The trigger is
> therefore written to swallow its own failure and record it, and a gate proves
> that a deliberately broken routing rule still lets the order through.

---

## THE FEATURES

### Schema

| # | Migration | What |
|---|---|---|
| 132 | `132_the_third_tier.sql` | `v2_staff_accounts` — wid, desk, username, bcrypt password, active, actor_label. Partial unique username per store. RLS scoped to owner-or-own-wid. **No grant to anon.** Self-test proves a staff row cannot reach `v2_my_wid()`. |
| 133 | `133_a_desk_signs_in.sql` | `v2_staff_login(wid, username, password)` — bcrypt, throttled through the existing `v2_rate_limit_hits`, returns a session row. `v2_staff_session(staff_id)` re-validates on every call. Granted to `anon` (it is a login), everything else revoked. |
| 134 | `134_an_order_reaches_a_desk.sql` | `v2_order_desk_assignments` + `v2_order_desk_routing` + the defensive auto-route trigger. Unique `(order_id, desk)`. `return_reason` required on return. |
| 135 | `135_the_warehouse_never_sees_money.sql` | `v2_warehouse_queue(staff_id)` and `v2_warehouse_order(staff_id, order_id)` — explicit column lists with **no money column at all**. Self-test asserts the return table contains no numeric price column by name. |
| 136 | `136_money_that_already_moved.sql` | `v2_money_received` — amount, currency, method (`cash`/`bank`/`cheque`/`card_offline`/`other`), received_on, reference, note, one author. A record, not a charge. **Built before 137, not after: the finance reads select from it, and a migration cannot reference a table a later one creates.** Named `v2_money_received` rather than `v2_order_receipts` because `v2_receipt_costs` (121) already means the landed cost of goods received into a warehouse — one word, one meaning, or a new word. |
| 137 | `137_the_finance_desk.sql` | `v2_finance_queue(staff_id)`, `v2_finance_order(...)`, `v2_finance_order_head(...)`, `v2_finance_aging(...)` — money, cost, margin; **no bin, no pick, no fulfil_note**. |
| 138 | `138_a_desk_does_its_work.sql` | `v2_desk_accept`, `v2_desk_complete`, `v2_desk_return(reason)`, `v2_desk_set_fulfil_note` — each takes `p_staff_id`, re-checks desk/active/wid, and **none of them writes `v2_orders.status`**. |

### Client

| File | What |
|---|---|
| `js/data/staff-auth.js` | staff login, session persistence, sign-out |
| `js/data/desk.js` | the shared desk data layer — queue, order, accept/complete/return |
| `js/data/receipts.js` | recording and listing receipts |
| `js/views/warehouse.js` | **NEW.** Queue → order → pick. Packs shown as packs *and* exploded. The fulfil note, finally readable. Hand-back with a reason. |
| `js/views/finance.js` | **NEW.** What's owed, aging buckets, order detail with margin, receipts. |
| `js/lib/dev-auth.js` | `ROLES` + session resolution + the sign-out branch |
| `js/lib/nav-config.js` | `NAV_BY_ROLE.warehouse`, `NAV_BY_ROLE.finance`, two `ROLE_LABEL` entries |
| `js/app.js` | `homeByRole`, route registration |
| `js/views/login.js`, `js/lib/login-doors.js` | a staff door — `#/login/warehouse`, `#/login/finance` |
| `js/views/wholesaler.js` | **"Send to…"** on the order detail screen; staff accounts and routing rules inside the existing Team screen |

> **The wholesaler sidebar stays at exactly nine entries.** `check_inventory_module.mjs:86`
> asserts it and `nav-config.js:31-44` records that it is Hadi's own cap. Staff
> management and routing rules therefore live **inside** Team, and "Send to…" lives
> on the order itself. Nothing new goes in that sidebar.

### Gates — every one proven red before it is believed

| Gate | Proves |
|---|---|
| `check_the_third_tier.sql` | staff hold no table grant; `anon` gains nothing; a staff row cannot reach wholesaler power; a staff account is not a marketplace person |
| `check_warehouse_sees_no_money.mjs` | ⭐ the money wall, in the SQL signature **and** in the rendered DOM |
| `check_warehouse_sees_no_money.sql` | the return tables carry no price/cost/subtotal column, by name |
| `check_finance_sees_no_floor.sql` | no bin, no pick progress, no `fulfil_note` reaches finance |
| `check_finance_records_not_charges.mjs` | no processor, no card field, no control a buyer could reach |
| `check_desk_routing.sql` | one desk per order; return requires a reason; auto-routing is idempotent; **a broken rule still lets the order through** |
| `check_two_state_machines.sql` | no desk function writes `v2_orders.status` |
| `check_desk_tenant_isolation.sql` | a desk at store A sees nothing of store B, on every function |
| updated `check_nav_completeness.mjs` | its hard-coded `(owner\|wholesaler\|sales\|buyer)` route regex learns the two new prefixes — **otherwise it silently stops checking them** |
| updated `check_post_login_landing.mjs` | the two new view modules and home routes join its list |

---

## Order of work

1. **132 + 133** — the tier and its door. Nothing is useful until someone can sign in.
2. **134** — routing and the two state machines.
3. **135 + the warehouse view** — the money wall first, because it is the claim.
4. **138** — the desk's write actions.
5. **136 + 137 + the finance view.** *(Built in that order; the plan originally had them the other way round and a migration cannot select from a table a later migration creates.)*
6. **The wholesaler's side** — "Send to…", staff management, routing rules.
7. **Manifest, gate evidence, push, PR.**

## Open, and assumed rather than blocked

- **D-15 — "the owner" means the person who runs the store.** Hadi said *"the
  owner could automatically send it."* In this system `owner` is the OGGI platform
  role; the person who receives an order is the `wholesaler`. Built store-scoped,
  which is correct under both readings — OGGI's own store is a wholesaler row like
  any other, so OGGI's warehouse works the same way.
- **D-16 — one desk per person.** A staff account has one desk. Someone who is both
  warehouse and finance gets two logins. Revisit if that is annoying in practice;
  a `desk` array is a bigger change than it looks because every column wall
  becomes conditional.
- **D-17 — no driver desk yet.** 088's link already serves the driver and needs no
  account. Adding a third desk later is now cheap.

---

## ⚠️ What actually happened, recorded against the plan

The plan above survived contact almost intact. Three things were not in it:

1. **136 and 137 swapped.** The finance reads select from `v2_money_received`, and
   a migration cannot reference a table a later one creates. Corrected above.

2. **A ninth migration, `139`,** which is not a feature at all. Migration 137's
   self-test asserted that `cost` was granted to no browser role, passed on a
   clean replay, and **production refused it**. The refusal was right and what it
   found was this: migration 031 revoked `select (cost)` from `authenticated` on
   17 August and offered `v2_my_variant_costs()` instead — and the app never
   moved to it. `js/data/products-admin.js` still reads and writes `cost` on the
   table. Somebody re-granted it on production so the product editor kept
   working, and wrote no migration.

   So `replay_migrations.sh` has been proving *"this repo can rebuild the
   product"* while a rebuild would have produced a product editor that could not
   read or write a buying price. 139 restores the grant and asserts **both**
   halves: `authenticated` must hold it, `anon` must not.

3. **Two defects in this block's own gates**, both found by sabotage rather than
   by reading: the money-wall gate read the wrong half of an `import` statement,
   and it cried wolf on `line-height:1.45`. Recorded in
   `checks/GATE-EVIDENCE.md`.

## D-15 answered by building it

"The owner could automatically send it" — built **store-scoped**, so the person
who receives an order (`role = 'wholesaler'`) is the one who sends it. That is
correct under both readings of the sentence: OGGI's own store is a wholesaler row
like any other, so OGGI's warehouse works exactly the same way.
