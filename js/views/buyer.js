// OGGI Wholesale v2 — Buyer views (Batch 2: real catalog, cart, orders)
import { emptyState } from "../components/empty-state.js";
import { renderProductCard } from "../components/product-card.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { supabase, sbCall } from "../lib/supabase-client.js";
import { getCatalog, getWholesaler, listWholesalers } from "../data/catalog.js";
import { cart } from "../data/cart.js";
import { getBuyerOrders, orderedTimesCount, getBuyerOrderedProductIds } from "../data/orders.js";
import { getPricingContext, resolveClientId, tierForQty, nextTier, effectivePrice, productMoqStatus, marginPct } from "../data/pricing.js";
import { listPacksForProducts, getPackById } from "../data/prepacks.js";
import { renderCatalogToolbar } from "../components/catalog-toolbar.js";
import { filterAndSortCatalog, defaultCatalogFilters } from "../data/catalog-filter.js";
import { renderTrustBadges } from "../components/trust-badges.js";
import { showOrderCelebration } from "../lib/animations/order-celebration.js";

import { esc, pageHeader } from "../lib/utils.js";
async function defaultLocation(wid) {
  const { data } = await sbCall(
    supabase.from("v2_locations").select("id,name").eq("wid", wid).eq("is_default", true).maybeSingle()
  );
  return data;
}

function buyerLabel() {
  const s = devAuth.getSession();
  return s?.actorLabel || "Dev Buyer";
}

// ---------- Catalog ----------

async function dashboard(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;

  // No "Switch supplier" action: switching implied a roster to switch
  // between, and that roster was the leak. See suppliers() below.
  outlet.appendChild(pageHeader("Catalog", `Browsing ${session.wholesalerName || wid}`));

  const skeletonWrap = document.createElement("div");
  skeletonWrap.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;";
  for (let i = 0; i < 6; i++) {
    const s = document.createElement("div");
    s.className = "skeleton card";
    s.style.height = "260px";
    skeletonWrap.appendChild(s);
  }
  outlet.appendChild(skeletonWrap);

  const [wholesaler, location, catalog] = await Promise.all([
    getWholesaler(wid),
    defaultLocation(wid),
    getCatalog(wid),
  ]);

  skeletonWrap.remove();

  if (!wholesaler) {
    outlet.appendChild(emptyState({
      icon: "🏢",
      title: `No wholesaler found for "${wid}"`,
      body: `Try one of the seeded demo wholesalers (mg, sq, omni, w1785168930020) from Switch supplier, or check the wid you logged in with.`,
    }));
    return;
  }

  if (!catalog.length) {
    outlet.appendChild(emptyState({
      icon: "📦",
      title: "No products yet",
      body: `${wholesaler.name} hasn't listed any products.`,
    }));
    return;
  }

  if (!location) {
    outlet.appendChild(emptyState({ icon: "⚠️", title: "No location configured", body: "This wholesaler has no default location, so orders can't be placed yet." }));
    return;
  }

  // Batch 6: tiered pricing / MOQ / negotiated-price context, fetched once
  // for the whole grid rather than per-card, plus which of these products
  // this buyer has already ordered (for the first-order vs. reorder MOQ
  // distinction) -- both are pure display/UX; the submit RPC re-derives
  // all of this itself and is the real authority (see cart.js/pricing.js).
  const label = buyerLabel();
  // Batch 14: v2_client_price_overrides' client_id is authoritative from
  // the real login response (session.clientId) now that buyers have a
  // real account -- prefer it, and only fall back to the old
  // shop_name-matching lookup for a session with no real accountId yet
  // (e.g. mid "switch supplier" browsing, see the suppliers() handler
  // below). The fallback itself now always resolves to null under the
  // Batch 14 RLS pass (v2_clients direct reads are wholesaler/owner-only)
  // -- that's the documented, safe "no override applies" default, not a
  // crash, so this stays a strict behavior improvement, never a break.
  const [clientId, orderedProductIds] = await Promise.all([
    session.clientId || resolveClientId(wid, label),
    getBuyerOrderedProductIds(session.accountId),
  ]);
  const [{ tiersByProduct, overridesByVariant }, packsByProduct] = await Promise.all([
    getPricingContext(catalog.map((p) => p.id), clientId),
    listPacksForProducts(catalog.map((p) => p.id)),
  ]);

  // Batch 8: trust badge strip (generic-only, compact) shown once above the
  // toolbar -- the full card with wholesaler-specific payment/return terms
  // lives at the cart, where it actually matters for the buyer's decision.
  outlet.appendChild(renderTrustBadges(wholesaler, { compact: true }));

  const gridWrap = document.createElement("div");
  outlet.appendChild(gridWrap);

  function renderGrid(filters) {
    const filtered = filterAndSortCatalog(catalog, filters, { lowMoqThreshold: wholesaler.low_moq_threshold ?? 12 });
    toolbar.setResultCount(filtered.length, catalog.length);
    gridWrap.innerHTML = "";
    if (!filtered.length) {
      gridWrap.appendChild(emptyState({ icon: "🔍", title: "No products match your filters", body: "Try clearing a filter or broadening your search." }));
      return;
    }
    const freshGrid = document.createElement("div");
    freshGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;";
    filtered.forEach((product) => {
      freshGrid.appendChild(renderProductCard({
        product, wid, locationId: location.id, currency: wholesaler.currency || "$",
        tiers: tiersByProduct.get(product.id) || [],
        overridesByVariant,
        isReorder: orderedProductIds.has(product.id),
        packs: packsByProduct.get(product.id) || [],
        onCartChange: () => document.dispatchEvent(new CustomEvent("v2:cart-changed")),
      }));
    });
    gridWrap.appendChild(freshGrid);
  }

  const toolbar = renderCatalogToolbar({
    catalog, lowMoqThreshold: wholesaler.low_moq_threshold ?? 12,
    onChange: renderGrid,
  });
  outlet.insertBefore(toolbar.el, gridWrap);
  renderGrid(defaultCatalogFilters());
}

