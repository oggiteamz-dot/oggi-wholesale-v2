# Batch 0 — Deploy Record
**Project scaffold & dev-mode access · 11 Aug 2026**

## What was built
- New `wholesale-v2/` project structure: `css/`, `js/{lib,components,views,data}`, `supabase/migrations`, `docs/` — modular, small purpose-fit files throughout, per the standing "never one monolithic file" rule.
- Light-mode-first design token system (`css/tokens.css`) — light is the only theme; no dark mode exists in v2, per Hadi's explicit instruction. Base reset/typography (`css/base.css`), shared component styles for buttons/inputs/badges/cards/toasts (`css/components.css`), app-shell layout for topbar + side nav + outlet (`css/layout.css`).
- Dev-mode auth stub (`js/lib/dev-auth.js`) — role picker (Owner/Wholesaler/Salesperson/Buyer), no real security, session stored in `localStorage` under a v2-only key so it can never collide with anything v1. Explicitly commented as temporary and scheduled for full replacement in Batch 14 (Security, built last by design).
- Minimal dependency-free hash router (`js/lib/router.js`) supporting param segments, used instead of pulling in a framework — keeps the whole app buildable/testable with zero build step.
- Base layout shell wired for all four roles: topbar (`js/components/topbar.js`), side nav driven by a single nav-config source of truth (`js/lib/nav-config.js`, `js/components/sidenav.js`), and per-role view modules (`js/views/{owner,wholesaler,salesperson,buyer}.js`) — each registers its real routes now; most routes currently render an honest "not built yet, scheduled in Batch N" empty state rather than faking data.
- Supabase client (`js/lib/supabase-client.js`) pointed at the same `oggi-wholesale` project v1 uses, on the new publishable key. Not yet wired into any view — that starts in Batch 1's data layer.

## Database
Batch 1's core schema migration (`supabase/migrations/001_v2_inventory_core.sql`) was applied to the live project (`olaipgdckbgjediddloj`) this session — see that file for full detail. Verified via `list_tables` before and after: all 14 pre-existing v1 tables unchanged (row counts identical), 11 new `v2_`-prefixed tables + 1 date partition added, zero collisions. One advisory finding (the August partition table didn't inherit RLS enablement) was found and fixed immediately (`alter table ... enable row level security`).

## Self-test performed
Served the scaffold locally (`python3 -m http.server`) and drove it with Playwright (chromium):
- Role picker renders all 4 roles.
- Logging in as Wholesaler correctly persists a dev session, redirects to `#/wholesaler`, and renders the role-scoped side nav (7 items, matches `nav-config.js`).
- Clicking a nav item (Products) navigates via the router to a real, distinct route and renders that route's placeholder — confirming routing is real, not decorative.
- "Switch role" clears the session and returns to the login screen.
- Logging in as Buyer and reloading the page correctly restores the session from `localStorage` (session persistence works).
- Zero console errors and zero failed network requests during the full flow (the only 404 observed in an earlier pass was the browser's automatic `favicon.ico` request, unrelated to app code — confirmed by re-running with response-code logging isolated to the actual login/navigation flow, which came back clean).

## Known gaps / explicitly not done in this batch
- Not yet deployed to a live URL/subdomain. This session has no Cloudflare deploy credentials or MCP tool access, so v2 cannot be pushed to Cloudflare Pages/Workers from here the way v1 is hosted. The app is fully functional locally (any static file server works, no build step) and every file is saved to your machine — deploying it live is a manual step (or something to hand me credentials/a wrangler token for next time) rather than a shortcut taken here.
- No real data anywhere yet — every dashboard stat is a placeholder `—`, every non-home route is an honest empty state. Real data starts with Batch 1's migration script (pulling actual v1 wholesalers/products/orders/clients into the new schema) and continues through Batches 2-5 (re-implementing all four roles' verified v1 features with zero regression).
- `favicon.ico` doesn't exist yet — cosmetic only, not fixed here since it's not part of any batch's scope.

## Files (13, all new)
```
wholesale-v2/index.html
wholesale-v2/css/tokens.css
wholesale-v2/css/base.css
wholesale-v2/css/components.css
wholesale-v2/css/layout.css
wholesale-v2/js/app.js
wholesale-v2/js/lib/supabase-client.js
wholesale-v2/js/lib/dev-auth.js
wholesale-v2/js/lib/router.js
wholesale-v2/js/lib/nav-config.js
wholesale-v2/js/components/topbar.js
wholesale-v2/js/components/sidenav.js
wholesale-v2/js/components/empty-state.js
wholesale-v2/js/views/login.js
wholesale-v2/js/views/owner.js
wholesale-v2/js/views/wholesaler.js
wholesale-v2/js/views/salesperson.js
wholesale-v2/js/views/buyer.js
```

## Status: DONE. No known failing tests, no partial implementation within this batch's stated scope. Proceeding to Batch 1 (core data migration script).
