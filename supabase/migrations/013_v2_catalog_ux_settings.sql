-- OGGI Wholesale v2 — Batch 8: Catalog UX upgrades — wholesaler-level settings
-- 11 Aug 2026
--
-- Adds the wholesaler-configurable knobs the buyer-side catalog toolbar and
-- cart trust/guarantee card need. All live on v2_wholesalers -- the same
-- v2-owned mirror table created in Batch 5 (migration 008), never on v1's
-- real `wholesalers` table. Every column defaults to a sane value so
-- existing rows (the 4 real doc-confirmed wholesalers) don't need a manual
-- backfill and every query against v2_wholesalers keeps working unchanged.
--
-- low_moq_threshold: what counts as "low MOQ" for the buyer-side "Low MOQ
--   only" catalog filter (Batch 8). Wholesaler-configurable because what's
--   "low commitment" varies a lot by category (a 6-unit MOQ is trivial for
--   basics, ambitious for a made-to-order style) -- a single hardcoded
--   number for every wholesaler would be wrong for most of them.
-- trust_message / return_policy / payment_terms: free-text shown on the
--   buyer's cart/checkout trust card (js/components/trust-badges.js). Kept
--   nullable with generic fallback copy in the UI layer rather than forced
--   defaults here, so a wholesaler who hasn't filled these in yet still
--   gets honest, non-fabricated messaging instead of a filled-in-looking
--   placeholder.

alter table v2_wholesalers
  add column if not exists low_moq_threshold int not null default 12,
  add column if not exists trust_message text,
  add column if not exists return_policy text,
  add column if not exists payment_terms text;
