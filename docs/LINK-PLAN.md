# Block 3 — LINK. The one door.

**Written 7 September 2026, from Hadi's specification, after reading every line of
the code it touches and measuring the corpus it will run against. No code has
been written yet. This is the plan he asked for before any is.**

---

## What Hadi asked for, in his words

> "When they create a share link, they're gonna put in that person's phone
> number. They're gonna put in their name, but basically we're just gonna look
> for their phone number to make sure that this is the same person, and they're
> gonna set a discount for that link. And this is a one time use link. So we
> have to make a link multiple times.
>
> And give them the function, the ability to decide. Is this a one time link for
> one person, or this is like an unlimited use link, or is this link but the
> approval is needed? Or if it's auto approval with, like, a certain number of
> link users? Like, let's say they set it at five and six people click on the
> link, only the first five that complete the sign in actually get the auto
> access. If the sixth person logs in, they just log into the marketplace
> itself, and they send a request for access for that wholesaler instead.
>
> But either way, they get access and they are logged in. **They are signed up
> to the marketplace itself.**"

And on the discounted invite, earlier in the same message:

> "First of all, yes, they have to have their phone number added, obviously, a
> hundred percent. They're gonna go through the questionnaire anyway."

---

## The two things the research changed

### 1. The last sentence is the biggest feature in the block, and it does not exist

*"They are signed up to the marketplace itself."*

Today **there is no marketplace sign-up at all.** Not a hard one, not a broken
one — none. `docs/OUTSTANDING.md` §9.2 says it plainly and production confirms
it: all 7 people on the platform were created by `v2_backfill_person_identity`,
a one-off utility that maps *pre-existing* logins to humans. Nothing in the
running app has ever created a person.

Worse, the two paths that look like sign-up both mint a **dead end**:

| path | what it creates | `person_id` |
|---|---|---|
| `v2_redeem_buyer_invite` (089:243-250) | `v2_clients` + `v2_portal_accounts` | **NULL** |
| `v2_approve_signup_request`, anonymous branch (107:171-179) | `v2_clients` + `v2_portal_accounts` | **NULL** |

An account with no `person_id` can never reach the directory, can never switch
stores, can never search across stores, and `v2_set_marketplace_password`
refuses to upgrade it (096:432). It is a login to one shop, for ever.

So **LINK-00 comes before everything else**: a person, a phone channel and a
marketplace credential are created on *every* way in. Without it the rest of
this block builds a nicer front door onto the same dead end.

### 2. Hadi has now answered the three questions §9.2 said were not guessable

`docs/OUTSTANDING.md` §9.2 closes with three decisions and says none of them can
be guessed. This message answers all three, and §9.3 (auto-approve rules,
recorded as **not buildable**) is unblocked by the answer:

| §9.2 asked | Hadi's answer |
|---|---|
| Should an approved applicant become a real OGGI buyer, or stay a store-scoped login? | **A real OGGI buyer.** "Either way, they get access and they are logged in. They are signed up to the marketplace itself." |
| Is a typed phone number enough to identify somebody? | **Yes, in this shape** — see below. |
| Should a shop self-register before launch? | Not answered, and not needed for this block. Every path here starts with a link a wholesaler made. **Open decision D-4.** |

**Why the phone is safe here, when §9.2 said it was not.** §9.2's objection was
correct and is not being waved away: *without an OTP anyone can claim any
number.* But that objection is about **self-asserted** identity — a stranger
typing a number nobody else knows. That is not what this block does. Here the
**wholesaler types the number first**, into a link they then send to that
number's owner. The person redeeming must produce a number that matches one
already written down by the other party. That is a shared secret between two
people, not a claim by one — the same shape as the 24-hex token itself, and
strictly stronger than the token alone, because it takes *both* the link and the
number.

