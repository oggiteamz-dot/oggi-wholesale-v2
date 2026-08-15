// OGGI Wholesale v2 — CSV/spreadsheet catalog importer with duplicate
// detection (Batch 11)
//
// Row schema (CSV headers, case-insensitive, order-independent):
//   product_name, sku, color, size, price   -- required
//   cost, compare_at_price/retail_price, moq_qty, barcode, on_hand_qty  -- optional
//
// True binary .xlsx parsing isn't done here (see the Batch 11 deploy record
// for why) -- a wholesaler exports/saves their spreadsheet as CSV first,
// which every spreadsheet tool supports natively. The parser below is a
// real quoted-field-aware CSV parser (handles commas and newlines inside
// quoted values, and "" as an escaped quote), not a naive .split(',').
//
// This same row shape is also what js/data/ai-catalog-import.js normalizes
// AI-extracted rows into, so both import paths share ONE preview/dedupe/
// commit pipeline below rather than two parallel ones.

import { supabase, sbCall } from "../lib/supabase-client.js";

const REQUIRED_HEADERS = ["product_name", "sku", "color", "size", "price"];

/** Real CSV parsing -- quoted fields (with embedded commas/newlines) and
 * doubled-quote escaping are handled properly, not just a comma split.
 * Returns { headers: string[], rows: object[] } with rows keyed by
 * lowercased header. */
export function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) pushRow();

  const raw = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!raw.length) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => h.trim().toLowerCase());
  const dataRows = raw.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
  return { headers, rows: dataRows };
}

function normalizeRow(raw) {
  return {
    productName: (raw.product_name || "").trim(),
    sku: (raw.sku || "").trim(),
    color: (raw.color || "").trim(),
    size: (raw.size || "").trim(),
    price: raw.price === "" || raw.price == null ? null : Number(raw.price),
    cost: raw.cost === "" || raw.cost == null ? null : Number(raw.cost),
    retailPrice: raw.retail_price ?? raw.compare_at_price,
    moqQty: raw.moq_qty === "" || raw.moq_qty == null ? null : parseInt(raw.moq_qty, 10),
    barcode: (raw.barcode || "").trim() || null,
    onHandQty: raw.on_hand_qty === "" || raw.on_hand_qty == null ? 0 : parseInt(raw.on_hand_qty, 10),
  };
}

/** Validates every row, checks required-header presence, and plans each
 * row's action against BOTH the file's own rows (in-file duplicate SKUs)
 * AND the wholesaler's real existing catalog (existing SKU -> update;
 * existing product name, new SKU -> add variant to that product; brand new
 * product name -> create product). Nothing is written yet -- this is the
 * preview the wholesaler reviews before committing. */
export async function planImport(wid, parsed) {
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !parsed.headers.includes(h));
  if (missingHeaders.length) {
    return { ok: false, error: `Missing required column(s): ${missingHeaders.join(", ")}` };
  }

  const { data: existingProducts } = await sbCall(supabase.from("v2_products").select("id, name").eq("wid", wid));
  const { data: existingVariants } = await sbCall(
    supabase.from("v2_product_variants").select("id, sku, product_id").in("product_id", (existingProducts || []).map((p) => p.id).length ? (existingProducts || []).map((p) => p.id) : ["00000000-0000-0000-0000-000000000000"])
  );
  const productByNameLower = new Map((existingProducts || []).map((p) => [p.name.trim().toLowerCase(), p]));
  // Scoped to THIS wholesaler's own variants only (existingVariants was
  // already queried against this wid's own product ids above) -- but sku
  // strings aren't guaranteed globally unique across every wholesaler on
  // the platform, so the resolved variant's real id (not the sku string)
  // is what commitImport uses to target its update, never a bare
  // `.eq("sku", ...)` that could theoretically also match another
  // wholesaler's row sharing the same sku text.
  const variantBySku = new Map((existingVariants || []).map((v) => [v.sku, v]));

  const seenSkusInFile = new Set();
  const newProductNamesSeenInFile = new Set();

  const planned = parsed.rows.map((raw, idx) => {
    const row = normalizeRow(raw);
    const errors = [];
    if (!row.productName) errors.push("Missing product_name");
    if (!row.sku) errors.push("Missing sku");
    if (!row.color) errors.push("Missing color");
    if (!row.size) errors.push("Missing size");
    if (row.price == null || isNaN(row.price) || row.price < 0) errors.push("Missing or invalid price");
    if (row.sku && seenSkusInFile.has(row.sku)) errors.push(`Duplicate sku "${row.sku}" elsewhere in this file`);
    if (row.sku) seenSkusInFile.add(row.sku);

    let action = "create_product";
    let existingProductId = null;
    let existingVariantId = null;
    if (row.sku && variantBySku.has(row.sku)) {
      action = "update_variant";
      existingProductId = variantBySku.get(row.sku).product_id;
      existingVariantId = variantBySku.get(row.sku).id;
    } else if (row.productName && productByNameLower.has(row.productName.trim().toLowerCase())) {
      action = "add_variant";
      existingProductId = productByNameLower.get(row.productName.trim().toLowerCase()).id;
    } else if (row.productName && newProductNamesSeenInFile.has(row.productName.trim().toLowerCase())) {
      action = "add_variant"; // a product this file itself is about to create, on an earlier row
    } else if (row.productName) {
      newProductNamesSeenInFile.add(row.productName.trim().toLowerCase());
    }

    return { rowNumber: idx + 2, ...row, action: errors.length ? "error" : action, existingProductId, existingVariantId, errors };
  });

  const summary = {
    total: planned.length,
    createProduct: planned.filter((r) => r.action === "create_product").length,
    addVariant: planned.filter((r) => r.action === "add_variant").length,
    updateVariant: planned.filter((r) => r.action === "update_variant").length,
    errors: planned.filter((r) => r.action === "error").length,
  };
  return { ok: true, rows: planned, summary };
}

