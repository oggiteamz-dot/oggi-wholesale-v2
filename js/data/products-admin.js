// OGGI Wholesale v2 — wholesaler product management (Batch 3)
import { supabase, sbCall } from "../lib/supabase-client.js";
import { imagesForVariants } from "../components/image-gallery.js";
import { getDefaultCatalog, addProductToCatalog } from "./catalogs.js";
import { uploadProductImage } from "./uploads.js";

export async function listProductsForAdmin(wid) {
  const { data: products } = await sbCall(
    supabase.from("v2_products").select("*").eq("wid", wid).order("created_at", { ascending: false })
  );
  if (!products || !products.length) return [];

  const productIds = products.map((p) => p.id);
  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("*").in("product_id", productIds)
  );
  const variantIds = (variants || []).map((v) => v.id);

  let balances = [];
  if (variantIds.length) {
    const { data } = await sbCall(supabase.from("v2_inventory_by_variant").select("*").in("variant_id", variantIds));
    balances = data || [];
  }
  const balByVariant = new Map(balances.map((b) => [b.variant_id, b]));

  const variantsByProduct = new Map();
  (variants || []).forEach((v) => {
    const list = variantsByProduct.get(v.product_id) || [];
    const bal = balByVariant.get(v.id);
    list.push({ ...v, onHand: bal ? Number(bal.total_on_hand) : 0, available: bal ? Number(bal.total_available) : 0 });
    variantsByProduct.set(v.product_id, list);
  });

  return products.map((p) => {
    const vs = variantsByProduct.get(p.id) || [];
    return {
      ...p,
      variants: vs,
      totalOnHand: vs.reduce((s, v) => s + v.onHand, 0),
      variantCount: vs.length,
      priceRange: vs.length ? [Math.min(...vs.map((v) => Number(v.price) || 0)), Math.max(...vs.map((v) => Number(v.price) || 0))] : [0, 0],
      // Batch 18: the distinct photos across this product's variants, so the
      // Products list can show the garment instead of only naming it.
      images: imagesForVariants(vs),
    };
  });
}

export async function toggleArchived(productId, archived) {
  return sbCall(supabase.from("v2_products").update({ archived, updated_at: new Date().toISOString() }).eq("id", productId));
}

/** Bulk price update: applies a percentage delta to every variant of the
 * given products (e.g. +10 for a 10% increase, -15 for a 15% markdown). */
export async function bulkUpdatePrice(variantIds, percentDelta) {
  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("id, price").in("id", variantIds)
  );
  if (!variants) return { ok: false };
  const updates = variants.map((v) => ({
    id: v.id,
    price: Math.round(Number(v.price) * (1 + percentDelta / 100) * 100) / 100,
  }));
  for (const u of updates) {
    await sbCall(supabase.from("v2_product_variants").update({ price: u.price, updated_at: new Date().toISOString() }).eq("id", u.id));
  }
  return { ok: true, count: updates.length };
}

/** Duplicate-as-template: clones a product's full shell -- name (suffixed
 * " (copy)"), options, option values, AND variants (so the copy is
 * immediately sellable once unarchived, not an empty shell the wholesaler
 * has to rebuild by hand) -- but never copies stock. Every cloned variant
 * starts with no v2_inventory_balances row at all (not a zero row, no row)
 * so it reads as genuinely un-stocked rather than silently fabricating
 * inventory that was never actually received. */
