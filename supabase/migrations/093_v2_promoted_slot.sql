-- =============================================================================
-- 093 — THE PROMOTED SLOT                            SR-02, SR-03, 29 Aug 2026
-- =============================================================================
--
-- OGGI earns a commission on certain products it sells on behalf of the
-- wholesalers who own them. OGGI builds nothing itself. So "an OGGI product"
-- is not a brand -- it is a COMMERCIAL ARRANGEMENT ON SOMEONE ELSE'S PRODUCT,
-- and this file models it that way: a promotion is a row about a product, with
-- a rate and a date, owned by the platform, never a column pretending the
-- product belongs to us.
--
-- ==== SR-03 IS THE WHOLE POINT OF THIS FILE, AND IT IS A CONSTRAINT ========
--
-- The obvious way to favour a product is to add weight to it inside the
-- ranking. That is what every marketplace that has since been fined for
-- self-preferencing did. It is attractive precisely because it is invisible:
-- nobody can see a thumb on the scale from the outside, including the person
-- who put it there, six months later.
--
-- So promotion here CANNOT touch the organic ranking. It cannot, not
-- "should not": promoted products are selected by a SEPARATE query into a
-- SEPARATE, BOUNDED, LABELLED slot, and the organic result set is computed by
-- the same code as before, with promotion playing no part in it whatsoever.
--
-- The gate states this as a property rather than an intention:
--
--     turning every promotion off must not change the organic ordering AT ALL
--
-- That is checkable, and it is checked. If someone later "optimises" this by
-- folding promotion into the rank, that assertion goes red.
--
-- WHY BOUNDED
-- Three. Not "a few", not a percentage. A slot whose size floats with how many
-- products OGGI has arranged commission on is a slot that grows quietly until
-- it is the whole page. A fixed cap is the difference between a shelf and a
-- takeover, and a wholesaler can be told what it is.
--
-- WHY LABELLED
-- SR-05 says the preference is published. The database half of that is that
-- every promoted row is FLAGGED as promoted in the answer, so the screen
-- cannot present it as an ordinary result even by accident. A gate asserts the
-- flag exists; the DOM gate asserts it is rendered.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- It does not read anything about how well a wholesaler's own products sell.
-- SR-04 is a hard data wall: wholesaler sales data must never inform OGGI's
-- commercial decisions. Nothing here queries v2_orders, and nothing should.
-- =============================================================================

create table if not exists wholesale_v2.v2_oggi_promoted (
  product_id      uuid primary key references wholesale_v2.v2_products(id) on delete cascade,
  commission_pct  numeric(5,2),
  active          boolean not null default true,
  note            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists v2_oggi_promoted_active_idx
  on wholesale_v2.v2_oggi_promoted (active) where active;

comment on table wholesale_v2.v2_oggi_promoted is
  'Products OGGI has a commission arrangement on. A ROW ABOUT SOMEONE ELSE''S PRODUCT, not a claim of ownership -- OGGI builds nothing. Deliberately holds the rate and the date, which a boolean column on v2_products could not, and keeps the arrangement out of the wholesaler''s own table where they would see and could edit it.';
comment on column wholesale_v2.v2_oggi_promoted.commission_pct is
  'What OGGI earns. Recorded here so the commercial arrangement is a fact in the database rather than an understanding in someone''s head. NEVER returned to a buyer.';

alter table wholesale_v2.v2_oggi_promoted enable row level security;
drop policy if exists v2_oggi_promoted_owner on wholesale_v2.v2_oggi_promoted;
create policy v2_oggi_promoted_owner on wholesale_v2.v2_oggi_promoted for all
  using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());
grant select, insert, update, delete on wholesale_v2.v2_oggi_promoted to authenticated;
-- anon gets nothing, as since 085. A buyer reaches a promotion only as a
-- FLAG on a search result, never as a readable arrangement.

-- ============================================================== the search ===
-- Extends 092. The organic half is byte-for-byte the same query it was; the
-- promoted half is bolted on beside it and cannot reach into it.
-- The return type gains two columns, and Postgres will not widen one in
-- place: `create or replace` fails with "cannot change return type of
-- existing function". Dropping first is therefore required, not tidy-
-- mindedness -- and it drops the grants with it, which is why every grant
-- is re-issued below rather than assumed to have survived.
drop function if exists wholesale_v2.v2_search_products(uuid, text, integer, integer);

create function wholesale_v2.v2_search_products(
  p_account_id uuid,
  p_q          text,
  p_limit      integer default 30,
  p_offset     integer default 0
)
returns table (
  product_id       uuid,
  product_name     text,
  category         text,
  wid              text,
  wholesaler_name  text,
  image_url        text,
  price_from       numeric,
  currency         text,
  is_promoted      boolean,
  slot             text
)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wids   text[];
  v_norm   text;
  v_found  int;
  PROMO_CAP constant int := 3;   -- fixed. See the header on why not a percentage.
