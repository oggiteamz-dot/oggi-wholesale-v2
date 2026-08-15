// OGGI Wholesale v2 — inbound WooCommerce order webhook (Batch 12)
//
// Same shape and same honesty posture as shopify-order-webhook (see that
// file's header comment for the full rationale) -- WooCommerce's
// "Order created" webhook topic is pointed at this URL with ?wid=<wid>,
// each line item's SKU is matched to that wholesaler's own catalog, and
// real stock is decremented via the same v2_decrement_stock ledger RPC
// (movement_type='sale', reference_type='woocommerce_order').
//
// WooCommerce signs webhooks the same way Shopify does: base64(HMAC-SHA256
// of the raw body, using the webhook's secret) in the
// X-WC-Webhook-Signature header. Same optional-but-enforced-when-present
// verification posture as the Shopify function.

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
    body: JSON.stringify({ wid, integration_type: "woocommerce", event_type: eventType, direction: "inbound", status, detail: detail.slice(0, 1000) }),
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

  const hasSecretRes = await rest("/rest/v1/rpc/v2_has_integration_secret", {
    method: "POST",
    body: JSON.stringify({ p_wid: wid, p_integration_type: "woocommerce", p_secret_name: "webhook_secret" }),
  });
  const hasSecret = hasSecretRes.ok ? await hasSecretRes.json() : false;
  if (hasSecret) {
    const secretRes = await rest("/rest/v1/rpc/v2_get_integration_secret", {
      method: "POST",
      body: JSON.stringify({ p_wid: wid, p_integration_type: "woocommerce", p_secret_name: "webhook_secret" }),
    });
    const secret = secretRes.ok ? await secretRes.json() : null;
    const sigHeader = req.headers.get("x-wc-webhook-signature") || "";
    const verified = secret ? await hmacVerify(secret, rawBody, sigHeader) : false;
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
        p_movement_type: "sale", p_reference_type: "woocommerce_order", p_reference_id: null,
        p_note: `WooCommerce order #${order.id ?? "unknown"}`,
      }),
    });
    results.push({ sku, ok: decRes.ok, error: decRes.ok ? null : (await decRes.text()).slice(0, 200) });
  }

  const okCount = results.filter((r) => r.ok).length;
  await logEvent(wid, "order_webhook", okCount === results.length ? "success" : "failed", JSON.stringify(results).slice(0, 900));
  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
});
