// OGGI Wholesale v2 — prepack / ratio-pack data access (Batch 7)
//
// A pack collapses to ONE cart/order line ("2x Boutique Pack – Style ABC,
// Blue") but its stock is still reserved/decremented per real component
// variant through the exact same RPCs every other line uses (see
// migrations/012_v2_prepack_enforcement.sql) -- this module only adds the
// bundle definition + the sell-through-informed ratio suggestion on top.

import { supabase, sbCall } from "../lib/supabase-client.js";

// ---------------------------------------------------------------------------
// DECISION D4, taken 21 Aug 2026: a flat pack price is STORED, never CHARGED.
// ---------------------------------------------------------------------------
// v2_pack_definitions.pack_price has existed since Batch 7 and v2_submit_order
// has never read it. The server prices every line -- pack lines included -- as
// qty x v2_effective_unit_price(...), which is the negotiated price, else the
// quantity break, else list, and then the catalog/customer discount. Verified
// against the live function body on 21 Aug 2026 and pinned by
// checks/check_line_pricing.sql, which sets pack_price to 50.00 on its fixture
// and asserts the order still comes to 96.00.
//
// This module used to fold that number into `price`, so a wholesaler who set
// a flat price produced a card showing one number and an invoice showing
// another, with nothing anywhere to say which was real.
//
// Hadi, 20 Aug 2026: "we will not be pricing per pack or per ratio. The price
// they will read in the thumbnail is going to be the per unit price."
//
// So: `price` is now ALWAYS the honest sum of the pieces at list. The stored
// flat price is still returned, as `flatPackPrice`, because nothing is deleted
// and a wholesaler's data is not ours to discard -- but it is a note about
// intent, not a price, and no buyer-facing screen may render it as one. If it
// is ever to become real, that is a change to v2_submit_order and to this
// comment, made deliberately, not a field quietly starting to mean something.
// ---------------------------------------------------------------------------


export async function listPacksForProduct(productId) {
  const { data: packs } = await sbCall(
    supabase.from("v2_pack_definitions").select("*").eq("product_id", productId).eq("archived", false).order("created_at", { ascending: false })
  );
  if (!packs || !packs.length) return [];

  const { data: components } = await sbCall(
    supabase.from("v2_pack_components").select("*, v2_product_variants(sku, price, extra_attrs)").in("pack_id", packs.map((p) => p.id))
  );
  const byPack = new Map();
  (components || []).forEach((c) => {
    const list = byPack.get(c.pack_id) || [];
    list.push({
      id: c.id, variantId: c.variant_id, qtyPerPack: c.qty_per_pack,
      sku: c.v2_product_variants?.sku, price: Number(c.v2_product_variants?.price ?? 0),
      color: c.v2_product_variants?.extra_attrs?.color, size: c.v2_product_variants?.extra_attrs?.size,
    });
    byPack.set(c.pack_id, list);
  });

  return packs.map((p) => {
    const components = (byPack.get(p.id) || []).sort((a, b) => (a.size || "").localeCompare(b.size || ""));
    const unitCount = components.reduce((s, c) => s + c.qtyPerPack, 0);
    const sumPrice = components.reduce((s, c) => s + c.qtyPerPack * c.price, 0);
    return {
      id: p.id, name: p.name, color: p.color, source: p.source,
      productId: p.product_id,
      // See D4 above: always the sum of the pieces, never the stored flat price.
      price: sumPrice,
      flatPackPrice: p.pack_price != null ? Number(p.pack_price) : null,
      isFlatPrice: p.pack_price != null,
      unitCount, components,
    };
  });
}

