// OGGI Wholesale v2 — Integrations (Tier 2) settings screen (Batch 12)
//
// One card per integration. Every card is honest about its real state:
// enabled/disabled, connected/not, and (for OAuth providers) whether the
// PLATFORM itself has been registered with that provider yet — a
// wholesaler clicking "Connect QuickBooks" before OGGI has its own Intuit
// developer app sees a clear explanation, not a broken redirect.
//
// Secrets (access tokens, API keys) are write-only from this screen — the
// input clears after saving and the UI only ever shows "saved" / "not set",
// never the value itself, because this app has no way to read it back out
// (v2_get_integration_secret is service_role-only, see the Batch 12
// migration).

import { devAuth } from "../lib/dev-auth.js";
import { toast } from "../components/toast.js";
import {
  INTEGRATION_TYPES, getIntegrationSettings, updateIntegrationSettings,
  setIntegrationSecret, hasIntegrationSecret, sendTestEvent, getIntegrationEvents,
  getConnectAuthorizeUrl, inboundWebhookUrl,
} from "../data/integrations.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pageHeader(title, desc) {
  const el = document.createElement("div");
  el.className = "page-header";
  el.innerHTML = `<div class="page-title-group"><h1>${title}</h1><p>${desc}</p></div>`;
  return el;
}

const META = {
  zapier: { label: "Zapier / Webhooks", icon: "⚡", blurb: "Point any Zapier zap, Make.com scenario, or your own listener at a webhook URL you control. We POST a JSON payload on new orders and shipped orders." },
  shopify: { label: "Shopify", icon: "🛍️", blurb: "Inbound: Shopify order webhooks decrement your OGGI stock automatically. Outbound: OGGI stock changes push back to Shopify (needs a saved access token and per-SKU mapping)." },
  woocommerce: { label: "WooCommerce", icon: "🧩", blurb: "Same as Shopify, for a WooCommerce store — inbound order webhook decrements stock; outbound push needs a saved access token." },
  whatsapp: { label: "WhatsApp Business", icon: "💬", blurb: "Sends an order-notification message via the WhatsApp Cloud API on new orders and shipped orders, and logs replies you receive." },
  quickbooks: { label: "QuickBooks Online", icon: "📗", blurb: "One-way order → invoice sync. When you confirm an order, an invoice is created in your QuickBooks company." },
  xero: { label: "Xero", icon: "📘", blurb: "One-way order → invoice sync, same trigger as QuickBooks — confirming an order creates an invoice in Xero." },
};

function statusBadge(settings) {
  if (!settings) return `<span class="badge badge-neutral">Not set up</span>`;
  if (settings.connected) return `<span class="badge badge-success">Connected</span>`;
  if (settings.enabled) return `<span class="badge badge-info">Enabled</span>`;
  return `<span class="badge badge-neutral">Disabled</span>`;
}

async function renderOAuthCard(type, wid, settings) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;margin-bottom:14px;";
  const meta = META[type];
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div><h4 style="margin-bottom:2px;">${meta.icon} ${meta.label}</h4><div style="font-size:12px;color:var(--text-tertiary);max-width:520px;">${meta.blurb}</div></div>
      <div>${statusBadge(settings)}</div>
    </div>
  `;
  const connectBtn = document.createElement("button");
  connectBtn.className = "btn btn-secondary btn-sm";
  connectBtn.style.marginTop = "10px";
  connectBtn.textContent = settings?.connected ? `Reconnect ${meta.label}` : `Connect ${meta.label}`;
  connectBtn.addEventListener("click", async () => {
    const result = await getConnectAuthorizeUrl(wid, type);
    if (!result.ok) {
      toast(result.message || "Not configured yet", { type: "danger" });
      return;
    }
    window.open(result.url, "_blank", "noopener");
  });
  card.appendChild(connectBtn);
  if (settings?.connected) {
    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;color:var(--text-tertiary);margin-top:8px;";
    const idField = type === "quickbooks" ? settings.config?.realm_id : settings.config?.tenant_id;
    info.textContent = `Connected ${settings.connected_at ? new Date(settings.connected_at).toLocaleString() : ""}${idField ? ` — company/tenant ${idField}` : ""}`;
    card.appendChild(info);
  }
  return card;
}

function renderZapierCard(wid, settings) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;margin-bottom:14px;";
  const meta = META.zapier;
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div><h4 style="margin-bottom:2px;">${meta.icon} ${meta.label}</h4><div style="font-size:12px;color:var(--text-tertiary);max-width:520px;">${meta.blurb}</div></div>
      <div>${statusBadge(settings)}</div>
    </div>
  `;
  const urlInput = document.createElement("input");
  urlInput.className = "input";
  urlInput.style.marginTop = "10px";
  urlInput.placeholder = "https://hooks.zapier.com/hooks/catch/...";
  urlInput.value = settings?.config?.webhook_url || "";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
  const enabledLabel = document.createElement("label");
  enabledLabel.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;";
  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = !!settings?.enabled;
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode("Enabled"));
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-secondary btn-sm";
  saveBtn.textContent = "Save";
  const testBtn = document.createElement("button");
  testBtn.className = "btn btn-ghost btn-sm";
  testBtn.textContent = "Send test event";
  saveBtn.addEventListener("click", async () => {
    await updateIntegrationSettings(wid, "zapier", { enabled: enabledCheckbox.checked, config: { webhook_url: urlInput.value.trim() } });
    toast("Zapier settings saved", { type: "success" });
  });
  testBtn.addEventListener("click", async () => {
    await sendTestEvent(wid, "zapier");
    toast("Test event dispatched — check your Zapier/webhook history", { type: "success" });
  });
  row.appendChild(enabledLabel);
  row.appendChild(saveBtn);
  row.appendChild(testBtn);
  card.appendChild(urlInput);
  card.appendChild(row);
  return card;
}

