// OGGI Wholesale v2 — wholesaler product management (Batch 3)
import { supabase, sbCall } from "../lib/supabase-client.js";
import { imagesForVariants } from "../components/image-gallery.js";
import { getDefaultCatalog, addProductToCatalog } from "./catalogs.js";
import { uploadProductImage } from "./uploads.js";
import { getSupplier } from "./suppliers.js";

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

  // Batch 21: the card can now show supplier, cost and margin, so the list has
  // to carry them. One extra query for the supplier names rather than a join,
  // because v2_suppliers is under a column-level grant where select("*") is
  // refused outright -- see js/data/suppliers.js for the full reasoning.
  const supplierIds = [...new Set(products.map((p) => p.supplier_id).filter(Boolean))];
  const supplierName = new Map();
  if (supplierIds.length) {
    const { data: sups } = await sbCall(
      supabase.from("v2_suppliers").select("id, name").in("id", supplierIds)
    );
    (sups || []).forEach((s) => supplierName.set(s.id, s.name));
  }

  return products.map((p) => {
    const vs = variantsByProduct.get(p.id) || [];
    const costs = vs.map((v) => (v.cost == null ? null : Number(v.cost))).filter((c) => c != null);
    const prices = vs.map((v) => Number(v.price) || 0);
    // Margin from the AVERAGE of each, not the first variant: a product whose
    // sizes cost different amounts has one margin, and picking a variant at
    // random to represent it would make the number move when the sort changed.
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const avgPrice = avg(prices), avgCost = avg(costs);
    return {
      ...p,
      variants: vs,
      totalOnHand: vs.reduce((s, v) => s + v.onHand, 0),
      available: vs.reduce((s, v) => s + (v.available || 0), 0),
      onHand: vs.reduce((s, v) => s + v.onHand, 0),
      variantCount: vs.length,
      supplierName: supplierName.get(p.supplier_id) || null,
      costRange: costs.length ? [Math.min(...costs), Math.max(...costs)] : [null, null],
      marginPct: avgPrice && avgCost != null && avgPrice > 0
        ? ((avgPrice - avgCost) / avgPrice) * 100
        : null,
      priceRange: vs.length ? [Math.min(...prices), Math.max(...prices)] : [0, 0],
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
/**
 * RETIRED AS A CAPABILITY, KEPT AS A FUNCTION. Always refuses. (Batch 6)
 *
 * This did the bulk reprice in the browser: fetch N variants, then N sequential
 * UPDATEs. Everything about it was dangerous.
 *
 *   * It recorded nothing. The previous price was overwritten and stored
 *     nowhere, so there was no undo and no way to answer "what was this
 *     before". One mistyped percentage repriced a whole catalogue,
 *     permanently, with no confirmation step in front of it.
 *   * N round trips from a browser is not atomic. Close the laptop at variant
 *     30 of 64 and the catalogue is half repriced, with nothing anywhere
 *     recording which half.
 *   * It applied no archived filter, to products or to variants, so goods
 *     deliberately withdrawn from sale were repriced along with everything
 *     else.
 *
 * Replaced by js/data/pricing-bulk.js, which previews first, does the whole
 * change in one server-side statement, and writes v2_price_changes so it can
 * be undone (migration 078).
 *
 * It refuses rather than forwarding to the new path because the signatures
 * mean different things -- this one took a caller-chosen list of variant ids,
 * the new one takes a wid and derives the list on the server, which is what
 * makes the preview and the apply agree. Silently reinterpreting one as the
 * other would be a worse failure than a loud one. It is not deleted, so a
 * caller added later fails visibly here instead of failing to resolve and
 * getting "fixed" by someone pasting the old loop back in.
 */
export async function bulkUpdatePrice() {
  return {
    ok: false,
    error: "bulkUpdatePrice was retired in Batch 6 -- it could not be undone. Use applyBulkPrice() from js/data/pricing-bulk.js, which previews, runs atomically and records every old price.",
  };
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

/** Everything the edit form needs to reopen a product exactly as it stands:
 *  its own fields, every variant with colour/size/price/barcode, the colour
 *  barcode tier, and the photos. */
export async function getProductForEdit(productId) {
  const [{ data: product }, { data: variants }, { data: colourBarcodes }] = await Promise.all([
    sbCall(supabase.from("v2_products")
      .select("id, wid, name, description, category, selling_model, moq_qty, barcode, supplier_id, archived")
      .eq("id", productId).maybeSingle()),
    sbCall(supabase.from("v2_product_variants")
      .select("id, sku, price, cost, retail_price, moq_qty, barcode, extra_attrs, image_url, images, archived")
      .eq("product_id", productId)),
    sbCall(supabase.from("v2_product_colour_barcodes")
      .select("id, color, barcode").eq("product_id", productId)),
  ]);
  if (!product) return { ok: false, error: "That product no longer exists." };
  return { ok: true, product, variants: variants || [], colourBarcodes: colourBarcodes || [] };
}

/** How much history each variant carries, so the editor can tell the
 *  difference between "this was a typo, delete it" and "this has been sold".
 *  Returns a Map of variantId -> { onHand, ordered }. */
export async function variantUsage(variantIds) {
  const usage = new Map(variantIds.map((id) => [id, { onHand: 0, ordered: 0 }]));
  if (!variantIds.length) return usage;

  const [{ data: balances }, { data: lines }] = await Promise.all([
    sbCall(supabase.from("v2_inventory_balances").select("variant_id, qty_on_hand").in("variant_id", variantIds)),
    sbCall(supabase.from("v2_order_items").select("variant_id").in("variant_id", variantIds)),
  ]);
  (balances || []).forEach((b) => {
    const u = usage.get(b.variant_id);
    if (u) u.onHand += Number(b.qty_on_hand) || 0;
  });
  (lines || []).forEach((l) => {
    const u = usage.get(l.variant_id);
    if (u) u.ordered += 1;
  });
  return usage;
}

/**
 * Saves an edited product.
 *
 * The hard part is not the product row -- it is reconciling variants. A
 * wholesaler editing a product will rename a colour, add a size, fix a
 * barcode, and delete the size they typed by mistake, all in one sitting, and
 * the save has to tell those apart.
 *
 * Variants are matched by (colour, size), NOT by id, because that is the pair
 * the form actually edits and the pair a SKU is built from. Matching by id
 * would make "rename Crimson to Red" look like "delete Crimson, create Red",
 * which would throw away that variant's stock and its order history.
 *
 * A variant that disappears from the form is NEVER hard-deleted:
 *   - if it holds stock or appears on any order, the save is refused and says
 *     which one, because deleting it would silently corrupt what happened;
 *   - otherwise it is ARCHIVED, so it stops appearing without the row (and
 *     anything that may yet reference it) being destroyed.
 */
export async function updateProduct(productId, draft = {}) {
  const name = String(draft.name || "").trim();
  if (!name) return { ok: false, error: "Give the product a name." };

  const current = await getProductForEdit(productId);
  if (!current.ok) return current;

  const wanted = (draft.variants || []).filter((v) => String(v.sku || "").trim());
  if (!wanted.length) return { ok: false, error: "A product needs at least one variant." };

  const key = (color, size) =>
    `${String(color || "").trim().toLowerCase()}|${String(size || "").trim().toLowerCase()}`;

  const existingByKey = new Map(
    current.variants.map((v) => [key(v.extra_attrs?.color, v.extra_attrs?.size), v])
  );
  const wantedKeys = new Set(wanted.map((v) => key(v.color, v.size)));

  // ---- refuse to destroy history -------------------------------------
  const dropped = current.variants.filter(
    (v) => !v.archived && !wantedKeys.has(key(v.extra_attrs?.color, v.extra_attrs?.size))
  );
  if (dropped.length) {
    const usage = await variantUsage(dropped.map((v) => v.id));
    const blocked = dropped.filter((v) => {
      const u = usage.get(v.id);
      return u && (u.onHand > 0 || u.ordered > 0);
    });
    if (blocked.length) {
      const names = blocked
        .map((v) => `${v.extra_attrs?.color || "—"}/${v.extra_attrs?.size || "—"}`)
        .join(", ");
      return {
        ok: false,
        error: `Cannot remove ${names} — ${blocked.length === 1 ? "it has" : "they have"} stock on hand or ${blocked.length === 1 ? "appears" : "appear"} on an order. Move the stock out first, or leave the size in place; removing it would change what your past orders say they contained.`,
      };
    }
  }

  // ---- the product row ------------------------------------------------
  const model = draft.sellingModel || current.product.selling_model || "open";
  const { error: pErr } = await sbCall(
    supabase.from("v2_products").update({
      name,
      description: draft.description?.trim() || null,
      category: draft.category?.trim() || null,
      selling_model: model,
      moq_qty: Math.max(1, Number(draft.moqQty) || 1),
      supplier_id: draft.supplierId || null,
      barcode: String(draft.barcode || "").trim() || null,
      updated_at: new Date().toISOString(),
    }).eq("id", productId)
  );
  if (pErr) {
    return {
      ok: false,
      error: pErr.code === "23505"
        ? "That product barcode is already used on another product."
        : pErr.message,
    };
  }

  // ---- variants: update, insert, archive -------------------------------
  const updated = [], added = [], archived = [], failed = [];

  for (const v of wanted) {
    const existing = existingByKey.get(key(v.color, v.size));
    const payload = {
      sku: String(v.sku).trim(),
      price: v.price === "" || v.price == null ? null : Number(v.price),
      cost: v.cost === "" || v.cost == null ? null : Number(v.cost),
      retail_price: v.retailPrice === "" || v.retailPrice == null ? null : Number(v.retailPrice),
      moq_qty: Math.max(1, Number(v.moqQty) || 1),
      barcode: String(v.barcode || "").trim() || null,
      extra_attrs: {
        ...(existing?.extra_attrs || {}),
        color: String(v.color || "").trim() || null,
        size: String(v.size || "").trim() || null,
        colorHex: String(v.colorHex || "").trim() || null,
      },
      archived: false,          // re-adding a previously archived pair revives it
    };

    if (existing) {
      const { error } = await sbCall(
        supabase.from("v2_product_variants").update(payload).eq("id", existing.id)
      );
      if (error) failed.push({ sku: payload.sku, error: error.message });
      else updated.push(payload.sku);
    } else {
      const { error } = await sbCall(
        supabase.from("v2_product_variants").insert({ product_id: productId, ...payload })
      );
      if (error) failed.push({ sku: payload.sku, error: error.message });
      else added.push(payload.sku);
    }
  }

  for (const v of dropped) {
    const { error } = await sbCall(
      supabase.from("v2_product_variants").update({ archived: true }).eq("id", v.id)
    );
    if (!error) archived.push(`${v.extra_attrs?.color || "—"}/${v.extra_attrs?.size || "—"}`);
  }

  // ---- photos ----------------------------------------------------------
  // This was missing entirely, and it is the bug Hadi hit: the edit form let
  // him add a photo, delete one and press "Make main", said "saved", and threw
  // all of it away, because updateProduct only ever wrote the product row and
  // its variants.
  //
  // draft.photoStrip is the strip exactly as it is on screen, in order --
  // existing photos as { url }, newly picked ones as { file }. That shape is
  // what makes deletion and reordering expressible at all: a list of new files
  // cannot say "the second one is gone" or "these two swapped".
  //
  // Absent (an older caller, or the create path) means "photos not under
  // discussion", which must not be confused with an empty strip meaning
  // "remove every photo".
  let photoProblem = null;
  if (Array.isArray(draft.photoStrip)) {
    const urls = [];
    let failedPhotos = 0;
    for (const item of draft.photoStrip) {
      if (item?.url) { urls.push(item.url); continue; }
      if (!item?.file) continue;
      const up = await uploadProductImage({ file: item.file, wid: current.product.wid, productId });
      if (up?.ok && up.url) urls.push(up.url);
      else failedPhotos++;
    }

    // Every live variant carries the same gallery, the same way createProduct
    // attaches it -- `images` is what a buyer swipes, `image_url` is the hero
    // the cards and thumbnails read.
    const { error: imgErr } = await sbCall(
      supabase.from("v2_product_variants")
        .update({ images: urls, image_url: urls[0] || null, updated_at: new Date().toISOString() })
        .eq("product_id", productId).eq("archived", false)
    );
    if (imgErr) photoProblem = `Photos could not be attached: ${imgErr.message}`;
    else if (failedPhotos) {
      photoProblem = `${failedPhotos} photo${failedPhotos === 1 ? "" : "s"} did not upload — everything else saved.`;
    }
  }

  // ---- colour barcodes -------------------------------------------------
  // Replaced wholesale rather than diffed: there are at most a handful per
  // product, and a delete-then-insert cannot leave a stale colour behind when
  // a colour is renamed.
  const colourBarcodes = (draft.colourBarcodes || []).filter((cb) => cb.color && cb.barcode);
  await sbCall(supabase.from("v2_product_colour_barcodes").delete().eq("product_id", productId));
  let barcodeProblem = null;
  if (colourBarcodes.length) {
    const { error } = await sbCall(
      supabase.from("v2_product_colour_barcodes").insert(
        colourBarcodes.map((cb) => ({ product_id: productId, color: cb.color, barcode: cb.barcode }))
      )
    );
    if (error) {
      barcodeProblem = error.code === "23505"
        ? "One colour barcode is already used elsewhere, so the colour barcodes were not saved. Everything else was."
        : `Colour barcodes could not be saved: ${error.message}`;
    }
  }

  return {
    ok: true,
    productId,
    name,
    updated: updated.length,
    added: added.length,
    archived: archived.length,
    failed,
    message: [
      `"${name}" saved.`,
      added.length ? `${added.length} new variant${added.length === 1 ? "" : "s"}.` : "",
      archived.length ? `${archived.length} removed (${archived.join(", ")}) — archived, not deleted.` : "",
      failed.length ? `${failed.length} variant${failed.length === 1 ? "" : "s"} failed: ${failed[0].error}` : "",
      photoProblem || "",
      barcodeProblem || "",
    ].filter(Boolean).join(" "),
  };
}

/**
 * Everything a person needs to ANSWER A QUESTION about a product without
 * changing it.
 *
 * Hadi asked for "a button to essentially edit or a button to view or both",
 * and the two are not the same job. Edit is for when you already know what is
 * wrong. View is for "is this the right one?", "what did we pay?", "why is the
 * scanner not finding it?" -- and every one of those is answered by seeing the
 * data laid out, not by being dropped into a form where any stray keystroke is
 * a change you now have to undo. Opening a form to read something is how
 * accidental edits happen.
 *
 * So this returns the same object the editor loads, PLUS the three things the
 * editor does not carry because it does not need them: the supplier's own
 * record, stock split by location (the editor only shows a total), and the
 * variant's cost. Read-only can afford to show cost; a form field cannot,
 * because a mistyped cost silently rewrites margin on every future order.
 */
export async function getProductDetail(productId) {
  const base = await getProductForEdit(productId);
  if (!base.ok) return base;

  const variantIds = base.variants.map((v) => v.id);

  // The join, not two queries: v2_inventory_balances already carries the
  // location relationship, and v2_locations is under a column-level grant
  // where select("*") is REFUSED outright rather than trimmed. Naming the one
  // column needed keeps this working the next time a sensitive column lands on
  // that table.
  const [{ data: balances }, supplier] = await Promise.all([
    variantIds.length
      // Live view, not the table (064). Same columns, plus qty_available.
      ? sbCall(supabase.from("v2_inventory_balances_live")
          .select("variant_id, location_id, qty_on_hand, qty_reserved, qty_available, v2_locations(name)")
          .in("variant_id", variantIds))
      : Promise.resolve({ data: [] }),
    getSupplier(base.product.supplier_id),
  ]);

  const byVariant = new Map(variantIds.map((id) => [id, []]));
  (balances || []).forEach((b) => {
    const list = byVariant.get(b.variant_id);
    if (!list) return;
    list.push({
      locationId: b.location_id,
      locationName: b.v2_locations?.name || "Unnamed location",
      onHand: Number(b.qty_on_hand) || 0,
      reserved: Number(b.qty_reserved) || 0,
      // From the view, not re-derived here -- see 064.
      available: Number(b.qty_available) || 0,
    });
  });

  const colourBarcodeByColour = new Map(
    base.colourBarcodes.map((cb) => [String(cb.color || "").toLowerCase(), cb.barcode])
  );

  const variants = base.variants
    .filter((v) => !v.archived)
    .map((v) => {
      const colour = v.extra_attrs?.color || "";
      const stock = byVariant.get(v.id) || [];
      return {
        id: v.id,
        sku: v.sku,
        colour,
        colourHex: v.extra_attrs?.colorHex || "",
        size: v.extra_attrs?.size || "",
        price: v.price,
        cost: v.cost,
        retailPrice: v.retail_price,
        moqQty: v.moq_qty,
        sizeBarcode: v.barcode || "",
        colourBarcode: colourBarcodeByColour.get(colour.toLowerCase()) || "",
        stock,
        onHand: stock.reduce((s, r) => s + r.onHand, 0),
        available: stock.reduce((s, r) => s + r.available, 0),
      };
    });

  return {
    ok: true,
    product: base.product,
    supplier: supplier || null,
    images: imagesForVariants(base.variants),
    colourBarcodes: base.colourBarcodes,
    variants,
    archivedVariantCount: base.variants.filter((v) => v.archived).length,
  };
}

/** Catalog-only: sold from catalogs, NOT stock-controlled (migration 062).
 *
 *  Hadi, 20 Aug 2026: "create a toggle... whenever they click it they're
 *  telling you, hey, this is a catalog-only product, don't put it in the
 *  inventory."
 *
 *  This is deliberately NOT the same as holding zero stock. Zero drives
 *  low-stock alerts, reorder suggestions, dead-stock reports and an
 *  out-of-stock ribbon; a made-to-order or drop-shipped line would sit in
 *  all of them forever and teach the wholesaler to ignore the reports.
 *  "I do not stock this" and "I have run out" are different statements. */
export async function setCatalogOnly(productId, catalogOnly) {
  return sbCall(supabase.from("v2_products")
    .update({ catalog_only: !!catalogOnly, updated_at: new Date().toISOString() })
    .eq("id", productId));
}

/** in / out / not_tracked for every product this wholesaler has, keyed by
 *  product id. One call for a whole catalog screen rather than one per
 *  tile, and one place that decides what "out of stock" means. */
export async function getStockStates(wid) {
  const { data } = await sbCall(supabase.rpc("v2_catalog_stock_state", { p_wid: wid }));
  const map = new Map();
  (data || []).forEach((r) => map.set(r.product_id, { state: r.stock_state, onHand: Number(r.on_hand) || 0 }));
  return map;
}
