// OGGI Wholesale v2 — QuickBooks Online / Xero OAuth connect flow (Batch 12)
//
// A single shared function handles both providers via ?provider=quickbooks
// or ?provider=xero, and two actions:
//
//   ?action=authorize-url&wid=<wid>   -> { ok, url } to redirect the
//   wholesaler's browser to, so THEY log into their own QBO/Xero account
//   and approve OGGI's platform app accessing it. The platform app's
//   client_id/client_secret (QBO_CLIENT_ID/QBO_CLIENT_SECRET or
//   XERO_CLIENT_ID/XERO_CLIENT_SECRET) are registered ONCE for the whole
//   OGGI platform (same pattern as any real "Connect your QuickBooks"
//   integration — Intuit/Xero issue one developer-app credential pair to
//   the SaaS vendor, not to each of the vendor's customers), and are
//   currently unset, so this honestly reports not_configured rather than
//   building a URL with an empty client_id that would fail on Intuit/
//   Xero's side anyway.
//
//   ?action=callback (GET, hit directly by Intuit/Xero after the
//   wholesaler approves access) -> exchanges the returned `code` for a
//   real access+refresh token pair, stores the refresh token via
//   v2_set_integration_secret (vault-backed, never in a plain table — see
//   the Batch 12 migration's header comment), and marks the integration
//   connected. Also currently only reachable in its honest not_configured
//   form, for the same reason.
//
// `state` carries the wholesaler's wid through the redirect round-trip
// (Intuit/Xero echo it back unchanged). This build's existing dev-mode
// posture (no real per-user session yet) means state isn't cryptographically
// signed here — a Batch 14 item, same as every other "harden once real auth
// exists" note in this build — but it can't be exploited to leak anything,
// since it only ever selects WHICH wholesaler's OAuth tokens get written on
// a callback the wholesaler themselves triggered by clicking "Connect".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://olaipgdckbgjediddloj.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const REDIRECT_BASE = `${SUPABASE_URL}/functions/v1/oauth-connect`;

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers || {}) },
  });
}

function notConfigured(provider: string) {
  const envPrefix = provider === "quickbooks" ? "QBO" : "XERO";
  return new Response(JSON.stringify({
    ok: false, reason: "not_configured",
    message: `OGGI's own ${provider} developer app hasn't been registered on this project yet (needs a ${envPrefix}_CLIENT_ID / ${envPrefix}_CLIENT_SECRET secret). This is a one-time platform-level setup step, not something an individual wholesaler can do from their own dashboard.`,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const action = url.searchParams.get("action") || (url.searchParams.get("code") ? "callback" : "authorize-url");

  if (provider !== "quickbooks" && provider !== "xero") {
    return new Response(JSON.stringify({ ok: false, reason: "bad_request", message: "provider must be quickbooks or xero" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const clientId = Deno.env.get(provider === "quickbooks" ? "QBO_CLIENT_ID" : "XERO_CLIENT_ID");
  const clientSecret = Deno.env.get(provider === "quickbooks" ? "QBO_CLIENT_SECRET" : "XERO_CLIENT_SECRET");

  if (action === "authorize-url") {
    const wid = url.searchParams.get("wid");
    if (!wid) return new Response(JSON.stringify({ ok: false, reason: "bad_request", message: "missing wid" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (!clientId) return notConfigured(provider);

    const redirectUri = `${REDIRECT_BASE}?provider=${provider}&action=callback`;
    const authUrl = provider === "quickbooks"
      ? `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent("com.intuit.quickbooks.accounting")}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(wid)}`
      : `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid profile email accounting.transactions offline_access")}&state=${encodeURIComponent(wid)}`;

    return new Response(JSON.stringify({ ok: true, url: authUrl }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (action === "callback") {
    if (!clientId || !clientSecret) return notConfigured(provider);
    const code = url.searchParams.get("code");
    const wid = url.searchParams.get("state");
    const realmId = url.searchParams.get("realmId"); // QuickBooks only
    if (!code || !wid) {
      return new Response(JSON.stringify({ ok: false, reason: "bad_request", message: "missing code/state" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const redirectUri = `${REDIRECT_BASE}?provider=${provider}&action=callback`;
    const tokenUrl = provider === "quickbooks" ? "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" : "https://identity.xero.com/connect/token";
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) {
      return new Response(JSON.stringify({ ok: false, reason: "token_exchange_failed", message: (await tokenRes.text()).slice(0, 300) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const tokenJson = await tokenRes.json();

    let tenantOrRealmId = realmId;
    if (provider === "xero") {
      const connRes = await fetch("https://api.xero.com/connections", { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
      const conns = connRes.ok ? await connRes.json() : [];
      tenantOrRealmId = conns?.[0]?.tenantId || null;
    }

    await rest("/rest/v1/rpc/v2_set_integration_secret", {
      method: "POST",
      body: JSON.stringify({ p_wid: wid, p_integration_type: provider, p_secret_name: "refresh_token", p_secret_value: tokenJson.refresh_token }),
    });
    await rest(`/rest/v1/v2_integration_settings?wid=eq.${encodeURIComponent(wid)}&integration_type=eq.${provider}`, {
      method: "PATCH",
      body: JSON.stringify({
        connected: true, connected_at: new Date().toISOString(), enabled: true,
        config: provider === "quickbooks" ? { realm_id: tenantOrRealmId } : { tenant_id: tenantOrRealmId },
      }),
    });

    return new Response(`<html><body>Connected to ${provider === "quickbooks" ? "QuickBooks Online" : "Xero"}. You can close this window.</body></html>`, {
      status: 200, headers: { "Content-Type": "text/html" },
    });
  }

  return new Response(JSON.stringify({ ok: false, reason: "bad_request" }), { status: 200, headers: { "Content-Type": "application/json" } });
});