function renderSecretRow(labelText, placeholder, onSave) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
  const label = document.createElement("span");
  label.style.cssText = "font-size:12px;color:var(--text-tertiary);width:110px;flex-shrink:0;";
  label.textContent = labelText;
  const input = document.createElement("input");
  input.className = "input";
  input.type = "password";
  input.placeholder = placeholder;
  input.style.flex = "1";
  const btn = document.createElement("button");
  btn.className = "btn btn-secondary btn-sm";
  btn.textContent = "Save";
  btn.addEventListener("click", async () => {
    if (!input.value.trim()) return;
    await onSave(input.value.trim());
    input.value = "";
    toast(`${labelText} saved securely`, { type: "success" });
  });
  wrap.appendChild(label);
  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}

async function renderChannelCard(type, wid, settings) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;margin-bottom:14px;";
  const meta = META[type];
  const hasAccessToken = await hasIntegrationSecret(wid, type, "access_token");
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div><h4 style="margin-bottom:2px;">${meta.icon} ${meta.label}</h4><div style="font-size:12px;color:var(--text-tertiary);max-width:520px;">${meta.blurb}</div></div>
      <div>${statusBadge(settings)}</div>
    </div>
  `;

  const domainField = type === "shopify" ? "shop_domain" : "shop_domain";
  const domainInput = document.createElement("input");
  domainInput.className = "input";
  domainInput.style.marginTop = "10px";
  domainInput.placeholder = type === "shopify" ? "your-store.myshopify.com" : "yourstore.com";
  domainInput.value = settings?.config?.[domainField] || "";

  const enabledLabel = document.createElement("label");
  enabledLabel.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px;";
  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = !!settings?.enabled;
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode("Enabled"));

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-secondary btn-sm";
  saveBtn.textContent = "Save";
  saveBtn.style.marginTop = "8px";
  saveBtn.addEventListener("click", async () => {
    await updateIntegrationSettings(wid, type, { enabled: enabledCheckbox.checked, config: { ...(settings?.config || {}), [domainField]: domainInput.value.trim() } });
    toast(`${meta.label} settings saved`, { type: "success" });
  });

  const accessTokenRow = renderSecretRow("Access token", hasAccessToken ? "•••••••• (saved — enter to replace)" : "paste access token", (val) => setIntegrationSecret(wid, type, "access_token", val));
  const webhookSecretRow = renderSecretRow("Webhook secret", "optional — enables signature verification", (val) => setIntegrationSecret(wid, type, "webhook_secret", val));

  const inboundNote = document.createElement("div");
  inboundNote.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-top:10px;padding:8px;background:var(--surface-subtle,#f6f6f6);border-radius:6px;word-break:break-all;";
  inboundNote.innerHTML = `<strong>Inbound order webhook URL</strong> — paste this into ${meta.label}'s webhook settings so new orders there decrement your OGGI stock automatically:<br>${esc(inboundWebhookUrl(type, wid))}`;

  card.appendChild(domainInput);
  card.appendChild(enabledLabel);
  card.appendChild(saveBtn);
  card.appendChild(accessTokenRow);
  card.appendChild(webhookSecretRow);
  card.appendChild(inboundNote);
  return card;
}

