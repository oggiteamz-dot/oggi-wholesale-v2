# Batch 14 — Security & Authentication — Deploy Record

**This is the last batch in BATCH-PLAN-V2.md.** Everything below replaces
Batch 0's dev-mode auth stub ("pick any role, no password") with real,
credentialed authentication, closes the RLS gaps that stub left open, and
adds the operational hardening (rate limiting, CSP, edge-function
`verify_jwt`) that every earlier batch's own code comments flagged as
"deferred to Batch 14."

## Read this first: how to actually log in as owner now

Real auth means there is no more "pick a role" screen for owner/wholesaler.
The **only** way to create the first owner account is to redeem this
bootstrap invite code from the new login screen's "I have an invite code"
tab:

```
[REDACTED - see local docs/BATCH-14-DEPLOY-RECORD.md - this code should be rotated before real use]
```

It expires **2027-08-11** and is currently unused. Steps: open the app →
Admin tab → "I have an invite code" → paste it in → you'll be asked to
sign up with a real email + password first if you don't already have a
Supabase Auth account, then the code links that account to the owner role.
Once you're signed in as owner, use the new **Invites** screen
(`/owner/invites`) to mint wholesaler invites for real wholesalers — you
never need to touch SQL again after this one bootstrap step.

Buyer and sales accounts are created by an owner or wholesaler from the
new **Team & Buyers** screen (`/wholesaler/team`), or by a buyer
self-registering via the "Request buyer access" flow and being approved
from the **Onboarding Queue** (`/owner/onboarding`).

## Architecture: two tiers, mirroring v1's already-proven pattern

v1's auth was read (never modified) as the reference design, because it's
already production-tested:

- **Owner / Wholesaler** → real Supabase Auth (email + password, a real
  JWT session). The only way to get one of these roles is redeeming a
  single-use invite code (`v2_invites` + `v2_create_invite`/
  `v2_redeem_invite`) — never self-assigned by signing up alone.
- **Buyer / Sales** → a new unified `v2_portal_accounts` table (mirrors
  v1's separate `clients`/`reps` tables, merged into one with a `role`
  column since the login/throttle logic is identical either way).
  Username + bcrypt password, checked server-side by throttled
  `v2_buyer_login`/`v2_sales_login` RPCs — same 10-fails/15-minute-window/
  15-minute-lock constants as v1's `login_throttle`, same "locked" and
  "wrong password" look identical to the caller" property.

`js/lib/dev-auth.js` was rewritten in place (same file path, same
`devAuth` export, same synchronous `getSession()` contract every existing
call site across ~15 files already depended on) — this was Batch 0's own
forward-looking design, and it worked exactly as planned. The one new
async step (resolving whichever session currently exists) happens once in
`devAuth.bootstrap()`, awaited in `app.js` before the first render.

## New UI screens

Four screens either didn't exist yet or were placeholders explicitly
deferred to "real auth, scoped to Batch 14":

- **`/owner/invites`** — new. Create owner/wholesaler invites, see every
  invite's status (Pending / Used / Expired).
- **`/owner/onboarding`** — rewired. Approving a buyer signup request now
  actually provisions a real `v2_clients` CRM row + a working
  `v2_portal_accounts` login (previously just flipped a status flag). The
  generated password is shown exactly once in the approval UI — there is
  no transactional email in this build, so the approver relays it to the
  buyer out-of-band (same honest, documented gap as Batch 12's
  invite/OAuth flows).
- **`/wholesaler/clients`** — new. Was a placeholder since Batch 4 whose
  own text said "needs a v2 clients table + real auth, scoped to Batch
  14" — that auth now exists, so this replaces the placeholder with a
  real screen built on `js/data/clients.js`'s already-working
  `getClientsByRecency`/`addClient`/`deactivateClient` functions (those
  functions existed since Batch 4; only the UI screen was missing).
- **`/wholesaler/team`** — new. Create buyer/sales logins for a
  wholesaler's own storefront, optionally linked to an existing client
  CRM row, and toggle any existing account active/disabled.

## RLS hardening — what's closed, what's deliberately still open

