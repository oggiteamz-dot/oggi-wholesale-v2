-- =============================================================================
-- 042 — WHOLESALER IDENTITY + BILLING LOCKDOWN
-- =============================================================================
-- 18 Aug 2026. Reported by Hadi, verbatim: "Why do we have the names of all
-- the different wholesalers available to be seen by a customer, by a
-- wholesaler? That needs to be removed."
--
-- WHAT WAS ACTUALLY EXPOSED
-- -------------------------
-- Verified live before writing this, using nothing but the publishable key
-- that ships in the public JS bundle -- no login, no session, no token:
--
--   GET /rest/v1/v2_wholesalers?select=wid,brand,name,contact_phone,
--       contact_email,owner_notes,price_amount,paid_until
--   -> every wholesaler row, including OGGI's own contact phone and email
--      and one customer's paid_until date.
--
--   GET /rest/v1/v2_wholesaler_billing?select=*
--   -> every wholesaler's subscription_status, price_amount, paid_until,
--      days_remaining.
--
-- TWO INDEPENDENT CAUSES. Fixing either one alone would have left the other
-- wide open, which is why both are handled here.
--
--   (a) `anon` and `authenticated` held table-wide SELECT, INSERT, UPDATE,
--       DELETE, TRUNCATE, REFERENCES and TRIGGER on v2_wholesalers, and the
--       read policy in migration 023 was `using (true)`.
--
--   (b) v2_wholesaler_billing is a VIEW created WITHOUT security_invoker, so
--       it runs with its owner's rights and BYPASSES row-level security on
--       the base table entirely. Tightening v2_wholesalers would not have
--       closed it. This is the trap worth remembering: a definer view is a
--       hole straight through RLS, and it does not appear in pg_policies.
--
-- THE GRANT TRAP, AGAIN
-- ---------------------
-- Migrations 031/032 already paid for this lesson on v2_product_variants.cost:
-- a column-level REVOKE does NOT override a table-level GRANT. Postgres treats
-- them as separate grants and the wider one wins. So the table grant must be
-- DROPPED first, and an explicit safe column list granted in its place.
-- Every REVOKE below is a REVOKE ALL on the table, never a per-column revoke.
--
-- WHY anon GETS NOTHING AT ALL
-- ----------------------------
-- Buyers and sales reps run as `anon` -- they authenticate through
-- v2_portal_accounts, so auth.uid() is NULL and v2_my_wid() cannot identify
-- them. There is therefore NO row-level predicate that can scope an anon read
-- to "their own wholesaler". Leaving anon with SELECT and a narrower column
-- list would still permit enumeration of the whole roster, which is the exact
-- thing being reported.
--
-- So anon loses table access completely and reaches a wholesaler only through
-- v2_public_wholesaler(p_wid), which takes an EXACT id and returns AT MOST ONE
-- ROW of catalogue-facing columns. There is no argument that returns a list.
-- Enumeration stops being a permissions question and becomes impossible.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. v2_wholesalers -- drop the table-wide grants
-- ---------------------------------------------------------------------
-- REVOKE ALL, not a column revoke. See the header.
revoke all on wholesale_v2.v2_wholesalers from anon;
revoke all on wholesale_v2.v2_wholesalers from authenticated;

-- ---------------------------------------------------------------------
-- 2. Re-grant a deliberate, minimal surface to `authenticated`
-- ---------------------------------------------------------------------
-- `authenticated` is the owner and the wholesalers -- the only two roles
-- holding a real Supabase JWT. Row scoping (step 3) then decides WHICH rows;
-- this decides WHICH COLUMNS, and the two are independent controls.
--
-- Every column here is one the shipped front-end actually reads. Checked
-- against js/data/catalog.js, js/data/owner.js, js/data/wholesaler-settings.js,
-- js/data/pricing-admin.js and js/views/owner*.js. If a column is not on this
-- list, no browser session can read it by any query, ever.
grant select (
  wid, brand, name, currency, active,
  low_moq_threshold, trust_message, return_policy, payment_terms,
  order_min_qty, order_min_value
) on wholesale_v2.v2_wholesalers to authenticated;

-- DELIBERATELY ABSENT, and now unreachable from any browser session:
--   contact_phone, contact_email  -- PII
--   owner_notes                   -- OGGI's private notes on a customer
--   price_amount, price_currency, billing_period, paid_until,
--   subscription_status, cancelled_at, cancel_reason
--                                 -- what this customer pays OGGI
--   created_by, created_at, industry, location
-- The owner still sees all of them -- through the SECURITY DEFINER functions
-- in step 5, which check v2_require_owner() before returning a single byte.

-- Writes: only the columns the app actually edits. `active` is the owner's
-- suspend switch; the rest are the wholesaler's own settings screens.
grant update (
  brand, name, currency, active, updated_at,
  low_moq_threshold, trust_message, return_policy, payment_terms,
  order_min_qty, order_min_value
) on wholesale_v2.v2_wholesalers to authenticated;

-- No INSERT and no DELETE for anyone. Creating a wholesaler goes through
-- v2_create_wholesaler() and deleting is not a thing the app does at all --
-- both were reachable directly until this migration.

