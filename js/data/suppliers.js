// OGGI Wholesale v2 — suppliers: who the wholesaler buys from (Batch 17)
//
// Direction matters and the word is overloaded in this codebase: buyer.js's
// suppliers() screen means "the wholesalers I buy from" from a BUYER's seat.
// This module is the wholesaler's own supply chain -- their factories and
// vendors. It is never buyer-facing, and migration 050 revoked anon entirely,
// so every function here requires a real Supabase Auth session.
//
// Explicit column lists throughout, never select("*"): under a column-level
// grant "*" expands to every column including ungranted ones and the whole
// query is refused. That rule has now cost this codebase two separate outages
// (the 15 Aug cost leak, and getLocations in Batch 15), so it is applied here
// pre-emptively rather than after the third.

import { supabase, sbCall } from "../lib/supabase-client.js";

const COLS = "id, wid, name, contact_name, phone, email, address, country, ref_code, notes, archived, created_at";

function shape(r) {
  return {
    id: r.id,
    wid: r.wid,
    name: r.name,
    contactName: r.contact_name || "",
    phone: r.phone || "",
    email: r.email || "",
    address: r.address || "",
    country: r.country || "",
    refCode: r.ref_code || "",
    notes: r.notes || "",
    archived: !!r.archived,
    createdAt: r.created_at,
  };
}

/** Live suppliers for this wholesaler, alphabetically -- a sourcing list is
 *  something people scan by name, not by when it was added. */
export async function listSuppliers(wid, { includeArchived = false } = {}) {
  let q = supabase.from("v2_suppliers").select(COLS).eq("wid", wid);
  if (!includeArchived) q = q.eq("archived", false);
  const { data } = await sbCall(q.order("name", { ascending: true }));
  return (data || []).map(shape);
}

export async function createSupplier(wid, form) {
  const name = String(form?.name || "").trim();
  if (!name) return { ok: false, error: "Give the supplier a name." };

  const { data, error } = await sbCall(
    supabase.from("v2_suppliers").insert({
      wid,
      name,
      contact_name: form.contactName?.trim() || null,
      phone: form.phone?.trim() || null,
      email: form.email?.trim() || null,
      address: form.address?.trim() || null,
      country: form.country?.trim() || null,
      ref_code: form.refCode?.trim() || null,
      notes: form.notes?.trim() || null,
    }).select(COLS).single()
  );

  if (error) {
    // 23505 is the (wid, lower(name)) unique index. Saying so beats "failed to
    // save": the wholesaler already has this supplier and wants to pick it, not
    // create it again.
    if (error.code === "23505") {
      return { ok: false, error: `You already have a supplier called "${name}".` };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, supplier: shape(data) };
}

export async function updateSupplier(id, form) {
  const patch = { updated_at: new Date().toISOString() };
  if (form.name !== undefined) {
    const n = String(form.name || "").trim();
    if (!n) return { ok: false, error: "Give the supplier a name." };
    patch.name = n;
  }
  const map = {
    contactName: "contact_name", phone: "phone", email: "email",
    address: "address", country: "country", refCode: "ref_code", notes: "notes",
  };
  for (const [k, col] of Object.entries(map)) {
    if (form[k] !== undefined) patch[col] = String(form[k] || "").trim() || null;
  }

  const { data, error } = await sbCall(
    supabase.from("v2_suppliers").update(patch).eq("id", id).select(COLS).single()
  );
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Another supplier already has that name." };
    return { ok: false, error: error.message };
  }
  return { ok: true, supplier: shape(data) };
}

/** Archive rather than delete. Products keep pointing at the row (050 uses
 *  on delete set null, so a real delete would silently erase the sourcing on
 *  every product bought from them), and archiving frees the name for reuse
 *  because the unique index only covers live rows. */
export async function archiveSupplier(id) {
  const { error } = await sbCall(
    supabase.from("v2_suppliers")
      .update({ archived: true, updated_at: new Date().toISOString() })
      .eq("id", id)
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function restoreSupplier(id) {
  const { error } = await sbCall(
    supabase.from("v2_suppliers")
      .update({ archived: false, updated_at: new Date().toISOString() })
      .eq("id", id)
  );
  if (error && error.code === "23505") {
    return { ok: false, error: "A live supplier already has that name — rename it first." };
  }
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** How many products each supplier is on, so the Suppliers screen can show it
 *  BEFORE someone archives one -- the same reasoning as showing stock next to a
 *  location before offering to archive it. */
export async function supplierProductCounts(wid) {
  const { data } = await sbCall(
    supabase.from("v2_products").select("supplier_id").eq("wid", wid)
  );
  const counts = new Map();
  (data || []).forEach((r) => {
    if (!r.supplier_id) return;
    counts.set(r.supplier_id, (counts.get(r.supplier_id) || 0) + 1);
  });
  return counts;
}