// =============================================================================
// SUPPLIERS -- capability removed 18 Aug 2026
// =============================================================================
// This screen used to list EVERY wholesaler on the platform by brand name,
// each with a "Browse catalog" button that swapped the session's wid. So any
// buyer of any wholesaler could read OGGI's entire client list and walk into a
// competitor's catalogue. Reported by Hadi on sight, and correct to report:
// the wholesalers are OGGI's customers, and their names are not the buyer's
// business.
//
// THE ROUTE IS KEPT, THE ROSTER IS GONE. Deleting the route would 404 anyone
// with a bookmark or a bottom-nav entry cached in an installed PWA -- a
// removal that looks like a crash. This renders an explanation instead.
//
// Cross-wholesaler browsing is NOT being abandoned; it is being rebuilt as the
// Marketplace, where products from many wholesalers appear under OGGI's own
// branding with no supplier identity attached anywhere. Same buyer benefit,
// none of the disclosure.
//
// Belt and braces: migration 042 revoked the anon role's access to
// v2_wholesalers, so restoring this screen's old query would now fail against
// the database rather than quietly working again.
// =============================================================================
async function suppliers(outlet) {
  outlet.appendChild(pageHeader(
    "Suppliers",
    "You browse the catalogue of the supplier you have an account with."
  ));
  outlet.appendChild(emptyState({
    icon: "\u{1F3EC}",
    title: "One account, one supplier",
    body: "You're set up with your supplier and their full catalogue is on the Catalog tab. "
        + "Browsing products across multiple suppliers is coming to OGGI as the Marketplace.",
  }));
}

// ---------- Cart ----------

