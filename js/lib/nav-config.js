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
    { icon: "🏢", label: "Suppliers", path: "/buyer/suppliers" },
  ],
};

export const ROLE_LABEL = {
  owner: "Owner / Admin",
  wholesaler: "Wholesaler",
  sales: "Salesperson",
  buyer: "Buyer",
};