/**
 * THE BUYER'S PACK PATH. Batch S / S3.
 *
 * ⛔ WHY THIS IS NOT COSMETIC. Three of the four selling models — series,
 * prepack and ratio — can only be ordered as a pack: v2_enforce_selling_model
 * refuses loose lines, and since 15 Aug the card hides the per-size stepper for
 * them entirely. For those products **the pack is the buy button.**
 *
 * ⛔ AND IT FIXES A LIVE BUG. js/views/buyer.js:745 — the SHARE LINK view —
 * passed `packs: []` to every card. Not "whatever it found": an empty list,
 * unconditionally. The card took its bundle-only-with-no-packs branch and
 * printed *"This product has no bundles set up yet, so it cannot be ordered.
 * Ask the wholesaler to add one."* The wholesaler had. Counted on production
 * 26 Aug: **13 of 23 live products, across five of the six wholesalers**, dead
 * on the one channel the product is built around — and reading as the
 * wholesaler's own mistake rather than the app's.
 *
 * ⚠️ `flatPackPrice` / `isFlatPrice` are NOT returned by these functions.
 * Decision D4 (21 Aug): a flat pack price is stored, never charged, and no
 * buyer screen may render it — verified by grep on 26 Aug, nothing outside this
 * module reads either field. It is also the wholesaler's margin structure, and
 * the single most sensitive number in the Batch S research. A field that is
 * never used and must never leak does not cross this boundary.
 */
function assemblePackRows(rows) {
  const byPack = new Map();
  for (const r of rows || []) {
    let pack = byPack.get(r.pack_id);
    if (!pack) {
      pack = {
        id: r.pack_id, name: r.pack_name, color: r.pack_color, source: r.source,
        productId: r.product_id, components: [],
      };
      byPack.set(r.pack_id, pack);
    }
    // A pack whose components have not been written yet arrives as one row
    // with a null component. It must stay a pack with nothing in it -- a
    // vanished pack is indistinguishable from the bug above.
    if (!r.component_id) continue;
    pack.components.push({
      id: r.component_id,
      variantId: r.variant_id,
      qtyPerPack: r.qty_per_pack,
      sku: r.sku,
      price: Number(r.unit_price ?? 0),
      color: r.extra_attrs?.color,
      size: r.extra_attrs?.size,
    });
  }
  // The database already ordered these. No re-sort here: a second sort is a
  // second place for the order to be wrong.
  for (const pack of byPack.values()) {
    pack.unitCount = pack.components.reduce((s, c) => s + c.qtyPerPack, 0);
    pack.price = pack.components.reduce((s, c) => s + c.qtyPerPack * c.price, 0);
  }
  return byPack;
}

/** Group assembled packs by product, the shape the catalog grid reads. */
function packsByProduct(byPack) {
  const out = new Map();
  for (const pack of byPack.values()) {
    const list = out.get(pack.productId) || [];
    list.push(pack);
    out.set(pack.productId, list);
  }
  return out;
}

/** Packs for everything behind a share LINK. Map(productId -> [pack]). */
export async function listPacksByToken(token, accountId = null) {
  if (!token) return new Map();
  const { data } = await sbCall(
    supabase.rpc("v2_catalog_packs", { p_token: token, p_account_id: accountId || null })
  );
  return packsByProduct(assemblePackRows(data));
}

/** Packs for a SIGNED-IN buyer's catalogue. Map(productId -> [pack]). */
export async function listPacksForBuyerCatalog(accountId, catalogId) {
  if (!accountId || !catalogId) return new Map();
  const { data } = await sbCall(
    supabase.rpc("v2_buyer_catalog_packs", { p_account_id: accountId, p_catalog_id: catalogId })
  );
  return packsByProduct(assemblePackRows(data));
}

/** One pack, current composition, for REORDER. Gated on the pack's product
 *  being in a catalogue this account may still see -- so a product the
 *  wholesaler has since pulled stops reordering, which is the same answer the
 *  buyer would get browsing. */
export async function getBuyerPack(accountId, packId) {
  if (!accountId || !packId) return null;
  const { data } = await sbCall(
    supabase.rpc("v2_buyer_pack", { p_account_id: accountId, p_pack_id: packId })
  );
  const byPack = assemblePackRows(data);
  return byPack.size ? [...byPack.values()][0] : null;
}

/** Batch version of listPacksForProduct for a whole catalog grid, fetched
 * once per catalog load (same pattern as Batch 6's getPricingContext) so
 * a product grid of N products doesn't issue N pack queries. */
