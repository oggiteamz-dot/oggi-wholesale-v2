// OGGI Wholesale v2 — cart data access (Batch 2)
// Cart lines hold a soft stock RESERVATION (v2_reserve_stock, 15 min TTL)
// per line, not just a client-side number. This is the real fix for the
// #1 buyer complaint from Research 3 (in-place quantity editing) done
// properly: editing qty releases the old reservation and creates a fresh
// one for the new amount, so the buyer can never edit their way past real
// stock, and their held stock isn't silently gone if they change their mind.
// Cart lines are persisted to localStorage so a page reload doesn't lose
// the cart (the underlying Supabase reservations already have their own
// server-side TTL as the real backstop).

import { supabase, sbCall } from "../lib/supabase-client.js";

// `scope` is normally just the wid (one cart per buyer per wholesaler).
// Salespeople need MORE than that -- one concurrent cart PER CLIENT they're
// ordering on behalf of, so switching between two clients' in-progress
// orders never mixes their line items. Every function below takes an
// optional `scopeSuffix` (a client id) that gets appended to the storage
// scope; the real `wid` is always tracked separately and is what actually
// gets sent to the submit RPC, so scoping the cart never risks scoping the
// order itself incorrectly.
function scopeOf(wid, scopeSuffix) {
  return scopeSuffix ? `${wid}::${scopeSuffix}` : wid;
}

function cartKey(scope) {
  return `oggi-v2-cart-${scope}`;
}

function readCart(scope) {
  try {
    return JSON.parse(localStorage.getItem(cartKey(scope)) || "[]");
  } catch {
    return [];
  }
}

function writeCart(scope, lines) {
  localStorage.setItem(cartKey(scope), JSON.stringify(lines));
}

