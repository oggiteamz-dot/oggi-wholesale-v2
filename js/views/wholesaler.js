// OGGI Wholesale v2 — Wholesaler views (Batch 3: real orders, products, inventory)
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { getWholesaler } from "../data/catalog.js";
import { getWholesalerOrders, advanceOrderStatus, nextStatus } from "../data/wholesaler-orders.js";
import { listProductsForAdmin, toggleArchived, bulkUpdatePrice, duplicateAsTemplate } from "../data/products-admin.js";
import { getStockTable, receiveStock, adjustStock, getLocations } from "../data/inventory-admin.js";
import { getProductPricing, setProductMoq, addTier, removeTier, setVariantMoq, setVariantRetailPrice, setVariantReorderSettings, setVariantBarcode, setVariantImages, getOrderMinimums, setOrderMinimums } from "../data/pricing-admin.js";
import { listPacksForProduct, createPack, archivePack, suggestPackRatio } from "../data/prepacks.js";
import { getWholesalerSettings, updateWholesalerSettings } from "../data/wholesaler-settings.js";
import { getReorderSuggestions, getInventoryIntelligenceReport, getCycleCountSchedule, logCycleCount } from "../data/inventory-intelligence.js";
import { recordReceiptCost } from "../data/landed-cost.js";
import { listKits, createKit, archiveKit, assembleKit } from "../data/kits.js";
import { getClientsByRecency, addClient, deactivateClient, coverageSnapshot } from "../data/clients.js";
import { listCatalogs, getCatalogProducts, createCatalog, getDefaultCatalog,
         addProductToCatalog, removeProductFromCatalog } from "../data/catalogs.js";
import { createProduct } from "../data/products-admin.js";
import { renderProductForm } from "../components/product-form.js";
import { listSuppliers, createSupplier, updateSupplier, archiveSupplier, restoreSupplier, supplierProductCounts } from "../data/suppliers.js";
import { listLocations, locationStockTotals, createLocation, renameLocation,
         setDefaultLocation, archiveLocation, transferStock } from "../data/locations.js";
import { listPortalAccounts, setPortalAccountActive } from "../data/team.js";

import { renderDateRangeFilter } from "../components/date-range-filter.js";
import { renderLineChart, renderBarChart } from "../components/chart.js";
import { getWholesalerSummary, getTopProducts, getTopClients, getSalesSeries } from "../data/owner-analytics.js";

import { esc, money, pageHeader } from "../lib/utils.js";
// ---------- Dashboard ----------

// =============================================================================
// DASHBOARD  (rebuilt 18 Aug 2026)
// =============================================================================
// Hadi's ask, verbatim: "Total orders, revenue, and clients -- these should be
// their own, like build a dashboard, to be wholesaler specific."
//
// Those three lived only on the OWNER dashboard, where they are platform-wide
// totals summed across every wholesaler. This screen previously showed open
// orders, variants tracked, low stock and out of stock: useful operationally,
// and completely silent about money.
//
// WHERE THE NUMBERS COME FROM, AND WHERE THEY DO NOT
// --------------------------------------------------
// Every commercial figure here comes from the SQL functions in migration 039,
// through js/data/owner-analytics.js. NOTHING on this screen re-computes a
// total in JavaScript. That is not tidiness -- it is the reason the owner's
// drill-down and this dashboard cannot ever quote different revenue for the
// same month. Migration 044 changed those functions' guard from "is the owner"
// to "is the owner, or is this your own wid", specifically so both screens
// could share one definition instead of growing two.
//
// If you are about to add a figure here, add it to 039 and read it back. The
// moment a total is summed in this file, it is a second opinion.
//
// The operational stats are KEPT, below the commercial ones. They answer a
// different question -- "what do I need to do today" rather than "how is the
// business doing" -- and deleting them to make room would be a regression
// dressed up as a redesign.
//
// TIME FRAME
// ----------
// Reuses js/components/date-range-filter.js exactly as the owner drill-down
// does: today, this week, this month, 6 months, this year, lifetime, custom.
// Its `bucketForRange` picks the chart granularity, so a lifetime view draws
// months and a week draws days without this file deciding anything.
// =============================================================================

async function dashboard(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader(
    `${session.wholesalerName || wid} — Dashboard`,
    "Your orders, revenue and clients. Everything here is yours alone."
  ));

  // --- the time frame drives everything commercial on the page ---
  const commercial = document.createElement("div");
  const filter = renderDateRangeFilter({
    initial: "30d",
    onChange: (range) => paintCommercial(commercial, wid, range, session),
  });
  outlet.appendChild(filter.el);
  outlet.appendChild(commercial);

  // Mount with the default range. Deliberately not awaited before the
  // operational block below renders: the two halves load independently, so a
  // slow analytics query does not hold back the low-stock counts.
  filter.trigger();

  await paintOperational(outlet, wid);
}

/** Headline figures + charts for the chosen window. Re-runs on every range
 *  change, so it fully replaces its container rather than appending. */
async function paintCommercial(host, wid, range, session) {
  host.innerHTML = `<div class="card" style="padding:16px;font-size:13px;color:var(--text-tertiary);">Loading your figures…</div>`;

  const currency = session.currency || "$";
  const [summary, series, products, clients] = await Promise.all([
    getWholesalerSummary(wid, range),
    getSalesSeries(wid, { ...range, bucket: range.bucket }),
    getTopProducts(wid, { ...range, limit: 8 }),
    getTopClients(wid, { ...range, limit: 8 }),
  ]);

  host.innerHTML = "";

  if (!summary.ok) {
    host.appendChild(emptyState({
      icon: "⚠️", title: "Could not load your figures", body: summary.error,
    }));
    return;
  }

  const fmt = (n) => currency + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

  // The three Hadi named come first, in the order he named them.
  const stats = document.createElement("div");
  stats.className = "stat-grid";
  [
    ["Total orders", String(summary.orders)],
    ["Revenue", fmt(summary.revenue)],
    ["Clients", String(summary.clientsTotal)],
    ["Average order", fmt(summary.avgOrder)],
    ["Units sold", String(summary.units)],
    // Shown as a count, not a bare percentage: "3 cancelled" is actionable
    // where "12.5%" of eight orders reads as a trend that isn't there.
    ["Cancelled", String(summary.cancelled)],
  ].forEach(([label, value]) => {
    const c = document.createElement("div");
    c.className = "card stat-card";
    c.innerHTML = `<div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>`;
    stats.appendChild(c);
  });
  host.appendChild(stats);

  // An honest word about an empty window. "0 orders" for a range with no
  // trading is a fact; showing charts of nothing underneath it is noise.
  if (!summary.orders) {
    host.appendChild(emptyState({
      icon: "◆",
      title: `No orders in ${range.label.toLowerCase()}`,
      body: summary.clientsTotal
        ? `You have ${summary.clientsTotal} client${summary.clientsTotal === 1 ? "" : "s"} set up. Nothing was ordered in this period — try a wider time frame.`
        : "Once buyers start ordering from your catalogue, revenue and top products appear here.",
    }));
    return;
  }

  host.appendChild(chartCard(
    "Revenue over time",
    "Every period is drawn, including the ones with no sales — a gap would imply orders that never happened.",
    renderLineChart({
      buckets: series.rows.map((r) => r.at),
      series: [{ name: "Revenue", points: series.rows.map((r) => r.revenue) }],
      currency,
    })
  ));

  if (products.rows.length) {
    host.appendChild(chartCard(
      "Top products",
      "By revenue in this period. Hover a bar for units and order count.",
      renderBarChart({
        currency,
        rows: products.rows.map((r) => ({
          label: r.name,
          value: r.revenue,
          detail: [["Units", String(r.units)], ["Orders", String(r.orders)],
                   ["Share", `${r.pctOfRevenue.toFixed(1)}%`]],
        })),
      })
    ));
  }

  if (clients.rows.length) {
    host.appendChild(chartCard(
      "Top clients",
      "By revenue in this period.",
      renderBarChart({
        currency,
        rows: clients.rows.map((r) => ({
          label: r.shopName || "Unnamed client",
          value: r.revenue,
          detail: [["Orders", String(r.orders)],
                   ["Average", currency + r.avgOrder.toFixed(0)],
                   ["Share", `${r.pctOfRevenue.toFixed(1)}%`]],
        })),
      })
    ));
  }
}

/** The operational half: what needs doing today. Unchanged in substance from
 *  the original dashboard -- these counts were already correct and already
 *  scoped to this wholesaler. */
async function paintOperational(outlet, wid) {
  const [orders, stock] = await Promise.all([getWholesalerOrders(wid), getStockTable(wid)]);
  const openOrders = orders.filter((o) => o.status !== "delivered" && o.status !== "cancelled").length;
  const lowStockCount = stock.filter((s) => s.available > 0 && s.available <= 15).length;
  const outOfStockCount = stock.filter((s) => s.available <= 0).length;

  const wrap = document.createElement("section");
  wrap.className = "card detail-card";
  wrap.innerHTML = `<header class="detail-card-head">
      <h3>Needs attention</h3>
      <p>Live right now, not filtered by the time frame above — an order waiting to ship is waiting regardless of which month you are looking at.</p>
    </header>`;
  const body = document.createElement("div");
  body.className = "detail-card-body";

  const stats = document.createElement("div");
  stats.className = "stat-grid";
  [
    ["Open orders", openOrders],
    ["Variants tracked", stock.length],
    ["Low stock", lowStockCount],
    ["Out of stock", outOfStockCount],
  ].forEach(([label, value]) => {
    const c = document.createElement("div");
    c.className = "card stat-card";
    c.innerHTML = `<div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>`;
    stats.appendChild(c);
  });
  body.appendChild(stats);
  wrap.appendChild(body);
  outlet.appendChild(wrap);
}

/** A titled card wrapping a chart. Local on purpose: owner-wholesaler-detail.js
 *  has its own `card()` helper, and importing across two view files to save six
 *  lines is how this codebase ended up with pageHeader in seven copies. If a
 *  third view wants this, it graduates to js/components/. */
function chartCard(title, subtitle, chartEl) {
  const el = document.createElement("section");
  el.className = "card detail-card";
  el.innerHTML = `<header class="detail-card-head">
      <h3>${esc(title)}</h3>
      <p>${esc(subtitle)}</p>
    </header>`;
  const body = document.createElement("div");
  body.className = "detail-card-body";
  body.appendChild(chartEl);
  el.appendChild(body);
  return el;
}

// ---------- Orders (fulfillment ladder) ----------

async function ordersView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Orders", "Move orders through the fulfillment ladder: new → confirmed → shipped → delivered."));

  const orders = await getWholesalerOrders(wid);
  if (!orders.length) {
    outlet.appendChild(emptyState({ icon: "📥", title: "No orders yet", body: "Orders placed against this wholesaler's catalog will show up here." }));
    return;
  }

  const STATUS_BADGE = { new: "badge-info", confirmed: "badge-accent", shipped: "badge-warning", delivered: "badge-success", cancelled: "badge-danger" };

  orders.forEach((order) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:16px;margin-bottom:12px;";
    const next = nextStatus(order.status);
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div>
          <div style="font-weight:650;">${esc(order.buyerLabel)}</div>
          <div style="font-size:12px;color:var(--text-tertiary);">${new Date(order.createdAt).toLocaleString()}</div>
        </div>
        <div style="text-align:right;">
          <span class="badge ${STATUS_BADGE[order.status] || "badge-neutral"}">${order.status}</span>
          <div style="font-weight:700;margin-top:4px;">$${order.subtotal.toFixed(2)}</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">${order.items.map((i) => i.isPack ? `${i.packQty}× ${esc(i.productName)} pack` : `${i.qty}× ${esc(i.productName)} (${esc(i.color)}/${esc(i.size)})`).join(", ")}</div>
    `;
    if (next) {
      const btn = document.createElement("button");
      btn.className = "btn btn-primary btn-sm";
      btn.textContent = `Mark ${next}`;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { error } = await advanceOrderStatus(order.id, next);
        if (error) { toast("Failed to update order status", { type: "danger" }); btn.disabled = false; return; }
        toast(`Order marked ${next}`, { type: "success" });
        outlet.innerHTML = "";
        ordersView(outlet);
      });
      card.appendChild(btn);
    }
    // Batch 10: scan-to-pick checklist, offered once an order is confirmed
    // (the natural point to physically pull and pack it before shipping).
    // Independent of the "Mark shipped" button above -- a wholesaler who
    // doesn't use scan-picking can still advance status manually exactly as
    // before; this is an additional, optional path, not a replacement.
    if (order.status === "confirmed" || order.status === "shipped") {
      const pickLink = document.createElement("a");
      pickLink.className = "btn btn-secondary btn-sm";
      pickLink.style.marginLeft = "8px";
      pickLink.href = `#/wholesaler/pick/${order.id}`;
      pickLink.textContent = "Scan to pick";
      card.appendChild(pickLink);
    }
    outlet.appendChild(card);
  });
}

