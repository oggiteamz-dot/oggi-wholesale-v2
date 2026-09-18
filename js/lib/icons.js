// =============================================================================
// OGGI Wholesale v2 — NAVIGATION ICONS                        18 Sep 2026
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// The navigation shipped with emoji: ◆ 📥 👥 🗂 🔑 📊 ⬆️ 🔌 ⚙️. Emoji are the
// fastest way to get an icon and the single most amateur-looking thing on an
// otherwise careful screen, because they are somebody else's artwork: they
// carry their own colours, their own weights, and a different drawing on every
// operating system. A wholesaler on Windows and one on an iPhone were not
// looking at the same product.
//
// These are 24x24 line icons on a common grid, drawn with `currentColor` and a
// 1.6 stroke, so they take the nav item's colour -- grey at rest, mint on the
// active ink pill -- and they are identical on every device.
//
// KEYED BY ROUTE, NOT BY LABEL. js/lib/nav-config.js is read by
// checks/check_nav_completeness.mjs, which asserts that bar + more equals the
// full list for every role; editing the `icon:` values in that array would
// register as a change to the thing the gate is guarding. The routes are
// already stable and already the identity of each destination, so this maps
// off them and nav-config is left exactly as it was. An unknown route falls
// back to the emoji it already had, so nothing can vanish.
// =============================================================================

const S = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;

export const NAV_ICONS = {
  // ---- owner ----
  "/owner":              S('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z"/>'),
  "/owner/search":       S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  "/owner/wholesalers":  S('<path d="M3 21h18M5 21V8l7-4 7 4v13M10 21v-5h4v5"/>'),
  "/owner/onboarding":   S('<path d="M4 12.5l5 5L20 6.5"/>'),
  "/owner/invites":      S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>'),
  "/owner/exports":      S('<path d="M12 3v11m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  "/owner/audit":        S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  "/owner/ranking":      S('<path d="M12 4v16M5 9l7-5 7 5M4.5 9h15M7 9l-2.5 6h5zM17 9l-2.5 6h5z"/>'),
  // ---- wholesaler ----
  "/wholesaler":            S('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z"/>'),
  "/wholesaler/orders":     S('<path d="M4 7h16l-1.2 11.2A2 2 0 0116.8 20H7.2a2 2 0 01-2-1.8z"/><path d="M9 7V5.5a3 3 0 016 0V7"/>'),
  "/wholesaler/clients":    S('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><path d="M16 6.2a3 3 0 010 5.6M17.5 19a5.6 5.6 0 00-2-4"/>'),
  "/wholesaler/catalogs":   S('<path d="M4 5.5A1.5 1.5 0 015.5 4H10l1.5 2H19a1 1 0 011 1v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18z"/>'),
  "/wholesaler/team":       S('<circle cx="8.5" cy="14.5" r="3.5"/><path d="M11.4 12.6L19 5m-2 0h3v3"/>'),
  "/wholesaler/inventory":  S('<path d="M3.5 8.5L12 4l8.5 4.5v7L12 20l-8.5-4.5z"/><path d="M3.5 8.5L12 13l8.5-4.5M12 13v7"/>'),
  "/wholesaler/import":     S('<path d="M12 20V9m0 0l-4 4m4-4l4 4M5 7V5a2 2 0 012-2h10a2 2 0 012 2v2"/>'),
  "/wholesaler/integrations": S('<path d="M9 3v5M15 3v5M6.5 8h11v5a5.5 5.5 0 01-11 0z"/><path d="M12 18.5V21"/>'),
  "/wholesaler/settings":   S('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/>'),
  // ---- desks ----
  "/warehouse":     S('<path d="M4 20V9.5L12 5l8 4.5V20"/><path d="M9 20v-6h6v6"/>'),
  "/finance":       S('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5h.01M17.5 14.5h.01"/>'),
  "/finance/aging": S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
  // ---- sales ----
  "/sales":         S('<path d="M4 18l5-6 4 3.5L20 7"/><path d="M15 7h5v5"/>'),
  "/sales/clients": S('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><path d="M16 6.2a3 3 0 010 5.6M17.5 19a5.6 5.6 0 00-2-4"/>'),
  "/sales/orders":  S('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>'),
  "/sales/visits":  S('<path d="M12 21s7-5.8 7-11a7 7 0 10-14 0c0 5.2 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  // ---- buyer ----
  "/buyer/market":      S('<path d="M3.5 9l1.3-4.2A1.5 1.5 0 016.3 4h11.4a1.5 1.5 0 011.5 1l1.3 4"/><path d="M3.5 9h17v9.5A1.5 1.5 0 0119 20H5a1.5 1.5 0 01-1.5-1.5z"/><path d="M8 9a4 4 0 008 0"/>'),
  "/buyer":             S('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  "/buyer/cart":        S('<path d="M3 4h2.2l2.3 11.2A2 2 0 009.5 17h7.8a2 2 0 002-1.6L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/>'),
  "/buyer/orders":      S('<path d="M4 7h16l-1.2 11.2A2 2 0 0116.8 20H7.2a2 2 0 01-2-1.8z"/><path d="M9 7V5.5a3 3 0 016 0V7"/>'),
  "/buyer/favourites":  S('<path d="M12 20.3l-1.4-1.3C5.9 14.9 3 12.3 3 9.1A4.6 4.6 0 017.6 4.5 5 5 0 0112 6.6a5 5 0 014.4-2.1A4.6 4.6 0 0121 9.1c0 3.2-2.9 5.8-7.6 9.9z"/>'),
  "/buyer/search":      S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  "/buyer/wholesalers": S('<path d="M3 21h18M5 21V8l7-4 7 4v13M10 21v-5h4v5"/>'),
  "/buyer/suppliers":   S('<path d="M3 21h18M5 21V8l7-4 7 4v13M10 21v-5h4v5"/>'),
};

/** The icon for a route, or `null` when there is none — callers keep whatever
 *  they had, so a new nav entry never renders a blank square. */
export function navIcon(path) {
  return NAV_ICONS[path] || null;
}
