// OGGI Wholesale v2 — mobile barcode receiving & picking (Batch 10)
//
// Two dedicated, mobile-first screens, kept in their own file rather than
// folded into the already-large js/views/wholesaler.js -- these are meant
// to be opened on a phone/tablet in a warehouse, not alongside the desktop
// admin chrome, so they intentionally use larger touch targets and a
// single-column layout.
//
// Scanning mechanism: a plain autofocused text input that captures
// whatever a hardware barcode scanner types (nearly all warehouse barcode
// scanners act as a fast keyboard + a trailing Enter keystroke -- this
// works with any such scanner, no camera/library/permissions needed, and
// is the same mechanism most production warehouse web tools use for
// exactly that reason). As a progressive enhancement, when the browser
// exposes the native BarcodeDetector API, an optional "Scan with camera"
// button appears; it's fully feature-detected and wrapped defensively so
// its absence (or a denied camera permission) never blocks the primary
// keyboard-scanner path, which is the one actually verified in this build
// (see the Batch 10 deploy record for why camera scanning itself couldn't
// be exercised in this sandbox).

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";
import { toast } from "../components/toast.js";
// Batch 16: renderScanBar moved to components/scan-bar.js so the product
// builder can scan into grid cells without a second implementation. The
// behaviour here is unchanged -- it is the same function, in a new file.
import { renderScanBar } from "../components/scan-bar.js";
import { emptyState } from "../components/empty-state.js";
import { lookupByCode } from "../data/barcode-lookup.js";
import { receiveStock, getLocations } from "../data/inventory-admin.js";
import { recordReceiptCost } from "../data/landed-cost.js";
import { getPickProgress, scanPickItem, undoPickItem } from "../data/picking.js";
import { advanceOrderStatus } from "../data/wholesaler-orders.js";

import { esc, pageHeader } from "../lib/utils.js";
// ---------- Receive-scan ----------

