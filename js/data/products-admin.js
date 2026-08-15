// OGGI Wholesale v2 — wholesaler product management (Batch 3)
import { supabase, sbCall } from "../lib/supabase-client.js";

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