-- ---------------------------------------------------------------------
-- 3. Row scoping -- replace `using (true)`
-- ---------------------------------------------------------------------
drop policy if exists v2_wholesalers_read on wholesale_v2.v2_wholesalers;
create policy v2_wholesalers_read_scoped on wholesale_v2.v2_wholesalers
  for select
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());
comment on policy v2_wholesalers_read_scoped on wholesale_v2.v2_wholesalers is
  'Owner sees every wholesaler. A wholesaler sees exactly their own row and cannot discover that any other wholesaler exists. Replaces migration 023''s using (true), which was written when the buyer login screen was believed to need the roster -- it does not: login takes the wid as typed input and v2_buyer_login returns the name.';

-- INSERT/UPDATE/DELETE policies from 023 are already correctly scoped
-- (v2_is_owner() / v2_my_wid()) and are left exactly as they are.

-- ---------------------------------------------------------------------
-- 4. The one door left open to `anon`, and it is a keyhole
-- ---------------------------------------------------------------------
-- A buyer browsing a catalogue needs their supplier's display name, currency
-- and the trust/returns copy shown on the cart. Exact id in, at most one row
-- out, public columns only. No list form exists.
create or replace function wholesale_v2.v2_public_wholesaler(p_wid text)
returns table (
  wid text, brand text, name text, currency text, active boolean,
  low_moq_threshold integer, trust_message text,
  return_policy text, payment_terms text
)
language sql
security definer
set search_path = wholesale_v2, public
stable
as $$
  -- No wildcard, no ILIKE, no OR. An exact match or nothing.
  select w.wid, w.brand, w.name, w.currency, w.active,
         w.low_moq_threshold, w.trust_message, w.return_policy, w.payment_terms
  from wholesale_v2.v2_wholesalers w
  where w.wid = p_wid
  limit 1;
$$;
comment on function wholesale_v2.v2_public_wholesaler(text) is
  'The ONLY read path into v2_wholesalers for the anon role. Exact-id lookup, one row, catalogue-facing columns. Returns inactive wholesalers too, carrying `active` so the buyer app can say "this supplier is unavailable" instead of rendering a blank page -- suspending a wholesaler must not look like a crash to their customers.';

revoke all on function wholesale_v2.v2_public_wholesaler(text) from public;
grant execute on function wholesale_v2.v2_public_wholesaler(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. v2_wholesaler_billing -- the definer view
-- ---------------------------------------------------------------------
-- Left as a SECURITY DEFINER view ON PURPOSE, and then made unreachable.
-- Switching it to security_invoker instead would break the owner console,
-- because the owner runs as `authenticated` and step 2 just removed that
-- role's SELECT on price_amount and paid_until. Revoking the view and
-- reaching it through an owner-checked function is the honest shape: one
-- gate, stated once, rather than two half-controls that have to agree.
revoke all on wholesale_v2.v2_wholesaler_billing from anon;
revoke all on wholesale_v2.v2_wholesaler_billing from authenticated;

create or replace function wholesale_v2.v2_owner_billing_list()
returns table (
  wid text, brand text, paid_until date, subscription_status text,
  price_amount numeric, price_currency text, billing_period text,
  cancelled_at timestamptz, cancel_reason text,
  is_paid_up boolean, days_remaining integer, status_label text
)
language plpgsql
security definer
set search_path = wholesale_v2, public
stable
as $$
begin
  -- SECURITY DEFINER bypasses RLS, so THIS LINE is the access control.
  -- Not decoration. Deleting it publishes OGGI's entire revenue book.
  perform wholesale_v2.v2_require_owner();
  return query
    select b.wid, b.brand, b.paid_until, b.subscription_status,
           b.price_amount, b.price_currency, b.billing_period,
           b.cancelled_at, b.cancel_reason,
           b.is_paid_up, b.days_remaining, b.status_label
    from wholesale_v2.v2_wholesaler_billing b
    order by b.brand;
end;
$$;
comment on function wholesale_v2.v2_owner_billing_list() is
  'Owner-only replacement for selecting v2_wholesaler_billing directly. Until 18 Aug 2026 that view was readable by the anon role and, being a definer view, bypassed RLS -- so every wholesaler''s subscription price and expiry date was public.';

revoke all on function wholesale_v2.v2_owner_billing_list() from public;
grant execute on function wholesale_v2.v2_owner_billing_list() to authenticated;

-- ---------------------------------------------------------------------
-- 6. v2_wholesaler_brands -- same `using (true)` shape
-- ---------------------------------------------------------------------
-- A wholesaler's brand lineup (Nike, Dsquared...) is competitive
-- intelligence: it identifies who they are even without the name attached.
-- Only the owner console reads this today, so scoping it costs nothing now
-- and closes the hole before CR-0003 puts it in front of buyers.
drop policy if exists v2_wholesaler_brands_read on wholesale_v2.v2_wholesaler_brands;
create policy v2_wholesaler_brands_read_scoped on wholesale_v2.v2_wholesaler_brands
  for select
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

revoke all on wholesale_v2.v2_wholesaler_brands from anon;
revoke all on wholesale_v2.v2_wholesaler_brands from authenticated;
grant select (id, wid, name, is_primary, sort_order)
  on wholesale_v2.v2_wholesaler_brands to authenticated;

-- Brands are written through v2_set_wholesaler_brands() (migration 037),
-- which is SECURITY DEFINER, so no direct write grant is needed.

-- When CR-0003 ships the buyer-facing brand lineup, it gets its own
-- exact-id function alongside v2_public_wholesaler -- NOT a table grant.
