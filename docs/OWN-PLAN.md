# Block 6 — OGGI SELLS

**Hadi, 8 Sep 2026, answering the question that had been open since the marketplace was built:**

> "we do sell"

And, on the three decisions that follow from it:

- Own products appear **in ordinary results, labelled** — not in a separate shelf.
- The OGGI store is run by **separate staff who cannot reach the owner console**.
- It **appears in the buyer directory, marked as OGGI's own**.

---

## ⚠️ THE THING THAT MAKES THIS DIFFERENT FROM EVERY OTHER BLOCK

This is not a feature. It is a **change to a promise already made in writing to
every wholesaler on the platform**, and the page that carries it says so itself:

> a published ranking policy that has drifted from the code is not a stale
> document, it is a false statement made in writing to a supplier
> — `js/views/ranking-policy.js`, header

The page currently says, in bold:

> **OGGI does not sell any products on this platform.** There is no OGGI-owned
> brand here, and nothing in the system that could mark one.
>
> If that ever changes, it will not change quietly, and it will not change the
> answer above. Own-brand products would appear in their own labelled, capped
> shelf — the same treatment as paid placement — and **never inside the ordinary
> results. This page will say so before it happens, not afterwards.**
>
> **And your sales figures will not be used to decide it.**

Three of those four sentences are affected:

| The promise | What happens to it |
|---|---|
| "OGGI does not sell any products" | **Becomes false.** Must be rewritten. |
| "their own labelled, capped shelf… never inside the ordinary results" | **Deliberately broken.** Hadi chose ordinary results with a label. The page must say so plainly, not quietly drop the sentence. |
| "This page will say so **before** it happens" | **Kept — and this is the whole sequencing constraint below.** |
| "your sales figures will not be used to decide it" | **Kept, and made technically true for the first time** by the separate-staff wall. Today it is a promise with nothing behind it. |

### The state of the world, measured not assumed (8 Sep 2026)

Production carries **thirteen wholesalers and none of them is OGGI**:
`demo-meridian`, `demo-casasole`, `demo-atelier`, `demo-petitnord`, `demo-loom`,
`demo-vantage`, `test`, `demo`, `sq`, `mg`, `omni`, `w1785168930020`, `tesst`.

No OGGI store, no OGGI products, nothing marked. **So the page is TRUE today**,
there is no live false statement, and the "before, not afterwards" promise can
still be kept exactly as written. That is the one piece of luck here and the
plan is built around not wasting it.

### THE SEQUENCING CONSTRAINT, which is binding

```
   1. the page changes           ──►   2. a first-party store may exist
      (OWN-06)                          with public products (OWN-01..05)
```

Doing these in the other order breaks a written commitment. It is not enough to
intend the right order — **OWN-07 makes it mechanically impossible to get wrong**,
which is the only version of this that survives a busy week.

---

## The features

### OWN-01 — the mark

`is_first_party boolean not null default false` on `v2_wholesalers`, with a
partial unique index so **at most one store can ever be true**. Two first-party
stores is a labelling rule with an ambiguity in it.

The page's current wording — *"nothing in the system that could mark one"* — is
accurate today, and this is the line that stops being accurate.

### OWN-02 — the label, and why it carries the whole block

Because Hadi chose ordinary results, **the label is the entire protection.** In
the shelf design, placement did the work; here nothing does except the mark on
the card. A first-party product that renders without its label is OGGI competing
invisibly with its own suppliers — the exact arrangement the 28 Aug research
found most consistently penalised.

So:

- `is_first_party` is **returned by the feed** (`v2_marketplace_feed` already
  returns `is_promoted` and `slot`; this joins them), never computed in the browser
- asserted **on the rendered card**, not only on the query
- and there must be **no state of any buyer-facing surface** where a first-party
  product appears without it — feed, search, similar products, directory, store page

### OWN-03 — ⭐ the ranking must be blind to it

The integrity claim of the whole block, and it is stated **behaviourally** rather
than by reading the code:

> Set `is_first_party` on a store and the organic ordering of every product must
> be **byte-identical** to what it was before.

This is migration 093's assertion turned around. 093 proves that turning every
promotion off cannot change the organic order; this proves that turning
first-party *on* cannot either. A behavioural assertion survives a rewrite of the
ranking function; a code-reading assertion does not.

### OWN-04 — the wall

Separate staff, no owner console. Gate: **no person may hold both a membership in
the first-party store and owner access.** Asserted over the real tables, so it
goes red the day somebody is granted both, rather than the day somebody notices.

This is what turns *"your sales figures will not be used to decide it"* from a
sentence into a fact.

### OWN-05 — the directory, marked

OGGI appears in `v2_wholesaler_directory` like any other store, carrying the same
label. A buyer can find it and request access normally.

### OWN-06 — the page: the section REMOVED  ⚠️ CHANGED 8 Sep