That is also exactly why §9.3's AC-12 becomes buildable. The registry's proposed
auto-approve rules were rules on **applicant-supplied text** ("by area", "by
referral") — a rule on the typed location auto-admits anyone who types the right
city. Hadi's rule is not of that kind. It is *"the first five people who open the
link I personally sent"*: a cap on a secret the wholesaler controls and can
revoke. It admits no stranger who was not already sent the link.

**Where this reasoning stops.** A phone the *applicant* typed on a link that
carries no phone (`unlimited`, `capped`) is still unverified, and this plan never
treats it as proof of anything. It is used only to *find* an existing person, and
finding must never merge two people (the 090 invariant). ID-05, the one-time
code, remains unbuilt and remains the thing that would set `verified_at` — which
is null on every channel that exists.

---

## What already exists, and why neither piece does the job

Two link systems ship today. Neither is what he described, and they do not
compose.

### `v2_buyer_invites` (migration 089, + bulk in 109)

One-time, 30-day, per-store, `#/i/<24-hex>`. Carries `shop_name`, `phone`,
`note`. Redemption creates a client and a login.

Missing: **a person's name**, **a discount**, **a usage cap**, **a catalogue**,
**any link type at all** — and it creates the dead-end account above.

**Production has issued exactly ZERO invitations.** The table is empty. Nothing
has ever been redeemed. That single fact is what makes this block clean: the new
model can **replace** this one rather than sit beside it as a third parallel
door. (`v2_buyer_invites` is also missing an exception handler on the
`unique (wid, shop_name)` constraint, so a duplicate shop name raises raw
Postgres text at the buyer — recorded here so it is not inherited.)

### `v2_catalogs.share_token` (migration 056)

Unlimited, never expires, never counted, `#/c/<24-hex>`, `is_public` decides
whether a stranger sees it. Carries no identity whatsoever.

Missing: **everything about a person.** And it has three live defects the
research turned up, all of which this block has to walk past or fix:

1. `js/views/buyer.js:1019-1022` — the "Sign in" button on a private link sets
   `location.hash = "#/login"`, but `#/login` is **not a registered route** and
   only the router listens to `hashchange`. The person gets *"Page not found."*
2. `js/views/buyer.js:1020` — `sessionStorage["v2:after-login"]` is written and
   **read nowhere**. The promise to bring them back to the catalogue is not
   implemented.
3. **Guest ordering does not exist.** A stranger on a public link can add to
   cart and take real 15-minute stock reservations, but there is no order bar,
   no reachable cart (`cartView` dereferences `session.wid` on a null session
   and throws), and no name/phone capture. The wholesaler's own UI copy at
   `js/views/wholesaler.js:3797` promises *"They give a name and phone number
   when they order."* It is not built.

Defect 3 is the same hole this block fills from the other end. A stranger who
opens a link and wants to buy needs an identity; Hadi's answer is that they get
one. So LINK does not add guest checkout — **it removes the need for it.**

---

## The design

### One object: `v2_share_links`

A link is a row. It knows whose store it opens, which shelf it lands on, who it
was made for, what they are worth, how many times it may be used, and what
happens to the person who uses it.

```
wid                 text     not null   -- whose store
catalog_id          uuid     null       -- which shelf they land on; null = the whole store
kind                text     not null   -- 'one_time' | 'unlimited' | 'approval' | 'capped'
max_uses            integer  null       -- only for 'capped'; 1 is implied by 'one_time'
uses_count          integer  not null default 0
invitee_name        text     null       -- the person, as the wholesaler knows them
invitee_phone       text     null       -- what the wholesaler typed
invitee_phone_key   text     generated always as (v2_normalise_channel('phone', invitee_phone)) stored
discount_pct        numeric  null       -- THE CUSTOMER'S OWN RATE. See LINK-09.
token               text     not null unique
expires_at          timestamptz null
revoked_at / revoked_by / created_by / created_at / note
```

`invitee_phone_key` is `generated always … stored` on purpose — migration 108
argued the case and `v2_person_channels.normalised` is the counter-example where
a caller must remember, which is a bug waiting to happen. This table will not
repeat it.

### The four types, in one table

| kind | who may redeem | how many times | what a redemption grants |
|---|---|---|---|
| `one_time` | the holder of the link **whose phone matches** | 1 | immediate access |
| `unlimited` | anyone holding the link | ∞ | immediate access |
| `approval` | anyone holding the link | ∞ | a marketplace account + a request in the wholesaler's queue |
| `capped` | anyone holding the link | first `max_uses` | immediate access; **everyone after that falls to `approval`** |

`one_time` is the default, because it is what Hadi described first and it is the
safest. It is also the only kind for which the phone is a *gate*; on the other
three a typed phone is only used to *find* an existing person.

### The rule that never bends

> **Nobody who opens a real link is ever turned away from OGGI.**

Whatever the kind, whatever the cap, whether the phone matched or not — the
person finishes with a marketplace account they can log into. The only thing
that varies is whether they walk into *that wholesaler's store* today or wait for
an approval. That is Hadi's *"but either way, they get access and they are
logged in"*, and it is the single sentence the whole block is arranged around.

---

## The features

### LINK-00 — A person is created on every way in ⭐ the keystone

`v2_ensure_person(p_phone, p_name, p_email)` — find-or-create, returning
`person_id`. Finds through `v2_person_channels.normalised` (the existing unique
`(kind, normalised)` index), creates when there is no match, and **never merges
two people** (the 090 invariant, which the gate will state as an assertion, not
a comment).

Then a marketplace credential (`v2_person_credentials`) and a session
(`v2_buyer_sessions`) so they are *logged in*, not merely *registered*.

Also fixes the two existing dead ends in the same breath, because leaving them
minting `person_id IS NULL` accounts alongside a door that does it right is how
a platform ends up with two classes of buyer nobody can explain:
- `v2_redeem_buyer_invite`
- `v2_approve_signup_request`, the anonymous branch

**Blast radius to measure before touching:** 1 portal account on production has
`person_id IS NULL`.

### LINK-01 — The table, and the token

`v2_share_links` as above. Token by the house recipe —
`encode(extensions.gen_random_bytes(12),'hex')`, 96 bits, unique index — because
three separate places already use it and a fourth spelling is a fourth thing to
audit. **Not** generated in the browser: `rotateCatalogLink` does that today
(`js/data/catalogs.js:243-253`) and it is the one entropy source in the codebase
that is not the database.

Route `#/j/<token>` — `j` for *join*, deliberately not `c` (a catalogue link) or
`i` (a v2_buyer_invites link), so the three cannot be confused in a log, in a
support conversation, or by `isPublicPath`.

### LINK-02 — Creating a link: the wholesaler's form

Fields: **their name**, **their phone**, **discount %**, **link type**, and for
`capped` a **number**. Optional: which catalogue it lands on, an expiry, a
private note.

Lives beside the existing invite card on `#/wholesaler/clients`, and **replaces**
it (LINK-12). The form must make the four types legible in one sentence each —
this is a screen a person uses in a hurry, and a wrong type here is either a
leaked price list or a customer who cannot get in.

Copy + WhatsApp, both. The catalogue share link is copy-only today while invites,
order handoffs and the public order sheet all have WhatsApp buttons; there is no
reason for the difference and every reason for the button on the one link that
is sent to a named person's phone.

### LINK-03 — The four types, enforced in the database

Not on the screen. A disabled button is a UI state, not a rule — the lesson
migration 121 already wrote down. `v2_redeem_share_link` decides.

Constraints that make an impossible link impossible to store:
`max_uses` is required by `capped` and forbidden on the others; `one_time`
requires a phone (there is no "one person" without a person); `discount_pct`
takes the same −100…100 bound migration 123 just gave the dial and the customer
rate, for the same reason.

### LINK-04 — The phone is the match

On a `one_time` link, redemption compares
`v2_normalise_channel('phone', typed)` against the stored `invitee_phone_key`.

- **Match** → straight in.
- **No match** → they still get a marketplace account, and an access request
  goes to the wholesaler naming both numbers, so the wholesaler can see at a
  glance that the right person typed a second SIM — or that the wrong person
  has the link.

The normaliser is Lebanese-defaulting (`961`), strips `+`, `00` and every
separator, and returns NULL under 7 digits. **Measured on the corpus:** all 59
client phones normalise to a real key, 58 distinct, **none collide inside a
single wholesaler**, and exactly one number spans two wholesalers — which is the
"one human, two stores" case the marketplace exists for. The key works on the
data we actually have.

### LINK-05 — Opening a link: the stranger's screen

One screen, four states, no dead ends:

| state | what they see |
|---|---|
| valid | *"&lt;Wholesaler&gt; invited you"* + the sign-up form |
| used up (`one_time` already redeemed, or `capped` full) | the form still, with *"you'll join OGGI and ask &lt;Wholesaler&gt; for access"* — **never a wall** |
| revoked / expired | one honest sentence and a way to reach the wholesaler |
| not found | indistinguishable from revoked, per the 056 rule |

And the return path actually works — LINK-05 fixes the `#/login` dead end and
makes `v2:after-login` a real thing rather than a key nothing reads.

### LINK-06 — Redemption: one transaction

`v2_redeem_share_link(p_token, p_phone, p_name, p_password, p_answers jsonb)`
returns the marketplace session **and** what happened to the store access.

`select … for update` on the link row first — the cap and the one-time flag are
both decided under that lock, or two people clicking at once both get in.
`v2_redeem_buyer_invite` already establishes this pattern; this follows it.

In one transaction, in this order:
1. the person, the channel, the credential, the session (LINK-00)
2. **if access is granted:** the client row (carrying the discount), the portal
   account (carrying `person_id`), the membership
3. **if not:** the access request, stamped with the person and the link
4. `uses_count = uses_count + 1`

Two rows that must exist and do not today: `v2_clients` must be created with
`on conflict` handling for `unique (wid, shop_name)` — both existing redemption
paths raise raw Postgres text at the buyer on a duplicate shop name.

### LINK-07 — The cap counts completions, not clicks

Hadi was precise: *"only the first five that complete the sign in actually get
the auto access."* `uses_count` increments at the end of a successful
transaction, under the lock taken in LINK-06. Six people may open the link; the
sixth to *finish* is the one who falls through.

### LINK-08 — The overflow lands somewhere real

The person who arrives after the cap, or whose phone did not match, gets:
- a marketplace account and a session — they are **logged in**, on the
  marketplace, seeing the directory;
- an access request in that wholesaler's existing queue, carrying `person_id`
  (so approval takes the *good* branch of `v2_approve_signup_request` — the one
  that writes a membership, which migration 107 exists to guarantee), the phone
  they typed, and the link they came through;
- a screen that says which of those two things happened and what comes next.

This reuses `v2_signup_requests`, `v2_access_reapply_standing` and
`v2_approve_signup_request` unchanged. It adds one column: which link the
request came from, so the wholesaler reviewing it can see *"came through the
link you sent to Rita, 03 456 789"* instead of a name and a shrug.

### LINK-09 — The discount a link carries ⚠ read this against migration 122

Migration 122 landed **today** and its rule is: *the door a buyer came through
must not decide what they pay.* A link carrying a discount looks, at a glance,
like exactly the thing that was just removed.

It is not, and the difference is the whole design.

- What 122 removed was a **shelf rate**: a discount that lived on a catalogue
  and applied *whenever a buyer arrived through it*. The same buyer had two
  prices at the same moment — 108.80 on the store screen, 96.00 on a link. That
  is a door deciding a price.
- What a link carries here is **that customer's own rate**, set at the moment
  the wholesaler invites them. At redemption it is written once onto
  `v2_clients.discount_pct` and **the link's copy is never read for pricing
  again**. After redemption there is exactly one rate for that buyer, through
  every door, for ever.

The link is an onboarding form that happens to include the discount field the
wholesaler would otherwise have typed into the client record five minutes later.
It is not a second pricing dimension.

**This is enforced, not promised.** LINK-09's gate submits an order through the
link's catalogue and through the store screen after redemption and requires the
same unit price — the same property `check_one_price_per_buyer.sql` asserts, now
asserted again on a buyer who arrived through a discounted link. If a future
change makes the link price anything, that file goes red.

**Open decision D-2:** what happens when a wholesaler sends a *second* link, with
a different discount, to a phone that is already their client. Overwrite the
rate, ignore it, or refuse the link? Assumption until Hadi says otherwise:
**refuse at creation time**, with *"Rita is already your customer — change her
discount on her client record."* Silently overwriting a negotiated rate from a
link somebody forgot they sent is the kind of thing nobody finds for months.

### LINK-10 — The questionnaire

*"They're gonna go through the questionnaire anyway."*

The six required client fields already exist and are already refused server-side
by `v2_create_client` (060:175-189): shop name, owner name, phone, what they
sell, username, password. Redemption asks the same six, so a shop that arrives
through a link is as complete as one the wholesaler typed in by hand. The
optional sixteen stay optional and stay behind a fold.

⚠ `v2_wholesalers.client_fields` — the per-wholesaler switch for which optional
questions to ask — is **a shipped column with zero readers**. No defaults object,
no settings UI, no RPC projects it. Hadi's instruction when it was added was
*"just make it a toggle and they change it as they see fit. It's not up to us."*
Wiring it is a real feature and it is **not** in this block; it is named here so
it stops being invisible. **Open decision D-3.**

### LINK-11 — The link list

The wholesaler's screen: every link, who it was for, its kind, `3 of 5 used`,
its state, and one button each to copy, WhatsApp and revoke. Revoking is
`revoked_at`, never a delete — the audit trigger pattern 104 established, and
the same reason: a link that was sent and withdrawn is a thing that happened.

### LINK-12 — Retiring `v2_buyer_invites`

Zero rows on production, zero redemptions, ever. The invite card, the bulk
paste-a-list panel and `#/i/:token` all fold into LINK.

**This is a removal, so it needs Hadi's explicit approval and `ALLOW_DELETIONS=1`
naming what went.** It is *last* in the block, after LINK is proven, and the
bulk-invite paste box is genuinely useful — it should survive as *"make a link
for each of these"* rather than being dropped. `#/i/:token` keeps answering for
as long as a token could plausibly be in someone's WhatsApp, which — with zero
issued — is zero days, but the route costs nothing to leave alive.

**Open decision D-1.**

### LINK-13 — What a link may never do

Written as gate assertions, not as comments:

- A link **grants access to one store**. It never carries a price after
  redemption (LINK-09), never reveals another store's data, never survives
  revocation, never exceeds its cap under concurrency.
- A `one_time` link that has been used answers **identically** to a revoked one
  and to a made-up one — the 056 rule, so a token cannot be probed for whether
  it was ever real.
- The redemption RPC is `anon`-callable **by necessity** (the redeemer has no
  account yet) and therefore gets the full 124 treatment: it may create exactly
  the rows named in LINK-06 and nothing else, and it must not become a way to
  write stock, read another tenant, or enumerate people. The check that anon
  may not change stock (`check_anon_cannot_write_stock.sql`) states its rule by
  *behaviour*, so a new anon-callable function that touched inventory would turn
  it red without anybody remembering to add it.
- Rate-limited on the existing `v2_rate_limit_check`, keyed per token, so a link
  cannot be brute-forced into telling you whether a phone number is a customer.

---

## Open decisions — for Hadi, not guessable

| # | Decision | What I will assume overnight if unanswered |
|---|---|---|
| **D-1** | Retire `v2_buyer_invites`, or keep both doors? | **Build LINK first, retire nothing.** A removal needs approval; LINK-12 stays unbuilt until he says so. |
| **D-2** | A second link, a different discount, to an existing customer's phone. | **Refuse at creation**, naming the existing customer. Never silently overwrite a negotiated rate. |
| **D-3** | Wire `client_fields` so each wholesaler picks their optional questions? | **Not in this block.** Named, not built. |
| **D-4** | May a shop that found OGGI on its own sign up with no link at all? | **No.** Every path in this block starts with a link a wholesaler made. The machinery LINK-00 builds would make it a small step later. |
| **D-5** | Should `capped` and `unlimited` links carry a discount at all? | **No — `discount_pct` only on `one_time`.** A rate is a thing you agree with one named person; a discount on a link that anyone may forward is a price list in the wild. |
| **D-6** | Does a link expire by default? | **Yes, 30 days**, matching the invite it replaces, wholesaler-settable, clamped 1–180. |

---

## Build order

Each step is a migration + a screen + a gate, red-proved, control-run against
`origin/main`, manifest row, evidence, PR. The same standard as tonight's batch.

1. **LINK-00** — the person on every way in. *Nothing else is worth building first;
   without it every door still ends in a dead-end account.*
2. **LINK-01** — the table, the token, the route.
3. **LINK-06 + LINK-03 + LINK-04** — redemption, the four types, the phone match.
   One migration, because the lock, the cap and the match are one decision.
4. **LINK-07 + LINK-08** — the cap and the overflow. The concurrency gate lives here.
5. **LINK-09** — the discount, and the gate that proves it did not undo 122.
6. **LINK-05 + LINK-10** — the stranger's screen and the questionnaire.
7. **LINK-02 + LINK-11** — the wholesaler's create form and link list.
8. **LINK-13** — the security gate, written across the whole block.
9. **LINK-12** — retiring the old invite. **Only on Hadi's word.**

---

## What this block does not do

- **No OTP.** No phone is verified by this block, and `verified_at` stays null.
  The safety comes from the wholesaler having written the number down first
  (see above), not from proof of possession. ID-05 remains open.
- **No guest checkout.** LINK removes the need for it rather than building it —
  but the copy at `js/views/wholesaler.js:3797` that promises it must be
  corrected, or the screen keeps lying.
- **No self-registration** (D-4).
- **No per-wholesaler questionnaire** (D-3).
