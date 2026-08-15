// OGGI Wholesale v2 — catalog migration/onboarding import screen (Batch 11)
// Two entry paths (CSV upload/paste, and AI-assisted photo/PDF) feeding ONE
// shared preview → review → commit pipeline, so a wholesaler always sees
// exactly what will happen to their catalog before anything is written.

import { devAuth } from "../lib/dev-auth.js";
import { toast } from "../components/toast.js";
import { parseCsv, planImport, commitImport } from "../data/csv-import.js";
import { extractCatalogFromImage } from "../data/ai-catalog-import.js";
import { getLocations } from "../data/inventory-admin.js";

import { esc, pageHeader } from "../lib/utils.js";
const ACTION_LABEL = {
  create_product: { text: "New product", cls: "badge-success" },
  add_variant: { text: "New variant → existing product", cls: "badge-info" },
  update_variant: { text: "Update existing SKU", cls: "badge-warning" },
  error: { text: "Error", cls: "badge-danger" },
};

/** Shared preview table + commit button, used by both the CSV and
 * AI-photo paths once either has produced a `planned` result. */
function renderPreview({ wid, defaultLocationId, planned, container, onCommitted }) {
  container.innerHTML = "";

  const summaryLine = document.createElement("div");
  summaryLine.style.cssText = "font-size:13px;margin-bottom:10px;";
  summaryLine.innerHTML = `${planned.summary.total} row(s): <strong>${planned.summary.createProduct}</strong> new product${planned.summary.createProduct === 1 ? "" : "s"}, <strong>${planned.summary.addVariant}</strong> new variant${planned.summary.addVariant === 1 ? "" : "s"} on existing products, <strong>${planned.summary.updateVariant}</strong> existing SKU${planned.summary.updateVariant === 1 ? "" : "s"} to update, ${planned.summary.errors ? `<strong style="color:var(--danger-600,#b3261e);">${planned.summary.errors} error(s)</strong>` : "0 errors"}.`;
  container.appendChild(summaryLine);

  const table = document.createElement("div");
  table.className = "card";
  table.style.padding = "8px";
  table.style.maxHeight = "360px";
  table.style.overflowY = "auto";
  planned.rows.forEach((r) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:12px;";
    const label = ACTION_LABEL[r.action];
    row.innerHTML = `
      <div style="width:30px;color:var(--text-tertiary);">#${r.rowNumber}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${esc(r.productName || "(missing name)")} <span style="color:var(--text-tertiary);font-weight:400;">${esc(r.sku)} · ${esc(r.color)}/${esc(r.size)}</span></div>
        ${r.errors.length ? `<div style="color:var(--danger-600,#b3261e);">${esc(r.errors.join("; "))}</div>` : `<div style="color:var(--text-tertiary);">${r.price != null ? "$" + r.price.toFixed(2) : ""}${r.onHandQty ? ` · ${r.onHandQty} units to receive` : ""}</div>`}
      </div>
      <span class="badge ${label.cls}">${label.text}</span>
    `;
    table.appendChild(row);
  });
  container.appendChild(table);

  const commitBtn = document.createElement("button");
  commitBtn.className = "btn btn-primary";
  commitBtn.style.marginTop = "12px";
  const validCount = planned.rows.filter((r) => r.action !== "error").length;
  commitBtn.textContent = `Commit ${validCount} row(s)`;
  commitBtn.disabled = validCount === 0;
  commitBtn.addEventListener("click", async () => {
    commitBtn.disabled = true;
    commitBtn.textContent = "Importing…";
    const results = await commitImport(wid, planned.rows, defaultLocationId);
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    toast(`Import complete — ${okCount} succeeded${failCount ? `, ${failCount} failed` : ""}`, { type: failCount ? "danger" : "success" });

    container.innerHTML = "";
    results.forEach((r) => {
      const row = document.createElement("div");
      row.style.cssText = `padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-subtle);color:${r.ok ? "var(--text-primary)" : "var(--danger-600,#b3261e)"};`;
      row.textContent = `#${r.rowNumber} ${r.sku}: ${r.ok ? (r.note || "OK") : r.error}`;
      container.appendChild(row);
    });
    if (onCommitted) onCommitted();
  });
  container.appendChild(commitBtn);
}

