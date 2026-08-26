-- ============================================================================
-- check_anon_grants.sql — Batch S, gate S7.
--
-- THE QUESTION: "does the anon role still hold a key to any table in this
-- schema, or a standing rule that will hand it one tomorrow?"
--
-- These are the same assertions migration 085 runs on itself, lifted out so
-- they can be asked again -- next week, after the next migration, on any
-- database -- without re-running the revoke. That separation is the point: an
-- assertion that lives only inside the statement that satisfies it can never
-- fail, because the fix always runs first. Run 085's copy to prove the change
-- landed; run THIS one to prove it is still true.
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_anon_grants.sql <db>
-- Silence and exit 0 is a pass. Any violation raises and exits non-zero.
--
-- RED PROOF -- every one of these was run against a PASSING database and made
-- this file raise, then undone. A check nobody has seen fail is not a check.
--   grant select on wholesale_v2.v2_products to anon;                 -> fires
--   grant select (price) on wholesale_v2.v2_product_variants to anon; -> fires
--   grant select on wholesale_v2.v2_inventory_by_variant to anon;     -> fires
--   grant usage on sequence wholesale_v2.<any> to anon;               -> fires
--   alter default privileges in schema wholesale_v2
--     grant select on tables to anon;                                 -> fires
--   grant execute on wholesale_v2.v2_catalog_discount_pct to anon;    -> fires
--   grant select on wholesale_v2.v2_products to public;               -> fires
--   revoke execute on wholesale_v2.v2_catalog_read from anon;         -> fires
--
-- The column case is the one that matters most and was found last: the first
-- draft of this file read only pg_class.relacl, and a deliberate
-- `grant select (price) ... to anon` sailed straight past it. Column grants
-- live in pg_attribute.attacl, and migration 032 uses exactly that form.
--
-- PAIR WITH check_anon_scope.sh, which asks the live REST endpoint the same
-- question from outside. This file reads the catalog; that one reads the door.
-- A grant can be absent here and the door still open through a definer
-- function that forgot its gate, so neither replaces the other.
-- ============================================================================

do $$
declare
  leftover text;
begin
  -- Two catalogs, not one. A table-level grant lands in pg_class.relacl; a
  -- COLUMN-level grant lands in pg_attribute.attacl and is INVISIBLE to
  -- relacl. That is not a hypothetical: 032 revoked table SELECT on
  -- v2_product_variants and granted fourteen columns back instead, so a check
  -- that reads only relacl would have called this schema clean while every
  -- price, sku and barcode was still readable by a stranger. It was written
  -- that way first, and only a deliberate `grant select (price) ... to anon`
  -- against a passing database exposed it.
  select string_agg(x.label, ', ' order by x.label) into leftover from (
    select format('%s(%s)', c.relname, c.relacl::text) as label
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2'
       and c.relkind in ('r','p','v','m','f','S')
       and c.relacl::text like '%anon=%'
    union all
    select format('%s.%s [column] (%s)', c.relname, a.attname, a.attacl::text)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2'
       and a.attnum > 0 and not a.attisdropped
       and a.attacl::text like '%anon=%'
  ) x;

  if leftover is not null then
    raise exception 'S7 DID NOT LAND: anon still holds privileges on %', leftover;
  end if;
end $$;

-- PUBLIC is anon's back door: a grant to PUBLIC is a grant to every role,
-- including anon, and it does not show up as `anon=` in relacl. This project
-- has none today. If production has one, this migration must NOT report
-- success -- but it must not revoke it blind either, because `authenticated`
-- may be leaning on the same grant and the wholesaler app would go dark.
-- Raise, and let a human decide.
do $$
declare
  leftover text;
begin
  select string_agg(c.relname || ' ' || c.relacl::text, ', ' order by c.relname)
    into leftover
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'wholesale_v2'
     and c.relkind in ('r','p','v','m','f','S')
     and c.relacl::text ~ '(^\{|,)=[a-zA-Z]+/';

  if leftover is not null then
    raise exception 'S7 INCOMPLETE: these objects are granted to PUBLIC, which reaches anon: %', leftover;
  end if;
end $$;

do $$
declare
  leftover text;
begin
  select string_agg(d.defaclobjtype::text || ':' || d.defaclacl::text, ', ')
    into leftover
    from pg_default_acl d
   where d.defaclnamespace = 'wholesale_v2'::regnamespace
     and d.defaclacl::text like '%anon=%';

  if leftover is not null then
    raise exception 'S7 DID NOT LAND: the default privileges still open new objects to anon: %', leftover;
  end if;
end $$;

do $$
begin
  if has_function_privilege('anon', 'wholesale_v2.v2_catalog_discount_pct(uuid, uuid)', 'execute') then
    raise exception 'S7 DID NOT LAND: anon can still execute the ungated v2_catalog_discount_pct';
  end if;

  -- and the other direction: the gated replacements must still be reachable,
  -- or S7 has shut the shop rather than the door.
  if not has_function_privilege('anon', 'wholesale_v2.v2_buyer_discount_pct(uuid, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_token_discount_pct(text, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_catalog_read(text, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_buyer_catalog_read(uuid, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_buyer_list_prices(uuid, uuid[])', 'execute')
  then
    raise exception 'S7 OVERSHOT: a gated buyer function is no longer executable by anon';
  end if;
end $$;
