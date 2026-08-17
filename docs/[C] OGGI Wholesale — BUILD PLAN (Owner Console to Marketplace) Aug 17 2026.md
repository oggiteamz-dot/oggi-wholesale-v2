# OGGI Wholesale — BUILD PLAN
## Owner Console → Marketplace, in batches
**17 August 2026** · Supersedes the batch ordering in CR-0001 §Sequence
Built from: the v1→v2 Regression Ledger (24 findings), a code-truth pass on the live
source, and three deep-research threads (158 sources, listed in §9).

---

# 0. THE FOUR ANSWERS YOU ASKED FOR

## 0.1 "Did you build it mobile first?" — **No. And it is worse than not-mobile-first.**

**The evidence, from your own source:**

| Check | Finding |
|---|---|
| Media queries in the entire app | **3.** One is `prefers-reduced-motion`. The other two are `max-width: 880px` |
| Query direction | `max-width` = **desktop-first**. Mobile-first uses `min-width` |
| `css/layout.css:62` | `@media (max-width: 880px) { #sidenav { display: none; } }` |
| Hamburger / drawer / bottom nav anywhere in the codebase | **Zero matches** |
| Nav items in the topbar | **None** — topbar is brand, role label, cart icon, "Switch role" |

**So: below 880px the sidebar is hidden and nothing replaces it. On a phone, every role —
owner, wholesaler, rep, buyer — has NO navigation at all.** You can only move between
screens by typing a `#/` URL by hand or finding an in-page link.

This is not a styling complaint. Under your own *Software Quality-of-Life Checklist
(STANDARD)*, "no stranded screen — every screen has a way home + next action" is a Tier-1
gate. It is currently red **app-wide**, and has been since the v2 build started.

### The research finding that changes the fix

I assumed your users were phone-first. **The data says otherwise for Lebanon.**

StatCounter, July 2026, device share of web traffic:

| Country | Mobile | Desktop |
|---|---|---|
| **Lebanon** | **40.4%** | **58.7%** |
| Saudi Arabia | 65.4% | 33.6% |
| Iraq | 61.1% | 37.4% |
| UAE | 59.4% | 40.0% |

**Lebanon is desktop-majority.** The Gulf and Iraq are mobile-majority but at ~60%, not
"overwhelming." Caveat both ways: StatCounter measures page views on tracker-carrying
sites, not B2B tool usage, and nobody publishes a device split for B2B wholesale software
in this region. A wholesaler checking stock on a warehouse floor is on a phone; the same
person reconciling a month of orders is on a laptop. **Both are real users.**

**What this changes:** do **not** rebuild mobile-only, and do **not** deprecate the desktop
sidebar — in Lebanon it is serving the majority. Build adaptive, both sizes first-class.
The bar for fixing mobile nav is not "most users are on phones"; it is "40–65% of traffic
currently has no navigation," which is indefensible at any share.

**One more number worth knowing:** median cellular download is **43.9 Mbps in Lebanon vs
614 Mbps in the UAE — a 14× gap**. And Tecno + Infinix (budget Android, 2–4GB RAM) are
**12.6% of Lebanese mobile traffic**, plus ~12% "Unknown" which skews old and low-end.
Roughly a fifth to a quarter of Lebanese mobile traffic is on weak hardware. Your
`wholesaler.js` is 68KB/1,258 lines with 142 `innerHTML` writes. **Code-splitting is a
performance requirement here, not just hygiene.**

## 0.2 "Will rebuilding lose all these features?" — **A rewrite would. An incremental retrofit will not.**

The research turned up the best-documented recent case of exactly your fear:

**Sonos, 2024.** Redesigned their app, shipped it with working features deleted — sleep
timers, local music management, playlist and queue editing. The CEO publicly apologised.
The earnings call put the damage at **"at least $100 million"** in lost FY2024 revenue,
plus **$20–30M** in remediation, two delayed hardware launches, and eventually his job.

**They did not lose those features to a bug. The rewrite reproduced what the team
remembered the app did.** That is verbatim the root cause your own Feature Ledger rule was
written for, and the mechanism behind the 2.0 rewrite dropping the size axis.

**So: no rewrite.** The safe path, in order:

1. **Capture Playwright visual baselines for every screen × role at 375 / 768 / 1280px
   BEFORE touching any CSS.** This is the single highest-leverage action in the whole plan
   and takes an afternoon. Without pre-change baselines, visual regression testing is
   worthless — you cannot compare against a state you never captured.
2. Ship navigation **first, alone**, as its own batch. It is independently testable.
3. Convert **component by component**, one per commit, each independently revertable.
   Never a global find-and-replace — that produces the closed-range gap bug (a
   `min-width:880` and `max-width:880` pair leaves 880px itself unstyled).
4. Split `wholesaler.js` **only after** the CSS is stable, so a regression has one possible
   cause, not two.

⚠️ **The check-design trap, from your own history:** your feature check once reported
"Product images: MISSING" because it searched for a table named `product_images` when the
feature is real as `image_url` columns on variants. *Searched for a name, missed the
shape.* **A retrofit changes shape constantly** — a sidebar link becomes a bottom-tab item,
a hover menu becomes a drawer row. **A name-based check will report every migrated feature
as lost and every un-migrated one as present.** Check reachability and behaviour, never
identifiers.