begin
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;
  end if;

  v_norm := wholesale_v2.v2_search_normalise(p_q);
  if length(v_norm) < 2 then
    return;
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  select array_agg(distinct x) into v_wids from (
    select m.wid as x
      from wholesale_v2.v2_person_memberships m
     where v_person is not null and m.person_id = v_person and m.active
    union
    select a.wid from wholesale_v2.v2_portal_accounts a where a.id = p_account_id
  ) s;

  if v_wids is null or array_length(v_wids, 1) is null then
    return;
  end if;

  if p_limit is null or p_limit < 1 then p_limit := 30; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  create temporary table if not exists tmp_search_hits (
    product_id uuid, product_name text, category text, wid text,
    wholesaler_name text, image_url text, price_from numeric, currency text,
    rank int
  ) on commit drop;
  delete from tmp_search_hits;

  -- ---- THE ORGANIC SET. Unchanged from 092. Promotion is not mentioned. ----
  insert into tmp_search_hits
  select
    p.id, p.name, p.category, p.wid,
    coalesce(nullif(btrim(w.name), ''), w.brand, p.wid),
    (select coalesce(v.image_url, v.images->>0)
       from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and coalesce(v.image_url, v.images->>0) is not null
      limit 1),
    (select min(v.price) from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and v.price is not null),
    coalesce(w.currency, '$'),
    case
      when wholesale_v2.v2_search_normalise(p.name) like '%' || v_norm || '%' then 0
      when wholesale_v2.v2_search_normalise(coalesce(p.category,'')) like '%' || v_norm || '%' then 1
      else 2
    end
  from wholesale_v2.v2_products p
  join public.wholesalers w on w.wid = p.wid
  where p.wid = any(v_wids)
    and coalesce(p.archived, false) = false
    and w.active
    and (
         wholesale_v2.v2_search_normalise(p.name) like '%' || v_norm || '%'
      or wholesale_v2.v2_search_normalise(coalesce(p.category, '')) like '%' || v_norm || '%'
      or exists (
           select 1 from wholesale_v2.v2_product_variants v
            where v.product_id = p.id
              and wholesale_v2.v2_search_normalise(coalesce(v.sku, '')) like '%' || v_norm || '%'
         )
    );

  select count(*) into v_found from tmp_search_hits;

  if v_found = 0 then
    insert into wholesale_v2.v2_search_misses (person_id, q_raw, q_normalised, wids)
    values (v_person, left(coalesce(p_q, ''), 200), v_norm, v_wids);
    return;
  end if;

  -- ---- THE PROMOTED SLOT. A separate, capped, labelled selection. ----------
  -- Note what is NOT here: any write to tmp_search_hits, and any change to the
  -- rank column. The organic ordering below cannot see this query.
  return query
  select t.product_id, t.product_name, t.category, t.wid, t.wholesaler_name,
         t.image_url, t.price_from, t.currency,
         true as is_promoted, 'promoted'::text as slot
    from tmp_search_hits t
    join wholesale_v2.v2_oggi_promoted op
      on op.product_id = t.product_id and op.active
   order by t.rank, t.product_name
   limit PROMO_CAP;

  -- ---- THE ORGANIC RESULTS, ordered exactly as 092 ordered them. ----------
  -- Promoted products still appear here, in their honest position. They are
  -- not removed: hiding a product from the organic list because it is promoted
  -- would ALSO be a distortion, just in the other direction, and it would make
  -- the shelf a substitute for the results rather than an addition to them.
  return query
  select t.product_id, t.product_name, t.category, t.wid, t.wholesaler_name,
         t.image_url, t.price_from, t.currency,
         exists (select 1 from wholesale_v2.v2_oggi_promoted op2
                  where op2.product_id = t.product_id and op2.active) as is_promoted,
         'organic'::text as slot
    from tmp_search_hits t
   order by t.rank, t.product_name, t.wholesaler_name
   limit p_limit offset p_offset;
end;
$fn$;

revoke all on function wholesale_v2.v2_search_products(uuid, text, integer, integer) from public;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to anon;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to authenticated;

comment on function wholesale_v2.v2_search_products(uuid, text, integer, integer) is
  'SR-01/02/03. Products across the stores this buyer belongs to. Promoted products are returned in a SEPARATE, CAPPED (3), FLAGGED slot; the organic set is computed and ordered without reference to promotion at all, so turning every promotion off cannot change the organic ordering -- which is exactly what checks/check_promoted_slot.sql asserts. Never returns commission_pct.';

-- =============================================================================
-- SELF-ASSERTING.
-- =============================================================================
do $$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema='wholesale_v2' and table_name='v2_oggi_promoted';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: v2_oggi_promoted was not created'; end if;

  -- The commission rate is OGGI's business and no buyer's.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and (pg_get_function_result(p.oid) ilike '%commission%'
       or p.prosrc ilike '%commission_pct%');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: search touches commission_pct -- what OGGI earns on a product is not a buyer''s business, and would tell them which results are paid for in a way the label does not'; end if;

  -- anon must not be able to read the arrangement itself.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_oggi_promoted' and grantee='anon';
  if n <> 0 then raise exception 'ASSERT 3 FAILED: anon holds % grant(s) on the promotion table', n; end if;

  -- The answer must be able to say which rows are promoted.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and pg_get_function_result(p.oid) ilike '%is_promoted%';
  if n <> 1 then raise exception 'ASSERT 4 FAILED: the answer cannot distinguish a promoted result, so a screen could present one as ordinary'; end if;

  -- SR-04, the data wall, stated mechanically: promotion must not consult orders.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and p.prosrc ilike '%v2_orders%';
  if n <> 0 then raise exception 'ASSERT 5 FAILED: search reads v2_orders -- SR-04 is a hard wall between wholesaler sales data and OGGI''s commercial decisions'; end if;

  raise notice '093 OK: promotion is a separate capped labelled slot; the organic set never mentions it; commission is never returned; orders are never read.';
end $$;
