-- Batch 14 -- part 2/3: RLS hardening pass.
--
-- Scope decision, stated plainly rather than left implicit: this pass
-- tightens every WRITE path (insert/update/delete) on wholesaler-owned
-- data to require a real, authenticated owner or the matching
-- wholesaler (v2_is_owner() / v2_my_wid(), from migration 022 -- backed
-- by real Supabase Auth as of this batch, not the free "pick a role"
-- dev-mode session). Buyer-facing catalog/inventory/pricing READS
-- (v2_products, v2_product_variants, v2_product_options and friends,
-- v2_inventory_balances, v2_locations, v2_pricing_tiers) are left
-- anon-readable on purpose -- the entire buyer app across 13 earlier
-- batches reads this data via plain anon-key REST calls with no buyer
-- session concept in the request at all, and re-architecting every one
-- of those call sites onto session-scoped RPCs is real, valuable, FUTURE
-- work that deserves its own reviewed batch, not something to fold into
-- a single unreviewed overnight pass alongside everything else here.
-- That gap is carried forward explicitly in the deploy record, not
-- silently left as-is and called "hardened."
--
-- The one buyer-facing area that DOES get fully closed here is order
-- data, because it is the one place real money/PII sits behind a
-- guessable string (wid + free-text buyer_label) rather than a
-- credential -- see the v2_orders/v2_order_items section below and the
-- new v2_get_buyer_orders / v2_submit_order changes in migration 024.

-- ---------------------------------------------------------------------
-- Pure wholesaler-admin tables, direct wid column -- old single
-- permissive policy dropped, replaced with a scoped ALL policy. None of
-- these are read by the buyer-facing app, so there is no anon-read
-- carve-out to preserve.
-- ---------------------------------------------------------------------
drop policy if exists v2_integration_settings_all on v2_integration_settings;
create policy v2_integration_settings_scoped on v2_integration_settings for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_integration_events_all on v2_integration_events;
create policy v2_integration_events_scoped on v2_integration_events for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_clients_all on v2_clients;
create policy v2_clients_scoped on v2_clients for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_cycle_counts_all on v2_cycle_counts;
create policy v2_cycle_counts_scoped on v2_cycle_counts for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_kit_definitions_all on v2_kit_definitions;
create policy v2_kit_definitions_scoped on v2_kit_definitions for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_pack_definitions_all on v2_pack_definitions;
create policy v2_pack_definitions_scoped on v2_pack_definitions for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_visit_log_all on v2_visit_log;
create policy v2_visit_log_scoped on v2_visit_log for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_signup_requests_all on v2_signup_requests;
create policy v2_signup_requests_scoped on v2_signup_requests for all
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());
comment on policy v2_signup_requests_scoped on v2_signup_requests is
  'Direct table access is owner/wholesaler-only, closing the gap this table''s own migration 007 comment flagged for Batch 14. Prospective buyers with no session at all still submit requests -- via the new v2_submit_signup_request SECURITY DEFINER RPC in migration 024, which forces status=pending server-side, not via a direct anon insert policy.';

drop policy if exists v2_wholesalers_all on v2_wholesalers;
-- v2_wholesalers stays SELECT-open (buyer login screen needs to resolve
-- a wholesaler's display name/brand before a buyer has any credential
-- at all), but every write is owner/wholesaler-scoped.
create policy v2_wholesalers_read on v2_wholesalers for select using (true);
create policy v2_wholesalers_write_scoped on v2_wholesalers for update
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_wholesalers_owner_insert on v2_wholesalers for insert
  with check (v2_is_owner());
create policy v2_wholesalers_owner_delete on v2_wholesalers for delete
  using (v2_is_owner());

-- v2_locations: buyers need to see pickup/delivery location names
-- (anon SELECT stays open), but only the owning wholesaler/owner can
-- create or edit one. Replaces the old auth.jwt()->>'wid' policy, which
-- was a no-op under dev-mode (no jwt claim ever set it, so it always
-- evaluated to wid = wid).
drop policy if exists v2_locations_scoped on v2_locations;
create policy v2_locations_read on v2_locations for select using (true);
create policy v2_locations_write_scoped on v2_locations for insert
  with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_locations_update_scoped on v2_locations for update
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_locations_delete_scoped on v2_locations for delete
  using (v2_is_owner() or wid = v2_my_wid());

