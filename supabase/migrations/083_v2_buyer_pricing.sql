-- ============================================================================
-- 083 — Batch S / S4: pricing through the gate
--
-- TWO THINGS ARE WRONG TODAY, AND THE SECOND IS THE SERIOUS ONE.
--
-- (a) v2_pricing_tiers is read straight off the table by the buyer, and anon
--     holds SELECT on it. There are ZERO tier rows on production today
--     (checked 26 Aug), so nothing leaks yet — but at launch, twenty
--     wholesalers in one trade will fill that table with their quantity
--     breaks, and the read is cross-tenant.
--
-- (b) ⛔ v2_catalog_discount_pct(p_catalog_id, p_client_id) is SECURITY
--     DEFINER, granted to anon, and TAKES BOTH IDS FROM THE CALLER WITH NO
--     GATE. Proven live from the app's own origin, signed out, on 26 Aug:
--
--       AMANI Stores (sq)     -> 10.00
--       CEDAR Shops (sq)      ->  5.00
--       Boutique Farah (test) -> 10.00
--       catalog 'test432'     -> -5.00
--
--     Those are real negotiated terms. And the catalogue one is NEGATIVE — a
--     price increase that this project's own notes describe as "invisible to
--     the buyer by design". It is not invisible: a buyer holds their own
--     client id in their session, and one call returns their own number. That
--     part needs no guessing whatsoever.
--
--     It also leaks existence: a real catalog id returns '0.00', a made-up one
--     returns '0'. That is an oracle for confirming a guessed uuid.
--
-- This is the same defect migration 048 already fixed once, for price
-- overrides, and the same lesson written in js/data/catalogs.js:
-- **"a parameter you can change is a parameter someone will change."**
--
-- THE FIX: the buyer's discount is derived from their VALIDATED ACCOUNT.
-- There is no client_id parameter, so there is no different question to ask.
-- Same shape as v2_buyer_price_overrides (Batch 16) and v2_buyer_catalogs (055).
--
-- ⚠️ THE OLD FUNCTION IS LEFT IN PLACE AND STILL GRANTED. Revoking it here
-- would change behaviour before the app has moved, which is the one ordering
-- mistake this whole batch is built to avoid. It is revoked in S7, with the
-- table grants, after a real order has gone through the new path.
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. Quantity breaks for one catalogue. Internal, ungated, no grants —
--    same contract as v2__catalog_rows and v2__catalog_pack_rows.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2__catalog_tier_rows(p_catalog_id uuid)
returns table (product_id uuid, min_qty int, unit_price numeric)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select t.product_id, t.min_qty, t.unit_price
  from wholesale_v2.v2_catalog_products cp
  join wholesale_v2.v2_products p
    on p.id = cp.product_id and not p.archived
  join wholesale_v2.v2_pricing_tiers t
    on t.product_id = p.id
  where cp.catalog_id = p_catalog_id
  order by t.product_id, t.min_qty;
$fn$;

comment on function wholesale_v2.v2__catalog_tier_rows(uuid) is
  'INTERNAL. Batch S/S4. Quantity breaks for one catalog, WITH NO GATE. Granted to nobody.';

revoke all on function wholesale_v2.v2__catalog_tier_rows(uuid) from public;
revoke all on function wholesale_v2.v2__catalog_tier_rows(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Tiers — the two gated entry points.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_catalog_tiers(
  p_token text, p_account_id uuid default null
)
returns table (product_id uuid, min_qty int, unit_price numeric)
language plpgsql stable security definer
set search_path = wholesale_v2, public
as $fn$
declare v_cat_id uuid;
begin
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';
  if v_cat_id is null then return; end if;
  return query select * from wholesale_v2.v2__catalog_tier_rows(v_cat_id);
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_tiers(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_tiers(text, uuid) to anon, authenticated;

create or replace function wholesale_v2.v2_buyer_catalog_tiers(
  p_account_id uuid, p_catalog_id uuid
)
returns table (product_id uuid, min_qty int, unit_price numeric)
language plpgsql stable security definer
set search_path = wholesale_v2, public
as $fn$
begin
  if p_account_id is null or p_catalog_id is null then return; end if;
  if not exists (
    select 1 from wholesale_v2.v2_buyer_catalogs(p_account_id) bc where bc.id = p_catalog_id
  ) then return; end if;
  return query select * from wholesale_v2.v2__catalog_tier_rows(p_catalog_id);
end;
$fn$;

revoke all on function wholesale_v2.v2_buyer_catalog_tiers(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_catalog_tiers(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. ⛔ THE ONE THAT MATTERS: the discount, from the account, not the caller.
--
-- Takes NO client id. The client is read off the validated portal account
-- row, exactly as v2_buyer_price_overrides does. The catalogue is checked
-- against what this account may actually see.
--
-- The arithmetic is NOT reimplemented here — it delegates to
-- v2_catalog_discount_pct with ids IT resolved, so the buyer's screen and
-- v2_submit_order keep applying one rule. Two implementations of one
-- arithmetic rule is how the cart and the invoice drift apart, which
-- js/data/pricing.js already says in as many words.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_buyer_discount_pct(
  p_account_id uuid,
  p_catalog_id uuid default null
)
returns numeric
language plpgsql stable security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_acct   wholesale_v2.v2_portal_accounts%rowtype;
  v_cat_id uuid;
begin
  if p_account_id is null then
    return 0;
  end if;

  select * into v_acct from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id and a.role in ('buyer','sales') and a.active;
  if v_acct.id is null then
    return 0;
  end if;

  -- A catalogue this account cannot see contributes nothing, rather than
  -- erroring: same "an empty answer cannot confirm a guess" rule the rest of
  -- the batch follows.
  if p_catalog_id is not null and exists (
    select 1 from wholesale_v2.v2_buyer_catalogs(p_account_id) bc where bc.id = p_catalog_id
  ) then
    v_cat_id := p_catalog_id;
  end if;

  return wholesale_v2.v2_catalog_discount_pct(v_cat_id, v_acct.client_id);
end;
$fn$;

comment on function wholesale_v2.v2_buyer_discount_pct(uuid, uuid) is
  'Batch S/S4. The discount percentage for THIS buyer, derived from their validated account. Takes no client id, because a parameter you can change is a parameter someone will change. Replaces the buyer-side use of v2_catalog_discount_pct, which is revoked from anon in S7.';

revoke all on function wholesale_v2.v2_buyer_discount_pct(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_buyer_discount_pct(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. The same, for a buyer holding only a LINK.
--
-- Not logged in means no client, so only the catalogue's own share applies —
-- which is exactly what a not-logged-in buyer is charged.
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_token_discount_pct(
  p_token text, p_account_id uuid default null
)
returns numeric
language plpgsql stable security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_cat_id uuid;
  v_client uuid;
begin
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';
  if v_cat_id is null then
    return 0;
  end if;

  if p_account_id is not null then
    select a.client_id into v_client from wholesale_v2.v2_portal_accounts a
     where a.id = p_account_id and a.role in ('buyer','sales') and a.active;
  end if;

  return wholesale_v2.v2_catalog_discount_pct(v_cat_id, v_client);
end;
$fn$;

revoke all on function wholesale_v2.v2_token_discount_pct(text, uuid) from public;
grant execute on function wholesale_v2.v2_token_discount_pct(text, uuid) to anon, authenticated;
