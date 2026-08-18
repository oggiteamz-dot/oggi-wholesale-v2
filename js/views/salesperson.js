// OGGI Wholesale v2 — Salesperson views (Batch 4: real client list, visits, reorder)
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { getClientsByRecency, addClient, deactivateClient, coverageSnapshot } from "../data/clients.js";
import { logVisit, getVisits } from "../data/visits.js";
import { getWholesalerOrders } from "../data/wholesaler-orders.js";
import { cart } from "../data/cart.js";
import { listClientOverrides, setClientOverride, removeClientOverride, listVariantsForPicker } from "../data/client-pricing.js";

import { esc, pageHeader } from "../lib/utils.js";
function timeAgo(iso) {
  if (!iso) return "Never ordered";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

// ---------- Dashboard ----------

async function dashboard(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Salesperson Dashboard", "Client coverage at a glance."));

  const clients = await getClientsByRecency(wid);
  const snap = coverageSnapshot(clients);

  const stats = document.createElement("div");
  stats.className = "stat-grid";
  [
    ["Total clients", snap.total],
    ["Ordered in last 30d", snap.coveredRecently],
    ["Needs attention", snap.needsAttention],
    ["Never ordered", snap.neverOrdered],
  ].forEach(([label, value]) => {
    const c = document.createElement("div");
    c.className = "card stat-card";
    c.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
    stats.appendChild(c);
  });
  outlet.appendChild(stats);

  if (!clients.length) {
    outlet.appendChild(emptyState({ icon: "◆", title: "No clients yet", body: "Add clients from My Clients to start tracking coverage." }));
  }
}

// ---------- My Clients ----------

async function clientsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("My Clients", "Sorted by most recent order first — the ones that have gone quiet sink to the bottom."));

  // Add-client-on-the-fly form
  const addForm = document.createElement("div");
  addForm.className = "card";
  addForm.style.cssText = "padding:16px;margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;";
  addForm.innerHTML = `
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Shop name</label><input class="input" id="new-shop" style="width:200px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Phone</label><input class="input" id="new-phone" style="width:140px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Discount %</label><input class="input" id="new-discount" type="number" style="width:90px;" value="0" /></div>
  `;
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-primary btn-sm";
  addBtn.textContent = "Add client";
  addBtn.addEventListener("click", async () => {
    const shopName = document.getElementById("new-shop").value.trim();
    if (!shopName) { toast("Shop name required", { type: "danger" }); return; }
    const phone = document.getElementById("new-phone").value.trim();
    const discountPct = parseFloat(document.getElementById("new-discount").value) || 0;
    const { error } = await addClient(wid, { shopName, phone, discountPct });
    if (error) { toast("Could not add client (name may already exist)", { type: "danger" }); return; }
    toast(`${shopName} added`, { type: "success" });
    outlet.innerHTML = "";
    clientsView(outlet);
  });
  addForm.appendChild(addBtn);
  outlet.appendChild(addForm);

  const clients = await getClientsByRecency(wid);
  if (!clients.length) {
    outlet.appendChild(emptyState({ icon: "👥", title: "No clients yet", body: "Add your first client above." }));
    return;
  }

  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";

  clients.forEach((c) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:650;">${esc(c.shop_name)}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${esc(c.phone || "no phone")} · ${c.discount_pct}% discount${c.note ? " · " + esc(c.note) : ""}</div>
      </div>
      <div style="text-align:right;width:130px;">
        <div style="font-size:12px;font-weight:600;">${timeAgo(c.lastOrderAt)}</div>
        <div style="font-size:11px;color:var(--text-tertiary);">${c.orderCount} order${c.orderCount === 1 ? "" : "s"} · $${c.lifetimeValue.toFixed(0)}</div>
      </div>
    `;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;";

    const logVisitBtn = document.createElement("button");
    logVisitBtn.className = "btn btn-secondary btn-sm";
    logVisitBtn.textContent = "Log visit";
    logVisitBtn.addEventListener("click", async () => {
      const note = prompt(`Visit note for ${c.shop_name} (optional):`, "");
      if (note === null) return;
      await logVisit(wid, { clientId: c.id, repLabel: session.actorLabel || "Rep", note });
      toast("Visit logged", { type: "success" });
    });

    const deactivateBtn = document.createElement("button");
    deactivateBtn.className = "btn btn-ghost btn-sm";
    deactivateBtn.textContent = "Deactivate";
    deactivateBtn.addEventListener("click", async () => {
      if (!confirm(`Deactivate ${c.shop_name}? They'll stop appearing in coverage tracking.`)) return;
      await deactivateClient(c.id);
      toast(`${c.shop_name} deactivated`, { type: "success" });
      outlet.innerHTML = "";
      clientsView(outlet);
    });

    const pricingBtn = document.createElement("button");
    pricingBtn.className = "btn btn-secondary btn-sm";
    pricingBtn.textContent = "Manage pricing";

    actions.appendChild(pricingBtn);
    actions.appendChild(logVisitBtn);
    actions.appendChild(deactivateBtn);
    row.appendChild(actions);

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;width:100%;";
    wrap.appendChild(row);
    const panel = document.createElement("div");
    panel.style.cssText = "display:none;padding:14px;background:var(--surface-sunken,#f7f7f5);border-bottom:1px solid var(--border-subtle);";
    wrap.appendChild(panel);

    let panelLoaded = false;
    pricingBtn.addEventListener("click", async () => {
      const isOpen = panel.style.display === "block";
      panel.style.display = isOpen ? "none" : "block";
      if (isOpen || panelLoaded) return;
      panelLoaded = true;
      panel.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">Loading…</div>`;
      await renderClientPricingPanel(panel, wid, c);
    });

    list.appendChild(wrap);
  });
  outlet.appendChild(list);
}

