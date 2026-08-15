// OGGI Wholesale v2 — wholesaler-side "Team & Buyers" data access (Batch 14)
//
// Portal account CREATION stays on devAuth.createPortalAccount (identity
// machinery, same reasoning as login/invite -- it hashes a password via
// a SECURITY DEFINER RPC and must never be done as a raw client-side
// insert). This module is just the read/manage side: listing existing
// buyer + sales accounts for the caller's own wid, and toggling one
// active/inactive. Both are plain table operations because
// v2_portal_accounts_admin_scoped RLS (migration 022) already restricts
// them to the owner or the matching wholesaler -- no RPC needed for
// operations that don't touch a password.
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function listPortalAccounts(wid) {
  const { data } = await sbCall(
    supabase.from("v2_portal_accounts")
      .select("id,role,username,actor_label,client_id,active,created_at")
      .eq("wid", wid)
      .order("created_at", { ascending: false })
  );
  return data || [];
}

export async function setPortalAccountActive(accountId, active) {
  return sbCall(supabase.from("v2_portal_accounts").update({ active, updated_at: new Date().toISOString() }).eq("id", accountId));
}
