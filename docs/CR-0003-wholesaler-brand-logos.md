# CR-0003 — Wholesaler brand lineup, with logos

**Raised:** 17 Aug 2026 by Hadi · **Lane:** NORMAL (schema + code + storage)
**Status:** FILED, NOT STARTED · **Section:** Wholesaler account + buyer catalogue
**Blocked by:** nothing structural — see §3, the bucket already exists

---

## What was asked, in Hadi's words

> "add to the wholesaler section when we go and start building the features for
> the wholesalers accounts — I want them to have the ability to upload, either
> write the names of the brands that they sell, or they actually write the name
> and upload the logo of each of their brands. This way, when someone enters
> into their store or catalog or whatever you want to call it, they get to see
> all the different brands they hold."

Numbered so none of it can quietly vanish:

| # | Ask | Type |
|---|---|---|
| W1 | A wholesaler manages **their own** brand list, without the owner doing it for them | Change (new) |
| W2 | Name only is enough — a brand with no logo is still a valid brand | Change (new) |
| W3 | Optionally **upload a logo** per brand | Change (new) |
| W4 | Buyers entering the catalogue **see the brand lineup** | Change (new) |

**W2 matters more than it looks.** If a logo is required, a wholesaler with
seven brands and two logo files adds two brands and gives up. Name-only must be
a first-class state, not a placeholder.

---

## 1. What already exists (verified against the live database, 17 Aug)

Most of this is built. The gap is smaller than it appears.

| Piece | State |
|---|---|
| `v2_wholesaler_brands` (wid, name, is_primary, sort_order) | **LIVE** — migration 038 |
| `v2_set_wholesaler_brands(p_wid, p_brands[])` | **LIVE**, atomic replace |
| `js/data/brands.js` — list / listByWholesaler / set | **LIVE** — shipped 17 Aug |
| `js/components/tag-input.js` — type-and-Enter chips | **LIVE**, 13 behaviours tested |
| Owner can set brands when creating a wholesaler | **LIVE** |
| Storage bucket for images (`product-img`, public) | **EXISTS**, created for v1 |

**What is missing is exactly three things:** a `logo_url` column, an upload
path in v2, and the two screens (wholesaler-side editor, buyer-side lineup).

---

## 2. The real blocker, named honestly

**v2 has no image upload path at all.** This is regression #10 in
`REGRESSION-LEDGER-2026-08-17.md`, confirmed again while filing this CR:
`grep` for `storage.from(` / `.upload(` across `js/` returns **zero matches**.
v2 accepts pasted image URLs only, by its own admission
(`wholesaler.js:388-396`). v1 uploaded up to 50 photos per product to a bucket.

So W3 is not "add a file input". It is **build the upload path v2 never got**,
and brand logos are simply its first consumer.

**That is an argument for doing it here, not against it.** The same upload path
is needed by product images (#10), and it is the single most-missed capability
in the wholesaler role. Building it for brand logos — where the blast radius is
one small image per brand rather than a 50-photo product gallery — is a much
safer first outing than building it directly into the product editor.

---

## 3. Good news: the bucket is already there

`storage.buckets` on the live project:

```
product-img    public
order-voice    public     <- v1's voice notes (regression #14)
public-docs    public
module-audio   public
```

`product-img` was created for v1 and still exists. Brand logos can live under
a `brands/<wid>/<brand>.png` prefix in it, or get their own bucket — a decision,
not an obstacle. **No infrastructure has to be provisioned.**

⚠️ **But note `public: true` on every bucket.** That is correct for buyer-facing
product photos and brand logos, which are meant to be seen. It would be wrong
for anything private, and whoever builds the upload path must not reuse a public
bucket for documents by habit. Worth checking the RLS on `storage.objects`
before the first write, not after.

---

## 4. Scope sketch (not a plan — that comes when this is scheduled)

**Schema**
- `v2_wholesaler_brands.logo_url text null` — additive, expand-only
- Optional: `logo_path` if the storage key is kept separately from the public URL

**Storage**
- Decide bucket + path convention
- RLS on `storage.objects`: a wholesaler may write only under their own `wid`
  prefix. **This is the security-critical part of the whole CR** — an upload
  path scoped only in the browser lets any authenticated wholesaler overwrite
  another's logos.
- Client-side downscale before upload. A 2000×2000 logo rendered at 40px is the
  same waste the OGGI logo had (68KB → 12KB after trimming). At 43.9 Mbps median
  mobile in Lebanon this is not a nicety.

**Wholesaler screen** — extend the existing tag input, or a small list editor:
name (required) · logo (optional) · reorder · remove. Reuses `tag-input.js` for
the name-only path so W2 costs nothing.

**Buyer screen** — a brand lineup strip on the catalogue. Name-only brands
render as a text chip; brands with a logo render the logo. **Both must look
deliberate.** A grid where two cells are images and five are text looks broken
unless it is designed to.

**Owner console** — the drill-down (CR-0004) should show the lineup too; it is
part of "what does this wholesaler actually carry".

---

## 5. Open questions for Hadi, when this is scheduled

1. Who owns the brand list — wholesaler only, or owner *and* wholesaler both?
   Today the owner sets it at creation. If both can edit, whose wins?
2. Should a brand be a **shared entity** across wholesalers (one "Nike" record
   that many suppliers link to) or free text per wholesaler? Shared enables
   "show me every supplier carrying Nike", which is a marketplace feature.
   Free text is what exists today.
3. Is the lineup **filterable** by the buyer — tap Nike, see only Nike products?
   That needs a brand link on the PRODUCT, not just the wholesaler, which is a
   bigger schema change than this CR.
4. Logo moderation: the owner sees these before buyers do, or not?

**Question 2 is the one with real consequences.** If the marketplace
(§1 of the build plan) ever lets buyers browse by brand across suppliers, brands
must be shared entities. Retrofitting that later means de-duplicating free text
across every wholesaler — "Nike", "NIKE", "Nike Inc" — by hand.

---

## 6. Where this sits

Backlog, wholesaler section. **Not scheduled.** The owner console is the
current lane, and the standing rule is one thing at a time.

Filed so it is a decision that was made, not a request that was forgotten.
