// OGGI Wholesale v2 — kit/bundle SKU data access (Batch 9)
//
// A kit is a pre-assembled, cross-product bundle that becomes its OWN real
// sellable SKU (v2_kit_definitions.kit_variant_id is a normal
// v2_product_variants row) -- deliberately different from Batch 7's
// prepacks, which collapse to one order line at order time but never exist
// as real on-hand stock and are scoped to a single product's own
// colourways. A kit's components can be variants of entirely different
// products. The only way component stock becomes kit stock is
// v2_assemble_kit (migrations/015), which this module wraps.

import { supabase, sbCall } from "../lib/supabase-client.js";

export async function listKits(wid) {
  const { data: kits } = await sbCall(
    supabase.from("v2_kit_definitions")
      .select("*, v2_product_variants(sku, price, extra_attrs, v2_products(name))")
      .eq("wid", wid).eq("active", true).order("created_at", { ascending: false })
  );
  if (!kits || !kits.length) return [];

  const { data: components } = await sbCall(
    supabase.from("v2_kit_components")
      .select("*, v2_product_variants(sku, extra_attrs, v2_products(name))")
      .in("kit_id", kits.map((k) => k.id))
  );
  const byKit = new Map();
  (components || []).forEach((c) => {
    const list = byKit.get(c.kit_id) || [];
    list.push({
      id: c.id, componentVariantId: c.component_variant_id, qtyPerKit: c.qty_per_kit,
      sku: c.v2_product_variants?.sku,
      productName: c.v2_product_variants?.v2_products?.name,
      color: c.v2_product_variants?.extra_attrs?.color, size: c.v2_product_variants?.extra_attrs?.size,
    });
    byKit.set(c.kit_id, list);
  });

  return kits.map((k) => ({
    id: k.id, name: k.name,
    kitVariantId: k.kit_variant_id,
    kitSku: k.v2_product_variants?.sku,
    kitPrice: k.v2_product_variants?.price != null ? Number(k.v2_product_variants.price) : null,
    kitProductName: k.v2_product_variants?.v2_products?.name,
    components: byKit.get(k.id) || [],
  }));
}

/** Creates a kit definition against an EXISTING variant (the wholesaler
 * picks which of their SKUs represents the kit -- usually a dedicated
 * "kit"/"bundle" product+variant they've already created via the normal
 * product admin, exactly like any other sellable SKU) plus its component
 * list. Doesn't create the variant itself -- that's the existing product
 * admin's job (Batch 3), kept out of scope here to avoid a second,
 * parallel product-creation path. */
export async function createKit(wid, { name, kitVariantId, components }) {
  const { data: kit, error } = await sbCall(
    supabase.from("v2_kit_definitions").insert({ wid, kit_variant_id: kitVariantId, name }).select().single()
  );
  if (error || !kit) return { ok: false, error };

  for (const c of components) {
    if (c.qtyPerKit > 0) {
      await sbCall(supabase.from("v2_kit_components").insert({ kit_id: kit.id, component_variant_id: c.componentVariantId, qty_per_kit: c.qtyPerKit }));
    }
  }
  return { ok: true, kitId: kit.id };
}

export async function archiveKit(kitId) {
  return sbCall(supabase.from("v2_kit_definitions").update({ active: false }).eq("id", kitId));
}

/** Assembles `qty` kits at `locationId` -- atomically consumes every
 * component's stock and produces the kit SKU's stock via the
 * v2_assemble_kit RPC (migrations/015). Returns { ok:false, error } with
 * the server's real "insufficient stock for component X" message on
 * failure (never a generic error) so the wholesaler knows exactly which
 * component is short. */
export async function assembleKit(kitId, locationId, qty, note) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_assemble_kit", { p_kit_id: kitId, p_location_id: locationId, p_qty: qty, p_actor_id: null, p_note: note || null })
  );
  if (error || !data) return { ok: false, error };
  return { ok: true, balance: data };
}
