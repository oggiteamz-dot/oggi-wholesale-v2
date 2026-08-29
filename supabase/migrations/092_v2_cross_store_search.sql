-- =============================================================================
-- 092 — SEARCH ACROSS THE STORES YOU ACTUALLY HAVE   SR-01, SR-10, 29 Aug 2026
-- =============================================================================
--
-- "Find me black denim" -- across every wholesaler this buyer can enter, and
-- across NONE that they cannot. That second half is the whole feature.
--
-- WHY THIS IS THE MOST DANGEROUS FUNCTION IN THE SCHEMA SO FAR
--
-- The directory (091) shows a name and a category for businesses that have not
-- let the buyer in. This one returns PRODUCTS AND PRICES. Every previous
-- buyer-facing read was scoped to a single store the buyer was already inside;
-- this one deliberately reaches across many. So the scoping is not a filter
-- applied at the end -- it is the first thing computed, from the caller's own
-- membership rows, and nothing the caller says can widen it:
--
--   * there is NO wid argument. The caller cannot name a store.
--   * the store set comes from v2_person_memberships WHERE active, resolved
--     from the account id inside this function.
--   * an account that cannot be verified gets zero rows, not an error.
--
-- GP-04 says wholesale price must never leak to someone without access. Here
-- the buyer HAS access to every store in the result by construction, which is
-- what makes returning a price legitimate at all.
--
-- WHY "PRICE FROM" AND NOT THE EXACT PRICE
--
-- A buyer's real price depends on their client record in that specific store --
-- discount_pct, quantity tiers, catalogue overrides. Computing it per row here
-- would be both slow and, worse, occasionally WRONG in a place the buyer reads
-- as a promise. So search returns the lowest listed price for the product in
-- that store and says nothing more; the exact price is what the product card
-- shows when they open it, through the same v2_effective_unit_price the order
-- actually uses. A search result that under-promises and is then confirmed is
-- honest. One that quotes a price the order does not honour is a complaint.
--
-- WHY THE NORMALISATION IS HAND-WRITTEN AND NOT AN EXTENSION
--
-- Production has neither `unaccent` nor `pg_trgm`. Adding an extension to a
-- live database is a bigger decision than this feature warrants, and it would
-- make the migration unreplayable anywhere that lacks it. The rules below are
-- small, explicit and testable, and they cover what actually breaks search in
-- this market: Arabic diacritics that buyers omit, the four forms of alef, teh
-- marbuta vs heh, and alef maqsura vs yeh. A shop owner typing "قميص" must find
-- "قَمِيص", and today does not.
--
-- SR-08 (full Arabic + Latin + Arabizi multi-subfield indexing) is a larger
-- piece of work and is NOT claimed here. This is the honest subset: script-
-- aware normalisation on both sides of the comparison.
-- =============================================================================

-- ---------------------------------------------------- text normalisation --
create or replace function wholesale_v2.v2_search_normalise(p_text text)
returns text
language plpgsql
immutable
set search_path = wholesale_v2, public
as $fn$
declare v text;
begin
  v := lower(btrim(coalesce(p_text, '')));
  if v = '' then return ''; end if;

  -- ORDER MATTERS, AND THIS ORDER IS THE FIX FOR A REAL BUG.
  -- Arabic-Indic digits are folded FIRST, before anything is stripped.
  -- The first version of this function stripped diacritics first, using the
  -- range [U+0610-U+0670]. That range SPANS U+0660-U+0669 -- the Arabic-Indic
  -- digits -- so a query of ٣ was deleted entirely before it could ever be
  -- converted to 3. Production's own self-assertion caught it and refused the
  -- migration; the local replay had passed it. Folding the digits first makes
  -- the result correct no matter how the class below is interpreted.
  v := translate(v, '٠١٢٣٤٥٦٧٨٩', '0123456789');

  -- Diacritics (tashkeel), ENUMERATED rather than given as a range. A range
  -- is a compact way to write a set whose membership you have not checked,
  -- and the bug above is exactly what that costs. These are the marks that
  -- actually appear in product names; every one is listed.
  v := regexp_replace(v, '[ًٌٍَُِّْٰٕٓٔ]', '', 'g');
  -- Tatweel, the decorative stretch character. Never semantic.
  v := replace(v, 'ـ', '');
  -- The four alefs are one letter to a person typing quickly.
  v := regexp_replace(v, '[آأإٱ]', 'ا', 'g');
  -- Teh marbuta and heh are interchanged constantly in informal typing.
  v := replace(v, 'ة', 'ه');
  -- Alef maqsura -> yeh, same reason.
  v := replace(v, 'ى', 'ي');

  -- Punctuation and separators become spaces: "t-shirt" must find "t shirt".
  v := regexp_replace(v, '[^[:alnum:]؀-ۿ]+', ' ', 'g');
  v := btrim(regexp_replace(v, '\s+', ' ', 'g'));
  return v;
