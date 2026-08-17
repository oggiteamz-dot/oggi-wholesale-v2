# Two-Part Research Report

**Method note (honest):** this was real web research — 65 URLs opened, listed in full at the end. Primary standards documents (W3C, MITRE CWE, NIST, OWASP, CISA) were read directly rather than via secondary summaries. Five URLs returned no usable content (Apple HIG tab-bars, two Material 3 pages, LukeW, Speedtest) and are flagged as such; where that happened I substituted an equivalent primary or near-primary source. Nothing below is written from memory.

---

# PART A — Separating Admin from Customer Entry Points

## A1. Is the owner's instinct correct?

**Split verdict: the conclusion is defensible, the stated reason is wrong — and the wrong reason will lead to the wrong build.**

### Where the standards genuinely back him

The instinct to separate admin from user surfaces is a real, long-standing control, not folklore:

- **CWE-419 (Unprotected Primary Channel)** — "The product uses a primary channel for administration or restricted functionality, but it does not properly protect the channel." Its two mitigations are, verbatim: *"Do not expose administrative functionnality on the user UI"* and *"Protect the administrative/restricted functionality with a strong authentication mechanism."* ([cwe.mitre.org/data/definitions/419.html](https://cwe.mitre.org/data/definitions/419.html))
- **NIST SP 800-53r5 SC-2** — "Separate user functionality, including user interface services, from system management functionality." The discussion explicitly lists *"administrative interfaces on different domains with additional access controls"* as an acceptable mechanism. Enhancement **SC-2(1)**: *"Prevent the presentation of system management functionality at interfaces to non-privileged users."* ([csf.tools SC-2](https://csf.tools/reference/nist-sp-800-53/r5/sc/sc-2/)) The same control appears as **NIST SP 800-171 3.13.3**.
- **OWASP Developer Guide (V3)** — *"All systems should code separate applications for administrator and user access"*, and *"Administrators must be segregated from normal users."* ([owasp-devguide-v3](https://owasp.gitbooks.io/owasp-devguide-v3/content/04-OperationalSecurity/Administrative-Interfaces.html))
- **OWASP ASVS 4.0, requirement 4.3.1** (L1/L2/L3, mapped to CWE-419) — *"Verify administrative interfaces use appropriate multi-factor authentication to prevent unauthorized use."* ([ASVS 4.0 V4](https://raw.githubusercontent.com/OWASP/ASVS/master/4.0/en/0x12-V4-Access-Control.md))
- **CISA BOD 23-02** is the strongest institutional statement — US federal agencies must, within 14 days of discovery, either remove a management interface from the internet or put it behind *"a policy enforcement point separate from the interface itself (preferred action)."* ([cisa.gov BOD 23-02](https://www.cisa.gov/news-events/directives/binding-operational-directive-23-02))

So: **separating admin is real, codified, and in one jurisdiction legally mandatory.**

### Where his reasoning is wrong

"A shared link invites hacking" treats the **URL as a control**. It is not. Nobody attacks a link; they attack an endpoint.

- **OWASP WSTG-CONF-05** exists precisely because admin interfaces are trivially enumerated: path guessing (`/admin`, `/administrator`), Google dorks that *"expose these paths within seconds"*, alternate ports, and — most relevant to an SPA — *"Links to administrator functionality may be discovered"* by examining client-side code sent to all users. ([OWASP WSTG-CONF-05](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/05-Enumerate_Infrastructure_and_Application_Admin_Interfaces))
- **PortSwigger's Web Security Academy** puts it flatly: *"hiding sensitive functionality does not provide effective access control because users might discover the obfuscated URL in a number of ways"* and *"The script containing the URL is visible to all users regardless of their role."* Their prevention line: *"Never rely on obfuscation alone for access control."* ([portswigger.net/web-security/access-control](https://portswigger.net/web-security/access-control))
- **CWE-656 (Reliance on Security Through Obscurity)** — *"The security mechanism can be bypassed easily."* Design assumption should be *"that reverse engineering is feasible."* ([CWE-656](https://cwe.mitre.org/data/definitions/656.html))

**The honest one-line answer to give him:** separation is worth doing, but not for the reason he thinks. It does not hide anything. Its value is that it **creates a place to hang controls you cannot otherwise apply** — a policy enforcement point, an IP allowlist, mandatory MFA, a short-lived separate session, a stricter CSP — and it **shrinks the blast radius** when something else goes wrong. If you split the URLs and change nothing else, you have built a decoy, and decoys create false confidence, which is worse than the honest single URL.

### What is straightforwardly security theatre

| Practice | Verdict |
|---|---|
| Moving admin to `/xk3n-admin-9f2` (unguessable path) | Theatre. CWE-656. Leaks via JS bundle, Referer, logs, bookmarks. |
| Moving admin to `admin.example.com` **with no other change** | Theatre-plus. Cosmetic unless a PEP or different session lives there. |
| Hiding the admin nav link from buyers | Theatre as *security*; legitimate as *UX*. |
| Client-side `if (role === 'owner')` route guards | Theatre — **CWE-602**: *"an attacker can modify the client-side behavior to bypass the protection mechanisms."* ([CWE-602](https://cwe.mitre.org/data/definitions/602.html)) |

---

## A2. The real mechanisms, ranked by effectiveness

Ranked by *marginal risk reduction per unit of effort*, for a small team.

### Tier 1 — Does most of the work

**1. Server-side authorization enforced on every request (including RLS)**

This is the whole ballgame. ASVS 4.1.1: *"Verify that the application enforces access control rules on a trusted service layer."* ASVS 5.0 §8.3.1 is blunter: *"The application enforces authorization rules at a trusted service layer and doesn't rely on controls that an untrusted consumer could manipulate, such as client-side JavaScript."* ([ASVS 5.0 V8](https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x17-V8-Authorization.md)) The OWASP Authorization Cheat Sheet: *"Access control checks must be performed server-side, at the gateway, or using serverless function"* and *"deny-by-default."* ([Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html))

Scale of the problem: **Broken Access Control is #1 in both OWASP Top 10:2021 and Top 10:2025.** 2021: 318,487 occurrences, 19,013 CVEs. 2025: **1,839,701 total occurrences, 32,654 total CVEs, 40 CWEs mapped, avg weighted exploit 7.04.** ([A01:2021](https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/index.html), [A01:2025](https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/))

For multi-tenant specifically, ASVS 5.0 §8.4.1: *"Multi-tenant applications use cross-tenant controls to ensure consumer operations will never affect tenants with which they do not have permissions to interact."*

**2. Mandatory MFA for admin/staff, with step-up re-auth on dangerous actions**

Microsoft Research (May 2023) measured *"MFA reduces the risk of compromise by 99.22% across the entire population"*, with over 99.99% of MFA-enabled accounts remaining secure. ([Microsoft Research](https://www.microsoft.com/en-us/research/publication/how-effective-is-multifactor-authentication-at-deterring-cyberattacks/))

The counterfactual is documented: Mandiant's **UNC5537 / Snowflake** campaign succeeded on exactly three conditions — no MFA, credentials never rotated (some stolen as far back as 2020 still valid), and no network allow lists. ~**165 organisations** notified as of 10 June 2024. ([Google Cloud / Mandiant](https://cloud.google.com/blog/topics/threat-intelligence/unc5537-snowflake-data-theft-extortion))

OWASP DevGuide adds the step-up rule: *"Use strong authentication to log on, and re-authenticate major or dangerous transactions."*

### Tier 2 — High value, moderate effort

**3. A policy enforcement point (PEP) in front of admin — IP allowlist or zero-trust proxy**

CISA's *preferred* remedy is a PEP *"separate from the interface itself"*. NIST SP 800-207's tenets are the design rationale: *"All communication is secured regardless of network location. Network location alone does not imply trust"*, and *"All resource authentication and authorization are dynamic and strictly enforced before access is allowed."* ([NIST SP 800-207 PDF](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf))

Practically, for a small team this is Cloudflare Access (or equivalent) in front of the admin host — which supports allow-by-email-domain, require-MFA, allow/block by country and IP, and can be scoped to a specific path, not just a hostname. ([Cloudflare One common policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/))

⚠️ Caveat: a **client-supplied IP allowlist is only meaningful when enforced at the edge/server**. Lebanon's residential and mobile IPs are largely dynamic, so an owner-only allowlist is realistic; a wholesaler-wide one is not.

**4. Separate session/identity boundary for admin**

More valuable than the URL split, and often confused with it. Distinct cookie, distinct lifetime, no cross-scope reuse. OWASP Session Management Cheat Sheet warns the `Domain` attribute is the trap: setting it to *"a too permissive value, such as `example.com` allows an attacker to launch attacks on the session IDs between different hosts... For example, vulnerabilities in `www.example.com` might allow an attacker to get access to the session IDs from `secure.example.com`."* The recommended fix is the `__Host-` prefix: *"must be set with `Secure`, must not have a `Domain` attribute, and must use `Path=/`. Prevents subdomain forgery and HTTPS downgrade attacks."* ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html))

**Note the tension:** `__Host-` cookies *cannot* be shared across subdomains. That is a feature for isolation and a cost for SSO. You get one or the other.

### Tier 3 — Real but modest

**5. Separate origin/host for admin (`admin.example.com`)**

Buys genuine things — origin isolation, independent CSP, cookie isolation, independent PEP attachment, smaller XSS blast radius. GitHub Enterprise recommends subdomain isolation on exactly this basis: *"Subdomain isolation mitigates cross-site scripting and other related vulnerabilities"* by separating user-supplied content onto isolated subdomains. ([GitHub Enterprise docs](https://docs.github.com/en/enterprise-server@3.13/admin/configuring-settings/hardening-security-for-your-enterprise/enabling-subdomain-isolation))

But it buys **zero authorization**. If the same Supabase project, same RLS policies and same RPCs serve both hosts, the admin API is equally reachable from the buyer host with `curl`.

**6. Not shipping admin JS to non-admins (bundle separation / code-splitting)**

**More useful than the URL split and less useful than people hope.** What it actually buys: it removes the free map. GuidePoint Security's field write-up documents the exact failure mode — searching a JS bundle for "Administration" yielded *"nine matches in the JavaScript code"*, exposing an `/administration` endpoint; in another case a low-privileged user found `/api/admin/users` in JS and *"successfully retriev[ed] all user passwords in cleartext despite lacking administrative authorization."* ([GuidePoint Security](https://www.guidepointsecurity.com/blog/the-secret-life-of-apis-uncovering-hidden-endpoints-and-more/))

Read that second case carefully: **the JS disclosure was the recon; the missing server-side check was the vulnerability.** Splitting the bundle would have delayed discovery by an afternoon and prevented nothing. It is attack-surface hygiene (OWASP Attack Surface Analysis Cheat Sheet: *"turning off features and interfaces that aren't being used"*), not a control. ([Attack Surface Analysis Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Attack_Surface_Analysis_Cheat_Sheet.html))

**7. Separate identity provider / separate tenant for admins**

Strong isolation, real operational weight. Justified once you have staff admins who are not the owner. Below that headcount it is over-engineering.

**8. Path-based split (`/admin/*` in the same app)**

Lowest value of the genuine mechanisms — *unless* a PEP is attached to the path (which Cloudflare Access supports). On its own it is a naming convention.

---

## A3. The critical question, answered honestly

> **In an SPA, does splitting the URL improve security if the same JS bundle and same database policies serve everyone?**

**No. Essentially zero.** And it is worth being precise about *why*, because the precision is what changes the build plan.

### The mental model that's wrong

The instinct treats the app as the security boundary — as if the browser were a locked building and the URL a door. In a modern SPA on a hosted backend, **the browser is not a boundary at all.** The buyer's phone and the owner's laptop both hold ordinary JavaScript talking to the *same* public API with the *same* public key. The only thing that distinguishes them is a token the server validates.

Supabase says this in its own docs, and it is not a caveat — it is the architecture: *"Your publishable key is safe to expose with RLS enabled, because row access permission is checked against your access policies and the user's JSON Web Token (JWT)."* And: *"Never expose your service role or secret keys on the frontend... they bypass RLS."* ([Supabase — Securing your data](https://supabase.com/docs/guides/database/secure-data))

Restated for the owner in plain terms: **the database, not the website, is the lock.** Three websites in front of one unlocked database are three doors into the same unlocked room.

### Hiding an interface vs. enforcing authorization

| | Hiding an interface | Enforcing authorization |
|---|---|---|
| **Where it runs** | The user's browser | The server / database |
| **Who controls it** | The attacker | You |
| **Bypass cost** | DevTools, 30 seconds | Requires a real vulnerability |
| **Failure mode** | Silent — looks fine until someone tries | Loud — request is refused and logged |
| **CWE** | CWE-656, CWE-602 | The control that prevents CWE-419 |

The relevant OWASP line for a role-per-tenant app: *"A user should not be able to access a resource they do not have permissions simply because they are able to guess and manipulate that object's identifier."*

### The precedent that matches this exact stack

**CVE-2025-48757** — *"An insufficient database Row-Level Security policy in Lovable through 2025-04-15 allows remote unauthenticated attackers to read or write to arbitrary database tables of generated sites."* CVSS 3.1 **9.3 Critical**, published 29 May 2025; **170+ apps** affected per the disclosure write-ups. ([NVD CVE-2025-48757](https://nvd.nist.gov/vuln/detail/CVE-2025-48757))

Every one of those apps had a nice-looking front end. Several had admin sections. None of that mattered. The vulnerability was one layer down, in exactly the place the URL split does not reach.

### ⚠️ Specific flag for this codebase

Your own project notes record an open item that is *materially more dangerous* than the shared login URL, and which three separate URLs would not touch: `DATA_KEYS` still includes `'users'`, so **plaintext rep passwords sync into a shared document readable by every authenticated tenant**, plus a single `id:'main'` row and an admin password never rotated since it sat in a plaintext PRD. That is a cross-tenant authorization and secrets-handling defect — Tier 1. Splitting the entry points while that stands is redecorating the lobby of a building with no locks on the flats. **Fix order should follow risk, not intuition.**

---

## A4. Practical downsides and costs of splitting into three apps

These are real and, for a two-person team, they compound.

**1. Code duplication — and your codebase is already showing the failure mode**

Your Aug-15 modularity assessment found the HTML-escape helper existing in **10 copies under 4 names** (`esc`, `escapeHtml`, `escapeHtmlLocal`, `escapeHtmlSp`) and `pageHeader` in **7 copies that have already drifted** — 4 render a `page-actions` slot, 3 do not. Splitting into three deployable apps multiplies drift surface by three, unless a shared library is extracted **first**. Brad Frost's interface inventory exists to surface exactly this class of divergence. ([bradfrost.com](https://bradfrost.com/blog/post/conducting-an-interface-inventory/))

**2. Session handling across hosts**

Either you share a cookie via `Domain=.example.com` — which OWASP warns re-opens cross-subdomain session theft and forfeits the `__Host-` prefix — or you accept separate logins per host. **You cannot have strict cookie isolation and seamless cross-host SSO from a cookie.** Token-based auth in `localStorage` is per-origin too, so three origins means three token stores.

**3. PWA / service worker scoping — the largest concrete cost here, because v2 is already a PWA**

From web.dev's multi-origin PWA guidance:
- *"a page at `https://www.example.com` can't call `register()` with a service worker url at `https://section.example.com`"*
- *"a service worker can only control pages hosted under the origin and path it belongs to"*
- *"The Cache object, indexedDB, and localStorage are also constrained to a single origin"*
- *"each origin must have its own manifest with a `start_url` that's relative to itself"*
- *"users receiving the installation prompt in a subdomain will only be able to install PWAs for the subpages, not for the main URL"*

And the closing recommendation: *"consider migrating to a single origin, unless there's an important reason to keep the multi-origin architecture."* ([web.dev multi-origin PWAs](https://web.dev/articles/multi-origin-pwas))

**The genuine nuance:** web.dev's companion article reaches the *opposite* conclusion when the things really are separate apps — separate origins "Recommended"; non-overlapping paths "Not recommended"; nested paths "Strongly not recommended", because *"all URLs in the inner app will actually be considered part of both the outer app and the inner app."* ([web.dev multiple PWAs on one domain](https://web.dev/articles/building-multiple-pwas-on-the-same-domain))

**Synthesis:** if buyer and wholesaler are genuinely two products with two install experiences, separate origins are correct. If they are one product with two roles, a single origin is correct and the split will actively degrade the PWA. **The owner-admin console is the clean case — it should never have been a PWA anyway.**

**4. Deploy complexity**

Three Cloudflare Workers, three `.assetsignore` files, three cache-name bumps, three chances for the disk/repo drift your notes already record happening twice in one day. Your own history says the deploy pipeline is the most fragile part of the system.

**5. CORS / CSP**

Three origins calling one API means CORS config becomes load-bearing. OWASP A01 lists *"CORS misconfiguration allows API access from unauthorized/untrusted origins"* as a top access-control failure. Today you have zero CORS risk because you have one origin.

---

## A5. Documented breaches and CVEs from admin surfaces exposed alongside user surfaces

**1. CVE-2023-22515 — Atlassian Confluence, "Broken Access Control", exploited as a zero-day**

The cleanest match to the question. Per CISA/FBI/MS-ISAC advisory AA23-289A: *"threat actors can change the Confluence server's configuration to indicate the setup is not complete and use the `/setup/setupadministrator.action` endpoint to create a new administrator user"*, triggered *"via a request on the unauthenticated `/server-info.action` endpoint."* Administrative *setup* functionality was reachable on the same web surface as ordinary users. Atlassian rated it critical; nation-state exploitation was observed. ([CISA AA23-289A](https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-289a))

**2. CVE-2022-40684 — Fortinet FortiOS/FortiProxy auth bypass**

Allowed attackers to *"bypass authentication and gain access to the administrative interface"* via a crafted HTTP/S request. Exploited in the wild; added to CISA KEV. Rapid7's recommendation is the general lesson: *"all high-value edge devices limit public access to any administrative interface."* ([Rapid7](https://www.rapid7.com/blog/post/2022/10/07/cve-2022-40684-remote-authentication-bypass-vulnerability-in-fortinet-firewalls-web-proxies/))

**3. Snowflake / UNC5537 (2024) — ~165 organisations**

Not an "admin panel" bug but the most instructive: the surface was fine, the *controls on it* were not. No MFA, unrotated credentials, no network allow lists. ([Mandiant](https://cloud.google.com/blog/topics/threat-intelligence/unc5537-snowflake-data-theft-extortion))

**4. CVE-2025-48757 — Lovable / Supabase RLS, 170+ apps, CVSS 9.3**

Same stack class as yours. Insufficient RLS → unauthenticated read/write to arbitrary tables. ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-48757))

**5. The systemic evidence: CISA BOD 23-02 itself**

A binding directive is not issued over a hypothetical. Its rationale: *"Threat actors have used certain classes of network devices to gain unrestricted access to organizational networks leading to full scale compromises"*, because *"Most device management interfaces... are not meant to be accessible directly from the public internet."*

**⚠️ Deliberately excluded:** several 2026-dated cPanel/Metabase items surfaced in search. I did not open their primary advisories and will not cite them as fact.

**⚠️ Honest limitation:** I found no public post-mortem of a *pure SPA* breached specifically because owner/wholesaler/buyer shared one login URL. The failure mode is documented at the *layer below* (Confluence, Lovable) every time. That absence is itself the finding: **the URL is not where these things break.**

---

## A6. Recommended architecture — ordered by what to do first

### Now (this week) — nothing to do with URLs

**A1. Close the cross-tenant data leak.** Remove `'users'` from `DATA_KEYS`. Passwords must never be in a synced document. Rotate the admin password — your own notes say treat it as leaked.

**A2. Enforce authorization in the database, not the app.** Every table under per-tenant RLS keyed off the authenticated JWT. Deny by default. Verify by attempting a cross-tenant read with a real buyer token — **not** by reading the policy and agreeing with it. Precedent: `check_pack_moq.sh` reported 7 green while the function crashed on every call. *A check is not finished until it has been proven to go red.*

**A3. MFA (or at minimum a distinct strong credential + short session + re-auth on destructive actions) for owner/staff.** ASVS 4.3.1 is L1 — it applies at the lowest conformance level.

**A4. Prove it from outside the browser.** `curl` an admin RPC with a buyer token. If it returns data, the URL split would have been theatre. If it returns 403, you have a real boundary and the split becomes optional hardening.

### Next (2–4 weeks) — the split, done for the right reason

**B1. Extract `js/lib/` first.** Escaping, `pageHeader`, session, Supabase client. Splitting apps before deduplicating helpers guarantees three divergent copies. Non-negotiable ordering.

**B2. Move the owner/staff console to its own origin — `admin.<domain>` — and put a PEP in front of it.** Cloudflare Access with allow-by-email + require-MFA, optionally country restriction. This is the CISA "preferred action" pattern, adapted to a small team. It buys origin isolation, an independent CSP, cookie isolation, and a genuine choke point.

**B3. Do NOT make the admin console a PWA.** No service worker, no manifest, no offline. Keeps the multi-origin PWA problems entirely out of the picture.

**B4. Admin cookie: `__Host-` prefixed, no `Domain` attribute, short expiry, no sharing with the buyer origin.**

**B5. Code-split so admin JS never ships to buyers.** Attack-surface hygiene, not a control. Cheap once B1 is done.

### Later / conditional

**C1. Keep wholesaler and buyer on ONE origin.** They are two roles in one product, share a PWA install story, and web.dev's guidance points to a single origin for that case. Two clearly-labelled entry *routes* (`/portal`, `/shop`) with server-enforced roles gives the owner the "separate links" he wants — different links, different landing screens, different bundles, one origin — at a fraction of the cost.

**C2. Separate IdP / dedicated staff tenant** — only once staff admins exist who aren't the owner.

**C3. IP allowlist** — only if the owner works from a static IP. Otherwise it will lock him out and get switched off, and a control that gets switched off is worse than one never built.

### What to actually tell the owner

> "You're right that admins shouldn't share a front door with customers — that's in the NIST and OWASP standards, and the US government mandates it for federal systems. But the link isn't what gets attacked. Right now, three separate links would change nothing, because all three would talk to the same database with the same rules. I'll do the split — and I'll do the part that actually stops an attack first, so the split is protecting something real instead of just looking safer."

---

## A7. ⚠️ What Part A does NOT solve

- **Splitting entry points does not stop a stolen or shared password.** MFA does. Neither stops the owner writing the admin password in a WhatsApp message.
- **Separate origins do not prevent broken authorization.** A01 is #1 in 2025 with 1.84M occurrences precisely because it is an application-logic failure, not a topology failure.
- **A PEP protects the *interface*, not the *API*.** If the Supabase API stays publicly reachable (it must, for the buyer app), Cloudflare Access in front of `admin.<domain>` protects the HTML and JS, not the data. **The database rules are still doing all the real work.** Anyone who forgets this will build a very secure-feeling front door onto an open API.
- **None of this addresses XSS.** Your notes record 142 `innerHTML` writes and 7 unescaped `pageHeader` copies, currently backstopped by a CSP with `script-src 'self'`. That backstop is one careless `unsafe-inline` away from gone.
- **None of it addresses backup, key rotation, or logging.** Mandiant's Snowflake finding was that credentials stolen in 2020 still worked in 2024.
- **This research cannot tell you whether your RLS is actually correct.** That requires reading your live policies and attempting real cross-tenant access. Everything in A6 step A2 is a *procedure*, not a verdict.

---
---

# PART B — Mobile-First Retrofit

## B1. Retrofitting a desktop-first app without a rewrite

### First, a correction to a common assumption

The obvious plan — "flip every `max-width` to `min-width`" — is **not** the consensus best practice for an existing codebase, and two serious sources argue against it.

Ahmad Shadeed's survey (648 votes) found mobile-first 33.3%, desktop-first 21.9%, **mix of both 24.7%** — i.e. no dominant orthodoxy. His technical argument is that desktop-first often produces *fewer* overrides, because *"by using a `max-width` media query, we are **scoping** a specific design to a specific viewport width."* His actual recommendation is neither: *"write the base styles first and then we start thinking about what will happen for mobile and desktop"* — especially valuable for *"components that look **completely different** on mobile versus desktop size."* ([ishadeed.com](https://ishadeed.com/article/the-state-of-mobile-first-and-desktop-first/))

A List Apart's *Mobile-First CSS: Is It Time for a Rethink?* is harsher: *"all those exceptions create complexity and inefficiency, which in turn can lead to an increased testing effort and a code base that's harder to maintain"*, and — the line that matters most for a retrofit — *"Changes to the CSS at a lower view (like adding a new style) requires all higher breakpoints to be regression tested."* Its alternative is **closed media query ranges**: *"Only set styles when needed. Not set them with the expectation of overwriting them later on, again and again."* ([alistapart.com](https://alistapart.com/article/mobile-first-css-is-it-time-for-a-rethink/))

Shadeed also flags the specific bug a sloppy conversion produces: using the same numeric value in both `min-` and `max-` queries leaves a gap — *"99% of the time, you'll forget to test an important breakpoint: 500px"* where neither rule applies.

### The safe incremental path

**Step 0 — Inventory before touching anything.** Brad Frost's interface inventory: *"taking stock and categorizing the components making up your website or app"*, with the whole team, 30–90 minutes. This produces the list you will later verify nothing fell off. Your existing `FEATURE-MANIFEST.md` is half of this already; the missing half is a **screen × role × breakpoint** grid.

**Step 1 — Ship navigation before touching layout.** With `display:none` below 880px and no drawer, a phone user currently has **no navigation at all**. That is not a responsive-design problem, it is a **total loss of function**. It is also independently fixable, independently testable, and independently shippable. Do it first, alone. (Your standing NEVER-MULTITASK rule points the same way.)

**Step 2 — Fix touch targets globally.** A stylesheet-level `min-height: 44px; min-width: 44px` on interactive elements, plus spacing. Low risk, high compliance payoff (see B3).

**Step 3 — Convert *component by component*, not file by file.** For each component: give it a base (unqualified) style that works narrow, then add `min-width` enhancement, then delete that component's `max-width` rule. One component per commit, each independently revertable. Do **not** do a global find-and-replace — that is the change class that produces the closed-range gap bug and makes regression untraceable.

**Step 4 — Use container queries for reusable pieces.** Now safe to depend on: **Baseline "Widely available" since 2025-08-14** (Chrome 105, Edge 105, Safari 16, Firefox 110). ([web-features-explorer](https://web-platform-dx.github.io/web-features-explorer/features/container-queries/)) The mechanism, per MDN: `container-type: inline-size` on the parent, then `@container (width > 700px) { … }`. *"the card can be reused in multiple areas of a page without needing to know specifically where it will be placed each time."* ([MDN Container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries))

**Why this matters specifically here:** with **one** breakpoint at 880px, the entire layout is a binary. Container queries let a product card, a stock matrix, or an order line adapt to *its own* available width — which is exactly the shape of a wholesale catalogue where the same card appears in a grid, a list, and a drawer.

**Step 5 — Split `wholesaler.js` only after the CSS is stable.** It is 68 KB / 1,258 lines holding 9 screens. Doing both at once means any regression has two possible causes.

---

## B2. Mobile navigation for an app with many sections and multiple roles

### The research on hamburger menus — actual numbers

**NN/g, 179 participants, 6 sites, phones and desktop, three navigation conditions (hidden / visible / combo):** ([nngroup.com/articles/hamburger-menus](https://www.nngroup.com/articles/hamburger-menus/))

| Measure | Finding |
|---|---|
| Navigation *use*, desktop | Hidden **27%** vs visible **48%** / combo **50%** |
| Navigation *use*, mobile | Hidden **57%** vs combo **86%** |
| Content discoverability | *"a more than 20% drop in discoverability on sites with hidden navigation"* |
| Perceived task difficulty | **+21%** vs visible; **+11%** vs combo |
| Task time, desktop | *"at least **39% slower** when the navigation was hidden"* |
| Task time, mobile | ***15% slower*** vs combo |
| Time to reach nav | +5–7s desktop, ~+2s mobile |

**NN/g's follow-up study on mobile discovery** found icon familiarity is not the issue — salience and labelling are: *"the hamburger menu is not so universal that everyone knows it or immediately looks for it."* One site with visible/combo navigation saw **89% usage**; one with hidden navigation **44%**, with users averaging **24s vs 33s** to reach navigation. A participant on the hidden-nav site *"scrolled extensively, searched multiple times, and abandoned the task without ever attempting to use the menu."* ([nngroup.com/articles/find-navigation-mobile-even-hamburger](https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/))

### The strongest single data point for bottom tabs

**Redbooth** (project management app) moved from a hamburger menu to bottom navigation: *"session time increased 70 percent, and daily active users increased by 65 percent nearly overnight."* The reverse also held — **Polar**'s *"Daily engagement decreased when Polar added a toggle menu with the 'Top' label"*, replacing an always-visible segmented control. ([Google Design / Medium](https://medium.com/google-design/the-obvious-ui-is-often-the-best-ui-7a25597d79fd))

⚠️ **Flag:** these are vendor-reported, uncontrolled before/after figures from ~2015-16 apps, published via Google Design. Directionally consistent with NN/g's controlled study; **do not treat "70%" as an expected outcome for a B2B wholesale tool.**

⚠️ **Flag:** Luke Wroblewski's *Obvious Always Wins* primary page ([lukew.com/ff/entry.asp?1945=](https://www.lukew.com/ff/entry.asp?1945=)) returned **404**. The Redbooth/Polar figures above are from the Google Design article that cites the same body of work. Original source not verified directly.

### The hard constraint the brief runs into

NN/g's pattern primer is unambiguous, and it directly limits the bottom-tab option:

> *"Tab bars and navigation bars are well suited for sites with relatively few navigation options. If your site has more than 5 options, it's hard to fit them in a tab or navigation bar."*

And on hamburgers: *"The navigation menu makes the navigation options least discoverable"*, but it *"can accommodate many options and support submenus easily"*, and suits *"content-heavy, browse-mostly sites and apps."*

NN/g also documents a third pattern that fits multi-role apps well — the **navigation hub**: a home screen listing all options, which *"works for task-based websites and apps, especially when users tend to limit themselves to using only one branch of the navigation hierarchy during a single session."* That describes a wholesaler doing an inventory session, or a buyer placing an order, almost exactly. ([nngroup.com/articles/mobile-navigation-patterns](https://www.nngroup.com/articles/mobile-navigation-patterns/))

### Thumb reachability

Steven Hoober's field study — **1,333 observations** of people using phones in public, 780 involving screen interaction: **one-handed 49%** (67% right thumb), **cradled 36%** (72% thumb-on-screen), **two-handed 15%**. So **~85% of touch interactions are thumb-driven**, favouring the bottom of the screen. ([UXmatters](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php))

⚠️ Hoober's own caution against over-applying it: users *"frequently switch holding methods"*, and he warns against assuming *"low-priority or dangerous functions"* belong in hard-to-reach areas.

### Bottom nav on the mobile *web* specifically

Relevant because this is a PWA, not a native app. Smashing Magazine's treatment notes bottom nav collides with browser chrome: *"iOS handlebars can get in the way of bottom navigation"*, requiring *"the navigation is spacious enough to accommodate the iOS safe area."* Mitigations: `env(safe-area-inset-bottom)` padding, keep nav fixed while content scrolls, don't push critical items to screen extremes. ([Smashing Magazine](https://www.smashingmagazine.com/2019/08/bottom-navigation-pattern-mobile-web-pages/))

⚠️ **Material Design 3 and Apple HIG primary pages could not be read** — `m3.material.io` and `developer.apple.com/design/human-interface-guidelines/tab-bars` are JS-rendered and returned no body text. Material's *number of destinations* and Apple's *tab count* guidance are therefore **unverified** here. Google's accessibility docs and Apple's design-tips page were readable and are cited in B3.

### Recommendation: hybrid, not either/or

The evidence does not support "bottom tabs" or "hamburger". It supports **combo navigation** — NN/g's best-performing condition on every measure.

**Concretely:**

- **Persistent bottom bar, 4 items + 1 "More"**, role-dependent:
  - *Buyer:* Catalogue · Cart · Orders · Account · More
  - *Wholesaler:* Orders · Products · Inventory · Clients · More
  - *Owner/staff:* separate console (per Part A) — **do not** try to fit three roles in one bar
- **"More" opens a full-screen hub** listing every remaining section with text labels — NN/g's hub pattern, which is precisely what an app with 9+ sections needs and what a 5-slot bar cannot hold.
- **Text labels always visible.** Icon-only bars re-create the discoverability problem the bar was meant to solve; NN/g's mobile study attributed poor discovery to low visual salience.
- **Support navigation elsewhere too** — NN/g: *"make key user tasks easy to do in the absence of navigation"*, via direct links to primary tasks on the home screen, in-line and related links, a prominent search, and *"Repeating the main site navigation in the footer."* ([nngroup.com/articles/support-mobile-navigation](https://www.nngroup.com/articles/support-mobile-navigation/))
- **Above 880px, keep the existing sidebar.** Do not delete working desktop navigation to achieve consistency. Baymard's dataset — **16,000+ scored pages across 180+ leading sites** — finds **58% of desktop** and **67% of mobile** navigation performance is *"mediocre to poor"*, and **95% of sites don't highlight the user's current scope in the main navigation**. That last one is a cheap, high-value win at both sizes. ([Baymard](https://baymard.com/blog/ecommerce-navigation-best-practice))
- **`env(safe-area-inset-bottom)` from day one**, and validate against iOS Safari's bottom toolbar.

---

## B3. Touch targets — the requirements, precisely

| Standard | Minimum | Level / status |
|---|---|---|
| **WCAG 2.2 SC 2.5.8 Target Size (Minimum)** | **24 × 24 CSS px** | **Level AA** — *"The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:"* ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)) |
| **WCAG 2.2 SC 2.5.5 Target Size (Enhanced)** | **44 × 44 CSS px** | Level AAA ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)) |
| **Apple HIG** | **44 × 44 pt** | *"Create controls that measure at least 44 points x 44 points so they can be accurately tapped with a finger."* ([developer.apple.com/design/tips](https://developer.apple.com/design/tips)) |
| **Google / Material** | **48 × 48 dp** | *"A touch target of 48 x 48 dp results in a physical size of about 9 mm... The recommended target size for touchscreen objects is 7–10 mm."* ([Android Accessibility Help](https://support.google.com/accessibility/android/answer/7101858?hl=en-GB)) |

**The five SC 2.5.8 exceptions, verbatim** (these matter — several will apply to a dense wholesale UI):

1. **Spacing** — *"Undersized targets... are positioned so that if a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect another target or the circle for another undersized target"*
2. **Equivalent** — *"The function can be achieved through a different control on the same page that meets this criterion"*
3. **Inline** — *"The target is in a sentence or its size is otherwise constrained by the line-height of non-target text"*
4. **User Agent Control** — *"The size of the target is determined by the user agent and is not modified by the author"*
5. **Essential** — *"A particular presentation of the target is essential or is legally required"*

Intent: users with *"hand tremors, spasticity, and quadriplegia"* — but the beneficiaries in practice are far wider (moving vehicles, one hand full, gloves, a phone held over a stock crate in a warehouse).

**Practical rule for this app:** build to **44 px minimum, 48 px for anything a wholesaler taps repeatedly** (quantity steppers, size-matrix cells, colour chips), with **≥8 px gaps**. The spacing exception is the escape hatch for a genuinely dense stock matrix — but the exception requires *measurable* 24 px non-overlapping circles, so it must be tested, not asserted.

**⚠️ Specific risk in this codebase:** the colour chips, per-variant stock matrix, and barcode toggles are exactly the pattern that fails 2.5.8. They are the first thing to measure.

---

## B4. Mobile web reality in Lebanon and the Gulf — **the brief's premise does not survive contact with the data**

### Device share of web traffic (StatCounter, July 2026, >3bn monthly page views)

| Country | Mobile | Desktop | Tablet |
|---|---|---|---|
| **Lebanon** | **40.37%** | **58.67%** | 0.96% |
| Saudi Arabia | 65.43% | 33.61% | 0.96% |
| Iraq | 61.06% | 37.36% | 1.59% |
| UAE | 59.35% | 40.02% | 0.63% |

Sources: [Lebanon](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/lebanon) · [Saudi Arabia](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/saudi-arabia) · [Iraq](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/iraq) · [UAE](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/united-arab-emirates)

**🔴 This directly contradicts the brief's stated assumption that these users are "overwhelmingly phone-first."** Lebanon measures as **desktop-majority**. The Gulf and Iraq are mobile-majority but at ~60–65%, not "overwhelming."

**Caveats — and they cut both ways:**
- StatCounter measures **page views on sites carrying its tracker**, not app sessions and not B2B tool usage. It over-weights content/media sites.
- Desktop share can be inflated by office and internet-café usage — plausible in Lebanon.
- **B2B behaviour genuinely differs from consumer browsing.** A wholesaler checking stock on a warehouse floor is a phone; the same person reconciling a month of orders is a laptop. Both are your users.

**⚠️ Unverified:** I found no dataset measuring device split for *B2B wholesale software* in Lebanon or the Gulf. Nobody publishes it.

### Connectivity and penetration (DataReportal)

- **Lebanon** (report dated 8 Nov 2025, Oct-2025 data): population **5.86m**; internet users **5.38m / 91.8%**; cellular connections **4.76m = 81.3% of population**; social media **4.58m / 78.1%**; **median cellular download 43.90 Mbps**. ([datareportal.com/reports/digital-2026-lebanon](https://datareportal.com/reports/digital-2026-lebanon))
- **UAE** (5 Nov 2025): population **11.4m**; internet users **11.3m / 99.0%**; cellular connections **23.0m = 202% of population**; social media **12.5m / 110%**; **median cellular download 614.42 Mbps**. ([datareportal.com/reports/digital-2026-united-arab-emirates](https://datareportal.com/reports/digital-2026-united-arab-emirates))

**Note the 14× speed gap** between Lebanon and the UAE. A build tuned on Gulf connections will feel broken in Beirut. Lebanon also runs on an unstable grid, which means intermittent connectivity independent of network speed — **the PWA offline capability you already shipped is more valuable in Lebanon than the mobile layout is.**

⚠️ **Saudi Arabia figures unverified** — [datareportal.com/digital-in-saudi-arabia](https://datareportal.com/digital-in-saudi-arabia) is a landing page and the individual report was not opened. ⚠️ [speedtest.net/global-index/lebanon](https://www.speedtest.net/global-index/lebanon) returned **403** to the fetch proxy; Ookla data not independently confirmed.

### Device classes (Lebanon, StatCounter July 2026)

Apple **35.96%**, Samsung **28.72%**, Unknown **11.81%**, **Tecno 8.27%**, **Infinix 4.34%**, Xiaomi 3.42%. ([vendor share](https://gs.statcounter.com/vendor-market-share/mobile/lebanon))

**Tecno + Infinix = 12.6%** — both Transsion budget Android brands, typically 2–4 GB RAM, weak single-core performance. Combined with ~12% "Unknown" (often older or lower-end devices), roughly **a fifth to a quarter of Lebanese mobile traffic is on low-end hardware.**

**Implication that matters more than layout:** your `wholesaler.js` is 68 KB/1,258 lines in a codebase with **142 `innerHTML` writes**. On a Tecno at 43 Mbps that is a parse-and-layout cost, not just a download cost. **Code-splitting is a performance requirement here, not only the security hygiene from Part A** — one change that pays off in both parts.

### What this means for the recommendation

**It does not change the answer, it changes the justification.** "No navigation at all below 880px" is a **total loss of function for 40% of Lebanese and 60–65% of Gulf traffic** — indefensible at any share. But it does mean:

- **Do not deprecate or degrade the desktop sidebar.** In Lebanon it is serving the majority.
- **Do not rebuild as "mobile-only."** Adaptive, both sizes first-class.
- **Measure your own traffic.** You have OGGI Insight, built for exactly this. One week of real device data beats every number in this table.

---

## B5. Does retrofitting risk losing features? Yes — and here is the documented proof

### What actually causes feature loss

NN/g on radical vs incremental: *"Drastic website changes are jarring for users and risky for business"*, with incremental change recommended as the default, and the warning that *"Customers balk at change, even when the new design is clearly better."* ([nngroup.com/articles/radical-incremental-redesign](https://www.nngroup.com/articles/radical-incremental-redesign/))

### The case study — Sonos, 2024

The best-documented recent example of a mobile app redesign that shipped with working features deleted.

**Features removed:** *"sleep timers, management of locally-stored music, and the ability to edit playlists and song queues."* CEO Patrick Spence: *"I want to begin by personally apologising for disappointing you."* Restoring queue/playlist editing was scheduled *"until September or October, and that's if everything runs to schedule."* ([What Hi-Fi](https://www.whathifi.com/news/sonos-ceo-apologises-for-the-app-redesign-that-deleted-key-features))

**The financial figures, from the earnings call:**
- *"The challenges associated with our app launch adversely affected our revenue by at least **$100 million**"* in FY2024
- *"**$20 million to $30 million** total"* budgeted for recovery ($7m spent in Q4, $5–10m expected in Q1)
- Two hardware launches (Arc Ultra, Sub 4) delayed
- Spence acknowledged they *"mishandled the rollout"* and had *"spread ourselves too thin"*
- The remediation commitments are the actual lesson: *"rigorous quality benchmarks at the outset"*, introducing major app changes *"gradually"*, and appointing **a quality ombudsperson**
([Sonos FY24 earnings call transcript](https://www.investing.com/news/transcripts/earnings-call-sonos-confronts-app-issues-sees-revenue-drop-in-fiscal-2024-93CH-3723640))

Spence left the CEO role in the aftermath.

**Why this maps onto your situation with uncomfortable precision:** Sonos did not lose those features to a bug. They lost them because a rewrite reproduced *what the team remembered the app did*. That is verbatim the root cause in your own Feature Ledger rule, and the mechanism behind your 2.0 rewrite dropping the size axis.

### Concrete safeguards, ordered by cost-effectiveness

**1. A feature manifest that gates the merge — you already have this, so make it enforcing**

`FEATURE-MANIFEST.md` exists. Extend it to a **screen × role × breakpoint** matrix and make the completeness check fail the build when an entry has no corresponding behaviour. Your own experience is the argument: *"a feature check reported 'Full series: PRESENT' — the match was inside `.git/hooks/*.sample`."*

**⚠️ The failure mode you must design against — from your own notes, and it is the single most important paragraph in this section:** *"the same check reported 'Product images: MISSING' — the feature is real, implemented as `image_url`/`images` columns on variants, not a table named `product_images`. Searched for a name, missed the shape."* A retrofit changes **shape** constantly — a sidebar link becomes a bottom-tab item, a hover menu becomes a drawer row. **A name-based check will report every migrated feature as lost and every unmigrated one as present.** Check for reachability and behaviour, not identifiers.

**2. Visual regression testing — best fit for this specific job**

Playwright's `toHaveScreenshot()` captures baselines, compares with **pixelmatch**, and supports `maxDiffPixels` thresholds. ([playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots))

Practical setup: **baseline every screen × role at 375px, 768px and 1280px BEFORE any CSS changes.** This is the highest-leverage single action in Part B and takes an afternoon. Without pre-change baselines, visual regression testing is worthless — you cannot compare to a state you never captured.

Playwright's own caveat is real: *"browser rendering can vary based on the host OS, version, settings, hardware, power source... headless mode"* — so pin the runner or you will drown in false diffs. **And a false diff is the same failure as a false alarm in a security gate: a check that cries wolf gets switched off.**

**3. An interface inventory before the work starts** — Brad Frost's method, 30–90 minutes, whole team, screenshots categorised. It surfaces the drift you already know exists (10 escape helpers, 7 diverged `pageHeader` copies) *before* it gets baked into a new layout.

**4. A manual, phone-in-hand walk of every screen in every role** — Sonos had automated testing. What they lacked was somebody using the thing the way a real user does. On a real phone, on a real Lebanese connection, on one of the cheap Android devices representing ~13% of traffic.

**5. Ship behind a per-role flag, roll out gradually** — Sonos's own #1 remediation commitment. It converts a catastrophe into a rollback.

**6. Prove each check goes red** — your standing rule, and it applies here more than anywhere: *"a check is not finished until it has been proven to go RED."* Delete a bottom-tab item, confirm the manifest check fails, restore, confirm it passes.

---

## B6. ⚠️ What Part B does NOT solve

- **A bottom bar does not fix information architecture.** If a wholesaler cannot find "stock transfers" today, five tabs and a More sheet will not make the mental model coherent. That needs card-sorting with real users, which no amount of navigation chrome substitutes for.
- **Responsive CSS does not fix performance.** A 68 KB view module and 142 `innerHTML` writes will be slow on a Tecno at 43 Mbps regardless of layout. That is B1-Step-5 and code-splitting work, measured with Lighthouse — not assumed from "feels fine."
- **WCAG 2.5.8 compliance is not accessibility.** It is one AA criterion. Nothing here addresses contrast, focus order, screen readers, or **RTL for Arabic** — which for Lebanon and the Gulf is arguably a bigger gap than touch targets, and was not researched here.
- **Visual regression testing catches pixels, not behaviour.** A button that renders perfectly and no longer submits passes every screenshot test. Behavioural checks (`check_pack_moq.sh` class) remain necessary and separate.
- **The device statistics are proxies, not your users.** StatCounter's Lebanon figure is page-view-weighted across public websites. Your actual split could be 80/20 either direction. **Instrument before you optimise.**
- **None of this addresses the two-copy drift problem.** `wholesale-v2/` and `wholesale-v2-github-upload/` must stay byte-identical; your notes record them drifting twice in one day, each time causing a real bug. A mobile retrofit touches nearly every CSS and view file — **the highest-probability failure of this whole project is not a bad layout, it is a correct fix that never reaches the deploy.**
- **I could not verify Material 3 or Apple HIG navigation-count guidance.** Both primary pages are JS-rendered and returned no content. If the exact tab-count recommendation matters for a design review, those need reading in a browser.

---

# Every URL opened

### Part A — standards, guidance, incidents
1. https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/05-Enumerate_Infrastructure_and_Application_Admin_Interfaces
2. https://cwe.mitre.org/data/definitions/419.html
3. https://cwe.mitre.org/data/definitions/656.html
4. https://cwe.mitre.org/data/definitions/602.html
5. https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
6. https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
7. https://cheatsheetseries.owasp.org/cheatsheets/Attack_Surface_Analysis_Cheat_Sheet.html
8. https://csf.tools/reference/nist-sp-800-53/r5/sc/sc-2/
9. https://raw.githubusercontent.com/OWASP/ASVS/master/4.0/en/0x12-V4-Access-Control.md
10. https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x17-V8-Authorization.md
11. https://github.com/OWASP/ASVS/issues/1591 *(metadata only — comments not retrieved)*
12. https://www.cisa.gov/news-events/directives/binding-operational-directive-23-02
13. https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-289a
14. https://portswigger.net/web-security/access-control
15. https://owasp.org/Top10/A01_2021-Broken_Access_Control/ *(redirect page)*
16. https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/index.html
17. https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/
18. https://supabase.com/docs/guides/database/secure-data
19. https://nvd.nist.gov/vuln/detail/CVE-2025-48757
20. https://web.dev/articles/multi-origin-pwas
21. https://web.dev/articles/building-multiple-pwas-on-the-same-domain
22. https://www.guidepointsecurity.com/blog/the-secret-life-of-apis-uncovering-hidden-endpoints-and-more/
23. https://www.rapid7.com/blog/post/2022/10/07/cve-2022-40684-remote-authentication-bypass-vulnerability-in-fortinet-firewalls-web-proxies/
24. https://cloud.google.com/blog/topics/threat-intelligence/unc5537-snowflake-data-theft-extortion
25. https://www.microsoft.com/en-us/research/publication/how-effective-is-multifactor-authentication-at-deterring-cyberattacks/
26. https://owasp.gitbooks.io/owasp-devguide-v3/content/04-OperationalSecurity/Administrative-Interfaces.html
27. https://csrc.nist.gov/pubs/sp/800/207/final *(landing page — definitions not present)*
28. https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf
29. https://devguide.owasp.org/
30. https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/
31. https://docs.github.com/en/enterprise-server@3.13/admin/configuring-settings/hardening-security-for-your-enterprise/enabling-subdomain-isolation

### Part B — accessibility, navigation research, regional data, redesign risk
32. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
33. https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html
34. https://support.google.com/accessibility/android/answer/7101858?hl=en-GB
35. https://developer.apple.com/design/tips
36. https://developer.apple.com/design/human-interface-guidelines/tab-bars — ⚠️ **no content (JS-rendered)**
37. https://m3.material.io/components/navigation-bar/guidelines — ⚠️ **no content (JS-rendered)**
38. https://m3.material.io/foundations/designing/structure — ⚠️ **no content (JS-rendered)**
39. https://developer.android.com/develop/ui/compose/layouts/adaptive/navigation-suite-scaffold — ⚠️ **404**
40. https://www.lukew.com/ff/entry.asp?1945= — ⚠️ **404**
41. https://medium.com/google-design/the-obvious-ui-is-often-the-best-ui-7a25597d79fd
42. https://www.nngroup.com/articles/hamburger-menus/
43. https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/
44. https://www.nngroup.com/articles/mobile-navigation-patterns/
45. https://www.nngroup.com/articles/support-mobile-navigation/
46. https://www.nngroup.com/articles/radical-incremental-redesign/
47. https://baymard.com/blog/ecommerce-navigation-best-practice
48. https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php
49. https://www.smashingmagazine.com/2019/08/bottom-navigation-pattern-mobile-web-pages/
50. https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries
51. https://web-platform-dx.github.io/web-features-explorer/features/container-queries/
52. https://ishadeed.com/article/the-state-of-mobile-first-and-desktop-first/
53. https://alistapart.com/article/mobile-first-css-is-it-time-for-a-rethink/
54. https://bradfrost.com/blog/post/conducting-an-interface-inventory/
55. https://playwright.dev/docs/test-snapshots
56. https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/lebanon
57. https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/saudi-arabia
58. https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/united-arab-emirates
59. https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/iraq
60. https://gs.statcounter.com/vendor-market-share/mobile/lebanon
61. https://datareportal.com/reports/digital-2026-lebanon
62. https://datareportal.com/reports/digital-2026-united-arab-emirates
63. https://datareportal.com/digital-in-saudi-arabia — ⚠️ **landing page only, figures not retrieved**
64. https://www.speedtest.net/global-index/lebanon — ⚠️ **HTTP 403, blocked**
65. https://www.whathifi.com/news/sonos-ceo-apologises-for-the-app-redesign-that-deleted-key-features
66. https://www.investing.com/news/transcripts/earnings-call-sonos-confronts-app-issues-sees-revenue-drop-in-fiscal-2024-93CH-3723640

---

## Consolidated flags — what is unverified

| Claim | Status |
|---|---|
| Redbooth +70% session time / +65% DAU | Vendor-reported, uncontrolled, via Google Design; **original LukeW source 404** |
| Material 3 navigation-bar destination count | **Not verified** — page unreadable |
| Apple HIG tab-bar count / persistence guidance | **Not verified** — page unreadable (44pt target size **is** verified via a different Apple page) |
| Saudi Arabia DataReportal headline figures | **Not verified** — landing page only |
| Lebanon Ookla speeds | **Not verified** — Speedtest returned 403 (DataReportal's 43.90 Mbps median **is** verified) |
| ASVS #1591 contributor discussion | **Not retrieved** — only the issue title/metadata rendered |
| 2026-dated cPanel / Metabase CVEs | **Deliberately not cited** — primary advisories not opened |
| B2B-specific device split for Lebanon/Gulf | **No such dataset found** — measure your own traffic |
| Whether your RLS policies are actually correct | **Cannot be determined by research** — requires live cross-tenant testing |agentId: a5c2935662083f180 (use SendMessage with to: 'a5c2935662083f180', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 203693
tool_uses: 105
duration_ms: 911273</usage>