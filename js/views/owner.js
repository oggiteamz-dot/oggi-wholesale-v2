// OGGI Wholesale v2 — Owner/Admin views (Batch 5: real cross-wholesaler data)
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { supabase, sbCall } from "../lib/supabase-client.js";
import {
  crossWholesalerStats, onboardingChecklist, universalSearch,
  listSignupRequests, approveSignupRequest, rejectSignupRequest, setWholesalerActive, getAuditLog, listInvites,
} from "../data/owner.js";
import { rowsToCsv, downloadCsv } from "../data/csv-export.js";

function pageHeader(title, desc, actionsHtml = "") {
  const el = document.createElement("div");
  el.className = "page-header";
  el.innerHTML = `<div class="page-title-group"><h1>${title}</h1><p>${desc}</p></div><div class="page-actions">${actionsHtml}</div>`;
  return el;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Dashboard ----------

async function dashboard(outlet) {
  outlet.appendChild(pageHeader("Owner Dashboard", "Cross-wholesaler overview — real aggregates across every wholesaler in the system."));

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const { totals, perWholesaler } = await crossWholesalerStats();
  loading.remove();

  const stats = document.createElement("div");
  stats.className = "stat-grid";
  [
    ["Active wholesalers", `${totals.activeWholesalers} / ${totals.wholesalers}`],
    ["Total orders", totals.orders],
    ["Total revenue", `$${totals.revenue.toFixed(0)}`],
    ["Total clients", totals.clients],
  ].forEach(([label, value]) => {
    const c = document.createElement("div");
    c.className = "card stat-card";
    c.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
    stats.appendChild(c);
  });
  outlet.appendChild(stats);

  if (!perWholesaler.length) {
    outlet.appendChild(emptyState({ icon: "◆", title: "No wholesalers yet", body: "Wholesalers will appear here once they're created." }));
    return;
  }

  const table = document.createElement("div");
  table.className = "card";
  table.style.padding = "8px";
  perWholesaler.forEach((w) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:650;">${esc(w.name)}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${w.wid}${w.active ? "" : " · <span style='color:var(--danger)'>inactive</span>"}</div>
      </div>
      <div style="text-align:right;width:110px;">
        <div style="font-size:12px;font-weight:600;">${w.orders} orders</div>
        <div style="font-size:11px;color:var(--text-tertiary);">$${w.revenue.toFixed(0)}</div>
      </div>
      <div style="text-align:right;width:110px;">
        <div style="font-size:12px;font-weight:600;">${w.products} products</div>
        <div style="font-size:11px;color:var(--text-tertiary);">${w.clients} clients</div>
      </div>
    `;
    table.appendChild(row);
  });
  outlet.appendChild(table);
}

// ---------- Universal Search ----------

async function searchView(outlet) {
  outlet.appendChild(pageHeader("Universal Search", "Search across wholesalers, products, and clients — real ILIKE queries against real tables."));

  const box = document.createElement("div");
  box.className = "card";
  box.style.cssText = "padding:16px;margin-bottom:16px;";
  box.innerHTML = `<input class="input" id="owner-search-input" placeholder="Search by name…" style="width:100%;max-width:400px;" />`;
  outlet.appendChild(box);

  const results = document.createElement("div");
  outlet.appendChild(results);

  function renderGroup(title, items, lineFn) {
    if (!items.length) return "";
    return `<div class="card" style="padding:8px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary);padding:8px 12px;">${title}</div>
      ${items.map((i) => `<div style="padding:10px 12px;border-top:1px solid var(--border-subtle);">${lineFn(i)}</div>`).join("")}
    </div>`;
  }

  let debounceTimer = null;
  box.querySelector("#owner-search-input").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    const q = e.target.value;
    debounceTimer = setTimeout(async () => {
      if (q.trim().length < 2) { results.innerHTML = ""; return; }
      results.innerHTML = `<div class="card" style="padding:16px;">Searching…</div>`;
      const { wholesalers, products, clients } = await universalSearch(q);
      if (!wholesalers.length && !products.length && !clients.length) {
        results.innerHTML = "";
        results.appendChild(emptyState({ icon: "🔍", title: "No matches", body: `Nothing found for "${esc(q)}".` }));
        return;
      }
      results.innerHTML =
        renderGroup("Wholesalers", wholesalers, (w) => `<strong>${esc(w.brand || w.name)}</strong> <span style="color:var(--text-tertiary);font-size:12px;">${w.wid}</span>`) +
        renderGroup("Products", products, (p) => `<strong>${esc(p.name)}</strong> <span style="color:var(--text-tertiary);font-size:12px;">wid: ${p.wid}</span>`) +
        renderGroup("Clients", clients, (c) => `<strong>${esc(c.shop_name)}</strong> <span style="color:var(--text-tertiary);font-size:12px;">wid: ${c.wid}</span>`);
    }, 300);
  });
}

// ---------- Wholesalers ----------

async function wholesalersView(outlet) {
  const session = devAuth.getSession();
  outlet.appendChild(pageHeader("Wholesalers", "Every wholesaler in the system, with real onboarding completion signals."));

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const { perWholesaler } = await crossWholesalerStats();
  loading.remove();

  if (!perWholesaler.length) {
    outlet.appendChild(emptyState({ icon: "🏢", title: "No wholesalers yet", body: "Nothing to show." }));
    return;
  }

  perWholesaler.forEach((w) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:16px;margin-bottom:12px;";
    const checklist = onboardingChecklist(w);
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-weight:650;font-size:15px;">${esc(w.name)} <span style="font-weight:400;color:var(--text-tertiary);font-size:12px;">${w.wid}</span></div>
          <span class="badge ${w.active ? "badge-success" : "badge-danger"}" style="margin-top:6px;">${w.active ? "Active" : "Inactive"}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="toggle">${w.active ? "Deactivate" : "Reactivate"}</button>
      </div>
      <div style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;">
        ${checklist.map((c) => `<div style="font-size:12px;color:${c.done ? "var(--success)" : "var(--text-tertiary)"};">${c.done ? "✓" : "○"} ${esc(c.label)}</div>`).join("")}
      </div>
    `;
    card.querySelector('[data-action="toggle"]').addEventListener("click", async () => {
      let reason = null;
      if (w.active) {
        reason = prompt(`Reason for deactivating ${w.name}? (recorded in the audit log)`, "");
        if (reason === null) return;
      }
      const { error } = await setWholesalerActive(w.wid, !w.active, reason, session?.actorLabel || "Owner");
      if (error) { toast("Could not update wholesaler status", { type: "danger" }); return; }
      toast(`${w.name} ${w.active ? "deactivated" : "reactivated"}`, { type: "success" });
      outlet.innerHTML = "";
      wholesalersView(outlet);
    });
    outlet.appendChild(card);
  });
}