async function receiveScanView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Scan to Receive", "Scan a barcode (or type the SKU), confirm the quantity, done."));

  const locations = await getLocations(wid);
  if (!locations.length) {
    outlet.appendChild(emptyState({ icon: "⚠️", title: "No location configured", body: "Add a location before receiving stock." }));
    return;
  }

  const locationSelect = document.createElement("select");
  locationSelect.className = "input";
  locationSelect.style.marginBottom = "12px";
  locationSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${esc(l.name)}${l.is_default ? " (default)" : ""}</option>`).join("");
  if (locations.length > 1) outlet.appendChild(locationSelect);

  const matchCard = document.createElement("div");
  matchCard.className = "card";
  matchCard.style.cssText = "padding:16px;margin-bottom:16px;display:none;";
  outlet.appendChild(matchCard);

  const log = document.createElement("div");
  log.className = "card";
  log.style.padding = "8px";
  const logHeader = document.createElement("div");
  logHeader.style.cssText = "font-size:12px;font-weight:650;padding:8px 12px;color:var(--text-tertiary);";
  logHeader.textContent = "Received this session";
  log.appendChild(logHeader);
  outlet.appendChild(log);

  function addLogLine(text, ok) {
    const row = document.createElement("div");
    row.style.cssText = `padding:8px 12px;border-top:1px solid var(--border-subtle);font-size:13px;color:${ok ? "var(--text-primary)" : "var(--danger-600,#b3261e)"};`;
    row.textContent = text;
    log.insertBefore(row, log.children[1] || null);
  }

  async function handleScan(code) {
    matchCard.style.display = "none";
    const match = await lookupByCode(wid, code);
    if (!match) { toast(`No SKU or barcode matches "${code}"`, { type: "danger" }); scanBar.refocus(); return; }

    matchCard.style.display = "block";
    matchCard.innerHTML = `
      <div style="font-weight:650;margin-bottom:4px;">${esc(match.productName)}</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">${esc(match.sku)}${match.barcode ? ` · barcode ${esc(match.barcode)}` : ""} · ${esc(match.color)}/${esc(match.size)} · ${match.totalOnHand} on hand now</div>
    `;
    const qtyInput = document.createElement("input");
    qtyInput.className = "input"; qtyInput.type = "number"; qtyInput.inputMode = "numeric"; qtyInput.min = "1"; qtyInput.value = "10";
    qtyInput.style.cssText = "font-size:18px;padding:12px;width:100%;margin-bottom:10px;";
    matchCard.appendChild(qtyInput);

    const landedToggle = document.createElement("details");
    landedToggle.innerHTML = `<summary style="font-size:12px;color:var(--text-tertiary);cursor:pointer;margin-bottom:8px;">+ landed cost (optional)</summary>`;
    const freightInput = document.createElement("input");
    freightInput.className = "input"; freightInput.type = "number"; freightInput.step = "0.01"; freightInput.placeholder = "Freight cost (total)"; freightInput.style.marginBottom = "6px";
    const dutyInput = document.createElement("input");
    dutyInput.className = "input"; dutyInput.type = "number"; dutyInput.step = "0.01"; dutyInput.placeholder = "Duty cost (total)"; dutyInput.style.marginBottom = "6px";
    const otherInput = document.createElement("input");
    otherInput.className = "input"; otherInput.type = "number"; otherInput.step = "0.01"; otherInput.placeholder = "Other cost (total)";
    landedToggle.appendChild(freightInput);
    landedToggle.appendChild(dutyInput);
    landedToggle.appendChild(otherInput);
    matchCard.appendChild(landedToggle);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn-primary";
    confirmBtn.style.cssText = "width:100%;font-size:16px;padding:14px;margin-top:10px;";
    confirmBtn.textContent = "Confirm receive";
    confirmBtn.addEventListener("click", async () => {
      const qty = parseInt(qtyInput.value, 10);
      if (!qty || qty <= 0) { toast("Enter a quantity", { type: "danger" }); return; }
      confirmBtn.disabled = true;
      const locationId = locationSelect.value || locations[0].id;
      const { error } = await receiveStock(match.variantId, locationId, qty, "Mobile scan receive");
      if (error) { toast("Receive failed", { type: "danger" }); confirmBtn.disabled = false; return; }

      const freight = parseFloat(freightInput.value) || 0;
      const duty = parseFloat(dutyInput.value) || 0;
      const other = parseFloat(otherInput.value) || 0;
      if (freight || duty || other) {
        await recordReceiptCost({ variantId: match.variantId, locationId, qty, baseCost: match.cost, freightCost: freight, dutyCost: duty, otherCost: other });
      }

      addLogLine(`+${qty} — ${match.sku} (${match.color}/${match.size})`, true);
      toast(`Received ${qty}x ${match.sku}`, { type: "success" });
      matchCard.style.display = "none";
      scanBar.refocus();
    });
    matchCard.appendChild(confirmBtn);
  }

  const scanBar = renderScanBar({ placeholder: "Scan barcode or type SKU, then Enter…", onSubmit: handleScan });
  outlet.insertBefore(scanBar.el, matchCard);
}

// ---------- Scan-to-pick ----------

async function pickView(outlet, params) {
  const orderId = params.orderId;
  const { data: order } = await sbCall(supabase.from("v2_orders").select("id, buyer_label, status, created_at").eq("id", orderId).maybeSingle());
  if (!order) {
    outlet.appendChild(emptyState({ icon: "⚠️", title: "Order not found", body: "This order doesn't exist or was removed." }));
    return;
  }

  outlet.appendChild(pageHeader(`Pick order — ${order.buyer_label}`, `Placed ${new Date(order.created_at).toLocaleString()} · status: ${order.status}`));

  const checklist = document.createElement("div");
  checklist.className = "card";
  checklist.style.padding = "8px";
  const shipBtn = document.createElement("button");
  shipBtn.className = "btn btn-primary";
  shipBtn.style.cssText = "width:100%;font-size:16px;padding:14px;margin-top:14px;";
  shipBtn.textContent = "Mark fully picked & shipped";

  let items = [];

  function renderChecklist() {
    checklist.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid var(--border-subtle);${it.complete ? "background:var(--success-50,#f0f9f2);" : ""}`;
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;">${it.complete ? "✅ " : ""}${esc(it.productName)} <span style="color:var(--text-tertiary);font-weight:400;">${esc(it.color)}/${esc(it.size)}</span></div>
          <div style="font-size:12px;color:var(--text-tertiary);">${esc(it.sku)}${it.barcode ? ` · ${esc(it.barcode)}` : ""}</div>
        </div>
        <div style="font-weight:700;font-size:15px;">${it.pickedQty} / ${it.expectedQty}</div>
      `;
      if (it.pickedQty > 0) {
        const undoBtn = document.createElement("button");
        undoBtn.className = "btn btn-ghost btn-sm";
        undoBtn.textContent = "Undo";
        undoBtn.addEventListener("click", async () => {
          const result = await undoPickItem(orderId, it.barcode || it.sku);
          if (!result.ok) { toast(result.error?.message || "Undo failed", { type: "danger" }); return; }
          await refresh();
        });
        row.appendChild(undoBtn);
      }
      checklist.appendChild(row);
    });

    const allComplete = items.length > 0 && items.every((it) => it.complete);
    shipBtn.disabled = !allComplete || order.status === "shipped" || order.status === "delivered";
    shipBtn.textContent = order.status === "shipped" || order.status === "delivered"
      ? `Already ${order.status}`
      : allComplete ? "Mark fully picked & shipped" : `Scan remaining items to enable shipping (${items.filter((i) => !i.complete).length} SKU(s) left)`;
  }

  async function refresh() {
    items = await getPickProgress(orderId);
    renderChecklist();
  }

  async function handleScan(code) {
    const result = await scanPickItem(orderId, code);
    if (!result.ok) { toast(result.error?.message || `Scan failed for "${code}"`, { type: "danger" }); scanBar.refocus(); return; }
    await refresh();
    scanBar.refocus();
  }

  const scanBar = renderScanBar({ placeholder: "Scan barcode or type SKU to pick one unit…", onSubmit: handleScan });
  outlet.appendChild(scanBar.el);
  outlet.appendChild(checklist);
  outlet.appendChild(shipBtn);

  shipBtn.addEventListener("click", async () => {
    shipBtn.disabled = true;
    const { error } = await advanceOrderStatus(orderId, "shipped");
    if (error) { toast("Failed to mark shipped", { type: "danger" }); shipBtn.disabled = false; return; }
    toast("Order marked shipped", { type: "success" });
    window.location.hash = "#/wholesaler/orders";
  });

  await refresh();
}

export function registerMobileOpsRoutes(router) {
  router.register("/wholesaler/receive-scan", (outlet) => receiveScanView(outlet));
  router.register("/wholesaler/pick/:orderId", (outlet, params) => pickView(outlet, params));
}