// ---------- Products ----------

async function productsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Products", "Archive, duplicate as template, or apply a bulk price change."));

  const products = await listProductsForAdmin(wid);
  if (!products.length) {
    outlet.appendChild(emptyState({ icon: "📦", title: "No products yet", body: "Products migrated from your existing catalog, or added later, will appear here." }));
    return;
  }

  const table = document.createElement("div");
  table.className = "card";
  table.style.padding = "8px";

  function row(p) {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";
    r.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;">${esc(p.name)}${p.archived ? ' <span class="badge badge-neutral">Archived</span>' : ""}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${p.variantCount} variants · ${p.totalOnHand} units on hand · $${p.priceRange[0].toFixed(2)}–$${p.priceRange[1].toFixed(2)}</div>
      </div>
    `;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;";

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "btn btn-secondary btn-sm";
    archiveBtn.textContent = p.archived ? "Unarchive" : "Archive";
    archiveBtn.addEventListener("click", async () => {
      await toggleArchived(p.id, !p.archived);
      toast(p.archived ? "Unarchived" : "Archived", { type: "success" });
      outlet.innerHTML = "";
      productsView(outlet);
    });

    const dupBtn = document.createElement("button");
    dupBtn.className = "btn btn-secondary btn-sm";
    dupBtn.textContent = "Duplicate as template";
    dupBtn.addEventListener("click", async () => {
      dupBtn.disabled = true;
      const result = await duplicateAsTemplate(p.id);
      dupBtn.disabled = false;
      toast(result.ok ? "Template created (archived, zero stock — edit and publish when ready)" : "Duplicate failed", { type: result.ok ? "success" : "danger" });
      if (result.ok) { outlet.innerHTML = ""; productsView(outlet); }
    });

    const pricingBtn = document.createElement("button");
    pricingBtn.className = "btn btn-secondary btn-sm";
    pricingBtn.textContent = "Pricing & MOQ";

    const packsBtn = document.createElement("button");
    packsBtn.className = "btn btn-secondary btn-sm";
    packsBtn.textContent = "Packs";

    actions.appendChild(packsBtn);
    actions.appendChild(pricingBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(dupBtn);
    r.appendChild(actions);

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;width:100%;";
    wrap.appendChild(r);

    const panel = document.createElement("div");
    panel.style.cssText = "display:none;padding:14px 16px 16px 16px;background:var(--surface-sunken,#f7f7f5);border-bottom:1px solid var(--border-subtle);";
    wrap.appendChild(panel);

    let panelLoaded = false;
    pricingBtn.addEventListener("click", async () => {
      const isOpen = panel.style.display === "block";
      panel.style.display = isOpen ? "none" : "block";
      if (isOpen || panelLoaded) return;
      panelLoaded = true;
      panel.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">Loading…</div>`;
      await renderPricingPanel(panel, p);
    });

    const packsPanel = document.createElement("div");
    packsPanel.style.cssText = "display:none;padding:14px 16px 16px 16px;background:var(--surface-sunken,#f7f7f5);border-bottom:1px solid var(--border-subtle);";
    wrap.appendChild(packsPanel);

    packsBtn.addEventListener("click", async () => {
      const isOpen = packsPanel.style.display === "block";
      packsPanel.style.display = isOpen ? "none" : "block";
      if (isOpen) return;
      packsPanel.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">Loading…</div>`;
      await renderPacksPanel(packsPanel, wid, p);
    });

    return wrap;
  }

  products.forEach((p) => table.appendChild(row(p)));
  outlet.appendChild(table);

  // Bulk price update
  const bulkCard = document.createElement("div");
  bulkCard.className = "card";
  bulkCard.style.cssText = "margin-top:16px;padding:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
  bulkCard.innerHTML = `<strong style="font-size:13px;">Bulk price update (all products):</strong>`;
  const pctInput = document.createElement("input");
  pctInput.className = "input"; pctInput.type = "number"; pctInput.placeholder = "e.g. 10 or -15"; pctInput.style.width = "120px";
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-sm";
  applyBtn.textContent = "Apply %";
  applyBtn.addEventListener("click", async () => {
    const pct = parseFloat(pctInput.value);
    if (isNaN(pct)) { toast("Enter a percentage first", { type: "danger" }); return; }
    const allVariantIds = products.flatMap((p) => p.variants.map((v) => v.id));
    applyBtn.disabled = true;
    const result = await bulkUpdatePrice(allVariantIds, pct);
    applyBtn.disabled = false;
    toast(result.ok ? `Updated ${result.count} variant prices by ${pct}%` : "Bulk update failed", { type: result.ok ? "success" : "danger" });
    if (result.ok) { outlet.innerHTML = ""; productsView(outlet); }
  });
  bulkCard.appendChild(pctInput);
  bulkCard.appendChild(applyBtn);
  outlet.appendChild(bulkCard);

  // Order-level minimums (Batch 6) -- wholesaler-wide, not per-product.
  const orderMinCard = document.createElement("div");
  orderMinCard.className = "card";
  orderMinCard.style.cssText = "margin-top:12px;padding:16px;display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;";
  const mins = await getOrderMinimums(wid);
  orderMinCard.innerHTML = `
    <strong style="font-size:13px;width:100%;">Order-level minimum (applies to every order placed with you):</strong>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Min units total</label><input class="input" id="order-min-qty" type="number" min="1" value="${mins.orderMinQty ?? ""}" placeholder="none" style="width:110px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Min order value</label><input class="input" id="order-min-value" type="number" min="0" step="0.01" value="${mins.orderMinValue ?? ""}" placeholder="none" style="width:110px;" /></div>
  `;
  const saveOrderMinBtn = document.createElement("button");
  saveOrderMinBtn.className = "btn btn-primary btn-sm";
  saveOrderMinBtn.textContent = "Save";
  saveOrderMinBtn.addEventListener("click", async () => {
    const orderMinQty = orderMinCard.querySelector("#order-min-qty").value;
    const orderMinValue = orderMinCard.querySelector("#order-min-value").value;
    const { error } = await setOrderMinimums(wid, {
      orderMinQty: orderMinQty === "" ? null : parseInt(orderMinQty, 10),
      orderMinValue: orderMinValue === "" ? null : parseFloat(orderMinValue),
    });
    toast(error ? "Failed to save" : "Order minimum saved", { type: error ? "danger" : "success" });
  });
  orderMinCard.appendChild(saveOrderMinBtn);
  outlet.appendChild(orderMinCard);
}

// ---------- Pricing & MOQ panel (Batch 6, per-product) ----------

