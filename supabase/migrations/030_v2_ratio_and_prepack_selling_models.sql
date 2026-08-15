-- Back-filled 15 Aug 2026 from the live database (project olaipgdckbgjediddloj).
-- Applied live 2026-08-15 (schema_migrations version 20260815152532,
-- name "v2_ratio_and_prepack_selling_models"); never previously saved as a repo
-- file. Exported verbatim so the repo can rebuild the database from scratch.

-- Migration 030: make 'ratio' and 'prepack' real, the same way 029 did 'series'.
--
-- Values taken from v1's working source, not invented:
--   app/index.html:469  RATIO_CURVE = {36:2, 38:3, 40:5, 42:2}
--   app/index.html:468  PACK_UNIT   = 12
--   app/index.html:5624 ratioOf(p,sz) = p.ratio[sz] || RATIO_CURVE[sz] || 1
-- Those agree: 2+3+5+2 = 12. A prepack carton IS the ratio curve for one colour.
--
-- Difference between the two models:
--   prepack — a fixed carton of ONE colour; buy N cartons.
--   ratio   — same per-colour composition, buyer chooses which colours.
-- Both are therefore expressible as one generated pack PER COLOUR, which means
-- they inherit migration 028's server-side pack validation and add no new way
-- to get stock or minimums wrong.
--
-- Deliberate simplification, recorded rather than hidden: v1's ratio mode also
-- let a buyer switch individual SIZES off within the curve. That is not carried
-- over. A ratio pack here is the whole curve for a chosen colour. Restoring
-- per-size toggles is a later refinement, not a silent omission.

-- 1. The curve becomes editable data on the product instead of a constant
--    buried in a 6000-line HTML file.
alter table wholesale_v2.v2_products
  add column if not exists ratio_curve jsonb;

comment on column wholesale_v2.v2_products.ratio_curve is
  'Units per size in one pack, e.g. {"36":2,"38":3,"40":5,"42":2}. Seeded from '
  'v1 RATIO_CURVE; sizes absent from the curve default to 1. Editable per product.';

update wholesale_v2.v2_products p
   set ratio_curve = (
     select jsonb_object_agg(sz, coalesce((('{"36":2,"38":3,"40":5,"42":2}'::jsonb)->>sz)::int, 1))
       from (select distinct v.extra_attrs->>'size' sz
               from wholesale_v2.v2_product_variants v
              where v.product_id = p.id and not v.archived) s)
 where p.selling_model in ('ratio','prepack')
   and p.ratio_curve is null;

-- 2. Allow packs to record which model generated them.
alter table wholesale_v2.v2_pack_definitions
  drop constraint if exists v2_pack_definitions_source_check;
alter table wholesale_v2.v2_pack_definitions
  add constraint v2_pack_definitions_source_check
  check (source in ('manual', 'suggested', 'series', 'ratio', 'prepack'));

-- 3. One pack per colour for every ratio/prepack product. Idempotent.
insert into wholesale_v2.v2_pack_definitions (product_id, wid, name, color, source)
select p.id, p.wid,
       p.name || ' — ' || c.colour || ' pack',
       c.colour,
       p.selling_model
  from wholesale_v2.v2_products p
  join lateral (
    select distinct v.extra_attrs->>'color' as colour
      from wholesale_v2.v2_product_variants v
     where v.product_id = p.id and not v.archived
  ) c on true
 where p.selling_model in ('ratio','prepack')
   and not p.archived
   and not exists (
     select 1 from wholesale_v2.v2_pack_definitions d
      where d.product_id = p.id and d.color = c.colour
        and d.source in ('ratio','prepack') and not d.archived);

insert into wholesale_v2.v2_pack_components (pack_id, variant_id, qty_per_pack)
select d.id, v.id,
       coalesce((p.ratio_curve->>(v.extra_attrs->>'size'))::int, 1)
  from wholesale_v2.v2_pack_definitions d
  join wholesale_v2.v2_products p on p.id = d.product_id
  join wholesale_v2.v2_product_variants v
    on v.product_id = d.product_id
   and not v.archived
   and v.extra_attrs->>'color' = d.color
 where d.source in ('ratio','prepack') and not d.archived
   and not exists (
     select 1 from wholesale_v2.v2_pack_components c
      where c.pack_id = d.id and c.variant_id = v.id);

-- 4. Enforce all four models, not just series.
create or replace function wholesale_v2.v2_enforce_selling_model(
  p_product_id uuid, p_has_pack_line boolean, p_product_name text
) returns void
language plpgsql
set search_path = wholesale_v2
as $$
declare
  v_model text;
begin
  select selling_model into v_model from v2_products where id = p_product_id;

  if v_model = 'series' and not p_has_pack_line then
    raise exception
      '"%" is sold as a full series -- every colour and size together. Add it as a series rather than as individual sizes.',
      p_product_name;
  end if;

  if v_model = 'prepack' and not p_has_pack_line then
    raise exception
      '"%" is sold in fixed cartons. Choose a colour and a number of cartons rather than individual sizes.',
      p_product_name;
  end if;

  if v_model = 'ratio' and not p_has_pack_line then
    raise exception
      '"%" is sold in ratio packs -- the size mix is set by the wholesaler. Choose a colour and a number of packs rather than individual sizes.',
      p_product_name;
  end if;
end;
$$;
