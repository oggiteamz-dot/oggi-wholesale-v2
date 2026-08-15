// OGGI Wholesale v2 — client directory (Batch 4)
import { supabase, sbCall } from "../lib/supabase-client.js";

/** Clients sorted by recency of their last order (most recent first, nulls
 * — never-ordered clients — last). This is the actual "recency-sorted
 * client list" feature, not just an alphabetical list, computed from real
 * order history rather than a stored-and-drifting last_order_at column. */
export async function getClientsByRecency(wid) {
  const [{ data: clients }, { data: orders }] = await Promise.all([
    sbCall(supabase.from("v2_clients").select("*").eq("wid", wid).eq("active", true)),
    sbCall(supabase.from("v2_orders").select("buyer_label, created_at, subtotal").eq("wid", wid).order("created_at", { ascending: false })),
  ]);

  const lastOrderByBuyer = new Map();
  const orderCountByBuyer = new Map();
  const totalByBuyer = new Map();
  (orders || []).forEach((o) => {
    if (!lastOrderByBuyer.has(o.buyer_label)) lastOrderByBuyer.set(o.buyer_label, o.created_at);
    orderCountByBuyer.set(o.buyer_label, (orderCountByBuyer.get(o.buyer_label) || 0) + 1);
    totalByBuyer.set(o.buyer_label, (totalByBuyer.get(o.buyer_label) || 0) + Number(o.subtotal));
  });

  const enriched = (clients || []).map((c) => ({
    ...c,
    lastOrderAt: lastOrderByBuyer.get(c.shop_name) || null,
    orderCount: orderCountByBuyer.get(c.shop_name) || 0,
    lifetimeValue: totalByBuyer.get(c.shop_name) || 0,
  }));

  return enriched.sort((a, b) => {
    if (!a.lastOrderAt && !b.lastOrderAt) return a.shop_name.localeCompare(b.shop_name);
    if (!a.lastOrderAt) return 1;
    if (!b.lastOrderAt) return -1;
    return new Date(b.lastOrderAt) - new Date(a.lastOrderAt);
  });
}

export async function addClient(wid, { shopName, phone, note, discountPct }) {
  return sbCall(supabase.from("v2_clients").insert({
    wid, shop_name: shopName, phone: phone || null, note: note || null, discount_pct: discountPct || 0,
  }).select().single());
}

export async function deactivateClient(clientId) {
  return sbCall(supabase.from("v2_clients").update({ active: false, updated_at: new Date().toISOString() }).eq("id", clientId));
}

/** Coverage snapshot: how many active clients have ordered in the last 30
 * days vs. gone quiet. Real signal for a rep planning their week, not a
 * vanity count. */
export function coverageSnapshot(clients) {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 86400000;
  const coveredRecently = clients.filter((c) => c.lastOrderAt && now - new Date(c.lastOrderAt).getTime() < THIRTY_DAYS).length;
  const neverOrdered = clients.filter((c) => !c.lastOrderAt).length;
  return { total: clients.length, coveredRecently, needsAttention: clients.length - coveredRecently - neverOrdered, neverOrdered };
}
