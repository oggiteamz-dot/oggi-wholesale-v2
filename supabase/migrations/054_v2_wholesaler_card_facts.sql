-- =============================================================================
-- 054 — WHAT A PRODUCT CARD SHOWS, chosen by the wholesaler
-- =============================================================================
-- 19 Aug 2026. Hadi: "other than the price, I don't want colours and sizes.
-- Instead, I want the ability for the wholesaler to pick the two to three
-- pieces of information that he wants... he can toggle on price, colours,
-- sizes, supplier, sales and orders." And, on warehouses: "if they have
-- multiple locations, they can pick which warehouse, or to show how many each
-- warehouse has of each one."
--
-- Stored on the wholesaler, not in the browser, because the choice has to
-- follow them to their phone. One column, one ordered array of keys.
--
-- The cap of three is enforced in the interface and in
-- js/lib/card-facts.js normaliseFacts(), deliberately NOT as a check
-- constraint: a future screen with more room to spare is a product decision,
-- and it should not take a migration to make it.
-- =============================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_wholesalers
  add column if not exists card_facts text[] not null default '{price,available,onHand}';

comment on column wholesale_v2.v2_wholesalers.card_facts is
  'Which facts appear on a product card, in order. Keys defined in js/lib/card-facts.js. A warehouse-specific fact is stored as stockAt:<location uuid>; stockByLocation means "one line per warehouse".';

-- Named columns, the way every other grant on this table is written, so that
-- adding a column here stays a decision to publish it.
grant select (card_facts) on wholesale_v2.v2_wholesalers to authenticated;
grant update (card_facts) on wholesale_v2.v2_wholesalers to authenticated;