async function cartView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Cart", "Edit quantities directly — no need to remove and re-add."));

  const lines = cart.get(wid);
  if (!lines.length) {
    outlet.appendChild(emptyState({ icon: "🧺", title: "Your cart is empty", body: "Add products from the catalog to see them here." }));
    return;
  }

  const wholesaler = await getWholesaler(wid);
  const currency = wholesaler?.currency || "$";
  const location = await defaultLocation(wid);

  // Batch 8: quantity-tiered price nudge in the cart itself (not just the
  // product card) -- a buyer editing quantities directly in the cart should
  // see the same "add N more to unlock $X/ea" feedback they'd have seen on
  // the catalog grid. Fetched once for the distinct set of products already
  // in the cart; pack lines don't carry a single product's tiers (a pack
  // can span multiple sizes of one product but is sold as a flat unit) so
  // they're excluded, matching Batch 7's pack-lines-are-exempt precedent.
  const label = buyerLabel();
  const clientId = session.clientId || (await resolveClientId(wid, label));
  const cartProductIds = [...new Set(lines.filter((l) => !l.isPack && l.productId).map((l) => l.productId))];
  const { tiersByProduct } = cartProductIds.length
    ? await getPricingContext(cartProductIds, clientId)
    : { tiersByProduct: new Map() };

  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";

  function renderLines() {
    list.innerHTML = "";
    const current = cart.get(wid);
    current.forEach((line) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";

      if (line.isPack) {
        // Batch 7: a pack is ALWAYS one line here, no matter how many
        // real SKUs it decomposes into underneath ("2x Boutique Pack –
        // Style ABC, Blue"), per the research doc's explicit requirement.
        const breakdown = line.components.map((c) => `${c.qtyPerPack}×${c.size || c.sku}`).join("/");
        row.innerHTML = `
          <span class="badge badge-info" style="flex:none;">Pack</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;">${esc(line.packName)}${line.packColor ? ` — ${esc(line.packColor)}` : ""}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${breakdown} · ${currency}${line.price.toFixed(2)} each pack</div>
          </div>
        `;
        const qtyInput = document.createElement("input");
        qtyInput.type = "number"; qtyInput.className = "input"; qtyInput.style.width = "80px"; qtyInput.min = "0";
        qtyInput.value = String(line.packQty);
        qtyInput.addEventListener("change", async () => {
          const qty = parseInt(qtyInput.value, 10) || 0;
          const result = await cart.updatePackQty(wid, line.packLineId, qty);
          if (!result.ok) {
            toast("Not enough stock for that pack quantity", { type: "danger" });
            qtyInput.value = String(line.packQty);
            return;
          }
          toast("Cart updated", { type: "success" });
          renderLines();
          renderSummary();
          document.dispatchEvent(new CustomEvent("v2:cart-changed"));
        });
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn btn-ghost btn-sm";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          await cart.removePack(wid, line.packLineId);
          renderLines();
          renderSummary();
          document.dispatchEvent(new CustomEvent("v2:cart-changed"));
        });
        const lineTotal = document.createElement("div");
        lineTotal.style.cssText = "font-weight:600;width:80px;text-align:right;";
        lineTotal.textContent = `${currency}${(line.packQty * line.price).toFixed(2)}`;
        row.appendChild(qtyInput);
        row.appendChild(lineTotal);
        row.appendChild(removeBtn);
        list.appendChild(row);
        return;
      }

      row.innerHTML = `
        <span class="dot" style="width:18px;height:18px;border-radius:5px;background:${line.colorHex};flex:none;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;">${esc(line.productName)}</div>
          <div style="font-size:12px;color:var(--text-secondary);">${esc(line.color)} · ${esc(line.size)} · ${currency}${line.price.toFixed(2)} each</div>
        </div>
      `;
      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.className = "input";
      qtyInput.style.width = "80px";
      qtyInput.min = "0";
      qtyInput.value = String(line.qty);
      qtyInput.addEventListener("change", async () => {
        const qty = parseInt(qtyInput.value, 10) || 0;
        const result = await cart.setLineQty(wid, line, qty);
        if (!result.ok) {
          toast("Not enough stock for that quantity", { type: "danger" });
          qtyInput.value = String(line.qty);
          return;
        }
        toast("Cart updated", { type: "success" });
        renderLines();
        renderSummary();
        document.dispatchEvent(new CustomEvent("v2:cart-changed"));
      });
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-ghost btn-sm";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        await cart.removeLine(wid, line.variantId);
        renderLines();
        renderSummary();
        document.dispatchEvent(new CustomEvent("v2:cart-changed"));
      });
      const lineTotal = document.createElement("div");
      lineTotal.style.cssText = "font-weight:600;width:80px;text-align:right;";
      lineTotal.textContent = `${currency}${(line.qty * line.price).toFixed(2)}`;

      row.appendChild(qtyInput);
      row.appendChild(lineTotal);
      row.appendChild(removeBtn);
      list.appendChild(row);

      // Batch 8: tiered-price nudge for this line, using the SAME
      // cross-colourway aggregate basis Batch 6 established (every cart
      // line for this product, any colour/size, summed together).
      const tiers = line.productId ? tiersByProduct.get(line.productId) || [] : [];
      if (tiers.length) {
        const aggQty = current.filter((l) => !l.isPack && l.productId === line.productId).reduce((s, l) => s + l.qty, 0);
        const nt = nextTier(tiers, aggQty);
        if (nt) {
          const nudge = document.createElement("div");
          nudge.style.cssText = "font-size:11px;color:var(--accent-600,#2f6b4f);padding:0 12px 10px 42px;border-bottom:1px solid var(--border-subtle);margin-top:-1px;";
          nudge.textContent = `Add ${nt.minQty - aggQty} more of this product (any colour/size) to unlock ${currency}${nt.unitPrice.toFixed(2)}/ea`;
          list.appendChild(nudge);
        }
      }
    });
    if (!current.length) {
      outlet.querySelectorAll(".cart-summary,.card").forEach((n) => n.remove());
      outlet.appendChild(emptyState({ icon: "🧺", title: "Your cart is empty", body: "Add products from the catalog to see them here." }));
    }
  }

  const summary = document.createElement("div");
  summary.className = "cart-summary card";
  summary.style.cssText = "margin-top:16px;padding:18px;display:flex;justify-content:space-between;align-items:center;";

  function renderSummary() {
    const current = cart.get(wid);
    const total = current.reduce((s, l) => s + (l.isPack ? l.packQty * l.price : l.qty * l.price), 0);
    summary.innerHTML = `<div><div style="font-size:12px;color:var(--text-tertiary);">Subtotal</div><div style="font-size:22px;font-weight:700;">${currency}${total.toFixed(2)}</div></div>`;
    const submitBtn = document.createElement("button");
    submitBtn.className = "btn btn-primary";
    submitBtn.textContent = "Submit order";
    submitBtn.disabled = !current.length || !location;
    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      const label = buyerLabel();
      const clientId = session.clientId || (await resolveClientId(wid, label));
      const result = await cart.submit(wid, { buyerLabel: label, locationId: location.id, clientId, accountId: session.accountId });
      if (!result.ok) {
        // Batch 6: MOQ/order-minimum violations come back as a real
        // Postgres exception message from the server (the actual
        // authority — see migrations/010) rather than a generic failure,
        // so surface it verbatim when present instead of guessing.
        const serverMsg = result.error?.message;
        toast(serverMsg || "Order submission failed — a held item may have expired. Please review your cart.", { type: "danger" });
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit order";
        renderLines();
        renderSummary();
        return;
      }
      document.dispatchEvent(new CustomEvent("v2:cart-changed"));
      // Batch 13: the full-screen celebration is awaited before navigating
      // away — a buyer always sees it play out (or dismisses it themselves
      // by tapping), rather than racing a hash change against an
      // in-progress animation. showOrderCelebration() itself shortens to a
      // brief static checkmark with no confetti under
      // prefers-reduced-motion (see js/lib/animations/order-celebration.js),
      // so this await is never a long forced wait for a buyer who has that
      // OS setting on.
      await showOrderCelebration({ message: `Order placed — ${currency}${result.order.subtotal}` });
      window.location.hash = "#/buyer/orders";
    });
    summary.appendChild(submitBtn);
  }

  outlet.appendChild(list);
  outlet.appendChild(summary);
  // Batch 8: trust/guarantee card right where the buyer commits to the
  // order -- generic platform badges plus this wholesaler's own payment
  // terms/return policy when they've set them (see migrations/013 and
  // js/components/trust-badges.js).
  outlet.appendChild(renderTrustBadges(wholesaler));
  renderLines();
  renderSummary();
}