end;
$fn$;

comment on function wholesale_v2.v2_search_normalise(text) is
  'Applied to BOTH the query and the searched text, so the comparison is symmetric. Strips Arabic diacritics and tatweel, folds the four alef forms, teh marbuta to heh, alef maqsura to yeh, Arabic-Indic digits to ASCII, and punctuation to spaces. Not an extension: production has neither unaccent nor pg_trgm, and a migration that cannot replay without one is a migration that cannot be verified.';

-- ------------------------------------------- searches that found nothing --
-- SR-10: log every zero-result query FROM DAY ONE. The queries a catalogue
-- cannot answer are the highest-value list in the product -- they are buyers
-- telling you, in their own words, what they came for and did not find. It
-- costs one insert and it cannot be reconstructed retroactively.
create table if not exists wholesale_v2.v2_search_misses (
  id           bigserial primary key,
  person_id    uuid references wholesale_v2.v2_people(id) on delete set null,
  q_raw        text not null,
  q_normalised text not null,
  wids         text[],
  created_at   timestamptz not null default now()
);

create index if not exists v2_search_misses_norm_idx
  on wholesale_v2.v2_search_misses (q_normalised, created_at desc);

comment on table wholesale_v2.v2_search_misses is
  'SR-10. Every search that returned nothing, with the stores it looked in. Deliberately keeps the RAW query as well as the normalised one: when a normalisation rule is later found wrong, the raw text is the only way to tell a bad rule from a genuinely absent product. Owner-only.';

alter table wholesale_v2.v2_search_misses enable row level security;
drop policy if exists v2_search_misses_owner on wholesale_v2.v2_search_misses;
create policy v2_search_misses_owner on wholesale_v2.v2_search_misses for all
  using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());
grant select on wholesale_v2.v2_search_misses to authenticated;
-- anon gets nothing, as everywhere since 085.

-- ================================================================ search ====
create or replace function wholesale_v2.v2_search_products(
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
  currency         text
)
language plpgsql
volatile                       -- it writes the miss log; see SR-10 above
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_person uuid;
  v_wids   text[];
  v_norm   text;
  v_found  int;
begin
  if p_account_id is null or not wholesale_v2.v2_account_can_act(p_account_id) then
    return;                    -- no rows. An error message is information.
  end if;

  v_norm := wholesale_v2.v2_search_normalise(p_q);
  if length(v_norm) < 2 then
    return;                    -- one character matches everything; that is not a search.
  end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = p_account_id;

  -- THE SCOPE. Computed first, from membership, before anything is searched.
  -- The buyer's own store is included even when the person layer has not
  -- caught up (person_id is nullable on purpose -- 090), so a search never
  -- silently excludes the store they are signed in to.
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

  insert into tmp_search_hits
  select
    p.id,
    p.name,
    p.category,
    p.wid,
    coalesce(nullif(btrim(w.name), ''), w.brand, p.wid),
    (select coalesce(v.image_url, v.images->>0)
       from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and coalesce(v.image_url, v.images->>0) is not null
      limit 1),
    (select min(v.price) from wholesale_v2.v2_product_variants v
      where v.product_id = p.id and v.price is not null),
    coalesce(w.currency, '$'),
    -- A name match is what the buyer meant. A category or SKU match is a
    -- fallback, and ordering says so rather than pretending they are equal.
    case
      when wholesale_v2.v2_search_normalise(p.name) like '%' || v_norm || '%' then 0
      when wholesale_v2.v2_search_normalise(coalesce(p.category,'')) like '%' || v_norm || '%' then 1
      else 2
    end
  from wholesale_v2.v2_products p
  join public.wholesalers w on w.wid = p.wid
  where p.wid = any(v_wids)          -- <<< the scope, applied in the join
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

  -- SR-10. Recorded before returning, and only when the answer was empty.
  if v_found = 0 then
    insert into wholesale_v2.v2_search_misses (person_id, q_raw, q_normalised, wids)
    values (v_person, left(coalesce(p_q, ''), 200), v_norm, v_wids);
    return;
  end if;

  return query
  select t.product_id, t.product_name, t.category, t.wid, t.wholesaler_name,
         t.image_url, t.price_from, t.currency
    from tmp_search_hits t
   order by t.rank, t.product_name, t.wholesaler_name
   limit p_limit offset p_offset;
