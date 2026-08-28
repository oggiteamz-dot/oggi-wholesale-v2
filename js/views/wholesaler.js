// OGGI Wholesale v2 — Wholesaler views (Batch 3: real orders, products, inventory)
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
// (import from "../data/catalog.js" removed — every symbol it brought in was only used by renderRatioSection, deleted in CR-0001)
import { getWholesalerOrders, getWholesalerOrder, advanceOrderStatus, nextStatus, setFulfilNote } from "../data/wholesaler-orders.js";
import { listProductsForAdmin, toggleArchived, bulkUpdatePrice, duplicateAsTemplate, setCatalogOnly, getStockStates } from "../data/products-admin.js";
import { getStockTable, getStockByProduct, getSalesByProduct, receiveStock, getLocations } from "../data/inventory-admin.js";
import { getProductPricing, setProductMoq, addTier, removeTier, setVariantMoq, setVariantRetailPrice, setVariantReorderSettings, setVariantBarcode, setVariantImages, getOrderMinimums, setOrderMinimums } from "../data/pricing-admin.js";
// CR-0001, 24 Aug 2026: the ratio imports are gone from THIS file because
// renderRatioSection was deleted with it. js/data/size-ratios.js itself is
// untouched and still fully exported -- js/components/order-setup.js imports
// listRatios and ratioShorthand to offer a saved mix as an optional shortcut,
// and suggestPackRatio for "Suggest from what sells". Nothing was removed
// from the data layer; only this view stopped being the thing that used it.
import { getWholesalerSettings, updateWholesalerSettings } from "../data/wholesaler-settings.js";
import { getInventoryIntelligenceReport, getCycleCountSchedule, logCycleCount } from "../data/inventory-intelligence.js";
import { getInventorySignals, getVariantStatuses } from "../data/inventory-signals.js";
import { getMovementLedger, movementTypeLabel, referenceLabel, MOVEMENT_TYPES } from "../data/inventory-movements.js";
import { getInventoryValuation, isFullyCosted } from "../data/inventory-valuation.js";
import { assignInternalBarcodes, getLabelRows } from "../data/barcodes.js";
import { renderEan13Svg, isValidEan13, isInternalBarcode } from "../lib/barcode-ean13.js";
import { getInventorySettings, saveInventorySettings, resetInventorySettings, INVENTORY_SETTING_HELP, INVENTORY_SETTING_BOUNDS } from "../data/inventory-settings.js";
import { recordReceiptCost } from "../data/landed-cost.js";
import { listKits, createKit, archiveKit, assembleKit } from "../data/kits.js";
import { getClientsByRecency, deactivateClient, coverageSnapshot } from "../data/clients.js";
import { banClient, unbanClient, BAN_REASONS, banReasonLabel, getLiveBansByClient } from "../data/client-bans.js";
import { renderClientForm } from "../components/client-form.js";
import { updateCatalogSettings, addProductsToCatalog, DISCOUNT_MODES,
         catalogLink, setCatalogPublic, rotateCatalogLink,
         setBillboard, setHighlightLabel, setProductHighlighted,
         listCatalogs, getCatalogProducts, createCatalog, getDefaultCatalog,
         addProductToCatalog, removeProductFromCatalog } from "../data/catalogs.js";
import { createProduct, getProductForEdit, getProductDetail, updateProduct } from "../data/products-admin.js";
import { sellingModelBadge } from "../lib/selling-model.js";
import { openModal, closeModal } from "../lib/modal-stack.js";
import { openReceiveDialog } from "../components/receive-dialog.js";
import { ask, confirmAction } from "../components/ask.js";
import { receiveScanView } from "./mobile-ops.js";
import { renderOrderSetup } from "../components/order-setup.js";
import { router } from "../lib/router.js";
import { renderProductForm } from "../components/product-form.js";
import { renderProductTile, productGrid } from "../components/admin-product-tile.js";
import { renderProductDetail } from "../components/product-detail.js";
import { renderProductPicker } from "../components/product-picker.js";
import { renderBillboard } from "../components/billboard.js";
import { uploadCatalogBillboard } from "../data/uploads.js";
import { renderCardFactsPicker } from "../components/card-facts-picker.js";
// Batch 6: Inventory holds three panes now -- Stock, Products, Pricing rules.
import { renderSubTabs } from "../components/sub-tabs.js";
import { previewBulkPrice, applyBulkPrice, revertPriceBatch, recentPriceBatches, formatPct } from "../data/pricing-bulk.js";
import { factsFor, normaliseFacts } from "../lib/card-facts.js";
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
  const [orders, stock, statusByVariant] = await Promise.all([
    getWholesalerOrders(wid), getStockTable(wid), getVariantStatuses(wid),
  ]);
  const openOrders = orders.filter((o) => o.status !== "delivered" && o.status !== "cancelled").length;
  // Batch 1: counted per VARIANT from the shared signal, not per stock row
  // against a flat 15. Two things changed and both were wrong before:
  // "low" now means less cover than the wholesaler's target rather than a
  // unit count that means something different for every SKU, and a variant
  // stocked in two warehouses is counted once rather than twice.
  const variantStatuses = [...statusByVariant.values()];
  const lowStockCount = variantStatuses.filter((s) => s.status === "low" || s.status === "reorder").length;
  const outOfStockCount = variantStatuses.filter((s) => s.status === "out").length;

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

    // Batch N step 2 -- the note, ON THE LIST, not one click deep.
    //
    // This is the single most-repeated complaint about order notes in the
    // research behind this batch: not that they are badly designed, but that
    // they sit somewhere nobody opens. A Cin7 user asked, verbatim, for a
    // comments box "on the list of SO's so that we don't have to open up each
    // invoice". A badge saying a note EXISTS is not good enough either -- the
    // recurring Shopify complaint is "the icon is there but no note shown".
    // So: show the words, truncated, right here.
    const noteBits = [];
    if (order.notes) noteBits.push({ label: "On the order", text: order.notes });
    order.items.forEach((i) => {
      if (i.buyerNote) {
        noteBits.push({ label: i.isPack ? `${esc(i.productName)} pack` : `${esc(i.productName)} (${esc(i.color || "")}/${esc(i.size || "")})`, text: i.buyerNote });
      }
    });
    if (noteBits.length) {
      const nb = document.createElement("div");
      nb.className = "order-notes-preview";
      nb.style.cssText = "border-left:3px solid var(--accent-500,#54E5A0);padding:8px 10px;margin:0 0 10px 0;background:var(--surface-2,rgba(84,229,160,.06));border-radius:0 6px 6px 0;";
      nb.innerHTML = `<div style="font-size:11px;font-weight:700;letter-spacing:.02em;color:var(--text-tertiary);margin-bottom:4px;">WHAT THE BUYER ASKED FOR</div>` +
        noteBits.slice(0, 3).map((n) => {
          const oneLine = String(n.text).replace(/\s+/g, " ").trim();
          const shown = oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
          return `<div style="font-size:12px;line-height:1.45;margin-bottom:2px;"><span style="color:var(--text-tertiary);">${n.label}:</span> <strong style="font-weight:600;">${esc(shown)}</strong></div>`;
        }).join("") +
        (noteBits.length > 3 ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">+ ${noteBits.length - 3} more — open the order to read them all</div>` : "");
      card.appendChild(nb);
    }

    const openLink = document.createElement("a");
    openLink.className = "btn btn-secondary btn-sm";
    openLink.href = `#/wholesaler/orders/${order.id}`;
    openLink.textContent = "Open order";
    openLink.style.marginRight = "8px";
    card.appendChild(openLink);
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

// ===========================================================================
// Batch N step 2 -- ONE ORDER, IN FULL.
//
// Until this screen existed the wholesaler's Orders tab was summary cards and
// nothing to click: buyer name, date, status, total, and one comma-joined
// string of items. Hadi's ask was "they can go click and they can see the full
// order, what each item was ordered, what is the comment".
//
// Two rules from the research shape it:
//   1. The buyer's note is rendered against ITS OWN LINE, never pooled at the
//      bottom. A note detached from the thing it is about is a note nobody
//      acts on.
//   2. A pack is shown as a pack AND exploded into the pieces it contains.
//      A warehouse cannot pick "2 x Boutique Pack"; it picks 2 small, 4 medium,
//      4 large. Showing only the collapsed form is how a picking error happens.
// ===========================================================================
async function orderDetailView(outlet, orderId) {
  const session = devAuth.getSession();
  const wid = session.wid;

  const order = await getWholesalerOrder(wid, orderId);
  if (!order) {
    outlet.appendChild(pageHeader("Order", ""));
    outlet.appendChild(emptyState({
      icon: "🔍", title: "That order could not be found",
      body: "It may belong to a different wholesaler, or it may have been removed. Nothing has been changed.",
    }));
    const back = document.createElement("a");
    back.className = "btn btn-secondary"; back.href = "#/wholesaler/orders"; back.textContent = "Back to orders";
    outlet.appendChild(back);
    return;
  }

  const STATUS_BADGE = { new: "badge-info", confirmed: "badge-accent", shipped: "badge-warning", delivered: "badge-success", cancelled: "badge-danger" };
  const currency = "$";

  outlet.appendChild(pageHeader(`Order from ${order.buyerLabel}`,
    `Placed ${new Date(order.createdAt).toLocaleString()}`));

  const back = document.createElement("a");
  back.className = "btn btn-ghost btn-sm no-print";
  back.href = "#/wholesaler/orders";
  back.textContent = "← All orders";
  back.style.marginBottom = "12px";
  outlet.appendChild(back);

  // ---- the header card ----------------------------------------------------
  const head = document.createElement("div");
  head.className = "card";
  head.style.cssText = "padding:16px;margin-bottom:14px;";
  const totalPieces = order.rawLines.reduce((n, l) => n + l.qty, 0);
  head.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:700;font-size:16px;">${esc(order.buyerLabel)}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">
          ${totalPieces} piece${totalPieces === 1 ? "" : "s"} · ${order.items.length} line${order.items.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style="text-align:right;">
        <span class="badge ${STATUS_BADGE[order.status] || "badge-neutral"}">${esc(order.status)}</span>
        <div style="font-weight:700;font-size:20px;margin-top:4px;">${currency}${order.subtotal.toFixed(2)}</div>
      </div>
    </div>`;
  outlet.appendChild(head);

  // ---- Migration 087: the wholesaler's OWN note, to their warehouse -------
  //
  // Deliberately a different colour, a different label and a different side of
  // the line from the buyer's note. Two authors, two audiences: one is a
  // customer's request, the other is an internal instruction. If a future
  // reader has to think for a second about which is which, this has failed.
  function fulfilEditor(labelText, currentValue, itemId) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin:10px 0 0 0;padding:10px 12px;border-left:3px solid var(--warning-500,#d9a521);background:var(--surface-2,rgba(217,165,33,.07));border-radius:0 6px 6px 0;";

    const label = document.createElement("div");
    label.style.cssText = "font-size:10px;font-weight:700;letter-spacing:.03em;color:var(--text-tertiary);margin-bottom:4px;";
    label.textContent = labelText;

    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.rows = 1;
    ta.placeholder = "e.g. pull from the back stock";
    ta.value = currentValue || "";
    ta.style.cssText = "width:100%;min-height:36px;resize:vertical;font-size:13px;line-height:1.45;";
    ta.setAttribute("aria-label", labelText);
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
    ta.addEventListener("input", grow);
    requestAnimationFrame(grow);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-top:4px;min-height:14px;";

    let lastSaved = currentValue || "";
    ta.addEventListener("blur", async () => {
      const next = ta.value.trim();
      if (next === lastSaved) { hint.textContent = ""; return; }
      hint.style.color = "var(--text-tertiary)";
      hint.textContent = "Saving…";
      const result = await setFulfilNote(order.id, next, itemId);
      if (!result.ok) {
        // Never fail silently. A note the wholesaler believes their warehouse
        // will read, that was never stored, is worse than no field at all.
        hint.style.color = "var(--danger,#c33)";
        hint.textContent = result.error?.message || "That note could not be saved — please try again.";
        return;
      }
      lastSaved = next;
      hint.textContent = next ? "Saved. Only your team sees this." : "Note cleared.";
      setTimeout(() => { hint.textContent = ""; }, 2500);
    });

    wrap.appendChild(label);
    wrap.appendChild(ta);
    wrap.appendChild(hint);
    return wrap;
  }

  // ---- the buyer's note about the WHOLE order -----------------------------
  if (order.notes) {
    const on = document.createElement("div");
    on.className = "card";
    on.style.cssText = "padding:14px 16px;margin-bottom:14px;border-left:4px solid var(--accent-500,#54E5A0);";
    on.innerHTML = `
      <div style="font-size:11px;font-weight:700;letter-spacing:.02em;color:var(--text-tertiary);margin-bottom:6px;">THE BUYER'S NOTE ON THIS ORDER</div>
      <div style="font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(order.notes)}</div>`;
    outlet.appendChild(on);
  }

  // The wholesaler's instruction for the order as a whole.
  const orderFulfil = document.createElement("div");
  orderFulfil.className = "card";
  orderFulfil.style.cssText = "padding:14px 16px;margin-bottom:14px;";
  orderFulfil.appendChild(fulfilEditor("YOUR NOTE TO THE WAREHOUSE — THE BUYER NEVER SEES THIS", order.fulfilNote, null));
  outlet.appendChild(orderFulfil);

  // ---- every line ---------------------------------------------------------
  const list = document.createElement("div");
  list.className = "card";
  list.style.cssText = "padding:0;margin-bottom:14px;overflow:hidden;";

  order.items.forEach((line, idx) => {
    const row = document.createElement("div");
    row.style.cssText = `padding:14px 16px;${idx ? "border-top:1px solid var(--border-subtle);" : ""}`;

    const photo = line.isPack
      ? (line.components[0] && line.components[0].imageUrl) || null
      : line.imageUrl;
    const swatch = line.isPack ? null : line.colorHex;

    const thumb = photo
      ? `<img src="${esc(photo)}" alt="" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex:none;background:var(--surface-2);">`
      : `<div style="width:56px;height:56px;border-radius:8px;flex:none;background:${swatch ? esc(swatch) : "var(--surface-2)"};display:flex;align-items:center;justify-content:center;font-size:20px;">${swatch ? "" : "📦"}</div>`;

    if (line.isPack) {
      // The pack, AND what is actually inside it. Both, always.
      const pieces = line.components.reduce((n, c) => n + c.qty, 0);
      row.innerHTML = `
        <div style="display:flex;gap:12px;align-items:flex-start;">
          ${thumb}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;gap:10px;">
              <div>
                <span class="badge badge-info" style="margin-right:6px;">Pack</span>
                <strong style="font-size:14px;">${line.packQty}× ${esc(line.productName)}</strong>
              </div>
              <div style="font-weight:700;white-space:nowrap;">${currency}${line.lineTotal.toFixed(2)}</div>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">
              <strong>${pieces} pieces</strong> to pick:
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
              ${line.components.map((c) => `<span style="font-size:12px;padding:3px 8px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border-subtle);"><strong>${c.qty}×</strong> ${esc(c.color || "")}${c.color && c.size ? " / " : ""}${esc(c.size || c.sku || "")}</span>`).join("")}
            </div>
          </div>
        </div>`;
    } else {
      row.innerHTML = `
        <div style="display:flex;gap:12px;align-items:flex-start;">
          ${thumb}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;gap:10px;">
              <div>
                <strong style="font-size:14px;">${line.qty}× ${esc(line.productName)}</strong>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">
                  ${esc(line.color || "")}${line.color && line.size ? " · " : ""}${esc(line.size || "")}
                  ${line.sku ? ` · <span style="font-family:ui-monospace,monospace;">${esc(line.sku)}</span>` : ""}
                </div>
              </div>
              <div style="text-align:right;white-space:nowrap;">
                <div style="font-weight:700;">${currency}${line.lineTotal.toFixed(2)}</div>
                <div style="font-size:11px;color:var(--text-tertiary);">${currency}${line.unitPrice.toFixed(2)} each</div>
              </div>
            </div>
          </div>
        </div>`;
    }

    // The note sits against ITS OWN LINE. Never pooled at the bottom.
    if (line.buyerNote) {
      const n = document.createElement("div");
      n.style.cssText = "margin:10px 0 0 68px;padding:8px 10px;border-left:3px solid var(--accent-500,#54E5A0);background:var(--surface-2,rgba(84,229,160,.06));border-radius:0 6px 6px 0;";
      n.innerHTML = `<div style="font-size:10px;font-weight:700;letter-spacing:.03em;color:var(--text-tertiary);margin-bottom:3px;">BUYER'S NOTE</div>` +
                    `<div style="font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(line.buyerNote)}</div>`;
      row.appendChild(n);
    }

    // ...and the wholesaler's own instruction for this line, underneath it.
    const fw = fulfilEditor("YOUR NOTE TO THE WAREHOUSE", line.fulfilNote, line.itemId);
    fw.style.marginLeft = "68px";
    row.appendChild(fw);

    list.appendChild(row);
  });
  outlet.appendChild(list);

  // ---- actions, unchanged from the list view -------------------------------
  const actions = document.createElement("div");
  actions.className = "no-print";
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
  const next = nextStatus(order.status);
  if (next) {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.style.minHeight = "44px";
    btn.textContent = `Mark ${next}`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await advanceOrderStatus(order.id, next);
      if (error) { toast("Failed to update order status", { type: "danger" }); btn.disabled = false; return; }
      toast(`Order marked ${next}`, { type: "success" });
      outlet.innerHTML = "";
      orderDetailView(outlet, orderId);
    });
    actions.appendChild(btn);
  }
  if (order.status === "confirmed" || order.status === "shipped") {
    const pick = document.createElement("a");
    pick.className = "btn btn-secondary";
    pick.style.minHeight = "44px";
    pick.href = `#/wholesaler/pick/${order.id}`;
    pick.textContent = "Scan to pick";
    actions.appendChild(pick);
  }
  outlet.appendChild(actions);
}