// ---------- Orders ----------

async function ordersView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("My Orders", "Order history, status, and one-click reorder."));

  const [orders, wholesaler] = await Promise.all([getBuyerOrders(session.accountId), getWholesaler(wid)]);
  const currency = wholesaler?.currency || "$";

  if (!orders.length) {
    outlet.appendChild(emptyState({ icon: "📦", title: "No orders yet", body: "Orders you place will show up here with live status and a one-click reorder button." }));
    return;
  }

  const STATUS_BADGE = {
    new: "badge-info", confirmed: "badge-accent", shipped: "badge-warning", delivered: "badge-success", cancelled: "badge-danger",
  };

  orders.forEach((order) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "padding:16px;margin-bottom:12px;";
    const date = new Date(order.createdAt).toLocaleString();
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div>
          <span class="badge ${STATUS_BADGE[order.status] || "badge-neutral"}">${order.status}</span>
          <span style="color:var(--text-tertiary);font-size:12px;margin-left:8px;">${date}</span>
        </div>
        <div style="font-weight:700;">${currency}${order.subtotal.toFixed(2)}</div>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);">${order.items.map((i) => i.isPack ? `${i.packQty}× ${esc(i.productName)} pack` : `${i.qty}× ${esc(i.productName)} (${esc(i.color)}/${esc(i.size)})`).join(", ")}</div>
    `;
    const reorderBtn = document.createElement("button");
    reorderBtn.className = "btn btn-secondary btn-sm";
    reorderBtn.style.marginTop = "10px";
    reorderBtn.textContent = "Reorder";
    reorderBtn.addEventListener("click", async () => {
      reorderBtn.disabled = true;
      const location = await defaultLocation(wid);
      let failures = 0;
      for (const item of order.items) {
        if (item.isPack) {
          // Batch 7: re-add at the pack's CURRENT composition/price, not a
          // stale snapshot from when this order was placed -- the pack may
          // have been edited (or archived) since.
          const pack = await getPackById(item.packId);
          if (!pack) { failures++; continue; }
          const r = await cart.addPack(wid, pack, item.packQty, location.id);
          if (!r.ok) failures++;
          continue;
        }
        const r = await cart.setLineQty(wid, {
          variantId: item.variantId, productId: item.productId, locationId: location.id, productName: item.productName,
          color: item.color, colorHex: "#999", size: item.size, price: item.unitPrice,
        }, item.qty);
        if (!r.ok) failures++;
      }
      toast(failures ? `Added to cart — ${failures} item(s) had insufficient stock` : "All items added to cart", { type: failures ? "danger" : "success" });
      window.location.hash = "#/buyer/cart";
    });
    card.appendChild(reorderBtn);
    outlet.appendChild(card);
  });
}

// ---------- Favourites (localStorage-backed; no account system yet) ----------

function favKey(wid) {
  return `oggi-v2-favourites-${wid}`;
}
export function isFavourite(wid, productId) {
  try {
    return (JSON.parse(localStorage.getItem(favKey(wid)) || "[]")).includes(productId);
  } catch { return false; }
}
export function toggleFavourite(wid, productId) {
  const list = JSON.parse(localStorage.getItem(favKey(wid)) || "[]");
  const idx = list.indexOf(productId);
  if (idx >= 0) list.splice(idx, 1); else list.push(productId);
  localStorage.setItem(favKey(wid), JSON.stringify(list));
}

async function favouritesView(outlet) {
  const session = devAuth.getSession();
  const wid = session.wid;
  outlet.appendChild(pageHeader("Favourites", "Products you've starred for this supplier."));

  const favIds = JSON.parse(localStorage.getItem(favKey(wid)) || "[]");
  if (!favIds.length) {
    outlet.appendChild(emptyState({ icon: "★", title: "No favourites yet", body: "Star products from the catalog to save them here." }));
    return;
  }
  const [catalog, wholesaler, location] = await Promise.all([getCatalog(wid), getWholesaler(wid), defaultLocation(wid)]);
  const favProducts = catalog.filter((p) => favIds.includes(p.id));
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;";
  favProducts.forEach((product) => {
    grid.appendChild(renderProductCard({ product, wid, locationId: location?.id, currency: wholesaler?.currency || "$" }));
  });
  outlet.appendChild(grid);
}

export function registerBuyerRoutes(router) {
  router.register("/buyer", (outlet) => dashboard(outlet));
  router.register("/buyer/cart", (outlet) => cartView(outlet));
  router.register("/buyer/orders", (outlet) => ordersView(outlet));
  router.register("/buyer/favourites", (outlet) => favouritesView(outlet));
  router.register("/buyer/suppliers", (outlet) => suppliers(outlet));
}

