// =============================================================================
// OGGI Wholesale v2 — CATALOGS (data layer)
// =============================================================================
//
// A catalog is a named, ordered selection of one wholesaler's own products.
// The tables arrived in migration 045; before that /wholesaler/catalogs was a
// literal "scheduled later" stub and there was no catalog table in the schema
// at all, so "catalog" meant nothing more than "this wholesaler's non-archived
// products" -- a query, not an object.
//
// SCOPING IS THE DATABASE'S JOB, NOT THIS FILE'S
// ----------------------------------------------
// Every query here still passes `wid` where it is useful for an index, but the
// isolation comes from the row policies in 045 (owner or v2_my_wid()). If a
// filter here were forgotten, the database would still return nothing that
// does not belong to the caller. That ordering matters: three tables in this
// schema have already needed a leak fixed after the fact because the filter
// was in the JavaScript and the policy said `true`.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

/** Every catalog for a wholesaler, default first, then alphabetical. */
export async function listCatalogs(wid) {
  const { data, error } = await sbCall(
    supabase.from("v2_catalogs")
      .select("id, wid, name, description, is_default, active, created_at")
      .eq("wid", wid)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true })
  );
  if (error) return { ok: false, error: error.message, rows: [] };
  return {
    ok: true,
    rows: (data || []).map((c) => ({
      id: c.id, wid: c.wid, name: c.name, description: c.description,
      isDefault: !!c.is_default, active: c.active !== false, createdAt: c.created_at,
    })),
  };
}

/**
 * The products in one catalog, with the summary figures the builder shows.
 *
 * Two queries rather than one nested select: PostgREST's embedded resource
 * syntax would work, but the variant/stock rollup below needs the variants
 * anyway, and a single join returning one row per variant would then have to
 * be regrouped here regardless.
 */
export async function getCatalogProducts(catalogId) {
  const { data: links, error } = await sbCall(
    supabase.from("v2_catalog_products")
      .select("product_id, sort_order, added_at")
      .eq("catalog_id", catalogId)
      .order("sort_order", { ascending: true })
  );
  if (error) return { ok: false, error: error.message, rows: [] };
  const ids = (links || []).map((l) => l.product_id);
  if (!ids.length) return { ok: true, rows: [] };

  const [{ data: products }, { data: variants }] = await Promise.all([
    sbCall(supabase.from("v2_products")
      .select("id, name, description, category, archived, selling_model, created_at")
      .in("id", ids)),
    sbCall(supabase.from("v2_product_variants")
      .select("id, product_id, sku, price, archived, extra_attrs")
      .in("product_id", ids)),
  ]);

  const byProduct = new Map();
  (variants || []).filter((v) => !v.archived).forEach((v) => {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(v);
  });

  const order = new Map((links || []).map((l, i) => [l.product_id, i]));
  return {
    ok: true,
    rows: (products || []).map((p) => {
      const vs = byProduct.get(p.id) || [];
      const prices = vs.map((v) => Number(v.price || 0)).filter((n) => n > 0);
      return {
        id: p.id, name: p.name, description: p.description, category: p.category,
        archived: !!p.archived, sellingModel: p.selling_model, createdAt: p.created_at,
        variantCount: vs.length,
        // Distinct colours, for the swatch row. "#999" matches the fallback
        // js/data/catalog.js already uses, so a variant with no colorHex looks
        // the same on this screen as it does to a buyer. In practice that is
        // CSV-imported variants only -- the importer writes colour and size
        // but no hex; the v1 migration and this app's own form both set one.
        colors: [...new Map(vs.filter((v) => v.extra_attrs?.color)
          .map((v) => [v.extra_attrs.color,
                       { name: v.extra_attrs.color, hex: v.extra_attrs.colorHex || "#999" }])).values()],
        priceRange: prices.length ? [Math.min(...prices), Math.max(...prices)] : [0, 0],
      };
    }).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
  };
}