// One product panel opener, shared by Products and Catalogs.
//
// Lifted out of the products pane on 20 Aug 2026 when the ratio editor was
// added to Catalogs as well. Copying the closure into the second view
// would have worked on the day and rotted the moment one of the two got
// fixed -- the same duplicate-helper failure this repo keeps a table of.
// The only thing that differs between callers is where the panel lands,
// so that is the only thing passed in.
// CHANGED 23 Aug 2026 (Batch 8, C1/C2). It used to append the panel into
// `panelHost` -- a div that sits AFTER the entire product grid -- and then
// call card.scrollIntoView({ block: "nearest" }) to bring it into view.
//
// Measured on Hadi's live catalog before the change:
//
//     panel top   1608px
//     viewport     911px
//     page scrolled  0px
//
// The scroll call resolved against a scrolling container that was not the
// one actually scrolling, so it silently did nothing. Clicking "Packs &
// ratios" moved nothing on screen and produced no error. Hadi's report was
// "I can't see how to use the different ratio in the pre-pack" -- the
// feature was there and had been unreachable since the day it shipped.
//
// The fix is not a better scrollIntoView. A panel whose visibility depends
// on a scroll call landing correctly is a panel that will break again the
// next time anything about the page's scroll structure changes. This is now
// a DRAWER: fixed to the viewport, so where it appears cannot depend on how
// long the grid above it is, how far down the page you are, or which
// element owns the scrollbar. There is no measurement left to get wrong.
//
// `panelHost` is still accepted and still identifies the owner, so both
// callers (Products pane, Catalogs) are unchanged.
let openDrawer = null;

function closeProductPanel() {
  // Batch 8A. This drawer was the ONE dialog in the app that already defended
  // itself against navigation -- it hand-rolled a "v2:navigated" listener, an
  // Escape listener, a scroll lock and focus return. All four are now the
  // modal stack's job, so this is the same behaviour with one owner instead
  // of four copies, and the three dialogs that had none of it get all of it.
  if (!openDrawer) return;
  const { root } = openDrawer;
  openDrawer = null;          // cleared FIRST: closeModal() runs onClose, and
  closeModal(root);           // a re-entrant call must not close twice.
}

/**
 * Open the ratio / prepack builder for a product id, from anywhere.
 *
 * Batch 8D, 23 Aug 2026. Hadi: "I have zero ways of actually opening this up.
 * I think you're thinking that there's going to be an AI building this. No,
 * it's going to be a human. So it needs to be manual."
 *
 * Until now the only door was a card action, three screens from where the
 * selling model is actually chosen. This is the same drawer, opened from the
 * product form, at the moment the decision is made.
 *
 * Refetched rather than handed a product object, because the caller is a form
 * that has just written to the database and whatever it holds in memory is a
 * draft, not what was stored.
 */
async function openSellingSetup(productId, model) {
  const session = devAuth.getSession();
  const wid = session?.wid;
  const fresh = await getProductForEdit(productId);
  if (!fresh.ok) { toast(fresh.error || "Could not open that product.", { type: "danger" }); return; }
  const product = { ...fresh.product, variants: fresh.variants };
  const title = model === "prepack" ? "Prepacks" : "Ratios and prepacks";
  openProductPanel(null, title, product, (body) => renderPacksPanel(body, wid, product));
}

function openProductPanel(panelHost, title, product, painter) {
  // Only one drawer at a time, and a second click replaces the first rather
  // than stacking two fixed elements on top of each other.
  closeProductPanel();
  const returnFocus = document.activeElement;

  const root = document.createElement("div");
  root.className = "pdrawer-root";

  const backdrop = document.createElement("div");
  backdrop.className = "pdrawer-backdrop";
  backdrop.addEventListener("click", closeProductPanel);
  root.appendChild(backdrop);

  const card = document.createElement("div");
  card.className = "pdrawer card pdet";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", `${product.name} — ${title}`);

  const head = document.createElement("div");
  head.className = "pdet-head pdrawer-head";
  head.innerHTML = `<div><h4>${esc(product.name)}</h4><p>${esc(title)}</p></div>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-ghost btn-sm";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeProductPanel);
  const headActions = document.createElement("div");
  headActions.className = "pdet-head-actions";
  headActions.appendChild(closeBtn);
  head.appendChild(headActions);
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "pdrawer-body";
  body.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">Loading…</div>`;
  card.appendChild(body);
  root.appendChild(card);

  // Escape, the scroll lock, focus return and closing-on-navigation all come
  // from the stack now. The onClose hook clears this module's own handle so
  // that a close triggered from anywhere -- Escape, a route change, another
  // drawer opening -- leaves openDrawer in step with what is actually on
  // screen. A stale handle here is how a second click does nothing.
  openDrawer = { root, returnFocus };
  openModal(root, {
    label: `${product.name} — ${title}`,
    onClose: () => { openDrawer = null; },
  });

  closeBtn.focus();
  painter(body);
}

// ---------- Products ----------

/**
 * The PRODUCTS pane of the Inventory screen. Batch 6.
 *
 * Was its own top-level screen at /wholesaler/products until 21 Aug 2026. Hadi
 * asked for it to become a sub-tab of Inventory, and he was right: both screens
 * listed the same products, from the same tile component, with the same card
 * facts, differing only in which figures they showed and which buttons the card
 * offered. Two doors into one room.
 *
 * The two wholesaler-wide controls that used to sit at the bottom of this
 * screen -- bulk price update and the order-level minimum -- moved to the
 * Pricing rules pane. They are not properties of any product, and a bulk
 * reprice of the entire catalogue does not belong at the foot of a list you
 * scroll past forty times a day.
 */
/**
 * The "+ New product" bar, shared by the Stock pane and the Products pane.
 *
 * Batch 8E, 23 Aug 2026. Hadi: "I can't create a product anymore in the
 * products tab."
 *
 * He was right, and it had been true since Batch 6 folded the standalone
 * Products screen into Inventory: the create button lives on the STOCK pane,
 * and the PRODUCTS pane — the one actually called "Products" — had none. If
 * you had no products at all it was worse: that pane returned early on an
 * empty state, so the tab named after products offered no way to make one.
 *
 * Extracted rather than copied. Two inline copies of a form this size is how
 * one of them quietly stops passing onOpenSellingSetup, and then the ratio
 * button is dead on exactly one screen -- which is the shape of the bug this
 * batch already fixed once.
 */
function mountNewProductBar(outlet, { wid, locations = [], suppliers = [], location = null,
                                      catalogName = "your main catalog", reload = () => {} }) {
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
      catalogName,
      locations,
      hasLocation: !!location,
      locationName: location?.name || "",
      suppliers,
      // Creating a supplier without leaving a half-built product: this form
      // holds unsaved photos and a stock grid, neither of which survives a
      // navigation, so "go and make one first" would mean losing the work.
      onCreateSupplier: (draft) => createSupplier(wid, draft),
      onCancel: () => { formHost.innerHTML = ""; newBtn.textContent = "+ New product"; },
      onOpenSellingSetup: (pid, model) => openSellingSetup(pid, model),
      onSubmit: async (draft) => {
        const res = await createProduct(wid, { ...draft, locationId: draft.locationId || location?.id || null });
        if (res.ok) {
          toast(res.message, { type: res.variantsFailed?.length ? "warning" : "success" });
          // Batch 8D. Repainting here destroys the form -- and with it the
          // "Set ratios" button that has just appeared on it. For a model that
          // CANNOT be sold until it has a pack, throwing the person back to a
          // list is how the product stays unsellable. The pane repaints when
          // they close the form instead.
          const needsSetup = draft.sellingModel === "ratio" || draft.sellingModel === "prepack";
          if (!needsSetup) reload();
        }
        return res;
      },
    });
    formHost.appendChild(form.el);
    form.focus();
  });
}

async function productsPane(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;

  const [products, prodLocations, prodSettings] = await Promise.all([
    listProductsForAdmin(wid), getLocations(wid), getWholesalerSettings(wid),
  ]);
  const prodFacts = normaliseFacts(prodSettings.card_facts, prodLocations);
  const prodSales = prodFacts.some((k) => ["unitsSold", "orderCount", "lastSold"].includes(k))
    ? await getSalesByProduct(wid) : new Map();

  // Batch 8E. Hadi: "I can't create a product anymore in the products tab."
  // Since Batch 6 folded the standalone Products screen into Inventory, the
  // only create button was on the STOCK pane. Same bar, same form, same
  // createProduct() -- mounted BEFORE the empty-state return below, because
  // the state with no products is precisely when you most need to make one.
  const [prodSuppliers, prodDefaultCatalog] = await Promise.all([
    listSuppliers(wid), getDefaultCatalog(wid),
  ]);
  mountNewProductBar(outlet, {
    wid,
    locations: prodLocations,
    suppliers: prodSuppliers,
    location: prodLocations[0] || null,
    catalogName: prodDefaultCatalog?.name || "your main catalog",
    reload: () => { outlet.innerHTML = ""; productsPane(outlet); },
  });

  if (!products.length) {
    outlet.appendChild(emptyState({
      icon: "📦", title: "No products yet",
      body: "Add one with the button above, or import a catalog. Anything migrated from your existing catalog appears here too.",
    }));
    return;
  }

  // Cards, not rows -- the same component Inventory uses. Hadi on the old
  // layout: "It's too tiny. The thumbnail is ultra tiny." A product list is a
  // catalogue, and you find a garment in a catalogue by recognising it.
  //
  // Pricing and Packs stayed as panels that open UNDER the grid rather than
  // living inside the card: a card with its panels inline would push every
  // other card down the page, and the grid is the thing being scanned.
  const reload = () => { outlet.innerHTML = ""; productsPane(outlet); };
  const grid = productGrid();
  const panelHost = document.createElement("div");

  // Was a closure private to this view until 20 Aug 2026. Lifted out to
  // openProductPanel() below so Catalogs can open the same panels without
  // a second copy of it -- this file's own rule is that a helper
  // copy-pasted into two places is a bug waiting for one copy to be fixed.
  const openPanel = (title, product, painter) => openProductPanel(panelHost, title, product, painter);

  products.forEach((p) => {
    const badges = [];
    if (p.archived) badges.push({ text: "Archived", kind: "badge-neutral" });
    // Batch 8, C4. Enforced by the server since migrations 029/030 and never
    // once said on screen. Null for open stock -- see js/lib/selling-model.js
    // for why the default deliberately does not get a badge.
    const smA = sellingModelBadge(p.selling_model);
    if (smA) badges.push(smA);

    grid.appendChild(renderProductTile({
      id: p.id,
      name: p.name,
      images: p.images || [],
      badges,
      facts: factsFor({ ...p, ...(prodSales.get(p.id) || {}) }, prodFacts, { locations: prodLocations }),
      actions: [
        { label: "View", variant: "btn-primary", onClick: () => openProductView(p.id, reload) },
        { label: "Edit", onClick: () => openProductEditor(p.id, reload) },
        { label: "Pricing & MOQ", onClick: () => openPanel("Pricing, tiers and minimums", p, (body) => renderPricingPanel(body, p)) },
        { label: "Packs", onClick: () => openPanel("Prepacks and ratios", p, (body) => renderPacksPanel(body, wid, p)) },
        { label: p.archived ? "Unarchive" : "Archive", onClick: async () => {
            await toggleArchived(p.id, !p.archived);
            toast(p.archived ? "Unarchived" : "Archived", { type: "success" });
            reload();
          } },
        { label: "Duplicate as template", title: "Creates an archived, zero-stock copy you can edit and publish", onClick: async () => {
            const result = await duplicateAsTemplate(p.id);
            toast(result.ok ? "Template created (archived, zero stock — edit and publish when ready)" : "Duplicate failed",
                  { type: result.ok ? "success" : "danger" });
            if (result.ok) reload();
          } },
      ],
      onOpen: () => openProductView(p.id, reload),
    }));
  });

  outlet.appendChild(grid);
  outlet.appendChild(panelHost);
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
    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;" title="Counted across all sizes of that colour. 12 means twelve red in any size mix — not twelve of each size.">Minimum per colour (optional)</label>
      <input class="input" id="moq-colour" type="number" min="1" value="${pricing.moqPerColour ?? ""}" style="width:110px;" placeholder="no limit" /></div>
  `;
  const saveMoqBtn = document.createElement("button");
  saveMoqBtn.className = "btn btn-primary btn-sm";
  saveMoqBtn.textContent = "Save MOQ";
  saveMoqBtn.addEventListener("click", async () => {
    const moqQty = parseInt(panel.querySelector("#moq-first").value, 10) || 1;
    const reorderRaw = panel.querySelector("#moq-reorder").value;
    const moqReorderQty = reorderRaw === "" ? null : parseInt(reorderRaw, 10);
    // Blank clears the rule. Passing "" rather than leaving it out is
    // deliberate -- see setProductMoq: omission means "don't touch",
    // empty means "remove the limit", and a wholesaler needs both.
    const colourRaw = panel.querySelector("#moq-colour").value;
    const moqPerColour = colourRaw === "" ? null : parseInt(colourRaw, 10);
    const { error } = await setProductMoq(product.id, { moqQty, moqReorderQty, moqPerColour });
    toast(error
      ? "Failed to save MOQ"
      : (moqPerColour ? `Saved — every colour now needs at least ${moqPerColour}` : "MOQ saved"),
      { type: error ? "danger" : "success" });
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

// ---------- Ratio-first pack authoring (migration 061) ----------
//
// This section sits ABOVE the old per-variant pack builder, which is
// deliberately left in place below it: it is still the right tool for a
// genuinely bespoke one-off pack, and deleting a working feature to make
// room for a new one is how things silently disappear here.
//
// What it replaces is the DEFAULT path. Before this, the only way to
// build a pack was to type a quantity into every colour x size row --
// 8 colours x 8 sizes is 64 boxes, one pack at a time, and it is why
// nobody used the builder. Now: write the curve once as a single row of
// steppers, then apply it to every colour in one click.
/**
 * The one panel behind "Packs & ratios".  CR-0001, 24 Aug 2026.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT IS GONE
 * ----------------------------------------
 * Two builders, stacked in one drawer:
 *
 *   renderRatioSection()  -- base unit, a saved-ratio LIBRARY, a MANDATORY
 *                            name field, a row of steppers, four starter
 *                            buttons, "save ratio and apply to all colours".
 *   the pack builder      -- pack name, colour, a "flat price (not charged)"
 *                            box, a suggest button, and ONE ROW PER VARIANT.
 *                            64 rows on an 8x8 product.
 *
 * Hadi's own Aug-20 spec had already called for this: SM-30, "Kill the 64-row
 * list", and "Never make the wholesaler re-enter a ratio per colour or per
 * product -- THIS IS THE ENTIRE COMPLAINT." The ratio row was added ABOVE the
 * 64-row list instead of replacing it, so both shipped, and the complaint
 * stood. That makes most of this a defect against an approved spec rather
 * than a change of mind.
 *
 * NOTHING IS LOST. Both features that lived only in the old builder came
 * across into js/components/order-setup.js as shortcuts:
 *   - "Suggest from what sells"  (was suggestPackRatio)
 *   - the saved-mix library      (was listRatios), now optional, never a gate
 * The ratio data layer (js/data/size-ratios.js) is untouched and still
 * exported, so a saved mix made before today still opens.
 *
 * NO MIGRATION. v2_enforce_selling_model (migration 063) already rejects loose
 * lines for 'series', 'prepack' AND 'ratio' with identical logic -- three
 * names for one rule. Existing products keep their selling_model and are never
 * re-classified; the new panel only ever writes 'open' or 'prepack'.
 */
async function renderPacksPanel(panel, wid, product) {
  panel.innerHTML = "";
  panel.appendChild(renderOrderSetup({
    product,
    wid,
    // The way out of the "no colours or sizes yet" state. The drawer closes
    // first -- leaving it open behind the editor is the orphaned-dialog bug of
    // 23 Aug, and the editor is itself a modal. Refetched on the way back, so
    // the grid is built over sizes the database actually accepted rather than
    // over the editor's draft, which it is allowed to alter or reject.
    onAddVariants: () => {
      closeProductPanel();
      openProductEditor(product.id, async () => {
        const fresh = await getProductForEdit(product.id);
        const next = fresh.ok ? { ...fresh.product, variants: fresh.variants } : product;
        openProductPanel(null, "How buyers order this", next, (body) => renderPacksPanel(body, wid, next));
      });
    },
    // Refetch rather than patch from memory: the database is allowed to reject
    // or alter what it was given, and a panel repainted from an optimistic
    // local copy is a panel that can disagree with what was actually saved.
    onSaved: async () => {
      const fresh = await getProductForEdit(product.id);
      const next = fresh.ok ? { ...fresh.product, variants: fresh.variants } : product;
      renderPacksPanel(panel, wid, next);
    },
  }));
}

async function stockPane(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;

  const [stock, locations, suppliers, settings] = await Promise.all([
    getStockTable(wid), getLocations(wid), listSuppliers(wid), getWholesalerSettings(wid),
  ]);
  const cardFacts = normaliseFacts(settings.card_facts, locations);
  // Sales figures cost a sweep of every order line this wholesaler has ever
  // had, so they are fetched ONLY when a sales fact is actually switched on.
  // Paying for two numbers nobody asked to see would be the wrong trade on a
  // screen people open forty times a day.
  const wantsSales = cardFacts.some((k) => ["unitsSold", "orderCount", "lastSold"].includes(k));
  const sales = wantsSales ? await getSalesByProduct(wid) : new Map();
  const location = locations[0] || null;

  // The SECOND entry point for product creation. Same component, same
  // createProduct(), same guarantees -- it just does not name a catalog, so
  // the product is filed in the wholesaler's default one. Hadi asked for both:
  // "you can either create a product inside the inventory, or you can create a
  // product inside the actual catalogs".
  const defaultCatalog = await getDefaultCatalog(wid);

  mountNewProductBar(outlet, {
    wid, locations, suppliers, location,
    catalogName: defaultCatalog?.name || "your main catalog",
    reload: () => { outlet.innerHTML = ""; stockPane(outlet); },
  });

  if (!stock.length) {
    outlet.appendChild(emptyState({
      icon: "📊", title: "Nothing in stock yet",
      body: "Add a product with the button above, or import a catalog. Every variant you create shows up here — including ones you have not received stock into yet.",
    }));
    return;
  }

  // One card per PRODUCT, with the colour/size breakdown inside it. The old
  // layout was a row per colour+size+location, so a seven-variant product
  // filled seven near-identical text rows -- a ledger, when what a wholesaler
  // needs to find a garment is a catalogue.
  const [products, invStatusByVariant] = await Promise.all([getStockByProduct(wid), getVariantStatuses(wid)]);
  const grid = productGrid();
  const reload = () => { outlet.innerHTML = ""; stockPane(outlet); };

  const factsCard = renderCardFactsPicker({
    selected: cardFacts,
    locations,
    onSave: async (keys) => {
      const { error } = await updateWholesalerSettings(wid, { cardFacts: keys });
      if (error) { toast("Could not save what the cards show.", { type: "danger" }); return { ok: false, error: error.message }; }
      toast("Saved. Every product card now shows what you picked.", { type: "success" });
      reload();
      return { ok: true };
    },
  });
  outlet.appendChild(factsCard.el);

  products.forEach((p) => {
    const badges = [];
    if (p.outCount) badges.push({ text: `${p.outCount} out`, kind: "badge-danger" });
    if (p.lowCount) badges.push({ text: `${p.lowCount} low`, kind: "badge-warning" });
    if (p.neverStockedCount) badges.push({ text: `${p.neverStockedCount} not stocked`, kind: "badge-neutral" });
    // CR-0004. A colour with no photograph still sells -- it shows the buyer an
    // honest empty frame rather than another colour's garment. That is only a
    // fair trade if the wholesaler can SEE it, so it is said here, where they
    // are already looking at the product, rather than left to be discovered by
    // a customer. Amber, not red: incomplete, not broken.
    if (p.noPhotoColours) {
      badges.push({
        text: `${p.noPhotoColours} colour${p.noPhotoColours === 1 ? "" : "s"} without photos`,
        kind: "badge-warning",
        title: "Buyers see an empty frame for these colours. They can still be ordered — open the product and tap the photos that belong to each colour.",
      });
    }

    const tile = renderProductTile({
      id: p.productId,
      name: p.productName,
      images: p.images,
      badges,
      // Whatever the wholesaler chose, in their order. One definition of each
      // fact, shared with Products, Catalogs and the picker.
      facts: factsFor({ ...p, ...(sales.get(p.productId) || {}) }, cardFacts, { locations }),
      actions: [
        { label: "Receive & transfer", variant: "btn-primary", onClick: () => openProductDetail(p) },
        { label: "View", onClick: () => openProductView(p.productId, reload) },
        { label: "Edit", onClick: () => openProductEditor(p.productId, reload) },
      ],
      onOpen: () => openProductDetail(p),
    });
    grid.appendChild(tile);
  });
  outlet.appendChild(grid);

  const detailHost = document.createElement("div");
  outlet.appendChild(detailHost);

  /** The colour/size breakdown, opened under the grid. Inline rather than a
   *  modal for the same reason the transfer panel is: on a phone a centred
   *  dialog covers the very figures the operator is deciding against. */
  function openProductDetail(p) {
    detailHost.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "card inv-detail";

    const head = document.createElement("div");
    head.className = "inv-detail-head";
    head.innerHTML = `<h4>${esc(p.productName)}</h4>
      <p>${p.variantCount} colour/size combination${p.variantCount === 1 ? "" : "s"} · ${p.available} available of ${p.onHand} on hand</p>`;
    // Batch 2: the ledger, reachable from the number it explains. A wholesaler
    // looking at "12 available" and expecting 20 is one tap from the list of
    // every movement that produced the 12 -- rather than having to know a
    // Stock Movements screen exists and then filter their way back here.
    const history = document.createElement("button");
    history.className = "btn btn-secondary btn-sm";
    history.textContent = "History";
    history.title = `Every stock movement for ${p.productName}`;
    history.style.minHeight = "44px";
    history.addEventListener("click", () => {
      location.hash = `#/wholesaler/movements/${encodeURIComponent(p.productId)}`;
    });
    head.appendChild(history);

    const close = document.createElement("button");
    close.className = "btn btn-ghost btn-sm";
    close.textContent = "Close";
    close.addEventListener("click", () => { detailHost.innerHTML = ""; });
    head.appendChild(close);
    panel.appendChild(head);

    p.variants.forEach((row) => {
      const r = document.createElement("div");
      r.className = "inv-row";
      // Batch 1: same shared verdict as the dashboard and the intelligence
      // screen, with the days of cover shown so the badge is checkable rather
      // than something the wholesaler has to take on trust.
      const sig = invStatusByVariant.get(row.variantId);
      const coverHint = sig && sig.daysOfCover != null ? ` title="${esc(sig.daysOfCover.toFixed(1))} days of cover left"` : "";
      const st = sig ? sig.status : (row.neverStocked ? "not_tracked" : row.available <= 0 ? "out" : "ok");
      const badge = st === "not_tracked"
        ? '<span class="badge badge-neutral">Not stocked yet</span>'
        : st === "out" ? '<span class="badge badge-danger">Out</span>'
        : st === "reorder" ? `<span class="badge badge-warning"${coverHint}>Reorder</span>`
        : st === "low" ? `<span class="badge badge-warning"${coverHint}>Low</span>` : "";
      const main = document.createElement("div");
      main.innerHTML = `
        <div class="inv-row-main">
          <div class="inv-row-name">${esc(row.color || "—")} / ${esc(row.size || "—")}</div>
          <div class="inv-row-meta">${esc(row.locationName)} · SKU ${esc(row.sku)}${row.barcode ? ` · ${esc(row.barcode)}` : ""}</div>
        </div>
        <div class="inv-row-qty">
          <div class="inv-row-avail">${row.available} avail.</div>
          <div class="inv-row-meta">${row.onHand} on hand${row.reserved ? `, ${row.reserved} held` : ""}</div>
        </div>
        <div class="inv-row-badge">${badge}</div>
      `;
      while (main.firstChild) r.appendChild(main.firstChild);

      const receiveBtn = document.createElement("button");
      receiveBtn.className = "btn btn-secondary btn-sm";
      receiveBtn.textContent = "Receive";
      receiveBtn.addEventListener("click", async () => {
        if (!row.locationId) {
          toast("There is no stock location set up to receive into. Tell OGGI — every wholesaler should have one.", { type: "danger" });
          return;
        }
        // Batch 8A, 23 Aug 2026. This was four consecutive native prompt()
        // boxes, and the sequence had a real defect on top of being ugly:
        // the stock was written to the database after box 1, so cancelling
        // box 2 -- which read "Cancel to skip landed-cost tracking" -- looked
        // like cancelling the receipt and was not. The units were already in.
        // Cancelling also silently threw away boxes 3 and 4 together, so
        // recording freight without duty meant typing a 0 you did not mean.
        //
        // One form now, validated BEFORE anything is written, so Cancel means
        // cancel. See js/components/receive-dialog.js.
        openReceiveDialog(row, async ({ qty, freight, duty, other, recordCost }) => {
          const { error } = await receiveStock(row.variantId, row.locationId, qty);
          if (error) return { ok: false, error: "That receipt could not be saved. Nothing was changed." };

          if (recordCost && (freight || duty || other)) {
            await recordReceiptCost({
              variantId: row.variantId, locationId: row.locationId, qty,
              baseCost: row.cost,
              freightCost: freight, dutyCost: duty, otherCost: other,
            });
          }
          toast(`Received ${qty} units`, { type: "success" });
          outlet.innerHTML = "";
          stockPane(outlet);
          return { ok: true };
        });
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
          openTransfer(row, locations, () => { outlet.innerHTML = ""; stockPane(outlet); });
        });
        r.appendChild(moveBtn);
      }

      panel.appendChild(r);
    });

    detailHost.appendChild(panel);
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
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

