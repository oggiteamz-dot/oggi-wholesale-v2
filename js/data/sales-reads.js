// =============================================================================
// OGGI Wholesale v2 — THE SALESPERSON'S READ PATH        18 Sep 2026, migration 140
// =============================================================================
//
// WHY THIS MODULE EXISTS
// ----------------------
// js/data/clients.js, wholesaler-orders.js and visits.js go straight at
// v2_clients, v2_orders and v2_visit_log. Signed in as a WHOLESALER that works:
// the browser holds a real Supabase Auth JWT, runs as `authenticated`, and RLS
// lets it through. Signed in as a SALESPERSON the identical call runs as `anon`
// -- which Batch S (085) revoked every table grant from -- and answers
//
//     42501  permission denied for table v2_clients
//
// So /sales/clients, /sales/orders and /sales/visits rendered empty. Three of
// the rep's four screens, broken since 28 August, invisible because the two
// roles share the same data modules and everyone tested as the wholesaler.
//
// Migration 140 gives the rep the same shape through SECURITY DEFINER functions
// that re-derive the wid from the account id. This module is the seam: one
// place that answers "is the person reading this a rep, and if so which
// account", so the three call sites each gain two lines instead of a fork.
//
// ⚠️ THE ACCOUNT ID IS A CLAIM, NOT A CREDENTIAL. Nothing here is a security
// boundary -- a browser could pass any uuid. The check is in the database:
// v2_sales_wid re-reads the account, re-checks role='sales', that the account
// is active and that its store is active, and every function returns zero rows
// if any of that fails. This file only decides WHICH CALL to make.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";
import { devAuth } from "../lib/dev-auth.js";

/** The rep's account id, or null when the reader is not a rep. */
export function salesAccountId() {
  const s = devAuth.getSession();
  if (!s || s.role !== "sales") return null;
  return s.accountId || s.actorId || null;
}

export async function salesClients() {
  const id = salesAccountId();
  if (!id) return null;                        // null = "not my path", not "no rows"
  const { data } = await sbCall(supabase.rpc("v2_sales_clients", { p_account_id: id }));
  return data || [];
}

export async function salesOrders(limit = 400) {
  const id = salesAccountId();
  if (!id) return null;
  const { data } = await sbCall(supabase.rpc("v2_sales_orders", { p_account_id: id, p_limit: limit }));
  return data || [];
}

export async function salesVisits(limit = 100) {
  const id = salesAccountId();
  if (!id) return null;
  const { data } = await sbCall(supabase.rpc("v2_sales_visits", { p_account_id: id, p_limit: limit }));
  return data || [];
}

export async function salesLogVisit({ clientId, repLabel, note }) {
  const id = salesAccountId();
  if (!id) return null;
  const { data, error } = await sbCall(supabase.rpc("v2_sales_log_visit", {
    p_account_id: id, p_client_id: clientId, p_rep_label: repLabel || null, p_note: note || null,
  }));
  if (error) return { ok: false, msg: "Could not save that just now." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "Could not save that just now." };
}