// ---------- Per-client "Your Price" overrides (Batch 6) ----------

async function renderClientPricingPanel(panel, wid, client) {
  // Batch 16: every call in this panel now carries the rep's real
  // v2_portal_accounts id. The database validates it (exists, role='sales',
  // active, belongs to this client's wholesaler) rather than trusting it --
  // a rep runs as anon and could otherwise claim to be anyone. Before this,
  // these calls hit the table directly and RLS refused every write, so this
  // panel could list prices but never change one.
  const accountId = devAuth.getSession()?.accountId || null;
  const [overrides, variants] = await Promise.all([
    listClientOverrides(accountId, client.id),
    listVariantsForPicker(wid),
  ]);
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:12px;font-weight:650;margin-bottom:8px;";
  header.textContent = `Negotiated prices for ${client.shop_name} — override wins over volume tiers and the base price at checkout.`;
  panel.appendChild(header);

  const list = document.createElement("div");
  function renderList() {
    list.innerHTML = overrides.length ? "" : `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">No negotiated prices yet.</div>`;
    overrides.forEach((o) => {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;align-items:center;gap:10px;font-size:13px;padding:4px 0;";
      r.innerHTML = `<div style="flex:1;">${esc(o.productName)} <span style="color:var(--text-tertiary);">(${esc(o.color)}/${esc(o.size)})</span> — <s style="color:var(--text-tertiary);">$${o.basePrice.toFixed(2)}</s> <strong>$${o.overridePrice.toFixed(2)}</strong>${o.note ? ` · ${esc(o.note)}` : ""}</div>`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "btn btn-ghost btn-sm";
      rmBtn.textContent = "Remove";
      rmBtn.addEventListener("click", async () => {
        // The removal has to be confirmed by the server before the row leaves
        // the screen: this used to drop it from the list unconditionally, so a
        // refusal looked exactly like a success until the next reload.
        const res = await removeClientOverride(accountId, o.id);
        if (!res.ok) { toast(res.error || "Could not remove that price", { type: "danger" }); return; }
        const idx = overrides.findIndex((x) => x.id === o.id);
        if (idx >= 0) overrides.splice(idx, 1);
        renderList();
        toast("Override removed", { type: "success" });
      });
      r.appendChild(rmBtn);
      list.appendChild(r);
    });
  }
  renderList();
  panel.appendChild(list);

  const addRow = document.createElement("div");
  addRow.style.cssText = "display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap;";
  const select = document.createElement("select");
  select.className = "input";
  select.style.width = "260px";
  select.innerHTML = variants.map((v) => `<option value="${v.variantId}">${esc(v.productName)} (${esc(v.color)}/${esc(v.size)}) — $${v.price.toFixed(2)}</option>`).join("");
  const priceInput = document.createElement("input");
  priceInput.className = "input"; priceInput.type = "number"; priceInput.min = "0"; priceInput.step = "0.01"; priceInput.placeholder = "Your price"; priceInput.style.width = "110px";
  const noteInput = document.createElement("input");
  noteInput.className = "input"; noteInput.placeholder = "Note (optional)"; noteInput.style.width = "160px";
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-primary btn-sm";
  addBtn.textContent = "Set price";
  addBtn.addEventListener("click", async () => {
    const price = parseFloat(priceInput.value);
    if (isNaN(price)) { toast("Enter a price", { type: "danger" }); return; }
    const variant = variants.find((v) => v.variantId === select.value);
    const session = devAuth.getSession();
    const saved = await setClientOverride(accountId, client.id, select.value, price, noteInput.value, session?.actorLabel || "Rep");
    // Surface the database's own refusal instead of a generic "Failed to save":
    // it distinguishes "you aren't allowed to price for that client" from
    // "that product belongs to a different wholesaler", and the rep can act on
    // the difference.
    if (!saved.ok) { toast(saved.error || "Failed to save", { type: "danger" }); return; }
    const existingIdx = overrides.findIndex((o) => o.variantId === select.value);
    const newRow = { id: saved.id, variantId: select.value, overridePrice: price, note: noteInput.value, basePrice: variant.price, sku: variant.sku, productName: variant.productName, color: variant.color, size: variant.size };
    if (existingIdx >= 0) overrides[existingIdx] = newRow; else overrides.unshift(newRow);
    renderList();
    priceInput.value = ""; noteInput.value = "";
    toast("Price saved", { type: "success" });
  });
  if (!variants.length) {
    addRow.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">No products to price yet.</div>`;
  } else {
    addRow.appendChild(select);
    addRow.appendChild(priceInput);
    addRow.appendChild(noteInput);
    addRow.appendChild(addBtn);
  }
  panel.appendChild(addRow);
}