// ---------- Barcode labels (Batch 4, migration 076) ----------
// v1 printed barcodes; the 2.0 rewrite kept only the reader. Production had
// 0 of 191 variants carrying a code, so the camera scanner shipped in Batch 18
// had nothing to scan.
//
// The labels are EAN-13, not v1's Code 128-B, because THIS app's decoder reads
// EAN-13 and explicitly does not read Code 128. Printing Code 128 would have
// produced labels the app that printed them could not scan.

async function labelsView(outlet, params = {}) {
  const session = devAuth.getSession();
  const wid = session.wid;

  // Batch 8B: when this view is a SUB-TAB of Inventory the screen already has
  // its title, so a second one stacked underneath reads as two screens rather
  // than one. Kept as a flag, not deleted, so the standalone route still shows
  // a title if it is ever reached directly.
  if (!params.embedded) {
    const labelsHeader = pageHeader("Barcode labels",
      "Print a scannable label for every colour and size. Codes are read by the app's own camera scanner and by any hardware scanner.");
    // Screen furniture only -- printing the page title would cost a label off
    // the top of the sheet.
    labelsHeader.classList.add("no-print");
    outlet.appendChild(labelsHeader);
  }

  const host = document.createElement("div");
  outlet.appendChild(host);

  async function paint() {
    host.innerHTML = "";
    const { rows, error } = await getLabelRows(wid, { productId: params.productId || null });

    if (error) {
      host.appendChild(emptyState({ icon: "⚠️", title: "Could not load your products",
        body: "Nothing has been changed." }));
      return;
    }
    if (!rows.length) {
      host.appendChild(emptyState({ icon: "🏷", title: "No products to label yet",
        body: "Add a product and every colour and size will appear here, ready to print." }));
      return;
    }

    const missing = rows.filter((r) => !r.barcode);

    // --- the action bar ---
    const bar = document.createElement("div");
    bar.className = "card no-print";
    bar.style.cssText = "padding:14px 16px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;";
    const summary = document.createElement("div");
    summary.style.cssText = "flex:1;min-width:220px;font-size:12px;color:var(--text-secondary);";
    summary.innerHTML = missing.length
      ? `<strong>${missing.length}</strong> of ${rows.length} have no barcode yet. ` +
        `Assigning one gives it a code in the range set aside for a shop's own use, so it can never clash with a manufacturer's.`
      : `All ${rows.length} colour/size combinations have a barcode.`;
    bar.appendChild(summary);

    if (missing.length) {
      const assign = document.createElement("button");
      assign.className = "btn btn-primary";
      assign.style.minHeight = "44px";
      assign.textContent = `Give the other ${missing.length} a barcode`;
      assign.addEventListener("click", async () => {
        assign.disabled = true; assign.textContent = "Assigning…";
        const { assigned, error: e } = await assignInternalBarcodes(wid, { productId: params.productId || null });
        if (e) { toast("Could not assign barcodes", { type: "danger" }); assign.disabled = false; return; }
        toast(`${assigned.length} barcode${assigned.length === 1 ? "" : "s"} assigned`, { type: "success" });
        paint();
      });
      bar.appendChild(assign);
    }

    const printBtn = document.createElement("button");
    printBtn.className = "btn btn-secondary";
    printBtn.style.minHeight = "44px";
    printBtn.textContent = "Print these labels";
    printBtn.disabled = rows.every((r) => !r.barcode);
    printBtn.addEventListener("click", () => window.print());
    bar.appendChild(printBtn);
    host.appendChild(bar);

    // --- the sheet ---
    const sheet = document.createElement("div");
    sheet.className = "label-sheet";
    sheet.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;";

    rows.forEach((r) => {
      const cell = document.createElement("div");
      cell.className = "label-cell";
      cell.style.cssText =
        "border:1px solid var(--border-subtle);border-radius:8px;padding:10px;background:#fff;color:#000;" +
        "display:flex;flex-direction:column;gap:6px;break-inside:avoid;";

      const bits = [r.color, r.size].filter(Boolean).join(" / ");
      const head = document.createElement("div");
      head.style.cssText = "font-size:11px;line-height:1.3;";
      head.innerHTML =
        `<div style="font-weight:700;">${esc(r.productName)}</div>` +
        (bits ? `<div>${esc(bits)}</div>` : "") +
        `<div style="font-family:monospace;color:#444;">${esc(r.sku)}</div>`;
      cell.appendChild(head);

      if (r.barcode && isValidEan13(r.barcode)) {
        const wrap = document.createElement("div");
        // The SVG is inserted as markup rather than an <img src="data:...">
        // because index.html ships a CSP without data: in img-src, and an
        // inline <svg> element needs no source at all.
        wrap.innerHTML = renderEan13Svg(r.barcode, { moduleWidth: 2, height: 46 });
        const svg = wrap.firstElementChild;
        if (svg) { svg.style.maxWidth = "100%"; svg.style.height = "auto"; }
        cell.appendChild(wrap);
        if (!isInternalBarcode(r.barcode)) {
          const note = document.createElement("div");
          note.style.cssText = "font-size:10px;color:#666;";
          note.textContent = "Manufacturer's barcode";
          cell.appendChild(note);
        }
      } else if (r.barcode) {
        // A code that exists but is not a valid EAN-13 is shown as text and
        // named as such. Drawing bars for it would produce a label that looks
        // right and cannot be scanned, which is worse than no label.
        const note = document.createElement("div");
        note.style.cssText = "font-size:11px;color:#a33;";
        note.textContent = `Code "${r.barcode}" is not a valid EAN-13, so it cannot be drawn as bars.`;
        cell.appendChild(note);
      } else {
        const note = document.createElement("div");
        note.className = "no-print";
        note.style.cssText = "font-size:11px;color:#888;";
        note.textContent = "No barcode yet";
        cell.appendChild(note);
      }
      sheet.appendChild(cell);
    });
    host.appendChild(sheet);
  }

  await paint();
}

// ---------- Stock movements (Batch 2, migrations 069/070/071) ----------
// The audit trail that makes "why is this 12 and not 20" answerable.
// v2_inventory_movements has been written correctly since migration 001 and
// shown nowhere. Two things had to be fixed before it could be displayed:
// its read policy was `using (true)` and readable anonymously across all six
// wholesalers (069), and only 9 of 236 rows recorded who did it (070).

const MOVEMENT_PAGE_SIZE = 50;