async function renderWhatsappCard(wid, settings) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;margin-bottom:14px;";
  const meta = META.whatsapp;
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div><h4 style="margin-bottom:2px;">${meta.icon} ${meta.label}</h4><div style="font-size:12px;color:var(--text-tertiary);max-width:520px;">${meta.blurb}</div></div>
      <div>${statusBadge(settings)}</div>
    </div>
  `;
  const phoneIdInput = document.createElement("input");
  phoneIdInput.className = "input";
  phoneIdInput.style.marginTop = "10px";
  phoneIdInput.placeholder = "WhatsApp phone_number_id (from Meta Business dashboard)";
  phoneIdInput.value = settings?.config?.phone_number_id || "";
  const notifyPhoneInput = document.createElement("input");
  notifyPhoneInput.className = "input";
  notifyPhoneInput.style.marginTop = "8px";
  notifyPhoneInput.placeholder = "Phone number to notify, e.g. 15551234567";
  notifyPhoneInput.value = settings?.config?.notify_phone || "";

  const enabledLabel = document.createElement("label");
  enabledLabel.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px;";
  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = !!settings?.enabled;
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode("Enabled"));

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-secondary btn-sm";
  saveBtn.textContent = "Save";
  saveBtn.style.marginTop = "8px";
  saveBtn.addEventListener("click", async () => {
    await updateIntegrationSettings(wid, "whatsapp", {
      enabled: enabledCheckbox.checked,
      config: { phone_number_id: phoneIdInput.value.trim(), notify_phone: notifyPhoneInput.value.trim() },
    });
    toast("WhatsApp settings saved", { type: "success" });
  });

  const accessTokenRow = renderSecretRow("Access token", "paste WhatsApp Cloud API access token", (val) => setIntegrationSecret(wid, "whatsapp", "access_token", val));

  card.appendChild(phoneIdInput);
  card.appendChild(notifyPhoneInput);
  card.appendChild(enabledLabel);
  card.appendChild(saveBtn);
  card.appendChild(accessTokenRow);
  return card;
}

function renderEventsLog(events) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;margin-top:6px;";
  card.innerHTML = `<h4 style="margin-bottom:8px;">Recent activity</h4>`;
  if (!events.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:var(--text-tertiary);";
    empty.textContent = "No integration activity yet — enable an integration above and trigger an order to see events here.";
    card.appendChild(empty);
    return card;
  }
  const table = document.createElement("div");
  table.style.cssText = "max-height:300px;overflow-y:auto;";
  const statusColor = { success: "var(--success-600,#1a7f37)", failed: "var(--danger-600,#b3261e)", skipped: "var(--text-tertiary)", dispatched: "var(--info-600,#0969da)", pending: "var(--text-tertiary)" };
  events.forEach((e) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;align-items:baseline;";
    row.innerHTML = `
      <div style="width:70px;flex-shrink:0;color:var(--text-tertiary);">${new Date(e.created_at).toLocaleTimeString()}</div>
      <div style="width:90px;flex-shrink:0;">${esc(e.integration_type)}</div>
      <div style="width:60px;flex-shrink:0;color:var(--text-tertiary);">${esc(e.direction)}</div>
      <div style="width:110px;flex-shrink:0;">${esc(e.event_type)}</div>
      <div style="width:80px;flex-shrink:0;font-weight:600;color:${statusColor[e.status] || "inherit"};">${esc(e.status)}</div>
      <div style="flex:1;min-width:0;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(e.detail || "")}">${esc(e.detail || "")}</div>
    `;
    table.appendChild(row);
  });
  card.appendChild(table);
  return card;
}

export async function integrationsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.innerHTML = "";
  outlet.appendChild(pageHeader("Integrations", "Connect accounting, ecommerce stock sync, WhatsApp notifications, and Zapier webhooks."));

  const settingsByType = await getIntegrationSettings(wid);
  const events = await getIntegrationEvents(wid, 25);

  const grid = document.createElement("div");
  outlet.appendChild(grid);

  grid.appendChild(renderZapierCard(wid, settingsByType.zapier));
  grid.appendChild(await renderChannelCard("shopify", wid, settingsByType.shopify));
  grid.appendChild(await renderChannelCard("woocommerce", wid, settingsByType.woocommerce));
  grid.appendChild(await renderWhatsappCard(wid, settingsByType.whatsapp));
  grid.appendChild(await renderOAuthCard("quickbooks", wid, settingsByType.quickbooks));
  grid.appendChild(await renderOAuthCard("xero", wid, settingsByType.xero));

  outlet.appendChild(renderEventsLog(events));
}

export function registerIntegrationsRoutes(router) {
  router.register("/wholesaler/integrations", (outlet) => integrationsView(outlet));
}
