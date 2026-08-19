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
import { imagesForVariants } from "../components/image-gallery.js";

/** Every catalog for a wholesaler, default first, then alphabetical. */
export async function listCatalogs(wid) {
  const { data, error } = await sbCall(
    supabase.from("v2_catalogs")
      // Explicit column list, and migration 053's three new columns are named
      // here deliberately. 045 revoked the blanket grant on this table so that
      // adding a column would have to be a decision to publish it; that only
      // holds if the read side is updated on purpose too.
      .select("id, wid, name, description, is_default, active, created_at, access_tier, discount_pct, discount_mode, share_token, is_public, billboard_enabled, billboard_image_url, billboard_media_type, billboard_product_id, billboard_cta, highlight_label")
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
      accessTier: Number(c.access_tier) || 1,
      discountPct: Number(c.discount_pct) || 0,
      discountMode: c.discount_mode || "combine",
      shareToken: c.share_token || null,
      isPublic: !!c.is_public,
      billboardEnabled: !!c.billboard_enabled,
      billboardUrl: c.billboard_image_url || "",
      billboardMediaType: c.billboard_media_type || "image",
      billboardProductId: c.billboard_product_id || null,
      billboardCta: c.billboard_cta || "",
      highlightLabel: c.highlight_label || "Featured",
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
      .select("product_id, sort_order, added_at, highlighted")
      .eq("catalog_id", catalogId)
      // Highlighted first, exactly as the buyer sees it. The wholesaler
      // arranging a catalog and the customer reading it must be looking at the
      // same order, or "always on top" is a promise only one of them can see.
      .order("highlighted", { ascending: false })
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
      // image_url/images come along so the list can show what the product
      // LOOKS like. A clothing catalogue that is only text makes a wholesaler
      // read forty rows that all say "jacket".
      .select("id, product_id, sku, price, archived, extra_attrs, image_url, images")
      .in("product_id", ids)),
  ]);

  const byProduct = new Map();
  (variants || []).filter((v) => !v.archived).forEach((v) => {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(v);
  });

  const order = new Map((links || []).map((l, i) => [l.product_id, i]));
  const highlightedBy = new Map((links || []).map((l) => [l.product_id, !!l.highlighted]));
  return {
    ok: true,
    rows: (products || []).map((p) => {
      const vs = byProduct.get(p.id) || [];
      const prices = vs.map((v) => Number(v.price || 0)).filter((n) => n > 0);
      return {
        id: p.id, name: p.name, description: p.description, category: p.category,
        archived: !!p.archived, sellingModel: p.selling_model, createdAt: p.created_at,
        highlighted: !!highlightedBy.get(p.id),
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
        images: imagesForVariants(vs),
      };
    }).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
  };
}