async function movementsView(outlet, params = {}) {
  const session = devAuth.getSession();
  const wid = session.wid;

  // Filter state lives here rather than in the URL: the filters are a way of
  // reading one screen, not four separate places a wholesaler navigates to.
  const filters = {
    productId: params.productId || null,
    locationId: null,
    types: [],
    since: null,
    offset: 0,
  };

  outlet.appendChild(pageHeader("Stock movements",
    "Every change to your stock, newest first — what moved, when, why, and who did it."));

  const host = document.createElement("div");
  outlet.appendChild(host);

  const locations = await getLocations(wid);

  async function paint() {
    host.innerHTML = "";

    const { rows, total, error } = await getMovementLedger(wid, {
      productId: filters.productId,
      locationId: filters.locationId,
      types: filters.types,
      since: filters.since,
      limit: MOVEMENT_PAGE_SIZE,
      offset: filters.offset,
    });

    // --- filters ---
    const bar = document.createElement("div");
    bar.className = "card";
    bar.style.cssText = "padding:12px 16px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;";

    const typeSel = document.createElement("select");
    typeSel.className = "input";
    typeSel.style.cssText = "min-height:44px;max-width:220px;";
    typeSel.innerHTML = `<option value="">Everything that happened</option>` +
      Object.entries(MOVEMENT_TYPES)
        .map(([k, v]) => `<option value="${esc(k)}"${filters.types[0] === k ? " selected" : ""}>${esc(v.label)}</option>`)
        .join("");
    typeSel.addEventListener("change", () => {
      filters.types = typeSel.value ? [typeSel.value] : [];
      filters.offset = 0; paint();
    });
    bar.appendChild(typeSel);

    if (locations.length > 1) {
      const locSel = document.createElement("select");
      locSel.className = "input";
      locSel.style.cssText = "min-height:44px;max-width:220px;";
      locSel.innerHTML = `<option value="">Every warehouse</option>` +
        locations.map((l) => `<option value="${esc(l.id)}"${filters.locationId === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("");
      locSel.addEventListener("change", () => {
        filters.locationId = locSel.value || null; filters.offset = 0; paint();
      });
      bar.appendChild(locSel);
    }

    const sinceSel = document.createElement("select");
    sinceSel.className = "input";
    sinceSel.style.cssText = "min-height:44px;max-width:200px;";
    [["", "All time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]]
      .forEach(([v, label]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        if ((filters.since ? String(filters.sinceDays) : "") === v) o.selected = true;
        sinceSel.appendChild(o);
      });
    sinceSel.addEventListener("change", () => {
      const d = sinceSel.value ? parseInt(sinceSel.value, 10) : null;
      filters.sinceDays = d;
      filters.since = d ? new Date(Date.now() - d * 86400000).toISOString() : null;
      filters.offset = 0; paint();
    });
    bar.appendChild(sinceSel);

    if (filters.productId && rows.length) {
      const chip = document.createElement("button");
      chip.className = "btn btn-secondary btn-sm";
      chip.style.minHeight = "44px";
      chip.textContent = `Only ${rows[0].productName} ✕`;
      chip.title = "Show every product again";
      chip.addEventListener("click", () => { filters.productId = null; filters.offset = 0; paint(); });
      bar.appendChild(chip);
    }
    host.appendChild(bar);

    if (error) {
      host.appendChild(emptyState({ icon: "⚠️", title: "Could not load the ledger",
        body: "Something went wrong reading your stock history. Nothing has been changed." }));
      return;
    }

    if (!rows.length) {
      // Say which of the two it is. "No results" for a filter and "no history"
      // for an empty ledger look identical and mean different things.
      const filtered = filters.productId || filters.locationId || filters.types.length || filters.since;
      host.appendChild(emptyState({
        icon: "🕓",
        title: filtered ? "Nothing matches those filters" : "No stock movements yet",
        body: filtered
          ? "Try widening the date range or choosing 'Everything that happened'."
          : "Every receipt, sale, transfer and correction will be listed here automatically, from the moment you first receive stock.",
      }));
      return;
    }

    // --- the ledger ---
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:0;overflow:hidden;";

    const shown = filters.offset + rows.length;
    const head = document.createElement("div");
    head.style.cssText = "padding:12px 16px;font-size:12px;color:var(--text-tertiary);border-bottom:1px solid var(--border-subtle);";
    head.textContent = `Showing ${filters.offset + 1}–${shown} of ${total}`;
    card.appendChild(head);

    let lastDay = null;
    rows.forEach((r) => {
      const when = new Date(r.createdAt);
      const day = when.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement("div");
        sep.style.cssText = "padding:8px 16px;background:var(--surface-2);font-size:11px;font-weight:650;color:var(--text-secondary);";
        sep.textContent = when.toLocaleDateString(undefined, { weekday:"short", day:"numeric", month:"short", year:"numeric" });
        card.appendChild(sep);
      }

      const meta = MOVEMENT_TYPES[r.type] || { tone: "neutral", blurb: "" };
      const colour = meta.tone === "in" ? "var(--success,#137a4a)"
                   : meta.tone === "out" ? "var(--danger,#c33)" : "var(--text-tertiary)";
      const sign = r.qtyDelta > 0 ? "+" : "";

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid var(--border-subtle);font-size:12px;";

      const qty = document.createElement("div");
      qty.style.cssText = `min-width:56px;text-align:right;font-weight:750;font-size:15px;color:${colour};`;
      qty.textContent = `${sign}${r.qtyDelta}`;
      row.appendChild(qty);

      const body = document.createElement("div");
      body.style.cssText = "flex:1;min-width:0;";
      const variantBits = [r.color, r.size].filter(Boolean).join(" / ");
      const ref = referenceLabel(r.referenceType);
      // "who" is shown honestly. Rows written before migration 070 have no
      // actor and say so, rather than showing a blank that reads as data loss.
      const who = r.actorLabel
        ? `by ${esc(r.actorLabel)}`
        : `<span title="Who did this was not recorded before 21 Aug 2026. New movements record it automatically.">who: not recorded</span>`;
      body.innerHTML =
        `<div style="font-weight:650;color:${colour};">${esc(movementTypeLabel(r.type))}` +
        `<span style="font-weight:400;color:var(--text-tertiary);"> · ${esc(meta.blurb)}</span></div>` +
        `<div style="margin-top:2px;">${esc(r.productName)}` +
        (variantBits ? ` <span style="color:var(--text-tertiary);">${esc(variantBits)}</span>` : "") +
        ` <span style="color:var(--text-tertiary);">${esc(r.sku || "")}</span></div>` +
        `<div style="margin-top:2px;color:var(--text-tertiary);">` +
        `${when.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}` +
        (r.locationName ? ` · ${esc(r.locationName)}` : "") +
        (ref ? ` · ${esc(ref)}` : "") +
        ` · ${who}</div>` +
        (r.note ? `<div style="margin-top:4px;color:var(--text-secondary);font-style:italic;">${esc(r.note)}</div>` : "");
      row.appendChild(body);
      card.appendChild(row);
    });
    host.appendChild(card);

    // --- paging ---
    if (total > MOVEMENT_PAGE_SIZE) {
      const pager = document.createElement("div");
      pager.style.cssText = "display:flex;gap:8px;justify-content:center;padding:14px 0;";
      const mk = (label, disabled, delta) => {
        const b = document.createElement("button");
        b.className = "btn btn-secondary"; b.textContent = label;
        b.style.minHeight = "44px"; b.disabled = disabled;
        b.addEventListener("click", () => {
          filters.offset = Math.max(0, filters.offset + delta);
          paint();
          host.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        return b;
      };
      pager.appendChild(mk("← Newer", filters.offset === 0, -MOVEMENT_PAGE_SIZE));
      pager.appendChild(mk("Older →", shown >= total, MOVEMENT_PAGE_SIZE));
      host.appendChild(pager);
    }
  }

  await paint();
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

async function intelligenceView(outlet, { embedded = false } = {}) {
  const session = devAuth.getSession();
  const wid = session.wid;
  // Batch 8B: when this view is a SUB-TAB of Inventory the screen already has
  // its title, so a second one stacked underneath reads as two screens rather
  // than one. Kept as a flag, not deleted, so the standalone route still shows
  // a title if it is ever reached directly.
  if (!embedded) {
    outlet.appendChild(pageHeader("Inventory Intelligence", "Reorder suggestions, GMROI/aging/sell-through, ABC cycle counts, and kit assembly."));
  }

  // One signal fetch feeds the summary, the reorder list and the breakout
  // alert, so the three can never disagree with each other on screen.
  const [signals, report, cycleSchedule, kits, stock, locations, settingsResult, valuation] = await Promise.all([
    getInventorySignals(wid), getInventoryIntelligenceReport(wid), getCycleCountSchedule(wid),
    listKits(wid), getStockTable(wid), getLocations(wid), getInventorySettings(wid),
    getInventoryValuation(wid),
  ]);
  const reorderSuggestions = signals
    .filter((sig) => (sig.status === "reorder" || sig.status === "out") && sig.suggestedQty > 0)
    .sort((a, b) => {
      const aCover = a.status === "out" ? -1 : (a.daysOfCover ?? Infinity);
      const bCover = b.status === "out" ? -1 : (b.daysOfCover ?? Infinity);
      return aCover - bCover;
    });
  const breakouts = signals.filter((sig) => sig.isBreakout)
    .sort((a, b) => (b.breakoutRatio ?? 0) - (a.breakoutRatio ?? 0));
  const defaultLocation = locations.find((l) => l.is_default) || locations[0];
  const variantOptions = dedupeVariants(stock);

  // --- Stock health at a glance (Batch 1) ---
  // Five counts, not one. "Never stocked" and "sold out" look identical as a
  // number and mean completely different things -- one is a catalogue entry,
  // the other is money not being taken. Merging them is what put 43 false
  // OUT alarms on one wholesaler's screen and taught them to stop looking.
  const STATUS_META = {
    out:         { label: "Sold out",     tone: "danger",  blurb: "was stocked, now at zero" },
    reorder:     { label: "Reorder now",  tone: "warning", blurb: "at or below the reorder point" },
    low:         { label: "Running low",  tone: "warning", blurb: "under your cover target" },
    ok:          { label: "Healthy",      tone: "success", blurb: "comfortable" },
    no_data:     { label: "No sales yet", tone: "muted",   blurb: "in stock, nothing sold in the window" },
    not_tracked: { label: "Not stocked",  tone: "muted",   blurb: "never received into stock" },
  };
  const counts = {};
  signals.forEach((sig) => { counts[sig.status] = (counts[sig.status] || 0) + 1; });

  const healthSection = document.createElement("div");
  healthSection.className = "card";
  healthSection.style.cssText = "padding:16px;margin-bottom:16px;";
  const cfg = settingsResult.settings;
  healthSection.innerHTML =
    `<h4 style="margin-bottom:4px;">Stock health</h4>
     <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px;">
       Worked out from your own sales history over the last ${cfg.velocityWindowDays} days.
       No setup needed &mdash; ${settingsResult.isDefault ? "these are the starting settings" : "using your saved settings"}, adjustable below.
     </div>`;
  const chipRow = document.createElement("div");
  chipRow.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";
  ["out", "reorder", "low", "ok", "no_data", "not_tracked"].forEach((key) => {
    if (!counts[key]) return;
    const meta = STATUS_META[key];
    const chip = document.createElement("div");
    chip.title = meta.blurb;
    chip.style.cssText =
      "display:flex;align-items:baseline;gap:6px;padding:8px 12px;border-radius:10px;" +
      "background:var(--surface-2);border:1px solid var(--border-subtle);min-height:44px;box-sizing:border-box;";
    chip.innerHTML =
      `<span style="font-weight:700;font-size:16px;">${counts[key]}</span>` +
      `<span style="font-size:12px;color:var(--text-secondary);">${esc(meta.label)}</span>`;
    chipRow.appendChild(chip);
  });
  if (!chipRow.children.length) {
    chipRow.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">No active products yet.</div>`;
  }
  healthSection.appendChild(chipRow);
  outlet.appendChild(healthSection);

  // --- What the stock is worth (Batch 3, restores v1's L4 and L5) ---
  // Every figure here is shown WITH its coverage. One production wholesaler
  // holds 1,400 units of which 0% carry a cost; printing "$0.00" would tell
  // them their inventory is worthless when the truth is that nobody has
  // entered a cost price. Those are opposite instructions.
  if (valuation && valuation.unitsOnHand > 0) {
    const money = (n) => `${session.currency || "$"}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const val = document.createElement("div");
    val.className = "card";
    val.style.cssText = "padding:16px;margin-bottom:16px;";
    val.innerHTML = `<h4 style="margin-bottom:4px;">What your stock is worth</h4>`;

    const fully = isFullyCosted(valuation);
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-bottom:12px;";
    sub.innerHTML = fully
      ? `Across all ${valuation.unitsOnHand.toLocaleString()} units on hand.`
      : `⚠️ Worked out from <strong>${valuation.unitsValued.toLocaleString()} of ${valuation.unitsOnHand.toLocaleString()}</strong> units ` +
        `(${valuation.coveragePct ?? 0}%). The other ${valuation.unitsUnvalued.toLocaleString()} have no cost price recorded, ` +
        `so they are left out rather than counted as free. Add cost prices under Products → Pricing &amp; MOQ and this figure completes itself.`;
    val.appendChild(sub);

    const figs = document.createElement("div");
    figs.style.cssText = "display:flex;flex-wrap:wrap;gap:20px;";
    const fig = (label, value, note, tone) => {
      const d = document.createElement("div");
      d.style.cssText = "min-width:130px;";
      d.innerHTML =
        `<div style="font-size:11px;color:var(--text-tertiary);">${esc(label)}</div>` +
        `<div style="font-size:19px;font-weight:750;${tone ? `color:${tone};` : ""}">${esc(value)}</div>` +
        (note ? `<div style="font-size:11px;color:var(--text-tertiary);">${esc(note)}</div>` : "");
      return d;
    };
    figs.appendChild(fig("Value at cost", valuation.unitsValued ? money(valuation.valueAtCost) : "—",
      valuation.unitsValued ? "what it cost you" : "no cost prices recorded yet"));
    figs.appendChild(fig("Value at your list price", valuation.valueAtPrice ? money(valuation.valueAtPrice) : "—",
      "if every unit sold at list"));
    figs.appendChild(fig("Margin in stock",
      valuation.marginPct == null ? "—" : money(valuation.marginValue),
      // Never "0%". Null means it could not be computed, which is a different
      // statement from "you make nothing".
      valuation.marginPct == null ? "needs both cost and price" : `${valuation.marginPct}% of list`));
    val.appendChild(figs);

    // Dead stock and undated stock are two different categories and are shown
    // as such. 075 stopped treating "no arrival on record" as "old".
    const notes = document.createElement("div");
    notes.style.cssText = "margin-top:14px;padding-top:12px;border-top:1px solid var(--border-subtle);font-size:12px;display:grid;gap:6px;";
    if (valuation.deadUnits > 0) {
      notes.innerHTML += `<div><strong style="color:var(--danger,#c33);">${money(valuation.deadValueAtCost)}</strong> ` +
        `tied up in dead stock — ${valuation.deadUnits.toLocaleString()} units across ${valuation.deadVariants} ` +
        `SKU${valuation.deadVariants === 1 ? "" : "s"} that arrived over ${valuation.deadStockDays} days ago and have not sold since.</div>`;
    } else {
      notes.innerHTML += `<div style="color:var(--text-tertiary);">No dead stock: nothing has been sitting unsold for more than ${valuation.deadStockDays} days.</div>`;
    }
    if (valuation.unknownAgeUnits > 0) {
      notes.innerHTML += `<div style="color:var(--text-tertiary);">` +
        `${valuation.unknownAgeUnits.toLocaleString()} units across ${valuation.unknownAgeVariants} ` +
        `SKU${valuation.unknownAgeVariants === 1 ? "" : "s"} have no recorded arrival, so their age is unknown. ` +
        `They are <em>not</em> counted as dead — they are simply undated. Receiving stock through the app dates it from then on.</div>`;
    }
    val.appendChild(notes);
    outlet.appendChild(val);
  }

  // --- Reorder suggestions ---
  const reorderSection = document.createElement("div");
  reorderSection.className = "card";
  reorderSection.style.cssText = "padding:16px;margin-bottom:16px;";
  reorderSection.innerHTML = `<h4 style="margin-bottom:8px;">Needs reordering</h4>`;
  if (!reorderSuggestions.length) {
    // An honest empty state. It says which of the two reasons applies, rather
    // than the old text which implied the wholesaler had homework to do
    // ("no SKUs have a reorder point configured yet") -- that sentence was
    // the bug describing itself.
    const sellable = signals.filter((sig) => sig.status !== "not_tracked").length;
    const withSales = signals.filter((sig) => sig.velocityPerDay > 0).length;
    let message;
    if (!sellable) {
      message = "Nothing has been received into stock yet, so there is nothing to reorder.";
    } else if (!withSales) {
      message = `Nothing has sold in the last ${cfg.velocityWindowDays} days, so there is no demand to work a reorder point from. This fills in on its own as orders come in &mdash; no setup needed.`;
    } else {
      message = "Nothing needs reordering right now. Every SKU with sales history has more cover than your target.";
    }
    reorderSection.innerHTML += `<div style="font-size:12px;color:var(--text-tertiary);">${message}</div>`;
  } else {
    reorderSuggestions.forEach((v) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;flex-wrap:wrap;";
      // Provenance is shown deliberately. A reorder point the wholesaler
      // cannot trace is a reorder point they will not act on.
      const sourceNote = v.reorderPointSource === "manual"
        ? `reorder point ${v.reorderPoint} (yours)`
        : `reorder point ${v.reorderPoint} (worked out from ${v.velocityPerDay.toFixed(2)}/day over ${cfg.velocityWindowDays}d)`;
      const coverNote = v.status === "out"
        ? `<span class="badge badge-danger">Sold out</span>`
        : `${v.daysOfCover != null ? `${v.daysOfCover.toFixed(1)} days of cover` : ""}`;
      row.innerHTML = `
        <div style="flex:1;min-width:180px;">
          <div style="font-weight:600;">${esc(v.sku)} <span style="color:var(--text-tertiary);font-weight:400;">${esc(v.productName)} (${esc(v.color || "—")}/${esc(v.size || "—")})</span></div>
          <div style="color:var(--text-tertiary);">${v.available} available · ${coverNote} · ${sourceNote}${v.leadTimeDays != null ? ` · ${v.leadTimeDays}d lead time` : ""}</div>
        </div>
        <div style="font-weight:700;">Suggest: ${v.suggestedQty}</div>
      `;
      const receiveBtn = document.createElement("button");
      receiveBtn.className = "btn btn-primary btn-sm";
      receiveBtn.textContent = "Receive suggested qty";
      receiveBtn.style.minHeight = "44px";
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

  // --- Breakout colourways (restored from v1) ---
  // "The blue tee flying off the shelf": one colour outselling its siblings.
  // Needs no configuration at all -- it reads order history directly.
  const breakoutSection = document.createElement("div");
  breakoutSection.className = "card";
  breakoutSection.style.cssText = "padding:16px;margin-bottom:16px;";
  breakoutSection.innerHTML = `<h4 style="margin-bottom:8px;">Selling faster than its other colours</h4>`;
  if (breakouts.length) {
    breakouts.forEach((v) => {
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;";
      const urgency = (v.status === "reorder" || v.status === "out" || v.status === "low")
        ? ` <span class="badge badge-warning">${esc(STATUS_META[v.status].label)}</span>` : "";
      row.innerHTML = `
        <div style="font-weight:600;">${esc(v.color || v.sku)} — ${esc(v.productName)}${v.size ? ` (${esc(v.size)})` : ""}${urgency}</div>
        <div style="color:var(--text-tertiary);">
          Selling ${v.breakoutRatio != null ? `${v.breakoutRatio.toFixed(1)}×` : "well above"} the middle of its ${v.siblingCount} other colour${v.siblingCount === 1 ? "" : "s"}
          · ${v.velocityPerDay.toFixed(2)}/day · ${v.unitsSold} sold${v.daysOfCover != null ? ` · ${v.daysOfCover.toFixed(1)} days of cover left` : ""}
        </div>`;
      breakoutSection.appendChild(row);
    });
  } else {
    // Explain the silence. "Nothing stood out" and "nothing was comparable"
    // look identical on screen and mean different things -- and only one of
    // them is something the wholesaler can do anything about.
    const comparable = signals.filter((sig) => sig.siblingCount >= cfg.breakoutMinSiblings).length;
    const message = comparable
      ? `No colour is currently outselling the others by ${cfg.breakoutMultiple}× or more.`
      : `Nothing to compare yet. This alert looks across the colours of the same product in the same size, and needs at least ${cfg.breakoutMinSiblings} other colours to compare against. If you list each colour as its own product, add them as colour options on one product instead and this starts working.`;
    breakoutSection.innerHTML += `<div style="font-size:12px;color:var(--text-tertiary);">${message}</div>`;
  }
  outlet.appendChild(breakoutSection);

  // --- Tuning (Batch 1, L3) ---
  // These are the knobs behind every number above. Collapsed by default: the
  // screen has to be useful before it is configurable, or the wholesaler
  // concludes it needs setting up and closes it. Nothing here is required --
  // with no row saved at all, the defaults shown are exactly what the server
  // uses.
  const tuningSection = document.createElement("details");
  tuningSection.className = "card";
  tuningSection.style.cssText = "padding:16px;margin-bottom:16px;";
  const summary = document.createElement("summary");
  summary.style.cssText = "cursor:pointer;font-weight:650;font-size:14px;min-height:44px;display:flex;align-items:center;";
  summary.textContent = settingsResult.isDefault
    ? "Tune these numbers (currently using the starting settings)"
    : "Tune these numbers (using your saved settings)";
  tuningSection.appendChild(summary);

  const tuningBody = document.createElement("div");
  tuningBody.style.cssText = "margin-top:12px;display:grid;gap:14px;";
  const intro = document.createElement("div");
  intro.style.cssText = "font-size:11px;color:var(--text-tertiary);";
  intro.textContent = "Every SKU already has a working reorder point without any of this. Changing a number here changes how the figures above are worked out, for every product at once.";
  tuningBody.appendChild(intro);

  const SETTING_LABELS = {
    velocityWindowDays: "Sales history window (days)",
    leadTimeDays: "Typical restock lead time (days)",
    coverTargetDays: "Stock cover target (days)",
    safetyDays: "Safety buffer (days)",
    lowStockThreshold: "Flat low-stock threshold (units)",
    breakoutMultiple: "Breakout multiple",
    breakoutMinSiblings: "Breakout: minimum colours to compare",
    breakoutMinUnits: "Breakout: minimum units sold",
  };
  const inputs = {};
  Object.keys(SETTING_LABELS).forEach((key) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const label = document.createElement("label");
    label.textContent = SETTING_LABELS[key];
    label.style.cssText = "font-size:13px;font-weight:600;";
    const help = document.createElement("div");
    help.textContent = INVENTORY_SETTING_HELP[key];
    help.style.cssText = "font-size:11px;color:var(--text-tertiary);";
    const input = document.createElement("input");
    input.className = "input";
    input.type = "number";
    input.step = key === "breakoutMultiple" ? "0.1" : "1";
    input.min = String(INVENTORY_SETTING_BOUNDS[key][0]);
    input.max = String(INVENTORY_SETTING_BOUNDS[key][1]);
    input.value = String(cfg[key]);
    input.style.minHeight = "44px";
    const err = document.createElement("div");
    err.style.cssText = "font-size:11px;color:var(--danger,#c33);display:none;";
    input.addEventListener("input", () => {
      const [lo, hi] = INVENTORY_SETTING_BOUNDS[key];
      const n = Number(input.value);
      const bad = input.value === "" || Number.isNaN(n) || n < lo || n > hi;
      err.textContent = bad ? `Must be a number between ${lo} and ${hi}` : "";
      err.style.display = bad ? "block" : "none";
    });
    inputs[key] = input;
    wrap.append(label, help, input, err);
    tuningBody.appendChild(wrap);
  });

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Save and recalculate";
  saveBtn.style.minHeight = "44px";
  saveBtn.addEventListener("click", async () => {
    const partial = {};
    for (const [key, input] of Object.entries(inputs)) {
      const [lo, hi] = INVENTORY_SETTING_BOUNDS[key];
      const n = Number(input.value);
      if (input.value === "" || Number.isNaN(n) || n < lo || n > hi) {
        toast(`${SETTING_LABELS[key]} must be between ${lo} and ${hi}`, { type: "danger" });
        input.focus();
        return;
      }
      partial[key] = n;
    }
    saveBtn.disabled = true;
    const { error } = await saveInventorySettings(wid, partial);
    if (error) {
      toast("Could not save those settings", { type: "danger" });
      saveBtn.disabled = false;
      return;
    }
    // Re-render rather than patching numbers in place, so what is on screen
    // is always what the server just computed -- never a local guess at what
    // the change did.
    toast("Settings saved — figures recalculated", { type: "success" });
    outlet.innerHTML = "";
    intelligenceView(outlet);
  });
  btnRow.appendChild(saveBtn);

  if (!settingsResult.isDefault) {
    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-secondary";
    resetBtn.textContent = "Back to the starting settings";
    resetBtn.style.minHeight = "44px";
    resetBtn.addEventListener("click", async () => {
      resetBtn.disabled = true;
      const { error } = await resetInventorySettings(wid);
      toast(error ? "Could not reset" : "Back to the starting settings", { type: error ? "danger" : "success" });
      if (error) { resetBtn.disabled = false; return; }
      outlet.innerHTML = "";
      intelligenceView(outlet);
    });
    btnRow.appendChild(resetBtn);
  }
  tuningBody.appendChild(btnRow);
  tuningSection.appendChild(tuningBody);
  outlet.appendChild(tuningSection);

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
        // Batch 8A. The validation used to happen AFTER the box closed, so a
        // typo meant retyping the whole count from memory; now the dialog
        // refuses it and keeps what was typed.
        const countedRaw = await ask({
          title: `Physical count for ${c.sku}`,
          body: `The system expects ${c.onHand}. Enter what you actually counted — if they differ, the difference is logged as a correction with your name on it.`,
          label: "Counted quantity",
          type: "number",
          value: String(c.onHand),
          confirmLabel: "Log count",
          validate: (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 0) return "Enter the number you counted — a whole number, 0 or more.";
            return null;
          },
        });
        if (countedRaw === null) return;
        const countedQty = parseInt(countedRaw, 10);
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

  // REPLACED 20 Aug 2026 (migration 060). The old form here asked for four
  // things -- shop name, phone, note, discount -- and created a CRM row with
  // NO LOGIN. A client who cannot sign in is not a client; that is the same
  // shape of gap that left SQUARE authenticating into nowhere on 17 Aug.
  //
  // The new form asks Hadi's six required fields and creates the record and
  // the login in ONE transaction, then shows the password exactly once.
  // Everything optional is folded away behind "Add more details" so the
  // common case stays six fields wide.
  outlet.appendChild(renderClientForm({
    onCreated: () => { outlet.innerHTML = ""; clientsView(outlet); },
  }));

  const loading = document.createElement("div");
  loading.className = "card";
  loading.style.padding = "16px";
  loading.textContent = "Loading…";
  outlet.appendChild(loading);

  const [clients, liveBans] = await Promise.all([
    getClientsByRecency(wid),
    getLiveBansByClient(wid),
  ]);
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
    const ban = liveBans.get(c.id) || null;
    const isBanned = c.status === "banned" || !!ban;

    const row = document.createElement("div");
    // A banned row is muted and carries a red left edge, so it reads as
    // "cut off" at a glance without being hidden. Hadi's requirement was
    // that the ban be VISUAL -- this is that, and the row stays in place
    // so it can be lifted from the same screen it was applied on.
    row.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);" +
      (isBanned ? "background:var(--danger-bg,rgba(180,35,24,.06));border-left:3px solid var(--danger,#b42318);" : "");

    const bannedBadge = isBanned
      ? `<span style="display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:var(--danger,#b42318);color:#fff;font-size:11px;font-weight:700;letter-spacing:.02em;vertical-align:middle;">BANNED</span>`
      : "";
    const banLine = isBanned && ban
      ? `<div style="font-size:12px;color:var(--danger,#b42318);margin-top:2px;">Banned ${new Date(ban.banned_at).toLocaleDateString()} — ${esc(banReasonLabel(ban.reason_code))}${ban.reason_text ? ": " + esc(ban.reason_text) : ""}</div>`
      : "";

    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:650;${isBanned ? "opacity:.75;" : ""}">${esc(c.shop_name)}${bannedBadge}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${esc(c.phone || "—")}${c.discount_pct ? ` · ${c.discount_pct}% discount` : ""}${c.note ? " · " + esc(c.note) : ""}</div>
        ${banLine}
      </div>
      <div style="text-align:right;width:130px;">
        <div style="font-size:12px;font-weight:600;">${c.orderCount} order${c.orderCount === 1 ? "" : "s"}</div>
        <div style="font-size:11px;color:var(--text-tertiary);">${c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString() : "never ordered"}</div>
      </div>
      <div style="text-align:right;width:90px;font-size:12px;font-weight:600;">$${c.lifetimeValue.toFixed(0)}</div>
      <button class="btn ${isBanned ? "btn-secondary" : "btn-ghost"} btn-sm" data-action="ban">${isBanned ? "Unban" : "Ban"}</button>
      ${isBanned ? "" : `<button class="btn btn-ghost btn-sm" data-action="deactivate">Deactivate</button>`}
    `;

    row.querySelector('[data-action="ban"]').addEventListener("click", async () => {
      if (isBanned) {
        const yes = await confirmAction({
          title: `Lift the ban on ${c.shop_name}?`,
          body: "They will be able to sign in and order again. The record of this ban is kept.",
          confirmLabel: "Lift the ban",
        });
        if (!yes) return;
        unbanClient(c.id, null).then((r) => {
          if (!r.ok) return toast(r.msg || "Could not lift the ban.", { type: "error" });
          toast(`${c.shop_name} can trade again`, { type: "success" });
          clientsView(outlet);
        });
      } else {
        openBanDialog(c, () => clientsView(outlet));
      }
    });

    const deact = row.querySelector('[data-action="deactivate"]');
    if (deact) deact.addEventListener("click", async () => {
      const yes = await confirmAction({
        title: `Deactivate ${c.shop_name}?`,
        body: "This hides them from your active client list. Their order history is kept.\n\nIt is NOT a ban — they can still sign in and order. Use Ban if you want to stop them.",
        confirmLabel: "Deactivate",
      });
      if (!yes) return;
      await deactivateClient(c.id);
      toast(`${c.shop_name} deactivated`, { type: "default" });
      row.remove();
    });
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

// ---------- Ban dialog ----------
//
// A reason is MANDATORY. That is not bureaucracy: a ban with no reason
// cannot be explained to the person, cannot be explained to your own
// staff next month, and cannot be reviewed when they ask to come back.
// "Rejected/banned with no reason given" was the single most frequent
// complaint across every B2B platform researched for this feature, and
// the database refuses reason_code='other' with no text regardless of
// what this dialog does.
function openBanDialog(client, onDone) {
  const back = document.createElement("div");
  back.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;";

  const box = document.createElement("div");
  box.className = "card";
  box.style.cssText = "max-width:460px;width:100%;padding:20px;";
  box.innerHTML = `
    <div style="font-size:18px;font-weight:700;margin-bottom:4px;">Ban ${esc(client.shop_name)}?</div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">
      They will be signed out and will not be able to see your catalogues or place orders.
      Their order history is kept, and you can lift this at any time.
    </div>
    <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;">Why? <span style="color:var(--danger,#b42318);">*</span></label>
    <select id="ban-reason" class="input" style="width:100%;margin-bottom:4px;">
      ${BAN_REASONS.map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`).join("")}
    </select>
    <div id="ban-hint" style="font-size:11px;color:var(--text-tertiary);margin-bottom:12px;"></div>
    <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;">Note <span id="ban-note-req" style="color:var(--danger,#b42318);display:none;">*</span></label>
    <textarea id="ban-note" class="input" rows="3" style="width:100%;margin-bottom:6px;" placeholder="Only you and OGGI see this. The client is never shown it."></textarea>
    <div id="ban-err" style="font-size:12px;color:var(--danger,#b42318);min-height:16px;margin-bottom:10px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn btn-ghost" data-a="cancel">Cancel</button>
      <button class="btn btn-danger" data-a="confirm" style="background:var(--danger,#b42318);color:#fff;">Ban this client</button>
    </div>
  `;
  back.appendChild(box);
  // Batch 8A: through the modal stack, so a route change cannot leave this
  // sitting over an unrelated screen asking whether to ban somebody.
  openModal(back, { label: `Ban ${client.shop_name}?` });

  const sel  = box.querySelector("#ban-reason");
  const hint = box.querySelector("#ban-hint");
  const note = box.querySelector("#ban-note");
  const req  = box.querySelector("#ban-note-req");
  const err  = box.querySelector("#ban-err");

  const syncHint = () => {
    const r = BAN_REASONS.find((x) => x.code === sel.value);
    hint.textContent = r ? r.hint : "";
    req.style.display = sel.value === "other" ? "inline" : "none";
  };
  sel.addEventListener("change", syncHint);
  syncHint();

  const close = () => closeModal(back);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  box.querySelector('[data-a="cancel"]').addEventListener("click", close);

  box.querySelector('[data-a="confirm"]').addEventListener("click", async () => {
    err.textContent = "";
    if (sel.value === "other" && !note.value.trim()) {
      err.textContent = "Pick a reason, or write one here. A ban with no reason cannot be explained later.";
      return;
    }
    const btn = box.querySelector('[data-a="confirm"]');
    btn.disabled = true; btn.textContent = "Banning…";
    const r = await banClient(client.id, sel.value, note.value.trim());
    if (!r.ok) {
      err.textContent = r.msg || "Could not ban this client.";
      btn.disabled = false; btn.textContent = "Ban this client";
      return;
    }
    close();
    toast(`${client.shop_name} is banned`, { type: "default" });
    onDone && onDone();
  });
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

/**
 * CATALOGS.
 *
 * Batch 8A, 23 Aug 2026 — which catalog you are looking at now lives in the
 * URL instead of in a variable.
 *
 * THE BUG THIS FIXES, precisely. Hadi: "I created a catalog and got sent back
 * to the dashboard." It never went to the dashboard. `activeId` was a local
 * variable seeded from the DEFAULT catalog, and creating one re-ran this whole
 * function -- so the new catalog was created, the screen redrew, and the
 * redraw re-seeded activeId back to Main Catalog. From the outside, being
 * silently returned to the first tab and being thrown out of the screen look
 * identical.
 *
 * The same variable was also wiped by a reload, by the back button, and by any
 * re-render from anywhere else. Patching the create path would have fixed one
 * of four symptoms and left the class alive. A route fixes all four by
 * construction, and gives away a share link to a single catalog for free.
 *
 * @param {object} [params]
 * @param {string} [params.id]   Catalog id from the route. Absent on the bare
 *                               /wholesaler/catalogs path, which still works
 *                               because it is what everyone has bookmarked.
 * @param {string} [params.pid]  Product id, when the packs drawer is itself
 *                               the route.
 */
async function catalogsView(outlet, params = {}) {
  const session = devAuth.getSession();
  const wid = session.wid;
  let catPanelHost = null;
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

  // From the URL when the URL names one, otherwise the default. An id in the
  // URL that no longer exists (a deleted catalog, a stale bookmark) falls back
  // rather than showing an error: the person wanted their catalogs, and they
  // are looking at the list of them.
  const fromRoute = params.id && catalogs.some((c) => c.id === params.id) ? params.id : null;
  if (params.id && !fromRoute) {
    toast("That catalog no longer exists — showing your main one instead.", { type: "warning" });
  }
  let activeId = fromRoute || catalogs.find((c) => c.isDefault)?.id || catalogs[0].id;

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
      // Navigating rather than swapping in place. Same rule as the Inventory
      // sub-tabs (js/components/sub-tabs.js): the tab is in the URL, so a
      // reload lands where the reader was instead of silently resetting to
      // the default and letting them think they lost their place.
      b.addEventListener("click", () => {
        if (c.id === activeId) return;
        router.go(`/wholesaler/catalogs/${encodeURIComponent(c.id)}`);
      });
      tabs.appendChild(b);
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-ghost btn-sm";
    add.textContent = "+ New catalog";
    add.addEventListener("click", async () => {
      const name = await ask({
        title: "New catalog",
        body: "A catalog is a link you send to a buyer. You choose who can open it and what discount it carries.",
        label: "What is this catalog called?",
        placeholder: "Summer 26, Outlet, Wholesale only…",
        confirmLabel: "Create catalog",
        validate: (v) => (v.trim().length >= 2 ? null : "Give it a name — it is what you will pick it out by, and buyers see it on the link."),
      });
      if (!name) return;
      const res = await createCatalog(wid, { name });
      if (!res.ok) { toast(res.error, { type: "danger" }); return; }
      // A new catalog opens at tier 1 with no discount, which is deliberately
      // the harmless setting -- visible to everyone, prices exactly as set.
      // Saying where to change that is the difference between a catalog that
      // gets configured and one that quietly stays at the default forever.
      toast(`"${res.name}" created — set its tier and discount at the top of the page.`, { type: "success" });
      // THE FIX, in one line. This used to re-run catalogsView(), which
      // re-seeded activeId from the default catalog and dropped the person
      // straight back onto Main Catalog with their brand-new catalog nowhere
      // in sight. Navigating to the new catalog's own route lands them in the
      // thing they just made -- and a reload keeps them there.
      if (res.id) router.go(`/wholesaler/catalogs/${encodeURIComponent(res.id)}`);
      else { outlet.innerHTML = ""; catalogsView(outlet); }
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

    // ---- who can see this catalog, and what it does to the price ----
    // Above the products on purpose. These three decide what every product
    // below is worth and who is allowed to look at it, so reading them after
    // scrolling past forty garments is the wrong way round.
    panel.appendChild(catalogSettingsCard(catalog, products));

    const bar = document.createElement("div");
    bar.className = "pf-actions";
    bar.style.marginTop = "0";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "btn btn-primary";
    newBtn.textContent = "+ Create new product";
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn btn-secondary";
    pickBtn.textContent = "Pick from inventory";
    bar.appendChild(newBtn);
    bar.appendChild(pickBtn);
    panel.appendChild(bar);

    pickBtn.addEventListener("click", async () => {
      pickBtn.disabled = true;
      pickBtn.textContent = "Loading your products…";
      const all = await listProductsForAdmin(wid);
      const inHere = new Set((await getCatalogProducts(activeId)).rows.map((p) => p.id));
      pickBtn.disabled = false;
      pickBtn.textContent = "Pick from inventory";

      const pickerLocations = await getLocations(wid);
      const picker = renderProductPicker({
        products: all.filter((p) => !p.archived),
        alreadyIn: inHere,
        catalogName: catalog.name,
        cardFacts: normaliseFacts((await getWholesalerSettings(wid)).card_facts, pickerLocations),
        locations: pickerLocations,
        onClose: () => picker.close(),
        onAdd: async (ids) => {
          const res = await addProductsToCatalog(activeId, ids);
          if (!res.ok) { toast(res.error, { type: "danger" }); return; }
          picker.close();
          toast(
            res.added
              ? `Added ${res.added} product${res.added === 1 ? "" : "s"} to ${catalog.name}.`
              : "Those were already in this catalog.",
            { type: res.added ? "success" : "warning" }
          );
          await paintList();
        },
      });
      // Batch 8A. The picker is a full-screen dialog; before this it was the
      // only way to add products to a catalog and it survived navigation.
      openModal(picker.el, { label: `Add products to ${catalog.name}` });
      picker.focus();
    });

    const formHost = document.createElement("div");
    panel.appendChild(formHost);

    // The list gets its own container so a refresh after a save repaints ONLY
    // the list. Repainting the whole panel wiped the open form -- including
    // the line confirming what had just been created, which the operator then
    // never saw. Adding one product almost always means adding the next.
    listHost = document.createElement("div");
    panel.appendChild(listHost);

    newBtn.addEventListener("click", () => {
      if (formHost.firstChild) { formHost.innerHTML = ""; newBtn.textContent = "+ Create new product"; return; }
      newBtn.textContent = "Close the form";
      const form = renderProductForm({
        catalogName: catalog.name,
        locations: allLocations,
        hasLocation: !!location,
        locationName: location?.name || "",
        suppliers,
        onCreateSupplier: (draft) => createSupplier(wid, draft),
        onCancel: () => { formHost.innerHTML = ""; newBtn.textContent = "+ Create new product"; },
        // Batch 8D. This form stays open after a successful create, so the
        // drawer opens over it and closing the drawer returns you to the form
        // you were in -- no navigation, nothing lost.
        onOpenSellingSetup: (pid, model) => openSellingSetup(pid, model),
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

  /**
   * Tier, discount and mode for the catalog on screen.
   *
   * The discount is stated in plain words underneath as it is typed --
   * "customers pay 5% less than the price on each product" -- because a number
   * in a box called "Discount %" is ambiguous in exactly the way that costs
   * money: -10 could reasonably be read as "ten percent off" by someone in a
   * hurry. Saying what it will DO removes the guess.
   */
  function catalogSettingsCard(catalog, products = []) {
    const card = document.createElement("div");
    card.className = "card cat-settings";

    card.innerHTML = `
      <div class="cat-settings-head">
        <h4>${esc(catalog.name)}${catalog.isDefault ? ' <span class="badge badge-neutral">Default</span>' : ""}</h4>
        <p>Who can see this catalog, and what it does to every price in it.</p>
      </div>
      <div class="cat-settings-grid">
        <div>
          <label for="cat-tier">Customer tier</label>
          <select class="input" id="cat-tier">
            ${[1, 2, 3, 4, 5].map((t) => `<option value="${t}"${t === catalog.accessTier ? " selected" : ""}>Tier ${t}</option>`).join("")}
          </select>
          <p class="cat-hint" id="cat-tier-hint"></p>
        </div>
        <div>
          <label for="cat-discount">Discount %</label>
          <input class="input" id="cat-discount" type="number" step="0.5" min="-100" max="100" value="${catalog.discountPct}">
          <p class="cat-hint" id="cat-discount-hint"></p>
        </div>
        <div class="cat-settings-mode">
          <label for="cat-mode">When the customer has their own discount</label>
          <select class="input" id="cat-mode">
            ${DISCOUNT_MODES.map((m) => `<option value="${m.value}"${m.value === catalog.discountMode ? " selected" : ""}>${esc(m.label)}</option>`).join("")}
          </select>
          <p class="cat-hint" id="cat-mode-hint"></p>
        </div>
      </div>
      <p class="cat-hint cat-silent">Buyers never see this discount as a discount — the adjusted number is simply the price on the product. Only a customer's own rate is shown to them, struck through.</p>
    `;

    const tierSel = card.querySelector("#cat-tier");
    const pctInput = card.querySelector("#cat-discount");
    const modeSel = card.querySelector("#cat-mode");

    function describe() {
      const t = Number(tierSel.value);
      card.querySelector("#cat-tier-hint").textContent = catalog.isPublic
        ? "Ignored while this catalog is open to anyone with the link."
        : t === 1 ? "Any of your customers with the link can open this catalog."
                  : `Only your customers set to tier ${t} or above.`;

      const pct = Number(pctInput.value);
      const d = card.querySelector("#cat-discount-hint");
      if (!Number.isFinite(pct) || pct === 0) d.textContent = "Prices are exactly as set on each product.";
      else if (pct > 0) d.textContent = `Customers pay ${pct}% LESS than the price on each product.`;
      else d.textContent = `Customers pay ${Math.abs(pct)}% MORE than the price on each product.`;

      card.querySelector("#cat-mode-hint").textContent =
        DISCOUNT_MODES.find((m) => m.value === modeSel.value)?.help || "";
    }
    [tierSel, pctInput, modeSel].forEach((el) => el.addEventListener("input", describe));
    describe();

    // ---- the link ----
    // This is how a catalog reaches anyone. Hadi: "he then gets the ability to
    // copy the link of that catalog and send it to his customers... There is no
    // website for the actual buyer. That's never going to happen."
    const linkBox = document.createElement("div");
    linkBox.className = "cat-link";
    linkBox.innerHTML = `
      <h5>The link you send</h5>
      <p class="cat-hint">Copy this and send it to your customers. It stops working the moment you switch this catalog off.</p>
    `;
    const row = document.createElement("div");
    row.className = "cat-link-row";
    const linkInput = document.createElement("input");
    linkInput.className = "input cat-link-input";
    linkInput.readOnly = true;
    linkInput.value = catalogLink(catalog.shareToken);
    linkInput.setAttribute("aria-label", `Link for ${catalog.name}`);
    linkInput.addEventListener("focus", () => linkInput.select());
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn-secondary btn-sm cat-link-copy";
    copy.textContent = "Copy link";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(linkInput.value);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
      } catch {
        // Clipboard access is refused in plenty of ordinary situations -- an
        // insecure origin, a browser that wants a fresher gesture. Selecting
        // the text means the person can still copy it themselves, which is a
        // far better answer than a button that silently does nothing.
        linkInput.focus();
        linkInput.select();
        copy.textContent = "Press Ctrl+C";
        setTimeout(() => { copy.textContent = "Copy link"; }, 2600);
      }
    });
    row.appendChild(linkInput);
    row.appendChild(copy);
    linkBox.appendChild(row);

    const pubLabel = document.createElement("label");
    pubLabel.className = "cat-public";
    const pub = document.createElement("input");
    pub.type = "checkbox";
    pub.id = "cat-public";
    pub.checked = !!catalog.isPublic;
    const pubText = document.createElement("span");
    const describePublic = () => {
      pubText.innerHTML = pub.checked
        ? "<strong>Open to anyone with the link.</strong> No login. They give a name and phone number when they order."
        : "<strong>Login required.</strong> Only your own customers, at tier " +
          `${catalog.accessTier} or above. A stranger with the link sees nothing.`;
    };
    pub.addEventListener("change", async () => {
      pub.disabled = true;
      const res = await setCatalogPublic(activeId, pub.checked);
      pub.disabled = false;
      if (!res.ok) { pub.checked = !pub.checked; toast(res.error, { type: "danger" }); return; }
      catalog.isPublic = pub.checked;
      describePublic();
      toast(pub.checked ? "Anyone with the link can now open this catalog." : "This catalog now needs a login.",
            { type: "success" });
    });
    describePublic();
    pubLabel.appendChild(pub);
    pubLabel.appendChild(pubText);
    linkBox.appendChild(pubLabel);

    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "btn btn-ghost btn-sm cat-link-rotate";
    rotate.textContent = "Get a new link";
    rotate.title = "Use this if the link reached someone it should not have. Every link you have already sent stops working.";
    rotate.addEventListener("click", async () => {
      // Irreversible for everyone already holding the old link, so it asks.
      const yes = await confirmAction({
        title: `Get a new link for "${catalog.name}"?`,
        body: "Every link you have already sent stops working immediately, and you will need to send the new one to everybody who should still have access.",
        confirmLabel: "Replace the link",
        danger: true,
      });
      if (!yes) return;
      rotate.disabled = true;
      const res = await rotateCatalogLink(activeId);
      rotate.disabled = false;
      if (!res.ok) { toast(res.error, { type: "danger" }); return; }
      catalog.shareToken = res.shareToken;
      linkInput.value = catalogLink(res.shareToken);
      toast("New link ready. The old one no longer works.", { type: "success" });
    });
    linkBox.appendChild(rotate);
    card.appendChild(linkBox);

    // ---- the billboard ----
    const bbBox = document.createElement("div");
    bbBox.className = "cat-billboard";
    bbBox.innerHTML = `
      <h5>Billboard</h5>
      <p class="cat-hint">A poster, GIF or short clip at the top of this catalog. Point it at one product with a button, or leave it as a plain poster.</p>
    `;

    const bbOnLabel = document.createElement("label");
    bbOnLabel.className = "cat-public";
    const bbOn = document.createElement("input");
    bbOn.type = "checkbox";
    bbOn.id = "cat-bb-on";
    bbOn.checked = !!catalog.billboardEnabled;
    const bbOnText = document.createElement("span");
    bbOnText.textContent = "Show the billboard on this catalog";
    bbOnLabel.appendChild(bbOn);
    bbOnLabel.appendChild(bbOnText);
    bbBox.appendChild(bbOnLabel);

    const bbBody = document.createElement("div");
    bbBody.className = "cat-billboard-body";
    bbBox.appendChild(bbBody);

    function paintBillboard() {
      bbBody.innerHTML = "";
      bbBody.hidden = !bbOn.checked;
      if (!bbOn.checked) return;

      if (catalog.billboardUrl) {
        const preview = renderBillboard({
          url: catalog.billboardUrl,
          mediaType: catalog.billboardMediaType,
          cta: catalog.billboardCta,
          label: catalog.name,
          onGo: catalog.billboardProductId ? () => {} : null,
        });
        preview.classList.add("cat-billboard-preview");
        bbBody.appendChild(preview);
      } else {
        const none = document.createElement("p");
        none.className = "pdet-none";
        none.textContent = "No artwork yet — upload a poster, GIF or clip below.";
        bbBody.appendChild(none);
      }

      const pick = document.createElement("label");
      pick.className = "btn btn-secondary btn-sm cat-bb-upload";
      pick.innerHTML = `<span>${catalog.billboardUrl ? "Replace artwork" : "Upload artwork"}</span>`;
      const file = document.createElement("input");
      file.type = "file";
      file.accept = "image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm";
      file.hidden = true;
      const status = document.createElement("span");
      status.className = "cat-hint";
      file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        status.textContent = "Uploading…";
        const up = await uploadCatalogBillboard({
          file: f, wid, catalogId: activeId,
          onProgress: (m) => { status.textContent = m; },
        });
        file.value = "";
        if (!up.ok) { status.textContent = up.error; toast(up.error, { type: "danger" }); return; }
        const saved = await setBillboard(activeId, { url: up.url, mediaType: up.mediaType, enabled: true });
        if (!saved.ok) { status.textContent = saved.error; return; }
        catalog.billboardUrl = up.url;
        catalog.billboardMediaType = up.mediaType;
        catalog.billboardEnabled = true;
        bbOn.checked = true;
        status.textContent = up.mediaType === "video" ? "Clip uploaded." : "Artwork uploaded.";
        toast("Billboard updated.", { type: "success" });
        paintBillboard();
      });
      pick.appendChild(file);

      const row = document.createElement("div");
      row.className = "cat-link-row";
      row.appendChild(pick);
      row.appendChild(status);
      bbBody.appendChild(row);

      // Which product the button goes to. Only products already in this
      // catalog are offered -- pointing a billboard at something the buyer
      // cannot reach from here is a button to nowhere.
      const target = document.createElement("div");
      target.className = "cat-bb-target";
      const sel = document.createElement("select");
      sel.className = "input";
      sel.id = "cat-bb-product";
      sel.innerHTML = `<option value="">Just a poster — no button</option>` +
        products.map((p) => `<option value="${esc(p.id)}"${p.id === catalog.billboardProductId ? " selected" : ""}>${esc(p.name)}</option>`).join("");
      const ctaInput = document.createElement("input");
      ctaInput.className = "input";
      ctaInput.id = "cat-bb-cta";
      ctaInput.placeholder = "See this product";
      ctaInput.value = catalog.billboardCta || "";
      ctaInput.setAttribute("aria-label", "Button label");

      const syncCta = () => { ctaInput.hidden = !sel.value; };
      sel.addEventListener("change", syncCta);
      syncCta();

      const bbSave = document.createElement("button");
      bbSave.type = "button";
      bbSave.className = "btn btn-secondary btn-sm";
      bbSave.textContent = "Save billboard";
      bbSave.addEventListener("click", async () => {
        bbSave.disabled = true;
        const res = await setBillboard(activeId, {
          productId: sel.value || null,
          cta: ctaInput.value,
          enabled: bbOn.checked,
        });
        bbSave.disabled = false;
        if (!res.ok) { toast(res.error, { type: "danger" }); return; }
        catalog.billboardProductId = sel.value || null;
        catalog.billboardCta = ctaInput.value.trim();
        toast("Billboard saved.", { type: "success" });
        paintBillboard();
      });

      target.appendChild(sel);
      target.appendChild(ctaInput);
      target.appendChild(bbSave);
      bbBody.appendChild(target);
    }

    bbOn.addEventListener("change", async () => {
      const res = await setBillboard(activeId, { enabled: bbOn.checked });
      if (!res.ok) { bbOn.checked = !bbOn.checked; toast(res.error, { type: "danger" }); return; }
      catalog.billboardEnabled = bbOn.checked;
      paintBillboard();
    });
    paintBillboard();
    card.appendChild(bbBox);

    // ---- what the pinned group is called ----
    const hlBox = document.createElement("div");
    hlBox.className = "cat-billboard";
    hlBox.innerHTML = `<h5>Highlighted group</h5>
      <p class="cat-hint">Products you highlight always sit at the top of this catalog, under this heading. Highlight them with the star on each card below.</p>`;
    const hlRow = document.createElement("div");
    hlRow.className = "cat-link-row";
    const hlInput = document.createElement("input");
    hlInput.className = "input";
    hlInput.id = "cat-highlight-label";
    hlInput.value = catalog.highlightLabel || "Featured";
    hlInput.placeholder = "New Arrivals";
    hlInput.setAttribute("aria-label", "What to call the highlighted group");
    const hlSave = document.createElement("button");
    hlSave.type = "button";
    hlSave.className = "btn btn-secondary btn-sm";
    hlSave.textContent = "Save name";
    hlSave.addEventListener("click", async () => {
      hlSave.disabled = true;
      const res = await setHighlightLabel(activeId, hlInput.value);
      hlSave.disabled = false;
      if (!res.ok) { toast(res.error, { type: "danger" }); return; }
      catalog.highlightLabel = res.label;
      hlInput.value = res.label;
      toast(`Highlighted products will show under "${res.label}".`, { type: "success" });
    });
    hlRow.appendChild(hlInput);
    hlRow.appendChild(hlSave);
    hlBox.appendChild(hlRow);
    card.appendChild(hlBox);

    const actions = document.createElement("div");
    actions.className = "pf-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-primary btn-sm";
    save.id = "cat-save";
    save.textContent = "Save catalog settings";
    const status = document.createElement("span");
    status.className = "cat-hint";
    actions.appendChild(save);
    actions.appendChild(status);
    card.appendChild(actions);

    save.addEventListener("click", async () => {
      save.disabled = true;
      const res = await updateCatalogSettings(activeId, {
        accessTier: Number(tierSel.value),
        discountPct: Number(pctInput.value),
        discountMode: modeSel.value,
      });
      save.disabled = false;
      if (!res.ok) { status.textContent = res.error; toast(res.error, { type: "danger" }); return; }
      // Keep the in-memory catalog in step, or switching tabs and back would
      // show the old numbers and look like the save had not worked.
      catalog.accessTier = Number(tierSel.value);
      catalog.discountPct = Number(pctInput.value);
      catalog.discountMode = modeSel.value;
      status.textContent = "Saved.";
      toast(`${catalog.name} updated.`, { type: "success" });
    });

    return card;
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

    // Same card grid as Inventory and Products. A catalog is the most
    // catalogue-like screen in the app -- it is literally a wholesaler showing
    // a buyer what they make -- so it would be the strangest place to keep a
    // list of text rows with a stamp-sized photo.
    const grid = productGrid();
    const catFacts = normaliseFacts((await getWholesalerSettings(wid)).card_facts, []);
    // One call for the whole screen. Per-tile would be a query per product
    // on a catalog that can hold hundreds.
    const stockStates = await getStockStates(wid);
    products.forEach((p) => {
      const badges = [];
      if (p.archived) badges.push({ text: "Archived", kind: "badge-neutral" });
      // Batch 8, C4. The catalog is where you decide how a thing is sold, so
      // it is the screen that most needs to show it. NOTE the field is
      // camelCase here and snake_case in the Products pane -- two different
      // queries, one shared badge helper, which is the point of the helper.
      const smB = sellingModelBadge(p.sellingModel);
      if (smB) badges.push(smB);

      // Stock state, migration 062. THREE states, not two: a catalog-only
      // product is never "out of stock" -- it is not stock-controlled at
      // all, and saying "out" about it would be a lie that also drags it
      // into every low-stock report.
      const st = stockStates.get(p.id);
      if (st?.state === "out") {
        badges.push({ text: "OUT OF STOCK", kind: "badge-danger" });
      } else if (st?.state === "not_tracked") {
        badges.push({ text: "Catalog only", kind: "badge-neutral" });
      }

      if (p.highlighted) badges.push({ text: catalog.highlightLabel || "Featured", kind: "badge-success" });
      p.colors.slice(0, 6).forEach((c) => badges.push({ text: c.name, kind: "badge-neutral" }));

      const tile = renderProductTile({
        id: p.id,
        name: p.name,
        images: p.images || [],
        badges,
        facts: factsFor(p, catFacts, {}),
        actions: [
          { label: "View", variant: "btn-primary", onClick: () => openProductView(p.id, () => paintList()) },
          { label: "Edit", onClick: () => openProductEditor(p.id, () => paintList()) },
          // Hadi, 20 Aug 2026: the ratio editor belongs here as well as on
          // Products, because the catalog is where you decide what you are
          // actually selling and how it is sold. Deliberately NOT added to
          // Inventory: that tab is about stock movements, and selling rules
          // are a different job -- mixing them is how a screen stops having
          // one answer to "what is this for".
          { label: "Packs & ratios",
            title: "Size ratios, prepacks and how this product is sold",
            onClick: () => openProductPanel(catPanelHost, "Prepacks and ratios", p,
                                            (body) => renderPacksPanel(body, wid, p)) },
          // Hadi, 20 Aug 2026: "create a toggle... hey, this is a
          // catalog-only product, don't put it in the inventory."
          //
          // The label states the RESULT of pressing it, not the current
          // state -- a button called "Catalog only" leaves you working out
          // whether that is what it is or what it will become.
          { label: st?.state === "not_tracked" ? "Start tracking stock" : "Make catalog-only",
            title: st?.state === "not_tracked"
              ? "Put this back in Inventory and start counting stock for it"
              : "Sell it from catalogs but keep it out of Inventory — for made-to-order, drop-ship or service lines that should never appear in a low-stock report",
            onClick: async () => {
              const goingCatalogOnly = st?.state !== "not_tracked";
              const { error } = await setCatalogOnly(p.id, goingCatalogOnly);
              if (error) { toast("Could not change this", { type: "danger" }); return; }
              toast(goingCatalogOnly
                ? `${p.name} is catalog-only — it will not appear in Inventory`
                : `${p.name} is back in Inventory and stock-controlled`,
                { type: "success" });
              paintList();
            } },
          // Hadi: "I want them to be able to highlight as many items as they
          // want... no matter what order they put them in, always the
          // highlighted items will be on the top." The label says which way
          // the click goes, rather than naming a state you have to work out.
          { label: p.highlighted ? "★ Remove highlight" : "☆ Highlight",
            title: `Highlighted products sit at the top of this catalog under "${catalog.highlightLabel || "Featured"}"`,
            onClick: async () => {
              const res = await setProductHighlighted(activeId, p.id, !p.highlighted);
              if (!res.ok) { toast(res.error, { type: "danger" }); return; }
              toast(p.highlighted
                ? `"${p.name}" is no longer highlighted.`
                : `"${p.name}" now sits at the top under "${catalog.highlightLabel || "Featured"}".`,
                { type: "success" });
              await paintList();
            } },
          // Wording matters: this unfiles, it does not delete. "Remove" alone
          // reads as destructive and would stop people using catalogs at all.
          { label: "Remove from catalog", onClick: async () => {
              const res = await removeProductFromCatalog(activeId, p.id);
              if (!res.ok) { toast(res.error, { type: "danger" }); return; }
              toast(`"${p.name}" removed from ${catalog.name}. The product itself is untouched.`, { type: "success" });
              await paintList();
            } },
        ],
        onOpen: () => openProductView(p.id, () => paintList()),
      });
      // The same glow the customer sees. Arranging a catalog and reading it
      // should look like the same catalog.
      if (p.highlighted) tile.classList.add("pcard-highlighted");
      grid.appendChild(tile);
    });
    listHost.appendChild(grid);
    // Where "Packs & ratios" opens, for the same reason Products has one:
    // the panel lands under the grid rather than over it, so the product
    // you clicked stays on screen while you edit how it is sold.
    // Recreated on every paint because listHost is cleared above -- a host
    // held from an earlier paint would be detached and the panel would
    // open into nothing, which looks exactly like the button not working.
    catPanelHost = document.createElement("div");
    listHost.appendChild(catPanelHost);
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

async function locationsView(outlet, { embedded = false } = {}) {
  const session = devAuth.getSession();
  const wid = session.wid;
  // Batch 8B: when this view is a SUB-TAB of Inventory the screen already has
  // its title, so a second one stacked underneath reads as two screens rather
  // than one. Kept as a flag, not deleted, so the standalone route still shows
  // a title if it is ever reached directly.
  if (!embedded) {
    outlet.appendChild(pageHeader(
      "Locations",
      "Warehouses and shops that hold your stock. Move stock between them here."
    ));
  }

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
      const name = await ask({
        title: "New stock location",
        body: "Somewhere stock physically sits. You can transfer units between locations, and every transfer is recorded.",
        label: "What is this location called?",
        placeholder: "Main Warehouse, Beirut Shop, Container 3…",
        confirmLabel: "Create location",
        validate: (v) => (v.trim().length >= 2 ? null : "Give it a name you would recognise on a stock report."),
      });
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
        const name = await ask({
          title: "Rename this location",
          label: "Location name",
          value: loc.name,
          confirmLabel: "Rename",
          validate: (v) => (v.trim().length >= 2 ? null : "Give it a name you would recognise on a stock report."),
        });
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

// ---------- Viewing a product (Batch 19) ----------
// The other half of "a button to essentially edit or a button to view or
// both". View comes FIRST in every action list on purpose: it is the safe
// door. Someone who is not sure which product they are looking at should be
// able to find out without landing in a form where a stray keystroke is an
// edit they now have to notice and undo.
//
// It opens in the same overlay the editor uses, and carries an "Edit this
// product" button, so the reading path leads into the writing path without
// making the writing path the only path.
function overlayHost(label) {
  const overlay = document.createElement("div");
  overlay.className = "prod-edit";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label);

  // Batch 8A, 23 Aug 2026. This used to own its own Escape listener and its
  // own body-scroll lock, and it did NOT listen for navigation. That is the
  // whole reason a product edit form was found sitting open over the
  // dashboard: the "N on hand" link inside it changed the route, the view
  // underneath was replaced, and this overlay -- which lives on document.body,
  // not in the view -- simply stayed where it was.
  //
  // Escape, the scroll lock, focus return and closing-on-navigation are now
  // all properties of js/lib/modal-stack.js, so the next dialog anyone writes
  // gets them without having to remember any of it.
  const close = () => closeModal(overlay);

  // Clicking the backdrop closes; clicking the panel does not. The panel is
  // the thing being read, and a mis-aimed click inside it should never throw
  // the reader out of it.
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });

  // The caller fills the overlay and then calls mount(). Kept as a separate
  // step rather than mounting here so a half-built dialog is never on screen.
  const mount = () => openModal(overlay, { label });

  return { overlay, close, mount };
}

async function openProductView(productId, onEdited) {
  if (!productId) { toast("That product could not be identified.", { type: "danger" }); return; }
  const detail = await getProductDetail(productId);
  if (!detail.ok) { toast(detail.error, { type: "danger" }); return; }

  const { overlay, close, mount } = overlayHost(`Details for ${detail.product.name}`);
  overlay.appendChild(renderProductDetail(detail, {
    onClose: close,
    onEdit: () => { close(); openProductEditor(productId, onEdited); },
  }));
  mount();
  overlay.querySelector(".pdet-close, .pdet-edit")?.focus();
}

// ---------- Editing a product (Batch 19) ----------
// Hadi: "I can't edit the product at all. Maybe there's a mistake. Maybe I
// want to look at the data." He was right -- there was no edit path anywhere
// in the app, only archive, duplicate and a bulk price tool.
//
// It reuses the builder rather than growing a second form. Two forms for one
// object drift: the edit one always ends up missing the field the create one
// gained last week, and then a wholesaler cannot fix the thing they just
// created. Same component, same validation, same grid, filled in.
async function openProductEditor(productId, onSaved) {
  if (!productId) { toast("That product could not be identified.", { type: "danger" }); return; }
  const session = devAuth.getSession();
  const wid = session?.wid;

  const [loaded, suppliers, locations] = await Promise.all([
    getProductForEdit(productId), listSuppliers(wid), getLocations(wid),
  ]);
  if (!loaded.ok) { toast(loaded.error, { type: "danger" }); return; }

  // Current stock per variant, so the grid opens showing what is actually on
  // hand rather than zeroes -- editing a product should not look like the
  // stock has vanished.
  const stock = await getStockTable(wid);
  const onHandByVariant = new Map();
  stock.forEach((r) => {
    onHandByVariant.set(r.variantId, (onHandByVariant.get(r.variantId) || 0) + r.onHand);
  });

  const colourBarcodes = {};
  loaded.colourBarcodes.forEach((cb) => { colourBarcodes[String(cb.color).toLowerCase()] = cb.barcode; });

  const images = [];
  loaded.variants.forEach((v) => {
    [v.image_url, ...(Array.isArray(v.images) ? v.images : [])].forEach((u) => {
      const url = String(u || "").trim();
      if (url && !images.includes(url)) images.push(url);
    });
  });

  const initial = {
    // id added 23 Aug 2026 (Batch 8D): the form needs it to know whether the
    // "Set ratios" button has anything to attach to yet.
    id: loaded.product.id,
    name: loaded.product.name,
    description: loaded.product.description,
    category: loaded.product.category,
    moqQty: loaded.product.moq_qty,
    sellingModel: loaded.product.selling_model,
    barcode: loaded.product.barcode,
    supplierId: loaded.product.supplier_id,
    images,
    colourBarcodes,
    variants: loaded.variants
      .filter((v) => !v.archived)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        price: v.price,
        cost: v.cost,
        retailPrice: v.retail_price,
        moqQty: v.moq_qty,
        barcode: v.barcode,
        color: v.extra_attrs?.color,
        size: v.extra_attrs?.size,
        colorHex: v.extra_attrs?.colorHex,
        onHand: onHandByVariant.get(v.id) || 0,
      })),
  };

  const { overlay, close, mount } = overlayHost(`Edit ${loaded.product.name}`);

  const form = renderProductForm({
    suppliers,
    locations,
    initial,
    onCreateSupplier: (d) => createSupplier(wid, d),
    // Batch 8D. The editor is itself a modal, so it closes before the drawer
    // opens -- two stacked modals is not a state worth supporting, and an
    // editor left open behind a drawer is the orphaned-dialog bug of 23 Aug.
    onOpenSellingSetup: (pid, model) => { close(); openSellingSetup(pid, model); },
    // Batch 8A. The "N on hand" figure in the grid used to change the route to
    // Inventory, which closed nothing and left this editor floating over the
    // Inventory screen. Now it opens the receive dialog ON TOP of this one:
    // the modal stack supports two deep, so the editor is still underneath,
    // still holding every unsaved photo and every grid cell, when the receipt
    // finishes.
    onOpenStock: (v) => {
      const variant = loaded.variants.find(
        (x) => !x.archived && x.extra_attrs?.color === v.colourName && x.extra_attrs?.size === v.size
      );
      if (!variant) {
        toast("Save this product first — that size does not exist in your stock yet.", { type: "warning" });
        return;
      }
      const location = locations[0] || null;
      if (!location?.id) {
        toast("There is no stock location set up to receive into. Tell OGGI — every wholesaler should have one.", { type: "danger" });
        return;
      }
      openReceiveDialog({
        productName: loaded.product.name,
        color: v.colourName, size: v.size,
        sku: variant.sku, locationName: location.name,
        onHand: v.onHand || 0, cost: variant.cost,
      }, async ({ qty, freight, duty, other, recordCost }) => {
        const { error } = await receiveStock(variant.id, location.id, qty);
        if (error) return { ok: false, error: "That receipt could not be saved. Nothing was changed." };
        if (recordCost && (freight || duty || other)) {
          await recordReceiptCost({
            variantId: variant.id, locationId: location.id, qty,
            baseCost: variant.cost, freightCost: freight, dutyCost: duty, otherCost: other,
          });
        }
        // Reopen the editor on fresh data so the figure the person just
        // changed is the figure they see. Refetching rather than adding qty
        // to what is on screen: another device may have moved the same stock.
        toast(`Received ${qty} units`, { type: "success" });
        close();
        openProductEditor(productId, onSaved);
        return { ok: true };
      });
    },
    onCancel: close,
    onSubmit: async (draft) => {
      const res = await updateProduct(productId, draft);
      if (res.ok) {
        toast(res.message, { type: res.failed?.length ? "warning" : "success" });
        close();
        onSaved?.();
      }
      return res;
    },
  });

  overlay.appendChild(form.el);
  mount();
  form.focus();
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
async function suppliersView(outlet, { embedded = false } = {}) {
  const session = devAuth.getSession();
  const wid = session?.wid;
  outlet.innerHTML = "";
  // Batch 8B: when this view is a SUB-TAB of Inventory the screen already has
  // its title, so a second one stacked underneath reads as two screens rather
  // than one. Kept as a flag, not deleted, so the standalone route still shows
  // a title if it is ever reached directly.
  if (!embedded) {
    outlet.appendChild(pageHeader(
      "Suppliers",
      "Who you buy from. Attach one to a product when you create it, so you can always find your way back to the source."
    ));
  }

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
    // Four required fields, the rest optional -- Hadi: "make everything
    // optional to add except the name and location and phone number and person
    // of contact". Grouped under headings rather than presented as one wall of
    // twenty inputs, because the answer to "what does this supplier sell" and
    // the answer to "what are their payment terms" get filled in at completely
    // different moments.
    card.innerHTML = `
      <div class="pf-grid">
        <div class="pf-field pf-span-2">
          <label class="pf-label">Supplier name <span class="pf-required">required</span></label>
          <input class="input" data-f="name" value="${esc(sp.name || "")}" autocomplete="off" placeholder="e.g. Zhejiang Textiles">
        </div>
        <div class="pf-field">
          <label class="pf-label">Contact person <span class="pf-required">required</span></label>
          <input class="input" data-f="contactName" value="${esc(sp.contactName || "")}" autocomplete="off">
        </div>
        <div class="pf-field">
          <label class="pf-label">Phone <span class="pf-required">required</span></label>
          <input class="input" data-f="phone" type="tel" value="${esc(sp.phone || "")}" autocomplete="off">
        </div>
        <div class="pf-field pf-span-2">
          <label class="pf-label">Address <span class="pf-required">required</span></label>
          <input class="input" data-f="address" value="${esc(sp.address || "")}" autocomplete="off" placeholder="Street, city — or just the city">
        </div>
        ${field("Country", "country", sp.country)}
        ${field("Email", "email", sp.email, "email")}

        <div class="pf-field pf-span-2 sup-group">What they sell</div>
        <div class="pf-field pf-span-2">
          <label class="pf-label">Categories / product types</label>
          <input class="input" data-f="sells" value="${esc((sp.sells || []).join(", "))}" autocomplete="off" placeholder="Denim, knitwear, outerwear — separate with commas">
        </div>
        <div class="pf-field pf-span-2">
          <label class="pf-label">Brands they carry</label>
          <input class="input" data-f="brands" value="${esc((sp.brands || []).join(", "))}" autocomplete="off" placeholder="Separate with commas">
        </div>

        <div class="pf-field pf-span-2 sup-group">Trade terms</div>
        ${field("Minimum order", "moq", sp.moq)}
        ${field("Lead time", "leadTime", sp.leadTime)}
        ${field("Payment terms", "paymentTerms", sp.paymentTerms)}
        ${field("Currency", "currency", sp.currency)}

        <div class="pf-field pf-span-2 sup-group">Where to find them</div>
        ${field("Website", "website", sp.website)}
        ${field("WhatsApp", "whatsapp", sp.whatsapp, "tel")}
        ${field("Instagram", "instagram", sp.instagram)}
        ${field("Catalogue link", "catalogUrl", sp.catalogUrl)}

        <div class="pf-field pf-span-2 sup-group">Your own notes</div>
        <div class="pf-field">
          <label class="pf-label">Rating</label>
          <select class="input" data-f="rating">
            <option value="">Not rated</option>
            ${[1,2,3,4,5].map((n) => `<option value="${n}"${Number(sp.rating) === n ? " selected" : ""}>${"★".repeat(n)}</option>`).join("")}
          </select>
        </div>
        <div class="pf-field">
          <label class="pf-label">Status</label>
          <select class="input" data-f="status">
            ${["active","trialling","dropped"].map((v) => `<option value="${v}"${(sp.status || "active") === v ? " selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("")}
          </select>
        </div>
        <div class="pf-field">
          <label class="pf-label">Last contacted</label>
          <input class="input" data-f="lastContacted" type="date" value="${esc(sp.lastContacted || "")}">
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
        sells: read("sells"), brands: read("brands"),
        moq: read("moq"), leadTime: read("leadTime"),
        paymentTerms: read("paymentTerms"), currency: read("currency"),
        website: read("website"), whatsapp: read("whatsapp"),
        instagram: read("instagram"), catalogUrl: read("catalogUrl"),
        rating: read("rating"), status: read("status"), lastContacted: read("lastContacted"),
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
      const trade = [
        (sp.sells || []).length && `Sells: ${sp.sells.join(", ")}`,
        (sp.brands || []).length && `Brands: ${sp.brands.join(", ")}`,
        sp.moq && `MOQ ${sp.moq}`,
        sp.leadTime && `Lead ${sp.leadTime}`,
        sp.paymentTerms,
        sp.rating && "★".repeat(Number(sp.rating)),
        sp.status && sp.status !== "active" && sp.status,
      ].filter(Boolean);
      card.innerHTML = `
        <div class="sup-row-main">
          <div class="sup-row-name">${esc(sp.name)}${sp.archived ? ' <span class="badge badge-neutral">Archived</span>' : ""}</div>
          <div class="sup-row-meta">${bits.length ? bits.map(esc).join(" · ") : "No contact details yet"}</div>
          ${trade.length ? `<div class="sup-row-trade">${trade.map(esc).join(" · ")}</div>` : ""}
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


// =============================================================================
// INVENTORY — the shell, and the pane that holds the wholesaler-wide rules
// =============================================================================
// Batch 6. Hadi asked for Products to become a sub-tab of Inventory. Doing it
// required somewhere for six things to live that existed ONLY on the Products
// screen, which is why this was the last batch and not the first:
//
//   pricing tiers          -> Products pane, "Pricing & MOQ" on each card
//   product MOQ            -> the same panel
//   archive / unarchive    -> Products pane, on each card
//   duplicate as template  -> Products pane, on each card
//   bulk price update      -> Pricing rules pane, rebuilt safe (migration 078)
//   order-level minimum    -> Pricing rules pane
//
// checks/check_inventory_panes.mjs asserts each of those six is reachable, so
// "we moved the screen and quietly lost a feature" cannot pass review. That is
// the whole reason the fold waited for its own batch.
//
// The last two are on their own pane rather than at the foot of the product
// list, where they used to sit. Neither is a property of any product, and a
// control that reprices an entire catalogue does not belong under a grid
// somebody scrolls past forty times a day.

/**
 * INVENTORY — one module, nine views of the same stock.  (Batch 8B, 23 Aug 2026)
 *
 * The wholesaler sidebar had FIFTEEN entries and seven of them were inventory.
 * Batch 6 folded Products in and stopped, which was fairly criticised as moving
 * one item and calling it a system. These six were never separate places: they
 * are questions you ask about the same stock. Where is it (Locations), how did
 * it get there (Movements), who sold it to you (Suppliers), how do you find it
 * on a shelf (Labels, Scan), and what should you do about it (Insights).
 *
 * EVERY TAB'S PATH IS ITS ORIGINAL TOP-LEVEL ROUTE, deliberately. The obvious
 * design would have been fresh `/wholesaler/inventory/movements` paths plus
 * redirects from the old ones. That is two sets of paths to keep in step, and
 * the redirect layer is exactly the sort of thing that rots quietly. Reusing
 * the original path means every bookmark and every installed phone's cached
 * navigation keeps working BY CONSTRUCTION rather than by a redirect somebody
 * has to remember to maintain.
 *
 * Labels and Movements take route params (a product id), so their render gets
 * the params object; the rest ignore it.
 */
const INVENTORY_TABS = [
  { key: "stock",        icon: "📊", label: "Stock",         path: "/wholesaler/inventory",          render: (host) => stockPane(host) },
  { key: "products",     icon: "📦", label: "Products",      path: "/wholesaler/inventory/products", render: (host) => productsPane(host) },
  { key: "pricing",      icon: "💲", label: "Pricing rules", path: "/wholesaler/inventory/pricing",  render: (host) => pricingRulesPane(host) },
  { key: "movements",    icon: "🕓", label: "Movements",     path: "/wholesaler/movements",          render: (host, params) => movementsView(host, { ...params, embedded: true }) },
  { key: "locations",    icon: "🏬", label: "Locations",     path: "/wholesaler/locations",          render: (host) => locationsView(host, { embedded: true }) },
  { key: "suppliers",    icon: "🏭", label: "Suppliers",     path: "/wholesaler/suppliers",          render: (host) => suppliersView(host, { embedded: true }) },
  { key: "labels",       icon: "🏷", label: "Labels",        path: "/wholesaler/labels",             render: (host, params) => labelsView(host, { ...params, embedded: true }) },
  { key: "scan",         icon: "📷", label: "Scan",          path: "/wholesaler/receive-scan",       render: (host) => receiveScanView(host, { embedded: true }) },
  { key: "intelligence", icon: "🧠", label: "Insights",      path: "/wholesaler/intelligence",       render: (host) => intelligenceView(host, { embedded: true }) },
];

/** The subtitle under "Inventory" changes with the tab, so the screen says what
 *  you are actually looking at. One title, nine explanations. */
const INVENTORY_SUBTITLE = {
  stock:        "What you have, where it is, and what is available to sell right now.",
  products:     "Everything you sell. Create, edit, price and set how each one is ordered.",
  pricing:      "The rules that apply to every product at once.",
  movements:    "Every unit in and out, dated and explained. This is why a number is what it is.",
  locations:    "Warehouses and shops that hold your stock. Move stock between them here.",
  suppliers:    "Who you buy from — so you can always find your way back to the source.",
  labels:       "Print a scannable label for every colour and size.",
  scan:         "Scan a barcode or type the SKU, confirm the quantity, done.",
  intelligence: "Reorder suggestions, aging and sell-through, ABC cycle counts, and kits.",
};

async function inventoryView(outlet, { tab = "stock", ...params } = {}) {
  outlet.appendChild(pageHeader(
    "Inventory",
    INVENTORY_SUBTITLE[tab] || "Your stock, your products and the rules that price them — one screen."
  ));
  // params carries route params (a product id for Movements and Labels)
  // straight through to whichever pane wants them.
  const tabs = renderSubTabs({ tabs: INVENTORY_TABS, active: tab, params });
  outlet.appendChild(tabs.el);
  await tabs.paint();
}

/**
 * PRICING RULES — the two things that apply to every product at once.
 */
async function pricingRulesPane(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  const reload = () => { outlet.innerHTML = ""; pricingRulesPane(outlet); };

  // ---- Bulk price update, rebuilt ----------------------------------------
  // The old version was one number and one button that repriced every variant
  // this wholesaler owned, archived ones included, with no confirmation and no
  // record of the previous price. See migration 078 and
  // js/data/products-admin.js's retired bulkUpdatePrice for the full account.
  const bulkCard = document.createElement("div");
  bulkCard.className = "card";
  bulkCard.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:10px;";
  bulkCard.innerHTML = `
    <strong style="font-size:13px;">Change every price at once</strong>
    <div style="font-size:11px;color:var(--text-tertiary);">
      Enter a percentage, see exactly what it would do, then apply. Every change is
      recorded and can be undone.
    </div>`;

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
  const pctInput = document.createElement("input");
  pctInput.className = "input"; pctInput.type = "number"; pctInput.step = "0.1";
  pctInput.placeholder = "e.g. 10 or -15"; pctInput.style.width = "120px";
  pctInput.setAttribute("aria-label", "Percentage change to apply to every price");

  const archLabel = document.createElement("label");
  archLabel.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);";
  const archBox = document.createElement("input");
  archBox.type = "checkbox";
  archLabel.appendChild(archBox);
  archLabel.appendChild(document.createTextNode("Include archived products"));

  const previewBtn = document.createElement("button");
  previewBtn.className = "btn btn-secondary btn-sm";
  previewBtn.textContent = "Preview";

  row.appendChild(pctInput); row.appendChild(archLabel); row.appendChild(previewBtn);
  bulkCard.appendChild(row);

  // The preview and the confirm live in the same box, and the Apply button
  // only exists once a preview has been read. A destructive control that can
  // be reached without passing the description of what it will do is a
  // control people press by accident.
  const previewBox = document.createElement("div");
  previewBox.style.cssText = "font-size:12px;";
  bulkCard.appendChild(previewBox);

  previewBtn.addEventListener("click", async () => {
    const pct = parseFloat(pctInput.value);
    previewBox.innerHTML = "";
    if (!Number.isFinite(pct) || pct === 0) {
      toast("Enter a percentage first — 0 would do nothing", { type: "danger" });
      return;
    }
    previewBtn.disabled = true;
    const p = await previewBulkPrice(wid, pct, { includeArchived: archBox.checked });
    previewBtn.disabled = false;
    if (!p) { toast("Could not work out what that would do", { type: "danger" }); return; }
    if (!p.variantCount) {
      previewBox.innerHTML = `<div style="color:var(--warning-600,#a15c00);">Nothing to reprice — no priced products match.</div>`;
      return;
    }

    const summary = document.createElement("div");
    summary.style.cssText = "background:var(--surface-2,rgba(0,0,0,.03));border-radius:8px;padding:10px;margin-top:4px;";
    // The extremes, not just the count. "482 prices" tells you nothing about
    // whether you typed 10 or 100; "your dearest goes 228.00 to 250.80" does.
    summary.innerHTML = `
      <div><strong>${p.variantCount}</strong> price${p.variantCount === 1 ? "" : "s"} would change by <strong>${formatPct(pct)}</strong>.</div>
      <div style="color:var(--text-secondary);margin-top:4px;">
        Cheapest ${money(p.minBefore, "$")} → <strong>${money(p.minAfter, "$")}</strong> ·
        dearest ${money(p.maxBefore, "$")} → <strong>${money(p.maxAfter, "$")}</strong>
      </div>
      ${p.skippedArchived ? `<div style="color:var(--text-tertiary);margin-top:4px;">${p.skippedArchived} archived ${p.skippedArchived === 1 ? "price is" : "prices are"} being left alone.</div>` : ""}
    `;
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary btn-sm";
    applyBtn.style.marginTop = "8px";
    applyBtn.textContent = `Apply ${formatPct(pct)} to ${p.variantCount} price${p.variantCount === 1 ? "" : "s"}`;
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      const res = await applyBulkPrice(wid, pct, { includeArchived: archBox.checked });
      applyBtn.disabled = false;
      if (!res.ok) {
        toast(res.error?.message || "Could not apply the change", { type: "danger" });
        return;
      }
      toast(`${res.variantCount} prices changed by ${formatPct(pct)} — you can undo this below`, { type: "success" });
      reload();
    });
    summary.appendChild(applyBtn);
    previewBox.appendChild(summary);
  });

  outlet.appendChild(bulkCard);

  // ---- What was changed, and the undo ------------------------------------
  const history = document.createElement("div");
  history.className = "card";
  history.style.cssText = "margin-top:12px;padding:16px;";
  const batches = await recentPriceBatches(wid, 5);
  if (!batches.length) {
    history.innerHTML = `<strong style="font-size:13px;">Recent price changes</strong>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:6px;">None yet. Once you make one it appears here, with an undo.</div>`;
  } else {
    history.innerHTML = `<strong style="font-size:13px;">Recent price changes</strong>`;
    batches.forEach((b) => {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;flex-wrap:wrap;";
      r.innerHTML = `<div style="flex:1;min-width:0;">
          <strong>${esc(formatPct(b.pctDelta))}</strong> on ${b.variantCount} price${b.variantCount === 1 ? "" : "s"}
          <span style="color:var(--text-tertiary);">· ${new Date(b.changedAt).toLocaleString()}</span>
          ${b.reverted ? ` <span class="badge badge-neutral">undone</span>` : ""}
        </div>`;
      if (!b.reverted) {
        const undo = document.createElement("button");
        undo.className = "btn btn-secondary btn-sm";
        undo.textContent = "Undo";
        undo.addEventListener("click", async () => {
          undo.disabled = true;
          const res = await revertPriceBatch(b.batchId);
          undo.disabled = false;
          if (!res.ok) { toast(res.error?.message || "Could not undo", { type: "danger" }); return; }
          // `skipped` is said out loud rather than swallowed. It is the count
          // of prices edited by hand since this batch ran, which the undo
          // deliberately left alone -- an undo that silently declines to undo
          // part of what it did is as misleading as one that clobbers work.
          toast(
            res.skipped
              ? `${res.restored} price${res.restored === 1 ? "" : "s"} put back. ${res.skipped} left alone — you had edited ${res.skipped === 1 ? "it" : "them"} since.`
              : `${res.restored} price${res.restored === 1 ? "" : "s"} put back`,
            { type: "success" }
          );
          reload();
        });
        r.appendChild(undo);
      }
      history.appendChild(r);
    });
  }
  outlet.appendChild(history);

  // ---- Order-level minimums ----------------------------------------------
  const orderMinCard = document.createElement("div");
  orderMinCard.className = "card";
  orderMinCard.style.cssText = "margin-top:12px;padding:16px;display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;";
  const mins = await getOrderMinimums(wid);
  orderMinCard.innerHTML = `
    <strong style="font-size:13px;width:100%;">Order-level minimum (applies to every order placed with you)</strong>
    <div style="font-size:11px;color:var(--text-tertiary);width:100%;margin-top:-4px;">
      Enforced by the server at checkout, not just shown — a buyer cannot submit under it.
    </div>
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

export function registerWholesalerRoutes(router) {
  router.register("/wholesaler", (outlet) => dashboard(outlet));
  // Batch 6: Products folded into Inventory. This route is KEPT and lands on
  // the Products pane, because an installed PWA can hold the old navigation in
  // its cache and a bookmark can outlive any refactor -- a link that used to
  // work must not start returning nothing.
  router.register("/wholesaler/products", (outlet) => inventoryView(outlet, { tab: "products" }));
  router.register("/wholesaler/orders", (outlet) => ordersView(outlet));
  router.register("/wholesaler/orders/:id", (outlet, params) => orderDetailView(outlet, params.id));
  router.register("/wholesaler/clients", (outlet) => clientsView(outlet));
  router.register("/wholesaler/team", (outlet) => teamView(outlet));
  router.register("/wholesaler/catalogs", (outlet) => catalogsView(outlet));
  // Batch 8A. One catalog, by id. The OLD bare path above is deliberately kept
  // and deliberately listed FIRST: it is what every existing bookmark and
  // every installed PWA's cached navigation points at, and it must keep
  // landing somewhere real rather than on "Page not found".
  router.register("/wholesaler/catalogs/:id", (outlet, params) => catalogsView(outlet, params));
  // Batch 8A. The packs & ratios drawer as a PLACE rather than a transient
  // state. Reload with it open and it comes back open, which is the whole
  // difference between a dialog and a screen.
  router.register("/wholesaler/catalogs/:id/product/:pid/packs", (outlet, params) => catalogsView(outlet, params));
  router.register("/wholesaler/inventory", (outlet) => inventoryView(outlet, { tab: "stock" }));
  router.register("/wholesaler/inventory/products", (outlet) => inventoryView(outlet, { tab: "products" }));
  router.register("/wholesaler/inventory/pricing", (outlet) => inventoryView(outlet, { tab: "pricing" }));
  // Batch 8B. These six used to be top-level screens with their own nav entries.
  // They are now sub-tabs of Inventory -- and they keep their ORIGINAL paths,
  // so every bookmark and every installed phone's cached navigation still lands
  // somewhere real, without a redirect layer to maintain.
  router.register("/wholesaler/movements", (outlet) => inventoryView(outlet, { tab: "movements" }));
  router.register("/wholesaler/labels", (outlet) => inventoryView(outlet, { tab: "labels" }));
  router.register("/wholesaler/labels/:productId", (outlet, params) => inventoryView(outlet, { tab: "labels", ...params }));
  // Deep link from a product card, so "why is this 12 and not 20" is answered
  // where the question is actually asked rather than on a screen the
  // wholesaler has to think to go and find.
  router.register("/wholesaler/movements/:productId", (outlet, params) => inventoryView(outlet, { tab: "movements", ...params }));

  router.register("/wholesaler/locations", (outlet) => inventoryView(outlet, { tab: "locations" }));
  router.register("/wholesaler/suppliers", (outlet) => inventoryView(outlet, { tab: "suppliers" }));
  router.register("/wholesaler/intelligence", (outlet) => inventoryView(outlet, { tab: "intelligence" }));
  router.register("/wholesaler/receive-scan", (outlet) => inventoryView(outlet, { tab: "scan" }));
  router.register("/wholesaler/settings", (outlet) => settingsView(outlet));
}
