// OGGI Wholesale v2 — wholesaler settings (Batch 8)
// Thin CRUD wrapper around the catalog-UX columns added to v2_wholesalers
// by migrations/013_v2_catalog_ux_settings.sql. Deliberately separate from
// js/data/catalog.js (which reads the same table for buyer-facing display)
// so the write path used by the wholesaler admin Settings screen has its
// own single call site -- same discipline as wholesaler-orders.js's
// advanceOrderStatus comment about having one gate-able call site once real
// auth lands in Batch 14.

import { supabase, sbCall } from "../lib/supabase-client.js";

export async function getWholesalerSettings(wid) {
  const { data } = await sbCall(
    supabase.from("v2_wholesalers").select("wid,low_moq_threshold,trust_message,return_policy,payment_terms,card_facts").eq("wid", wid).maybeSingle()
  );
  return data || { wid, low_moq_threshold: 12, trust_message: null, return_policy: null, payment_terms: null, card_facts: null };
}

/** patch may include any of: lowMoqThreshold (number), trustMessage,
 * returnPolicy, paymentTerms (strings, empty string clears to null). */
export async function updateWholesalerSettings(wid, patch) {
  const row = {};
  if (patch.lowMoqThreshold != null) row.low_moq_threshold = Math.max(1, parseInt(patch.lowMoqThreshold, 10) || 12);
  if ("trustMessage" in patch) row.trust_message = patch.trustMessage?.trim() || null;
  if ("returnPolicy" in patch) row.return_policy = patch.returnPolicy?.trim() || null;
  if ("paymentTerms" in patch) row.payment_terms = patch.paymentTerms?.trim() || null;
  // Migration 054. Written as an array, never a comma string: Postgres text[]
  // and a string that happens to contain commas are not the same thing, and
  // the difference only shows up on a warehouse whose name has a comma in it.
  if (Array.isArray(patch.cardFacts)) row.card_facts = patch.cardFacts;
  row.updated_at = new Date().toISOString();
  return sbCall(supabase.from("v2_wholesalers").update(row).eq("wid", wid));
}