export async function createCatalog(wid, {
  name, description = null, accessTier = 1, discountPct = 0, discountMode = "combine",
} = {}) {
  const clean = String(name || "").trim();
  if (!clean) return { ok: false, error: "Give the catalog a name." };
  const bad = settingsProblem({ accessTier, discountPct, discountMode });
  if (bad) return { ok: false, error: bad };
  const { data, error } = await sbCall(
    supabase.from("v2_catalogs")
      .insert({
        wid, name: clean, description: description || null, is_default: false, active: true,
        access_tier: Number(accessTier) || 1,
        discount_pct: Number(discountPct) || 0,
        discount_mode: discountMode,
      })
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

export const DISCOUNT_MODES = [
  { value: "combine",
    label: "Combine both",
    help: "This catalog's discount plus the customer's own. 5% here and 20% on them is 25% off." },
  { value: "catalog_only",
    label: "Only this catalog's discount",
    help: "The customer's own rate is ignored here. Everyone who can see this catalog pays the same." },
  { value: "customer_only",
    label: "Only the customer's discount",
    help: "This catalog's own discount is skipped — except for a customer with no rate set, who gets it rather than paying full price." },
];

/** The same bounds the database checks, said in words a person can act on.
 *  Checked here as well as there because a constraint violation arrives as
 *  "violates check constraint v2_catalogs_discount_range", which tells the
 *  wholesaler nothing about what to type instead. */
export function settingsProblem({ accessTier, discountPct, discountMode }) {
  const tier = Number(accessTier);
  if (!Number.isInteger(tier) || tier < 1 || tier > 5) {
    return "Customer tier has to be a whole number from 1 to 5.";
  }
  const pct = Number(discountPct);
  if (!Number.isFinite(pct) || pct < -100 || pct > 100) {
    return "Discount has to be between -100 and 100. A negative number raises the price.";
  }
  if (!DISCOUNT_MODES.some((m) => m.value === discountMode)) {
    return "Pick how this catalog's discount meets the customer's own.";
  }
  return null;
}

/** The link a wholesaler copies and sends. Built here rather than in the view
 *  so every place that shows a link builds the same one -- two screens
 *  disagreeing about a URL is a link that works from one of them. */
export function catalogLink(shareToken) {
  if (!shareToken) return "";
  return `${location.origin}${location.pathname}#/c/${shareToken}`;
}

/** Whether a catalog needs no login at all. Hadi: "he can basically decide,
 *  okay, this catalog is open for everyone, whether they have a username or
 *  not." Separate call from the tier/discount save because it changes WHO can
 *  see the catalog rather than what it costs, and the confirmation a person
 *  needs before flipping it is a different sentence. */
export async function setCatalogPublic(catalogId, isPublic) {
  const { error } = await sbCall(
    supabase.from("v2_catalogs")
      .update({ is_public: !!isPublic, updated_at: new Date().toISOString() })
      .eq("id", catalogId)
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** A new token, which kills every link already sent. The only way to take back
 *  a link that reached the wrong person. */
export async function rotateCatalogLink(catalogId) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await sbCall(
    supabase.from("v2_catalogs")
      .update({ share_token: token, updated_at: new Date().toISOString() })
      .eq("id", catalogId)
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, shareToken: token };
}

/** The billboard: what it shows, whether it shows, and where its button goes.
 *  billboardProductId null means "just a poster" -- that is the difference
 *  between the two shapes Hadi described, and it is a null rather than a
 *  separate mode flag because one of them is literally the absence of the
 *  other. */
export async function setBillboard(catalogId, {
  enabled, url, mediaType, productId, cta,
} = {}) {
  const patch = { updated_at: new Date().toISOString() };
  if (enabled !== undefined) patch.billboard_enabled = !!enabled;
  if (url !== undefined) patch.billboard_image_url = url || null;
  if (mediaType !== undefined) patch.billboard_media_type = mediaType === "video" ? "video" : "image";
  if (productId !== undefined) patch.billboard_product_id = productId || null;
  if (cta !== undefined) patch.billboard_cta = (cta || "").trim() || null;

  const { error } = await sbCall(supabase.from("v2_catalogs").update(patch).eq("id", catalogId));
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** What the wholesaler calls their pinned group. Blank falls back rather than
 *  rendering a header with no words in it. */
export async function setHighlightLabel(catalogId, label) {
  const clean = String(label || "").trim() || "Featured";
  const { error } = await sbCall(
    supabase.from("v2_catalogs")
      .update({ highlight_label: clean, updated_at: new Date().toISOString() })
      .eq("id", catalogId)
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, label: clean };
}

/** Pin or unpin one product in one catalog. Any number may be pinned -- Hadi:
 *  "I want them to be able to highlight as many items as they want". */
export async function setProductHighlighted(catalogId, productId, highlighted) {
  const { error } = await sbCall(
    supabase.from("v2_catalog_products")
      .update({ highlighted: !!highlighted })
      .eq("catalog_id", catalogId).eq("product_id", productId)
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Tier, discount and mode. Separate from renameCatalog because renaming is a
 *  label change and these three move money -- worth being able to read the
 *  call site and know which kind of change it is. */
export async function updateCatalogSettings(catalogId, { accessTier, discountPct, discountMode }) {
  const bad = settingsProblem({ accessTier, discountPct, discountMode });
  if (bad) return { ok: false, error: bad };
  const { error } = await sbCall(
    supabase.from("v2_catalogs").update({
      access_tier: Number(accessTier),
      discount_pct: Number(discountPct),
      discount_mode: discountMode,
      updated_at: new Date().toISOString(),
    }).eq("id", catalogId)
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Files several products into a catalog at once.
 *
 * Anything already in it is skipped rather than sent and allowed to fail: the
 * primary key (catalog_id, product_id) would reject the row, and one rejected
 * row in a multi-row insert takes the whole statement with it -- so picking
 * six products where one is already filed would silently add none of them.
 */
export async function addProductsToCatalog(catalogId, productIds = []) {
  const wanted = [...new Set(productIds.filter(Boolean))];
  if (!wanted.length) return { ok: true, added: 0, skipped: 0 };

  const { data: existing } = await sbCall(
    supabase.from("v2_catalog_products").select("product_id")
      .eq("catalog_id", catalogId).in("product_id", wanted)
  );
  const already = new Set((existing || []).map((r) => r.product_id));
  const fresh = wanted.filter((id) => !already.has(id));
  if (!fresh.length) return { ok: true, added: 0, skipped: already.size };

  const { error } = await sbCall(
    supabase.from("v2_catalog_products")
      .insert(fresh.map((id, i) => ({ catalog_id: catalogId, product_id: id, sort_order: 100 + i })))
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, added: fresh.length, skipped: already.size };
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


// ---------------------------------------------------------------------
// The buyer side (migration 055)
// ---------------------------------------------------------------------
// Both of these take ONLY the account id. There is no wid parameter and no
// catalog-owner parameter, because the strongest question a buyer can ask is
// "what may I see" -- and there is deliberately no argument through which to
// ask a different one. The database reads the wholesaler and the tier off the
// validated account row itself. Same shape as v2_buyer_price_overrides, and
// for the same reason: buyers run as `anon`, so no row policy can scope them,
// and a parameter you can change is a parameter someone will change.

/** The catalogs this buyer's tier allows, most-default first. */
export async function buyerCatalogs(accountId) {
  if (!accountId) return [];
  const { data } = await sbCall(supabase.rpc("v2_buyer_catalogs", { p_account_id: accountId }));
  return (data || []).map((c) => ({
    id: c.id, name: c.name, description: c.description,
    isDefault: !!c.is_default, accessTier: Number(c.access_tier) || 1,
  }));
}

/** The product ids in one catalog, in the wholesaler's order. Returns an empty
 *  list -- not an error -- if this account may not see that catalog, so a
 *  guessed id looks exactly like an empty catalog rather than confirming that
 *  something is there. */
export async function buyerCatalogProductIds(accountId, catalogId) {
  if (!accountId || !catalogId) return [];
  const { data } = await sbCall(
    supabase.rpc("v2_buyer_catalog_products", { p_account_id: accountId, p_catalog_id: catalogId })
  );
  return (data || []).map((r) => ({ id: r.product_id, highlighted: !!r.highlighted }));
}


/**
 * Resolve a catalog link. Returns one of four honest answers rather than a
 * list-or-nothing, because "log in", "you are not allowed", "this link is
 * dead" and "here it is" are four different things to say to someone holding a
 * URL, and an empty result can only say one of them.
 *
 *   ok              show it
 *   login_required  a real link to a private catalog; nobody is signed in
 *   denied          signed in, but wrong wholesaler or tier too low
 *   not_found       no such link, or the catalog has been switched off --
 *                   deliberately the same answer, so a dead link cannot
 *                   confirm it was ever alive
 */
export async function catalogByToken(token, accountId = null) {
  if (!token) return { status: "not_found" };
  const { data } = await sbCall(
    supabase.rpc("v2_catalog_by_token", { p_token: token, p_account_id: accountId || null })
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: "not_found" };
  return {
    status: row.status,
    id: row.id, name: row.name, description: row.description,
    wid: row.wid, isPublic: !!row.is_public,
    accessTier: Number(row.access_tier) || 1,
    wholesalerName: row.wholesaler_name,
    billboardEnabled: !!row.billboard_enabled,
    billboardUrl: row.billboard_image_url || "",
    billboardMediaType: row.billboard_media_type || "image",
    billboardProductId: row.billboard_product_id || null,
    billboardCta: row.billboard_cta || "",
    highlightLabel: row.highlight_label || "Featured",
  };
}

/** The products behind a link, HIGHLIGHTED FIRST, each flagged so the page can
 *  put a header above the pinned group. The ordering is the database's, not
 *  this function's: "no matter what order they put them in, always the
 *  highlighted items will be on the top" is a property of the catalog, and a
 *  second sort here would be a second place for it to be wrong.
 *  Re-checks the gate itself, so calling this without resolving first gains
 *  nothing. */
export async function catalogProductsByToken(token, accountId = null) {
  if (!token) return [];
  const { data } = await sbCall(
    supabase.rpc("v2_catalog_products_by_token", { p_token: token, p_account_id: accountId || null })
  );
  return (data || []).map((r) => ({ id: r.product_id, highlighted: !!r.highlighted }));
}