async function renderPricingPanel(panel, product) {
  const pricing = await getProductPricing(product.id);
  panel.innerHTML = "";

  const moqRow = document.createElement("div");
  moqRow.style.cssText = "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;";
  moqRow.innerHTML = `
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Product MOQ (first order, aggregated across colours/sizes)</label>
      <input class="input" id="moq-first" type="number" min="1" value="${pricing.moqQty}" style="width:100px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Reorder MOQ (optional, usually lower)</label>
      <input class="input" id="moq-reorder" type="number" min="1" value="${pricing.moqReorderQty ?? ""}" style="width:100px;" placeholder="same as above" /></div>
  `;
  const saveMoqBtn = document.createElement("button");
  saveMoqBtn.className = "btn btn-primary btn-sm";
  saveMoqBtn.textContent = "Save MOQ";
  saveMoqBtn.addEventListener("click", async () => {
    const moqQty = parseInt(panel.querySelector("#moq-first").value, 10) || 1;
    const reorderRaw = panel.querySelector("#moq-reorder").value;
    const moqReorderQty = reorderRaw === "" ? null : parseInt(reorderRaw, 10);
    const { error } = await setProductMoq(product.id, { moqQty, moqReorderQty });
    toast(error ? "Failed to save MOQ" : "MOQ saved", { type: error ? "danger" : "success" });
  });
  moqRow.appendChild(saveMoqBtn);
  panel.appendChild(moqRow);

  const tierHeader = document.createElement("div");
  tierHeader.style.cssText = "font-size:12px;font-weight:650;margin-bottom:6px;";
  tierHeader.textContent = "Volume price tiers (all-units — the whole order gets the matching tier's price once the threshold is reached, aggregated across colours/sizes)";
  panel.appendChild(tierHeader);

  const tierList = document.createElement("div");
  tierList.style.cssText = "margin-bottom:10px;";
  function renderTiers() {
    tierList.innerHTML = pricing.tiers.length
      ? ""
      : `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px;">No tiers yet — full-price only.</div>`;
    pricing.tiers.forEach((t) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;font-size:13px;padding:4px 0;";
      row.innerHTML = `<div style="flex:1;">Buy <strong>${t.minQty}+</strong> units → <strong>$${t.unitPrice.toFixed(2)}</strong>/unit</div>`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "btn btn-ghost btn-sm";
      rmBtn.textContent = "Remove";
      rmBtn.addEventListener("click", async () => {
        await removeTier(t.id);
        pricing.tiers = pricing.tiers.filter((x) => x.id !== t.id);
        renderTiers();
        toast("Tier removed", { type: "success" });
      });
      row.appendChild(rmBtn);
      tierList.appendChild(row);
    });
  }
  renderTiers();
  panel.appendChild(tierList);

  const addTierRow = document.createElement("div");
  addTierRow.style.cssText = "display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;";
  addTierRow.innerHTML = `
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Min qty</label><input class="input" id="tier-qty" type="number" min="1" style="width:90px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Unit price</label><input class="input" id="tier-price" type="number" min="0" step="0.01" style="width:100px;" /></div>
  `;
  const addTierBtn = document.createElement("button");
  addTierBtn.className = "btn btn-secondary btn-sm";
  addTierBtn.textContent = "Add tier";
  addTierBtn.addEventListener("click", async () => {
    const minQty = parseInt(panel.querySelector("#tier-qty").value, 10);
    const unitPrice = parseFloat(panel.querySelector("#tier-price").value);
    if (!minQty || isNaN(unitPrice)) { toast("Enter a min qty and unit price", { type: "danger" }); return; }
    const { data, error } = await addTier(product.id, minQty, unitPrice);
    if (error) { toast(error.message?.includes("duplicate") ? "A tier at that min qty already exists" : "Failed to add tier", { type: "danger" }); return; }
    pricing.tiers.push({ id: data[0]?.id, minQty, unitPrice });
    pricing.tiers.sort((a, b) => a.minQty - b.minQty);
    renderTiers();
    panel.querySelector("#tier-qty").value = "";
    panel.querySelector("#tier-price").value = "";
    toast("Tier added", { type: "success" });
  });
  addTierRow.appendChild(addTierBtn);
  panel.appendChild(addTierRow);

  const skuHeader = document.createElement("div");
  skuHeader.style.cssText = "font-size:12px;font-weight:650;margin-bottom:6px;";
  skuHeader.textContent = "Per-SKU minimum order qty & retail price (MSRP, for margin display)";
  panel.appendChild(skuHeader);

  const skuTable = document.createElement("div");
  pricing.variants.forEach((v) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;font-size:12px;padding:4px 0;";
    row.innerHTML = `<div style="flex:1;">${esc(v.sku)} <span style="color:var(--text-tertiary);">(${esc(v.color)}/${esc(v.size)}) · $${v.price.toFixed(2)} wholesale</span></div>`;
    const moqInput = document.createElement("input");
    moqInput.className = "input"; moqInput.type = "number"; moqInput.min = "1"; moqInput.value = v.moqQty; moqInput.style.width = "70px"; moqInput.title = "SKU MOQ";
    moqInput.addEventListener("change", async () => {
      const q = parseInt(moqInput.value, 10) || 1;
      const { error } = await setVariantMoq(v.id, q);
      toast(error ? "Failed to save" : "SKU MOQ saved", { type: error ? "danger" : "success" });
    });
    const retailInput = document.createElement("input");
    retailInput.className = "input"; retailInput.type = "number"; retailInput.min = "0"; retailInput.step = "0.01";
    retailInput.value = v.retailPrice ?? ""; retailInput.placeholder = "MSRP"; retailInput.style.width = "90px";
    retailInput.addEventListener("change", async () => {
      const val = retailInput.value === "" ? null : parseFloat(retailInput.value);
      const { error } = await setVariantRetailPrice(v.id, val);
      toast(error ? "Failed to save" : "Retail price saved", { type: error ? "danger" : "success" });
    });
    const barcodeInput = document.createElement("input");
    barcodeInput.className = "input"; barcodeInput.type = "text"; barcodeInput.style.width = "130px";
    barcodeInput.placeholder = "Barcode"; barcodeInput.title = "Scannable barcode (UPC/EAN or warehouse label)";
    barcodeInput.value = v.barcode || "";
    barcodeInput.addEventListener("change", async () => {
      const { error } = await setVariantBarcode(v.id, barcodeInput.value);
      toast(error ? "Failed to save (barcode may already be used by another SKU)" : "Barcode saved", { type: error ? "danger" : "success" });
    });
    row.appendChild(moqInput);
    row.appendChild(retailInput);
    row.appendChild(barcodeInput);
    skuTable.appendChild(row);
  });
  panel.appendChild(skuTable);

  // Batch 13: per-SKU photo URLs -- feeds the buyer-facing "360°" hologram
  // viewer directly (js/lib/animations/product-hologram.js). This build
  // has no image upload pipeline yet, so wholesalers paste in already-
  // hosted URLs; 0 URLs keeps that SKU on the honest placeholder tier,
  // 1 gives the tilt+sheen single-photo view, 2+ unlocks real drag-to-
  // rotate frame cycling through the exact photos entered here, in order.
  const photosHeader = document.createElement("div");
  photosHeader.style.cssText = "font-size:12px;font-weight:650;margin:12px 0 6px;";
  photosHeader.textContent = "Product photos, per SKU (comma-separated URLs — first URL is used as the primary thumbnail; 2+ URLs enable the buyer-facing 360° drag-to-rotate viewer)";
  panel.appendChild(photosHeader);

  const photosTable = document.createElement("div");
  pricing.variants.forEach((v) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;flex-wrap:wrap;";
    const label = document.createElement("div");
    label.style.cssText = "flex:0 0 160px;";
    label.textContent = `${v.sku} (${v.color}/${v.size})`;
    const photosInput = document.createElement("input");
    photosInput.className = "input";
    photosInput.type = "text";
    photosInput.style.flex = "1";
    photosInput.style.minWidth = "220px";
    photosInput.placeholder = "https://.../front.jpg, https://.../back.jpg";
    photosInput.value = (Array.isArray(v.images) ? v.images.map((i) => i.url) : []).join(", ");
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-secondary btn-sm";
    saveBtn.textContent = "Save photos";
    saveBtn.addEventListener("click", async () => {
      const urls = photosInput.value.split(",").map((u) => u.trim()).filter(Boolean);
      saveBtn.disabled = true;
      const { error } = await setVariantImages(v.id, urls);
      saveBtn.disabled = false;
      if (error) { toast("Failed to save photos", { type: "danger" }); return; }
      v.images = urls.map((url) => ({ url }));
      v.imageUrl = urls[0] || null;
      toast(urls.length >= 2 ? "Photos saved — 360° drag-rotate is now live for this SKU" : urls.length === 1 ? "Photo saved" : "Photos cleared — SKU back to the placeholder view", { type: "success" });
    });
    row.appendChild(label);
    row.appendChild(photosInput);
    row.appendChild(saveBtn);
    photosTable.appendChild(row);
  });
  panel.appendChild(photosTable);

  // Batch 9: reorder-point automation, per SKU -- a separate mini-table so
  // it doesn't crowd the existing MOQ/retail row above (this one is opt-in
  // per SKU and most rows will stay blank until a wholesaler wants it).
  const reorderHeader = document.createElement("div");
  reorderHeader.style.cssText = "font-size:12px;font-weight:650;margin:12px 0 6px;";
  reorderHeader.textContent = "Reorder-point automation, per SKU (optional — leave blank to opt out)";
  panel.appendChild(reorderHeader);

  const reorderTable = document.createElement("div");
  pricing.variants.forEach((v) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;flex-wrap:wrap;";
    const label = document.createElement("div");
    label.style.cssText = "flex:1;min-width:140px;";
    label.textContent = `${v.sku} (${v.color}/${v.size})`;
    const pointInput = document.createElement("input");
    pointInput.className = "input"; pointInput.type = "number"; pointInput.min = "0"; pointInput.style.width = "80px";
    pointInput.placeholder = "Reorder at"; pointInput.title = "Reorder point (available qty)"; pointInput.value = v.reorderPoint ?? "";
    const qtyInput = document.createElement("input");
    qtyInput.className = "input"; qtyInput.type = "number"; qtyInput.min = "1"; qtyInput.style.width = "80px";
    qtyInput.placeholder = "Reorder qty"; qtyInput.title = "Suggested reorder quantity"; qtyInput.value = v.reorderQty ?? "";
    const leadInput = document.createElement("input");
    leadInput.className = "input"; leadInput.type = "number"; leadInput.min = "0"; leadInput.style.width = "70px";
    leadInput.placeholder = "Lead days"; leadInput.title = "Supplier lead time, in days"; leadInput.value = v.leadTimeDays ?? "";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-ghost btn-sm";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const { error } = await setVariantReorderSettings(v.id, {
        reorderPoint: pointInput.value === "" ? null : parseInt(pointInput.value, 10),
        reorderQty: qtyInput.value === "" ? null : parseInt(qtyInput.value, 10),
        leadTimeDays: leadInput.value === "" ? null : parseInt(leadInput.value, 10),
      });
      toast(error ? "Failed to save" : "Reorder settings saved", { type: error ? "danger" : "success" });
    });
    row.appendChild(label);
    row.appendChild(pointInput);
    row.appendChild(qtyInput);
    row.appendChild(leadInput);
    row.appendChild(saveBtn);
    reorderTable.appendChild(row);
  });
  panel.appendChild(reorderTable);
}

// ---------- Packs panel (Batch 7, per-product) ----------

async function renderPacksPanel(panel, wid, product) {
  const packs = await listPacksForProduct(product.id);
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:12px;font-weight:650;margin-bottom:8px;";
  header.textContent = "Prepacks — fixed-composition bundles buyers order as one line (e.g. \"2x Boutique Pack\"), stock still decrements per real SKU underneath.";
  panel.appendChild(header);

  const list = document.createElement("div");
  if (!packs.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">No packs yet for this product.</div>`;
  }
  packs.forEach((pack) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;font-size:13px;padding:6px 0;";
    const breakdown = pack.components.map((c) => `${c.qtyPerPack}×${c.size || c.sku}`).join("/");
    row.innerHTML = `<div style="flex:1;">${esc(pack.name)}${pack.color ? ` — ${esc(pack.color)}` : ""} <span style="color:var(--text-tertiary);">(${breakdown}) · $${pack.price.toFixed(2)}/pack${pack.isFlatPrice ? "" : " (sum of components)"}</span></div>`;
    const archiveBtn = document.createElement("button");
    archiveBtn.className = "btn btn-ghost btn-sm";
    archiveBtn.textContent = "Archive";
    archiveBtn.addEventListener("click", async () => {
      await archivePack(pack.id);
      toast("Pack archived", { type: "success" });
      row.remove();
    });
    row.appendChild(archiveBtn);
    list.appendChild(row);
  });
  panel.appendChild(list);

  const formHeader = document.createElement("div");
  formHeader.style.cssText = "font-size:12px;font-weight:650;margin:12px 0 6px;";
  formHeader.textContent = "New pack";
  panel.appendChild(formHeader);

  const topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;";
  topRow.innerHTML = `
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Pack name</label><input class="input" id="pack-name" placeholder="Boutique Pack" style="width:160px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Colour (optional)</label><input class="input" id="pack-color" placeholder="e.g. Midnight Blue" style="width:150px;" /></div>
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;">Flat price (optional)</label><input class="input" id="pack-price" type="number" min="0" step="0.01" placeholder="sum of components" style="width:140px;" /></div>
  `;
  const suggestBtn = document.createElement("button");
  suggestBtn.className = "btn btn-secondary btn-sm";
  suggestBtn.textContent = "Suggest ratio from sell-through";
  topRow.appendChild(suggestBtn);
  panel.appendChild(topRow);

  const variantTable = document.createElement("div");
  const qtyInputs = new Map();
  product.variants.forEach((v) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;font-size:12px;padding:3px 0;";
    row.innerHTML = `<div style="flex:1;">${esc(v.sku)} <span style="color:var(--text-tertiary);">(${esc(v.extra_attrs?.color)}/${esc(v.extra_attrs?.size)})</span></div>`;
    const qtyInput = document.createElement("input");
    qtyInput.className = "input"; qtyInput.type = "number"; qtyInput.min = "0"; qtyInput.value = "0"; qtyInput.style.width = "70px";
    qtyInputs.set(v.id, qtyInput);
    row.appendChild(qtyInput);
    variantTable.appendChild(row);
  });
  panel.appendChild(variantTable);

  suggestBtn.addEventListener("click", async () => {
    suggestBtn.disabled = true;
    const { source, ratios } = await suggestPackRatio(product.id, product.variants.map((v) => v.id));
    ratios.forEach(({ variantId, qtyPerPack }) => {
      const input = qtyInputs.get(variantId);
      if (input) input.value = String(qtyPerPack);
    });
    suggestBtn.disabled = false;
    toast(`Suggested ratio applied (${source})`, { type: "success" });
  });

  const createBtn = document.createElement("button");
  createBtn.className = "btn btn-primary btn-sm";
  createBtn.style.marginTop = "10px";
  createBtn.textContent = "Create pack";
  createBtn.addEventListener("click", async () => {
    const name = panel.querySelector("#pack-name").value.trim();
    if (!name) { toast("Enter a pack name", { type: "danger" }); return; }
    const color = panel.querySelector("#pack-color").value.trim();
    const priceRaw = panel.querySelector("#pack-price").value;
    const components = [...qtyInputs.entries()].map(([variantId, input]) => ({ variantId, qtyPerPack: parseInt(input.value, 10) || 0 })).filter((c) => c.qtyPerPack > 0);
    if (!components.length) { toast("Set a quantity for at least one SKU", { type: "danger" }); return; }
    createBtn.disabled = true;
    const result = await createPack(wid, product.id, { name, color, components, packPrice: priceRaw === "" ? null : parseFloat(priceRaw) });
    createBtn.disabled = false;
    if (!result.ok) { toast("Failed to create pack", { type: "danger" }); return; }
    toast(`${name} pack created`, { type: "success" });
    await renderPacksPanel(panel, wid, product);
  });
  panel.appendChild(createBtn);
}