// ---------- Onboarding Queue ----------

async function onboardingView(outlet) {
  const session = devAuth.getSession();
  outlet.appendChild(pageHeader("Onboarding Queue", "Pending signup requests from prospective buyers."));

  const requests = await listSignupRequests("pending");
  if (!requests.length) {
    outlet.appendChild(emptyState({ icon: "✅", title: "Queue is empty", body: "No pending signup requests right now." }));
    return;
  }

  requests.forEach((r) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;";
    card.innerHTML = `
      <div>
        <div style="font-weight:650;">${esc(r.buyer_name)}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${esc(r.location || "—")} · Volume: ${esc(r.volume || "—")} · Sells: ${esc(r.sells || "—")}</div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">Requested wid: ${esc(r.wid || "—")} · ${new Date(r.created_at).toLocaleDateString()}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" data-action="reject">Reject</button>
        <button class="btn btn-primary btn-sm" data-action="approve">Approve</button>
      </div>
    `;
    card.querySelector('[data-action="approve"]').addEventListener("click", async () => {
      const btn = card.querySelector('[data-action="approve"]');
      btn.disabled = true;
      btn.textContent = "Approving…";
      const result = await approveSignupRequest(r.id);
      if (!result.ok) {
        toast(result.error || "Could not approve request", { type: "danger" });
        btn.disabled = false;
        btn.textContent = "Approve";
        return;
      }
      // Batch 14: approving now provisions a REAL buyer login (v2_clients
      // + v2_portal_accounts), and the generated password is returned
      // exactly once in this response -- there is no email
      // infrastructure yet, so it must be shown here and relayed to the
      // buyer out-of-band by whoever approved the request. Replacing the
      // card (rather than a toast, which auto-dismisses) is deliberate:
      // this is the ONLY moment this password will ever be visible again.
      card.innerHTML = `
        <div style="width:100%;">
          <div style="font-weight:650;margin-bottom:6px;">✅ ${esc(r.buyer_name)} approved — account created</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">Save these credentials now — the password will not be shown again. Relay them to the buyer yourself (no email is sent automatically).</div>
          <div style="display:flex;gap:16px;font-family:monospace;font-size:13px;background:var(--surface-sunken,#f7f7f5);border-radius:8px;padding:10px 12px;">
            <div><span style="color:var(--text-tertiary);">Username:</span> <strong>${esc(result.username)}</strong></div>
            <div><span style="color:var(--text-tertiary);">Password:</span> <strong>${esc(result.tempPassword)}</strong></div>
          </div>
          <button class="btn btn-secondary btn-sm" data-action="dismiss" style="margin-top:10px;">Done</button>
        </div>
      `;
      card.querySelector('[data-action="dismiss"]').addEventListener("click", () => card.remove());
    });
    card.querySelector('[data-action="reject"]').addEventListener("click", async () => {
      if (!confirm(`Reject ${r.buyer_name}'s request?`)) return;
      await rejectSignupRequest(r.id, session?.actorLabel || "Owner");
      toast(`${r.buyer_name} rejected`, { type: "default" });
      card.remove();
    });
    outlet.appendChild(card);
  });
}

