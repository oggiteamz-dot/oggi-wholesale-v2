-- Batch 13: product image support for variants.
--
-- This is the schema half of the "hologram" 360 viewer feature (see
-- js/lib/animations/product-hologram.js for the full design rationale).
-- No product photography exists yet in this dev database -- every seed
-- SKU has images = '[]' -- so the viewer's 0-photo tier (a generated,
-- colour-tinted placeholder silhouette) is genuinely exercised by every
-- product today. Saving real photos via setVariantImages() upgrades a
-- SKU to the 1- or 2+-photo tier with zero other code changes.
--
-- image_url: the single "primary" photo, used anywhere a flat thumbnail
--   is wanted (cards, order lines) without needing to unpack the array.
-- images: ordered jsonb array of { url } objects -- the full set used by
--   the 360 viewer's drag-to-rotate frame cycling when length >= 2.
--   Kept as a plain jsonb array (not a separate table) because this
--   build has no image upload/CDN pipeline yet -- URLs are pasted in by
--   a wholesaler admin (see js/views/wholesaler.js "Manage photos") and
--   there is no per-image metadata (alt text, sort weight, etc.) to
--   justify a normalized table yet. Revisit if/when real upload lands.

alter table v2_product_variants
  add column if not exists image_url text,
  add column if not exists images jsonb not null default '[]'::jsonb;
