// OGGI Wholesale v2 — Buyer views (Batch 2: real catalog, cart, orders)
import { emptyState } from "../components/empty-state.js";
import { directoryView, registerDirectoryRoutes } from "./directory.js";
import { registerSearchRoutes } from "./search.js";
import { renderProductCard } from "../components/product-card.js";
import { toast } from "../components/toast.js";
import { devAuth } from "../lib/dev-auth.js";
import { supabase, sbCall } from "../lib/supabase-client.js";
import { getCatalogByToken, getBuyerCatalog, getBuyerVisibleProducts, getWholesaler, listWholesalers, getVariantListPrices } from "../data/catalog.js";
import { buyerCatalogs, catalogByToken } from "../data/catalogs.js";
import { renderBillboard, sectionHeader } from "../components/billboard.js";
import { cart } from "../data/cart.js";
import { getBuyerOrders, orderedTimesCount, getBuyerOrderedProductIds } from "../data/orders.js";
import { getPricingContext, tierForQty, nextTier, effectivePrice, productMoqStatus, marginPct } from "../data/pricing.js";
import { listPacksByToken, listPacksForBuyerCatalog, getBuyerPack } from "../data/prepacks.js";
// Batch 5: the one place a cart total is calculated. See js/data/line-pricing.js
// for why the buyer app previously had two.
import { priceCart, aggregateQtyByProduct } from "../data/line-pricing.js";
import { renderCatalogToolbar } from "../components/catalog-toolbar.js";
import { filterAndSortCatalog, defaultCatalogFilters } from "../data/catalog-filter.js";
import { renderTrustBadges } from "../components/trust-badges.js";
import { renderOrderBar } from "../components/order-bar.js";
import { showOrderCelebration } from "../lib/animations/order-celebration.js";

import { esc, pageHeader } from "../lib/utils.js";
// 30 Aug 2026 — the marketplace. The switcher and the reorder rail both render
// NOTHING when they have nothing to show, so a buyer with one store and no
// order history sees exactly the screen they saw yesterday.
import { renderStoreSwitcher } from "../components/store-switcher.js";
import { renderProductRail } from "../components/product-rail.js";
import { listBuyItAgain } from "../data/reorder.js";
import { listPopularNow, popularTitle, popularSubtitle } from "../data/popular.js";
import { listSimilarProducts, similarSubtitle } from "../data/similar.js";
import { enterStore, marketplaceSession } from "../data/marketplace.js";
import { registerMarketplaceRoutes } from "./marketplace.js";
import { packBreakdown } from "../lib/pack-breakdown.js";
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

