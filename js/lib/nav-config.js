// OGGI Wholesale v2 — per-role side navigation config
// Single source of truth for what nav items each role sees. Views read
// their own routes from here too, so nav + routing never drift apart.

export const NAV_BY_ROLE = {
  owner: [
    { icon: "◆", label: "Dashboard", path: "/owner" },
    { icon: "🔍", label: "Universal Search", path: "/owner/search" },
    { icon: "🏢", label: "Wholesalers", path: "/owner/wholesalers" },
    { icon: "✅", label: "Onboarding Queue", path: "/owner/onboarding" },
    { icon: "✉️", label: "Invites", path: "/owner/invites" },
    { icon: "📄", label: "Exports", path: "/owner/exports" },
    { icon: "🕓", label: "Audit Log", path: "/owner/audit" },
  ],
  wholesaler: [
    { icon: "◆", label: "Dashboard", path: "/wholesaler" },
    { icon: "📦", label: "Products", path: "/wholesaler/products" },
    { icon: "📥", label: "Orders", path: "/wholesaler/orders" },
    { icon: "👥", label: "Clients", path: "/wholesaler/clients" },
    { icon: "🗂", label: "Catalogs", path: "/wholesaler/catalogs" },
    { icon: "🔑", label: "Team & Buyers", path: "/wholesaler/team" },
    { icon: "📊", label: "Inventory", path: "/wholesaler/inventory" },
    // Added 18 Aug 2026. Stock has been per-location in the data since
    // migration 001, but nothing could create a second location and nothing
    // could move stock between two -- regression ledger #17.
    // Batch 2. The stock ledger has been written since migration 001 and had
    // nowhere to be seen. Sits directly under Inventory because it answers the
    // question Inventory provokes: "why is this number what it is?"
    { icon: "🕓", label: "Stock Movements", path: "/wholesaler/movements" },
    { icon: "🏬", label: "Locations", path: "/wholesaler/locations" },
    // Batch 17. Sits next to Locations because both answer "where does stock
    // come from and go" -- Locations is inside the business, Suppliers is the
    // step before it.
    { icon: "🏭", label: "Suppliers", path: "/wholesaler/suppliers" },
    { icon: "🧠", label: "Intelligence", path: "/wholesaler/intelligence" },
    { icon: "📷", label: "Scan to Receive", path: "/wholesaler/receive-scan" },
    { icon: "⬆️", label: "Import Catalog", path: "/wholesaler/import" },
    { icon: "🔌", label: "Integrations", path: "/wholesaler/integrations" },
    { icon: "⚙️", label: "Settings", path: "/wholesaler/settings" },
  ],
  sales: [
    { icon: "◆", label: "Dashboard", path: "/sales" },
    { icon: "👥", label: "My Clients", path: "/sales/clients" },
    { icon: "🧾", label: "Orders", path: "/sales/orders" },
    { icon: "📍", label: "Visit Log", path: "/sales/visits" },
  ],
  buyer: [
    { icon: "◆", label: "Catalog", path: "/buyer" },
    { icon: "🧺", label: "Cart", path: "/buyer/cart" },
    { icon: "📦", label: "My Orders", path: "/buyer/orders" },
    { icon: "★", label: "Favourites", path: "/buyer/favourites" },
    // "Suppliers" removed 18 Aug 2026. It led to a grid of every wholesaler on
    // the platform by brand name -- OGGI's entire client list, shown to every
    // buyer. The /buyer/suppliers ROUTE still exists and explains itself (see
    // js/views/buyer.js) so an installed PWA with the old tab cached does not
    // land on a 404; it simply has no entry in the navigation any more.
    //
    // Its replacement is the Marketplace: products from many wholesalers, no
    // wholesaler names anywhere, all of it presented as OGGI. When that ships
    // it is added HERE, as a new item, and Gate 2 picks it up on both the
    // desktop sidebar and the phone bar automatically.
  ],
};

export const ROLE_LABEL = {
  owner: "Owner / Admin",
  wholesaler: "Wholesaler",
  sales: "Salesperson",
  buyer: "Buyer",
};

