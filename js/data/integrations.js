// OGGI Wholesale v2 — integrations data layer (Batch 12)
//
// Thin wrapper over v2_integration_settings/v2_integration_events plus the
// vault-backed secret RPCs. NEVER fetches a decrypted secret value — that
// RPC (v2_get_integration_secret) is deliberately not reachable by the
// anon/publishable key this client uses (service_role only, see the Batch
// 12 migration). This module only ever writes secrets and checks whether
// one exists, never reads one back.

import { supabase, sbCall } from "../lib/supabase-client.js";

export const INTEGRATION_TYPES = ["zapier", "shopify", "woocommerce", "whatsapp", "quickbooks", "xero"];

export async function getIntegrationSettings(wid) {
  const { data } = await sbCall(supabase.from("v2_integration_settings").select("*").eq("wid", wid));
  const byType = {};
  for (const type of INTEGRATION_TYPES) byType[type] = null;
  for (const row of data || []) byType[row.integration_type] = row;
  return byType;
}

export async function updateIntegrationSettings(wid, integrationType, patch) {
  return sbCall(
    supabase.from("v2_integration_settings")
      .upsert({ wid, integration_type: integrationType, ...patch, updated_at: new Date().toISOString() }, { onConflict: "wid,integration_type" })
  );
}

export async function setIntegrationSecret(wid, integrationType, secretName, secretValue) {
  return sbCall(supabase.rpc("v2_set_integration_secret", { p_wid: wid, p_integration_type: integrationType, p_secret_name: secretName, p_secret_value: secretValue }));
}

export async function hasIntegrationSecret(wid, integrationType, secretName) {
  const { data } = await sbCall(supabase.rpc("v2_has_integration_secret", { p_wid: wid, p_integration_type: integrationType, p_secret_name: secretName }));
  return !!data;
}

/** Wholesaler-facing "Send test event" button — safe to call directly,
 * since it only ever sends TO the wholesaler's own configured destination
 * and never returns a decrypted secret (see the Batch 12 migration's
 * header comment for the full security rationale). */
export async function sendTestEvent(wid, integrationType) {
  return sbCall(supabase.rpc("v2_dispatch_integration_event", {
    p_wid: wid, p_integration_type: integrationType, p_event_type: "test_event",
    p_payload: { message: "This is a test event from OGGI Wholesale v2.", sent_at: new Date().toISOString() },
  }));
}

export async function getIntegrationEvents(wid, limit = 25) {
  const { data } = await sbCall(
    supabase.from("v2_integration_events").select("*").eq("wid", wid).order("created_at", { ascending: false }).limit(limit)
  );
  return data || [];
}

export async function getConnectAuthorizeUrl(wid, provider) {
  const base = "https://olaipgdckbgjediddloj.supabase.co/functions/v1/oauth-connect";
  const res = await fetch(`${base}?provider=${provider}&action=authorize-url&wid=${encodeURIComponent(wid)}`, {
    headers: { apikey: "sb_publishable_GnN_sh_xneseBc9dya4Vpg_eziJoPI5" },
  });
  return res.json();
}

export function inboundWebhookUrl(provider, wid) {
  const base = "https://olaipgdckbgjediddloj.supabase.co/functions/v1";
  const fn = provider === "shopify" ? "shopify-order-webhook" : "woocommerce-order-webhook";
  return `${base}/${fn}?wid=${encodeURIComponent(wid)}`;
}