// ---------- Inventory ----------

async function inventoryView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Inventory", "Live stock by variant and location — lowest available first."));

  const [stock, locations, suppliers] = await Promise.all([
    getStockTable(wid), getLocations(wid), listSuppliers(wid),
  ]);
  const location = locations[0] || null;

  // The SECOND entry point for product creation. Same component, same
  // createProduct(), same guarantees -- it just does not name a catalog, so
  // the product is filed in the wholesaler's default one. Hadi asked for both:
  // "you can either create a product inside the inventory, or you can create a
  // product inside the actual catalogs".
  const defaultCatalog = await getDefaultCatalog(wid);

  const bar = document.createElement("div");
  bar.className = "pf-actions";
  bar.style.marginTop = "0";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "btn btn-primary";
  newBtn.textContent = "+ New product";
  bar.appendChild(newBtn);
  outlet.appendChild(bar);

  const formHost = document.createElement("div");
  outlet.appendChild(formHost);

  newBtn.addEventListener("click", () => {
    if (formHost.firstChild) { formHost.innerHTML = ""; newBtn.textContent = "+ New product"; return; }
    newBtn.textContent = "Close the form";
    const form = renderProductForm({
      catalogName: defaultCatalog?.name || "your main catalog",
      locations,
      hasLocation: !!location,
      locationName: location?.name || "",
      suppliers,
      // Creating a supplier without leaving a half-built product: this form
      // holds unsaved photos and a stock grid, neither of which survives a
      // navigation, so "go and make one first" would mean losing the work.
      onCreateSupplier: (draft) => createSupplier(wid, draft),
      onCancel: () => { formHost.innerHTML = ""; newBtn.textContent = "+ New product"; },
      onSubmit: async (draft) => {
        const res = await createProduct(wid, { ...draft, locationId: draft.locationId || location?.id || null });
        if (res.ok) {
          toast(res.message, { type: res.variantsFailed?.length ? "warning" : "success" });
          outlet.innerHTML = "";
          inventoryView(outlet);
        }
        return res;
      },
    });
    formHost.appendChild(form.el);
    form.focus();
  });

  if (!stock.length) {
    outlet.appendChild(emptyState({
      icon: "📊", title: "Nothing in stock yet",
      body: "Add a product with the button above, or import a catalog. Every variant you create shows up here — including ones you have not received stock into yet.",
    }));
    return;
  }

  const table = document.createElement("div");
  table.className = "card";
  table.style.padding = "8px";

  stock.forEach((row) => {
    const r = document.createElement("div");
    // A CLASS, not an inline style. The row now carries a badge, a quantity
    // block and a button, and at 390px the inline `display:flex` squeezed the
    // product name into a one-word-per-line column. Layout that has to change
    // with the viewport cannot live in a style attribute -- there is no media
    // query for an inline style. See css/mobile.css.
    r.className = "inv-row";
    // "Never stocked" and "Out" are different facts and must not share a
    // badge. One needs reordering; the other has simply never been received
    // into, which is the normal state of a product created five seconds ago.
    // Before the getStockTable rewrite these rows did not appear at all.
    const badge = row.neverStocked
      ? '<span class="badge badge-neutral">Not stocked yet</span>'
      : row.available <= 0 ? '<span class="badge badge-danger">Out</span>'
      : row.available <= 15 ? '<span class="badge badge-warning">Low</span>' : "";
    r.innerHTML = `
      <div class="inv-row-main">
        <div class="inv-row-name">${esc(row.productName)} <span class="inv-row-variant">${esc(row.color || "—")} / ${esc(row.size || "—")}</span></div>
        <div class="inv-row-meta">${esc(row.locationName)} · SKU ${esc(row.sku)}</div>
      </div>
      <div class="inv-row-qty">
        <div class="inv-row-avail">${row.available} avail.</div>
        <div class="inv-row-meta">${row.onHand} on hand${row.reserved ? `, ${row.reserved} held` : ""}</div>
      </div>
      <div class="inv-row-badge">${badge}</div>
    `;
    const receiveBtn = document.createElement("button");
    receiveBtn.className = "btn btn-secondary btn-sm";
    receiveBtn.textContent = "Receive";
    receiveBtn.addEventListener("click", async () => {
      if (!row.locationId) {
        toast("There is no stock location set up to receive into. Tell OGGI — every wholesaler should have one.", { type: "danger" });
        return;
      }
      const qty = parseInt(prompt(`Receive how many units of ${row.productName} (${row.color}/${row.size})?`, "10"), 10);
      if (!qty || qty <= 0) return;
      const { error } = await receiveStock(row.variantId, row.locationId, qty);
      if (error) { toast("Receive failed", { type: "danger" }); return; }

      // Batch 9: optional landed-cost detail for this receipt (freight/
      // duty/other) -- entirely skippable (Cancel on the first prompt opts
      // out of all three) since most receipts won't have extra cost detail
      // worth recording, matching this view's existing prompt()-based flow
      // rather than introducing a heavier modal for an optional add-on.
      const freightRaw = prompt(`Optional: freight cost for this receipt of ${qty} units? (Cancel to skip landed-cost tracking)`, "0");
      if (freightRaw !== null) {
        const dutyRaw = prompt("Duty/customs cost for this receipt?", "0");
        const otherRaw = prompt("Any other landed cost (handling, inspection, etc.)?", "0");
        await recordReceiptCost({
          variantId: row.variantId, locationId: row.locationId, qty,
          baseCost: row.cost,
          freightCost: parseFloat(freightRaw) || 0,
          dutyCost: parseFloat(dutyRaw) || 0,
          otherCost: parseFloat(otherRaw) || 0,
        });
      }
      toast(`Received ${qty} units`, { type: "success" });
      outlet.innerHTML = "";
      inventoryView(outlet);
    });
    r.appendChild(receiveBtn);

    // Transfer only appears when there is somewhere to transfer TO and
    // something to move. A button that can only ever fail is worse than no
    // button -- it invites the click and then explains itself.
    if (locations.length > 1 && row.available > 0) {
      const moveBtn = document.createElement("button");
      moveBtn.className = "btn btn-secondary btn-sm";
      moveBtn.textContent = "Transfer";
      moveBtn.addEventListener("click", () => {
        openTransfer(row, locations, () => { outlet.innerHTML = ""; inventoryView(outlet); });
      });
      r.appendChild(moveBtn);
    }

    table.appendChild(r);
  });
  outlet.appendChild(table);
}

/**
 * The transfer panel. Inline under the row rather than a modal, for the same
 * reason the product form is inline: a centred dialog on a 390px phone covers
 * the stock figures the operator is deciding against.
 *
 * It shows AVAILABLE, not on hand, because that is what the database will
 * actually let them move -- reserved units belong to an open cart. Showing
 * on-hand here and being refused on submit would be the app disagreeing with
 * itself.
 */
