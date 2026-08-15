# PWA + TWA (Android app) — status and next steps

Written in response to "make them both TWAs and give me the access
credentials." Covers what's done, what's blocked and why, and the exact
commands to finish either app once it's unblocked.

## What a TWA actually needs (background)

A Trusted Web Activity is a real installable PWA (manifest + active
service worker) wrapped in a thin native Android shell that opens the
site in a full-screen Chrome tab with no browser UI — it looks and
behaves like a native app, but it IS the website, not a rewrite of it.
Three things are required, in order:

1. **The site itself must be an installable PWA** — a `manifest.json`
   and an active service worker, served over HTTPS.
2. **A live, public HTTPS domain** — the Android app verifies its
   identity at runtime by fetching `https://<domain>/.well-known/assetlinks.json`
   and checking it against the app's own signing certificate. This
   cannot be faked or worked around with a local/offline URL — Android
   makes that HTTPS request from the real device.
3. **A signed Android app package** (built with Google's Bubblewrap
   CLI, wrapping the live URL) — the same signing key must be used for
   every future update, so it needs to be kept somewhere safe
   indefinitely.

Google Play Store publishing is a separate, later step on top of all of
this, and needs its own developer account — not covered here, since
that was explicitly deferred.

## V2 — status: PWA done, TWA blocked on deployment

**Done, this session:**

- `manifest.json` (project root) — name, icons, `display: "standalone"`,
  theme color `#00A576` (matches the brand).
- `sw.js` (project root) — caches the static app shell (HTML/CSS/JS/icons)
  for instant loads and real offline capability, and deliberately
  **never** caches anything from `*.supabase.co` — data, auth, and
  orders must always be live, never served stale. See its own header
  comment for the full reasoning.
- `js/register-sw.js` — registers the service worker. Kept as an
  external file, not an inline `<script>` in `index.html`, because this
  build's CSP is `script-src 'self'` with no `unsafe-inline` — an
  inline registration script would be silently blocked by the browser.
- `icons/` — a full icon set (72–512px, plus two "maskable" variants for
  Android's adaptive-icon mask) generated from the OGGI logo.
- `index.html` — wired up with the manifest link, theme-color, and
  Apple/iOS home-screen meta tags.

**Verified locally** (Playwright, headless Chromium): the service
worker registers and reaches `active` state with zero console errors,
and — the real test — reloading the page with the network fully
disabled still renders the full login screen from the cached shell.

**Blocked on:** v2 has never been deployed anywhere (see
`docs/BATCH-14-SCHEMA-MIGRATION-RECORD.md` §3 and §5) — a TWA cannot be
built against a site with no live HTTPS URL, full stop, regardless of
Play Store plans. Two steps first:

1. Add `wholesale_v2` to Supabase's Exposed Schemas list (dashboard-only).
2. `npx wrangler login` + `npx wrangler deploy` from the project root
   (needs your own Cloudflare sign-in).

**Once v2 is live**, building the Android app is one command:

```
npx @bubblewrap/cli init --manifest="https://<your-v2-domain>/manifest.json"
# answer the prompts (package name, e.g. com.oggiteamz.wholesale2; app name; etc.)
# Bubblewrap generates a new signing keystore during this step — see
# "About the signing key" below before you run this.
npx @bubblewrap/cli build
```

This produces a signed `.aab` (Play Store format) and an installable
`.apk` (for direct/sideload install on a test phone) in the project
folder Bubblewrap creates. You'll also need to add the printed
`assetlinks.json` content to `.well-known/assetlinks.json` in the
deployed site and redeploy once, so the app can verify itself — the
Bubblewrap output tells you exactly what to paste.

## V1 — status: not started, pending your decision

v1 is already live (`https://oggi-wholesale.oggi-teamz.workers.dev`),
so it doesn't have v2's deployment blocker — but it does mean any PWA
change touches the live, in-production 232KB file, which is why this
was raised as an explicit question before touching anything. Nothing in
v1 has been changed as of this document.

Once approved, the plan is the same shape as v2's: add a
`manifest.json`, an `sw.js`, an icon set, and the handful of `<head>`
lines linking them — as a small, additive diff against a verified
backup, handed back for review rather than deployed automatically
(there's no Cloudflare login available here for v1's account anyway,
so the actual "New deployment" click stays yours either way, same as
it's always been).

Once that's live, the Bubblewrap commands are identical to v2's, just
pointed at `https://oggi-wholesale.oggi-teamz.workers.dev/manifest.json`.

## About the signing key

Bubblewrap generates a Java keystore (`.keystore` file) the first time
you run `init`, protected by a password you set during the prompts.
**This is the single most important file in the whole TWA process to
not lose**: every future update to the Android app must be signed with
the *same* key, or the Play Store (and any device that already has the
app installed) will reject it as a different, untrusted app — there is
no recovery path if it's lost, only publishing under a brand-new
package name and losing every existing install.

Recommended: back the `.keystore` file and its password up somewhere
durable and separate from this project folder (a password manager that
supports file attachments, or at minimum a second physical location) as
soon as it's generated, before doing anything else with it.

## "Access credentials" — where that actually stands

- **v1**: the last logins on record (owner/owner, square/square,
  milano/milano, buyer/buyer) are in the PDF delivered earlier this
  session, dated July 11, 2026 — flagged there as possibly stale.
  Wrapping v1 in a TWA doesn't change these at all; the TWA is just a
  native shell around the same website with the same login screen.
- **v2**: there are no preset demo logins — it uses a real invite-code
  bootstrap instead (see `docs/BATCH-14-DEPLOY-RECORD.md`). Nobody has
  redeemed the bootstrap invite yet, since the app has never been
  publicly reachable. Once it's deployed, the first real owner account
  gets created by redeeming that invite code and choosing a real
  username and password — happy to walk through that the moment it's
  live, or do it directly if given the go-ahead.
