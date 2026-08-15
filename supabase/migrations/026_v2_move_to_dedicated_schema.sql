-- Batch 14 follow-up (post-delivery, per Hadi's explicit instruction) --
-- move v2 out of the `public` schema it shared with v1 into its own
-- dedicated `wholesale_v2` schema, for real structural isolation on top
-- of the naming-convention isolation (v2_ prefix) that already existed.
--
-- Every v2_* table already had zero foreign keys into v1's tables and
-- zero RLS policy ever referenced a v1 table -- so this migration is
-- purely additive isolation, not a fix for any actual cross-app
-- dependency. v1's own tables, functions, and RLS in `public` are NOT
-- touched by a single statement in this file.
--
-- Uses ALTER ... SET SCHEMA throughout rather than drop-and-recreate:
-- preserves data/indexes/constraints/RLS policies and function OIDs.
--
-- Sequence note (CORRECTED from initial attempt): all 7 bigint-PK
-- sequences (v2_inventory_movements_id_seq etc.) are owned by GENERATED
-- ... AS IDENTITY columns (pg_depend deptype = 'i', internal
-- dependency) rather than classic SERIAL (deptype = 'a'). Postgres
-- auto-moves identity-owned sequences to the new schema right along
-- with their owning table's ALTER TABLE ... SET SCHEMA, exactly like it
-- does for serial-owned sequences -- confirmed live: a first attempt at
-- this migration that included explicit `ALTER SEQUENCE ... SET SCHEMA`
-- statements for these 7 sequences failed with
-- `relation "public.v2_inventory_movements_id_seq" does not exist`
-- because by the time that statement ran, the sequence had already
-- moved automatically along with STEP 2's table move. That failed
-- attempt was atomic and rolled back cleanly (verified via pg_class --
-- everything was still in public, byte-for-byte as before). This
-- version simply omits the now-redundant explicit sequence moves.
--
-- Partitioned table caveat (see follow-up migration 027): unlike
-- identity sequences, a partitioned table's PARTITIONS do NOT move
-- automatically with the parent when the parent is SET SCHEMA'd --
-- confirmed live after this migration ran, v2_inventory_movements
-- (relkind 'p') moved to wholesale_v2 but its partition
-- v2_inventory_movements_2026_08 (a distinct relation, relkind 'r')
-- stayed behind in public. That is fixed in migration 027, applied
-- immediately after this one.
--
-- IMPORTANT MANUAL STEP FOR HADI, NOT SQL-SETTABLE: Supabase's REST API
-- (PostgREST) only serves schemas explicitly added to the project's
-- "Exposed schemas" list (Project Settings -> API -> Data API). This
-- migration does not and cannot add wholesale_v2 to that list -- it's a
-- platform/dashboard setting, not a database object. See
-- docs/BATCH-14-SCHEMA-MIGRATION-RECORD.md for the exact steps.

-- ===================================================================
-- STEP 1: create the dedicated schema and grant USAGE
-- ===================================================================
create schema if not exists wholesale_v2;
grant usage on schema wholesale_v2 to anon, authenticated, service_role, postgres;

-- ===================================================================
-- STEP 2: move every v2_* table (identity-owned sequences move
-- automatically with their parent table)
-- ===================================================================
alter table public.v2_audit_log set schema wholesale_v2;
alter table public.v2_client_price_overrides set schema wholesale_v2;
alter table public.v2_clients set schema wholesale_v2;
alter table public.v2_cycle_counts set schema wholesale_v2;
alter table public.v2_integration_events set schema wholesale_v2;
alter table public.v2_integration_settings set schema wholesale_v2;
alter table public.v2_inventory_balances set schema wholesale_v2;
alter table public.v2_inventory_movements set schema wholesale_v2;
alter table public.v2_invites set schema wholesale_v2;
alter table public.v2_kit_components set schema wholesale_v2;
alter table public.v2_kit_definitions set schema wholesale_v2;
alter table public.v2_locations set schema wholesale_v2;
alter table public.v2_login_throttle set schema wholesale_v2;
alter table public.v2_order_items set schema wholesale_v2;
alter table public.v2_order_pick_items set schema wholesale_v2;
alter table public.v2_orders set schema wholesale_v2;
alter table public.v2_pack_components set schema wholesale_v2;
alter table public.v2_pack_definitions set schema wholesale_v2;
alter table public.v2_portal_accounts set schema wholesale_v2;
alter table public.v2_pricing_tiers set schema wholesale_v2;
alter table public.v2_product_option_values set schema wholesale_v2;
alter table public.v2_product_options set schema wholesale_v2;
alter table public.v2_product_variant_option_values set schema wholesale_v2;
alter table public.v2_product_variants set schema wholesale_v2;
alter table public.v2_products set schema wholesale_v2;
alter table public.v2_rate_limit_hits set schema wholesale_v2;
alter table public.v2_receipt_costs set schema wholesale_v2;
alter table public.v2_signup_requests set schema wholesale_v2;
alter table public.v2_stock_reservations set schema wholesale_v2;
alter table public.v2_user_profiles set schema wholesale_v2;
alter table public.v2_visit_log set schema wholesale_v2;
alter table public.v2_webhook_deliveries set schema wholesale_v2;
alter table public.v2_webhook_endpoints set schema wholesale_v2;
alter table public.v2_wholesalers set schema wholesale_v2;

-- ===================================================================
-- STEP 3: move the view
-- ===================================================================
alter view public.v2_inventory_by_variant set schema wholesale_v2;

-- ===================================================================
-- STEP 4: move every v2_* function, then update each one's own
-- search_path (public -> wholesale_v2, preserving whichever extra
-- schemas -- extensions/net/vault -- it already needed). Moving the
-- function does NOT change its OID, so every existing RLS policy,
-- trigger, and cross-function call that already reference it by OID
-- keep working automatically.
-- ===================================================================
alter function public.v2_approve_signup_request(p_id uuid, p_username text) set schema wholesale_v2;
alter function wholesale_v2.v2_approve_signup_request(p_id uuid, p_username text) set search_path = wholesale_v2, extensions;
alter function public.v2_assemble_kit(p_kit_id uuid, p_location_id uuid, p_qty integer, p_actor_id uuid, p_note text) set schema wholesale_v2;
alter function wholesale_v2.v2_assemble_kit(p_kit_id uuid, p_location_id uuid, p_qty integer, p_actor_id uuid, p_note text) set search_path = wholesale_v2;
alter function public.v2_buyer_login(p_wid text, p_user text, p_pass text) set schema wholesale_v2;
alter function wholesale_v2.v2_buyer_login(p_wid text, p_user text, p_pass text) set search_path = wholesale_v2, extensions;
alter function public.v2_confirm_reservation(p_reservation_id bigint, p_order_id uuid, p_actor_id uuid) set schema wholesale_v2;
alter function wholesale_v2.v2_confirm_reservation(p_reservation_id bigint, p_order_id uuid, p_actor_id uuid) set search_path = wholesale_v2;
alter function public.v2_create_invite(p_role text, p_wid text, p_wholesaler_name text, p_expires_in_days integer) set schema wholesale_v2;
alter function wholesale_v2.v2_create_invite(p_role text, p_wid text, p_wholesaler_name text, p_expires_in_days integer) set search_path = wholesale_v2, extensions;
alter function public.v2_create_portal_account(p_role text, p_wid text, p_username text, p_password text, p_client_id uuid, p_actor_label text) set schema wholesale_v2;
alter function wholesale_v2.v2_create_portal_account(p_role text, p_wid text, p_username text, p_password text, p_client_id uuid, p_actor_label text) set search_path = wholesale_v2, extensions;
alter function public.v2_decrement_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_movement_type text, p_reference_type text, p_reference_id uuid, p_actor_id uuid, p_note text) set schema wholesale_v2;
alter function wholesale_v2.v2_decrement_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_movement_type text, p_reference_type text, p_reference_id uuid, p_actor_id uuid, p_note text) set search_path = wholesale_v2;
alter function public.v2_dispatch_integration_event(p_wid text, p_integration_type text, p_event_type text, p_payload jsonb) set schema wholesale_v2;
alter function wholesale_v2.v2_dispatch_integration_event(p_wid text, p_integration_type text, p_event_type text, p_payload jsonb) set search_path = wholesale_v2, net;
alter function public.v2_effective_unit_price(p_product_id uuid, p_variant_id uuid, p_client_id uuid, p_aggregate_qty bigint) set schema wholesale_v2;
alter function wholesale_v2.v2_effective_unit_price(p_product_id uuid, p_variant_id uuid, p_client_id uuid, p_aggregate_qty bigint) set search_path = wholesale_v2;
alter function public.v2_get_buyer_orders(p_account_id uuid) set schema wholesale_v2;
alter function wholesale_v2.v2_get_buyer_orders(p_account_id uuid) set search_path = wholesale_v2;
alter function public.v2_get_integration_secret(p_wid text, p_integration_type text, p_secret_name text) set schema wholesale_v2;
alter function wholesale_v2.v2_get_integration_secret(p_wid text, p_integration_type text, p_secret_name text) set search_path = wholesale_v2, vault;
alter function public.v2_has_integration_secret(p_wid text, p_integration_type text, p_secret_name text) set schema wholesale_v2;
alter function wholesale_v2.v2_has_integration_secret(p_wid text, p_integration_type text, p_secret_name text) set search_path = wholesale_v2;
alter function public.v2_inventory_integration_trigger() set schema wholesale_v2;
alter function wholesale_v2.v2_inventory_integration_trigger() set search_path = wholesale_v2;
alter function public.v2_is_owner() set schema wholesale_v2;
alter function wholesale_v2.v2_is_owner() set search_path = wholesale_v2;
alter function public.v2_my_role() set schema wholesale_v2;
alter function wholesale_v2.v2_my_role() set search_path = wholesale_v2;
alter function public.v2_my_wid() set schema wholesale_v2;
alter function wholesale_v2.v2_my_wid() set search_path = wholesale_v2;
alter function public.v2_orders_integration_trigger() set schema wholesale_v2;
alter function wholesale_v2.v2_orders_integration_trigger() set search_path = wholesale_v2;
alter function public.v2_rate_limit_check(p_key text, p_max integer, p_window_seconds integer) set schema wholesale_v2;
alter function wholesale_v2.v2_rate_limit_check(p_key text, p_max integer, p_window_seconds integer) set search_path = wholesale_v2;
alter function public.v2_receive_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_reference_type text, p_reference_id uuid, p_actor_id uuid, p_note text) set schema wholesale_v2;
alter function wholesale_v2.v2_receive_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_reference_type text, p_reference_id uuid, p_actor_id uuid, p_note text) set search_path = wholesale_v2;
alter function public.v2_redeem_invite(p_code text, p_actor_label text) set schema wholesale_v2;
alter function wholesale_v2.v2_redeem_invite(p_code text, p_actor_label text) set search_path = wholesale_v2;
alter function public.v2_release_expired_reservations() set schema wholesale_v2;
alter function wholesale_v2.v2_release_expired_reservations() set search_path = wholesale_v2;
alter function public.v2_release_reservation(p_reservation_id bigint) set schema wholesale_v2;
alter function wholesale_v2.v2_release_reservation(p_reservation_id bigint) set search_path = wholesale_v2;
alter function public.v2_reserve_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_cart_id uuid, p_buyer_id uuid, p_ttl_minutes integer) set schema wholesale_v2;
alter function wholesale_v2.v2_reserve_stock(p_variant_id uuid, p_location_id uuid, p_qty integer, p_cart_id uuid, p_buyer_id uuid, p_ttl_minutes integer) set search_path = wholesale_v2;
alter function public.v2_sales_login(p_user text, p_pass text) set schema wholesale_v2;
alter function wholesale_v2.v2_sales_login(p_user text, p_pass text) set search_path = wholesale_v2, extensions;
alter function public.v2_scan_pick_item(p_order_id uuid, p_code text) set schema wholesale_v2;
alter function wholesale_v2.v2_scan_pick_item(p_order_id uuid, p_code text) set search_path = wholesale_v2;
alter function public.v2_set_integration_secret(p_wid text, p_integration_type text, p_secret_name text, p_secret_value text) set schema wholesale_v2;
alter function wholesale_v2.v2_set_integration_secret(p_wid text, p_integration_type text, p_secret_name text, p_secret_value text) set search_path = wholesale_v2, vault;
alter function public.v2_start_order_pick(p_order_id uuid) set schema wholesale_v2;
alter function wholesale_v2.v2_start_order_pick(p_order_id uuid) set search_path = wholesale_v2;
alter function public.v2_submit_order(p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, p_client_id uuid, p_account_id uuid) set schema wholesale_v2;
alter function wholesale_v2.v2_submit_order(p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, p_client_id uuid, p_account_id uuid) set search_path = wholesale_v2;
alter function public.v2_submit_signup_request(p_wid text, p_buyer_name text, p_location text, p_volume text, p_sells text) set schema wholesale_v2;
alter function wholesale_v2.v2_submit_signup_request(p_wid text, p_buyer_name text, p_location text, p_volume text, p_sells text) set search_path = wholesale_v2;
alter function public.v2_undo_pick_item(p_order_id uuid, p_code text) set schema wholesale_v2;
alter function wholesale_v2.v2_undo_pick_item(p_order_id uuid, p_code text) set search_path = wholesale_v2;

-- ===================================================================
-- STEP 5: default privileges for THIS schema going forward, baking in
-- the lesson from 025_v2_fix_batch14_grant_hygiene.sql -- Supabase's
-- database-wide default privileges auto-grant EXECUTE on new functions
-- to anon, which is wrong for admin-gated RPCs more often than not.
-- ===================================================================
alter default privileges in schema wholesale_v2 grant execute on functions to authenticated;
alter default privileges in schema wholesale_v2 grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema wholesale_v2 grant usage, select on sequences to anon, authenticated;