function openTransfer(row, locations, onDone) {
  const existing = document.getElementById("transfer-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "transfer-panel";
  panel.className = "card detail-card product-form";
  const others = locations.filter((l) => l.id !== row.locationId);

  panel.innerHTML = `
    <header class="detail-card-head">
      <h3>Move stock</h3>
      <p>${esc(row.productName)} · ${esc(row.color || "—")} / ${esc(row.size || "—")} · SKU ${esc(row.sku)}</p>
    </header>
    <div class="detail-card-body">
      <div class="pf-grid">
        <div class="pf-field">
          <label class="pf-label">From</label>
          <input class="input" value="${esc(row.locationName)}" disabled>
          <p class="pf-hint">${row.available} available${row.reserved ? ` (${row.onHand} on hand, ${row.reserved} reserved)` : ""}</p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="tr-to">To</label>
          <select class="input" id="tr-to">
            ${others.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}${l.is_default ? " (default)" : ""}</option>`).join("")}
          </select>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="tr-qty">How many</label>
          <input class="input" id="tr-qty" type="number" min="1" max="${row.available}" step="1" value="${Math.min(row.available, 1)}" inputmode="numeric">
          <p class="pf-error" data-for="tr-qty" hidden></p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="tr-note">Note <span class="pf-optional">optional</span></label>
          <input class="input" id="tr-note" placeholder="e.g. restocking the shop" autocomplete="off">
        </div>
      </div>
      <p class="pf-status" role="status" hidden></p>
      <div class="pf-actions">
        <button type="button" class="btn btn-primary" id="tr-go">Move stock</button>
        <button type="button" class="btn btn-secondary" id="tr-cancel">Cancel</button>
      </div>
    </div>
  `;

  const status = panel.querySelector(".pf-status");
  const err = panel.querySelector('.pf-error[data-for="tr-qty"]');
  panel.querySelector("#tr-cancel").addEventListener("click", () => panel.remove());

  panel.querySelector("#tr-go").addEventListener("click", async () => {
    const qty = parseInt(panel.querySelector("#tr-qty").value, 10);
    err.hidden = true;
    if (!qty || qty <= 0) { err.textContent = "Enter how many units to move."; err.hidden = false; return; }
    if (qty > row.available) {
      err.textContent = `Only ${row.available} available to move.`; err.hidden = false; return;
    }
    const go = panel.querySelector("#tr-go");
    go.disabled = true; go.textContent = "Moving…";
    status.hidden = false; status.className = "pf-status"; status.textContent = "Moving stock…";

    const res = await transferStock({
      variantId: row.variantId,
      fromLocationId: row.locationId,
      toLocationId: panel.querySelector("#tr-to").value,
      qty,
      note: panel.querySelector("#tr-note").value.trim() || null,
    });

    go.disabled = false; go.textContent = "Move stock";
    if (!res.ok) {
      // The database's message names the real numbers ("Only 45 available to
      // move (45 on hand, 0 reserved)"). Passed through, not replaced with
      // something vaguer.
      status.className = "pf-status pf-status-error";
      status.textContent = res.error;
      return;
    }
    toast(`Moved ${qty} unit${qty === 1 ? "" : "s"}`, { type: "success" });
    onDone();
  });

  const rowEl = document.getElementById("transfer-anchor");
  (rowEl || document.getElementById("view-outlet")).appendChild(panel);
  panel.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- Inventory intelligence (Batch 9) ----------
// Reorder-point automation, GMROI/aging/sell-through reporting with
// ABC-tiered cycle counting, and kit/bundle assembly. See
// js/data/inventory-intelligence.js and js/data/kits.js for the real
// queries/RPCs behind each section -- this view is purely the rendering
// layer.

function dedupeVariants(stock) {
  const seen = new Map();
  stock.forEach((row) => {
    if (!seen.has(row.variantId)) {
      seen.set(row.variantId, { id: row.variantId, label: `${row.sku} — ${row.productName} (${row.color}/${row.size})`, cost: row.cost });
    }
  });
  return [...seen.values()];
}

async function intelligenceView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Inventory Intelligence", "Reorder suggestions, GMROI/aging/sell-through, ABC cycle counts, and kit assembly."));

  const [reorderSuggestions, report, cycleSchedule, kits, stock, locations] = await Promise.all([
    getReorderSuggestions(wid), getInventoryIntelligenceReport(wid), getCycleCountSchedule(wid), listKits(wid), getStockTable(wid), getLocations(wid),
  ]);
  const defaultLocation = locations.find((l) => l.is_default) || locations[0];
  const variantOptions = dedupeVariants(stock);

  // --- Reorder suggestions ---
  const reorderSection = document.createElement("div");
  reorderSection.className = "card";
  reorderSection.style.cssText = "padding:16px;margin-bottom:16px;";
  reorderSection.innerHTML = `<h4 style="margin-bottom:8px;">Reorder suggestions</h4>`;
  if (!reorderSuggestions.length) {
    reorderSection.innerHTML += `<div style="font-size:12px;color:var(--text-tertiary);">Nothing needs reordering right now (or no SKUs have a reorder point configured yet — set one from Products → Pricing & MOQ).</div>`;
  } else {
    reorderSuggestions.forEach((v) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;";
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${esc(v.sku)} <span style="color:var(--text-tertiary);font-weight:400;">${esc(v.productName)} (${esc(v.color)}/${esc(v.size)})</span></div>
          <div style="color:var(--text-tertiary);">${v.available} available · reorder point ${v.reorderPoint}${v.leadTimeDays != null ? ` · ${v.leadTimeDays}d lead time` : ""}</div>
        </div>
        <div style="font-weight:700;">Suggest: ${v.suggestedQty}</div>
      `;
      const receiveBtn = document.createElement("button");
      receiveBtn.className = "btn btn-primary btn-sm";
      receiveBtn.textContent = "Receive suggested qty";
      receiveBtn.disabled = !defaultLocation;
      receiveBtn.addEventListener("click", async () => {
        receiveBtn.disabled = true;
        const { error } = await receiveStock(v.variantId, defaultLocation.id, v.suggestedQty, "Reorder-point automation suggestion");
        toast(error ? "Receive failed" : `Received ${v.suggestedQty} units of ${v.sku}`, { type: error ? "danger" : "success" });
        if (!error) { outlet.innerHTML = ""; intelligenceView(outlet); }
        else receiveBtn.disabled = false;
      });
      row.appendChild(receiveBtn);
      reorderSection.appendChild(row);
    });
  }
  outlet.appendChild(reorderSection);

  // --- GMROI / aging / sell-through report ---
  const reportSection = document.createElement("div");
  reportSection.className = "card";
  reportSection.style.cssText = "padding:16px;margin-bottom:16px;overflow-x:auto;";
  reportSection.innerHTML = `<h4 style="margin-bottom:4px;">Inventory report — trailing ${report.trailingDays} days</h4>
    <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px;">GMROI = gross margin ÷ (on-hand qty × landed cost). ABC tier is this SKU's share of trailing revenue (A = top 80%, B = next 15%, C = remainder) — blank when there's no trailing revenue yet to classify from.</div>`;
  if (!report.rows.length) {
    reportSection.innerHTML += `<div style="font-size:12px;color:var(--text-tertiary);">No variants yet.</div>`;
  } else {
    const tableWrap = document.createElement("div");
    const header = document.createElement("div");
    header.style.cssText = "display:flex;gap:8px;font-size:11px;font-weight:650;color:var(--text-tertiary);padding:4px 0;border-bottom:1px solid var(--border-default);";
    header.innerHTML = `<div style="flex:2;">SKU</div><div style="width:36px;">ABC</div><div style="width:60px;text-align:right;">Sold</div><div style="width:80px;text-align:right;">Revenue</div><div style="width:70px;text-align:right;">GMROI</div><div style="width:70px;text-align:right;">Sell-thru</div><div style="width:90px;text-align:right;">Aging</div>`;
    tableWrap.appendChild(header);
    [...report.rows].sort((a, b) => b.revenue - a.revenue).forEach((r) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border-subtle);align-items:center;";
      const tierBadge = r.abcTier ? `<span class="badge ${r.abcTier === "A" ? "badge-success" : r.abcTier === "B" ? "badge-info" : "badge-neutral"}">${r.abcTier}</span>` : "—";
      row.innerHTML = `
        <div style="flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.sku)} <span style="color:var(--text-tertiary);">${esc(r.productName)}</span></div>
        <div style="width:36px;">${tierBadge}</div>
        <div style="width:60px;text-align:right;">${r.unitsSold}</div>
        <div style="width:80px;text-align:right;">${money(r.revenue)}</div>
        <div style="width:70px;text-align:right;">${r.gmroi != null ? r.gmroi.toFixed(2) : "—"}</div>
        <div style="width:70px;text-align:right;">${r.sellThroughPct != null ? r.sellThroughPct + "%" : "—"}</div>
        <div style="width:90px;text-align:right;">${esc(r.agingBucket)}</div>
      `;
      tableWrap.appendChild(row);
    });
    reportSection.appendChild(tableWrap);
  }
  outlet.appendChild(reportSection);

  // --- ABC cycle count schedule ---
  const cycleSection = document.createElement("div");
  cycleSection.className = "card";
  cycleSection.style.cssText = "padding:16px;margin-bottom:16px;";
  cycleSection.innerHTML = `<h4 style="margin-bottom:8px;">Cycle count schedule</h4>`;
  if (!cycleSchedule.length) {
    cycleSection.innerHTML += `<div style="font-size:12px;color:var(--text-tertiary);">No SKUs to count.</div>`;
  } else {
    cycleSchedule.slice(0, 25).forEach((c) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;";
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${esc(c.sku)} <span style="color:var(--text-tertiary);font-weight:400;">${esc(c.productName)} (${esc(c.color)}/${esc(c.size)})</span> ${c.due ? '<span class="badge badge-warning">Due</span>' : ""}</div>
          <div style="color:var(--text-tertiary);">Tier ${c.abcTier || "—"} · every ${c.frequencyDays}d · last counted ${c.lastCountedAt ? new Date(c.lastCountedAt).toLocaleDateString() : "never"} · ${c.onHand} on hand (system)</div>
        </div>
      `;
      const logBtn = document.createElement("button");
      logBtn.className = "btn btn-secondary btn-sm";
      logBtn.textContent = "Log count";
      logBtn.disabled = !defaultLocation;
      logBtn.addEventListener("click", async () => {
        const countedRaw = prompt(`Physical count for ${c.sku} (system expects ${c.onHand})?`, String(c.onHand));
        if (countedRaw === null) return;
        const countedQty = parseInt(countedRaw, 10);
        if (isNaN(countedQty) || countedQty < 0) { toast("Enter a valid count", { type: "danger" }); return; }
        const result = await logCycleCount(wid, {
          variantId: c.variantId, locationId: defaultLocation.id,
          expectedQty: c.onHand, countedQty, countedBy: session.actorLabel,
        });
        toast(result.ok ? (result.variance === 0 ? "Count matched — no correction needed" : `Count logged — corrected by ${result.variance > 0 ? "+" : ""}${result.variance}`) : "Failed to log count", { type: result.ok ? "success" : "danger" });
        if (result.ok) { outlet.innerHTML = ""; intelligenceView(outlet); }
      });
      row.appendChild(logBtn);
      cycleSection.appendChild(row);
    });
    if (cycleSchedule.length > 25) {
      const more = document.createElement("div");
      more.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-top:6px;";
      more.textContent = `+ ${cycleSchedule.length - 25} more SKUs, most-overdue shown first.`;
      cycleSection.appendChild(more);
    }
  }
  outlet.appendChild(cycleSection);

  // --- Kits ---
  const kitsSection = document.createElement("div");
  kitsSection.className = "card";
  kitsSection.style.cssText = "padding:16px;";
  kitsSection.innerHTML = `<h4 style="margin-bottom:4px;">Kits / bundle SKUs</h4>
    <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px;">A kit is its own real, sellable SKU assembled ahead of time from other SKUs' stock (can span multiple products) — different from a Pack (Products → Packs), which bundles one product's own colours/sizes into one order line without pre-building inventory.</div>`;

  const kitsList = document.createElement("div");
  function renderKitsList() {
    kitsList.innerHTML = "";
    if (!kits.length) {
      kitsList.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">No kits defined yet.</div>`;
      return;
    }
    kits.forEach((k) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;flex-wrap:wrap;";
      const breakdown = k.components.map((c) => `${c.qtyPerKit}×${c.sku}`).join(" + ");
      row.innerHTML = `
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:600;">${esc(k.name)} <span style="color:var(--text-tertiary);font-weight:400;">→ ${esc(k.kitSku)}${k.kitPrice != null ? ` · ${money(k.kitPrice)}` : ""}</span></div>
          <div style="color:var(--text-tertiary);">${esc(breakdown)}</div>
        </div>
      `;
      const qtyInput = document.createElement("input");
      qtyInput.className = "input"; qtyInput.type = "number"; qtyInput.min = "1"; qtyInput.value = "1"; qtyInput.style.width = "64px";
      const assembleBtn = document.createElement("button");
      assembleBtn.className = "btn btn-primary btn-sm";
      assembleBtn.textContent = "Assemble";
      assembleBtn.disabled = !defaultLocation;
      assembleBtn.addEventListener("click", async () => {
        const qty = parseInt(qtyInput.value, 10) || 0;
        if (qty <= 0) return;
        assembleBtn.disabled = true;
        const result = await assembleKit(k.id, defaultLocation.id, qty);
        assembleBtn.disabled = false;
        toast(result.ok ? `Assembled ${qty}x ${k.name}` : (result.error?.message || "Assembly failed — check component stock"), { type: result.ok ? "success" : "danger" });
      });
      const archiveBtn = document.createElement("button");
      archiveBtn.className = "btn btn-ghost btn-sm";
      archiveBtn.textContent = "Archive";
      archiveBtn.addEventListener("click", async () => {
        await archiveKit(k.id);
        toast("Kit archived", { type: "success" });
        outlet.innerHTML = "";
        intelligenceView(outlet);
      });
      row.appendChild(qtyInput);
      row.appendChild(assembleBtn);
      row.appendChild(archiveBtn);
      kitsList.appendChild(row);
    });
  }
  renderKitsList();
  kitsSection.appendChild(kitsList);

  // Create-kit form
  const createForm = document.createElement("div");
  createForm.style.cssText = "margin-top:14px;padding-top:14px;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:8px;";
  createForm.innerHTML = `<strong style="font-size:12px;">Create a kit</strong><div style="font-size:11px;color:var(--text-tertiary);">Pick an existing SKU to represent the kit itself (create it first via Products, priced as the bundle), then add the SKUs it's assembled from.</div>`;

  const nameInput = document.createElement("input");
  nameInput.className = "input"; nameInput.placeholder = "Kit name (e.g. \"Starter Bundle\")";

  const kitVariantSelect = document.createElement("select");
  kitVariantSelect.className = "input";
  kitVariantSelect.innerHTML = `<option value="">— Select the kit's own SKU —</option>` + variantOptions.map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join("");

  const componentsWrap = document.createElement("div");
  componentsWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  function addComponentRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;";
    const select = document.createElement("select");
    select.className = "input"; select.style.flex = "1";
    select.innerHTML = `<option value="">— Component SKU —</option>` + variantOptions.map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join("");
    const qty = document.createElement("input");
    qty.className = "input"; qty.type = "number"; qty.min = "1"; qty.value = "1"; qty.style.width = "70px"; qty.title = "Qty per kit";
    const rmBtn = document.createElement("button");
    rmBtn.className = "btn btn-ghost btn-sm"; rmBtn.textContent = "✕";
    rmBtn.addEventListener("click", () => row.remove());
    row.appendChild(select);
    row.appendChild(qty);
    row.appendChild(rmBtn);
    componentsWrap.appendChild(row);
  }
  addComponentRow();
  const addComponentBtn = document.createElement("button");
  addComponentBtn.className = "btn btn-secondary btn-sm";
  addComponentBtn.textContent = "+ Add component";
  addComponentBtn.addEventListener("click", addComponentRow);

  const createBtn = document.createElement("button");
  createBtn.className = "btn btn-primary btn-sm";
  createBtn.textContent = "Create kit";
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const kitVariantId = kitVariantSelect.value;
    if (!name || !kitVariantId) { toast("Enter a name and pick the kit's SKU", { type: "danger" }); return; }
    const components = [...componentsWrap.querySelectorAll("div")].map((row) => {
      const select = row.querySelector("select");
      const qtyInput = row.querySelector("input");
      return { componentVariantId: select.value, qtyPerKit: parseInt(qtyInput.value, 10) || 0 };
    }).filter((c) => c.componentVariantId && c.qtyPerKit > 0);
    if (!components.length) { toast("Add at least one component", { type: "danger" }); return; }
    createBtn.disabled = true;
    const result = await createKit(wid, { name, kitVariantId, components });
    createBtn.disabled = false;
    toast(result.ok ? "Kit created" : "Failed to create kit", { type: result.ok ? "success" : "danger" });
    if (result.ok) { outlet.innerHTML = ""; intelligenceView(outlet); }
  });

  createForm.appendChild(nameInput);
  createForm.appendChild(kitVariantSelect);
  createForm.appendChild(componentsWrap);
  createForm.appendChild(addComponentBtn);
  createForm.appendChild(createBtn);
  kitsSection.appendChild(createForm);

  outlet.appendChild(kitsSection);
}

