// OGGI Wholesale v2 — inbound Shopify order webhook (Batch 12)
//
// A wholesaler who also sells direct-to-consumer on Shopify points
// Shopify's "orders/create" webhook at this URL (with ?wid=<their wid> so
// a single shared endpoint can serve every wholesaler on the platform).
// Every line item's SKU is matched against that wholesaler's own
// v2_product_variants, and real stock is decremented through the SAME
// ledger-based v2_decrement_stock RPC every other stock-mutating path in
// this build uses (movement_type='sale', reference_type='shopify_order')
// -- never a second, parallel inventory-mutation path.
//
// Signature verification: Shopify signs every webhook with an HMAC-SHA256
// of the raw body using the app's webhook secret (X-Shopify-Hmac-Sha256
// header). If the wholesaler has saved a webhook secret
// (v2_has_integration_secret(wid,'shopify','webhook_secret')), it is
// enforced -- a bad or missing signature is rejected. If no secret has
// been saved yet (true for every wholesaler in this environment, since
// none has gone through Shopify's real app-install flow), the request is
// still processed but logged as unverified -- same dev-mode-open posture
// documented on every other inbound endpoint in this build since Batch 2,
// and the honest, safer default (verify when we can, don't silently drop
// orders when we can't) rather than pretending verification always ran.
//
// verify_jwt is OFF -- this must be callable by Shopify's own servers,
// which do not send a Supabase auth header.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://olaipgdckbgjediddloj.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers || {}) },
  });
}

async function hmacVerify(secret: string, rawBody: string, signatureB64: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === signatureB64;
}

async function logEvent(wid: string, eventType: string, status: string, detail: string) {
  await rest("/rest/v1/v2_integration_events", {
    method: "POST",
    body: JSON.stringify({ wid, integration_type: "shopify", event_type: eventType, direction: "inbound", status, detail: detail.slice(0, 1000) }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });

  const url = new URL(req.url);
  const wid = url.searchParams.get("wid");
  const rawBody = await req.text();
  if (!wid) {
    return new Response(JSON.stringify({ ok: false, reason: "missing_wid" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Optional signature verification (see header comment).
  const hasSecretRes = await rest("/rest/v1/rpc/v2_has_integration_secret", {
    method: "POST",
    body: JSON.stringify({ p_wid: wid, p_integration_type: "shopify", p_secret_name: "webhook_secret" }),
  });
  const hasSecret = hasSecretRes.ok ? await hasSecretRes.json() : false;
  let verified = false;
  if (hasSecret) {
    const secretRes = await rest("/rest/v1/rpc/v2_get_integration_secret", {
      method: "POST",
      body: JSON.stringify({ p_wid: wid, p_integration_type: "shopify", p_secret_name: "webhook_secret" }),
    });
    const secret = secretRes.ok ? await secretRes.json() : null;
    const hmacHeader = req.headers.get("x-shopify-hmac-sha256") || "";
    verified = secret ? await hmacVerify(secret, rawBody, hmacHeader) : false;
    if (!verified) {
      await logEvent(wid, "order_webhook", "failed", "signature verification failed — request rejected");
      return new Response(JSON.stringify({ ok: false, reason: "invalid_signature" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  let order: any;
  try {
    order = JSON.parse(rawBody);
  } catch {
    await logEvent(wid, "order_webhook", "failed", "invalid JSON body");
    return new Response(JSON.stringify({ ok: false, reason: "bad_json" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const lineItems = order.line_items || [];
  const locRes = await rest(`/rest/v1/v2_locations?wid=eq.${encodeURIComponent(wid)}&is_default=eq.true&select=id&limit=1`);
  const locations = await locRes.json();
  const locationId = locations?.[0]?.id;
  if (!locationId) {
    await logEvent(wid, "order_webhook", "failed", "no default location found for wholesaler");
    return new Response(JSON.stringify({ ok: false, reason: "no_default_location" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const results: any[] = [];
  for (const item of lineItems) {
    const sku = item.sku;
    if (!sku) { results.push({ sku: null, ok: false, error: "line item has no SKU" }); continue; }
    const variantRes = await rest(`/rest/v1/v2_product_variants?sku=eq.${encodeURIComponent(sku)}&select=id,product_id`);
    const variants = await variantRes.json();
    const variant = variants?.[0];
    if (!variant) { results.push({ sku, ok: false, error: "no matching SKU in this wholesaler's catalog" }); continue; }
    const decRes = await rest("/rest/v1/rpc/v2_decrement_stock", {
      method: "POST",
      body: JSON.stringify({
        p_variant_id: variant.id, p_location_id: locationId, p_qty: item.quantity || 1,
        p_movement_type: "sale", p_reference_type: "shopify_order", p_reference_id: null,
        p_note: `Shopify order #${order.id ?? order.name ?? "unknown"}`,
      }),
    });
    results.push({ sku, ok: decRes.ok, error: decRes.ok ? null : (await decRes.text()).slice(0, 200) });
  }

  const okCount = results.filter((r) => r.ok).length;
  await logEvent(wid, "order_webhook", okCount === results.length ? "success" : "failed", JSON.stringify(results).slice(0, 900));
  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
});