// ---------- Invites (Batch 14) ----------
//
// The only path to becoming an owner or wholesaler account (v2_invites,
// redeemed via the login screen's "I have an invite code" step). Only
// an owner can mint these (enforced inside v2_create_invite itself, not
// just by hiding this screen -- a wholesaler navigating here directly
// would still be rejected server-side). Codes are shown once at
// creation and remain visible in the list below (unlike a portal
// account's password, an invite code isn't a secret credential by
// itself -- it grants a signup, not direct access to anything -- so
// re-displaying it is fine and lets the owner resend a code they lost).

async function invitesView(outlet) {
  outlet.appendChild(pageHeader("Invites", "Invite-only onboarding: the only way a new owner or wholesaler account can be created."));

  const formCard = document.createElement("div");
  formCard.className = "card";
  formCard.style.cssText = "padding:16px;margin-bottom:16px;";
  formCard.innerHTML = `
    <div style="font-weight:650;margin-bottom:10px;">Create a new invite</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div>
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Role</label>
        <select class="input" id="inv-role" style="width:160px;">
          <option value="wholesaler">Wholesaler</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <div id="inv-wid-group">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Wholesaler (wid)</label>
        <select class="input" id="inv-wid" style="width:220px;"></select>
      </div>
      <div>
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Display name (optional)</label>
        <input class="input" id="inv-name" style="width:220px;" placeholder="shown to the person redeeming it" />
      </div>
      <button class="btn btn-primary" id="inv-create">Create invite</button>
    </div>
    <div id="inv-result" style="margin-top:12px;"></div>
  `;
  outlet.appendChild(formCard);

  // Event listeners are attached IMMEDIATELY, synchronously, right after
  // the form is in the DOM -- not after the wholesalers dropdown finishes
  // loading. A slow/failed fetch must never leave the Create button
  // silently dead (found live: the button looked clickable but did
  // nothing until the network call resolved, because the listener used
  // to be attached only after that awaited fetch completed).
  const widSelect = formCard.querySelector("#inv-wid");
  widSelect.innerHTML = `<option value="">Loading…</option>`;
  const roleSelect = formCard.querySelector("#inv-role");
  const widGroup = formCard.querySelector("#inv-wid-group");
  roleSelect.addEventListener("change", () => {
    widGroup.style.display = roleSelect.value === "wholesaler" ? "" : "none";
  });

  sbCall(supabase.from("v2_wholesalers").select("wid,brand,name").order("brand", { ascending: true })).then(({ data: wholesalers }) => {
    widSelect.innerHTML = (wholesalers || []).map((w) => `<option value="${esc(w.wid)}">${esc(w.brand || w.name)} (${esc(w.wid)})</option>`).join("") || `<option value="">No wholesalers yet</option>`;
  });

  formCard.querySelector("#inv-create").addEventListener("click", async () => {
    const btn = formCard.querySelector("#inv-create");
    const role = roleSelect.value;
    const wid = role === "wholesaler" ? widSelect.value : null;
    if (role === "wholesaler" && !wid) { toast("No wholesaler selected", { type: "danger" }); return; }
    btn.disabled = true;
    btn.textContent = "Creating…";
    const result = await devAuth.createInvite(role, wid, formCard.querySelector("#inv-name").value.trim() || null);
    btn.disabled = false;
    btn.textContent = "Create invite";
    if (!result.ok) { toast(result.error || "Could not create invite", { type: "danger" }); return; }
    formCard.querySelector("#inv-result").innerHTML = `
      <div style="font-family:monospace;font-size:13px;background:var(--surface-sunken,#f7f7f5);border-radius:8px;padding:10px 12px;">
        Invite code: <strong>${esc(result.code)}</strong>
      </div>
    `;
    toast("Invite created", { type: "success" });
    // Refresh the list BELOW so the new invite shows up there too --
    // deliberately does NOT touch formCard, so the one-time "here's your
    // code" box above stays visible instead of being wiped out by a full
    // re-render a moment after it appears (a real bug caught live: the
    // success message used to vanish almost instantly because the whole
    // outlet, including the box that was just written, got nuked and
    // rebuilt from scratch).
    refreshInvitesList();
  });

  const listCard = document.createElement("div");
  listCard.className = "card";
  listCard.style.padding = "8px";
  outlet.appendChild(listCard);

  async function refreshInvitesList() {
    const invites = await listInvites();
    listCard.innerHTML = "";
    if (!invites.length) {
      listCard.innerHTML = `<div style="padding:16px;color:var(--text-tertiary);font-size:13px;">No invites created yet.</div>`;
      return;
    }
    invites.forEach((inv) => {
      const isExpired = new Date(inv.expires_at) < new Date();
      const status = inv.used_by ? "Used" : isExpired ? "Expired" : "Pending";
      const statusColor = inv.used_by ? "var(--text-tertiary)" : isExpired ? "var(--danger-600,#b3261e)" : "var(--success-700,#027A48)";
      const row = document.createElement("div");
      row.style.cssText = "padding:12px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;gap:12px;";
      row.innerHTML = `
        <div>
          <div style="font-family:monospace;font-size:13px;">${esc(inv.code)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${esc(inv.role)}${inv.wid ? " · " + esc(inv.wid) : ""}${inv.wholesaler_name ? " · " + esc(inv.wholesaler_name) : ""}</div>
        </div>
        <div style="font-size:12px;color:${statusColor};font-weight:600;">${status}</div>
      `;
      listCard.appendChild(row);
    });
  }

  await refreshInvitesList();
}

