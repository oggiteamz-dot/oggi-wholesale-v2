// OGGI Wholesale v2 — visit logging (Batch 4)
import { supabase, sbCall } from "../lib/supabase-client.js";
import { salesVisits, salesLogVisit } from "./sales-reads.js";

export async function logVisit(wid, { clientId, repLabel, note }) {
  // A rep writes through migration 140's definer function, which re-derives the
  // wid from their account and refuses a client_id belonging to another store.
  // The direct insert below runs as `anon` for a rep and is refused outright.
  const viaRep = await salesLogVisit({ clientId, repLabel, note });
  if (viaRep) return viaRep.ok ? { data: { id: viaRep.id }, error: null }
                               : { data: null, error: { message: viaRep.msg } };
  return sbCall(supabase.from("v2_visit_log").insert({ wid, client_id: clientId, rep_label: repLabel, note: note || null }).select().single());
}

export async function getVisits(wid, limit = 50) {
  // Same seam as logVisit. v2_sales_visits already joins the shop name, so the
  // mapping below is shared rather than duplicated.
  const rep = await salesVisits(limit);
  if (rep) return rep.map((v) => ({
    id: v.id, repLabel: v.rep_label, note: v.note, visitedAt: v.visited_at,
    clientName: v.shop_name || "(client removed)",
  }));
  const { data } = await sbCall(
    supabase.from("v2_visit_log").select("*, v2_clients(shop_name)").eq("wid", wid).order("visited_at", { ascending: false }).limit(limit)
  );
  return (data || []).map((v) => ({
    id: v.id, repLabel: v.rep_label, note: v.note, visitedAt: v.visited_at,
    clientName: v.v2_clients?.shop_name || "(client removed)",
  }));
}
