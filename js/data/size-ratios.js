// OGGI Wholesale v2 — reusable size ratios (migration 061)
//
// Hadi, 20 Aug 2026: "There is no way to program the ratios. There is no
// way to program the pre-pack. There's nothing... Give them full freedom
// to decide what type of ratios, pre-packs, series, and so on, in
// whatever way they want."
//
// THE POINT OF THIS FILE IS REUSE.
// ---------------------------------------------------------------------
// A ratio is written ONCE, named, and then applied to as many products
// and colours as you like. Before this, a curve was re-typed per colour
// per product -- 8 colours x 8 sizes was 64 boxes, one pack at a time,
// which is why nobody ever used the pack builder.
//
// Every serious system in this market models the ratio as a standalone
// object and then attaches it: NuORDER creates "Size Packs" and then has
// a separate "associating packs to products" step; Brandboom lets you
// "add the same prepack to multiple products at one time". None of them
// store the curve only on the product.
//
// NOTE ON WHERE THE WORK HAPPENS: applying a ratio is a single
// SECURITY DEFINER call (v2_apply_ratio). It is not a loop in this file
// building packs colour by colour, because that would be several
// round-trips that can half-fail and leave a product carrying three of
// its four packs.
import { supabase, sbCall } from "../lib/supabase-client.js";

/** Starter curves, taken from real published practice rather than
 *  invented. These are OFFERED as a starting point to copy and edit --
 *  they are never applied to anything on their own, because the base
 *  unit is per product (Hadi: "they decide the base unit per product"). */
export const STARTER_RATIOS = [
  { name: "Bell 1-2-2-1",     sizes: ["S", "M", "L", "XL"],              weights: [1, 2, 2, 1] },
  { name: "Bell 1-2-3-2-1",   sizes: ["S", "M", "L", "XL", "XXL"],       weights: [1, 2, 3, 2, 1] },
  { name: "Even 2-3-3-2",     sizes: ["S", "M", "L", "XL"],              weights: [2, 3, 3, 2] },
  { name: "Oversized 1-1-2-3-2-1", sizes: ["S", "M", "L", "XL", "XXL", "3XL"], weights: [1, 1, 2, 3, 2, 1] },
  { name: "Numeric 2-3-5-2",  sizes: ["36", "38", "40", "42"],           weights: [2, 3, 5, 2] },
];

export function ratioTotal(weights) {
  return (weights || []).reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
}

/** "2-3-5-2" — how the trade actually writes a curve. */
export function ratioShorthand(weights) {
  return (weights || []).join("-");
}

export async function listRatios(wid) {
  const { data } = await sbCall(
    supabase.from("v2_size_ratios").select("*").eq("wid", wid).eq("archived", false)
      .order("name", { ascending: true })
  );
  return data || [];
}

export async function createRatio(wid, { name, sizes, weights, note, sequenceId }) {
  return sbCall(supabase.from("v2_size_ratios").insert({
    wid, name, sizes, weights,
    note: note || null,
    sequence_id: sequenceId || null,
  }).select().single());
}

export async function updateRatio(id, { name, sizes, weights, note }) {
  return sbCall(supabase.from("v2_size_ratios").update({
    name, sizes, weights, note: note || null,
  }).eq("id", id).select().single());
}

/** Archive, never delete. A ratio that generated packs months ago is the
 *  only explanation of why those packs contain what they contain. */
export async function archiveRatio(id) {
  return sbCall(supabase.from("v2_size_ratios").update({ archived: true }).eq("id", id));
}

/** Apply a ratio to a product across colours, in ONE call.
 *  Returns { ok, msg, packs_created, packs_replaced, pieces_per_pack,
 *            colors_done, sizes_unmatched }.
 *
 *  colors = null means EVERY colour the product has, which is the
 *  common case and the one that makes this worth having. */
export async function applyRatio(ratioId, productId, { colors = null, multiplier = 1, name = null } = {}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_apply_ratio", {
      p_ratio_id: ratioId,
      p_product_id: productId,
      p_colors: colors,
      p_multiplier: multiplier,
      p_name: name,
    })
  );
  if (error) return { ok: false, msg: error.message || "Could not apply this ratio." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "No response from the server." };
}

/** Which products already carry packs from this ratio. Shown BEFORE an
 *  edit, so changing a curve is never a blind action across an unknown
 *  number of products. */
export async function ratioUsage(ratioId) {
  const { data } = await sbCall(supabase.rpc("v2_ratio_usage", { p_ratio_id: ratioId }));
  return data || [];
}

/** The distinct sizes and colours a product actually has, in the order
 *  the wholesaler entered them. Used to pre-fill a new ratio with the
 *  right sizes instead of making someone retype them. */
export function productSizes(product) {
  const seen = [];
  (product.variants || []).forEach((v) => {
    const s = v.extra_attrs?.size;
    if (s && !seen.includes(s)) seen.push(s);
  });
  return seen;
}

export function productColors(product) {
  const seen = [];
  (product.variants || []).forEach((v) => {
    const c = v.extra_attrs?.color;
    if (c && !seen.includes(c)) seen.push(c);
  });
  return seen;
}

/** Set how many pieces one orderable unit of this product is.
 *  Per product, never a wholesaler-wide default -- Hadi was explicit. */
export async function setBaseUnit(productId, baseUnit) {
  return sbCall(supabase.from("v2_products")
    .update({ base_unit: baseUnit === "" || baseUnit == null ? null : parseInt(baseUnit, 10) })
    .eq("id", productId));
}