## 0.3 "Change it to OGGI's light colour scheme" — **Cheap, safe, and half-done already.**

Good news first: **it is already light mode.** `css/tokens.css` opens with a comment
recording your instruction ("Keep it light mode. I don't like the dark mode").

The problem is the accent ramp. The file says:

```css
/* Brand / accent (indigo — OGGI primary) */
--accent-500: #4F46E5;   /* indigo */
```

**That comment is factually wrong. Indigo was never OGGI.** OGGI is mint `#54E5A0`,
deep emerald `#00845F`, dark navy ink `#0E2230`. That single mislabelled line is why the
app doesn't look like yours.

**Scope of the fix:** one token file (35 hex values) + **~40 hardcoded hex across 13 JS
files** that bypass the tokens. Half a day. **Near-zero feature risk** — it changes no
logic, and the visual baselines from §0.2 will catch anything that moves.

⚠️ **One real constraint, not a nitpick:** mint `#54E5A0` on white is roughly a **1.7:1
contrast ratio** — it fails WCAG AA (4.5:1) for text by a wide margin. So mint cannot be
your button or text colour on light backgrounds. The correct mapping:

| Role | Colour |
|---|---|
| Text, primary buttons, links, active states | **emerald `#00845F`** (passes AA on white) |
| Headings, ink | **navy `#0E2230`** |
| Accents, highlights, success states, badges, chart fills, focus rings | **mint `#54E5A0`** |
| Dark surfaces (topbar, footer) | navy→black gradient, with mint on top (mint passes easily on dark) |

That is how the brand PDFs use it anyway — mint is a highlight on dark, not body text on
white. **And per your standing rule: no eye motif, no 6-pointed star. Text wordmark only.**
The current topbar renders a literal `O` in a box plus an `env-tag` reading **"v2 · dev"**
— that ships to production today and should go.

## 0.4 "Three separate links" — **Right conclusion. Wrong reason. And the wrong reason would build the wrong thing.**

### Where you are backed by the standards

This is codified, not folklore:

- **CWE-419** — mitigation, verbatim: *"Do not expose administrative functionality on the
  user UI."*
- **NIST SP 800-53r5 SC-2** — *"Separate user functionality, including user interface
  services, from system management functionality,"* and names *"administrative interfaces
  on different domains"* as an acceptable mechanism.
- **OWASP ASVS 4.3.1** (Level 1 — the *lowest* conformance tier) — admin interfaces must
  use MFA.
- **CISA BOD 23-02** — US federal agencies must, within 14 days, remove management
  interfaces from the internet or put them behind *"a policy enforcement point separate
  from the interface itself (preferred action)."*

### Where the reasoning breaks

"A shared link invites hacking" treats **the URL as a control**. It is not. Nobody attacks
a link; they attack an endpoint.

- OWASP WSTG-CONF-05 exists because admin paths are trivially enumerated — and
  specifically because *"links to administrator functionality may be discovered"* by
  reading the JavaScript sent to every user.
- PortSwigger: *"hiding sensitive functionality does not provide effective access control…
  The script containing the URL is visible to all users regardless of their role."*
- **CWE-656** — reliance on security through obscurity.

**Plainly: the database is the lock, not the website. Three websites in front of one
unlocked database are three doors into the same unlocked room.**

Supabase says this in its own docs — the publishable key is safe to expose *because* RLS
checks every row against the user's JWT. The security lives in the policies.

**The precedent that matches your exact stack: CVE-2025-48757 — insufficient Supabase RLS
in Lovable-generated apps, CVSS 9.3, 170+ apps, unauthenticated read/write to arbitrary
tables.** Every one of those apps had a nice front end. Several had admin sections. None of
it mattered.

### What I recommend, and in what order

**Do the split — but do the part that actually stops an attack first, so the split is
protecting something real instead of just looking safer.**

1. **Prove the boundary from outside the browser.** `curl` an owner-only RPC using a real
   *buyer* token. If it returns data, three links would have been theatre. If it returns
   403, you have a real boundary. *(This is Batch 0, and it gates everything.)*
2. **Owner/staff console → its own origin** (`admin.<domain>`), behind Cloudflare Access
   (allow-by-email + require MFA), **`__Host-` prefixed cookie, no `Domain` attribute,
   short session, and NOT a PWA** — no service worker, no manifest.
3. **Wholesaler and buyer stay on ONE origin.** They are two roles in one product sharing
   a PWA install story. web.dev is explicit: a service worker *"can only control pages
   hosted under the origin and path it belongs to"*, caches and localStorage are
   per-origin, each origin needs its own manifest, and users installing from a subdomain
   *"will only be able to install PWAs for the subpages."* Splitting them **actively
   degrades the PWA you shipped on 14 Aug.**
   You still get what you asked for: **two distinct entry links** (`/portal` for
   wholesalers, `/shop` for buyers) that land on different screens with different bundles —
   different links, one origin, a fraction of the cost.
4. **Code-split so admin JS never ships to a buyer.** Real attack-surface hygiene *and* a
   performance win on those Tecno devices. But be clear-eyed: GuidePoint documented a case
   where an attacker found `/api/admin/users` in a JS bundle and *"retrieved all user
   passwords in cleartext despite lacking administrative authorization."* **The JS
   disclosure was the recon; the missing server-side check was the vulnerability.**

