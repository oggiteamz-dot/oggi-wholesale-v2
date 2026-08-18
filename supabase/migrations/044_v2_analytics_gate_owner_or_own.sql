-- =============================================================================
-- 044 — THE ANALYTICS GATE BECOMES "OWNER, OR THIS WHOLESALER'S OWN DATA"
-- =============================================================================
-- 18 Aug 2026. Hadi: "Total orders, revenue, and clients -- these should be
-- their own, like build a dashboard, to be wholesaler specific."
--
-- Those three figures exist today only on the OWNER dashboard, where they are
-- platform-wide totals summed across every wholesaler. The wholesaler's own
-- dashboard shows open orders, variants tracked, low stock and out of stock --
-- useful operationally, and silent about money.
--
-- WHY THIS MIGRATION EXISTS AT ALL, RATHER THAN A NEW SET OF FUNCTIONS
-- -------------------------------------------------------------------
-- Migration 039 already computes every one of these: revenue, order count,
-- average and median order value, units sold, cancellation rate, four
-- different client counts, top products, top clients, and both time series.
-- All six functions are gated by v2_require_owner().
--
-- The obvious move is to write v2_my_summary(), v2_my_top_products() and so
-- on. That is the move this migration deliberately does not make.
-- js/data/owner-analytics.js states the reason in its own header:
--
--     "the moment two places can compute the same figure, they eventually
--      disagree and nobody can tell which screen is lying."
--
-- Two copies of "what is revenue" is not a hypothetical risk in this codebase.
-- The HTML-escape helper exists in ten copies under four names. pageHeader
-- exists in seven copies that have ALREADY diverged -- four render a
-- page-actions slot and three do not. A second revenue definition would drift
-- the same way, and the failure mode is worse than a missing slot: the owner's
-- drill-down and the wholesaler's dashboard would quote different money for
-- the same month, in front of a customer, with no way to tell which was right.
--
-- So the aggregates are not touched. ONE LINE changes in each of the six
-- functions -- the guard -- and both roles then read the same SQL.
--
-- HOW THE SWAP IS DONE, AND WHY IT LOOKS ODD
-- ------------------------------------------
-- The six functions are not re-typed here. This migration reads each one's
-- CURRENT definition out of the catalog with pg_get_functiondef(), replaces
-- exactly one line in the text, and executes the result.
--
--     perform wholesale_v2.v2_require_owner();
--  -> perform wholesale_v2.v2_require_owner_or_own(p_wid);
--
-- That is deliberate and it is the safer of the two options. Pasting 450
-- lines of aggregate SQL into a second file to change one line in each means
-- a second copy of every revenue definition, sitting in the repo, waiting to
-- drift from 039 -- the precise failure this migration exists to avoid. It
-- also means a transcription error could silently alter an aggregate, and an
-- aggregate that is quietly wrong is far worse than one that is obviously
-- broken, because it still returns a plausible number.
--
-- Reading from the catalog makes the bodies byte-identical by construction.
--
-- THE RISK OF DOING IT THIS WAY, AND THE GUARD AGAINST IT: a string replace
-- that matches nothing fails silently -- the function would be recreated
-- unchanged and still owner-only, and the wholesaler dashboard would return
-- 42501 with nothing explaining why. So the block below COUNTS the
-- substitutions and raises unless all six happened. It cannot half-apply.
--
-- WHAT THE NEW GUARD ALLOWS
-- -------------------------
--   owner              -> any wid
--   wholesaler         -> their own wid, and nothing else
--   anyone else / anon -> nothing, raises 42501
--
-- The wholesaler's wid comes from v2_my_wid(), which reads v2_user_profiles by
-- auth.uid(). It is derived from the token and cannot be claimed by the
-- client, so passing someone else's wid as p_wid raises rather than returning
-- their revenue. That is the entire security boundary of this migration and it
-- is one comparison; it is written out here so nobody has to infer it.
--
-- v2_require_owner() itself is left in place, unchanged. Nothing calls it after
-- this migration, but v2_owner_billing_list() (042) does, and other
-- cross-wholesaler functions will want it later. Removing a working guard to
-- tidy up is how guards get lost.
-- =============================================================================

set search_path = wholesale_v2, public;

-- -----------------------------------------------------------------------------
-- The new guard
-- -----------------------------------------------------------------------------
create or replace function wholesale_v2.v2_require_owner_or_own(p_wid text)
returns void
language plpgsql
security definer
set search_path = wholesale_v2, public
as $guard$
begin
  if wholesale_v2.v2_is_owner() then
    return;                                   -- the owner sees everything
  end if;

  -- v2_my_wid() reads v2_user_profiles by auth.uid(). It is derived from the
  -- token, never from anything the caller sends, so a wholesaler cannot ask
  -- for another wholesaler's figures by changing the argument.
  --
  -- The NULL check is not redundant: buyers and sales reps run as `anon` with
  -- auth.uid() NULL, so v2_my_wid() returns NULL for them. Without this,
  -- `NULL = p_wid` evaluates to NULL, `not NULL` is NULL, and an IF on NULL
  -- takes the else branch -- which would have let it through.
  if wholesale_v2.v2_my_wid() is null or wholesale_v2.v2_my_wid() is distinct from p_wid then
    raise exception 'You can only read your own figures'
      using errcode = '42501';
  end if;
