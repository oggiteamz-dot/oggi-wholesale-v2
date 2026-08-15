-- OGGI Wholesale v2 — Batch 3 write-policy fix
-- 11 Aug 2026
--
-- Found by testing the actual REST calls the wholesaler UI makes (not
-- assumed): v2_product_variants/options/option_values/variant_option_values
-- only had SELECT policies from the Batch 1 hardening pass (intentional --
-- inventory *quantities* must only move through the RPCs), and v2_orders
-- only had SELECT from Batch 2. But Batch 3 legitimately needs direct
-- writes for things that are NOT quantity fields: price/cost edits,
-- archive toggling, cloning a product's structure for "duplicate as
-- template", and order status transitions. Without these policies, writes
-- either hard-fail (INSERT, no policy = RLS violation) or worse, silently
-- no-op (UPDATE with no policy matches zero rows and returns 200 OK) --
-- confirmed both failure modes directly via curl against the live REST API
-- before shipping this batch, not assumed from reading the schema.
--
-- Same temporary/permissive-during-build posture as v2_products already
-- has (Batch 1). Hardened for real in Batch 14.

create policy v2_product_variants_write on v2_product_variants for insert with check (true);
create policy v2_product_variants_update on v2_product_variants for update using (true) with check (true);
create policy v2_product_options_write on v2_product_options for insert with check (true);
create policy v2_product_option_values_write on v2_product_option_values for insert with check (true);
create policy v2_product_variant_option_values_write on v2_product_variant_option_values for insert with check (true);
create policy v2_orders_update on v2_orders for update using (true) with check (true);