Migration `023_v2_rls_hardening.sql` replaced the `for all using (true)`
placeholder policies (Batch 0's "wide open, no auth yet" starting point)
across roughly 20 tables. Every WRITE path on wholesaler-owned data is now
`v2_is_owner() OR wid = v2_my_wid()` (direct or joined) — verified live via
`set local role = 'authenticated'` + `set local request.jwt.claim.sub`
session simulation across `v2_clients`, `v2_orders`, `v2_portal_accounts`,
`v2_invites`, confirming both that a wholesaler sees their own data and
that they do **not** see another wholesaler's.

Buyer-facing catalog/inventory/pricing **SELECT** reads were deliberately
left anon-open. Rearchitecting 12+ batches of already-shipped buyer-facing
anon-key reads onto session-scoped RPCs is real, valuable future work, but
it's out of safe scope for one unreviewed autonomous pass — flagging this
explicitly rather than silently leaving it undocumented.

The one buyer-facing area that WAS fully closed: **order data**
(`v2_orders`/`v2_order_items`), since it's real money/PII that was
previously readable by any anon caller who knew or could guess a
`wid + buyer_label` string. Buyer order reads now go exclusively through
`v2_get_buyer_orders(p_account_id)`, which independently validates a real,
active `v2_portal_accounts` id rather than trusting the caller's claim.

`v2_submit_order` gained an optional `p_account_id` — when a real buyer
session is present, the account's own `wid`/`client_id`/`actor_label`
override anything the caller separately claims, closing the "submit an
order pretending to be any buyer_label" identity-spoofing gap. Backward
compatible: the parameter defaults to null and old call shapes still work.

## Rate limiting

A reusable DB-backed sliding-window limiter (`v2_rate_limit_hits` +
`v2_rate_limit_check(key, max, window_seconds)`), applied to
`v2_redeem_invite` (20 attempts / 15 min, keyed per signed-in user — can't
brute-force a 24-byte invite code) and `v2_submit_signup_request` (30 / hour,
keyed per wholesaler wid — bounds how many pending requests one wholesaler
can be flooded with). This is RPC-level rate limiting; there is no
HTTP/edge-level rate limiting in this build (documented gap, see below).

## CSP — now a real HTTP header, not just a meta tag

v2 has never been deployed live, so there was no existing hosting config
to attach a header to. Three pieces ship together, covering whichever
hosting decision gets made later:

1. **`index.html`**'s new `<meta http-equiv="Content-Security-Policy">` —
   active immediately, in any environment, zero deploy step. This is
   defense-in-depth only: a `<meta>` CSP cannot set `frame-ancestors`
   (browsers ignore that directive there) and doesn't apply to non-HTML
   responses.
2. **`_headers`** (project root) — the real, authoritative policy as an
   actual HTTP header, in the format Cloudflare Pages and Netlify read
   natively with zero extra code, if v2 ends up on either.
3. **`cloudflare-worker/csp-worker.js`** + **`wrangler.toml`** — a
   header-injecting proxy Worker for any other host. Needs `ORIGIN` and
   the route domain filled in once a real hosting decision exists.

Policy: `script-src 'self'` (strict — no inline `<script>` tags or CDN
scripts anywhere in this build, verified by reading `index.html`, so this
needed zero rewrites). `style-src 'self' 'unsafe-inline'` — this codebase
uses inline `style="..."` attributes extensively across every dynamically-
rendered view; rewriting hundreds of call sites to CSS classes to drop
`'unsafe-inline'` here is real, valuable future work but out of scope for
this pass (documented trade-off, not an oversight — inline styles can't
execute arbitrary JS or exfiltrate data the way an unrestricted
`script-src` could, so this is a much smaller concession).
`img-src 'self' https: data:` — open to any HTTPS host, because
wholesalers set arbitrary product photo URLs (Batch 13's `image_url`
column) that can point anywhere. `connect-src` is scoped to this
Supabase project's own host only. `frame-ancestors 'none'`,
`object-src 'none'`, plus `X-Content-Type-Options`, `Referrer-Policy`, and
a locked-down `Permissions-Policy` on the two real-header paths.

Verified live via Playwright: zero CSP violations, app still renders
correctly with the meta tag active.

## Edge functions — `verify_jwt`

Checked all six of v2's own edge functions (the two unrelated ones, v1's
`manage-wholesaler-login` and the unrelated `minds-bank`, were left
untouched per the standing instruction never to touch anything outside
v2). Only **`extract-catalog-from-image`** was flipped to `verify_jwt:
true` — it's called exclusively via `supabase.functions.invoke()` from
the wholesaler-only Import Catalog screen, which automatically attaches
the signed-in user's real access token, so this needed zero frontend
change. Before this flip, anyone with the public anon key could call it
and burn the wholesaler's own Anthropic API credits with no rate limit;
that's now closed.

