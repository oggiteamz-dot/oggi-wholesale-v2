// OGGI Wholesale v2 — per-client negotiated price overrides ("Your Price"), Batch 6
//
// Batch 16 moved every function here off the table and onto RPCs, for two
// reasons that pull in opposite directions and are both real:
//
//   READS were open to everyone. The table carried `using (true)` for SELECT
//   from migration 023 until 048 -- per-client negotiated pricing, readable by
//   any holder of the publishable key, for every wholesaler.
//
//   WRITES were closed to the only role that uses this file. Sales reps
//   authenticate through v2_portal_accounts, so they run as anon with
//   auth.uid() NULL, which makes v2_my_wid() NULL and v2_is_owner() false --
//   and 023's scoped INSERT/UPDATE/DELETE policies can therefore never pass
//   for them. "Set price" on the salesperson screen returned 42501 every time
//   it was clicked. It has never worked; no sales accounts existed yet, so
//   nobody had clicked it.
//
// Both follow from the same fact -- anon cannot be scoped by a row policy --
// so both are fixed the same way: SECURITY DEFINER functions that VALIDATE the
// caller's portal account against v2_portal_accounts instead of believing the
// caller, and that check the wholesaler of the client AND of the variant so an
// override can never straddle two tenants.
//
// Every function below therefore takes accountId first. For an owner or
// wholesaler (a real Supabase Auth session) it is ignored -- their JWT is the
// credential -- so one code path serves all three kinds of actor.
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function listClientOverrides(accountId, clientId) {
  const { data } = await sbCall(
    supabase.rpc("v2_client_overrides_list", { p_account_id: accountId || null, p_client_id: clientId })
  );
  return (data || []).map((o) => ({
    id: o.id,
    variantId: o.variant_id,
    overridePrice: Number(o.override_price),
    note: o.note,
    basePrice: Number(o.base_price ?? 0),
    sku: o.sku,
    productName: o.product_name || "Product",
    color: o.color,
    size: o.size,
  }));
}

/** Returns { ok, error, id }. The error text is the database's own message
 * ("That product and that client belong to different wholesalers.", "You are
 * not allowed to price for that client.") -- passed through unchanged, because
 * it names the actual reason and anything vaguer would be the app knowing more
 * than it says. */
export async function setClientOverride(accountId, clientId, variantId, overridePrice, note, createdBy) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_client_override", {
      p_account_id: accountId || null,
      p_client_id: clientId,
      p_variant_id: variantId,
      p_price: overridePrice,
      p_note: note || null,
      p_created_by: createdBy || null,
    })
  );
  if (error) return { ok: false, error: error.message, id: null };
  const row = data?.[0];
  return { ok: !!row?.ok, error: row?.error || null, id: row?.id || null };
}

export async function removeClientOverride(accountId, id) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_remove_client_override", { p_account_id: accountId || null, p_id: id })
  );
  if (error) return { ok: false, error: error.message };
  const row = data?.[0];
  return { ok: !!row?.ok, error: row?.error || null };
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
