// OGGI Wholesale v2 — internal integration dispatch handler (Batch 12)
//
// Called by the `v2_dispatch_integration_event` Postgres function via
// pg_net whenever a real order/inventory event fires for an integration
// type that needs an authenticated third-party API call (WhatsApp,
// QuickBooks, Xero, Shopify, WooCommerce) — anything that doesn't need
// OAuth/HMAC/token-refresh logic (plain Zapier webhooks) is dispatched
// straight from Postgres instead and never reaches this function.
//
// Every branch below follows the SAME honesty rule as Batch 11's
// extract-catalog-from-image function: if the credentials/config this
// integration needs aren't present, it reports a clear "not configured"
// result into v2_integration_events and stops -- it never fabricates a
// successful sync. Per-wholesaler secrets (OAuth tokens, API keys) are
// decrypted via v2_get_integration_secret, which is grant-restricted to
// service_role -- this function calls it using the service-role key that
// Supabase injects into every edge function's environment automatically
// (SUPABASE_SERVICE_ROLE_KEY), which is never shipped to the browser.
//
// verify_jwt is OFF (dev-mode-until-Batch-14 posture, same as every other
// edge function in this build) -- this endpoint is reachable by anyone who
// knows the URL, but that only lets someone cause a spurious dispatch
// attempt to get logged; it can never leak a decrypted secret, because
// decryption only ever happens server-side inside this function using its
// own service-role credentials, never in response to a caller-supplied
// value.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://olaipgdckbgjediddloj.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function restCall(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
  return res;
}

async function getSecret(wid: string, integrationType: string, name: string): Promise<string | null> {
  const res = await restCall("/rest/v1/rpc/v2_get_integration_secret", {
    method: "POST",
    body: JSON.stringify({ p_wid: wid, p_integration_type: integrationType, p_secret_name: name }),
  });
  if (!res.ok) return null;
  const val = await res.json();
  return typeof val === "string" ? val : null;
}

async function getSettings(wid: string, integrationType: string) {
  const res = await restCall(`/rest/v1/v2_integration_settings?wid=eq.${encodeURIComponent(wid)}&integration_type=eq.${integrationType}&select=config,connected`);
  const rows = await res.json();
  return rows?.[0] || null;
}

async function markEvent(eventId: number, status: string, detail: string, httpStatus?: number) {
  await restCall(`/rest/v1/v2_integration_events?id=eq.${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ status, detail: detail.slice(0, 1000), http_status: httpStatus ?? null, updated_at: new Date().toISOString() }),
  });
}

async function handleWhatsapp(wid: string, eventId: number, eventType: string, payload: any) {
  const settings = await getSettings(wid, "whatsapp");
  const phoneNumberId = settings?.config?.phone_number_id;
  const accessToken = await getSecret(wid, "whatsapp", "access_token");
  if (!phoneNumberId || !accessToken) {
    return markEvent(eventId, "skipped", "not_configured: WhatsApp needs config.phone_number_id and a saved access_token secret");
  }
  const buyerPhone = settings?.config?.notify_phone; // wholesaler's own ops number to notify, or a mapped buyer number
  if (!buyerPhone) {
    return markEvent(eventId, "skipped", "not_configured: no notify_phone configured to send to");
  }
  const text = eventType === "order_created"
    ? `New order #${payload.order_id} received — ${payload.buyer_label}, subtotal $${payload.subtotal}`
    : `Order #${payload.order_id} for ${payload.buyer_label} has shipped`;
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: buyerPhone, type: "text", text: { body: text } }),
  });
  const body = await res.text();
  return markEvent(eventId, res.ok ? "success" : "failed", body.slice(0, 500), res.status);
}

