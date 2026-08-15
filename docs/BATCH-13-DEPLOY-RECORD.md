# Batch 13 — Animation & Visual Polish Pass — Deploy Record

## Scope

Motion feedback for the two moments in the buyer flow that had none:
adding an item to the cart, and placing an order. Plus the "hologram" 360°
product viewer the Feature Ledger calls out by name as designed once (the
"Ben-10-Omnitrix idea") and never shipped, because it was blocked on real
multi-angle product photography that was never delivered.

Four pieces:

1. **Fly-to-cart** — a coloured chip flies from the "Add to cart" button to
   a real cart icon (new — see below) in the topbar, then the icon bumps.
2. **Order celebration** — a full-screen animated checkmark + confetti
   burst on successful order submission, replacing a plain redirect.
3. **Hologram 360° viewer** — a 3-tier graceful-degradation product viewer.
4. **`prefers-reduced-motion` support** — every animation module checks it
   and degrades to instant/static per WCAG 2.3.3; this was built in from
   the start, not bolted on after.

## A prerequisite this batch found and fixed: there was no cart icon

Before this batch, the buyer topbar had no cart indicator at all — the
cart was only visible by navigating to `#/buyer/cart`. Fly-to-cart needs a
real landing target, so `js/components/topbar.js` now renders a
`#v2-cart-icon` basket link with a live item-count badge (driven by a new
`v2:cart-changed` document event) for the buyer role only. This is a real
UX gap this batch closed, not a stub built just to give the animation
somewhere to land — the badge is genuinely useful on its own.

Wiring the event required auditing every place `js/views/buyer.js`'s cart
view mutates the cart. Only the catalog grid's own `onCartChange` callback
dispatched anything before; the cart screen's own pack-qty-change, pack-
removal, line-qty-change, and line-removal handlers did not. All four now
dispatch `v2:cart-changed`, so the badge and any future listener stay
correct regardless of which screen changed the cart.

## The honest story on the hologram viewer

You cannot rotate through photos that were never taken. Rather than fake
it (recycling one photo as fake "angles," which would be a real quality
regression the moment a wholesaler noticed), the viewer has three real,
distinct states, and every SKU in this dev database is currently in the
first one, honestly:

- **0 photos** (every seed SKU today) → a generated on-brand placeholder
  silhouette, tinted with the variant's actual colour hex, with a
  pointer-driven 3D tilt + holographic sheen. Not a stand-in for real
  photography — an intentional "no photo yet, but still feels premium"
  state.
- **1 photo** → the real photo, same tilt+sheen treatment.
- **2+ photos** → a genuine drag-to-rotate viewer: dragging left/right
  cycles through the actual saved frames in order, exactly like real
  product-photography 360 spin, plus a slow auto-preview loop when idle
  (paused instantly on any pointer interaction).

All three states share the same stage/sheen/border chrome, so a SKU
upgrading from 0 → 1 → many photos is purely additive, never a
different-looking feature.

### Schema + admin UI added to make the upgrade path real, not theoretical

`supabase/migrations/021_v2_product_images.sql` adds `image_url` (text)
and `images` (jsonb array of `{url}`, default `'[]'`) to
`v2_product_variants`. `js/data/pricing-admin.js` gained
`setVariantImages(variantId, urls)`, and the Pricing & MOQ panel in
`js/views/wholesaler.js` gained a per-SKU "Product photos" table (paste
comma-separated URLs, save) so a wholesaler can actually move a SKU
through the three tiers today — this build has no image-upload/CDN
pipeline yet, so URLs are pasted in rather than uploaded, documented
in-line in the migration as a deliberate scope cut, not an oversight.

`js/data/catalog.js` (buyer-facing) and `js/data/pricing-admin.js`
(wholesaler-facing) both now select and map `image_url`/`images` through
to the variant objects consumers already use — no new fetch call needed
anywhere the viewer is opened from.

## `product-card.js` wiring

