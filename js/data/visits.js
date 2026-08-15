// OGGI Wholesale v2 — visit logging (Batch 4)
import { supabase, sbCall } from "../lib/supabase-client.js";

export async function logVisit(wid, { clientId, repLabel, note }) {
  return sbCall(supabase.from("v2_visit_log").insert({ wid, client_id: clientId, rep_label: repLabel, note: note || null }).select().single());
}

export async function getVisits(wid, limit = 50) {
  const { data } = await sbCall(
    supabase.from("v2_visit_log").select("*, v2_clients(shop_name)").eq("wid", wid).order("visited_at", { ascending: false }).limit(limit)
  );
  return (data || []).map((v) => ({
    id: v.id, repLabel: v.rep_label, note: v.note, visitedAt: v.visited_at,
    clientName: v.v2_clients?.shop_name || "(client removed)",
  }));
}
