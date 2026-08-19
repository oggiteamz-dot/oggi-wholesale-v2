// OGGI Wholesale v2 — Buyer views (Batch 2: real catalog, cart, orders)
import { emptyState } from "../components/empty-state.js";
import { renderProductCard } from "../components/product-card.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { supabase, sbCall } from "../lib/supabase-client.js";
import { getCatalog, getWholesaler, listWholesalers } from "../data/catalog.js";
import { buyerCatalogs, buyerCatalogProductIds, catalogByToken, catalogProductsByToken } from "../data/catalogs.js";
import { renderBillboard, sectionHeader } from "../components/billboard.js";
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
  // 18 Aug 2026 (migration 047): reads the RPC, not the table.
  //
  // Buyers and sales reps run as the `anon` role -- they authenticate through
  // v2_portal_accounts, so auth.uid() is NULL and v2_my_wid() cannot identify
  // them. That means no row policy can scope an anon read of v2_locations, so
  // 047 revoked anon's access to the table entirely and this select would now
  // return nothing at all.
  //
  // v2_public_default_location(p_wid) takes an exact id and returns one row of
  // two columns. Same shape, and the same reasoning, as v2_public_wholesaler
  // in migration 042.
  const { data } = await sbCall(supabase.rpc("v2_public_default_location", { p_wid: wid }));
  return (Array.isArray(data) ? data[0] : data) || null;
}

/** Which catalog the buyer is currently shopping. Module-level because the
 *  cart is a separate screen from the catalog, and the order has to record the
 *  catalog it was priced against -- a value that lived inside dashboard()
 *  would be gone by the time Submit is pressed. Null means "no catalog
 *  narrowing applied", which prices at list. */