async function importCatalogView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Import Catalog", "Bulk-load or update your catalog from a spreadsheet, or extract one from a photo/PDF."));

  const locations = await getLocations(wid);
  const defaultLocation = locations.find((l) => l.is_default) || locations[0];

  // ---------- CSV section ----------
  const csvSection = document.createElement("div");
  csvSection.className = "card";
  csvSection.style.cssText = "padding:16px;margin-bottom:16px;";
  csvSection.innerHTML = `
    <h4 style="margin-bottom:4px;">Import from CSV</h4>
    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">
      Required columns: <code>product_name, sku, color, size, price</code>. Optional: <code>cost, retail_price, moq_qty, barcode, on_hand_qty</code>.
      Export your spreadsheet as CSV first if it's currently .xlsx — every spreadsheet tool supports "Save as CSV".
      An existing SKU updates its price/cost/MOQ/retail/barcode only — stock is never changed on re-import, only on a brand-new SKU (via <code>on_hand_qty</code>).
    </div>
  `;
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,text/csv";
  fileInput.style.marginBottom = "8px";
  const csvTextarea = document.createElement("textarea");
  csvTextarea.className = "input";
  csvTextarea.rows = 6;
  csvTextarea.placeholder = "…or paste CSV text directly here\nproduct_name,sku,color,size,price\nDenim Jacket,DJ-001-Blue-M,Blue,M,45.00";
  csvTextarea.style.marginBottom = "8px";
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    csvTextarea.value = await file.text();
  });
  const parseBtn = document.createElement("button");
  parseBtn.className = "btn btn-secondary btn-sm";
  parseBtn.textContent = "Preview import";
  const csvPreviewContainer = document.createElement("div");
  csvPreviewContainer.style.marginTop = "12px";
  parseBtn.addEventListener("click", async () => {
    const parsed = parseCsv(csvTextarea.value);
    if (!parsed.rows.length) { toast("No rows found — check the CSV has a header row and at least one data row", { type: "danger" }); return; }
    const planned = await planImport(wid, parsed);
    if (!planned.ok) { toast(planned.error, { type: "danger" }); return; }
    renderPreview({ wid, defaultLocationId: defaultLocation?.id, planned, container: csvPreviewContainer });
  });
  csvSection.appendChild(fileInput);
  csvSection.appendChild(csvTextarea);
  csvSection.appendChild(parseBtn);
  csvSection.appendChild(csvPreviewContainer);
  outlet.appendChild(csvSection);

  // ---------- AI photo/PDF section ----------
  const aiSection = document.createElement("div");
  aiSection.className = "card";
  aiSection.style.cssText = "padding:16px;";
  aiSection.innerHTML = `
    <h4 style="margin-bottom:4px;">Import from a photo or PDF (AI-assisted)</h4>
    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">
      Upload a photo of a price list or a PDF catalog page. The same preview/review step below applies before anything is written — nothing is imported automatically.
    </div>
  `;
  const aiFileInput = document.createElement("input");
  aiFileInput.type = "file";
  aiFileInput.accept = "image/*,application/pdf";
  const aiExtractBtn = document.createElement("button");
  aiExtractBtn.className = "btn btn-secondary btn-sm";
  aiExtractBtn.textContent = "Extract with AI";
  aiExtractBtn.style.marginLeft = "10px";
  const aiPreviewContainer = document.createElement("div");
  aiPreviewContainer.style.marginTop = "12px";
  aiExtractBtn.addEventListener("click", async () => {
    const file = aiFileInput.files[0];
    if (!file) { toast("Choose a photo or PDF first", { type: "danger" }); return; }
    aiExtractBtn.disabled = true;
    aiExtractBtn.textContent = "Extracting…";
    const result = await extractCatalogFromImage(file);
    aiExtractBtn.disabled = false;
    aiExtractBtn.textContent = "Extract with AI";
    if (!result.ok) {
      aiPreviewContainer.innerHTML = `<div class="card" style="padding:14px;font-size:13px;color:var(--warning-600,#a15c00);">${esc(result.message)}</div>`;
      return;
    }
    if (!result.rows.length) {
      aiPreviewContainer.innerHTML = `<div class="card" style="padding:14px;font-size:13px;color:var(--text-tertiary);">No products could be read from that file — try a clearer photo, or use CSV import above.</div>`;
      return;
    }
    const planned = await planImport(wid, { headers: result.headers, rows: result.rows });
    if (!planned.ok) { toast(planned.error, { type: "danger" }); return; }
    renderPreview({ wid, defaultLocationId: defaultLocation?.id, planned, container: aiPreviewContainer });
  });
  aiSection.appendChild(aiFileInput);
  aiSection.appendChild(aiExtractBtn);
  aiSection.appendChild(aiPreviewContainer);
  outlet.appendChild(aiSection);
}

export function registerImportRoutes(router) {
  router.register("/wholesaler/import", (outlet) => importCatalogView(outlet));
}
