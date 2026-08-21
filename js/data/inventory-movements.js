// OGGI Wholesale v2 — the stock movement ledger (Batch 2, migrations 069/070/071)
//
// v2_inventory_movements has been written correctly by every stock RPC since
// migration 001 and displayed NOWHERE. 236 rows of real audit trail that no
// wholesaler could see. This is the read path.
//
// TWO THINGS WERE FIXED BEFORE THIS FILE COULD EXIST, both found by starting
// the batch with "what does the read policy on this table actually say":
//
//   069 — the table shipped with `using (true)`. RLS was ENABLED, which is
//         what made it dangerous: every "is RLS on?" audit answered yes while
//         the policy underneath permitted everything. Proven on production
//         from a browser holding only the publishable key: 236 rows across
//         ALL SIX wholesalers, readable anonymously, attributable by name.
//         The movement ledger is the most commercially sensitive table in the
//         system — exactly what a rival received, when, how much, and why.
//
//   070 — only 9 of 236 rows recorded WHO. Every JS call site passed
//         `p_actor_id: null`. Now the RPCs fall back to auth.uid(), so the
//         answer comes from the session and cannot be spoofed by a caller.
//
// Everything below reads through v2_movement_ledger(), which does the four
// joins and the filtering server-side. Doing it here would be four round
// trips and an N+1 per page, and would put the tenant scoping in the browser.

import { supabase, sbCall } from "../lib/supabase-client.js";

/** The movement types the ledger can show, with the plain-English label a
 *  wholesaler would actually use and the direction stock moved.
 *  `sign` is what the row MEANS, not merely the arithmetic: a reservation
 *  removes stock from the sellable pool without any of it leaving the
 *  building, which is why it reads as neutral rather than as a loss. */
export const MOVEMENT_TYPES = Object.freeze({
  receive:          { label: "Received",        tone: "in",      blurb: "stock arrived" },
  sale:             { label: "Sold",            tone: "out",     blurb: "went out against an order" },
  reserve:          { label: "Held for a cart", tone: "neutral", blurb: "set aside while a buyer checks out — still in the building" },
  release:          { label: "Hold released",   tone: "neutral", blurb: "a cart hold expired or was cancelled — back on sale" },
  transfer_in:      { label: "Transferred in",  tone: "in",      blurb: "arrived from another warehouse" },
  transfer_out:     { label: "Transferred out", tone: "out",     blurb: "sent to another warehouse" },
  adjustment:       { label: "Adjusted",        tone: "neutral", blurb: "corrected by hand" },
  count_correction: { label: "Count correction",tone: "neutral", blurb: "a physical count disagreed with the system" },
  kit_assembly:     { label: "Used in a kit",   tone: "out",     blurb: "consumed building a kit" },
});

/** Reference types, translated. A raw `reference_type` of "cart" tells the
 *  wholesaler nothing; "a buyer's cart" tells them where to look. */
export const REFERENCE_LABELS = Object.freeze({
  order: "an order", cart: "a buyer's cart", transfer: "a warehouse transfer",
  manual: "entered by hand", manual_receive: "entered by hand",
  count_correction: "a stock count", catalog_import: "a catalog import",
  kit: "a kit build", supplier_receipt: "a supplier receipt",
});

export function movementTypeLabel(type) {
  return MOVEMENT_TYPES[type]?.label || type || "—";
}
export function referenceLabel(refType) {
  if (!refType) return null;
  return REFERENCE_LABELS[refType] || refType.replace(/_/g, " ");
}

/**
 * A page of the ledger.
 *
 * Returns `{ rows, total, hasMore }`. `total` is the count under the CURRENT
 * filters, computed by the same query, so "50 of 236" is always consistent
 * with what is on screen — a separate count query can and does disagree with
 * the page beside it when data changes between the two.
 */
export async function getMovementLedger(wid, {
  productId = null, variantId = null, locationId = null,
  types = null, since = null, limit = 100, offset = 0,
} = {}) {
  const { data, error } = await sbCall(supabase.rpc("v2_movement_ledger", {
    p_product_id: productId,
    p_variant_id: variantId,
    p_location_id: locationId,
    // An empty array would mean "match nothing"; null means "no filter".
    p_types: types && types.length ? types : null,
    p_since: since,
    p_limit: limit,
    p_offset: offset,
    p_wid: wid || null,
  }));
  if (error || !data) return { rows: [], total: 0, hasMore: false, error: error || null };

  const rows = data.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    type: r.movement_type,
    qtyDelta: Number(r.qty_delta),
    productId: r.product_id,
    productName: r.product_name,
    variantId: r.variant_id,
    sku: r.sku,
    color: r.color,
    size: r.size,
    locationId: r.location_id,
    locationName: r.location_name,
    actorId: r.actor_id,
    // null on purpose where unknown. 227 of the first 236 rows predate
    // migration 070 and genuinely have no actor; the UI says "not recorded"
    // rather than inventing a name.
    actorLabel: r.actor_label || null,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    note: r.note,
  }));
  const total = data.length ? Number(data[0].total_count) : 0;
  return { rows, total, hasMore: offset + rows.length < total, error: null };
}

/** Every movement type actually present in this wholesaler's history, so the
 *  filter offers what they have rather than a fixed list of nine, seven of
 *  which return nothing. An empty filter dropdown option is a small lie. */
export async function getMovementTypesPresent(wid) {
  const { rows } = await getMovementLedger(wid, { limit: 500 });
  return [...new Set(rows.map((r) => r.type))].sort();
}
