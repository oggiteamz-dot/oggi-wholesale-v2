-- OGGI Wholesale v2 — cheap security hardening found by get_advisors after
-- Batch 1's migration. Not Batch 14 work (no real tenant authorization is
-- added here, that's still deferred) -- this is just: (1) let the app
-- actually read the tables it needs to, (2) stop a view from silently
-- bypassing RLS, (3) pin function search_path per Postgres best practice.
-- All three are zero-behavior-change, safe, and cost nothing to do now.
-- Applied to the live project 11 Aug 2026 -- see BATCH-1-DEPLOY-RECORD.md.

-- 1) Read policies for tables that had RLS enabled with no policy at all
--    (meaning: currently unreadable by anon/authenticated even for display
--    purposes). Read-only is the CORRECT permanent posture for movements/
--    balances/variant structure tables -- writes go exclusively through the
--    SECURITY DEFINER RPC functions (v2_receive_stock etc.), never direct
--    table writes, so no write policy is added here on purpose.
create policy v2_product_options_read on v2_product_options for select using (true);
create policy v2_product_option_values_read on v2_product_option_values for select using (true);
create policy v2_product_variants_read on v2_product_variants for select using (true);
create policy v2_product_variant_option_values_read on v2_product_variant_option_values for select using (true);
create policy v2_inventory_balances_read on v2_inventory_balances for select using (true);
create policy v2_inventory_movements_read on v2_inventory_movements for select using (true);

-- Reservations: a buyer should only ever see their own cart's reservations,
-- not everyone's. Scope by cart_id being passed by the client -- can't do
-- true per-buyer scoping until real auth exists (Batch 14), so for now
-- this stays read-restricted to nothing (no select policy added) and the
-- app reads reservation state back from the RPC return values it already
-- gets from v2_reserve_stock/v2_confirm_reservation, not via a live SELECT.

-- Webhook tables: internal/admin-only by design, no client-side read needed
-- yet (nothing consumes webhooks until Batch 12). Left with no policy
-- (deny-all) intentionally.

-- 2) Make the aggregate view respect the caller's RLS instead of running
--    as its (privileged) creator -- otherwise it silently bypasses the
--    read policy just added on v2_inventory_balances.
alter view v2_inventory_by_variant set (security_invoker = true);

-- 3) Pin search_path on every SECURITY DEFINER function (prevents a
--    search-path-hijack: a caller creating objects earlier in their own
--    search_path to trick the function into operating on the wrong table).
alter function v2_receive_stock(uuid, uuid, integer, text, uuid, uuid, text) set search_path = public;
alter function v2_decrement_stock(uuid, uuid, integer, text, text, uuid, uuid, text) set search_path = public;
alter function v2_reserve_stock(uuid, uuid, integer, uuid, uuid, integer) set search_path = public;
alter function v2_release_reservation(bigint) set search_path = public;
alter function v2_confirm_reservation(bigint, uuid, uuid) set search_path = public;
alter function v2_release_expired_reservations() set search_path = public;