end;
$fn$;

revoke all on function wholesale_v2.v2_search_products(uuid, text, integer, integer) from public;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to anon;
grant execute on function wholesale_v2.v2_search_products(uuid, text, integer, integer) to authenticated;

comment on function wholesale_v2.v2_search_products(uuid, text, integer, integer) is
  'SR-01. Products across every store this buyer is a member of, and no others. Takes NO wid: the store set is computed from v2_person_memberships inside the function, so there is nothing a caller can claim to widen it. Returns a "price from" rather than an exact price, because the exact one depends on the buyer''s client record in that store and a search result that quotes a price the order does not honour is a complaint.';

-- =============================================================================
-- SELF-ASSERTING.
-- =============================================================================
do $$
declare n int;
begin
  -- 1. the caller cannot name a store
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_search_products'
     and pg_get_function_identity_arguments(p.oid) ilike '%wid%';
  if n <> 0 then raise exception 'ASSERT 1 FAILED: v2_search_products takes a wid argument -- a caller could then search a store they are not in'; end if;

  -- 2. anon may search (buyers ARE anon since 085) but holds no table grant
  if not has_function_privilege('anon','wholesale_v2.v2_search_products(uuid,text,integer,integer)','execute')
    then raise exception 'ASSERT 2 FAILED: anon cannot search, so no buyer can'; end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and grantee='anon'
     and table_name in ('v2_search_misses','v2_products','v2_product_variants');
  if n <> 0 then raise exception 'ASSERT 3 FAILED: anon holds % table grant(s) around search', n; end if;

  -- 3. an unverifiable account gets nothing
  select count(*) into n from wholesale_v2.v2_search_products(
    '00000000-0000-0000-0000-000000000000'::uuid, 'shirt', 30, 0);
  if n <> 0 then raise exception 'ASSERT 4 FAILED: an unknown account searched % row(s)', n; end if;
  select count(*) into n from wholesale_v2.v2_search_products(null, 'shirt', 30, 0);
  if n <> 0 then raise exception 'ASSERT 5 FAILED: a null account searched % row(s)', n; end if;

  -- 4. normalisation is symmetric and does what it claims
  if wholesale_v2.v2_search_normalise('T-Shirt') <> 't shirt' then
    raise exception 'ASSERT 6 FAILED: punctuation is not folded to a space'; end if;
  if wholesale_v2.v2_search_normalise('  Denim   BLUE ') <> 'denim blue' then
    raise exception 'ASSERT 7 FAILED: case and whitespace are not normalised'; end if;
  if wholesale_v2.v2_search_normalise(E'قَمِيص')
     <> wholesale_v2.v2_search_normalise(E'قميص') then
    raise exception 'ASSERT 8 FAILED: Arabic diacritics are not stripped, so a buyer typing the plain word cannot find the marked one'; end if;
  if wholesale_v2.v2_search_normalise(E'أحمر')
     <> wholesale_v2.v2_search_normalise(E'احمر') then
    raise exception 'ASSERT 9 FAILED: alef forms are not folded'; end if;
  if wholesale_v2.v2_search_normalise(E'٣') <> '3' then
    raise exception 'ASSERT 10 FAILED: Arabic-Indic digits are not folded to ASCII'; end if;

  -- 5. the miss log exists and keeps the raw text
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_search_misses'
     and column_name in ('q_raw','q_normalised');
  if n <> 2 then raise exception 'ASSERT 11 FAILED: the miss log does not keep both the raw and normalised query'; end if;

  raise notice '092 OK: search is scoped by membership and takes no wid; normalisation folds Arabic marks, alef forms and digits; zero-result queries are logged.';
end $$;