// ---------- Exports ----------

async function exportsView(outlet) {
  outlet.appendChild(pageHeader("Exports", "Download real data as CSV — generated client-side from the live database."));

  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:12px;align-items:flex-start;";

  const exportsList = [
    {
      label: "Export all products (CSV)",
      run: async () => {
        const { data } = await sbCall(supabase.from("v2_products").select("id,wid,name,archived,created_at"));
        return rowsToCsv(data || [], [
          { label: "ID", value: (r) => r.id }, { label: "Wid", value: (r) => r.wid },
          { label: "Name", value: (r) => r.name }, { label: "Archived", value: (r) => r.archived },
          { label: "Created", value: (r) => r.created_at },
        ]);
      },
      filename: "products.csv",
    },
    {
      label: "Export all clients (CSV)",
      run: async () => {
        const { data } = await sbCall(supabase.from("v2_clients").select("id,wid,shop_name,phone,discount_pct,active,created_at"));
        return rowsToCsv(data || [], [
          { label: "ID", value: (r) => r.id }, { label: "Wid", value: (r) => r.wid },
          { label: "Shop", value: (r) => r.shop_name }, { label: "Phone", value: (r) => r.phone },
          { label: "Discount %", value: (r) => r.discount_pct }, { label: "Active", value: (r) => r.active },
          { label: "Created", value: (r) => r.created_at },
        ]);
      },
      filename: "clients.csv",
    },
    {
      label: "Export all orders (CSV)",
      run: async () => {
        const { data } = await sbCall(supabase.from("v2_orders").select("id,wid,buyer_label,status,subtotal,created_at"));
        return rowsToCsv(data || [], [
          { label: "ID", value: (r) => r.id }, { label: "Wid", value: (r) => r.wid },
          { label: "Buyer", value: (r) => r.buyer_label }, { label: "Status", value: (r) => r.status },
          { label: "Subtotal", value: (r) => r.subtotal }, { label: "Created", value: (r) => r.created_at },
        ]);
      },
      filename: "orders.csv",
    },
  ];

  exportsList.forEach((ex) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = ex.label;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        const csv = await ex.run();
        downloadCsv(ex.filename, csv);
        toast(`${ex.filename} downloaded`, { type: "success" });
      } finally {
        btn.disabled = false;
        btn.textContent = ex.label;
      }
    });
    card.appendChild(btn);
  });

  outlet.appendChild(card);
}