// =============================================================================
// MOBILE NAVIGATION SUPPORT  (added 17 Aug 2026, mobile-first pass)
// =============================================================================
//
// WHY THIS LIVES HERE AND NOT IN THE COMPONENT
// --------------------------------------------
// Below 880px the sidebar is hidden, so a phone needs its own navigation.
// The obvious way to build one is to hand-pick "the important five" screens
// for a bottom bar. That is exactly how screens go missing: the wholesaler
// role has twelve destinations, a bar holds five, and the other seven end up
// with no way in -- without deleting a single line of code.
//
// So the split is computed HERE, from the same array the desktop sidebar
// reads, and it is a pure function with no DOM in it so it can be tested
// directly. checks/check_nav_completeness.mjs asserts that bar + more equals
// the full list, exactly, for every role. A screen can only vanish from
// mobile by being deleted from this array -- at which point it vanishes from
// the desktop sidebar too, loudly, instead of quietly on one device class.

/** How many slots the bottom bar has, including the "More" button.
 *  Five is the practical ceiling: on a 360px screen (the narrow end of the
 *  Tecno/Infinix devices that are ~13% of Lebanese mobile traffic) five
 *  44px targets plus gaps is already the full width. */
export const MAX_BAR_ITEMS = 5;

/** Bar labels have roughly 9 characters before they truncate. These are the
 *  short forms for the labels that don't fit.
 *
 *  Kept as a separate map rather than a `short:` key on each nav item on
 *  purpose: editing those existing lines would register as deletions in
 *  Gate 1 (checks/check_no_feature_loss.sh), and the whole point of this
 *  pass is that it never deletes protected code. Additive by construction.
 *  Anything not listed here already fits and falls through to `label`. */
export const SHORT_LABEL = {
  "/owner/search": "Search",
  "/owner/wholesalers": "Sellers",
  "/owner/onboarding": "Queue",
  "/wholesaler/intelligence": "Insights",
  "/wholesaler/receive-scan": "Scan",
  "/wholesaler/integrations": "Apps",
  "/wholesaler/import": "Import",
  "/sales/clients": "Clients",
  "/sales/visits": "Visits",
  "/wholesaler/locations": "Places",
  "/buyer/favourites": "Saved",
  "/buyer": "Catalog",
  // "Dashboard" ellipsises in a 5-slot bar at 375px once the active tab
  // takes its heavier weight. Measured, not guessed.
  "/owner": "Home",
  "/wholesaler": "Home",
  "/sales": "Home",
};

/** The label to show in the bottom bar. Full labels are always used in the
 *  "More" hub, where there is room for them. */
export function shortLabel(item) {
  return SHORT_LABEL[item.path] || item.label;
}

/** The "More" button. Not a real destination -- it opens the hub sheet --
 *  so it carries `path: null` and `isMore: true`. Gate 2 looks for exactly
 *  this flag to confirm that an overflow actually has a door. */
export const MORE_ITEM = { icon: "☰", label: "More", path: null, isMore: true };

/**
 * Splits a role's nav items into what fits in the bottom bar and what goes
 * into the "More" hub. Pure -- no DOM, no globals -- so the gate can call it
 * directly in Node.
 *
 * Everything fits          -> all of it goes in the bar, no More button.
 * More items than slots    -> the first (MAX_BAR_ITEMS - 1) go in the bar,
 *                             a More button takes the last slot, and the
 *                             remainder go to the hub.
 *
 * Order is taken from NAV_BY_ROLE as-is. The arrays were already written
 * most-used-first, so no reordering was needed -- which matters, because
 * reordering lines would read as deletions to Gate 1.
 *
 * @param {Array<{icon:string,label:string,path:string}>} items
 * @returns {{bar:Array, more:Array}}
 */
export function splitNav(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= MAX_BAR_ITEMS) {
    return { bar: [...list], more: [] };
  }
  return {
    bar: [...list.slice(0, MAX_BAR_ITEMS - 1), MORE_ITEM],
    more: [...list.slice(MAX_BAR_ITEMS - 1)],
  };
}