The other five were checked and deliberately left `verify_jwt: false`,
each for a real, function-specific reason (not an oversight):

- **`integration-dispatch`** — called by `v2_dispatch_integration_event`
  via Postgres's `pg_net` extension with no bearer token at all (`pg_net`
  can't attach one without hardcoding a service-role key into a migration
  file, which would be worse). Flipping this would 401 every real
  integration dispatch and break the feature entirely.
- **`oauth-connect`**'s callback leg is hit directly by Intuit/Xero's own
  redirect after a wholesaler approves OAuth access — there is no
  Supabase session at that point by definition, it's a third-party
  redirect. Its authorize-url leg is also called via a raw `fetch()` with
  no bearer token today.
- **`shopify-order-webhook`**, **`woocommerce-order-webhook`**,
  **`whatsapp-webhook`** — inbound webhooks from third-party platforms
  that cannot send a Supabase JWT. Each already does its own
  platform-appropriate verification (Shopify: HMAC-SHA256 signature
  check against a per-wholesaler secret, when one has been saved;
  WhatsApp: Meta's `hub.verify_token` handshake).

## A real bug found and fixed during the final security sweep

`get_advisors` flagged `v2_create_invite`, `v2_redeem_invite`,
`v2_create_portal_account`, and `v2_approve_signup_request` as executable
by the `anon` role, despite each migration explicitly writing
`grant execute ... to authenticated` only. Root cause, confirmed live via
`pg_proc.proacl`: `revoke all on function X from public` does **not**
revoke Supabase's default privilege grant, which targets the `anon` role
directly, not the `PUBLIC` pseudo-role — `revoke ... from public` is a
no-op against it. Migration 018 (Batch 12) already had the correct
pattern (`revoke ... from public` **and** `from anon, authenticated`
explicitly) for `v2_get_integration_secret`; migrations 022/024 simply
didn't follow it consistently.

Fixed via `025_v2_fix_batch14_grant_hygiene.sql`, and the 022/024 source
files were corrected to match so a fresh `supabase db reset` gets it right
without needing the follow-up migration. Verified live before and after:
`set local role = 'anon'` calling `v2_create_invite` now returns a hard
`permission denied for function` at the database layer (before the fix it
reached the function body). Re-verified the same calls still succeed for
a real authenticated owner after the fix — no regression.

**Exploitability, assessed honestly:** this was not an active
vulnerability. All four functions have their own internal
`v2_is_owner()`/`v2_my_wid()`/`auth.uid() is null` checks that already
correctly reject a truly anonymous caller — verified live, not assumed.
This is a real defense-in-depth / least-privilege fix (the database's own
grant system should enforce this too, not solely the function body), not
a fix for a data leak.

## Two real UI bugs found and fixed during structural testing

1. **Invites screen's Create button was dead until a network call
   resolved.** The click listener was attached only *after* `await`ing the
   wholesalers-dropdown fetch — under any slow or failed network, the
   button rendered and looked clickable but silently did nothing. Fixed
   by attaching all listeners synchronously right after the form is in
   the DOM, populating the dropdown asynchronously afterward (same
   pattern the Team & Buyers screen already used correctly).
2. **Invites screen's "here's your code" success message vanished almost
   instantly after being created.** The create handler did a full
   `outlet.innerHTML = ""` re-render immediately after showing the
   one-time code, wiping out the box that was just written. Fixed by
   only refreshing the invites list below, leaving the success box
   (and the form) untouched.

Both were caught by an actual Playwright interaction test (click the
button, read back the result), not just a "does it render" check — a
render-only check would have passed on both bugs.

## Testing performed

- `node --check` on every changed/new JS file.
- Live SQL-level backend verification (execute_sql) for every new RPC and
  RLS policy this batch touches: invite create/redeem, buyer/sales login
  success and failure, throttle lockout at exactly 10 fails, locked-
  account-rejects-even-correct-password, signup-request approval
  provisioning a real working login end-to-end (approve → login with the
  generated credentials → succeeds), portal-account creation
  authorization (correct wid accepted, wrong wid rejected), RLS boundary
  checks with `set local role = 'authenticated'` explicitly set (a real
  gap found and corrected mid-batch — `execute_sql` runs as the `postgres`
  superuser by default, which bypasses RLS entirely regardless of
  `request.jwt.claim.sub`, so earlier-looking-plausible checks that didn't
  set role explicitly would not have caught an RLS bug; every RLS check
  in this record was re-verified with role explicitly set).
- A dedicated Playwright structural + interaction pass
  (`/tmp/pw_batch14_check.mjs`) covering all four new/changed buyer routes
  via the still-valid localStorage session mechanism, plus the four new
  owner/wholesaler screens via direct module import + a monkey-patched
  `devAuth.getSession()` (real Supabase Auth cannot be obtained inside
  this sandbox's network-blocked Chromium — documented limitation since
  Batch 2 — so this is a structural/interaction check, not proof the real
  HTTP auth flow works; that was instead verified via SQL-level session
  simulation above).
- Batch 13's full regression suite re-run clean (no cross-batch breakage).
- `get_advisors` (security) run twice — once to find the grant bug, once
  after the fix to confirm exactly the 4 expected findings disappeared
  and nothing else changed. Zero ERROR-level findings either time. The
  two remaining non-noise WARNs (`pg_net` in the public schema,
  `auth_leaked_password_protection`) predate this batch and are already
  documented: the former is a platform-level extension placement decision
  outside this batch's scope, the latter is a Supabase Dashboard toggle
  (Auth → Policies) that cannot be set via SQL — **recommended for Hadi
  to enable by hand**.
- All Batch 14 synthetic test data (test auth.users, profiles, clients,
  orders, portal accounts, invites) was cleaned up after each verification
  pass; the real bootstrap invite was re-verified pristine (`used_by`
  null, correct expiry) after every cleanup.

## Known gaps for future work (honest, not hidden)

- Buyer-facing catalog/inventory/pricing reads stay anon-open by design
  decision (see RLS section above) — a real future hardening pass, not
  done here.
- `oauth-connect`'s `state` parameter (which wholesaler an OAuth callback
  is for) isn't cryptographically signed — flagged in the function's own
  Batch-12 comment as a "harden once real auth exists" item. Not fixed
  this batch: the whole QuickBooks/Xero OAuth flow is entirely dormant
  (no platform-level client ID/secret registered on this project yet), so
  actual exploitability is currently zero, and this needs its own careful
  pass rather than a rushed addition alongside everything else in this
  batch.