// ---------- Audit Log ----------

async function auditView(outlet) {
  outlet.appendChild(pageHeader("Audit Log", "Append-only record of owner actions — nothing here can be edited or deleted after the fact."));

  const entries = await getAuditLog(100);
  if (!entries.length) {
    outlet.appendChild(emptyState({ icon: "🕓", title: "No audit entries yet", body: "Actions like deactivating a wholesaler or reviewing a signup request will appear here." }));
    return;
  }

  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";
  entries.forEach((e) => {
    const row = document.createElement("div");
    row.style.cssText = "padding:12px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;">
        <strong>${esc(e.action)}</strong>
        <span style="font-size:12px;color:var(--text-tertiary);">${new Date(e.created_at).toLocaleString()}</span>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">
        ${esc(e.actor_label)}${e.target_id ? " → " + esc(e.target_type) + " " + esc(e.target_id) : ""}
        ${e.details && Object.keys(e.details).length ? " · " + esc(JSON.stringify(e.details)) : ""}
      </div>
    `;
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

export function registerOwnerRoutes(router) {
  router.register("/owner", (outlet) => dashboard(outlet));
  router.register("/owner/search", (outlet) => searchView(outlet));
  router.register("/owner/wholesalers", (outlet) => wholesalersView(outlet));
  router.register("/owner/onboarding", (outlet) => onboardingView(outlet));
  router.register("/owner/invites", (outlet) => invitesView(outlet));
  router.register("/owner/exports", (outlet) => exportsView(outlet));
  router.register("/owner/audit", (outlet) => auditView(outlet));
}
