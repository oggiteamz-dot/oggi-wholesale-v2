// OGGI Wholesale v2 — per-client negotiated price overrides ("Your Price"), Batch 6
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function listClientOverrides(clientId) {
  const { data } = await sbCall(
    supabase.from("v2_client_price_overrides")
      .select("*, v2_product_variants(sku, price, extra_attrs, v2_products(name))")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
  );
  return (data || []).map((o) => ({
    id: o.id,
    variantId: o.variant_id,
    overridePrice: Number(o.override_price),
    note: o.note,
    basePrice: Number(o.v2_product_variants?.price ?? 0),
    sku: o.v2_product_variants?.sku,
    productName: o.v2_product_variants?.v2_products?.name || "Product",
    color: o.v2_product_variants?.extra_attrs?.color,
    size: o.v2_product_variants?.extra_attrs?.size,
  }));
}

export async function setClientOverride(clientId, variantId, overridePrice, note, createdBy) {
  return sbCall(
    supabase.from("v2_client_price_overrides")
      .upsert({ client_id: clientId, variant_id: variantId, override_price: overridePrice, note: note || null, created_by: createdBy || null }, { onConflict: "client_id,variant_id" })
      .select()
      .single()
  );
}

export async function removeClientOverride(id) {
  return sbCall(supabase.from("v2_client_price_overrides").delete().eq("id", id));
}

/** Flat searchable list of {variantId, sku, productName, color, size,
 * price} for the "add an override" picker -- reuses the wholesaler's own
 * product/variant data, not the buyer catalog (a wholesaler should be able
 * to set an override even on an archived/low-stock variant). */
export async function listVariantsForPicker(wid) {
  const { data: products } = await sbCall(supabase.from("v2_products").select("id, name").eq("wid", wid));
  if (!products || !products.length) return [];
  const { data: variants } = await sbCall(
    supabase.from("v2_product_variants").select("id, sku, price, extra_attrs, product_id").in("product_id", products.map((p) => p.id))
  );
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  return (variants || []).map((v) => ({
    variantId: v.id, sku: v.sku, price: Number(v.price ?? 0),
    productName: nameById.get(v.product_id) || "Product",
    color: v.extra_attrs?.color, size: v.extra_attrs?.size,
  }));
}
