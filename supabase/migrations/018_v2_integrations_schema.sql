-- OGGI Wholesale v2 — Batch 12: Integrations (Tier 2) schema
-- 11 Aug 2026
--
-- Adds: QuickBooks Online + Xero one-way invoice sync, generic outbound
-- webhooks (what a wholesaler points Zapier's "Webhooks by Zapier" trigger
-- at — there is no published Zapier app to install here, since publishing
-- to Zapier's marketplace is an out-of-band process on Zapier's own
-- platform with no API this build can call; the real, useful, buildable
-- subset is a reliable outbound webhook a wholesaler can wire into ANY
-- Zapier zap, Make.com scenario, or their own listener), Shopify/WooCommerce
-- stock sync (inbound order webhooks decrement v2 stock; outbound triggers
-- push v2 stock changes back out), and a WhatsApp order-notification webhook
-- genuinely wired into the order pipeline via a database trigger (not a
-- frontend call someone could forget to wire up).
--
-- SECURITY NOTE — this is the one deliberately-hardened corner of an
-- otherwise dev-mode-until-Batch-14 build. Every other v2_* table uses a
-- permissive `for all using (true)` RLS policy because there is no real
-- Supabase Auth session yet to scope by. That posture is fine for internal
-- catalog/order data. It is NOT fine for a wholesaler's real QuickBooks
-- refresh token, Shopify access token, or WhatsApp Business API token —
-- leaking one of those is a materially worse outcome than leaking catalog
-- data, so those values are never stored in a plain anon-readable table.
-- They go into Supabase Vault (already installed on this project —
-- `supabase_vault` extension, pgsodium-backed encryption at rest), and the
-- ONLY function that can decrypt them (v2_get_integration_secret) has
-- EXECUTE revoked from anon/authenticated and granted to service_role
-- alone — so only server-side code holding the service-role key (edge
-- functions, never shipped to a browser) can ever read a decrypted value
-- back out. Writing a new secret (v2_set_integration_secret) and checking
-- whether one exists (v2_has_integration_secret, no value returned) stay
-- open to anon, matching this build's existing "any anon request can act on
-- behalf of the current dev-mode session" posture — real per-user
-- authorization for who may configure a given wholesaler's integrations is
-- still a Batch 14 item, same as everywhere else in this build.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- Per-wholesaler, per-integration settings. Only NON-secret configuration
-- lives here (webhook URLs a wholesaler wants us to call, their shop
-- domain, their WhatsApp phone_number_id, feature toggles) plus vault
-- secret REFERENCES (opaque vault row ids, not the secret values
-- themselves) under config->'secret_refs'.
-- ---------------------------------------------------------------------
create table if not exists v2_integration_settings (
  wid              text not null references v2_wholesalers(wid) on delete cascade,
  integration_type text not null check (integration_type in ('zapier','shopify','woocommerce','whatsapp','quickbooks','xero')),
  enabled          boolean not null default false,
  config           jsonb not null default '{}'::jsonb,
  connected        boolean not null default false,
  connected_at     timestamptz,
  last_sync_at     timestamptz,
  last_sync_status text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (wid, integration_type)
);

alter table v2_integration_settings enable row level security;
create policy v2_integration_settings_all on v2_integration_settings for all using (true) with check (true);

