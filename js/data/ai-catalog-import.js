// OGGI Wholesale v2 — AI-assisted photo/PDF catalog import, frontend side
// (Batch 11)
// Calls the extract-catalog-from-image edge function and normalizes its
// response into the SAME row shape js/data/csv-import.js's planImport
// expects (the raw, lowercase-keyed shape planImport/parseCsv produces),
// so both import paths share one preview/dedupe/commit pipeline.

import { supabase } from "../lib/supabase-client.js";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data: URL ("data:image/png;base64,AAAA...") --
      // only the part after the comma is the actual base64 payload.
      const commaIdx = reader.result.indexOf(",");
      resolve(commaIdx >= 0 ? reader.result.slice(commaIdx + 1) : reader.result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Returns { ok:true, headers, rows } in the exact shape parseCsv() would
 * have produced (so planImport() works unmodified), or { ok:false, reason,
 * message } -- including the honest "not_configured" case when the
 * wholesaler hasn't added their own ANTHROPIC_API_KEY secret yet. Never
 * fabricates rows locally; every row shown to the wholesaler came from the
 * real edge function response. */
export async function extractCatalogFromImage(file) {
  const imageBase64 = await fileToBase64(file);
  const { data, error } = await supabase.functions.invoke("extract-catalog-from-image", {
    body: { imageBase64, mimeType: file.type || "image/jpeg" },
  });

  if (error) return { ok: false, reason: "network_error", message: error.message || "Could not reach the AI import service." };
  if (!data?.ok) return { ok: false, reason: data?.reason || "unknown", message: data?.message || "AI extraction failed." };

  const headers = ["product_name", "sku", "color", "size", "price", "cost", "moq_qty", "barcode"];
  const rows = (data.rows || []).map((r) => ({
    product_name: r.product_name ?? "",
    sku: r.sku ?? "",
    color: r.color ?? "",
    size: r.size ?? "",
    price: r.price == null ? "" : String(r.price),
    cost: r.cost == null ? "" : String(r.cost),
    moq_qty: r.moq_qty == null ? "" : String(r.moq_qty),
    barcode: r.barcode ?? "",
  }));
  return { ok: true, headers, rows };
}