- The `addBtn` click handler in `renderStepper(variant)` now calls
  `flyToCart({ sourceEl: addBtn, color: variant.colorHex })` immediately
  after a **successful** `cart.setLineQty` result, gated on `qty > 0` so a
  qty-zero removal never animates. The cart write has already succeeded
  by the time the animation fires — the animation is pure feedback and
  never blocks or affects real state, and if `flyToCart` can't find a
  cart-icon target (wholesaler/owner roles, which don't have one) it's a
  silent no-op rather than an error.
- A new "360°" button sits in a `swatchBar` row next to the colour
  swatches (always rendered, even at 0 photos, so the feature stays
  discoverable rather than hidden until real photography exists). It
  resolves the variant matching the currently-selected colour and opens
  `openHologramModal({ images, colorHex, productName })`.

## A real bug caught during self-review, before any live test ran

In `js/lib/animations/product-hologram.js`, `renderFrame` was originally
declared as a block-scoped `function renderFrame() {...}` *inside* the
`if (images.length >= 2) {...}` branch, but `startAutoRotate()` — which
calls `renderFrame()` from inside its `setInterval` callback — is defined
in the *outer* function scope, above that `if` block. ES modules are
always strict mode, so a block-scoped function declaration is not visible
outside its block; this would have thrown `ReferenceError: renderFrame is
not defined` the moment the auto-rotate interval fired for any 2+-photo
product — which is exactly the state the live-DOM test below exercises,
and exactly where it would have been caught anyway, just later and
messier. Fixed by hoisting: `let renderFrame = () => {};` declared
alongside `visual`/`hint` in the outer scope, reassigned inside the `if`
block instead of using a nested function declaration. A second piece of
leftover dead code from an earlier draft (`if (images.length === 1 ||
arguments[0]?.images?.length === 1) { /* no-op */ }`) was removed in the
same pass.

## Verification performed

**Static:** `node --check` on every new/changed file (all 9 animation/
data/view files) — all pass.

**Live database round trip (curl against the real Supabase REST API, real
`mg`/Milano Garments variant, cleaned up after):**
```
variant before: image_url=null, images=[]
PATCH image_url + images (2 URLs)  -> 200
GET immediately after              -> image_url and images both persisted correctly
PATCH cleanup (null / [])          -> 200
GET after cleanup                  -> back to image_url=null, images=[], byte-identical to "before"
```
Proves `setVariantImages`'s exact write shape against the real table, not
just against the migration's column definitions.

**Live-DOM Playwright test, real `product-card.js` module loaded and
exercised (not mocked) against synthetic product objects — this sandbox's
Chromium cannot reach Supabase (documented network limitation since Batch
2), so real catalog data can't be fetched inside the browser test, but the
component's actual rendering and interaction logic can be, and was:**
- 0-photo variant → 360° button renders, click opens a modal, the
  placeholder-silhouette tier renders (`.v2-hologram-placeholder` present,
  no `.v2-hologram-frame`), Escape closes it and removes the modal from
  the DOM.
- 2-photo variant → same button/click opens the drag-rotate tier instead:
  `.v2-hologram-frame` present with `src` equal to the *first* saved URL,
  "Drag to rotate" hint shown — proving the `renderFrame` scoping fix
  actually works once the auto-rotate `setInterval` fires (this is the
  exact code path that bug would have broken).
- `flyToCart` exercised directly against a real cart icon + button pair:
  chip element (`.v2-fly-chip`) appears mid-flight and is gone ~750ms
  later; `#v2-cart-icon` gains the `.v2-cart-bump` class only *after* the
  620ms flight animation's `onfinish` fires, not before — confirms the
  bump is sequenced after the flight, not simultaneous with it.
- Zero thrown JS exceptions (`pageerror`) across any of the above.

**Playwright structural pass across 8 routes** (buyer catalog/cart/orders,
wholesaler products/integrations/import, owner dashboard, salesperson
dashboard) using `context.addInitScript` to seed the dev-mode session
before any page script runs (more reliable than a two-navigation
localStorage-then-reload approach, which raced in this harness) — zero
thrown JS exceptions on any route; console noise from blocked Supabase
fetches is expected per the documented sandbox limitation and was
filtered out of the pass/fail signal rather than ignored silently (each
run reports how many such lines it saw).

## Honest gaps carried forward

- No real image upload/CDN — photo URLs must already be hosted somewhere
  else and pasted in. A normalized image table (with alt text, sort
  weight, per-image metadata) would be the next step if/when a real
  upload pipeline lands; a plain jsonb array is the right amount of
  structure for "wholesaler pastes URLs" today.
- The catalog-grid's "add to cart" fly animation and the new cart icon
  only appear for the buyer role, matching where a cart concept exists in
  this build at all (wholesaler/owner/sales don't have a cart).
- `v2_product_variants.images`/`image_url` inherit the same dev-mode
  `using (true)` RLS posture as every other catalog table in this build —
  no different from the columns around them, and explicitly not the kind
  of secret Batch 12's Vault hardening was built for.