-- ---------------------------------------------------------------------
-- v2_audit_log: cross-wholesaler by design (no wid column at all --
-- migration 007's own comment already called out "hardened for real
-- (owner-role-only access) in Batch 14"). Owner-only, full stop.
-- ---------------------------------------------------------------------
drop policy if exists v2_audit_log_all on v2_audit_log;
create policy v2_audit_log_owner_only on v2_audit_log for all
  using (v2_is_owner())
  with check (v2_is_owner());

-- ---------------------------------------------------------------------
-- Product catalog + inventory: SELECT stays anon-open (buyer catalog
-- browsing depends on it, see the header note), writes tightened to the
-- owning wholesaler/owner. product_id/variant_id-only tables reach wid
-- through a join to v2_products.
-- ---------------------------------------------------------------------
drop policy if exists v2_products_scoped on v2_products;
create policy v2_products_read on v2_products for select using (true);
create policy v2_products_write_scoped on v2_products for insert
  with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_products_update_scoped on v2_products for update
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());
create policy v2_products_delete_scoped on v2_products for delete
  using (v2_is_owner() or wid = v2_my_wid());

drop policy if exists v2_product_variants_write on v2_product_variants;
create policy v2_product_variants_write_scoped on v2_product_variants for insert
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
drop policy if exists v2_product_variants_update on v2_product_variants;
create policy v2_product_variants_update_scoped on v2_product_variants for update
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
create policy v2_product_variants_delete_scoped on v2_product_variants for delete
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
-- v2_product_variants_read (select, true) is untouched -- buyer catalog
-- browsing depends on it.

drop policy if exists v2_product_options_write on v2_product_options;
create policy v2_product_options_write_scoped on v2_product_options for insert
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
create policy v2_product_options_update_scoped on v2_product_options for update
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
create policy v2_product_options_delete_scoped on v2_product_options for delete
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));

drop policy if exists v2_product_option_values_write on v2_product_option_values;
create policy v2_product_option_values_write_scoped on v2_product_option_values for insert
  with check (v2_is_owner() or exists (
    select 1 from v2_product_options o join v2_products p on p.id = o.product_id
    where o.id = option_id and p.wid = v2_my_wid()
  ));
create policy v2_product_option_values_update_scoped on v2_product_option_values for update
  using (v2_is_owner() or exists (
    select 1 from v2_product_options o join v2_products p on p.id = o.product_id
    where o.id = option_id and p.wid = v2_my_wid()
  ))
  with check (v2_is_owner() or exists (
    select 1 from v2_product_options o join v2_products p on p.id = o.product_id
    where o.id = option_id and p.wid = v2_my_wid()
  ));
create policy v2_product_option_values_delete_scoped on v2_product_option_values for delete
  using (v2_is_owner() or exists (
    select 1 from v2_product_options o join v2_products p on p.id = o.product_id
    where o.id = option_id and p.wid = v2_my_wid()
  ));

drop policy if exists v2_product_variant_option_values_write on v2_product_variant_option_values;
create policy v2_product_variant_option_values_write_scoped on v2_product_variant_option_values for insert
  with check (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));
create policy v2_product_variant_option_values_delete_scoped on v2_product_variant_option_values for delete
  using (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));

-- Pricing tiers + per-client overrides: read stays open (the buyer
-- catalog price calculation needs both), writes wholesaler-scoped via
-- their product/variant join.
drop policy if exists v2_pricing_tiers_all on v2_pricing_tiers;
create policy v2_pricing_tiers_read on v2_pricing_tiers for select using (true);
create policy v2_pricing_tiers_write_scoped on v2_pricing_tiers for insert
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
create policy v2_pricing_tiers_update_scoped on v2_pricing_tiers for update
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));
create policy v2_pricing_tiers_delete_scoped on v2_pricing_tiers for delete
  using (v2_is_owner() or exists (select 1 from v2_products p where p.id = product_id and p.wid = v2_my_wid()));

drop policy if exists v2_client_price_overrides_all on v2_client_price_overrides;
create policy v2_client_price_overrides_read on v2_client_price_overrides for select using (true);
comment on policy v2_client_price_overrides_read on v2_client_price_overrides is
  'Carried-forward gap, stated explicitly: this is per-client negotiated pricing, and leaving SELECT anon-open means any caller can read every client''s override, not just their own. Scoping it to "the logged-in buyer''s own override only" needs the buyer catalog price computation (js/data/pricing.js) rewired onto a session-aware RPC, which is the same out-of-scope-for-tonight rearchitecture as the rest of buyer-facing catalog reads (see this migration''s header). Writes are scoped below; reads are not, on purpose, and this comment exists so that is a documented decision, not an oversight.';
create policy v2_client_price_overrides_write_scoped on v2_client_price_overrides for insert
  with check (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));