// ---------- Settings (Batch 8) ----------
//
// Just the catalog-UX knobs added by migrations/013 for now: the low-MOQ
// filter threshold the buyer catalog toolbar uses, and the payment-terms/
// return-policy/trust-message copy shown on the buyer cart's trust card
// (js/components/trust-badges.js). Broader wholesaler settings (branding,
// locations, notification prefs) aren't called for by this batch's scope
// and stay a placeholder-free-for-now gap rather than being half-built.

async function settingsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Settings", "Catalog filters and buyer-facing trust messaging."));

  const settings = await getWholesalerSettings(wid);

  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:20px;max-width:560px;display:flex;flex-direction:column;gap:16px;";

  function field(labelText, helpText, inputEl) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.cssText = "font-size:13px;font-weight:600;";
    const help = document.createElement("div");
    help.textContent = helpText;
    help.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-bottom:2px;";
    wrap.appendChild(label);
    wrap.appendChild(help);
    wrap.appendChild(inputEl);
    return wrap;
  }

  const moqInput = document.createElement("input");
  moqInput.type = "number"; moqInput.min = "1"; moqInput.className = "input";
  moqInput.value = String(settings.low_moq_threshold ?? 12);

  const trustInput = document.createElement("textarea");
  trustInput.className = "input"; trustInput.rows = 2;
  trustInput.value = settings.trust_message || "";
  trustInput.placeholder = "e.g. Family-run supplier, 12 years serving independent boutiques.";

  const paymentInput = document.createElement("textarea");
  paymentInput.className = "input"; paymentInput.rows = 2;
  paymentInput.value = settings.payment_terms || "";
  paymentInput.placeholder = "e.g. Net 30 for established accounts, prepay for first order.";

  const returnInput = document.createElement("textarea");
  returnInput.className = "input"; returnInput.rows = 2;
  returnInput.value = settings.return_policy || "";
  returnInput.placeholder = "e.g. Defects reported within 14 days replaced free of charge.";

  card.appendChild(field("Low MOQ threshold", "Products at or under this minimum-order-quantity show under the buyer catalog's \"Low MOQ only\" filter.", moqInput));
  card.appendChild(field("Trust message", "Shown on the buyer's cart alongside the platform's generic trust badges. Optional — leave blank to show only the generic badges.", trustInput));
  card.appendChild(field("Payment terms", "Shown on the buyer's cart. Optional.", paymentInput));
  card.appendChild(field("Return policy", "Shown on the buyer's cart. Optional.", returnInput));

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Save settings";
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const { error } = await updateWholesalerSettings(wid, {
      lowMoqThreshold: moqInput.value,
      trustMessage: trustInput.value,
      paymentTerms: paymentInput.value,
      returnPolicy: returnInput.value,
    });
    saveBtn.disabled = false;
    saveBtn.textContent = "Save settings";
    toast(error ? "Save failed" : "Settings saved", { type: error ? "danger" : "success" });
  });
  card.appendChild(saveBtn);

  outlet.appendChild(card);
}

// ---------- Clients (Batch 14 — the "/wholesaler/clients" placeholder
// explicitly deferred to "real auth, scoped to Batch 14"; that auth now
// exists, so this replaces the placeholder with the real screen) ----------

async function clientsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Clients", "Your buyer directory, sorted by most recent order first."));

  const formCard = document.createElement("div");
  formCard.className = "card";
  formCard.style.cssText = "padding:16px;margin-bottom:16px;";
  formCard.innerHTML = `
    <div style="font-weight:650;margin-bottom:10px;">Add a client</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Shop name</label>
        <input class="input" id="cl-name" style="width:200px;" /></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Phone</label>
        <input class="input" id="cl-phone" style="width:160px;" /></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Note</label>
        <input class="input" id="cl-note" style="width:200px;" /></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Discount %</label>
        <input class="input" id="cl-discount" type="number" min="0" max="100" value="0" style="width:90px;" /></div>
      <button class="btn btn-primary" id="cl-add">Add client</button>
    </div>
  `;
  outlet.appendChild(formCard);
  formCard.querySelector("#cl-add").addEventListener("click", async () => {
    const shopName = formCard.querySelector("#cl-name").value.trim();
    if (!shopName) { toast("Shop name is required", { type: "danger" }); return; }
    const btn = formCard.querySelector("#cl-add");
    btn.disabled = true;
    const { error } = await addClient(wid, {
      shopName,
      phone: formCard.querySelector("#cl-phone").value.trim(),
      note: formCard.querySelector("#cl-note").value.trim(),
      discountPct: Number(formCard.querySelector("#cl-discount").value) || 0,
    });
    btn.disabled = false;
    if (error) { toast("Could not add client", { type: "danger" }); return; }
    toast("Client added", { type: "success" });
    outlet.innerHTML = "";
    clientsView(outlet);
  });

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const clients = await getClientsByRecency(wid);
  loading.remove();

  const coverage = coverageSnapshot(clients);
  const stats = document.createElement("div");
  stats.className = "stat-grid";
  [
    ["Total clients", coverage.total],
    ["Ordered in last 30 days", coverage.coveredRecently],
    ["Needs attention", coverage.needsAttention],
    ["Never ordered", coverage.neverOrdered],
  ].forEach(([label, value]) => {
    const c = document.createElement("div");
    c.className = "card stat-card";
    c.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
    stats.appendChild(c);
  });
  outlet.appendChild(stats);

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
        <div style="font-size:12px;color:var(--text-secondary);">${esc(c.phone || "—")}${c.discount_pct ? ` · ${c.discount_pct}% discount` : ""}${c.note ? " · " + esc(c.note) : ""}</div>
      </div>
      <div style="text-align:right;width:130px;">
        <div style="font-size:12px;font-weight:600;">${c.orderCount} order${c.orderCount === 1 ? "" : "s"}</div>
        <div style="font-size:11px;color:var(--text-tertiary);">${c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString() : "never ordered"}</div>
      </div>
      <div style="text-align:right;width:90px;font-size:12px;font-weight:600;">$${c.lifetimeValue.toFixed(0)}</div>
      <button class="btn btn-ghost btn-sm" data-action="deactivate">Deactivate</button>
    `;
    row.querySelector('[data-action="deactivate"]').addEventListener("click", async () => {
      if (!confirm(`Deactivate ${c.shop_name}? This hides them from your active client list (their order history is kept).`)) return;
      await deactivateClient(c.id);
      toast(`${c.shop_name} deactivated`, { type: "default" });
      row.remove();
    });
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

// ---------- Team & Buyers (Batch 14) ----------
//
// Admin-provisioned buyer + sales logins (v2_portal_accounts), mirroring
// v1's create_rep() authorization pattern: only this wholesaler (or the
// owner) can create accounts scoped to their own wid. Account creation
// goes through devAuth.createPortalAccount (SECURITY DEFINER RPC — it
// hashes the password server-side; this screen never sees or stores a
// plaintext password after the one-time reveal below). Buyer accounts
// can optionally link to an existing client CRM row so their order
// history and "Your Price" overrides resolve correctly from first login
// (see js/data/pricing.js's resolveClientId fallback + Batch 14's
// session.clientId wiring in js/views/buyer.js).

async function teamView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Team & Buyers", "Create and manage buyer + sales logins for your storefront."));

  // Render the form immediately with an empty client dropdown, then fill
  // it in once the (separate, non-blocking) client list resolves -- a
  // slow/failed fetch should never hold up the whole form from appearing
  // (same defensive pattern as invitesView's wholesaler dropdown above).
  let clients = [];

  const formCard = document.createElement("div");
  formCard.className = "card";
  formCard.style.cssText = "padding:16px;margin-bottom:16px;";
  formCard.innerHTML = `
    <div style="font-weight:650;margin-bottom:10px;">Create an account</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Role</label>
        <select class="input" id="team-role" style="width:130px;">
          <option value="buyer">Buyer</option>
          <option value="sales">Sales</option>
        </select></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Display name</label>
        <input class="input" id="team-label" style="width:180px;" placeholder="shown on their orders" /></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Username</label>
        <input class="input" id="team-user" style="width:160px;" /></div>
      <div><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Password</label>
        <input class="input" id="team-pass" type="text" style="width:160px;" placeholder="min 8 characters" /></div>
      <div id="team-client-group"><label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Link to client (optional)</label>
        <select class="input" id="team-client" style="width:200px;">
          <option value="">No client link</option>
          ${clients.map((c) => `<option value="${esc(c.id)}">${esc(c.shop_name)}</option>`).join("")}
        </select></div>
      <button class="btn btn-primary" id="team-create">Create account</button>
    </div>
    <div id="team-result" style="margin-top:12px;"></div>
  `;
  outlet.appendChild(formCard);

  getClientsByRecency(wid).then((rows) => {
    clients = rows;
    const clientSelect = formCard.querySelector("#team-client");
    if (clientSelect) {
      clientSelect.innerHTML = `<option value="">No client link</option>` + clients.map((c) => `<option value="${esc(c.id)}">${esc(c.shop_name)}</option>`).join("");
    }
  });

  const roleSelect = formCard.querySelector("#team-role");
  const clientGroup = formCard.querySelector("#team-client-group");
  roleSelect.addEventListener("change", () => {
    clientGroup.style.display = roleSelect.value === "buyer" ? "" : "none";
  });

  formCard.querySelector("#team-create").addEventListener("click", async () => {
    const username = formCard.querySelector("#team-user").value.trim();
    const password = formCard.querySelector("#team-pass").value;
    const actorLabel = formCard.querySelector("#team-label").value.trim();
    if (!username || !password) { toast("Username and password are required", { type: "danger" }); return; }
    if (password.length < 8) { toast("Password must be at least 8 characters", { type: "danger" }); return; }
    if (!actorLabel) { toast("A display name is required", { type: "danger" }); return; }
    const role = roleSelect.value;
    const clientId = role === "buyer" ? (formCard.querySelector("#team-client").value || null) : null;

    const btn = formCard.querySelector("#team-create");
    btn.disabled = true;
    btn.textContent = "Creating…";
    const result = await devAuth.createPortalAccount({ role, wid, username, password, clientId, actorLabel });
    btn.disabled = false;
    btn.textContent = "Create account";
    if (!result.ok) { toast(result.error || "Could not create account", { type: "danger" }); return; }

    formCard.querySelector("#team-result").innerHTML = `
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">Save these now — the password will not be shown again.</div>
      <div style="display:flex;gap:16px;font-family:monospace;font-size:13px;background:var(--surface-sunken,#f7f7f5);border-radius:8px;padding:10px 12px;">
        <div><span style="color:var(--text-tertiary);">Username:</span> <strong>${esc(username)}</strong></div>
        <div><span style="color:var(--text-tertiary);">Password:</span> <strong>${esc(password)}</strong></div>
      </div>
    `;
    toast(`${role === "buyer" ? "Buyer" : "Sales"} account created`, { type: "success" });
  });

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const accounts = await listPortalAccounts(wid);
  loading.remove();

  if (!accounts.length) {
    outlet.appendChild(emptyState({ icon: "🔑", title: "No accounts yet", body: "Create your first buyer or sales login above." }));
    return;
  }

  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";
  accounts.forEach((a) => {
    const linkedClient = a.client_id ? clients.find((c) => c.id === a.client_id) : null;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:650;">${esc(a.actor_label)} <span class="badge ${a.role === "buyer" ? "badge-info" : "badge-neutral"}" style="margin-left:6px;">${a.role}</span></div>
        <div style="font-size:12px;color:var(--text-secondary);">@${esc(a.username)}${linkedClient ? " · linked to " + esc(linkedClient.shop_name) : ""}</div>
      </div>
      <div style="font-size:12px;font-weight:600;color:${a.active ? "var(--success-700,#027A48)" : "var(--text-tertiary)"};">${a.active ? "Active" : "Disabled"}</div>
      <button class="btn btn-ghost btn-sm" data-action="toggle">${a.active ? "Disable" : "Enable"}</button>
    `;
    row.querySelector('[data-action="toggle"]').addEventListener("click", async () => {
      await setPortalAccountActive(a.id, !a.active);
      toast(`${a.actor_label} ${a.active ? "disabled" : "enabled"}`, { type: "default" });
      outlet.innerHTML = "";
      teamView(outlet);
    });
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

