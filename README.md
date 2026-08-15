# OGGI Wholesale v2

A wholesale ordering app: wholesalers publish a catalogue, buyers order from it,
warehouse staff pick the orders. Built as a plain-JavaScript PWA with a Supabase
backend, deployed on Cloudflare Workers.

**Live:** https://oggi-wholesale-v2.oggi-teamz.workers.dev

---

## What this is, in plain English

Wholesale is not retail. The rules that make it wholesale are:

- **Minimum order quantities.** A buyer cannot take one of something. Minimums
  apply per SKU, per product across all colours and sizes, and per order.
- **Colour × size stock.** A "product" is not one number. A blue medium and a
  blue large are different things with different stock levels, and the app has
  to know that at every layer.
- **Packs.** A wholesaler can sell a fixed bundle — "1 small, 2 medium, 2 large"
  — as a single sellable unit. Inside a pack, the per-SKU minimum does not apply,
  because the pack itself is what's being sold.

Most of the complexity in this codebase exists to enforce those three things
honestly, including against a customer who edits their own browser.

---

## Layout

```
index.html            the whole app shell (hash-based routing, no framework)
css/                  design tokens, base, layout, components, animations
js/
  app.js              entry point and router wiring
  lib/
    utils.js          esc / money / pageHeader -- THE shared helpers (see below)
    router.js         hash router
    supabase-client.js
    dev-auth.js       session handling
    animations/       fly-to-cart, hologram viewer, order celebration
  components/         product card, toolbar, nav, toast, badges
  data/               business logic, one file per concern (25 files)
  views/              one file per screen, by role
supabase/
  migrations/         28 numbered SQL migrations, run in order
  functions/          6 edge functions (webhooks, AI catalog import, OAuth)
checks/               behaviour gates -- see checks/README.md
docs/                 batch-by-batch deploy records
```

`js/data/` is the part that matters most structurally: each file is one concern,
under ~310 lines. A change to pricing cannot silently delete prepacks, because
they live in different files.

---

## The one rule that matters: don't duplicate helpers

`js/lib/utils.js` holds `esc`, `money` and `pageHeader`. **Import them. Never
copy them.**

This is not style advice. Before August 15 2026 the escape helper existed in
**fourteen copies under four different names**, and `pageHeader` in seven. Two
files each contained two identical copies of the same function. That produced
two real defects:

1. **Drift.** Four `pageHeader` copies rendered a page-actions slot and three did
   not, so three screens structurally could not host a page-level button. Nobody
   decided that — someone updated four files and stopped.
2. **An unescaped sink.** Every copy of `pageHeader` wrote its title straight
   into `innerHTML` while an escape helper sat unused a few lines above it.

Duplicated helpers do not stay identical. They wait.

---

## Checks

`checks/` contains behaviour gates — they exercise the real thing and assert what
it does, rather than checking that a function still has a particular name.

- `check_pack_moq.sh` — proves minimum order quantity cannot be switched off by
  the client. 11 assertions.
- `check_escaping.mjs` — proves user-controlled values cannot inject HTML.
  13 assertions, run against a real DOM.

**A check is not finished until it has been proven to go red.** Break the thing
it guards, watch it fail, restore it, watch it pass. A check that has only ever
been green may be passing for a reason you did not intend — during development
`check_pack_moq.sh` reported 7 green while the database function was crashing on
every single call. See `checks/README.md`.

---

## Deployment

Pushing to `main` deploys automatically (Cloudflare Workers Builds → `npx
wrangler deploy`).

Because deploys run through `wrangler`, **`.assetsignore` is honoured** — so
`supabase/`, `docs/`, `checks/`, `wrangler.toml` and `worker.js` are never served
publicly. Keep that file accurate if you add a top-level folder.

> ⚠️ **Do not deploy by dragging this folder onto the Cloudflare dashboard
> uploader.** That uploader ignores `.assetsignore` and would publish
> `supabase/` — your database migrations — to the open web.

---

## Database

28 migrations in `supabase/migrations/`, applied in order. All v2 objects live in
the **`wholesale_v2`** schema (moved there by migration 026), not `public`.

**Before editing any database function, read its CURRENT definition from the
database** (`select prosrc from pg_proc where proname = '...'`), not from
whichever migration file is easiest to find. Migration files are a history, not
a description of what is running. Migration 012 and migration 024 both define
`v2_submit_order`; 012's version has five parameters and 024's has six, and
rebuilding from the wrong one silently deletes an authorisation check.

New migrations must **schema-qualify their type references** (`returns
wholesale_v2.v2_orders`), because return types and `%rowtype` declarations
resolve against the session search path at creation time, not the function's own
`set search_path`.

---

## Known gaps

- **Two of four selling models are missing.** Open stock and prepack/ratio-pack
  work. "Full series" and "Fixed box" do not exist — there is no `selling_model`
  column on `v2_products`. Both are additive on the existing pack machinery.
- **`pack_price` is never applied at checkout.** It is stored and displayed, but
  every line is priced individually, so a flat pack price does not change what a
  buyer is charged.
- **Editing a pack invalidates carts.** The cart snapshots a pack's composition
  when it is added. If a wholesaler edits the pack meanwhile, checkout fails with
  an unhelpful message. Safe, but it needs a "this pack changed" screen.
- **`js/views/wholesaler.js` is 68 KB and holds nine screens.** The last
  monolith; splitting it is planned.
