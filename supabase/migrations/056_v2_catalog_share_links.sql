-- =============================================================================
-- 056 — A CATALOG IS A LINK YOU SEND, NOT A SHOP SOMEONE BROWSES
-- =============================================================================
-- 19 Aug 2026, correcting migration 055's front door.
--
-- Hadi: "What I wanted is when a wholesaler creates a catalog, he then gets the
-- ability to copy the link of that catalog and send it to his customers as a
-- link... There is no website for the actual buyer. That's never going to
-- happen. Instead, what they get is a link that they only get access to when
-- the catalog is active and the wholesaler sends them the link. There is no
-- 'show me catalog'. There is no 'get catalog'. There is just a custom link for
-- each catalog, and the catalog gets the information that this person has the
-- right to view it when they log in using their username and password created
-- by the wholesaler."
--
-- 055 built the right ENTITLEMENT and the wrong NAVIGATION. It gave buyers a
-- switcher listing every catalog their tier allowed, which is the browsable
-- storefront he says will never exist. The gate itself was correct and is
-- reused here unchanged in spirit -- it is simply asked at the link instead of
-- in a menu.
--
-- THE RULES, in his words:
--
--   "Imagine me sending this link to a complete stranger by accident. They
--    don't have a username or password. They automatically can't see it."
--   "Let's say a tier four got one of those links, and this is a tier two.
--    They don't get access to it either. Only the right tier and above."
--   "The wholesaler should have the ability to toggle on or off the publicness
--    of this catalog... anyone can go in, anyone can see it, anyone can make an
--    order, and the second they click order they just have to put in their name
--    and phone number."
--
-- WHY ONE FUNCTION RETURNS A STATUS INSTEAD OF ROWS-OR-NOTHING
-- ------------------------------------------------------------
-- The app has four genuinely different things to say -- log in / you are not
-- allowed / this link is dead / here it is -- and an empty result set can only
-- say one of them. Returning a status lets the person holding a real link be
-- asked to log in, instead of being told the link is broken.
--
-- "not_found" deliberately covers BOTH a made-up token and a switched-off
-- catalog. A dead link must not confirm that it was ever alive.
--
-- What a link leaks, decided rather than defaulted: a private catalog is not
-- NAMED to anyone who has not logged in, because a forwarded link would
-- otherwise tell a stranger what this wholesaler sells. The WHOLESALER is
-- named, because someone being asked to log in has to know whose login.
--
-- pgcrypto lives in the `extensions` schema on Supabase and is not on the
-- search_path, so gen_random_bytes is qualified. Unqualified, the column
-- default would fail at INSERT time rather than here, which is a much worse
-- place to discover it.
-- =============================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_catalogs
  add column if not exists share_token text,
  add column if not exists is_public boolean not null default false;

update wholesale_v2.v2_catalogs
   set share_token = encode(extensions.gen_random_bytes(12), 'hex')
 where share_token is null;

alter table wholesale_v2.v2_catalogs
  alter column share_token set not null,
  alter column share_token set default encode(extensions.gen_random_bytes(12), 'hex');

create unique index if not exists v2_catalogs_share_token_uq
  on wholesale_v2.v2_catalogs (share_token);

comment on column wholesale_v2.v2_catalogs.share_token is
  'The unguessable part of this catalog link. 96 bits of randomness, hex, URL-safe. Rotating it kills every link already sent.';
comment on column wholesale_v2.v2_catalogs.is_public is
  'When true the link needs no account: anyone holding it can browse and order, giving only a name and phone at checkout. When false the link asks for a login and the tier still decides.';

grant select (share_token, is_public) on wholesale_v2.v2_catalogs to authenticated;
grant insert (share_token, is_public) on wholesale_v2.v2_catalogs to authenticated;
grant update (share_token, is_public) on wholesale_v2.v2_catalogs to authenticated;

create or replace function wholesale_v2.v2_catalog_by_token(
  p_token text,
  p_account_id uuid default null
)
returns table (
  status text, id uuid, name text, description text, wid text,
  is_public boolean, access_tier smallint, wholesaler_name text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_cat  wholesale_v2.v2_catalogs%rowtype;
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
  v_tier smallint;
  v_wname text;
begin
  select * into v_cat from wholesale_v2.v2_catalogs c
   where c.share_token = p_token and c.active;

  if v_cat.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, null::text;
    return;
  end if;

  select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_cat.wid;

  if v_cat.is_public then
    return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                        v_cat.is_public, v_cat.access_tier, v_wname;
    return;
  end if;

  if p_account_id is null then
    return query select 'login_required'::text, null::uuid, null::text, null::text, v_cat.wid,
                        false, v_cat.access_tier, v_wname;
    return;
  end if;

  select * into v_acct from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id and a.role in ('buyer','sales') and a.active;

  -- Wrong wholesaler and wrong tier give the SAME answer. Telling someone
  -- which of the two it was would let them map out whose catalog this is.
  if v_acct.id is null or v_acct.wid is distinct from v_cat.wid then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, v_wname;
    return;
  end if;

  select c.access_tier into v_tier from wholesale_v2.v2_clients c where c.id = v_acct.client_id;
  v_tier := coalesce(v_tier, 1);

  if v_tier < v_cat.access_tier then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, v_wname;
    return;
  end if;

  return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                      v_cat.is_public, v_cat.access_tier, v_wname;
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_by_token(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_by_token(text, uuid) to anon, authenticated;

create or replace function wholesale_v2.v2_catalog_products_by_token(
  p_token text,
  p_account_id uuid default null
)
returns table (product_id uuid, sort_order int)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_cat_id uuid;
begin
  -- The gate is re-applied here rather than trusted from the caller having
  -- resolved the token. A caller that skipped straight to this function would
  -- otherwise walk in.
  select r.id into v_cat_id
    from wholesale_v2.v2_catalog_by_token(p_token, p_account_id) r
   where r.status = 'ok';

  if v_cat_id is null then
    return;
  end if;

  return query
  select cp.product_id, cp.sort_order
    from wholesale_v2.v2_catalog_products cp
    join wholesale_v2.v2_products p on p.id = cp.product_id
   where cp.catalog_id = v_cat_id and not p.archived
   order by cp.sort_order, cp.added_at;
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_products_by_token(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_products_by_token(text, uuid) to anon, authenticated;