export async function duplicateAsTemplate(productId) {
  const { data: product } = await sbCall(supabase.from("v2_products").select("*").eq("id", productId).maybeSingle());
  if (!product) return { ok: false };

  const { data: newProduct, error: pErr } = await sbCall(
    supabase.from("v2_products").insert({
      wid: product.wid, name: `${product.name} (copy)`, description: product.description, category: product.category, archived: true,
    }).select().single()
  );
  if (pErr || !newProduct) return { ok: false };

  // Copy options + option values, keeping an old-value-id -> new-value-id
  // map so variant_option_values can be remapped below.
  const { data: options } = await sbCall(supabase.from("v2_product_options").select("*").eq("product_id", productId));
  const valueIdMap = new Map();
  for (const opt of options || []) {
    const { data: newOpt } = await sbCall(
      supabase.from("v2_product_options").insert({ product_id: newProduct.id, name: opt.name, position: opt.position }).select().single()
    );
    const { data: values } = await sbCall(supabase.from("v2_product_option_values").select("*").eq("option_id", opt.id));
    for (const val of values || []) {
      const { data: newVal } = await sbCall(
        supabase.from("v2_product_option_values").insert({ option_id: newOpt.id, value: val.value, position: val.position }).select().single()
      );
      if (newVal) valueIdMap.set(val.id, newVal.id);
    }
  }

  // Copy variants (sku suffixed to stay unique) + their option-value links,
  // remapped through valueIdMap. No inventory_balances row is created --
  // the variant simply has zero stock until someone receives it for real.
  const { data: variants } = await sbCall(supabase.from("v2_product_variants").select("*").eq("product_id", productId));
  for (const v of variants || []) {
    const { data: newVariant } = await sbCall(
      supabase.from("v2_product_variants").insert({
        product_id: newProduct.id, sku: `${v.sku}-COPY`, price: v.price, cost: v.cost,
        compare_at_price: v.compare_at_price, extra_attrs: v.extra_attrs, archived: false,
      }).select().single()
    );
    if (!newVariant) continue;
    const { data: linkRows } = await sbCall(supabase.from("v2_product_variant_option_values").select("option_value_id").eq("variant_id", v.id));
    for (const link of linkRows || []) {
      const newValueId = valueIdMap.get(link.option_value_id);
      if (newValueId) {
        await sbCall(supabase.from("v2_product_variant_option_values").insert({ variant_id: newVariant.id, option_value_id: newValueId }));
      }
    }
  }

  return { ok: true, productId: newProduct.id };
}

// =============================================================================
// CREATING A PRODUCT
// =============================================================================
// Added 18 Aug 2026. Until this function existed, THE ONLY WAY TO CREATE A
// PRODUCT IN THE ENTIRE APPLICATION WAS THE CSV IMPORTER. Products could be
// archived, duplicated, repriced, have their MOQ and packs edited -- but there
// was no "New product" anywhere, in Products, in Inventory or anywhere else.
// A wholesaler with ten items to add had to build a spreadsheet.
//
// ONE FUNCTION, TWO ENTRY POINTS
// ------------------------------
// The catalog builder and the Inventory screen both call THIS. They differ by
// one argument -- whether a catalog id comes along -- and nothing else.
//
// That is deliberate and it is worth being blunt about why. This codebase
// already carries the HTML-escape helper in ten copies under four names, and
// pageHeader in seven copies of which four render a page-actions slot and
// three do not. Two product-creation paths would drift the same way, and the
// drift would be silent: one would start setting colorHex and the other would
// not, or one would receive opening stock and the other would forget, and the
// only symptom would be "products I add from Inventory behave differently".
//
// WHAT IT GUARANTEES
// ------------------
//   * the product exists, with its variants
//   * every variant carries colour, size AND colorHex, so the buyer catalogue
//     renders a real swatch.
//
//     Be precise about this, because the first version of this comment was
//     wrong and said every v2 product rendered grey. It does not. The v1 data
//     migration set real hexes (#b23046, #2f6b4f and so on) and all 133
//     pre-existing variants carry one -- checked, rather than assumed, before
//     correcting this.
//
//     The real gap is narrower and still worth closing: the CSV IMPORTER
//     writes `extra_attrs: { color, size }` and no colorHex, so anything
//     imported by spreadsheet falls back to catalog.js's "#999" and does draw
//     grey. Products created here never do.
//   * opening stock, if any, is received through the v2_receive_stock RPC and
//     never by writing v2_inventory_balances directly. That rule is stated in
//     001_v2_inventory_core.sql's own header: balances are a ledger projection,
//     and writing one by hand desynchronises it from the movements that explain
//     it
//   * a variant with NO opening stock still appears in Inventory, because
//     getStockTable() now starts from variants rather than balances. So the
//     product is visible and receivable the moment it is created, without
//     inventing a zero-quantity balance row to make it show up
//   * the product is filed in a catalog -- the one passed, or the wholesaler's
//     default -- so it can never exist in no catalog and become unfindable
//
// IT IS NOT A TRANSACTION, AND THAT IS A KNOWN LIMITATION
// ------------------------------------------------------
// PostgREST gives one statement per request, so a product with three variants
// is five round trips. If the third variant fails, the product and the first
// two remain. Rather than pretend otherwise, the failure is reported honestly
// ("created, but 1 of 3 variants failed") and the product is left in place so
// the operator can fix the variant rather than lose the work. Making this
// atomic means a SECURITY DEFINER function taking the whole product as JSON,
// which is the right eventual answer and is noted here rather than half-done.
// =============================================================================