-- ---------------------------------------------------------------------
-- Audit/debug trail for every dispatch attempt (outbound) and every
-- received call (inbound) — a wholesaler can see exactly what was sent,
-- when, and whether it succeeded, instead of integrations being a black
-- box.
-- ---------------------------------------------------------------------
create table if not exists v2_integration_events (
  id               bigint generated always as identity primary key,
  wid              text not null,
  integration_type text not null,
  event_type       text not null,
  direction        text not null check (direction in ('outbound','inbound')),
  status           text not null default 'pending' check (status in ('pending','dispatched','success','failed','skipped')),
  http_status      int,
  detail           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists v2_integration_events_wid_idx on v2_integration_events(wid, integration_type, created_at desc);

alter table v2_integration_events enable row level security;
create policy v2_integration_events_all on v2_integration_events for all using (true) with check (true);

-- ---------------------------------------------------------------------
-- Vault-backed secret storage. write + existence-check are anon-callable
-- (dev-mode posture, matches the rest of this build); DECRYPT is not.
-- ---------------------------------------------------------------------
create or replace function v2_set_integration_secret(p_wid text, p_integration_type text, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_id uuid;
  v_vault_name text := 'v2_integration/' || p_wid || '/' || p_integration_type || '/' || p_secret_name;
begin
  insert into v2_integration_settings (wid, integration_type)
    values (p_wid, p_integration_type)
    on conflict (wid, integration_type) do nothing;

  select (config->'secret_refs'->>p_secret_name)::uuid into v_existing_id
    from v2_integration_settings where wid = p_wid and integration_type = p_integration_type;

  if v_existing_id is not null then
    perform vault.update_secret(v_existing_id, p_secret_value);
  else
    v_existing_id := vault.create_secret(p_secret_value, v_vault_name, 'OGGI v2 integration secret');
    update v2_integration_settings
      set config = jsonb_set(coalesce(config, '{}'::jsonb), array['secret_refs', p_secret_name], to_jsonb(v_existing_id::text), true),
          updated_at = now()
      where wid = p_wid and integration_type = p_integration_type;
  end if;
end;
$$;
revoke all on function v2_set_integration_secret(text, text, text, text) from public;
grant execute on function v2_set_integration_secret(text, text, text, text) to anon, authenticated, service_role;

create or replace function v2_has_integration_secret(p_wid text, p_integration_type text, p_secret_name text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select (config->'secret_refs' ? p_secret_name)
  from v2_integration_settings
  where wid = p_wid and integration_type = p_integration_type;
$$;
revoke all on function v2_has_integration_secret(text, text, text) from public;
grant execute on function v2_has_integration_secret(text, text, text) to anon, authenticated, service_role;

-- DECRYPT PATH — service_role only. This is the one function in the whole
-- v2 schema that is deliberately NOT reachable via the anon/publishable
-- key, because its entire job is to hand back a real third-party
-- credential in plaintext.
create or replace function v2_get_integration_secret(p_wid text, p_integration_type text, p_secret_name text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
  v_value text;
begin
  select (config->'secret_refs'->>p_secret_name)::uuid into v_id
    from v2_integration_settings where wid = p_wid and integration_type = p_integration_type;
  if v_id is null then
    return null;
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_id;
  return v_value;
end;
$$;
revoke all on function v2_get_integration_secret(text, text, text) from public;
revoke all on function v2_get_integration_secret(text, text, text) from anon, authenticated;
grant execute on function v2_get_integration_secret(text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Generic outbound dispatcher. Called from real order/inventory triggers
-- below (so it is genuinely wired into the pipeline, not a call a
-- frontend developer could forget to add) AND directly callable by anon
-- for the wholesaler-facing "Send test event" button — safe to expose,
-- because it only ever sends TO the wholesaler's own configured
-- destination (their webhook_url, or our own internal dispatch edge
-- function which itself re-checks configuration) and never returns a
-- decrypted secret to the caller.
--
-- zapier goes straight from Postgres via pg_net to the wholesaler's own
-- webhook_url (no OAuth/secrets involved, so there's no reason to round-
-- trip through an edge function). Every other integration type needs a
-- real per-platform authenticated API call (OAuth token refresh, HMAC
-- signing, etc.) that is far more reliable to write correctly in
-- TypeScript than in plpgsql, so those are hand off to the
-- `integration-dispatch` edge function, which decrypts whatever secret it
-- needs itself (service-role-only, see above) and reports back into
-- v2_integration_events when done.
-- ---------------------------------------------------------------------
create or replace function v2_dispatch_integration_event(p_wid text, p_integration_type text, p_event_type text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_settings record;
  v_event_id bigint;
  v_request_id bigint;
  v_webhook_url text;
begin
  select * into v_settings from v2_integration_settings
    where wid = p_wid and integration_type = p_integration_type and enabled = true;

  if not found then
    -- Not enabled — log a skip rather than silently doing nothing, so the
    -- events log is a complete record of "did we even try."
    insert into v2_integration_events (wid, integration_type, event_type, direction, status, detail)
      values (p_wid, p_integration_type, p_event_type, 'outbound', 'skipped', 'integration not enabled')
      returning id into v_event_id;
    return v_event_id;
  end if;

  insert into v2_integration_events (wid, integration_type, event_type, direction, status)
    values (p_wid, p_integration_type, p_event_type, 'outbound', 'pending')
    returning id into v_event_id;

  if p_integration_type = 'zapier' then
    v_webhook_url := v_settings.config->>'webhook_url';
    if v_webhook_url is null or v_webhook_url = '' then
      update v2_integration_events set status = 'failed', detail = 'no webhook_url configured', updated_at = now() where id = v_event_id;
      return v_event_id;
    end if;
    select net.http_post(
      url := v_webhook_url,
      body := jsonb_build_object('event_type', p_event_type, 'wid', p_wid, 'data', p_payload, 'event_id', v_event_id),
      headers := jsonb_build_object('Content-Type', 'application/json')
    ) into v_request_id;
    update v2_integration_events set status = 'dispatched', detail = 'pg_net request id ' || v_request_id, updated_at = now() where id = v_event_id;
  else
    select net.http_post(
      url := 'https://olaipgdckbgjediddloj.supabase.co/functions/v1/integration-dispatch',
      body := jsonb_build_object('event_id', v_event_id, 'wid', p_wid, 'integration_type', p_integration_type, 'event_type', p_event_type, 'payload', p_payload),
      headers := jsonb_build_object('Content-Type', 'application/json')
    ) into v_request_id;
    update v2_integration_events set status = 'dispatched', detail = 'pg_net request id ' || v_request_id, updated_at = now() where id = v_event_id;
  end if;

  update v2_integration_settings set last_sync_at = now(), updated_at = now() where wid = p_wid and integration_type = p_integration_type;

  return v_event_id;
exception when others then
  update v2_integration_events set status = 'failed', detail = sqlerrm, updated_at = now() where id = v_event_id;
  return v_event_id;
end;
$$;
revoke all on function v2_dispatch_integration_event(text, text, text, jsonb) from public;
grant execute on function v2_dispatch_integration_event(text, text, text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Order-pipeline wiring — a real database trigger, not a frontend call.
-- New order  -> zapier 'order_created' + whatsapp 'order_created'
-- confirmed  -> quickbooks 'invoice_sync' + xero 'invoice_sync' (one-way
--              order -> invoice push happens once a wholesaler has
--              actually confirmed the order is real, not on every
--              still-editable "new" order)
-- shipped    -> zapier 'order_shipped' + whatsapp 'order_shipped'
-- ---------------------------------------------------------------------
create or replace function v2_orders_integration_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'order_id', new.id, 'status', new.status, 'buyer_label', new.buyer_label,
    'subtotal', new.subtotal, 'created_at', new.created_at
  );

  if tg_op = 'INSERT' then
    perform v2_dispatch_integration_event(new.wid, 'zapier', 'order_created', v_payload);
    perform v2_dispatch_integration_event(new.wid, 'whatsapp', 'order_created', v_payload);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'confirmed' then
      perform v2_dispatch_integration_event(new.wid, 'quickbooks', 'invoice_sync', v_payload);
      perform v2_dispatch_integration_event(new.wid, 'xero', 'invoice_sync', v_payload);
    elsif new.status = 'shipped' then
      perform v2_dispatch_integration_event(new.wid, 'zapier', 'order_shipped', v_payload);
      perform v2_dispatch_integration_event(new.wid, 'whatsapp', 'order_shipped', v_payload);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists v2_orders_integration_trg on v2_orders;
create trigger v2_orders_integration_trg
  after insert or update on v2_orders
  for each row execute function v2_orders_integration_trigger();

-- ---------------------------------------------------------------------
-- Inventory-pipeline wiring — push stock changes out to Shopify/
-- WooCommerce whenever a real balance changes (any receive, sale,
-- adjustment, count correction — anything that lands in
-- v2_inventory_balances via the Batch 1 ledger RPCs already flows through
-- here, so this never needs updating when a new stock-mutating feature is
-- added elsewhere in the app).
-- ---------------------------------------------------------------------
create or replace function v2_inventory_integration_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wid text;
  v_payload jsonb;
begin
  if new.qty_on_hand is not distinct from old.qty_on_hand then
    return new;
  end if;

  select p.wid into v_wid
    from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = new.variant_id;

  if v_wid is null then
    return new;
  end if;

  v_payload := jsonb_build_object(
    'variant_id', new.variant_id, 'location_id', new.location_id,
    'qty_on_hand', new.qty_on_hand, 'qty_reserved', new.qty_reserved
  );
  perform v2_dispatch_integration_event(v_wid, 'shopify', 'stock_updated', v_payload);
  perform v2_dispatch_integration_event(v_wid, 'woocommerce', 'stock_updated', v_payload);

  return new;
end;
$$;

drop trigger if exists v2_inventory_integration_trg on v2_inventory_balances;
create trigger v2_inventory_integration_trg
  after insert or update on v2_inventory_balances
  for each row execute function v2_inventory_integration_trigger();
