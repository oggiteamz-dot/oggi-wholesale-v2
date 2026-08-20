// OGGI Wholesale v2 — client directory (Batch 4)
import { supabase, sbCall } from "../lib/supabase-client.js";

/** Clients sorted by recency of their last order (most recent first, nulls
 * — never-ordered clients — last). This is the actual "recency-sorted
 * client list" feature, not just an alphabetical list, computed from real
 * order history rather than a stored-and-drifting last_order_at column. */
export async function getClientsByRecency(wid) {
  const [{ data: clients }, { data: orders }] = await Promise.all([
    // CHANGED 20 Aug 2026 (migration 059): this used to filter
    // .eq("active", true), which meant a BANNED client silently vanished
    // from the wholesaler's own list the moment they were banned.
    //
    // That is exactly wrong. Every mature product that has this feature
    // (Slack, GitLab, Discourse) keeps a banned record visible in the
    // main list with a badge, because a ban you cannot see is a ban you
    // cannot lift, cannot explain to your own staff, and cannot audit.
    // Hadi's words were "it's VISUAL that this person cannot access
    // anything" -- invisible is the opposite of that.
    //
    // So we now select active + banned + pending, and exclude only
    // 'archived' (the old deactivate, which does mean "hide from my
    // working list"). The row renders differently per status.
    sbCall(supabase.from("v2_clients").select("*").eq("wid", wid).in("status", ["active", "banned", "pending"])),
    // FIXED 2026-08-17 (CR-0001 step 0) -- we now also select `client_id`,
    // and we match on it. See the comment block below for why.
    sbCall(supabase.from("v2_orders").select("client_id, buyer_label, created_at, subtotal").eq("wid", wid).order("created_at", { ascending: false })),
  ]);

  // ------------------------------------------------------------------
  // WHY THIS MATCHES ON client_id AND NOT ON buyer_label
  //
  // This code used to pair an order with a client by comparing
  //     order.buyer_label  ===  client.shop_name
  // which looks reasonable and is wrong, because those two fields hold
  // different KINDS of thing:
  //
  //   * buyer_label is a PERSON'S display name. The server sets it from
  //     the logged-in account's actor_label (see migration 024, the line
  //     `buyer_label := v_account.actor_label`) -- e.g. "Hadi Hamza".
  //   * shop_name is a BUSINESS name -- e.g. "Beirut Fashion House".
  //
  // They almost never coincide, so the comparison quietly found nothing
  // and every client read back as 0 orders / never ordered. It failed
  // SILENTLY: no error, no empty state, just confident wrong numbers on
  // the wholesaler dashboard, the rep dashboard, the coverage snapshot,
  // and this list's own sort order.
  //
  // Verified against live data on 2026-08-17: the only real order had
  // buyer_label "Demo Buyer" and matched no shop_name at all.
  //
  // v2_orders.client_id is the authoritative link. It is a real foreign
  // key, and migration 024 populates it server-side from the buyer's own
  // account, so it cannot drift the way a name comparison can.
  //
  // NOTE, deliberately not "fixed": an order whose client_id is NULL is
  // attributed to NO client. That is correct, not a bug -- it means the
  // order came from an account that was never linked to a client record
  // (the seeded "demo" buyer is one). Falling back to the old name match
  // for those would re-introduce the exact silent wrongness above, so we
  // don't. If such orders ever need attributing, link the account to a
  // client record; don't guess from a name.
  // ------------------------------------------------------------------
  const lastOrderByClient = new Map();
  const orderCountByClient = new Map();
  const totalByClient = new Map();
  (orders || []).forEach((o) => {
    if (!o.client_id) return; // unattributed on purpose -- see note above
    if (!lastOrderByClient.has(o.client_id)) lastOrderByClient.set(o.client_id, o.created_at);
    orderCountByClient.set(o.client_id, (orderCountByClient.get(o.client_id) || 0) + 1);
    totalByClient.set(o.client_id, (totalByClient.get(o.client_id) || 0) + Number(o.subtotal));
  });

  const enriched = (clients || []).map((c) => ({
    ...c,
    lastOrderAt: lastOrderByClient.get(c.id) || null,
    orderCount: orderCountByClient.get(c.id) || 0,
    lifetimeValue: totalByClient.get(c.id) || 0,
  }));

  return enriched.sort((a, b) => {
    // Banned clients stay in the list (see the note above) but sink to
    // the bottom, so they never sit between two customers you actually
    // trade with.
    const aBanned = a.status === "banned", bBanned = b.status === "banned";
    if (aBanned !== bBanned) return aBanned ? 1 : -1;
    if (!a.lastOrderAt && !b.lastOrderAt) return a.shop_name.localeCompare(b.shop_name);
    if (!a.lastOrderAt) return 1;
    if (!b.lastOrderAt) return -1;
    return new Date(b.lastOrderAt) - new Date(a.lastOrderAt);
  });
}

/** SUPERSEDED 20 Aug 2026 by createClient() below, and kept only because
 *  something else may still import it. It inserts a CRM row with NO login,
 *  which is the state that made SQUARE's account authenticate into nowhere
 *  on 17 Aug -- a client who cannot sign in is not a client. Do not use it
 *  for new work. */
export async function addClient(wid, { shopName, phone, note, discountPct }) {
  return sbCall(supabase.from("v2_clients").insert({
    wid, shop_name: shopName, phone: phone || null, note: note || null, discount_pct: discountPct || 0,
  }).select().single());
}

/** Create a client AND their login in one transaction (migration 060).
 *
 *  Everything that decides whether this is allowed happens server-side in
 *  v2_create_client: the six required fields, the duplicate-phone check,
 *  the duplicate-username check, the password hashing. This function does
 *  not validate -- it relays. If it looks like it is enforcing something,
 *  that is a mistake waiting to happen.
 *
 *  `temp_password` comes back ONLY when the server generated one, and only
 *  in this one response. It is never stored readable and cannot be fetched
 *  again -- only reset. */
export async function createClient({
  shopName, ownerName, phone, sells, username, password = null,
  discountPct = 0, accessTier = 1, extra = {},
}) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_create_client", {
      p_shop_name: shopName,
      p_owner_name: ownerName,
      p_phone: phone,
      p_sells: sells,
      p_username: username,
      p_password: password,
      p_discount_pct: discountPct,
      p_access_tier: accessTier,
      p_extra: extra,
    })
  );
  if (error) return { ok: false, msg: error.message || "Could not add this client." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "No response from the server." };
}

/** New one-time password for a client who forgot theirs. Also clears their
 *  login lockout -- someone who forgot a password has usually just failed
 *  ten attempts, and resetting into a locked account looks identical to the
 *  reset not having worked. */
export async function resetClientPassword(clientId) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_reset_client_password", { p_client_id: clientId })
  );
  if (error) return { ok: false, msg: error.message || "Could not reset the password." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "No response from the server." };
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
