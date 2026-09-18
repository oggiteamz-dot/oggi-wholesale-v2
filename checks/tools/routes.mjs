// The route census, as data. One place, read by the walker and by the
// before/after sheet, so the two can never disagree about what "every screen"
// means. Taken from the real registerXRoutes() calls in js/views/*.js on
// 18 Sep 2026 — 60 routes, six roles, five public entry points.
export const ROUTES = {
  public: [
    ["PUB-01", "/login",            "Sign in"],
  ],
  buyer: [
    ["BUY-01", "/buyer/market",     "Marketplace"],
    ["BUY-02", "/buyer/search",     "Cross-store search"],
    ["BUY-03", "/buyer",            "Catalogue (inside a store)"],
    ["BUY-05", "/buyer/cart",       "Cart"],
    ["BUY-06", "/buyer/orders",     "My orders"],
    ["BUY-08", "/buyer/favourites", "Favourites"],
    ["BUY-09", "/buyer/wholesalers","Wholesaler directory"],
    ["BUY-10", "/buyer/suppliers",  "Suppliers (legacy alias)"],
  ],
  wholesaler: [
    ["WS-01", "/wholesaler",                     "Dashboard"],
    ["WS-02", "/wholesaler/orders",              "Orders"],
    ["WS-03", "/wholesaler/clients",             "Clients"],
    ["WS-04", "/wholesaler/requests",            "Access requests"],
    ["WS-05", "/wholesaler/catalogs",            "Catalogues"],
    ["WS-06", "/wholesaler/team",                "Team & buyers"],
    ["WS-07", "/wholesaler/inventory",           "Inventory · Stock"],
    ["WS-07b","/wholesaler/inventory/products",  "Inventory · Products"],
    ["WS-07c","/wholesaler/inventory/pricing",   "Inventory · Pricing rules"],
    ["WS-07d","/wholesaler/movements",           "Inventory · Movements"],
    ["WS-07e","/wholesaler/locations",           "Inventory · Locations"],
    ["WS-07f","/wholesaler/suppliers",           "Inventory · Suppliers"],
    ["WS-07g","/wholesaler/labels",              "Inventory · Labels"],
    ["WS-07h","/wholesaler/receive-scan",        "Inventory · Scan"],
    ["WS-07i","/wholesaler/intelligence",        "Inventory · Insights"],
    ["WS-08", "/wholesaler/import",              "Import catalogue"],
    ["WS-09", "/wholesaler/integrations",        "Integrations"],
    ["WS-10", "/wholesaler/settings",            "Settings"],
    ["WS-11", "/wholesaler/links",               "Share links"],
    ["WS-12", "/wholesaler/visibility",          "Marketplace visibility"],
    ["WS-13", "/wholesaler/ranking-policy",      "Ranking policy"],
    ["WS-15", "/wholesaler/products",            "Products (legacy route)"],
  ],
  sales: [
    ["REP-01", "/sales",         "Rep dashboard"],
    ["REP-02", "/sales/clients", "My clients"],
    ["REP-03", "/sales/orders",  "Orders"],
    ["REP-04", "/sales/visits",  "Visit log"],
  ],
  warehouse: [
    ["WH-01", "/warehouse", "Picking queue"],
  ],
  finance: [
    ["FIN-01", "/finance",       "Finance orders"],
    ["FIN-02", "/finance/aging", "Who owes what"],
  ],
  owner: [
    ["OWN-01", "/owner",              "Owner dashboard"],
    ["OWN-02", "/owner/search",       "Universal search"],
    ["OWN-03", "/owner/wholesalers",  "Wholesalers"],
    ["OWN-04", "/owner/onboarding",   "Onboarding queue"],
    ["OWN-05", "/owner/invites",      "Invites"],
    ["OWN-06", "/owner/exports",      "Exports"],
    ["OWN-07", "/owner/audit",        "Audit log"],
    ["OWN-08", "/owner/ranking",      "Ranking"],
  ],
};
export const TOTAL = Object.values(ROUTES).reduce((n, r) => n + r.length, 0);
