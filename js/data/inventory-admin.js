// OGGI Wholesale v2 — wholesaler inventory management (Batch 3)
// Every write here goes through Batch 1's RPCs (v2_receive_stock etc.) --
// never a direct UPDATE on v2_inventory_balances, per the architecture's
// own rule (see 001_v2_inventory_core.sql header).
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function getLocations(wid) {
  const { data } = await sbCall(supabase.from("v2_locations").select("*").eq("wid", wid).eq("archived", false).order("is_default", { ascending: false }));
  return data || [];
}

export async function getStockTable(wid) {
  const { data: products } = await sbCall(supabase.from("v2_products").select("id,name").eq("wid", wid));
  if (!products || !products.length) return [];
  const productById = new Map(products.map((p) => [p.id, p.name]));
  const productIds = products.map((p) => p.id);

  const { data: variants } = await sbCall(supabase.from("v2_product_variants").select("*").in("product_id", productIds).eq("archived", false));
  const variantIds = (variants || []).map((v) => v.id);
  if (!variantIds.length) return [];

  const { data: balances } = await sbCall(supabase.from("v2_inventory_balances").select("*, v2_locations(name)").in("variant_id", variantIds));

  return (balances || []).map((b) => {
    const variant = (variants || []).find((v) => v.id === b.variant_id);
    return {
      variantId: b.variant_id,
      locationId: b.location_id,
      locationName: b.v2_locations?.name || "—",
      productName: productById.get(variant?.product_id) || "—",
      sku: variant?.sku,
      color: variant?.extra_attrs?.color,
      size: variant?.extra_attrs?.size,
      // Batch 9: base unit cost, needed by the landed-cost receipt flow
      // (js/data/landed-cost.js) to compute (base cost + freight/duty/
      // other allocated per unit).
      cost: variant?.cost != null ? Number(variant.cost) : 0,
      onHand: Number(b.qty_on_hand),
      reserved: Number(b.qty_reserved),
      available: Number(b.qty_on_hand) - Number(b.qty_reserved),
    };
  }).sort((a, b) => a.available - b.available); // low stock first -- most actionable
}

export async function receiveStock(variantId, locationId, qty, note) {
  return sbCall(supabase.rpc("v2_receive_stock", {
    p_variant_id: variantId, p_location_id: locationId, p_qty: qty,
    p_reference_type: "manual_receive", p_reference_id: null, p_actor_id: null,
    p_note: note || "Manual stock receipt (Batch 3 wholesaler UI)",
  }));
}

export async function adjustStock(variantId, locationId, qty, note) {
  // A manual count correction can go either direction: positive = receive,
  // negative = decrement. Route to the matching RPC rather than exposing a
  // raw balance write.
  if (qty > 0) {
    return sbCall(supabase.rpc("v2_receive_stock", {
      p_variant_id: variantId, p_location_id: locationId, p_qty: qty,
      p_reference_type: "count_correction", p_reference_id: null, p_actor_id: null, p_note: note,
    }));
  }
  if (qty < 0) {
    return sbCall(supabase.rpc("v2_decrement_stock", {
      p_variant_id: variantId, p_location_id: locationId, p_qty: Math.abs(qty),
      p_movement_type: "count_correction", p_reference_type: null, p_reference_id: null, p_actor_id: null, p_note: note,
    }));
  }
  return { ok: true };
}