// ---------- Deferred (not this batch) ----------


// =============================================================================
// CATALOGS  (built 18 Aug 2026 — was a "scheduled later" stub)
// =============================================================================
// Hadi: "there's an actual catalog, and inside of the actual catalog builder,
// create new products. And when you create these new products, you
// automatically have them be put into the inventory."
//
// Before this, /wholesaler/catalogs rendered a literal placeholder and there
// was no catalog table in the schema at all. Migration 045 added
// v2_catalogs + v2_catalog_products and back-filled a "Main Catalog" per
// wholesaler holding everything they already had, so this screen is never
// empty on first open -- a blank "no catalogs" page for a wholesaler with 64
// live variants would read as their products having gone missing.
//
// The "New product" button here and the one on Inventory call the SAME
// createProduct() with the SAME form component. The only difference is which
// catalog id goes along.
// =============================================================================

async function catalogsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader(
    "Catalogs",
    "Group your products into catalogs. New products land in the one you are looking at."
  ));

  const { ok, rows: catalogs, error } = await listCatalogs(wid);
  if (!ok) {
    outlet.appendChild(emptyState({ icon: "⚠️", title: "Could not load your catalogs", body: error }));
    return;
  }
  if (!catalogs.length) {
    // Migration 045 back-fills one per wholesaler, so this is genuinely
    // unexpected rather than a normal empty state -- and says so.
    outlet.appendChild(emptyState({
      icon: "🗂", title: "No catalogs found",
      body: "Every wholesaler should have a Main Catalog. If you are seeing this, tell OGGI — it means one was not created for you.",
    }));
    return;
  }

  let activeId = catalogs.find((c) => c.isDefault)?.id || catalogs[0].id;

  const tabs = document.createElement("div");
  tabs.className = "date-range-row";
  tabs.style.marginBottom = "var(--space-4)";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Your catalogs");
  outlet.appendChild(tabs);

  const panel = document.createElement("div");
  outlet.appendChild(panel);

  // A real reference, set when the panel is built. It used to be re-found with
  // panel.querySelector("div:last-child"), which is a description of a shape
  // rather than an identity -- and the shape matched the OPEN FORM's body
  // (the last child of its section) before it reached the list. Refreshing the
  // list therefore emptied the form, including the line that had just
  // confirmed what was created. Selectors that describe position are fine for
  // reading and dangerous for writing.
  let listHost = null;

  function paintTabs() {
    tabs.innerHTML = "";
    catalogs.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm " + (c.id === activeId ? "btn-primary" : "btn-secondary");
      b.textContent = c.name + (c.isDefault ? " ★" : "");
      b.setAttribute("aria-pressed", String(c.id === activeId));
      b.addEventListener("click", () => { activeId = c.id; paintTabs(); paintPanel(); });
      tabs.appendChild(b);
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-ghost btn-sm";
    add.textContent = "+ New catalog";
    add.addEventListener("click", async () => {
      const name = prompt("What is this catalog called?\n\ne.g. \"Summer 26\", \"Outlet\", \"Wholesale only\"");
      if (!name) return;
      const res = await createCatalog(wid, { name });
      if (!res.ok) { toast(res.error, { type: "danger" }); return; }
      toast(`"${res.name}" created`, { type: "success" });
      outlet.innerHTML = "";
      catalogsView(outlet);
    });
    tabs.appendChild(add);
  }

  async function paintPanel() {
    const catalog = catalogs.find((c) => c.id === activeId);
    panel.innerHTML = `<div class="card" style="padding:16px;font-size:13px;color:var(--text-tertiary);">Loading ${esc(catalog.name)}…</div>`;

    const [{ rows: products }, allLocations, suppliers] = await Promise.all([
      getCatalogProducts(activeId),
      getLocations(wid),
      listSuppliers(wid),
    ]);
    const location = allLocations[0] || null;

    panel.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "pf-actions";
    bar.style.marginTop = "0";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "btn btn-primary";
    newBtn.textContent = "+ New product";
    bar.appendChild(newBtn);
    panel.appendChild(bar);

    const formHost = document.createElement("div");
    panel.appendChild(formHost);

    // The list gets its own container so a refresh after a save repaints ONLY
    // the list. Repainting the whole panel wiped the open form -- including
    // the line confirming what had just been created, which the operator then
    // never saw. Adding one product almost always means adding the next.
    listHost = document.createElement("div");
    panel.appendChild(listHost);

    newBtn.addEventListener("click", () => {
      if (formHost.firstChild) { formHost.innerHTML = ""; newBtn.textContent = "+ New product"; return; }
      newBtn.textContent = "Close the form";
      const form = renderProductForm({
        catalogName: catalog.name,
        locations: allLocations,
        hasLocation: !!location,
        locationName: location?.name || "",
        suppliers,
        onCreateSupplier: (draft) => createSupplier(wid, draft),
        onCancel: () => { formHost.innerHTML = ""; newBtn.textContent = "+ New product"; },
        onSubmit: async (draft) => {
          const res = await createProduct(wid, {
            ...draft,
            catalogId: activeId,
            // The form now offers a location picker, so its choice wins; the
            // default is only the fallback for a wholesaler with one location.
            locationId: draft.locationId || location?.id || null,
          });
          if (res.ok) {
            toast(res.message, { type: res.variantsFailed?.length ? "warning" : "success" });
            await paintList();   // the list only -- the form stays open
          }
          return res;
        },
      });
      formHost.appendChild(form.el);
      form.focus();
    });

    await paintList(products);
  }

  /** Renders just the product list. Called on first paint and after a save. */
  async function paintList(preloaded) {
    const catalog = catalogs.find((c) => c.id === activeId);
    if (!listHost) return;
    const products = preloaded || (await getCatalogProducts(activeId)).rows;
    listHost.innerHTML = "";

    if (!products.length) {
      listHost.appendChild(emptyState({
        icon: "🗂", title: `${catalog.name} is empty`,
        body: "Add a product with the button above. It will appear here and in Inventory straight away.",
      }));
      return;
    }

    const list = document.createElement("div");
    list.className = "card";
    list.style.padding = "8px";
    products.forEach((p) => {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);flex-wrap:wrap;";
      const swatches = p.colors.map((c) =>
        `<span title="${esc(c.name)}" style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${esc(c.hex)};box-shadow:inset 0 0 0 1px rgba(14,34,48,.18);"></span>`
      ).join("");
      r.innerHTML = `
        <div style="flex:1;min-width:180px;">
          <div style="font-weight:600;font-size:14px;">${esc(p.name)}${p.archived ? ' <span class="badge badge-neutral">Archived</span>' : ""}</div>
          <div style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span>${p.variantCount} variant${p.variantCount === 1 ? "" : "s"}</span>
            ${p.priceRange[1] > 0 ? `<span>· ${money(p.priceRange[0])}–${money(p.priceRange[1])}</span>` : ""}
            ${swatches ? `<span style="display:inline-flex;gap:4px;align-items:center;">${swatches}</span>` : ""}
          </div>
        </div>
      `;
      const rm = document.createElement("button");
      rm.className = "btn btn-ghost btn-sm";
      // Wording matters: this unfiles, it does not delete. "Remove" alone
      // reads as destructive and would stop people using catalogs at all.
      rm.textContent = "Remove from catalog";
      rm.addEventListener("click", async () => {
        const res = await removeProductFromCatalog(activeId, p.id);
        if (!res.ok) { toast(res.error, { type: "danger" }); return; }
        toast(`"${p.name}" removed from ${catalog.name}. The product itself is untouched.`, { type: "success" });
        await paintList();
      });
      r.appendChild(rm);
      list.appendChild(r);
    });
    listHost.appendChild(list);
  }

  paintTabs();
  await paintPanel();
}

// Currently unused: /wholesaler/catalogs was its last caller and now has a
// real screen. Kept rather than deleted because every remaining stub in the
// app should look identical when it is written, and because deleting a shared
// helper the moment its last caller goes is how the next person ends up
// writing a seventh slightly-different version of it. If nothing calls it by
// the time the wholesaler batch is finished, it goes then, deliberately.

// =============================================================================
// LOCATIONS  (built 18 Aug 2026)
// =============================================================================
// Hadi: "add multiple locations to wholesalers".
//
// Stock has been keyed on (variant, location) since migration 001 -- what was
// missing is that nothing could create a second location and nothing could
// move stock between two. Regression ledger #17 said it plainly: "the only
// transfer tokens in the entire repo are the enum values on one line. No
// function, RPC or UI. An enum value is not a feature."
//
// EVERY WRITE HERE IS AN RPC. Migration 047 revoked INSERT/UPDATE/DELETE on
// v2_locations from the browser, because the rules -- at least one active
// location, exactly one default, never move stock a location does not have
// available -- have to hold whichever screen is calling. This view cannot
// break them even by accident.
//
// The stock totals are shown BEFORE anyone tries to archive, so "you can't,
// it still holds 240 units" is visible rather than a surprise at the click.
// Refusing at the moment of the click is correct but late.
// =============================================================================