### ⚠️ What splitting does NOT solve — stated so nobody over-trusts it

- It does not stop a stolen or shared password. MFA does.
- It does not prevent broken authorization. Broken Access Control is **#1 in OWASP Top 10
  2025 — 1.84M occurrences, 32,654 CVEs** — because it is an application-logic failure, not
  a topology failure.
- A policy enforcement point protects the **interface**, not the **API**. The Supabase API
  must stay publicly reachable for the buyer app. **The database rules keep doing all the
  real work.**
- It does nothing about the **142 `innerHTML` writes** and 7 unescaped `pageHeader` copies,
  currently backstopped by a CSP with `script-src 'self'` — one careless `unsafe-inline`
  away from gone.

---

# 1. THE MARKETPLACE — HONEST VERDICT BEFORE FEATURES

You want: business owners browse products from many wholesalers, wholesaler names hidden,
everything branded OGGI.

## 1.1 The finding that matters most

**No successful curated B2B wholesale marketplace hides the supplier.** Faire, Ankorstore,
Creoate, Orderchamp, JOOR, FashionGo, Zentrada — the brand *is* the merchandising unit.
Buyers shop brands.

Supplier anonymity exists in exactly **three** proven configurations, and all three are a
different business from Faire:

1. **1P — the platform buys and resells.** Wasoko (~40 warehouses), Amazon Business 1P,
   Turn 14, Sary, Retailo. **Anonymity here is free — it's a consequence of being the
   seller of record, not something you engineer.** The cost is inventory and working capital.
2. **Blind drop-ship inside a real distributor contract** (Turn 14 in auto parts). Works
   because there is *one* counterparty with a commercial contract, not a thousand.
3. **Dropship aggregators** (Spocket, Syncee) — hide the supplier from the *end consumer*,
   but the retailer sees them. Not your model.

## 1.2 The nine ways the curtain tears, ranked by how fast

| # | Leakage vector | Hardness |
|---|---|---|
| 1 | **Packing slip / invoice in the carton** — supplier prints the default once, cover gone | Contractual only |
| 2 | **Shipping label + return address** — must be a real address that accepts goods | Needs your own consolidation point |
| 3 | **Product legal labelling** | **Legal — cannot be engineered around.** EU GPSR (Reg. 2023/988, in force 13 Dec 2024) requires manufacturer name, postal address and email **on the product**. **In the EU, product anonymity is illegal.** US/MENA is permissive — "Distributed by OGGI" is compliant |
| 4 | Care labels, warranty cards, QR codes, branded tape | Needs a private-label SKU |
| 5 | **Customs / bill of lading** — shipper and consignee are **public record**, resold by ImportGenius, Panjiva, ImportYeti | Mitigable, never eliminated |
| 6 | **Reverse image search** — 15 seconds, unless you own the photography | Re-shoot everything |
| 7 | Returns address | Needs your own returns node |
| 8 | Supplier's sales team recognises repeat volume | Contractual |
| 9 | Your staff, their staff | Unfixable |

## 1.3 How often it actually fails — real numbers

- **China's largest on-demand cargo platform** (269,921 transactions, 1,971 drivers): off-platform
  transactions went **3.92% → 7.87%** after a 15% commission was introduced (+3.2pp caused
  by the fee). **Two-thirds of drivers leaked at least once in 137 days.**
- **Airbnb, Austin:** ~**5.4%** of transactions went offline. And the perverse finding —
  **better information about the counterparty *increases* leakage**, because it lowers the
  perceived risk of going direct.
- Buyer-side perks barely deter it (coefficient 0.025 vs 0.195 supplier-side). **Fee level
  is the dominant driver.**

**Budget for 5–8% leakage as a baseline, rising with your take rate. Anonymity buys time,
not immunity.**

## 1.4 The thing I'd want you to hear before building

**Hiding the supplier transfers 100% of the blame to you.** On Spocket, every stockout,
every silent cancellation, every unanswered message became *Spocket's* fault, because the
buyer had nobody else to shout at:

> *"Spocket is absolutely unreliable and completely unprofessional… no real inventory
> tracking; orders canceled for 'out of stock' despite high stock display… loss of ad spend
> (thousands)."*
> *"Supplier communication bottlenecked through customer service… unclear supplier ratings."*

**Faire can survive a bad brand — a buyer blames the brand. OGGI cannot: every bad supplier
is OGGI being bad.** The anonymised marketplace is an **operations commitment far more than
a software one**: live stock, same-day support, no silent cancellations. If you can't fund
that, ship it named.

## 1.5 But there is one genuinely strong wedge, and it isn't margin

The loudest unsolved complaint from independent retailers:

> *"We hate the fact that every store in our area can order exactly the same merchandise."*
> — Carol Schroeder, *Gifts & Decorative Accessories*

**Because buyers can't identify or contact suppliers, you can do territory exclusivity
better than Faire can** — you control which SKUs each buyer even sees, so no two shops on
the same street need to see the same catalogue. Faire's mechanics are worth copying
outright: zone sized to capture ~20–25 nearby retailers, capped at the postcode, 12-month
term, annual spend commitment, shortfall billed as credit.