end;
$guard$;

comment on function wholesale_v2.v2_require_owner_or_own(text) is
  'Raises unless the caller is the platform owner, or is the wholesaler whose wid was passed. Called first in every function in migration 039 -- those are SECURITY DEFINER and bypass RLS, so this check IS their access control. Replaces v2_require_owner() there so the owner drill-down and the wholesaler dashboard compute their figures from the same SQL and cannot disagree.';

revoke all on function wholesale_v2.v2_require_owner_or_own(text) from public, anon;
grant execute on function wholesale_v2.v2_require_owner_or_own(text) to authenticated;

-- -----------------------------------------------------------------------------
-- The swap
-- -----------------------------------------------------------------------------
do $swap$
declare
  r record;
  def text;
  newdef text;
  swapped int := 0;
  expected int := 6;
  targets text[] := array[
    'v2_owner_wholesaler_summary',
    'v2_owner_top_products',
    'v2_owner_top_clients',
    'v2_owner_sales_series',
    'v2_owner_product_series',
    'v2_owner_client_list'
  ];
begin
  for r in
    select p.oid, p.proname
    from pg_proc p
    where p.pronamespace = 'wholesale_v2'::regnamespace
      and p.proname = any(targets)
  loop
    def := pg_get_functiondef(r.oid);

    if position('perform wholesale_v2.v2_require_owner();' in def) = 0 then
      raise exception
        'v2_require_owner() guard not found in %(). Either it was already changed, or 039 was edited and this migration no longer knows where the guard is. Refusing to rewrite the function blind.',
        r.proname;
    end if;

    newdef := replace(def,
      'perform wholesale_v2.v2_require_owner();',
      'perform wholesale_v2.v2_require_owner_or_own(p_wid);');

    execute newdef;
    swapped := swapped + 1;
  end loop;

  -- A silent no-op here would leave the wholesaler dashboard raising 42501
  -- with nothing to explain it. Fail now, loudly, instead.
  if swapped <> expected then
    raise exception 'Expected to rewrite % analytics functions, rewrote %. Aborting.', expected, swapped;
  end if;

  raise notice 'v2_require_owner_or_own installed in % analytics functions', swapped;
end;
$swap$;

-- -----------------------------------------------------------------------------
-- Prove it took. Belt and braces: the DO block above counts its own work, and
-- this re-reads the catalog afterwards and fails if any function still carries
-- the old guard.
-- -----------------------------------------------------------------------------
do $verify$
declare stale text;
begin
  select string_agg(p.proname, ', ')
    into stale
    from pg_proc p
   where p.pronamespace = 'wholesale_v2'::regnamespace
     and p.proname in ('v2_owner_wholesaler_summary','v2_owner_top_products',
                       'v2_owner_top_clients','v2_owner_sales_series',
                       'v2_owner_product_series','v2_owner_client_list')
     and pg_get_functiondef(p.oid) like '%v2_require_owner();%';
  if stale is not null then
    raise exception 'These functions still carry the owner-only guard: %', stale;
  end if;
end;
$verify$;

-- Grants are unchanged by CREATE OR REPLACE, but are restated so this file can
-- be read on its own. `anon` stays excluded: buyers and sales reps have no wid
-- the database can verify, so there is nothing here they could safely be shown.
revoke all on function wholesale_v2.v2_owner_wholesaler_summary(text, timestamptz, timestamptz)            from public, anon;
revoke all on function wholesale_v2.v2_owner_top_products(text, timestamptz, timestamptz, int)             from public, anon;
revoke all on function wholesale_v2.v2_owner_top_clients(text, timestamptz, timestamptz, int)              from public, anon;
revoke all on function wholesale_v2.v2_owner_sales_series(text, timestamptz, timestamptz, text)            from public, anon;
revoke all on function wholesale_v2.v2_owner_product_series(text, uuid[], timestamptz, timestamptz, text)  from public, anon;
revoke all on function wholesale_v2.v2_owner_client_list(text, timestamptz, timestamptz)                   from public, anon;

grant execute on function wholesale_v2.v2_owner_wholesaler_summary(text, timestamptz, timestamptz)           to authenticated;
grant execute on function wholesale_v2.v2_owner_top_products(text, timestamptz, timestamptz, int)            to authenticated;
grant execute on function wholesale_v2.v2_owner_top_clients(text, timestamptz, timestamptz, int)             to authenticated;
grant execute on function wholesale_v2.v2_owner_sales_series(text, timestamptz, timestamptz, text)           to authenticated;
grant execute on function wholesale_v2.v2_owner_product_series(text, uuid[], timestamptz, timestamptz, text)  to authenticated;
grant execute on function wholesale_v2.v2_owner_client_list(text, timestamptz, timestamptz)                  to authenticated;

-- NOTE ON THE NAMES. These keep their v2_owner_* names even though a
-- wholesaler now calls them. Renaming six functions would touch every call
-- site in js/data/owner-analytics.js for no behavioural gain, and a rename is
-- exactly the kind of change that looks free and silently breaks one caller
-- nobody grepped for. Each function's comment is where the audience is
-- recorded, not the identifier.