// MK-01. Set by the cross-store product route below, read once by dashboard().
// A module-level value rather than a query string because the catalogue screen
// is reached by hash route and a param would have to be threaded through four
// call sites that have no other reason to know about it.
let pendingProductFocus = null;

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

  // Batch S / S2b. The whole-tenant getCatalog(wid) read is gone from here.
  // The buyer's visible catalogs are resolved FIRST, because the products now
  // come from the catalog they are allowed to see rather than from the
  // wholesaler's entire range filtered afterwards in the browser.
  const [wholesaler, location, visibleCatalogs] = await Promise.all([
    getWholesaler(wid),
    defaultLocation(wid),
    buyerCatalogs(session.accountId),
  ]);
  let activeCatalog = visibleCatalogs.find((c) => c.id === activeCatalogId) || visibleCatalogs[0] || null;
  activeCatalogId = activeCatalog?.id || null;
  const catalog = await getBuyerCatalog(session.accountId, activeCatalogId);

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
    // Batch S/S5: resolveClientId() is gone from the buyer path. It read
    // v2_clients directly, and under RLS an anon buyer has ALWAYS got nothing
    // back -- so it has only ever resolved to null here. After S7 revokes the
    // grant it would raise rather than return null. The real client id comes
    // from the login response (session.clientId); this was a fallback that
    // never once fired.
    session.clientId || null,
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
  // ⛔ WHAT USED TO BE HERE, AND WHY IT IS GONE (Batch S / S2b, 25 Aug 2026):
  //
  //     const ids = new Set(await buyerCatalogProductIds(session.accountId, cat.id));
  //     return catalog.filter((p) => ids.has(p.id));
  //
  // buyerCatalogProductIds returns OBJECTS, so that Set held object
  // references and ids.has(p.id) -- a string -- was ALWAYS false. Every
  // signed-in buyer saw an EMPTY catalogue. Live since 20 Aug 2026; see the
  // full account in js/data/catalog.js above getBuyerCatalog().
  //
  // There is no narrowing step any more. The database returns this buyer's
  // catalogue and nothing else, so there is no wider list left to filter --
  // which is the point of the batch, and incidentally makes the bug above
  // unrepresentable rather than merely fixed.
  let shownCatalog = catalog;

  const [{ tiersByProduct, overridesByVariant, discountPct }, packsByProduct] = await Promise.all([
    // Batch 16: pricing takes the ACCOUNT id now, not a client id -- the
    // database resolves which client that account belongs to. clientId above
    // is still needed, but only for order submission below.
    //
    // Migration 053: the client id also decides the discount percentage, which
    // v2_submit_order applies to every line whether this screen shows it or
    // not. Passing it here is what keeps the cart and the invoice agreeing.
    getPricingContext(catalog.map((p) => p.id), session.accountId, { clientId, catalogId: activeCatalog?.id || null }),
    listPacksForBuyerCatalog(session.accountId, activeCatalogId),
  ]);

  // The customer's own share of that percentage, kept separately because it is
  // the only part the buyer is allowed to SEE. The catalog's share is silent
  // by design, so it must never appear as a struck-through "before" price.
  const customerPct = Number(session.discountPct) || 0;

  // Batch 8: trust badge strip (generic-only, compact) shown once above the
  // toolbar -- the full card with wholesaler-specific payment/return terms
  // lives at the cart, where it actually matters for the buyer's decision.
  // ---------------------------------------------------------------- ID-09 --
  // THE STORE SWITCHER. Returns null for a buyer with fewer than two stores,
  // and for anyone who came through the per-store door, so this appends
  // nothing at all in both of those cases.
  const switcher = await renderStoreSwitcher({
    activeWid: wid,
    onSwitch: () => { window.location.hash = "#/buyer"; window.location.reload(); },
  });
  if (switcher) outlet.appendChild(switcher);

  // ---------------------------------------------------------------- RC-01 --
  // BUY IT AGAIN. Cross-store: every shop this person can still enter, ranked
  // most-recent first by migration 095. Renders nothing when there is nothing
  // to reorder, which as of today is every account on production — no account
  // that can log in has ever placed an order.
  //
  // Fetched but not awaited before the catalogue paints: the shelf is a
  // convenience and the catalogue is the screen. A slow reorder query must
  // never hold up the thing the buyer came for.
  const reorderSlot = document.createElement("div");
  outlet.appendChild(reorderSlot);
  listBuyItAgain({ limit: 12 }).then((items) => {
    const rail = renderProductRail({
      title: "Buy it again",
      items,
      testId: "reorder",
      onOpen: (it) => {
        // Same store: scroll to it, using the billboard's proven path.
        if (it.wid === wid) {
          const card = outlet.querySelector(`[data-product-id="${CSS.escape(it.productId)}"]`);
          if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            card.classList.add("card-pointed-at");
            setTimeout(() => card.classList.remove("card-pointed-at"), 2400);
            return;
          }
        }
        // Another store: MK-01 takes them there, and says so on the way.
        window.location.hash = `#/buyer/s/${encodeURIComponent(it.wid)}/p/${encodeURIComponent(it.productId)}`;
      },
    });
    if (rail) reorderSlot.appendChild(rail);
  }).catch(() => { /* a shelf that fails is a shelf that is absent */ });

  // ---------------------------------------------------------------- RC-02 --
  // POPULAR RIGHT NOW. What MANY DIFFERENT SHOPS are buying across the stores
  // this person can still enter — ranked by how many shops, never by how many
  // orders. Migration 099 carries the whole argument; the note worth repeating
  // here is that this rail sits directly BELOW the reorder shelf and must never
  // repeat it, which is why 099 excludes anything the buyer already orders.
  //
  // It renders nothing until something clears the minimum-buyer floor, which on
  // today's data is almost everything. That is the feature working: a shelf
  // headed "popular" backed by one shop is a false claim wearing a confident
  // label, and this one is asking a buyer to spend money on the strength of it.
  //
  // Fetched and not awaited, for the same reason as the shelf above it.
  const popularSlot = document.createElement("div");
  outlet.appendChild(popularSlot);
  listPopularNow({ limit: 12 }).then((items) => {
    const rail = renderProductRail({
      // The heading comes from the ANSWER, not from what was asked. See
      // popularTitle: a rail can never be titled "Popular in Tops" over a list
      // that widened past Tops.
      title: popularTitle(items),
      subtitle: popularSubtitle(items),
      items,
      testId: "popular",
      // NO paidLabel, and that is a statement rather than an omission: this
      // shelf is earned and 099 is asserted never to read the promotion table.
      // The day a paid rail ships it passes paidLabel and says so.
      onOpen: (it) => {
        if (it.wid === wid) {
          const card = outlet.querySelector(`[data-product-id="${CSS.escape(it.productId)}"]`);
          if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            card.classList.add("card-pointed-at");
            setTimeout(() => card.classList.remove("card-pointed-at"), 2400);
            return;
          }
        }
        window.location.hash = `#/buyer/s/${encodeURIComponent(it.wid)}/p/${encodeURIComponent(it.productId)}`;
      },
    });
    if (rail) popularSlot.appendChild(rail);
  }).catch(() => { /* a shelf that fails is a shelf that is absent */ });

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

  // ---------------------------------------------------------------- MK-01 --
  // Arrived here from another store's tile, or from a search result. Point at
  // the product, using the same scroll-and-flash the billboard has used since
  // Batch 8 rather than a second implementation of it.
  //
  // The flag is CLEARED whether or not the card is found, so a product that has
  // since left the catalogue does not keep re-triggering on every later visit.
  if (pendingProductFocus) {
    const target = pendingProductFocus;
    pendingProductFocus = null;
    const card = outlet.querySelector(`[data-product-id="${CSS.escape(target)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("card-pointed-at");
      setTimeout(() => card.classList.remove("card-pointed-at"), 2400);
    } else {
      // The honest outcome: they are in the right shop, and the thing they
      // tapped is not on sale any more. Saying so beats silently landing them
      // in a catalogue with no explanation of why.
      toast("That product is no longer in this catalogue.", { type: "info" });
    }

    // ------------------------------------------------------------- RC-03 --
    // MORE LIKE THIS. Mounted ONLY when the buyer arrived pointed at a
    // specific product, because that is the only moment "this" has a referent.
    // A "more like this" rail on the plain catalogue is a rail about nothing.
    //
    // Migration 100 matches on the words in the product's NAME, not on its
    // attributes: eight of 23 live products carry every colour family there
    // is, so an attribute match would put a tote bag beside a jacket. The
    // useful result is the SAME item from a second supplier, which is why the
    // subtitle counts other stores rather than describing the products.
    //
    // Fetched and not awaited, like the two shelves above it.
    const similarSlot = document.createElement("div");
    outlet.appendChild(similarSlot);
    listSimilarProducts({ productId: target, limit: 12 }).then((items) => {
      const rail = renderProductRail({
        title: "More like this",
        subtitle: similarSubtitle(items),
        items,
        testId: "similar",
        // No paidLabel: 100 is asserted never to read the promotion table.
        onOpen: (it) => {
          if (it.wid === wid) {
            const card = outlet.querySelector(`[data-product-id="${CSS.escape(it.productId)}"]`);
            if (card) {
              card.scrollIntoView({ behavior: "smooth", block: "center" });
              card.classList.add("card-pointed-at");
              setTimeout(() => card.classList.remove("card-pointed-at"), 2400);
              return;
            }
          }
          window.location.hash = `#/buyer/s/${encodeURIComponent(it.wid)}/p/${encodeURIComponent(it.productId)}`;
        },
      });
      if (rail) similarSlot.appendChild(rail);
    }).catch(() => { /* a shelf that fails is a shelf that is absent */ });
  }

  // ------------------------------------------------------------- GAP-4 ----
  // THE ORDER BAR.                                             28 Aug 2026
  //
  // The approved mockup pins one to the bottom of the catalogue; nothing like
  // it shipped. The only running count was a topbar badge, which sits out of
  // thumb reach and adds packs and pieces together as though they were the
  // same unit -- so two boxes of twelve and two loose shirts both read "2".
  //
  // It is given the SAME pricing context the cards are given, so the bar and
  // the card cannot quote different numbers, and it prices through priceCart()
  // so neither can disagree with the invoice.
  const orderBar = renderOrderBar({
    wid, currency: wholesaler.currency || "$",
    pricingCtx: {
      basePriceFor: (vid) => {
        for (const p of catalog) {
          const v = (p.variants || []).find((x) => x.id === vid);
          if (v) return v.price || 0;
        }
        return 0;
      },
      tiersByProduct, overridesByVariant, discountPct, customerPct,
    },
    onReview: () => { window.location.hash = "#/buyer/cart"; },
  });
  outlet.appendChild(orderBar);
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
  // KEPT AS A ROUTE, NOT AS A SCREEN. This used to render "One account, one
  // supplier ... the Marketplace is coming", which stopped being true on
  // 29 Aug 2026 when the directory shipped. An installed PWA with the old tab
  // cached still lands here, so it now shows the real thing rather than a
  // promise the product has already kept.
  //
  // It delegates rather than duplicating: two screens that must stay identical
  // are two screens that will not.
  await directoryView(outlet);
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
  // see the same "add N more" feedback they'd have seen on the catalog grid.
  // Fetched once for the distinct set of products already in the cart.
  //
  // BATCH 5 CORRECTION. This line used to end with
  //     .filter((l) => !l.isPack && l.productId)
  // and a comment explaining that pack lines are exempt from tiered pricing,
  // "matching Batch 7's pack-lines-are-exempt precedent". There is no such
  // precedent in the database: v2_submit_order prices pack lines through
  // exactly the same v2_effective_unit_price as every other line, and counts
  // their pieces in the aggregate that chooses the quantity break. The
  // exemption existed only in this file, and writing it down as intent is how
  // it survived three batches -- the same way the missing size axis survived
  // the 2.0 rewrite by being recorded in a PRD as the design.
  const cartProductIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  const { tiersByProduct, overridesByVariant, discountPct: cartDiscountPct } = cartProductIds.length
    ? await getPricingContext(cartProductIds, session.accountId, {
        clientId: session.clientId || null,
        // Same catalog the buyer was shopping, so the cart shows what the
        // invoice will say. Without it the cart prices at list and the order
        // arrives discounted, which looks like a pricing bug to everyone.
        catalogId: activeCatalogId,
      })
    : { tiersByProduct: new Map(), overridesByVariant: new Map(), discountPct: 0 };

  // The customer's own share of the discount -- the only part that may appear
  // as a struck-through "before" price. Same rule as the catalog grid.
  const cartCustomerPct = Number(session.discountPct) || 0;

  // Authoritative list prices for the loose lines. A cart line's stored
  // `price` is already effective, so it cannot be re-priced from; see
  // getVariantListPrices in js/data/catalog.js.
  //
  // CR-0008, 28 Aug 2026: pack lines used to be FILTERED OUT of this lookup
  // (`lines.filter((l) => !l.isPack)`), which was consistent only while
  // linePieces() silently priced their components at zero. With that fixed,
  // a pack's component variants must be in this map or basePriceFor falls
  // through to a loose cart line that does not exist and answers 0 -- the
  // same bug moved one function along. Both halves are needed; either alone
  // still prices a pack at nothing.
  const priceVariantIds = [
    ...lines.filter((l) => !l.isPack).map((l) => l.variantId),
    ...lines.filter((l) => l.isPack).flatMap((l) => (l.components || []).map((c) => c.variantId)),
  ].filter(Boolean);
  const listPriceByVariant = await getVariantListPrices(session.accountId, [...new Set(priceVariantIds)]);

  /** Everything priceCart needs, rebuilt per render because the cart changes. */
  function pricingCtx() {
    return {
      basePriceFor: (vid) => {
        if (listPriceByVariant.has(vid)) return listPriceByVariant.get(vid);
        const l = cart.get(wid).find((x) => !x.isPack && x.variantId === vid);
        return l?.listPrice != null ? l.listPrice : (l?.price ?? 0);
      },
      tiersByProduct, overridesByVariant,
      discountPct: cartDiscountPct, customerPct: cartCustomerPct,
    };
  }

  const list = document.createElement("div");
  list.className = "card";
  list.style.padding = "8px";

  function renderLines() {
    list.innerHTML = "";
    const current = cart.get(wid);
    // ONE arithmetic for the whole cart, the same one the product card quotes
    // and checks/check_line_pricing.mjs pins against the real SQL. Every
    // number printed below comes out of this call -- nothing is multiplied a
    // second time locally, because a second multiplication is a second chance
    // to disagree with the invoice.
    const pricedByIndex = priceCart(current, pricingCtx()).lines;
    current.forEach((line, lineIndex) => {
      const priced = pricedByIndex[lineIndex];
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-subtle);";

      if (line.isPack) {
        // Batch 7: a pack is ALWAYS one line here, no matter how many
        // real SKUs it decomposes into underneath ("2x Boutique Pack –
        // Style ABC, Blue"), per the research doc's explicit requirement.
        // Aggregated by size -- same reason as the product card. A cart line
        // for a series pack listed every colour x size component separately.
        const breakdown = packBreakdown(line.components).text;
        row.innerHTML = `
          <span class="badge badge-info" style="flex:none;">Pack</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;">${esc(line.packName)}${line.packColor ? ` — ${esc(line.packColor)}` : ""}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${breakdown}</div>
            <div style="font-size:12px;">${currency}${priced.unitPrice.toFixed(2)}${priced.isBlended ? " avg" : ""} per piece <span class="badge badge-neutral pc-multiplier">×${line.unitCount || priced.units / Math.max(line.packQty, 1)}</span> <span style="color:var(--text-secondary);">= ${priced.units} pieces</span></div>
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
        lineTotal.textContent = `${currency}${priced.lineTotal.toFixed(2)}`;
        row.appendChild(qtyInput);
        row.appendChild(lineTotal);
        row.appendChild(removeBtn);
        list.appendChild(row);
        list.appendChild(noteEditor(line));
        return;
      }

      row.innerHTML = `
        <span class="dot" style="width:18px;height:18px;border-radius:5px;background:${line.colorHex};flex:none;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;">${esc(line.productName)}</div>
          <div style="font-size:12px;color:var(--text-secondary);">${esc(line.color)} · ${esc(line.size)} · ${currency}${priced.unitPrice.toFixed(2)} per piece × ${priced.units}</div>
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
      lineTotal.textContent = `${currency}${priced.lineTotal.toFixed(2)}`;

      row.appendChild(qtyInput);
      row.appendChild(lineTotal);
      row.appendChild(removeBtn);
      list.appendChild(row);
      list.appendChild(noteEditor(line));

      // Batch 8: tiered-price nudge for this line, using the SAME
      // cross-colourway aggregate basis Batch 6 established (every cart
      // line for this product, any colour/size, summed together).
      const tiers = line.productId ? tiersByProduct.get(line.productId) || [] : [];
      // One nudge per product, not one per line: with packs now carrying a
      // productId, a cart holding two lines of the same product would
      // otherwise print the identical sentence twice.
      const firstLineOfProduct = current.findIndex((l) => l.productId === line.productId) === lineIndex;
      if (tiers.length && firstLineOfProduct) {
        // Pack pieces count here now (aggregateQtyByProduct expands them), so
        // a cart of packs is told about the break it has actually reached
        // instead of being told it has ordered nothing.
        const aggQty = aggregateQtyByProduct(current).get(line.productId) || 0;
        const nt = nextTier(tiers, aggQty);
        if (nt) {
          const nudge = document.createElement("div");
          nudge.style.cssText = "font-size:11px;color:var(--accent-600,#2f6b4f);padding:0 12px 10px 42px;border-bottom:1px solid var(--border-subtle);margin-top:-1px;";
          nudge.textContent = `Add ${nt.minQty - aggQty} more pieces of this product (any colour/size) to reach ${currency}${nt.unitPrice.toFixed(2)} each`;
          list.appendChild(nudge);
        }
      }
    });

  /** Migration 086 -- the buyer's note for one cart line.
   *
   * Deliberately NOT hidden behind a "add a note" link that has to be found.
   * The research on this feature is unambiguous: the dominant real-world
   * failure is not that notes are badly designed, it is that they sit
   * somewhere nobody opens. A collapsed affordance on the BUYER's side is
   * less harmful than on the reader's side, but an always-visible one costs
   * nothing here and removes the question entirely.
   *
   * Saves on blur rather than on every keystroke: a note can be long, and
   * rewriting localStorage per character is how a cheap feature becomes a
   * janky one on an older phone. */
  function noteEditor(line) {
    const wrap = document.createElement("div");
    wrap.className = "cart-note";
    wrap.style.cssText = "padding:0 12px 12px 12px;border-bottom:1px solid var(--border-subtle);margin-top:-1px;";

    const label = document.createElement("label");
    label.style.cssText = "display:block;font-size:11px;color:var(--text-tertiary);margin-bottom:4px;";
    label.textContent = "Note for this item (optional)";

    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.rows = 1;
    ta.placeholder = "e.g. send this one in the darker blue";
    ta.value = line.note || "";
    ta.style.cssText = "width:100%;min-height:38px;resize:vertical;font-size:13px;line-height:1.4;";
    ta.setAttribute("aria-label", "Note for this item");

    // Grow with the content: "an unlimited amount of writing" is the stated
    // requirement, and a one-row box that never grows silently discourages it.
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; };
    ta.addEventListener("input", grow);
    requestAnimationFrame(grow);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;color:var(--text-tertiary);margin-top:4px;min-height:14px;";

    ta.addEventListener("blur", () => {
      const before = line.note || "";
      const after = ta.value.trim();
      if (before === after) { hint.textContent = ""; return; }
      const result = cart.setLineNote(wid, line, after);
      if (!result.ok) {
        // Never fail silently: a note the buyer believes they left, that was
        // not stored, is worse than no note field at all.
        hint.textContent = "That note could not be saved — please try again.";
        hint.style.color = "var(--danger,#c33)";
        return;
      }
      line.note = result.note || "";
      hint.style.color = "var(--text-tertiary)";
      hint.textContent = after ? "Saved. The wholesaler will see this." : "Note cleared.";
      setTimeout(() => { hint.textContent = ""; }, 2500);
    });

    wrap.appendChild(label);
    wrap.appendChild(ta);
    wrap.appendChild(hint);
    return wrap;
  }

    if (!current.length) {
      outlet.querySelectorAll(".cart-summary,.card").forEach((n) => n.remove());
      outlet.appendChild(emptyState({ icon: "🧺", title: "Your cart is empty", body: "Add products from the catalog to see them here." }));
    }
  }

  const summary = document.createElement("div");
  summary.className = "cart-summary card";
  summary.style.cssText = "margin-top:16px;padding:18px;display:flex;justify-content:space-between;align-items:center;";

  // Rebuilt by every renderSummary() paint; held here so the submit handler
  // can read the CURRENT box rather than a stale closure over an old one.
  let orderNoteInput = null;

  function renderSummary() {
    const current = cart.get(wid);
    // The same priceCart() the lines above were printed from, so the subtotal
    // is the sum of the numbers on screen by construction rather than by a
    // second calculation that happens to agree.
    const { subtotal, lines: pricedLines } = priceCart(current, pricingCtx());
    const totalPieces = pricedLines.reduce((s2, p) => s2 + p.units, 0);
    summary.innerHTML = `<div><div style="font-size:12px;color:var(--text-tertiary);">Subtotal · ${totalPieces} piece${totalPieces === 1 ? "" : "s"}</div><div style="font-size:22px;font-weight:700;">${currency}${subtotal.toFixed(2)}</div></div>`;
    // ---- Migration 086: one note about the order as a whole ---------------
    // v2_orders.notes has existed since migration 004 and nothing has ever
    // written to it. This is the field that fills it.
    const noteBox = document.createElement("div");
    noteBox.style.cssText = "width:100%;margin:10px 0 12px 0;";
    const noteLabel = document.createElement("label");
    noteLabel.style.cssText = "display:block;font-size:12px;font-weight:600;margin-bottom:4px;";
    noteLabel.textContent = "Anything else for this order? (optional)";
    orderNoteInput = document.createElement("textarea");
    orderNoteInput.className = "input";
    orderNoteInput.rows = 2;
    orderNoteInput.placeholder = "e.g. deliver before Thursday";
    orderNoteInput.style.cssText = "width:100%;min-height:52px;resize:vertical;font-size:13px;line-height:1.4;";
    orderNoteInput.setAttribute("aria-label", "Note for this order");
    orderNoteInput.value = cart.getOrderNote(wid) || "";
    const growOrderNote = () => {
      orderNoteInput.style.height = "auto";
      orderNoteInput.style.height = `${Math.min(orderNoteInput.scrollHeight, 300)}px`;
    };
    orderNoteInput.addEventListener("input", growOrderNote);
    requestAnimationFrame(growOrderNote);
    // Persisted on blur so it survives a reload, exactly like the cart lines.
    orderNoteInput.addEventListener("blur", () => cart.setOrderNote(wid, orderNoteInput.value));
    noteBox.appendChild(noteLabel);
    noteBox.appendChild(orderNoteInput);
    summary.appendChild(noteBox);

    const submitBtn = document.createElement("button");
    submitBtn.className = "btn btn-primary";
    submitBtn.textContent = "Submit order";
    submitBtn.disabled = !current.length || !location;
    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      const label = buyerLabel();
      // Batch S/S5: was `session.clientId || await resolveClientId(wid, label)`.
      // resolveClientId read v2_clients directly and, under RLS, an anon buyer
      // has always got nothing back -- so the fallback has only ever produced
      // null. After S7 it would raise instead. The server re-derives the client
      // from the validated account anyway (migration 048), so nothing is lost.
      const clientId = session.clientId || null;
      const result = await cart.submit(wid, {
        buyerLabel: label, locationId: location.id, clientId,
        accountId: session.accountId,
        // Migration 086. Read at submit time rather than captured when the
        // field was built, so a note typed and not blurred still travels.
        notes: (orderNoteInput && orderNoteInput.value.trim()) || cart.getOrderNote(wid) || null,
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
          const pack = await getBuyerPack(session.accountId, item.packId);
          if (!pack) { failures++; continue; }
          // productId comes off the live pack definition (prepacks.js exposes it
          // as of Batch 5), so a reordered pack is counted toward this
          // product's quantity break exactly like a freshly added one.
          const r = await cart.addPack(wid, pack, item.packQty, location.id, undefined, { productId: pack.productId });
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
  // Batch S / S2b: through the gate, across every catalog this buyer may see.
  // A favourite starred in one catalog must still appear when another is
  // active, so this cannot read just the active one.
  const [visible, wholesaler, location] = await Promise.all([
    buyerCatalogs(session.accountId),
    getWholesaler(wid),
    defaultLocation(wid),
  ]);
  const catalog = await getBuyerVisibleProducts(session.accountId, visible.map((c) => c.id));
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

  // Batch S / S2. One gated call, where there used to be an id list plus a
  // whole-tenant table read that the gate had no say over. The ordering,
  // the highlighted flag and the filtering to THIS catalog are all the
  // database's now -- there is nothing left here to get them wrong.
  const products = await getCatalogByToken(token, session.accountId || null);

  if (!products.length) {
    outlet.appendChild(emptyState({
      icon: "🗂", title: "Nothing in this catalog yet",
      body: "The products are on their way. Check the link again shortly.",
    }));
    return;
  }

  const { tiersByProduct, overridesByVariant, discountPct } =
    await getPricingContext(products.map((p) => p.id), session.accountId, {
      // Batch S/S4: the link route passes its TOKEN, so the database can
      // gate the tiers and the discount on the link the buyer actually holds.
      clientId: session.clientId || null, catalogId: resolved.id, token,
    });
  const customerPct = Number(session.discountPct) || 0;
  // Batch S / S3. `packs` used to be a hard-coded [] here, and that was a live
  // bug, not a placeholder: a series/prepack/ratio product with no packs takes
  // the card's dead-end branch and prints "This product has no bundles set up
  // yet, so it cannot be ordered. Ask the wholesaler to add one." The
  // wholesaler HAD set one up. On production, 26 Aug: 13 of 23 products, five
  // of six wholesalers, un-orderable on the share link -- the one channel this
  // product is built around -- and blamed on the wholesaler.
  const [location, linkPacks] = await Promise.all([
    defaultLocation(wid),
    listPacksByToken(token, session.accountId || null),
  ]);

  const cardFor = (product) => renderProductCard({
    product, wid, locationId: location?.id, currency: "$",
    tiers: tiersByProduct.get(product.id) || [],
    overridesByVariant, discountPct, customerPct,
    packs: linkPacks.get(product.id) || [],
    highlighted: !!product.highlighted,
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
  // Batch S: the flag rides on the product now, from the catalog's own row.
  // It used to come from a separate id list fetched alongside a whole-tenant
  // table read; that list is gone, and so is the chance of the two disagreeing.
  const highlighted = products.filter((p) => p.highlighted);
  const rest = products.filter((p) => !p.highlighted);

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

  // MK-01 — A PRODUCT IN A STORE THIS BUYER MAY NOT CURRENTLY BE IN.
  //
  // This is the destination three shipped features have been pointing at and
  // missing: the directory, cross-store search, and the reorder rail all hand
  // back products from stores other than the open one, and until now there was
  // nowhere for a tap to go.
  //
  // enterStore() is a SERVER round trip — v2_session_account re-checks the
  // membership — so this route cannot be used to enter a store by typing its
  // id into the address bar. A buyer who was revoked gets the refusal, not the
  // catalogue.
  router.register("/buyer/s/:wid/p/:productId", async (outlet, params) => {
    const session = devAuth.getSession();
    if (session?.wid === params.wid) {
      // Already in that store: just point at the product.
      pendingProductFocus = params.productId;
      return dashboard(outlet);
    }
    if (!marketplaceSession()) {
      // Signed in through the per-store door, so there is no way to move.
      // Say which store it belongs to rather than failing blankly.
      outlet.appendChild(emptyState({
        icon: "🏬",
        title: "That product is in another wholesaler's store",
        body: "Sign in with your phone number to move between the wholesalers you buy from.",
      }));
      return;
    }
    const r = await enterStore(params.wid);
    if (!r.ok) {
      outlet.appendChild(emptyState({
        icon: "🔒",
        title: "You do not have access to that store",
        body: "Ask them for access from Browse our wholesalers, and they will let you in from their side.",
      }));
      return;
    }
    pendingProductFocus = params.productId;
    return dashboard(outlet);
  });
  router.register("/buyer/cart", (outlet) => cartView(outlet));
  router.register("/buyer/orders", (outlet) => ordersView(outlet));
  router.register("/buyer/favourites", (outlet) => favouritesView(outlet));
  router.register("/buyer/suppliers", (outlet) => suppliers(outlet));
  registerDirectoryRoutes(router);
  registerSearchRoutes(router);
  // MK-01, 1 Sep 2026. The marketplace home. Registered here rather than
  // replacing /buyer, because /buyer is the store you are INSIDE and it keeps
  // that job — the reference app Hadi sent works the same way, and the
  // per-store catalogue is what a buyer sees after they open a shop.
  registerMarketplaceRoutes(router);
}