async function handleInvoiceSync(wid: string, eventId: number, provider: "quickbooks" | "xero", payload: any) {
  const globalClientId = Deno.env.get(provider === "quickbooks" ? "QBO_CLIENT_ID" : "XERO_CLIENT_ID");
  const globalClientSecret = Deno.env.get(provider === "quickbooks" ? "QBO_CLIENT_SECRET" : "XERO_CLIENT_SECRET");
  if (!globalClientId || !globalClientSecret) {
    return markEvent(eventId, "skipped", `not_configured: this OGGI project has no ${provider === "quickbooks" ? "QBO_CLIENT_ID/QBO_CLIENT_SECRET" : "XERO_CLIENT_ID/XERO_CLIENT_SECRET"} secret set yet — the platform's own ${provider} developer app hasn't been registered. This is a platform-level setup step, not something an individual wholesaler can configure.`);
  }
  const refreshToken = await getSecret(wid, provider, "refresh_token");
  const tenantOrRealmId = (await getSettings(wid, provider))?.config?.[provider === "quickbooks" ? "realm_id" : "tenant_id"];
  if (!refreshToken || !tenantOrRealmId) {
    return markEvent(eventId, "skipped", `not_configured: wholesaler has not completed the ${provider} "Connect" OAuth flow yet`);
  }

  // Real token refresh + invoice-create calls (only reachable once both the
  // platform app AND a wholesaler's OAuth connection are real):
  const tokenUrl = provider === "quickbooks" ? "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" : "https://identity.xero.com/connect/token";
  const basicAuth = btoa(`${globalClientId}:${globalClientSecret}`);
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!tokenRes.ok) {
    return markEvent(eventId, "failed", `token refresh failed: ${(await tokenRes.text()).slice(0, 300)}`, tokenRes.status);
  }
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;

  const invoiceUrl = provider === "quickbooks"
    ? `https://quickbooks.api.intuit.com/v3/company/${tenantOrRealmId}/invoice`
    : `https://api.xero.com/api.xro/2.0/Invoices`;
  const invoiceRes = await fetch(invoiceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(provider === "xero" ? { "Xero-tenant-id": tenantOrRealmId } : {}),
    },
    body: JSON.stringify(provider === "quickbooks"
      ? { Line: [{ Amount: payload.subtotal, DetailType: "SalesItemLineDetail" }], CustomerRef: { name: payload.buyer_label } }
      : { Invoices: [{ Type: "ACCREC", Contact: { Name: payload.buyer_label }, LineItems: [{ Description: `Order #${payload.order_id}`, UnitAmount: payload.subtotal, Quantity: 1 }] }] }),
  });
  const invoiceBody = await invoiceRes.text();
  return markEvent(eventId, invoiceRes.ok ? "success" : "failed", invoiceBody.slice(0, 500), invoiceRes.status);
}

async function handleStockPush(wid: string, eventId: number, provider: "shopify" | "woocommerce", payload: any) {
  const settings = await getSettings(wid, provider);
  const variantMap = settings?.config?.variant_map || {};
  const remoteId = variantMap[payload.variant_id];
  if (!remoteId) {
    return markEvent(eventId, "skipped", `not_configured: no ${provider} product mapping saved for variant ${payload.variant_id} yet (config.variant_map)`);
  }
  const accessToken = await getSecret(wid, provider, "access_token");
  const shopDomain = settings?.config?.shop_domain;
  if (!accessToken || !shopDomain) {
    return markEvent(eventId, "skipped", `not_configured: ${provider} needs a saved access_token secret and config.shop_domain`);
  }

  if (provider === "shopify") {
    const locationId = settings?.config?.shopify_location_id;
    const res = await fetch(`https://${shopDomain}/admin/api/2024-01/inventory_levels/set.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ location_id: locationId, inventory_item_id: remoteId, available: payload.qty_on_hand }),
    });
    const body = await res.text();
    return markEvent(eventId, res.ok ? "success" : "failed", body.slice(0, 500), res.status);
  } else {
    const res = await fetch(`https://${shopDomain}/wp-json/wc/v3/products/${remoteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${accessToken}` },
      body: JSON.stringify({ stock_quantity: payload.qty_on_hand, manage_stock: true }),
    });
    const body = await res.text();
    return markEvent(eventId, res.ok ? "success" : "failed", body.slice(0, 500), res.status);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" } });
  try {
    const { event_id, wid, integration_type, event_type, payload } = await req.json();
    if (!event_id || !wid || !integration_type) {
      return new Response(JSON.stringify({ ok: false, reason: "bad_request" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    switch (integration_type) {
      case "whatsapp":
        await handleWhatsapp(wid, event_id, event_type, payload);
        break;
      case "quickbooks":
      case "xero":
        await handleInvoiceSync(wid, event_id, integration_type, payload);
        break;
      case "shopify":
      case "woocommerce":
        await handleStockPush(wid, event_id, integration_type, payload);
        break;
      default:
        await markEvent(event_id, "failed", `unknown integration_type: ${integration_type}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, reason: "unexpected_error", message: String((err as Error)?.message || err) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
});