export async function listPacksForProducts(productIds) {
  if (!productIds.length) return new Map();
  const { data: packs } = await sbCall(
    supabase.from("v2_pack_definitions").select("*").in("product_id", productIds).eq("archived", false).order("created_at", { ascending: false })
  );
  if (!packs || !packs.length) return new Map();

  const { data: components } = await sbCall(
    supabase.from("v2_pack_components").select("*, v2_product_variants(sku, price, extra_attrs)").in("pack_id", packs.map((p) => p.id))
  );
  const compByPack = new Map();
  (components || []).forEach((c) => {
    const list = compByPack.get(c.pack_id) || [];
    list.push({
      id: c.id, variantId: c.variant_id, qtyPerPack: c.qty_per_pack,
      sku: c.v2_product_variants?.sku, price: Number(c.v2_product_variants?.price ?? 0),
      color: c.v2_product_variants?.extra_attrs?.color, size: c.v2_product_variants?.extra_attrs?.size,
    });
    compByPack.set(c.pack_id, list);
  });

  const byProduct = new Map();
  packs.forEach((p) => {
    const components = (compByPack.get(p.id) || []).sort((a, b) => (a.size || "").localeCompare(b.size || ""));
    const unitCount = components.reduce((s, c) => s + c.qtyPerPack, 0);
    const sumPrice = components.reduce((s, c) => s + c.qtyPerPack * c.price, 0);
    const list = byProduct.get(p.product_id) || [];
    list.push({
      id: p.id, name: p.name, color: p.color, source: p.source,
      productId: p.product_id,
      // See D4 above: always the sum of the pieces, never the stored flat price.
      price: sumPrice,
      flatPackPrice: p.pack_price != null ? Number(p.pack_price) : null,
      isFlatPrice: p.pack_price != null,
      unitCount, components,
    });
    byProduct.set(p.product_id, list);
  });
  return byProduct;
}

/** Single-pack lookup (with live components/price), used by the buyer
 * "Reorder" flow to re-add a pack that appeared in past order history --
 * that history only stores the pack_id, not the full definition, and the
 * definition may have changed since (components, price), so reorder always
 * re-adds at CURRENT pack composition/pricing rather than a stale copy. */
export async function getPackById(packId) {
  const { data: pack } = await sbCall(supabase.from("v2_pack_definitions").select("*").eq("id", packId).eq("archived", false).maybeSingle());
  if (!pack) return null;
  const { data: components } = await sbCall(
    supabase.from("v2_pack_components").select("*, v2_product_variants(sku, price, extra_attrs)").eq("pack_id", packId)
  );
  const comps = (components || []).map((c) => ({
    variantId: c.variant_id, qtyPerPack: c.qty_per_pack,
    sku: c.v2_product_variants?.sku, price: Number(c.v2_product_variants?.price ?? 0),
    color: c.v2_product_variants?.extra_attrs?.color, size: c.v2_product_variants?.extra_attrs?.size,
  }));
  const sumPrice = comps.reduce((s, c) => s + c.qtyPerPack * c.price, 0);
  return {
    id: pack.id, name: pack.name, color: pack.color,
    productId: pack.product_id,
    // See D4 above: always the sum of the pieces, never the stored flat price.
    price: sumPrice,
    flatPackPrice: pack.pack_price != null ? Number(pack.pack_price) : null,
    isFlatPrice: pack.pack_price != null,
    unitCount: comps.reduce((s, c) => s + c.qtyPerPack, 0),
    components: comps,
  };
}

export async function createPack(wid, productId, { name, color, components, packPrice }) {
  const { data: pack, error } = await sbCall(
    supabase.from("v2_pack_definitions").insert({
      wid, product_id: productId, name, color: color || null,
      pack_price: packPrice === "" || packPrice == null ? null : packPrice,
      source: "manual",
    }).select().single()
  );
  if (error || !pack) return { ok: false, error };

  for (const c of components) {
    if (c.qtyPerPack > 0) {
      await sbCall(supabase.from("v2_pack_components").insert({ pack_id: pack.id, variant_id: c.variantId, qty_per_pack: c.qtyPerPack }));
    }
  }
  return { ok: true, packId: pack.id };
}