// ---------- Orders (rep's view of all orders for this wholesaler) ----------

async function ordersView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Orders", "All orders placed for this wholesaler."));

  const orders = await getWholesalerOrders(wid);
  if (!orders.length) {
    outlet.appendChild(emptyState({ icon: "🧾", title: "No orders yet", body: "Orders placed by clients (or on their behalf) will show up here." }));
    return;
  }
  const STATUS_BADGE = { new: "badge-info", confirmed: "badge-accent", shipped: "badge-warning", delivered: "badge-success", cancelled: "badge-danger" };
  orders.forEach((order) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;";
    card.innerHTML = `
      <div>
        <div style="font-weight:600;">${esc(order.buyerLabel)}</div>
        <div style="font-size:12px;color:var(--text-tertiary);">${new Date(order.createdAt).toLocaleDateString()} · ${order.items.length} line item(s)</div>
      </div>
      <div style="text-align:right;">
        <span class="badge ${STATUS_BADGE[order.status] || "badge-neutral"}">${order.status}</span>
        <div style="font-weight:700;">$${order.subtotal.toFixed(2)}</div>
      </div>
    `;
    outlet.appendChild(card);
  });
}

// ---------- Visit Log ----------

async function visitsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Visit Log", "Field visits recorded by the sales team."));

  const visits = await getVisits(wid);
  if (!visits.length) {
    outlet.appendChild(emptyState({ icon: "📍", title: "No visits logged yet", body: "Log a visit from My Clients to see it here." }));
    return;
  }
  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";
  visits.forEach((v) => {
    const row = document.createElement("div");
    row.style.cssText = "padding:12px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;">
        <strong>${esc(v.clientName)}</strong>
        <span style="font-size:12px;color:var(--text-tertiary);">${new Date(v.visitedAt).toLocaleString()}</span>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${esc(v.repLabel)}${v.note ? " — " + esc(v.note) : ""}</div>
    `;
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

export function registerSalespersonRoutes(router) {
  router.register("/sales", (outlet) => dashboard(outlet));
  router.register("/sales/clients", (outlet) => clientsView(outlet));
  router.register("/sales/orders", (outlet) => ordersView(outlet));
  router.register("/sales/visits", (outlet) => visitsView(outlet));
}
