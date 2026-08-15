// OGGI Wholesale v2 — inbound WhatsApp Cloud API webhook (Batch 12)
//
// Two jobs, matching Meta's own webhook contract exactly:
//
// 1) GET verification handshake — when a wholesaler (or the platform, once
//    a Meta app exists) registers this URL as their WhatsApp webhook, Meta
//    calls it once with ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//    and expects the raw `hub.challenge` value echoed back ONLY if
//    hub.verify_token matches a value we control. Blindly echoing the
//    challenge without checking the token would let anyone verify an
//    endpoint they don't control against Meta's systems, so the check is
//    real and this honestly 403s when WHATSAPP_VERIFY_TOKEN isn't set (the
//    current real state — no Meta app is registered for this project).
//
// 2) POST inbound messages — logged into v2_integration_events as
//    direction='inbound' so a wholesaler can see real buyer replies came
//    in, matched to a wholesaler via metadata.phone_number_id against
//    v2_integration_settings.config->>'phone_number_id'. Automated replies
//    (e.g. "send me today's catalog") are NOT built in this batch — this
//    lays the real, working receive-and-log path; a conversational
//    response layer is a natural follow-up, not fabricated here.
//
// The WHATSAPP_VERIFY_TOKEN used for the handshake is a project-level
// secret (Meta's webhook subscription is registered once per App, at the
// App level, not per-wholesaler) — same category as ANTHROPIC_API_KEY in
// Batch 11: absent right now, honestly gated, works the moment it's added.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://olaipgdckbgjediddloj.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers || {}) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    if (!expected) {
      return new Response("WhatsApp webhook verification isn't configured yet — set a WHATSAPP_VERIFY_TOKEN secret on this Supabase project to enable it.", { status: 403 });
    }
    if (mode === "subscribe" && token === expected && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("verification failed", { status: 403 });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, reason: "bad_json" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const entries = body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const messages = value.messages || [];
        if (!phoneNumberId || !messages.length) continue;

        // Resolve which wholesaler this WhatsApp Business number belongs to.
        const settingsRes = await rest(`/rest/v1/v2_integration_settings?integration_type=eq.whatsapp&config->>phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&select=wid&limit=1`);
        const settingsRows = settingsRes.ok ? await settingsRes.json() : [];
        const wid = settingsRows?.[0]?.wid;
        if (!wid) continue; // Not a number any wholesaler on this platform has configured.

        for (const msg of messages) {
          await rest("/rest/v1/v2_integration_events", {
            method: "POST",
            body: JSON.stringify({
              wid, integration_type: "whatsapp", event_type: "message_received", direction: "inbound", status: "success",
              detail: `From ${msg.from}: ${msg.text?.body || `[${msg.type} message]`}`.slice(0, 1000),
            }),
          });
        }
      }
    }
    // Meta requires a fast 200 regardless of what we did with the payload.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  return new Response("method not allowed", { status: 405 });
});