export async function archivePack(packId) {
  return sbCall(supabase.from("v2_pack_definitions").update({ archived: true, updated_at: new Date().toISOString() }).eq("id", packId));
}

/** Re-collapses an order's flat item list back into pack-grouped display
 * lines. Order history is read straight off v2_order_items (the real
 * per-SKU rows the RPC wrote), so this is a pure display-time regrouping,
 * not a second source of truth -- items sharing a pack_line_id are always
 * literally the same pack purchase, never a coincidence, since
 * pack_line_id is a fresh id generated once per pack added to a cart. */
export function groupPackLines(items) {
  const grouped = [];
  const packGroups = new Map();
  items.forEach((it) => {
    if (!it.packLineId) {
      grouped.push(it);
      return;
    }
    let group = packGroups.get(it.packLineId);
    if (!group) {
      group = {
        isPack: true, packLineId: it.packLineId, packId: it.packId, packQty: it.packQty,
        productName: it.productName, components: [], lineTotal: 0,
        // Migration 086. A pack is ONE line to the buyer and N rows underneath,
        // and cart.js writes the buyer's note onto the FIRST component only.
        // Without this line the collapse silently ate it: the note was stored
        // correctly and simply never arrived on any screen -- the exact shape
        // of the Batch-19 bug where the buyer's card fetched photography on
        // every request and discarded it one line later.
        buyerNote: null,
        // Migration 087. Same reasoning as buyerNote: the collapse must not
        // eat the wholesaler's instruction either. itemId comes with it so a
        // note can be written back against a real row.
        fulfilNote: null,
        itemId: null,
      };
      packGroups.set(it.packLineId, group);
      grouped.push(group);
    }
    group.components.push({ sku: it.sku, color: it.color, size: it.size, qty: it.qty, buyerNote: it.buyerNote || null, imageUrl: it.imageUrl || null });
    // First non-null wins, and it does not matter which row carries it: taking
    // the first one FOUND rather than the first one WRITTEN means a change to
    // component ordering upstream cannot lose the note.
    if (!group.buyerNote && it.buyerNote) group.buyerNote = it.buyerNote;
    if (!group.fulfilNote && it.fulfilNote) group.fulfilNote = it.fulfilNote;
    // The pack writes its fulfilment note against its FIRST row, mirroring how
    // the cart stores the buyer's note.
    if (group.itemId == null && it.itemId != null) group.itemId = it.itemId;
    group.lineTotal += it.lineTotal;
  });
  return grouped;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/** Sell-through-informed ratio suggestion (Research 3): looks at real
 * order history for this product's variants, sums qty ordered per
 * variant, and reduces to the smallest whole-number ratio (e.g. actual
 * sell-through of 8/16/16/8 units reduces to 1/2/2/1). Falls back to an
 * even 1:1:1... ratio across the product's variants when there's no real
 * order history yet -- the research doc's "always keep a fallback"
 * principle applied to the suggestion itself, not just the ordering UX. */
export async function suggestPackRatio(productId, variantIds) {
  const { data: items } = await sbCall(
    supabase.from("v2_order_items").select("variant_id, qty").in("variant_id", variantIds)
  );
  const soldByVariant = new Map(variantIds.map((id) => [id, 0]));
  (items || []).forEach((it) => soldByVariant.set(it.variant_id, (soldByVariant.get(it.variant_id) || 0) + it.qty));

  const totalSold = [...soldByVariant.values()].reduce((s, n) => s + n, 0);
  let ratios;
  let source;
  if (totalSold > 0) {
    ratios = variantIds.map((id) => Math.max(1, Math.round((soldByVariant.get(id) / totalSold) * variantIds.length)));
    source = "sell-through";
  } else {
    ratios = variantIds.map(() => 1);
    source = "even (no order history yet)";
  }
  const g = ratios.reduce((a, b) => gcd(a, b));
  const reduced = g > 1 ? ratios.map((r) => Math.round(r / g)) : ratios;
  return { source, ratios: variantIds.map((id, i) => ({ variantId: id, qtyPerPack: reduced[i] })) };
}