let activeCatalogId = null;

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
  // clientId is resolved here for ORDER SUBMISSION only. It no longer has
  // anything to do with pricing: as of Batch 16 the buyer's negotiated prices
  // come from v2_buyer_price_overrides, which derives the client from the
  // validated account row and accepts no client id at all. Prefer the real
  // login response (session.clientId); the shop_name fallback is for a session
  // with no real accountId yet (mid "switch supplier" browsing, see the
  // suppliers() handler below) and always resolves to null under the Batch 14
  // RLS pass, which is the safe default rather than a crash.
  const [clientId, orderedProductIds] = await Promise.all([
    session.clientId || resolveClientId(wid, label),
    getBuyerOrderedProductIds(session.accountId),
  ]);
  // Migration 055: which catalogs this buyer's tier allows, and which products
  // are in the one they are looking at. Until now every buyer saw every
  // product this wholesaler owned -- catalogs were wholesaler-side filing and
  // nothing more.
  //
  // A wholesaler who has never built a second catalog still has the Main
  // Catalog that migration 045 back-filled, so this narrows to it rather than
  // to nothing. If NO catalog is visible -- no account id, an older session --
  // the buyer keeps seeing the whole range, because showing someone an empty
  // shop because a lookup failed is far worse than showing them too much.
  //
  // Stated plainly: once a catalog IS resolved, an empty product list is shown
  // as empty. A failed products call and a genuinely empty catalog look the
  // same from here, and inventing products to cover the difference would be
  // worse than the honest blank.
  const visibleCatalogs = await buyerCatalogs(session.accountId);
  let activeCatalog = visibleCatalogs.find((c) => c.id === activeCatalogId) || visibleCatalogs[0] || null;
  activeCatalogId = activeCatalog?.id || null;

  async function narrowTo(cat) {
    if (!cat) return catalog;
    const ids = new Set(await buyerCatalogProductIds(session.accountId, cat.id));
    if (!ids.size) return [];
    return catalog.filter((p) => ids.has(p.id));
  }
  let shownCatalog = await narrowTo(activeCatalog);

  const [{ tiersByProduct, overridesByVariant, discountPct }, packsByProduct] = await Promise.all([
    // Batch 16: pricing takes the ACCOUNT id now, not a client id -- the
    // database resolves which client that account belongs to. clientId above
    // is still needed, but only for order submission below.
    //
    // Migration 053: the client id also decides the discount percentage, which
    // v2_submit_order applies to every line whether this screen shows it or
    // not. Passing it here is what keeps the cart and the invoice agreeing.
    getPricingContext(catalog.map((p) => p.id), session.accountId, { clientId, catalogId: activeCatalog?.id || null }),
    listPacksForProducts(catalog.map((p) => p.id)),
  ]);

  // The customer's own share of that percentage, kept separately because it is
  // the only part the buyer is allowed to SEE. The catalog's share is silent
  // by design, so it must never appear as a struck-through "before" price.
  const customerPct = Number(session.discountPct) || 0;

  // Batch 8: trust badge strip (generic-only, compact) shown once above the
  // toolbar -- the full card with wholesaler-specific payment/return terms
  // lives at the cart, where it actually matters for the buyer's decision.
  outlet.appendChild(renderTrustBadges(wholesaler, { compact: true }));

  // NO CATALOG SWITCHER. There is deliberately no "browse my catalogs" here.
  // Hadi: "There is no website for the actual buyer. That's never going to
  // happen... There is no 'show me catalog'. There is no 'get catalog'. There
  // is just a custom link for each catalog."
  //
  // A catalog is reached by opening the link the wholesaler sent (#/c/<token>,
  // migration 056), which resolves it, asks for a login if the catalog is not
  // public, and checks the tier. The switcher that used to live here listed
  // every catalog a buyer was entitled to, which is exactly the storefront
  // that is not being built. It was removed rather than hidden.

  const gridWrap = document.createElement("div");
  outlet.appendChild(gridWrap);

  function renderGrid(filters) {
    const filtered = filterAndSortCatalog(shownCatalog, filters, { lowMoqThreshold: wholesaler.low_moq_threshold ?? 12 });
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
        discountPct, customerPct,
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
  const cartProductIds = [...new Set(lines.filter((l) => !l.isPack && l.productId).map((l) => l.productId))];
  const { tiersByProduct, discountPct: cartDiscountPct } = cartProductIds.length
    ? await getPricingContext(cartProductIds, session.accountId, {
        clientId: session.clientId || null,
        // Same catalog the buyer was shopping, so the cart shows what the
        // invoice will say. Without it the cart prices at list and the order
        // arrives discounted, which looks like a pricing bug to everyone.
        catalogId: activeCatalogId,
      })
    : { tiersByProduct: new Map(), discountPct: 0 };

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
      const result = await cart.submit(wid, {
        buyerLabel: label, locationId: location.id, clientId,
        accountId: session.accountId,
        // The catalog priced this order; the server re-checks that this
        // account may actually see it before honouring the discount.
        catalogId: activeCatalogId,
      });
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

/**
 * A catalog link. This is the ONLY way into a catalog.
 *
 * Hadi: "There is no website for the actual buyer. That's never going to
 * happen. Instead, what they get is a link that they only get access to when
 * the catalog is active and the wholesaler sends them the link."
 *
 * Four outcomes, and each says only what the person is entitled to know:
 *
 *   not_found       the link is dead, or never existed. Same message for both,
 *                   because a dead link must not confirm it was ever alive.
 *   login_required  a real link to a private catalog. Names the WHOLESALER so
 *                   they know whose login to use, and does not name the
 *                   catalog -- a forwarded link should not tell a stranger
 *                   what this wholesaler sells.
 *   denied          signed in and still not allowed. Says so plainly rather
 *                   than pretending the link is broken, because the person is
 *                   a real customer and will otherwise ask why it is broken.
 *   ok              the catalog, priced through that catalog.
 *
 * The customer experience beyond this -- guest checkout on a public catalog,
 * what a returning customer lands on -- is deliberately still open. This page
 * exists so the link a wholesaler copies is not a link to nowhere.
 */
async function catalogLinkView(outlet, params) {
  const token = params?.token || "";
  const session = devAuth.getSession() || {};

  const resolved = await catalogByToken(token, session.accountId || null);

  if (resolved.status === "not_found") {
    outlet.appendChild(emptyState({
      icon: "🔗", title: "This link is not available",
      body: "It may have been switched off, or replaced with a newer one. Ask whoever sent it for the current link.",
    }));
    return;
  }

  if (resolved.status === "login_required") {
    outlet.appendChild(emptyState({
      icon: "🔒",
      title: `${resolved.wholesalerName || "This wholesaler"} shared a catalog with you`,
      body: "Sign in with the username and password they gave you to open it.",
    }));
    const go = document.createElement("button");
    go.className = "btn btn-primary";
    go.textContent = "Sign in";
    // Come back here afterwards rather than dumping them on a dashboard --
    // they clicked a link to see a catalog, not to arrive somewhere.
    go.addEventListener("click", () => {
      try { sessionStorage.setItem("v2:after-login", `/c/${token}`); } catch { /* private mode */ }
      location.hash = "#/login";
    });
    const wrap = document.createElement("div");
    wrap.className = "pf-actions";
    wrap.appendChild(go);
    outlet.appendChild(wrap);
    return;
  }

  if (resolved.status === "denied") {
    outlet.appendChild(emptyState({
      icon: "🔒", title: "This catalog is not open to your account",
      body: `You are signed in, but ${resolved.wholesalerName || "this wholesaler"} has not given your account access to this one. Ask them if you think that is wrong.`,
    }));
    return;
  }

  // ---- ok ----
  activeCatalogId = resolved.id;
  const wid = resolved.wid;
  outlet.appendChild(pageHeader(resolved.name, resolved.description || `From ${resolved.wholesalerName || "your supplier"}`));

  const rows = await catalogProductsByToken(token, session.accountId || null);
  const order = new Map(rows.map((r, i) => [r.id, i]));
  const pinned = new Set(rows.filter((r) => r.highlighted).map((r) => r.id));
  const everything = await getCatalog(wid);
  // The database decided the order; this only preserves it. getCatalog returns
  // its own ordering, so without this the highlighted-first rule would survive
  // the query and die in the filter.
  const products = everything
    .filter((p) => order.has(p.id))
    .sort((a, b) => order.get(a.id) - order.get(b.id));

  if (!products.length) {
    outlet.appendChild(emptyState({
      icon: "🗂", title: "Nothing in this catalog yet",
      body: "The products are on their way. Check the link again shortly.",
    }));
    return;
  }

  const { tiersByProduct, overridesByVariant, discountPct } =
    await getPricingContext(products.map((p) => p.id), session.accountId, {
      clientId: session.clientId || null, catalogId: resolved.id,
    });
  const customerPct = Number(session.discountPct) || 0;
  const location = await defaultLocation(wid);

  const cardFor = (product) => renderProductCard({
    product, wid, locationId: location?.id, currency: "$",
    tiers: tiersByProduct.get(product.id) || [],
    overridesByVariant, discountPct, customerPct,
    packs: [],
    highlighted: pinned.has(product.id),
  });
  // Same grid the buyer dashboard builds. Written inline there rather than as a
  // class, so it is matched here rather than inventing a second one that would
  // drift.
  const newGrid = () => {
    const g = document.createElement("div");
    g.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;";
    return g;
  };

  // ---- the billboard ----
  if (resolved.billboardEnabled && resolved.billboardUrl) {
    const target = resolved.billboardProductId;
    // A billboard advertising a product that has since left the catalog
    // becomes a plain poster rather than a button that scrolls to nothing.
    const targetPresent = target && products.some((p) => p.id === target);
    const bb = renderBillboard({
      url: resolved.billboardUrl,
      mediaType: resolved.billboardMediaType,
      cta: resolved.billboardCta,
      label: resolved.name,
      onGo: targetPresent ? () => {
        const card = outlet.querySelector(`[data-product-id="${CSS.escape(target)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("card-pointed-at");
        setTimeout(() => card.classList.remove("card-pointed-at"), 2400);
      } : null,
    });
    if (bb) outlet.appendChild(bb);
  }

  // ---- highlighted first, under the name the wholesaler chose ----
  const highlighted = products.filter((p) => pinned.has(p.id));
  const rest = products.filter((p) => !pinned.has(p.id));

  if (highlighted.length) {
    outlet.appendChild(sectionHeader(resolved.highlightLabel || "Featured", highlighted.length));
    const g = newGrid();
    highlighted.forEach((p) => g.appendChild(cardFor(p)));
    outlet.appendChild(g);
    // Only worth naming the remainder when there IS a pinned group above it.
    // "Everything else" over the whole catalog is a heading that says nothing.
    if (rest.length) outlet.appendChild(sectionHeader("Everything else", rest.length));
  }

  const g = newGrid();
  rest.forEach((p) => g.appendChild(cardFor(p)));
  outlet.appendChild(g);
}

export function registerBuyerRoutes(router) {
  // The catalog link. Registered OUTSIDE /buyer on purpose: it is the entry
  // point for someone who may not have an account at all.
  router.register("/c/:token", (outlet, params) => catalogLinkView(outlet, params));
  router.register("/buyer", (outlet) => dashboard(outlet));
  router.register("/buyer/cart", (outlet) => cartView(outlet));
  router.register("/buyer/orders", (outlet) => ordersView(outlet));
  router.register("/buyer/favourites", (outlet) => favouritesView(outlet));
  router.register("/buyer/suppliers", (outlet) => suppliers(outlet));
}