async function locationsView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader(
    "Locations",
    "Warehouses and shops that hold your stock. Move stock between them here."
  ));

  const host = document.createElement("div");
  outlet.appendChild(host);

  async function paint() {
    host.innerHTML = `<div class="card" style="padding:16px;font-size:13px;color:var(--text-tertiary);">Loading…</div>`;
    const [{ ok, rows, error }, totals] = await Promise.all([
      listLocations(wid), locationStockTotals(wid),
    ]);
    host.innerHTML = "";

    if (!ok) {
      host.appendChild(emptyState({ icon: "⚠️", title: "Could not load your locations", body: error }));
      return;
    }

    const bar = document.createElement("div");
    bar.className = "pf-actions";
    bar.style.marginTop = "0";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "+ New location";
    addBtn.addEventListener("click", async () => {
      const name = prompt("What is this location called?\n\ne.g. \"Main Warehouse\", \"Beirut Shop\", \"Container 3\"");
      if (!name) return;
      const res = await createLocation(wid, name);
      if (!res.ok) { toast(res.error, { type: "danger" }); return; }
      toast(`"${name.trim()}" created`, { type: "success" });
      paint();
    });
    bar.appendChild(addBtn);
    host.appendChild(bar);

    const list = document.createElement("div");
    list.className = "card";
    list.style.padding = "8px";

    rows.forEach((loc) => {
      const t = totals.get(loc.id) || { onHand: 0, reserved: 0, variants: 0 };
      const r = document.createElement("div");
      r.className = "inv-row";
      r.innerHTML = `
        <div class="inv-row-main">
          <div class="inv-row-name">${esc(loc.name)}</div>
          <div class="inv-row-meta">${t.onHand.toLocaleString()} unit${t.onHand === 1 ? "" : "s"} on hand across ${t.variants} variant${t.variants === 1 ? "" : "s"}${t.reserved ? ` · ${t.reserved} reserved` : ""}</div>
        </div>
        <div class="inv-row-badge">${loc.isDefault ? '<span class="badge badge-success">Default</span>' : ""}</div>
      `;

      const actions = document.createElement("div");
      actions.style.cssText = "grid-area:action;display:flex;gap:6px;flex-wrap:wrap;";

      const ren = document.createElement("button");
      ren.className = "btn btn-secondary btn-sm";
      ren.textContent = "Rename";
      ren.addEventListener("click", async () => {
        const name = prompt("New name for this location", loc.name);
        if (!name || name === loc.name) return;
        const res = await renameLocation(loc.id, name);
        if (!res.ok) { toast(res.error, { type: "danger" }); return; }
        toast("Renamed", { type: "success" });
        paint();
      });
      actions.appendChild(ren);

      // Archive is offered for the DEFAULT too, when there is more than one
      // location. v2_archive_location promotes the oldest survivor to default
      // afterwards, so this is safe -- and hiding the button was the interface
      // being stricter than the rule it was meant to reflect, with nothing on
      // screen explaining the difference.
      const canArchive = rows.filter((l) => !l.archived).length > 1;

      if (!loc.isDefault) {
        const def = document.createElement("button");
        def.className = "btn btn-secondary btn-sm";
        def.textContent = "Make default";
        // Worth spelling out, because "default" is otherwise a label with no
        // stated consequence: it is where new stock lands unless told otherwise.
        def.title = "New products and received stock go here unless you choose another location";
        def.addEventListener("click", async () => {
          const res = await setDefaultLocation(loc.id);
          if (!res.ok) { toast(res.error, { type: "danger" }); return; }
          toast(`"${loc.name}" is now the default`, { type: "success" });
          paint();
        });
        actions.appendChild(def);

      }

      if (canArchive) {
        const arc = document.createElement("button");
        arc.className = "btn btn-ghost btn-sm";
        arc.textContent = "Archive";
        // Disabled up front when it cannot succeed, WITH the reason on it.
        // The database refuses either way; showing why beforehand is the
        // difference between a rule and a rejection.
        if (t.onHand > 0) {
          arc.disabled = true;
          arc.title = `Still holds ${t.onHand} unit(s). Transfer them out first.`;
        } else if (loc.isDefault) {
          arc.title = "Another location will become the default automatically.";
        }
        arc.addEventListener("click", async () => {
          const res = await archiveLocation(loc.id);
          if (!res.ok) { toast(res.error, { type: "danger" }); return; }
          toast(`"${loc.name}" archived`, { type: "success" });
          paint();
        });
        actions.appendChild(arc);
      }

      r.appendChild(actions);
      list.appendChild(r);
    });
    host.appendChild(list);

    if (rows.length === 1) {
      host.appendChild(emptyState({
        icon: "🏬",
        title: "One location so far",
        body: "Add another and you can move stock between them — from Inventory, or from the Transfer button on any stock row.",
      }));
    }
  }

  await paint();
}

function placeholder(outlet, title, batchNote) {
  outlet.appendChild(pageHeader(title, `Not built yet — ${batchNote}`));
  outlet.appendChild(emptyState({ title: `${title} — coming soon`, body: "This route is wired and reachable; the view itself lands with its batch." }));
}

// ---------- Suppliers (Batch 17) ----------
// Hadi: "we should have one, a tab for different suppliers". This is the
// directory; creating one mid-product happens in the builder instead, because
// that form holds unsaved photos and a grid that no navigation survives.
//
// The word points the opposite way to the rest of the app: buyer.js's
// suppliers() means "wholesalers I buy from" seen from a buyer's seat. This is
// the wholesaler's own supply chain, and migration 050 closed the table to anon
// entirely, so nothing here is ever buyer-facing.
async function suppliersView(outlet) {
  const session = devAuth.getSession();
  const wid = session?.wid;
  outlet.innerHTML = "";
  outlet.appendChild(pageHeader(
    "Suppliers",
    "Who you buy from. Attach one to a product when you create it, so you can always find your way back to the source."
  ));

  const host = document.createElement("div");
  outlet.appendChild(host);

  let editingId = null;
  let creating = false;
  let showArchived = false;

  function field(label, key, value, type = "text") {
    return `<div class="pf-field">
      <label class="pf-label">${esc(label)}</label>
      <input class="input" data-f="${key}" type="${type}" value="${esc(value || "")}" autocomplete="off">
    </div>`;
  }

  function formCard(supplier) {
    const card = document.createElement("div");
    card.className = "card sup-form";
    card.style.padding = "14px";
    const sp = supplier || {};
    card.innerHTML = `
      <div class="pf-grid">
        <div class="pf-field pf-span-2">
          <label class="pf-label">Supplier name</label>
          <input class="input" data-f="name" value="${esc(sp.name || "")}" autocomplete="off" placeholder="e.g. Zhejiang Textiles">
        </div>
        ${field("Contact person", "contactName", sp.contactName)}
        ${field("Phone", "phone", sp.phone, "tel")}
        ${field("Email", "email", sp.email, "email")}
        ${field("Country", "country", sp.country)}
        <div class="pf-field pf-span-2">
          <label class="pf-label">Address</label>
          <input class="input" data-f="address" value="${esc(sp.address || "")}" autocomplete="off">
        </div>
        ${field("Your reference", "refCode", sp.refCode)}
        <div class="pf-field pf-span-2">
          <label class="pf-label">Notes</label>
          <input class="input" data-f="notes" value="${esc(sp.notes || "")}" autocomplete="off">
        </div>
      </div>
      <p class="pf-error" data-sup-error hidden></p>
    `;

    const actions = document.createElement("div");
    actions.className = "pf-actions";
    const save = document.createElement("button");
    save.className = "btn btn-primary btn-sm";
    save.textContent = supplier ? "Save changes" : "Add supplier";
    save.addEventListener("click", async () => {
      const read = (k) => card.querySelector(`[data-f="${k}"]`)?.value || "";
      const draft = {
        name: read("name"), contactName: read("contactName"), phone: read("phone"),
        email: read("email"), address: read("address"), country: read("country"),
        refCode: read("refCode"), notes: read("notes"),
      };
      save.disabled = true;
      const res = supplier ? await updateSupplier(supplier.id, draft) : await createSupplier(wid, draft);
      save.disabled = false;
      if (!res.ok) {
        // The database's own message: "You already have a supplier called X"
        // tells them to go and pick it, which "Save failed" does not.
        const err = card.querySelector("[data-sup-error]");
        err.textContent = res.error;
        err.hidden = false;
        return;
      }
      editingId = null; creating = false;
      toast(supplier ? "Supplier updated" : "Supplier added", { type: "success" });
      paint();
    });
    const cancel = document.createElement("button");
    cancel.className = "btn btn-secondary btn-sm";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { editingId = null; creating = false; paint(); });
    actions.appendChild(save); actions.appendChild(cancel);
    card.appendChild(actions);
    return card;
  }

  async function paint() {
    host.innerHTML = `<div class="card" style="padding:16px;font-size:13px;color:var(--text-tertiary);">Loading…</div>`;
    const [rows, counts] = await Promise.all([
      listSuppliers(wid, { includeArchived: showArchived }),
      supplierProductCounts(wid),
    ]);
    host.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "sup-bar";
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary btn-sm";
    addBtn.textContent = creating ? "Close" : "+ New supplier";
    addBtn.addEventListener("click", () => { creating = !creating; editingId = null; paint(); });
    bar.appendChild(addBtn);

    const arch = document.createElement("button");
    arch.className = "btn btn-ghost btn-sm";
    arch.textContent = showArchived ? "Hide archived" : "Show archived";
    arch.addEventListener("click", () => { showArchived = !showArchived; paint(); });
    bar.appendChild(arch);
    host.appendChild(bar);

    if (creating) host.appendChild(formCard(null));

    if (!rows.length) {
      host.appendChild(emptyState({
        icon: "🏭",
        title: showArchived ? "No suppliers yet" : "No suppliers yet",
        body: "Add the factories and vendors you buy from. You can also create one while building a product, without leaving the form.",
      }));
      return;
    }

    rows.forEach((sp) => {
      if (editingId === sp.id) { host.appendChild(formCard(sp)); return; }

      const used = counts.get(sp.id) || 0;
      const card = document.createElement("div");
      card.className = "card sup-row";
      const bits = [
        sp.contactName, sp.phone, sp.email,
        [sp.address, sp.country].filter(Boolean).join(", "),
        sp.refCode && `Ref ${sp.refCode}`,
      ].filter(Boolean);
      card.innerHTML = `
        <div class="sup-row-main">
          <div class="sup-row-name">${esc(sp.name)}${sp.archived ? ' <span class="badge badge-neutral">Archived</span>' : ""}</div>
          <div class="sup-row-meta">${bits.length ? bits.map(esc).join(" · ") : "No contact details yet"}</div>
          ${sp.notes ? `<div class="sup-row-notes">${esc(sp.notes)}</div>` : ""}
          <div class="sup-row-count">${used} product${used === 1 ? "" : "s"}</div>
        </div>
      `;

      const tools = document.createElement("div");
      tools.className = "sup-row-tools";

      const edit = document.createElement("button");
      edit.className = "btn btn-secondary btn-sm";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => { editingId = sp.id; creating = false; paint(); });
      tools.appendChild(edit);

      const toggle = document.createElement("button");
      toggle.className = "btn btn-ghost btn-sm";
      toggle.textContent = sp.archived ? "Restore" : "Archive";
      // Archive, never delete: supplier_id is `on delete set null`, so a real
      // delete would silently blank the sourcing on every product bought from
      // them. The product count sits right above this button so that cost is
      // visible before the click, not explained after it.
      toggle.addEventListener("click", async () => {
        const res = sp.archived ? await restoreSupplier(sp.id) : await archiveSupplier(sp.id);
        if (!res.ok) { toast(res.error, { type: "danger" }); return; }
        toast(sp.archived ? "Supplier restored" : "Supplier archived", { type: "success" });
        paint();
      });
      tools.appendChild(toggle);

      card.appendChild(tools);
      host.appendChild(card);
    });
  }

  await paint();
}

export function registerWholesalerRoutes(router) {
  router.register("/wholesaler", (outlet) => dashboard(outlet));
  router.register("/wholesaler/products", (outlet) => productsView(outlet));
  router.register("/wholesaler/orders", (outlet) => ordersView(outlet));
  router.register("/wholesaler/clients", (outlet) => clientsView(outlet));
  router.register("/wholesaler/team", (outlet) => teamView(outlet));
  router.register("/wholesaler/catalogs", (outlet) => catalogsView(outlet));
  router.register("/wholesaler/inventory", (outlet) => inventoryView(outlet));

  router.register("/wholesaler/locations", (outlet) => locationsView(outlet));
  router.register("/wholesaler/suppliers", (outlet) => suppliersView(outlet));
  router.register("/wholesaler/intelligence", (outlet) => intelligenceView(outlet));
  router.register("/wholesaler/settings", (outlet) => settingsView(outlet));
}