- No HTTP/edge-level rate limiting (e.g. Cloudflare rate limiting rules)
  — only the RPC-level DB limiter described above.
- `pg_net` extension is installed in the `public` schema (pre-existing,
  flagged by the linter, not a Batch 14 regression) — moving it is a
  platform-level change with broader blast radius than this batch's scope.
- `auth_leaked_password_protection` should be enabled by Hadi from the
  Supabase Dashboard (Authentication → Policies) — not SQL-settable.
- Style-src still needs `'unsafe-inline'` in the CSP (see CSP section).

## Files changed/added this batch

**Backend (Supabase, applied live):**
`supabase/migrations/022_v2_auth_schema.sql`,
`023_v2_rls_hardening.sql`, `024_v2_buyer_auth_bridge.sql`,
`025_v2_fix_batch14_grant_hygiene.sql`. Edge function
`extract-catalog-from-image` redeployed with `verify_jwt: true`.

**Frontend:**
`js/lib/dev-auth.js` (full rewrite), `js/views/login.js` (full rewrite),
`js/app.js` (async bootstrap), `js/data/orders.js` (full rewrite),
`js/data/cart.js` (submit signature), `js/views/buyer.js` (session
accountId/clientId wiring across dashboard/cart/orders/suppliers),
`js/views/owner.js` (new Invites screen, Onboarding Queue rewired),
`js/views/wholesaler.js` (new Clients + Team & Buyers screens),
`js/data/owner.js` (approveSignupRequest/rejectSignupRequest/listInvites),
`js/data/team.js` (new), `js/lib/nav-config.js` (two new nav entries).

**Infrastructure (new):**
`index.html` (CSP meta tag), `_headers`,
`cloudflare-worker/csp-worker.js`, `cloudflare-worker/wrangler.toml`.

## Bootstrap invite code, one more time since it matters most

```
[REDACTED - see local docs/BATCH-14-DEPLOY-RECORD.md - this code should be rotated before real use]
```

Role: owner. Expires: 2027-08-11. Status as of this record: unused.