**That, not the take rate, is the reason to build this.**

## 1.6 And the category's financial verdict, which is unambiguous

Every B2B wholesale marketplace that tried to make money on **the transaction alone** died
or pivoted: Handshake (retired Oct 2023), Tundra (shut Jun 2023), Abound (closed Jun 2023),
Trouva (administration Feb 2025, retailers unpaid), Bulletin (absorbed into a trade-show
business), Etsy Wholesale (2018).

The survivors make money on **credit, advertising, or fintech**: Faire on net-60 terms and
payout fees plus ads (7,000+ brands advertising, ~5% of revenue, *"the fastest growing
business we've ever launched"*); Bazaar reached profitability **only after acquiring a
fintech**; Wasoko-MaxAB is *"betting everything on fintech."* One founder's summary of the
model: ***"A terrible business, but an amazing Trojan horse."***

**Design the marketplace so credit terms and payment can bolt on later without a rewrite.
That is where this ends up, every single time.**

## 1.7 ⛔ The decision that gates the whole marketplace batch

**Is OGGI the merchant of record?** Does the buyer pay OGGI, get an OGGI invoice, and chase
OGGI for problems — or does the order pass through to the wholesaler?

- **If yes:** anonymity is real and structurally sound. You need payment handling, a
  payout ledger, and a support SLA.
- **If no:** anonymity is a curtain that tears in week three, and you carry the blame with
  none of the control.

**There is no third option. Nothing in Batch 9 should start before this is decided.**

---

# 2. WHAT THE RESEARCH SAYS TO ADD TO THE OWNER CONSOLE

You asked for: click a wholesaler → their customers, orders, revenue, stats, top-selling
products, highest-paying customer. Here is that, expanded against how Stripe Connect,
WHMCS, Shopify Partners and Atlassian actually structure a per-tenant view.

## 2.1 The wholesaler drill-down — field by field

**§A — Header (sticky)**
Tenant ID (copyable) · legal + trading name · status badge (Active / Trial / Past due /
Suspended / Churned) · owner contact incl. WhatsApp · country, city, currency · signup date
and days since · **last activity and who** · **direct link to their live catalogue** ·
actions bar (Message, Suspend, Change plan, Add credit, Impersonate, Audit log)

⚠️ **Copy Stripe's "Actions Required" block: top of page, ordered by urgency, and it
disappears entirely when nothing is wrong.** Never show an empty "0 issues" panel — it
trains people to ignore that region of the screen.

**§B — Commercial**
Plan, price, interval · **MRR contribution and % of platform MRR** · next renewal + days ·
payment method + expiry (flag cards expiring <30 days) · lifetime revenue · outstanding
balance · overdue invoices · credit balance · discounts + expiry · trial end · payment
failures last 90 days · **cancellation reason if churned**

**§C — Their business** *(the part you actually asked for)*

*Customers:* total buyer accounts · active 30/90d · new this month · **highest-paying buyer
(name, LTV, order count, last order)** · **top 5 buyers by revenue with each one's % of
that wholesaler's GMV** ← their own concentration risk · buyers with zero orders ever ·
buyers who ordered last period but not this one

*Orders:* this period vs prior + % change · GMV with a **trailing 12-month sparkline** ·
**AOV *and* median** (show both — AOV lies when one whale exists) · status split · **cancellation
rate** · **median time-to-confirm in hours** (pure ops-health signal) · last order timestamp

*Products:* total SKUs, active vs archived · zero-stock SKUs · **never-ordered SKUs** ·
**top sellers by units AND by revenue** (they disagree, show both) · products added last 30
days (catalogue freshness = engagement) · **% of catalogue with images** · **selling-model
mix** (open / prepack / ratio / series — tells you which features they actually use)

**§D — Engagement**
Last login (owner / any user) · logins 7/30d · **active users ÷ licensed seats** · DAU/MAU ·
**a literal feature-adoption checklist** (catalogue published ✓, first product ✓, first
buyer invited ✓, first order received ✓, packs configured ✗, price list set ✗) — show
*which* features, never a score · **time-to-first-value in days** · per-user table (invited,
days active, last active, orders processed, products edited) · mobile vs desktop split

**§E — Health & risk** — see §2.2

**§F — Support & history** — tickets, append-only timestamped notes, lifecycle event feed
(plan changes, suspensions, payment failures, flag toggles), **impersonation history for
this tenant**

**§G — Config & limits** — feature flags + who toggled them and when · usage vs limits ·
integrations · API keys (masked, last-used) · custom domain

**§H — Audit** — immutable log filtered to this tenant

**Two structural features to copy verbatim from Stripe, because they are the difference
between a console someone uses and one they abandon:**
- **Editable columns + saveable named views** on the tenant list
- **CSV export of the current *filtered* view**, not of everything

## 2.2 Health score — and the discipline that makes it honest

**Do not build a churn ML model.** At 5–50 tenants you will have had 3–8 churn events.
There is nothing to train on.

Signals, commerce-weighted (order velocity matters more than logins, because for a
transactional tenant *orders are the value delivery*):

| Signal | Green | Amber | Red |
|---|---|---|---|
| **Order velocity** (orders 30d ÷ prior 30d) | ≥0.9 | 0.6–0.9 | <0.6 |
| **Recency** (worse of: days since last order, days since owner login) | ≤7d | 8–21d | >21d |
| **Feature breadth** (of ~8 core features, last 30d) | ≥5 | 3–4 | ≤2 |
| **Buyer engagement** (active buyers ÷ total buyers) | ≥40% | 20–39% | <20% |
| **Commercial** (payment failures, downgrade, overdue, open P1 >7d) | none | one | two+ |

**Six rules, each from a documented failure:**
1. **Trend beats level.** 62-and-falling is worse than 45-and-flat. Store score history.
2. **Never display a bare number.** Show the five components. A person can act on "no
   orders in 26 days"; nobody can act on "47."
3. **Ship with NO weights until you have ≥10 real churn events.** Gainsight names *"failing
   to validate weights using historical churn data"* as a top mistake. Weighting before you
   have data is astrology with arithmetic.
4. **Absolute floors override the score.** Zero orders in 30 days = Critical regardless of
   the sum. Composites hide single catastrophic signals.
5. **Score at tenant level, never user level.**
6. **Time-to-first-value is a separate gate**, not a component. >30 days to first order is
   its own red flag.

⚠️ **Counter-signal most people get backwards:** a *sudden drop* in support tickets is a
disengagement signal, not a success signal. Both a spike (friction) and a collapse
(abandonment) are bad. A naive "fewer tickets = healthier" weighting inverts reality.

## 2.3 Platform-wide metrics — honest triage

**🟢 Actionable now at 5–50 tenants:** MRR with every tenant's contribution as a readable
table · logo count by status · **concentration risk** (one customer >10% of revenue is the
standard red flag; top-5 >25%) · GMV total and per tenant · **activation funnel counted in
names, not percentages** ("14 of 18 published a catalogue; 9 received a first order") ·
time-to-first-value per tenant · contraction events as a list · overdue invoices ·
**zero-activity list (14/30 days)** — this is your entire early-warning system ·
**"biggest movers, up and down, last 30 days"** — the delta list is more actionable than
the top list, and almost nobody builds it

**🟡 Build the plumbing, read it later (~50 tenants):** NRR/GRR — the maths is valid at any
n but the *number* is noise below ~30 accounts; store the monthly MRR movement components
(new / expansion / contraction / churn / reactivation) from day one so the series exists ·
cohort retention (store `signup_month` now) · CAC/LTV/payback

**🔴 Vanity at your scale:** logo churn **as a percentage** — with 20 tenants one churn =
5%; reporting "5% monthly churn" from n=1 is a lie with a decimal point. **Report the count
and the names.** · platform-wide DAU/MAU · total registered users · any percentage whose
denominator is under ~30

> The test worth adopting: *if a metric appears on your board deck and nobody has ever
> asked a follow-up question about it, it is a vanity metric.*

## 2.4 Impersonation — the highest-risk feature in the console

You will want "log in as this wholesaler." The evidence on how it goes wrong is brutal:

- **Twitter, 2020:** **>1,000 staff and contractors** could access any account and reset
  passwords. Four were phished. NY DFS found no adequate access controls and no CISO.
- **Snapchat "SnapLion":** built for lawful intercept, spread to four departments. A former
  employee: *"the keys to the kingdom."* Another confirmed it *"did not have a satisfactory
  level of logging to track what data employees accessed."* Employees spied on users.
- **Okta, Oct 2023:** support system held HAR files containing **session tokens** →
  **134 customers** exposed, 5 session-hijacked (1Password, Cloudflare, BeyondTrust).
- **Entra ID CVE-2025-55241 (CVSS 10.0):** impersonate any user in any tenant. Worst part —
  **no API-level logging**, so exploitation left *no trace* and bypassed MFA.
- **Uber "God View":** FTC settlement, **20 years** of biennial third-party privacy audits.

**The rules, non-negotiable:**

| # | Rule |
|---|---|
| 1 | **Read-only by default.** Write impersonation is a separate, rarer, louder thing |
| 2 | **Prefer "see their data" over "become them."** A good drill-down (§2.1) answers ~90% of support cases without impersonating at all — build that first and impersonation becomes rare, which is itself the strongest control |
| 3 | **Dual identity in the token — RFC 8693 `act` claim.** `sub` = impersonated, `act.sub` = the real admin. Never a `?impersonate=true` parameter (that exact pattern is a documented account-takeover path) |
| 4 | **30-minute max session, 10-minute idle timeout.** GitHub Enterprise caps at 1 hour; Clerk at 30 min |
| 5 | **Mandatory typed reason before the session starts.** This alone kills casual browsing |
| 6 | **Notify the tenant. Non-suppressible.** GitHub's wording: *"You cannot deactivate these emails"* |
| 7 | **Opt-in with expiry.** Zendesk's model: off by default, tenant enables for a chosen duration, auto-expires. In Lebanon/MENA this is a *sales asset*: "we literally cannot see inside your account unless you switch it on" |
| 8 | **Impossible-to-miss visual state** — banner *and* a full-viewport border. Banners get scrolled past |
| 9 | **"X on behalf of Y" attribution in the tenant-facing UI, permanently.** A real user on this: *"that should be classified as a security flaw when someone can log in as you, do something bad and everyone thinks you did it"* |
| 10 | **No admin may impersonate another admin** |
| 11 | **Scope by intersection** — the session sees only what *both* parties can access |
| 12 | **Hard-exclude payment credentials, buyer PII export, and password/2FA management** from impersonated sessions |
| 13 | **Log session START and END.** An open-ended session with no recorded end is unauditable |
| 14 | **Never log the session token itself** — that was Okta's 134-customer breach |

## 2.5 Twenty-two must-not-do rules from operator complaints

Condensed; full quotes and sources in the research appendix. The ones that bite hardest here:

- **Never split information the operator uses together across two screens.** *"I can't see
  my daily and monthly stats at the same time."* → today / this month / last month on ONE screen.
- **Never make the operator open a control before using it.** Search fields always visible.
- **Never let the console get slow as tenants grow.** Test with **500 synthetic tenants**
  before shipping, not 5.
- **Never let a number change retroactively without explanation.** Every metric shows
  "as of <timestamp>" and its definition on hover.
- **Never aggregate things the operator considers distinct.** Every rolled-up figure is
  clickable through to its rows. **No terminal numbers.**
- **Never ship a console whose data the owner can immediately tell is wrong.** Hand-verify
  every headline metric for one real tenant before launch. One visibly wrong number
  destroys trust in all the right ones.
- **Never gate a destructive action behind "Are you sure?"** — GitLab lost 100 projects to
  exactly that. **Type-to-confirm the tenant name**, show blast radius ("this affects 412
  products and 38 buyers"), soft-delete with a restore window.
- **Never make the view page the edit page.** Read-only by default, explicit Edit mode.
- **Never make bulk operations one-at-a-time.**
- **Never ship reporting with fixed columns.**
- **Never let an empty console count as a working console.** *"Done" means a screen showing
  real data for a real tenant* — the `wholesale_v2` exposed-schema outage is exactly this
  class: every asset returned 200 while every data call failed.

---

# 3. THE BATCHES — OWNER CONSOLE

Strict order. One at a time, proven before the next, per your standing rule.

## BATCH 0 — Prove the authorization boundary ⛔ GATES EVERYTHING
*Half a day. No new features.*

1. Mint a real **buyer** token. `curl` an owner-only RPC (`v2_create_wholesaler`,
   `v2_extend_subscription`, `v2_set_wholesaler_price`) with it.
2. Attempt a cross-tenant read: buyer of wholesaler A reading wholesaler B's products,
   clients, orders, costs.
3. Verify the owner-only tables reject an authenticated non-owner.
4. **Prove each check goes RED** — break it deliberately, watch it fail, restore, watch it
   pass. *A check is not finished until it has been proven to go red.* `check_pack_moq.sh`
   reported 7 green while the function crashed on every call.

**Proof of done:** a committed `checks/check_authz_boundary.sh`, negative-tested, with the
red output pasted in the commit message.
**If anything returns data it shouldn't, everything below stops until it's fixed.**

## BATCH 1 — Shared foundation + OGGI skin
*1–2 days. App-wide. Must precede new screens or you build six more in the wrong colours.*

1. **Playwright visual baselines: every screen × role at 375 / 768 / 1280px.** First. Before
   any CSS change.
2. Extract `js/lib/utils.js` — kill the **10 copies of the escape helper under 4 names**
   and the **7 drifted `pageHeader` copies** (4 render a `page-actions` slot, 3 don't, so
   `mobile-ops`, `integrations` and `import-catalog` structurally cannot host a page action).
3. Fix the 3 unescaped live-data call sites (`buyer.js:42`, `wholesaler.js:33`,
   `mobile-ops.js:214`).
4. **`tokens.css` → OGGI palette** per §0.3, and sweep the ~40 hardcoded hex in 13 files.
5. Remove the `v2 · dev` env tag; replace the `O` box with the OGGI text wordmark.
6. Re-run baselines, review every diff deliberately.

**Proof:** visual diff report reviewed screen by screen; contrast checker passing AA on
every text/background pair.

## BATCH 2 — Finish CR-0001's unshipped half
*The things you can't see, plus the one that's genuinely dangerous.*

1. **Multi-brand input box** ← your explicit ask. The data layer
   (`v2_set_wholesaler_brands`, `v2_wholesaler_brands`) is live; there is no UI.
2. **Price field on the create form** (currently you create, then set price separately).
3. **🔴 Password reset from the owner console.** I verified `pg_proc` — no reset function
   exists. Because logins are OGGI-issued `handle@oggiwholesale.app` and those are **not
   real inboxes**, a forgotten password today is **unrecoverable by anyone**. CR-0001 marked
   this "required, not optional" and it did not ship.
4. **R4 — send credentials by WhatsApp / copy to clipboard.** `wa.me` link, zero setup.
5. Edit an existing wholesaler's identity fields.

## BATCH 3 — The wholesaler drill-down ← *the big one you asked for*
*§2.1 §A–§C. Build §A, §B, §C as three commits.*

⚠️ **Depends on the client-stats join fix** (shipped today). Without it the drill-down would
have faithfully displayed "0 orders / never ordered" for every real client.

Ship with: read-only by default, editable columns + saved views, CSV export of the filtered
view, every rolled-up number clickable to its rows, freshness timestamp on every metric.

**Proof:** open a real wholesaler; hand-verify GMV, top buyer, and top product against a SQL
query. One wrong number and the batch fails.

## BATCH 4 — Health, concentration, biggest movers
*§2.2 + the green list in §2.3. Transparent signals, **no weights**.*

## BATCH 5 — Audit log + read-only impersonation
*§2.4. Audit log ships in the same batch as impersonation, never after.*

Schema: Actor · Action · Target · Timestamp · Context, consistent across every event type,
plus impersonated-user-if-any, before/after diff on mutations, tenant ID, reason text.
Append-only, hash-chained, 13 months hot, CSV export with a webhook hook left in the schema.
**Never log:** session IDs, tokens, keys, passwords, card data.

## BATCH 6 — Separate admin origin + policy enforcement point
*§0.4 steps 2 and 4. Only meaningful after Batch 0 passed.*

`admin.<domain>` · Cloudflare Access (allow-by-email + require MFA) · `__Host-` cookie ·
**not a PWA** · admin JS code-split out of the buyer bundle.
Then `/portal` and `/shop` as distinct entry routes on the existing origin.

## BATCH 7 — Public signup + invites + dormant email
*CR-0001 R5/R6/R7. Standalone embeddable `join.html`, rate-limited RPC modelled on the
existing buyer signup, requests land in the Onboarding Queue. Email built dormant: reports
"not configured", never pretends to send. Templates in a table, not in code.*

## BATCH 8 — Mobile navigation (app-wide)
*Per §0.1–0.2. Ships alone.*

- Persistent **bottom bar, 4 items + "More"**, role-dependent, **text labels always visible**
- **"More" opens a full-screen hub** listing every remaining section — the pattern for an
  app with 9+ sections, which a 5-slot bar cannot hold
- `env(safe-area-inset-bottom)` from day one (iOS bottom toolbar collides otherwise)
- 44px minimum touch targets, 48px for repeated taps (quantity steppers, size-matrix cells,
  colour chips), ≥8px gaps
- **Keep the desktop sidebar above 880px** — in Lebanon it serves the majority
- Highlight the user's current scope in the nav (**95% of sites don't** — cheap, high value)

**The evidence for combo over hamburger** (NN/g, 179 participants): navigation *use* on
mobile **57% hidden vs 86% combo**; **>20% drop in content discoverability** with hidden
nav; tasks **15% slower** on mobile, **39% slower** on desktop; perceived difficulty +21%.
Redbooth's hamburger→bottom-nav move reported **+70% session time, +65% DAU** *(vendor-
reported, uncontrolled — directionally consistent with NN/g, don't expect the number)*.

⚠️ The **owner console is exempt** — it lives on its own desktop origin per Batch 6 and
should not be a PWA at all.

## BATCH 9 — MARKETPLACE ⛔ BLOCKED on the §1.7 decision

Once merchant-of-record is decided:

**9a — Foundation:** cross-wholesaler product index · normalised attributes across messy
multi-supplier data · OGGI-branded product cards with **all supplier identifiers stripped
server-side** (not hidden client-side — that's the same mistake as §0.4) · category taxonomy
**9b — Cart:** one cart, one checkout, one payment across N hidden suppliers, split into N
fulfilments · per-supplier MOQ enforced inside the shared cart with live progress · per-
supplier lead times shown pre-checkout
*(This is a feature, not a compromise: JOOR's loudest complaint is being forced through
3–4 checkouts for one buying decision. Your buyer never even knows there were four.)*
**9c — Territory exclusivity** ← the wedge. Zone sized to ~20–25 nearby retailers, capped at
postcode, 12-month term, annual spend commitment
**9d — Trust ops:** live stock or "made to order, X-day lead time" — **no third state** ·
**no silent cancellations, ever** — a cancellation is a human message with a reason and a
substitute · **auto-cancel supplier orders unfulfilled 30 days past expected ship**
(Faire's mechanism, the cleanest SLA in the category) · performance badges **earned on
delivered metrics, never purchasable** (Alibaba sells "Gold Supplier" for $4,700/yr and
~99% of suppliers have it)
**9e — Money:** commission engine · split payouts on a **published date you never miss**
(Trouva died of exactly this) · per-order **net-proceeds preview to the supplier before
they accept** · **price parity contractual and monitored** · leave the schema seams for
credit terms (§1.6)

---

# 4. BACKLOG — WHOLESALER (12 open regressions)

Not started until the owner console batches land. Priority order:

| Pri | # | Item |
|---|---|---|
| 🔴 | 8 | **No product or variant creation UI at all** — products can only arrive via CSV/AI import. Nothing in `js/` ever writes `selling_model`, so the four selling models are enforceable but not *choosable* |
| 🔴 | 9 | **No colour can ever be set — every v2 product is grey.** `colorHex` is written by exactly one statement in the repo (the one-time v1 import) |
| 🔴 | 10 | **No image upload path** — pasted URLs only, zero storage calls in the repo. v1 did 50 photos/product to a bucket |
| 🔴 | 4 | **"Full series" enforcement can't be rebuilt from the repo** — the calling block exists only as a commented-out sample. Live has it, a from-scratch rebuild wouldn't |
| 🟠 | 12 | **An order can never be cancelled** — `cancelled` is in the enum and in 3 badge maps; nothing can set it. No edit-while-new, no change request |
| 🟠 | 13 | `/wholesaler/catalogs` is a literal "scheduled later" stub in the live nav |
| 🟠 | 16 | Order status timeline + the `packed` stage + per-line partial shipment (currently *forbidden* — Ship is disabled until every line is scanned) |
| 🟠 | 17 | Stock transfer between locations — **and no UI writes `v2_locations`, so a wholesaler cannot create a second location.** ⚠️ `FEATURE-MANIFEST.md` row 16 calls this "present but not enforced." That row is false — an enum value is not a feature. Correct or delete it |
| 🟠 | 18 | Order date-range filter (Today / Week / Month / Custom) — missing on all three order views |
| 🟠 | 19 | Manual WhatsApp send + bulk blast *(automated WhatsApp on order events IS real)* |
| 🟡 | 22 | "Was $X" badge — `compare_at_price` is a real column, imported, loaded, **never rendered** |
| 🟡 | 23 | Barcode label generation/printing — v2 scans but cannot render Code128/QR |
| 🟡 | 24 | `pack_price` stored and displayed but **never charged** |

# 5. BACKLOG — SALES REP (3 open)

| Pri | # | Item |
|---|---|---|
| 🟠 | 11 | **A rep cannot place an order.** `salesperson.js` imports `cart` and never uses it; no `/sales/order*` route; `v2_submit_order` accepts only `role='buyer'`. Order-on-behalf was the entire point of rep mode |
| 🟠 | 6 | Concurrent per-client rep carts — `scopeSuffix` threaded through all 7 cart methods, **no caller passes it** (12 call sites) |
| 🟡 | 21 | Rep client search; rep-scoped orders — `salesperson.js:241` fetches every order for the tenant. **No `rep_id`/`placed_by` column exists**, so "my orders / my revenue" is not computable without a schema change |

# 6. BACKLOG — BUYER (6 open)

| Pri | # | Item |
|---|---|---|
| 🔴 | 2 | **Favourites is a permanent dead end.** Route + nav exist, `isFavourite`/`toggleFavourite` exported and **imported by nothing**, no star control on any card. Empty state says "Star products from the catalog" and nothing can star |
| 🔴 | 3 | **Order notes readable but unwritable.** `cart.submit()` destructures `notes` and never passes it; the RPC has no notes parameter. Every note is permanently empty |
| 🔴 | 14 | **Voice note per order item** — your explicit Jul-17 ask, live in v1 on bucket `order-voice`. Zero MediaRecorder/audio/storage in v2 |
| 🔴 | 15 | **Written comment per line item** — same ask, same breath. No note column in any of 38 migrations |
| 🟠 | 5 | `orderedTimesCount` is dead code — "ordered N times" never renders |
| 🟡 | 20 | Buyer order-history search + activity feed — no input element exists |

# 7. NOT REGRESSIONS — never re-report these

Falsified by the audit and confirmed present: bulk price update · duplicate-as-template ·
client list by recency · rep sets client discount · catalog search + colour/size filter
(richer than v1) · **"Fixed box" — prepack IS fixed box** · ratio pack · colour×size variant
stock · MOQ · landed cost · ABC · reorder points · barcode scanning · per-product sizes.
**All four selling models are in the constraint.** The Aug-11 handoff and the 15 Aug
CLAUDE.md note saying "series = 0 matches" are **stale** — correct the record rather than
acting on it.

# 8. THE MISSING DOCUMENT THAT OUTRANKS EVERY BATCH

**`FEATURE-LEDGER-REBUILT.md` does not exist.** The v2 PRD, the 14-batch build plan and the
Aug 14 audit all cite it as the authoritative must-keep list. The only file that mentions
its name is the Aug 3 ledger pointing at it.

**v2 was built against a pointer to a missing document.** Until it exists, every future
"nothing was lost" claim is unverifiable — which is how 24 regressions accumulated through
five audits that each declared things fine.

**Reconstruct it from the CODE-TRUTH PASS + this regression ledger, and commit it.** It is
cheap, it is boring, and it is the reason this plan exists at all.

# 9. SOURCES

158 URLs opened across three research threads. Full lists, including every blocked fetch
and every unverified claim, are in the research appendix delivered alongside this plan.

**Honest limits, stated so nobody over-trusts this:**
- Trustpilot returned 403 on every attempt; Reddit thread bodies were blocked (403/500) and
  appear only as verbatim search snippets. Complaint mining leaned on Shopify App Store
  reviews, Capterra, G2, Hacker News, GitLab issues and trade press instead.
- No peer-reviewed study with clean effect sizes exists for churn leading indicators. Every
  such number here is practitioner-reported.
- Momentum Nexus's churn signal numbers are self-reported, n=11. Treat as hypotheses.
- No dataset exists for device split in B2B wholesale software in Lebanon or the Gulf.
  **Measure your own traffic — one week of real data beats every number in §0.1.**
- No public post-mortem exists of an SPA breached *specifically* because roles shared one
  login URL. The failure is always documented one layer down. **That absence is itself the
  finding.**