**Hadi, after reading the draft: do not disclose this to the wholesalers at all.**

That is his decision about what the page ADDRESSES, and it is available to him.
What is not available is leaving the old paragraph standing: a page that declines
to answer a question has declined to answer it; a page that goes on asserting
*"OGGI does not sell any products on this platform"* while OGGI sells in the
ordinary results is a false statement in writing to the suppliers it was written
to reassure.

So section 4 is **deleted**. Nothing replaces it. The page no longer raises the
question in either direction — which is what "do not disclose" can honestly mean
here, and is the most it can mean.

⚠️ **One claim elsewhere on the page survives and is now load-bearing**: section
7's *"your sales data is never used against you."* It stays true only because of
OWN-04's wall. Remove the wall and that sentence is the next false claim.

<details><summary>The original plan for this section (superseded)</summary>

Rewrite section 4 to say plainly that OGGI sells, where its products appear, that
they carry a label, that ranking is blind, and what changed and when.
</details>

> ⚠️ **Removed 9 Sep 2026.** Six bullet points describing the rewritten section
> were still sitting here, below the `<details>` that says the rewrite was
> superseded — so this document asserted, three paragraphs apart, both that
> section 4 was deleted and that it now says six specific things.
>
> That is the same defect the page itself was fixed for, in the document that
> records the fix. A plan that contradicts itself is not a plan; the reader has
> to guess which half is current, and half of them will guess wrong.
>
> What actually happened: `check_ranking_policy.mjs` asserts the **absence** of
> the old claim rather than the presence of a new one — the matched-pair rule,
> inverted rather than deleted.

### OWN-07 — ⭐ the sequence gate

The promise is about **order**, so the gate is about order:

> A store may not be marked first-party **and** hold public products while the
> ranking policy page still tells wholesalers that OGGI does not sell.

Red in either direction. Written to tolerate `is_first_party` not existing yet, so
it is meaningful from the moment it lands rather than only after OWN-01.

This is what makes the written promise self-enforcing instead of remembered.

---

## Order of work

1. ✅ **OWN-06 + OWN-07 + OWN-01** — the section removed, the contradiction gate, the mark (nobody marked).
2. ✅ **OWN-03** — the blindness gate, across all three ordering surfaces.
3. ✅ **OWN-02** — the label, server-sourced, through the data layer and both renderers.
4. ✅ **OWN-04** — the wall, asserted on the email.
5. ✅ **OWN-05** — the mark on every surface where a buyer sees OGGI beside somebody else.

   Scoped as "the directory badge" and finished wider, because a census of
   `js/data` on 9 Sep found the flag was set on **two** surfaces and needed on
   **seven**. "Buy it again", "Popular now" and "More like this" all render
   through `renderProductRail`, **which already drew the badge** — and no mapper
   ever set the flag for it to draw. Cross-store search, the directory and the
   directory's own "Your requests" list were unmarked too.

   Every one of those files was individually correct. That is the `/c/:token`
   failure for the third time in this repo, so the fix is not six edits: the
   badge is now ONE rendered helper (`js/components/first-party-badge.js`), and
   `check_oggi_label.mjs` no longer holds a list of surfaces — it takes a census
   of `js/data` and applies the rule below, with anything it cannot classify
   counted RED. A rail added next month is covered on the day it is written, by
   somebody not thinking about first-party labelling at all.

6. ⬜ Only then: create the OGGI store and mark it.

---

## The rule, stated once

> **Wherever a buyer sees OGGI's store ALONGSIDE other stores, it is marked.**

Ranked product lists, the directory, the requests list. **Not** marked on a
single-store page the buyer walked into deliberately — a share link, an
invitation, an order they have just placed — because there is no comparison
there and no doubt whose shop they are in.

Modules that carry a store identity and do not label are listed in `EXEMPT` in
`checks/check_oggi_label.mjs`, each with its reason written out. The one real
judgement call is the **store switcher**: chips for stores this buyer has
already joined, each met and marked in the directory first, and whose own label
is rewritten to "Opening…" and back while entering a store — so a child badge
there would be destroyed and restored wrong. Worth revisiting the day the
switcher stops rewriting its own text.

## Still open

- **D-12** — the OGGI store's `wid`. `oggi` is the obvious choice and is unused.
- **D-13** — does the OGGI store get share links, client discounts and the rest of
  the wholesaler feature set? (Assumption: yes, it is a wholesaler row like any
  other — every tenant-isolation gate then covers it with no exceptions, and
  exceptions are where leaks live.)
- ~~**D-14** — wording sign-off on the rewritten page.~~ **Closed 9 Sep**: there
  is no rewritten page. Section 4 was removed and nothing replaced it, so there
  is no new statement to third parties to sign off. What remains to sign off is
  §7's surviving *"your sales data is never used against you"*, which is now
  load-bearing on OWN-04's wall rather than on wording.