/** Executes a plan produced by planImport. New products are created once
 * per distinct new product_name (in file order), then every row's variant
 * is created/updated. `on_hand_qty` is ONLY ever applied as an initial
 * stock receive for a BRAND NEW variant -- re-importing an existing SKU
 * never touches its stock, deliberately, to avoid silently double-counting
 * inventory on a re-run of the same file (the real risk with any importer
 * that also tried to "sync" stock levels). Returns one result per row. */
export async function commitImport(wid, plannedRows, defaultLocationId) {
  const results = [];
  const newProductIdByName = new Map();

  for (const row of plannedRows) {
    if (row.action === "error") { results.push({ ...row, ok: false, error: row.errors.join("; ") }); continue; }

    try {
      let productId = row.existingProductId;
      if (!productId) {
        const nameKey = row.productName.trim().toLowerCase();
        if (newProductIdByName.has(nameKey)) {
          productId = newProductIdByName.get(nameKey);
        } else {
          const { data: newProduct, error } = await sbCall(
            supabase.from("v2_products").insert({ wid, name: row.productName }).select().single()
          );
          if (error || !newProduct) throw new Error(error?.message || "Failed to create product");
          productId = newProduct.id;
          newProductIdByName.set(nameKey, productId);
        }
      }

      if (row.action === "update_variant") {
        const patch = { price: row.price, updated_at: new Date().toISOString() };
        if (row.cost != null) patch.cost = row.cost;
        if (row.retailPrice != null && row.retailPrice !== "") patch.retail_price = Number(row.retailPrice);
        if (row.moqQty != null) patch.moq_qty = row.moqQty;
        if (row.barcode) patch.barcode = row.barcode;
        const { error } = await sbCall(supabase.from("v2_product_variants").update(patch).eq("id", row.existingVariantId));
        if (error) throw new Error(error.message);
        results.push({ ...row, ok: true, note: "Updated existing SKU's price/cost/MOQ/retail/barcode — stock was NOT changed." });
        continue;
      }

      const { data: newVariant, error } = await sbCall(
        supabase.from("v2_product_variants").insert({
          product_id: productId, sku: row.sku, price: row.price, cost: row.cost,
          retail_price: row.retailPrice != null && row.retailPrice !== "" ? Number(row.retailPrice) : null,
          moq_qty: row.moqQty || 1, barcode: row.barcode,
          // Do NOT hardcode the selling model here. Until 15 Aug 2026 this
          // said sellMode: "open", so every CSV import silently overwrote
          // whatever the wholesaler had set -- a catalogue sold in ratio packs
          // came back as loose open stock with nothing reporting the change.
          // The selling model belongs to the PRODUCT (v2_products.selling_model,
          // migrations 029/030), not to each variant, so a variant import must
          // not express an opinion about it at all.
          extra_attrs: { color: row.color, size: row.size },
        }).select().single()
      );
      if (error || !newVariant) throw new Error(error?.message || "Failed to create variant");

      if (row.onHandQty > 0 && defaultLocationId) {
        await sbCall(supabase.rpc("v2_receive_stock", {
          p_variant_id: newVariant.id, p_location_id: defaultLocationId, p_qty: row.onHandQty,
          p_reference_type: "catalog_import", p_reference_id: null, p_actor_id: null,
          p_note: "Initial stock from catalog import",
        }));
      }
      results.push({ ...row, ok: true, note: row.onHandQty > 0 ? `Created with ${row.onHandQty} units received` : "Created (0 stock — receive stock separately)" });
    } catch (err) {
      results.push({ ...row, ok: false, error: err.message || String(err) });
    }
  }

  return results;
}