create policy v2_client_price_overrides_update_scoped on v2_client_price_overrides for update
  using (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ))
  with check (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));
create policy v2_client_price_overrides_delete_scoped on v2_client_price_overrides for delete
  using (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));

-- Packs/kits: definitions have a direct wid; components reach it via
-- their parent definition. Reads stay open (buyer pack/kit browsing).
drop policy if exists v2_pack_components_all on v2_pack_components;
create policy v2_pack_components_read on v2_pack_components for select using (true);
create policy v2_pack_components_write_scoped on v2_pack_components for insert
  with check (v2_is_owner() or exists (select 1 from v2_pack_definitions d where d.id = pack_id and d.wid = v2_my_wid()));
create policy v2_pack_components_update_scoped on v2_pack_components for update
  using (v2_is_owner() or exists (select 1 from v2_pack_definitions d where d.id = pack_id and d.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_pack_definitions d where d.id = pack_id and d.wid = v2_my_wid()));
create policy v2_pack_components_delete_scoped on v2_pack_components for delete
  using (v2_is_owner() or exists (select 1 from v2_pack_definitions d where d.id = pack_id and d.wid = v2_my_wid()));

drop policy if exists v2_kit_components_all on v2_kit_components;
create policy v2_kit_components_read on v2_kit_components for select using (true);
create policy v2_kit_components_write_scoped on v2_kit_components for insert
  with check (v2_is_owner() or exists (select 1 from v2_kit_definitions d where d.id = kit_id and d.wid = v2_my_wid()));
create policy v2_kit_components_update_scoped on v2_kit_components for update
  using (v2_is_owner() or exists (select 1 from v2_kit_definitions d where d.id = kit_id and d.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_kit_definitions d where d.id = kit_id and d.wid = v2_my_wid()));
create policy v2_kit_components_delete_scoped on v2_kit_components for delete
  using (v2_is_owner() or exists (select 1 from v2_kit_definitions d where d.id = kit_id and d.wid = v2_my_wid()));

-- v2_receipt_costs: landed-cost records, wholesaler-internal only
-- (never read by the buyer app) -- fully scoped, no anon-read carve-out.
drop policy if exists v2_receipt_costs_all on v2_receipt_costs;
create policy v2_receipt_costs_scoped on v2_receipt_costs for all
  using (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ))
  with check (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));

-- ---------------------------------------------------------------------
-- Inventory: balances/movements stay SELECT-open (buyer catalog "N
-- available" / low-stock badges read v2_inventory_balances directly),
-- but these already have no direct anon WRITE policy at all (only the
-- ledger RPCs from Batch 1 -- v2_receive_stock etc -- write them, and
-- those are SECURITY DEFINER already). Nothing to change here beyond
-- confirming that stays true; no policy edits needed.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- v2_orders / v2_order_items / v2_order_pick_items: the one buyer-facing
-- area fully closed this batch (see migration header). SELECT is no
-- longer anon-open -- order contents/pricing/PII now require a real
-- owner/wholesaler session OR go through the new v2_get_buyer_orders
-- RPC (migration 024), which independently validates a real buyer
-- account_id rather than trusting a client-supplied wid+buyer_label
-- string. UPDATE (status changes: confirm/pick/ship) is wholesaler/
-- owner-only -- previously `using (true)`, i.e. anyone could flip any
-- order's status.
-- ---------------------------------------------------------------------
drop policy if exists v2_orders_read on v2_orders;
drop policy if exists v2_orders_update on v2_orders;
create policy v2_orders_admin_read on v2_orders for select
  using (v2_is_owner() or wid = v2_my_wid());
create policy v2_orders_admin_update on v2_orders for update
  using (v2_is_owner() or wid = v2_my_wid())
  with check (v2_is_owner() or wid = v2_my_wid());
-- No anon/authenticated insert policy here on purpose -- order creation
-- stays exclusively through the v2_submit_order RPC (SECURITY DEFINER,
-- already the case since Batch 4), which bypasses RLS internally.

drop policy if exists v2_order_items_read on v2_order_items;
create policy v2_order_items_admin_read on v2_order_items for select
  using (v2_is_owner() or exists (select 1 from v2_orders o where o.id = order_id and o.wid = v2_my_wid()));

drop policy if exists v2_order_pick_items_all on v2_order_pick_items;
create policy v2_order_pick_items_scoped on v2_order_pick_items for all
  using (v2_is_owner() or exists (select 1 from v2_orders o where o.id = order_id and o.wid = v2_my_wid()))
  with check (v2_is_owner() or exists (select 1 from v2_orders o where o.id = order_id and o.wid = v2_my_wid()));