function getCartId(scope) {
  const key = `oggi-v2-cart-id-${scope}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export const cart = {
  get(wid, scopeSuffix) {
    return readCart(scopeOf(wid, scopeSuffix));
  },

  count(wid, scopeSuffix) {
    return readCart(scopeOf(wid, scopeSuffix)).reduce((sum, l) => sum + (l.isPack ? l.packQty : l.qty), 0);
  },

  /** Add a new line, or update an existing line for the same variant to a
   * NEW ABSOLUTE quantity (not a delta) -- this is the in-place edit path.
   * Returns { ok:true } or { ok:false, reason, maxAvailable } so the UI can
   * show "only N left" instead of a generic failure. */
  async setLineQty(wid, { variantId, productId, locationId, productName, color, colorHex, size, price, listPrice }, qty, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    const existing = lines.find((l) => l.variantId === variantId);

    if (qty <= 0) {
      if (existing) await this.removeLine(wid, variantId, scopeSuffix);
      return { ok: true };
    }

    if (existing) {
      await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: existing.reservationId }));
    }

    const { data: reservation, error } = await sbCall(
      supabase.rpc("v2_reserve_stock", {
        p_variant_id: variantId,
        p_location_id: locationId,
        p_qty: qty,
        p_cart_id: getCartId(scope),
        p_buyer_id: null,
        p_ttl_minutes: 15,
      })
    );

    if (error || !reservation) {
      // reservation failed -- not enough available stock. Drop the old
      // line (its reservation was already released above) rather than
      // leave the cart pointing at a dead reservation id.
      writeCart(scope, lines.filter((l) => l.variantId !== variantId));
      return { ok: false, reason: "insufficient_stock" };
    }

    const newLine = {
      // Batch 8: productId (when the caller has it) lets the cart view
      // compute the same cross-colourway tiered-price nudge the product
      // card shows -- see js/views/buyer.js's cartView. Optional: reorder
      // call sites that don't pass it just don't get a nudge on that line,
      // never a broken cart.
      variantId, productId: productId || null, locationId, productName, color, colorHex, size, price,
      // Batch 5: the variant's LIST price, kept alongside the effective one.
      //
      // `price` is what this line was priced AT -- discount and quantity break
      // already applied. Re-pricing the cart from it would apply them a second
      // time. The cart screen re-fetches the real list prices, so this is only
      // the fallback for when that fetch fails; without it the fallback would
      // have to be `price`, and a failed lookup would quietly halve a
      // discounted line. Optional, so a line written by an older build (which
      // has no listPrice) still works.
      listPrice: listPrice != null ? Number(listPrice) : null,
      qty, reservationId: reservation.id,
      expiresAt: reservation.expires_at,
    };
    const next = existing
      ? lines.map((l) => (l.variantId === variantId ? newLine : l))
      : [...lines, newLine];
    writeCart(scope, next);
    return { ok: true };
  },

  async removeLine(wid, variantId, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    const existing = lines.find((l) => l.variantId === variantId);
    if (existing) {
      await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: existing.reservationId }));
    }
    writeCart(scope, lines.filter((l) => l.variantId !== variantId));
  },

  // ---------- Prepack / ratio-pack lines (Batch 7) ----------
  //
  // A pack is still, underneath, one soft reservation PER real component
  // variant -- it reuses the exact same v2_reserve_stock/v2_release_
  // reservation RPCs every plain line uses. The only new thing is that the
  // cart stores those reservations grouped under one `packLineId` so the
  // UI can render "2x Boutique Pack – Style ABC, Blue" as a single line
  // instead of exploding it into N per-size rows.

  /** Reserves stock for every component of a pack (qtyPerPack × packQty
   * each) and stores them as one pack line. If ANY component's stock
   * can't be reserved, every reservation made so far for this call is
   * released and the whole add fails -- never a partially-reserved pack. */
  async addPack(wid, pack, packQty, locationId, scopeSuffix, { productId = null } = {}) {
    const scope = scopeOf(wid, scopeSuffix);
    if (packQty <= 0) return { ok: false, reason: "invalid_qty" };

    const reserved = [];
    for (const c of pack.components) {
      const { data: reservation, error } = await sbCall(
        supabase.rpc("v2_reserve_stock", {
          p_variant_id: c.variantId,
          p_location_id: locationId,
          p_qty: c.qtyPerPack * packQty,
          p_cart_id: getCartId(scope),
          p_buyer_id: null,
          p_ttl_minutes: 15,
        })
      );
      if (error || !reservation) {
        for (const r of reserved) await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: r.reservationId }));
        return { ok: false, reason: "insufficient_stock", sku: c.sku };
      }
      reserved.push({ variantId: c.variantId, qtyPerPack: c.qtyPerPack, sku: c.sku, color: c.color, size: c.size, reservationId: reservation.id, expiresAt: reservation.expires_at });
    }

    const lines = readCart(scope);
    const newLine = {
      isPack: true, packLineId: crypto.randomUUID(), packId: pack.id,
      packName: pack.name, packColor: pack.color, price: pack.price, locationId,
      // Batch 5: which product this pack belongs to.
      //
      // Without it a pack line was invisible to the quantity-break aggregate,
      // because every aggregate in the app filtered on `variantId` and a pack
      // line has `components` instead. A buyer ordering 120 pieces as ten
      // packs was counted as ordering ZERO, so the break they had earned was
      // never shown -- while v2_submit_order applied it anyway and invoiced
      // them less than the cart they had approved.
      //
      // `productId` falls back to the pack's own product when the caller does
      // not pass one, so this is correct even for the reorder path.
      productId: productId || pack.productId || null,
      // Pieces per pack, so a screen can say "x12" without walking components.
      unitCount: pack.unitCount != null ? pack.unitCount : (pack.components || []).reduce((s2, c) => s2 + c.qtyPerPack, 0),
      packQty, components: reserved,
    };
    writeCart(scope, [...lines, newLine]);
    return { ok: true };
  },

  /** In-place pack qty edit -- release the old per-component reservations
   * and re-reserve at the new pack qty, same release-then-reserve pattern
   * as setLineQty. */
  async updatePackQty(wid, packLineId, newPackQty, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    const existing = lines.find((l) => l.isPack && l.packLineId === packLineId);
    if (!existing) return { ok: false, reason: "not_found" };

    for (const c of existing.components) {
      await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: c.reservationId }));
    }
    if (newPackQty <= 0) {
      writeCart(scope, lines.filter((l) => !(l.isPack && l.packLineId === packLineId)));
      return { ok: true };
    }

    const reserved = [];
    for (const c of existing.components) {
      const { data: reservation, error } = await sbCall(
        supabase.rpc("v2_reserve_stock", {
          p_variant_id: c.variantId,
          p_location_id: existing.locationId,
          p_qty: c.qtyPerPack * newPackQty,
          p_cart_id: getCartId(scope),
          p_buyer_id: null,
          p_ttl_minutes: 15,
        })
      );
      if (error || !reservation) {
        for (const r of reserved) await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: r.reservationId }));
        writeCart(scope, lines.filter((l) => !(l.isPack && l.packLineId === packLineId)));
        return { ok: false, reason: "insufficient_stock" };
      }
      reserved.push({ ...c, reservationId: reservation.id, expiresAt: reservation.expires_at });
    }
    writeCart(scope, lines.map((l) => (l.isPack && l.packLineId === packLineId ? { ...existing, packQty: newPackQty, components: reserved } : l)));
    return { ok: true };
  },

  async removePack(wid, packLineId, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    const existing = lines.find((l) => l.isPack && l.packLineId === packLineId);
    if (existing) {
      for (const c of existing.components) {
        await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: c.reservationId }));
      }
    }
    writeCart(scope, lines.filter((l) => !(l.isPack && l.packLineId === packLineId)));
  },

  async clear(wid, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    for (const l of lines) {
      if (l.isPack) {
        for (const c of l.components) await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: c.reservationId }));
      } else {
        await sbCall(supabase.rpc("v2_release_reservation", { p_reservation_id: l.reservationId }));
      }
    }
    writeCart(scope, []);
  },

  /** Submits the cart as a real order via the atomic v2_submit_order RPC.
   * On success, clears the local cart (reservations are now consumed).
   * On failure (e.g. a reservation expired mid-checkout, or a Batch 6
   * MOQ/pricing rule not being met), the cart is left alone so the buyer
   * doesn't lose their held items over a transient error.
   *
   * `unit_price` is still sent in the payload for backward-shaped calls,
   * but as of Batch 6 the server IGNORES it entirely and recomputes the
   * real price itself (override -> tier -> base) -- see
   * migrations/010_v2_pricing_moq_enforcement.sql. clientId (optional) is
   * how the server resolves this buyer's negotiated "Your Price" overrides
   * and first-order-vs-reorder MOQ; pass null/omit for a guest buyer with
   * no matching v2_clients record. accountId (Batch 14, optional) is the
   * real buyer session's v2_portal_accounts id -- when present, the
   * server uses ITS OWN wid/client_id/buyer_label from that account and
   * ignores whatever this call separately claims, closing the "submit an
   * order as any buyer_label" gap (see migrations/024's v2_submit_order
   * changes). Passing it is a strict improvement, never a behavior
   * change for a legitimate caller who already has a real session. */
  async submit(wid, { buyerLabel, locationId, notes, clientId, accountId, catalogId }, scopeSuffix) {
    const scope = scopeOf(wid, scopeSuffix);
    const lines = readCart(scope);
    if (!lines.length) return { ok: false, reason: "empty_cart" };

    // Pack lines expand into one payload entry PER COMPONENT (that's what
    // actually reserved stock and what the RPC needs to price/insert), all
    // sharing one pack_line_id so the order-history UI can re-collapse
    // them into a single "2x Boutique Pack" display line -- see
    // migrations/012_v2_prepack_enforcement.sql.
    const payload = lines.flatMap((l) => {
      if (l.isPack) {
        return l.components.map((c) => ({
          reservation_id: c.reservationId,
          variant_id: c.variantId,
          qty: c.qtyPerPack * l.packQty,
          unit_price: null,
          pack_id: l.packId,
          pack_line_id: l.packLineId,
          pack_qty: l.packQty,
        }));
      }
      return [{
        reservation_id: l.reservationId,
        variant_id: l.variantId,
        qty: l.qty,
        unit_price: l.price,
      }];
    });

    const { data: order, error } = await sbCall(
      supabase.rpc("v2_submit_order", {
        p_wid: wid,
        p_buyer_label: buyerLabel,
        p_location_id: locationId,
        p_lines: payload,
        p_client_id: clientId || null,
        p_account_id: accountId || null,
        // Migration 055. The catalog decides the discount, so the order has to
        // say which one it came through -- and the RPC checks the claim
        // against what this account is actually allowed to see, because
        // otherwise naming the deepest-discounted catalog would be a way to
        // pay its prices from anywhere.
        p_catalog_id: catalogId || null,
      })
    );

    if (error || !order) {
      return { ok: false, reason: "submit_failed", error };
    }

    writeCart(scope, []);
    return { ok: true, order };
  },
};
