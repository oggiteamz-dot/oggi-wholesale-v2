// OGGI Wholesale v2 — subscription / billing data layer (CR-0002)
//
// OGGI is sold as a subscription. Hadi collects the money himself and
// renews each wholesaler by hand, so what the software has to do is
// simple and unglamorous: record who has paid, until when, and for how
// much -- and never get that arithmetic wrong.
//
// ALL THE LOGIC IS IN THE DATABASE, NOT HERE. migrations/037 owns it,
// for one reason: extensions must stack from the customer's existing end
// date rather than from today. Doing that in the browser means every
// caller has to remember the rule, and the day one of them forgets, a
// paying customer silently loses months. One function, one rule, checked
// on the server.
//
// Two behaviours worth knowing before you change anything here:
//   * CANCEL keeps their remaining paid time -- they paid for it.
//   * TERMINATE (cancel with immediate=true) ends access today.
// They are separate on purpose. See the panel component for how they are
// kept visually distinct so one is never mistaken for the other.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** One row per wholesaler with the billing state already worked out
 * (is_paid_up, days_remaining, and a human status_label). Comes from the
 * v2_wholesaler_billing VIEW, so the console, any future access gate and
 * any report all read the same definition of "are they paid up" -- it is
 * computed from the date and cannot go stale like a stored flag. */
export async function getBillingByWholesaler() {
  //
  // 18 Aug 2026 (migration 042): reads the owner-checked FUNCTION, not the
  // view. v2_wholesaler_billing was created without security_invoker, which
  // means it runs with its owner's rights and bypasses row-level security on
  // v2_wholesalers completely -- and the anon role held SELECT on it. Every
  // wholesaler's subscription price, status and expiry date was readable with
  // the publishable key and no login at all.
  //
  // Worth stating plainly because it is not obvious: a definer view is a hole
  // straight THROUGH RLS, and it does not show up in pg_policies. Hardening
  // the base table would not have closed this. The view is now revoked from
  // both anon and authenticated, and v2_owner_billing_list() calls
  // v2_require_owner() before it returns a single byte.
  const { data } = await sbCall(supabase.rpc("v2_owner_billing_list"));
  const byWid = new Map();
  (data || []).forEach((r) => byWid.set(r.wid, r));
  return byWid;
}

/**
 * Adds paid time. Counted in MONTHS so any mix stacks: 1 + 6 + 12 all
 * add up rather than overwriting each other.
 * @param {string} wid
 * @param {number} months  1 = a month, 6 = six months, 12 = a year
 * @param {number} [amount] what they actually paid, for the record
 * @param {string} [note]
 */
export async function extendSubscription(wid, months, amount = null, note = null) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_extend_subscription", {
      p_wid: wid, p_months: months, p_amount: amount, p_note: note,
    })
  );
  if (error) return { ok: false, error: error.message || "Could not reach the server" };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, error: row?.error || "", paidUntil: row?.paid_until || null };
}

/**
 * @param {boolean} immediate  false = they keep the time they paid for
 *                             (the normal case). true = access ends today.
 */
export async function cancelSubscription(wid, reason = null, immediate = false) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_cancel_subscription", {
      p_wid: wid, p_reason: reason, p_immediate: immediate,
    })
  );
  if (error) return { ok: false, error: error.message || "Could not reach the server" };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, error: row?.error || "", paidUntil: row?.paid_until || null };
}

/** What this wholesaler pays per renewal. Per-wholesaler on purpose:
 * a negotiated rate must never be silently overwritten by a global one. */
export async function setPrice(wid, amount, currency = "$", period = "monthly") {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_wholesaler_price", {
      p_wid: wid, p_amount: amount, p_currency: currency, p_period: period,
    })
  );
  if (error) return { ok: false, error: error.message || "Could not reach the server" };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, error: row?.error || "" };
}

/** The money trail: every extension, price change and cancellation, newest
 * first. Append-only in the database -- nothing here can edit history. */
export async function getSubscriptionHistory(wid, limit = 50) {
  const { data } = await sbCall(
    supabase.from("v2_subscription_events").select("*")
      .eq("wid", wid).order("created_at", { ascending: false }).limit(limit)
  );
  return data || [];
}

/** Replaces a wholesaler's whole brand list. The FIRST entry becomes the
 * primary — the name buyers see — and is mirrored back into the legacy
 * `brand` column by the database so the two can never disagree. */
export async function setBrands(wid, brands) {
  const { data, error } = await sbCall(
    supabase.rpc("v2_set_wholesaler_brands", { p_wid: wid, p_brands: brands })
  );
  if (error) return { ok: false, error: error.message || "Could not reach the server" };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, error: row?.error || "", primaryBrand: row?.primary_brand || null };
}

/** All brands per wholesaler, primary first. */
export async function getBrandsByWholesaler() {
  const { data } = await sbCall(
    supabase.from("v2_wholesaler_brands").select("wid, name, is_primary, sort_order")
      .order("wid").order("sort_order")
  );
  const byWid = new Map();
  (data || []).forEach((b) => {
    if (!byWid.has(b.wid)) byWid.set(b.wid, []);
    byWid.get(b.wid).push(b);
  });
  return byWid;
}
