// OGGI Wholesale v2 — prepack / ratio-pack data access (Batch 7)
//
// A pack collapses to ONE cart/order line ("2x Boutique Pack – Style ABC,
// Blue") but its stock is still reserved/decremented per real component
// variant through the exact same RPCs every other line uses (see
// migrations/012_v2_prepack_enforcement.sql) -- this module only adds the
// bundle definition + the sell-through-informed ratio suggestion on top.

import { supabase, sbCall } from "../lib/supabase-client.js";

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
      price: p.pack_price != null ? Number(p.pack_price) : sumPrice,
      isFlatPrice: p.pack_price != null,
      unitCount, components,
    };
  });
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
      price: p.pack_price != null ? Number(p.pack_price) : sumPrice,
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
    price: pack.pack_price != null ? Number(pack.pack_price) : sumPrice,
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
      };
      packGroups.set(it.packLineId, group);
      grouped.push(group);
    }
    group.components.push({ sku: it.sku, color: it.color, size: it.size, qty: it.qty });
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
