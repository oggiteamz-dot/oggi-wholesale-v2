// OGGI Wholesale v2 — client bans (migration 059)
//
// Hadi, 20 Aug 2026: "whenever he has a client and he wants them out, he
// can simply just say banned. Like click a button, okay, this person is
// banned. And it's visual that this person cannot access anything that
// has to do with this wholesaler."
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------
// It does not enforce anything. Every function here is a thin call to a
// SECURITY DEFINER RPC that re-checks ownership and does the real work in
// one transaction (write the ban record AND switch off the buyer's
// logins). If this file were deleted, the ban would still hold; if this
// file were the only thing stopping a banned buyer, the ban would be
// decoration. See migration 059's header for the enforcement points.
import { supabase, sbCall } from "../lib/supabase-client.js";

// The seven reasons a wholesaler can throw someone out. `bad_conduct` is
// Hadi's own addition, in his words: "bad business conduct... this is not
// a person I want to do business with anymore."
//
// There is no free-text-only option by design: a ban with no code cannot
// be counted, filtered or explained six months later, and "banned with no
// reason given" is the single most-complained-about behaviour on every
// platform researched for this feature.
export const BAN_REASONS = [
  { code: "non_payment",    label: "Did not pay",              hint: "Owes money or repeatedly pays late." },
  { code: "bad_conduct",    label: "Bad business conduct",     hint: "Not someone I want to do business with anymore." },
  { code: "abusive",        label: "Abusive to staff",         hint: "Rude, threatening or harassing." },
  { code: "price_leakage",  label: "Sharing my prices",        hint: "Passing my catalogue or prices to competitors." },
  { code: "duplicate",      label: "Duplicate account",        hint: "Same person, second account." },
  { code: "not_a_business", label: "Not a real business",      hint: "Not an actual shop." },
  { code: "other",          label: "Other (say why)",          hint: "Requires an explanation." },
];

export function banReasonLabel(code) {
  return BAN_REASONS.find((r) => r.code === code)?.label || code || "—";
}

/** Ban a client. Returns { ok, msg, ban_id }.
 *  `reasonText` is REQUIRED when reasonCode is "other" — the database
 *  refuses it otherwise (constraint v2_client_bans_other_needs_text), so
 *  this cannot be bypassed by calling the RPC directly. */
export async function banClient(clientId, reasonCode, reasonText) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_ban_client", {
      p_client_id: clientId,
      p_reason_code: reasonCode,
      p_reason_text: reasonText || null,
    })
  );
  if (error) return { ok: false, msg: error.message || "Could not ban this client." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "No response from the server." };
}

/** Lift a ban. The ban record is NOT deleted — it is stamped as reversed,
 *  so "this client has been thrown out before" stays answerable. */
export async function unbanClient(clientId, note) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_unban_client", { p_client_id: clientId, p_note: note || null })
  );
  if (error) return { ok: false, msg: error.message || "Could not lift this ban." };
  const row = Array.isArray(data) ? data[0] : data;
  return row || { ok: false, msg: "No response from the server." };
}

/** Full ban history for one client — every episode, including lifted
 *  ones, newest first. Powers the client detail page. */
export async function getBanHistory(clientId) {
  const { data } = await sbCall(
    supabase.from("v2_client_bans").select("*").eq("client_id", clientId).order("banned_at", { ascending: false })
  );
  return data || [];
}

/** The live ban for each client, keyed by client_id, for one wholesaler.
 *  One query for the whole list rather than one per row. */
export async function getLiveBansByClient(wid) {
  const { data } = await sbCall(
    supabase.from("v2_client_bans").select("*").eq("wid", wid).is("reversed_at", null)
  );
  const map = new Map();
  (data || []).forEach((b) => map.set(b.client_id, b));
  return map;
}
