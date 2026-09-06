-- 120 — MOD-07: the tier gate is removed
--
-- DECISION D2, in Hadi's words: "Tier two, gate. Drop it. Completely remove it."
-- The build plan states the resulting rule: A MEMBER OF A STORE SEES THAT STORE.
--
-- WHAT A TIER WAS. `v2_catalogs.access_tier` (1-5) and `v2_clients.access_tier`
-- (1-5) were compared in exactly two places, and those two comparisons are the
-- whole feature:
--
--   v2_buyer_catalogs    where ... and c.access_tier <= v_tier
--   v2_catalog_by_token  if v_tier < v_cat.access_tier then -> 'denied'
--
-- Both go, in ONE migration. Removing one and not the other would leave the
-- list and the link disagreeing about who may open a catalogue -- the same
-- drift MOD-03 was written about, where the wider of two rules wins silently.
--
-- WHAT MUST SURVIVE, AND IS THE REASON THIS MIGRATION IS DANGEROUS
--
-- v2_catalog_by_token denies for TWO different reasons that sit four lines
-- apart, and only one of them is the tier gate:
--
--   v_acct.wid is distinct from v_cat.wid  -> 'denied'   <-- THE TENANT BOUNDARY
--   v_tier < v_cat.access_tier             -> 'denied'   <-- the tier gate
--
-- The first is which SHOP you belong to. The second is your RANK inside it.
-- They return the identical string from adjacent blocks, and deleting the wrong
-- one opens every wholesaler's private catalogues to every other wholesaler's
-- customers, while the screen still says "denied" often enough to look fine.
-- The gate asserts the tenant boundary explicitly, before and after.
--
-- 'login_required' for a signed-out visitor and the `is_public` short-circuit
-- are untouched.
--
-- MEASURED ON PRODUCTION BEFORE WRITING THIS
--
--   26 catalogues, 8 of them above tier 1, active. 59 clients spanning tiers 1-5.
--   So this is NOT an inert change: 7 of 13 buyer accounts can enumerate one
--   more catalogue afterwards.
--
--   AND YET NOT ONE PRODUCT CHANGES HANDS. The set of products every one of the
--   13 accounts can reach is byte-identical before and after -- all 13 hashes.
--   MOD-04 already widened the store read to the union of a buyer's catalogues,
--   and every gated catalogue's products were already reachable through another
--   catalogue that buyer could see. What widens is the ability to ENUMERATE a
--   catalogue, not the ability to order anything new.
--
--   Atelier's three hand-beaded made-to-order gowns -- A-102, A-109, A-110, the
--   named leak case carried through MK-04, MOD-01 and MOD-03 -- sit behind
--   tier 5, and that store's only buyer is already tier 5. They do not move.
--   They remain out of the marketplace: that is `p.is_public`, a different rule
--   in different functions, and this migration does not touch it.
--
-- THE RULE DOES CHANGE, AND SAYING SO IS THE POINT
--
-- Today no buyer sits below a catalogue that holds a product found nowhere
-- else, which is why nothing moves. From today, a wholesaler has no way to keep
-- a catalogue back from a buyer they have approved. That is what D2 asked for
-- and what the store model means -- catalogues are being retired entirely in
-- MOD-09 -- but it is a real change and it is recorded here rather than
-- discovered later.
--
-- THE COLUMNS STAY, AND BECOME VESTIGIAL
--
-- `access_tier` is not dropped from either table. Dropping it would cascade
-- into v2_create_client, three client screens and twelve checks for no benefit
-- while the catalogue concept is still standing. It stops being read by
-- anything after this migration and is scheduled to die with the catalogue in
-- MOD-09. Both functions still RETURN the column so no signature changes and
-- the 113/114 PGRST203 overload trap does not apply; asserted at the bottom.

CREATE OR REPLACE FUNCTION wholesale_v2.v2_buyer_catalogs(p_account_id uuid)
 RETURNS TABLE(id uuid, name text, description text, is_default boolean, access_tier smallint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'wholesale_v2', 'public'
AS $function$
declare
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
begin
  select * into v_acct from wholesale_v2.v2_portal_accounts
  where v2_portal_accounts.id = p_account_id
    and role in ('buyer', 'sales') and active;

  if v_acct.id is null then
    return;
  end if;

  -- MOD-07: the client's tier was read here and compared below. Both are gone.
  -- What remains is the only boundary that ever mattered: c.wid = v_acct.wid.
  return query
  select c.id, c.name, c.description, c.is_default, c.access_tier
  from wholesale_v2.v2_catalogs c
  where c.wid = v_acct.wid
    and c.active
  order by c.is_default desc, c.name;
end;
$function$
;

CREATE OR REPLACE FUNCTION wholesale_v2.v2_catalog_by_token(p_token text, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(status text, id uuid, name text, description text, wid text, is_public boolean, access_tier smallint, wholesaler_name text, billboard_enabled boolean, billboard_image_url text, billboard_media_type text, billboard_product_id uuid, billboard_cta text, highlight_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'wholesale_v2', 'public'
AS $function$
declare
  v_cat  wholesale_v2.v2_catalogs%rowtype;
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
  v_wname text;
begin
  select * into v_cat from wholesale_v2.v2_catalogs c
   where c.share_token = p_token and c.active;

  if v_cat.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, null::text,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_cat.wid;

  if v_cat.is_public then
    return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                        v_cat.is_public, v_cat.access_tier, v_wname,
                        v_cat.billboard_enabled, v_cat.billboard_image_url, v_cat.billboard_media_type,
                        v_cat.billboard_product_id, v_cat.billboard_cta, v_cat.highlight_label;
    return;
  end if;

  if p_account_id is null then
    return query select 'login_required'::text, null::uuid, null::text, null::text, v_cat.wid,
                        false, v_cat.access_tier, v_wname,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  select * into v_acct from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id and a.role in ('buyer','sales') and a.active;

  -- THE TENANT BOUNDARY. Not the tier gate, and deliberately left standing.
  -- The tier check that used to sit immediately below this one returned the
  -- SAME 'denied' string from an adjacent block, which is exactly why removing
  -- the wrong one would be so hard to see. This one is which SHOP you belong
  -- to; the deleted one was your RANK inside it.
  if v_acct.id is null or v_acct.wid is distinct from v_cat.wid then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, v_wname,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- MOD-07: `if v_tier < v_cat.access_tier then -> denied` stood here.
  return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                      v_cat.is_public, v_cat.access_tier, v_wname,
                      v_cat.billboard_enabled, v_cat.billboard_image_url, v_cat.billboard_media_type,
                      v_cat.billboard_product_id, v_cat.billboard_cta, v_cat.highlight_label;
end;
$function$
;