export async function createCatalog(wid, { name, description = null } = {}) {
  const clean = String(name || "").trim();
  if (!clean) return { ok: false, error: "Give the catalog a name." };
  const { data, error } = await sbCall(
    supabase.from("v2_catalogs")
      .insert({ wid, name: clean, description: description || null, is_default: false, active: true })
      .select("id, name").single()
  );
  if (error) {
    // 23505 is the (wid, lower(name)) unique index from 045. Saying so beats
    // "duplicate key value violates unique constraint v2_catalogs_unique_name".
    if (/duplicate key|23505/i.test(error.message)) {
      return { ok: false, error: `You already have a catalog called "${clean}".` };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id, name: data.name };
}

export async function renameCatalog(catalogId, name) {
  const clean = String(name || "").trim();
  if (!clean) return { ok: false, error: "A catalog needs a name." };
  const { error } = await sbCall(
    supabase.from("v2_catalogs").update({ name: clean }).eq("id", catalogId)
  );
  if (error) {
    if (/duplicate key|23505/i.test(error.message)) {
      return { ok: false, error: `You already have a catalog called "${clean}".` };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Files an existing product into a catalog. Idempotent.
 *
 * `ignoreDuplicates: true` is load-bearing, not a preference. Without it,
 * supabase-js sends a MERGE upsert, which PostgREST turns into
 * `INSERT ... ON CONFLICT DO UPDATE SET catalog_id = ..., product_id = ...,
 * sort_order = ...` -- an UPDATE naming every column in the payload.
 * Migration 045 grants UPDATE on `sort_order` only, deliberately, so the merge
 * form was refused for lacking UPDATE on catalog_id and product_id.
 *
 * The symptom was ugly: the product was created, its variants were created,
 * its stock was received, and it was filed nowhere -- so it appeared in
 * Inventory and was missing from the catalog it had just been created in. The
 * failure was invisible because createProduct() ignored this function's return
 * value. It no longer does.
 *
 * `ignoreDuplicates` sends ON CONFLICT DO NOTHING instead, which needs no
 * UPDATE privilege at all. Re-filing a product that is already in the catalog
 * is a no-op, which is the behaviour wanted anyway -- sort_order is set from
 * the catalog screen, not from here.
 */
export async function addProductToCatalog(catalogId, productId, sortOrder = 100) {
  const { error } = await sbCall(
    supabase.from("v2_catalog_products")
      .upsert({ catalog_id: catalogId, product_id: productId, sort_order: sortOrder },
              { onConflict: "catalog_id,product_id", ignoreDuplicates: true })
  );
  if (error) {
    // 23514 is the same-tenant trigger from 045. It should be unreachable from
    // the interface, which only ever offers this wholesaler's own products --
    // so if it fires, something upstream is wrong and the message should say
    // so rather than blaming the operator's input.
    if (/23514|another wholesaler/i.test(error.message)) {
      return { ok: false, error: "That product belongs to a different wholesaler. Reload and try again." };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Removes a product from a catalog. Does NOT delete the product -- it stays
 *  in Products and in any other catalog it belongs to. The wording in the
 *  interface has to make that distinction too, or this reads as "delete". */
export async function removeProductFromCatalog(catalogId, productId) {
  const { error } = await sbCall(
    supabase.from("v2_catalog_products").delete()
      .eq("catalog_id", catalogId).eq("product_id", productId)
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** The wholesaler's default catalog -- where a product created from Inventory
 *  is filed so it can never end up in no catalog at all. Migration 045
 *  back-filled one per wholesaler and a partial unique index keeps it to one,
 *  so this returning null means something is genuinely wrong. */
export async function getDefaultCatalog(wid) {
  const { data } = await sbCall(
    supabase.from("v2_catalogs").select("id, name").eq("wid", wid).eq("is_default", true).maybeSingle()
  );
  return data || null;
}