/**
 * @param {string} wid
 * @param {object} draft
 * @param {string} draft.name
 * @param {string} [draft.description]
 * @param {string} [draft.category]
 * @param {string} [draft.sellingModel]  one of open|prepack|series|ratio
 * @param {number} [draft.moqQty]
 * @param {Array}  draft.variants  [{ sku, color, colorHex, size, price, cost,
 *                                    retailPrice, moqQty, barcode, openingStock }]
 * @param {string} [draft.catalogId]     file it here; omit for the default
 * @param {string} [draft.locationId]    where opening stock lands
 */
export async function createProduct(wid, draft = {}) {
  const name = String(draft.name || "").trim();
  if (!name) return { ok: false, error: "Give the product a name." };

  const variants = (draft.variants || []).filter((v) => String(v.sku || "").trim());
  if (!variants.length) {
    return { ok: false, error: "A product needs at least one variant with a SKU." };
  }

  // (product_id, sku) is unique in the database. Catching it here means the
  // operator is told which SKU is repeated, rather than the first insert
  // succeeding and the second failing with a constraint name.
  const seen = new Set();
  for (const v of variants) {
    const sku = String(v.sku).trim().toLowerCase();
    if (seen.has(sku)) {
      return { ok: false, error: `SKU "${String(v.sku).trim()}" appears twice. Each variant needs its own.` };
    }
    seen.add(sku);
  }

  const model = draft.sellingModel || "open";
  if (!["open", "prepack", "series", "ratio"].includes(model)) {
    return { ok: false, error: `"${model}" is not a selling model this product can have.` };
  }

  const { data: product, error: pErr } = await sbCall(
    supabase.from("v2_products").insert({
      wid,
      name,
      description: draft.description?.trim() || null,
      category: draft.category?.trim() || null,
      selling_model: model,
      moq_qty: Math.max(1, Number(draft.moqQty) || 1),
      // Batch 17. Null when the wholesaler did not pick one -- sourcing is
      // optional and a product must never be blocked on it.
      supplier_id: draft.supplierId || null,
      // Batch 18, the coarsest barcode tier: one code for the whole style.
      barcode: String(draft.barcode || "").trim() || null,
    }).select("id, name").single()
  );
  if (pErr || !product) {
    return { ok: false, error: pErr?.message || "Could not create the product." };
  }

  // Colour-tier barcodes. After the product row exists, because they hang off
  // its id. Failures are collected rather than thrown: a barcode clash must
  // not destroy a product the wholesaler has spent ten minutes building, and
  // the message names which code so they can fix it and re-save.
  const barcodeProblems = [];
  const colourBarcodes = (draft.colourBarcodes || []).filter((cb) => cb.color && cb.barcode);
  if (colourBarcodes.length) {
    const { error: cbErr } = await sbCall(
      supabase.from("v2_product_colour_barcodes").insert(
        colourBarcodes.map((cb) => ({ product_id: product.id, color: cb.color, barcode: cb.barcode }))
      )
    );
    if (cbErr) {
      barcodeProblems.push(
        cbErr.code === "23505"
          ? "One of the colour barcodes is already used on another product. The product was created; add the colour barcodes again once the clash is fixed."
          : `Colour barcodes could not be saved: ${cbErr.message}`
      );
    }
  }

  const created = [];
  const failed = [];

  for (const v of variants) {
    const { data: variant, error: vErr } = await sbCall(
      supabase.from("v2_product_variants").insert({
        product_id: product.id,
        sku: String(v.sku).trim(),
        price: v.price === "" || v.price == null ? null : Number(v.price),
        cost: v.cost === "" || v.cost == null ? null : Number(v.cost),
        retail_price: v.retailPrice === "" || v.retailPrice == null ? null : Number(v.retailPrice),
        moq_qty: Math.max(1, Number(v.moqQty) || 1),
        barcode: String(v.barcode || "").trim() || null,
        // colorHex lives in extra_attrs beside colour and size because that is
        // where catalog.js already reads all three from -- real columns would
        // mean migrating every existing variant for no gain a buyer can see.
        // Setting it here is what keeps hand-created products out of the
        // grey-swatch fallback the CSV importer still lands in.
        extra_attrs: {
          color: String(v.color || "").trim() || null,
          size: String(v.size || "").trim() || null,
          colorHex: String(v.colorHex || "").trim() || null,
        },
      }).select("id, sku").single()
    );

    if (vErr || !variant) {
      failed.push({ sku: v.sku, error: vErr?.message || "insert failed" });
      continue;
    }
    created.push(variant);

    const opening = Number(v.openingStock) || 0;
    if (opening > 0 && draft.locationId) {
      // Through the RPC, never a direct balance write. See the header.
      const { error: sErr } = await sbCall(supabase.rpc("v2_receive_stock", {
        p_variant_id: variant.id,
        p_location_id: draft.locationId,
        p_qty: opening,
        p_reference_type: "product_created",
        p_reference_id: null,
        p_actor_id: null,
        p_note: `Opening stock for ${name} (${variant.sku})`,
      }));
      if (sErr) failed.push({ sku: v.sku, error: `created, but opening stock failed: ${sErr.message}` });
    }
  }

  // ---- photos ----------------------------------------------------------
  // Uploaded HERE rather than in the form, because uploadProductImage() needs
  // a product id and the product does not exist while someone is still
  // choosing colours. They are held as Files in the browser until this point,
  // which also makes the eyedropper instant -- it samples a local bitmap.
  //
  // Every image goes on every variant. `images` is the gallery a buyer swipes;
  // `image_url` is the hero. v1 attached one photo per COLOUR, which is the
  // better end state -- noted rather than half-built, since it needs the form
  // to record which upload each colour sampled from and that mapping only
  // exists client-side today.
  //
  // A failed upload does NOT fail the product. The product and its variants
  // are already real by this point, and throwing them away because a photo
  // did not reach storage would be the worst possible trade.
  const imageUrls = [];
  const photoErrors = [];
  const photos = Array.isArray(draft.photos) ? draft.photos : [];
  for (let i = 0; i < photos.length; i++) {
    draft.onProgress?.(`Uploading photo ${i + 1} of ${photos.length}…`);
    const up = await uploadProductImage({ file: photos[i], wid, productId: product.id });
    if (up?.ok && up.url) imageUrls.push(up.url);
    else photoErrors.push(up?.error || `photo ${i + 1} failed`);
  }

  if (imageUrls.length && created.length) {
    const { error: imgErr } = await sbCall(
      supabase.from("v2_product_variants")
        .update({ images: imageUrls, image_url: imageUrls[0], updated_at: new Date().toISOString() })
        .in("id", created.map((v) => v.id))
    );
    if (imgErr) photoErrors.push(`photos uploaded but not attached: ${imgErr.message}`);
  }

  // File it. A product in no catalog is a product nobody can find.
  //
  // The result is CHECKED. It was not, originally, and the cost of that was
  // immediate: a grant problem meant the filing silently failed, so a product
  // created in the catalog builder was created, stocked, shown in Inventory --
  // and absent from the catalog it had just been made in. Everything looked
  // like it worked apart from the one screen the operator was standing on.
  //
  // Swallowing the return value of a call that can fail is how a bug becomes
  // a mystery. If filing fails now, the operator is told, and told that the
  // product itself is fine.
  let filedIn = null;
  let fileError = null;
  const catalogId = draft.catalogId
    || (await getDefaultCatalog(wid).catch(() => null))?.id
    || null;
  if (catalogId) {
    const res = await addProductToCatalog(catalogId, product.id);
    if (res.ok) filedIn = catalogId;
    else fileError = res.error;
  } else {
    fileError = "no catalog to file it in";
  }

  return {
    ok: true,
    productId: product.id,
    name: product.name,
    variantsCreated: created.length,
    variantsFailed: failed,
    filedIn,
    fileError,
    imageCount: imageUrls.length,
    photoErrors,
    barcodeProblems,
    // Deliberately not "Success!". The operator needs to know whether all of
    // it worked, and a partial result has to say so in the same breath.
    message: [
      failed.length
        ? `"${name}" created with ${created.length} of ${variants.length} variants — ${failed.length} had a problem.`
        : `"${name}" created with ${created.length} variant${created.length === 1 ? "" : "s"}.`,
      imageUrls.length ? `${imageUrls.length} photo${imageUrls.length === 1 ? "" : "s"} attached.` : "",
      photoErrors.length
        ? `${photoErrors.length} photo${photoErrors.length === 1 ? "" : "s"} did not upload — the product is fine, add them again from Products.`
        : "",
      barcodeProblems.length ? barcodeProblems.join(" ") : "",
      fileError
        ? `It is in Inventory, but could not be added to the catalog (${fileError}) — add it from the catalog screen.`
        : "",
    ].filter(Boolean).join(" "),
  };
}
