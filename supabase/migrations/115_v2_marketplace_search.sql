-- =============================================================================
-- 115 — MARKETPLACE SEARCH
-- =============================================================================
-- Hadi, 1 Sep 2026: "At the top, there's just going to be a search bar, a
-- normal search bar that shows them, that gives them the ability to decide,
-- I want a product or I want a wholesaler or a brand or whatever."
--
-- The WHOLESALER half of that already exists: v2_directory_list takes a
-- p_search and answers "every active wholesaler, by name, and whether you are
-- in". This migration is the PRODUCT half, and nothing else.
--
-- A NEW FUNCTION, NOT A NEW ARGUMENT ON v2_marketplace_feed.
-- ---------------------------------------------------------
-- Migration 113 added p_sort to the feed with a default, which created a
-- SECOND overload rather than replacing the first; PostgREST refused both with
-- PGRST203 and the live feed broke until 114 dropped the old signature. The
-- lesson is written down in CLAUDE.md and it is obeyed here: a defaulted
-- argument is a new function, so if a new function is what you want, write one.
--
-- THE SCOPE IS THE FEED'S SCOPE, WORD FOR WORD.
-- Public catalogues of active wholesalers. Not "stores you belong to" — that
-- is v2_search_products and it must stay a different question, for the reason
-- written at the top of 112: the day the two share a definition, widening one
-- silently widens the other. The `access` column says whether you may BUY;
-- it does not decide what you may find.
--
-- A REFERENCE IS A SEARCH TERM.
-- Wholesale buyers quote references, not names — "send me 12 of C-117" is how
-- the order gets placed. So source_ref is matched, and matched FIRST: an exact
-- reference is the least ambiguous thing anybody can type into this box, and
-- it should land on one product rather than somewhere in a list of forty.
--
-- ADVERTISING DOES NOT JUMP THE QUEUE HERE, AND THAT IS DELIBERATE.
-- The feed reserves a share of every page for paid placement, because a feed
-- is a shelf OGGI arranges. A search is a question the buyer asked, and
-- answering it with a paid result first is a different product decision that
-- nobody has taken. is_promoted still rides along so the tile can print
-- "Sponsored" when a match happens to be promoted; it changes no ordering.
--
-- RANKING, in bands, so ties never fall back on physical row order:
--   0  exact reference          C-117
--   1  name starts with         "Byblos…" for "byb"
--   2  name contains
--   3  category or reference contains
-- then wholesaler name, then product id, so paging is stable.
-- =============================================================================

create or replace function wholesale_v2.v2_marketplace_search(
  p_account_id uuid default null,
  p_query text default null,
  p_limit integer default 40,
  p_offset integer default 0)
returns table(
  product_id uuid, product_name text, category text,
  wid text, wholesaler_name text, wholesaler_logo text,
  image_url text, price_from numeric, currency text,
  access text, is_promoted boolean, slot text)
language plpgsql
stable
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_person uuid;
  v_mine   text[] := '{}';
  v_q      text;
  v_like   text;
begin
  if p_limit is null or p_limit < 1 then p_limit := 40; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  v_q := btrim(coalesce(p_query, ''));
  -- An empty query returns NO ROWS rather than the whole marketplace. The feed
  -- is what answers "show me everything"; a search box that silently becomes a
  -- browse when you clear it makes the two indistinguishable on screen.
  if v_q = '' then return; end if;

  -- LIKE metacharacters are escaped rather than passed through. A buyer typing
  -- "50% cotton" means the three characters, not "match anything"; unescaped,
  -- a lone % returned the entire marketplace and a lone _ matched every
  -- one-character difference. Nothing crosses a privacy boundary either way —
  -- the scope is the public feed's scope — but a search box whose results do
  -- not correspond to what was typed is a search box nobody trusts twice.
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  -- Signed out is a legitimate state here, exactly as in the feed.
  if p_account_id is not null then
    select a.person_id into v_person
      from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;
    select coalesce(array_agg(distinct x), '{}') into v_mine
      from (select m.wid as x
              from wholesale_v2.v2_person_memberships m
             where v_person is not null and m.person_id = v_person and m.active
            union
            select a.wid from wholesale_v2.v2_portal_accounts a where a.id = p_account_id) s;
  end if;

  return query
  with eligible as (
    select distinct p.id, p.name, p.category, p.wid, p.source_ref
      from wholesale_v2.v2_products p
      join wholesale_v2.v2_catalog_products cp on cp.product_id = p.id
      join wholesale_v2.v2_catalogs c on c.id = cp.catalog_id
      join public.wholesalers w on w.wid = p.wid
     where c.is_public
       and w.active
       and coalesce(p.archived, false) = false
       and (
            upper(btrim(coalesce(p.source_ref, ''))) = upper(v_q)
         or p.name     ilike '%' || v_like || '%'
         or p.category ilike '%' || v_like || '%'
         or coalesce(p.source_ref, '') ilike '%' || v_like || '%'
       )
  ),
  shaped as (
    select
      e.id as product_id, e.name as product_name, e.category, e.wid,
      coalesce(nullif(btrim(w.name), ''), w.brand, e.wid) as wholesaler_name,
      w.logo as wholesaler_logo,
      (select coalesce(v.image_url, v.images->>0)
         from wholesale_v2.v2_product_variants v
        where v.product_id = e.id
          and coalesce(v.image_url, v.images->>0) is not null
        limit 1) as image_url,
      (select min(v.price) from wholesale_v2.v2_product_variants v
        where v.product_id = e.id and v.price is not null) as price_from,
      coalesce(w.currency, '$') as currency,
      case when e.wid = any(v_mine) then 'member' else 'none' end as access,
      exists (select 1 from wholesale_v2.v2_oggi_promoted op
               where op.product_id = e.id and op.active) as is_promoted,
      case
        when upper(btrim(coalesce(e.source_ref, ''))) = upper(v_q) then 0
        when e.name ilike v_like || '%'                            then 1
        when e.name ilike '%' || v_like || '%'                     then 2
        else 3
      end as band
      from eligible e
      join public.wholesalers w on w.wid = e.wid
  )
  select s.product_id, s.product_name, s.category, s.wid, s.wholesaler_name,
         s.wholesaler_logo, s.image_url, s.price_from, s.currency,
         s.access, s.is_promoted, 'organic'::text as slot
    from shaped s
   order by s.band, s.wholesaler_name, s.product_name, s.product_id
   limit p_limit offset p_offset;
end;
$function$;

grant execute on function wholesale_v2.v2_marketplace_search(uuid, text, integer, integer) to anon, authenticated;
