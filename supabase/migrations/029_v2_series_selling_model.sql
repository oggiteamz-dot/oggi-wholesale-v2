-- OGGI Wholesale v2 — Migration 029: make the "full series" selling model real
-- 15 Aug 2026
--
-- WHAT WAS WRONG
-- --------------
-- Every variant carries extra_attrs.sellMode, migrated faithfully from v1 by
-- migration 002 (line 191). Four values exist in the live data: open, prepack,
-- ratio, series. Only 'open' and 'prepack' are honoured by anything.
--
-- js/data/catalog.js:76 reads sellMode and maps it onto every variant object,
-- and then NO other code ever reads it again. What actually decides how a
-- product can be bought is whether a pack definition exists
-- (js/components/product-card.js:90). There were zero packs.
--
-- Result, in production: 16 variants of "Merino Crew Knit" (wid 'mg', 143
-- units) were declared "series" by their wholesaler and sold as loose open
-- stock. The instruction survived the migration, sat in the database, was
-- exposed through the API, and did nothing.
--
-- That is worse than the feature being absent, because both the data and the
-- API surface claim it is present. It is exactly the class of silent loss the
-- feature manifest exists to catch, and the check that caught it is
-- checks/check_data_invariants.sql §5.
--
-- WHAT "SERIES" MEANS — taken from v1's working source, not invented
-- ------------------------------------------------------------------
-- app/index.html:1555   pieces = series x nSizes x nColours
-- app/index.html:1598   cap    = floor( min(stock across EVERY colour) / nSizes )
-- app/index.html:1651   label  = "<n> full series"
--
-- So: a series includes EVERY colour and EVERY size. Buying N series means N
-- units of every variant of the product. The buyer does not choose colours —
-- that is the whole point of the model, and it is why v1 replaced the
-- open-stock grid entirely for a series product (index.html:1462).
--
-- HOW IT IS IMPLEMENTED — reusing machinery that already exists
-- -------------------------------------------------------------
-- A "series" is exactly a pack whose components are every live variant of the
-- product at one unit each. So this migration does not invent a parallel
-- mechanism: it generates a real v2_pack_definitions row per series product,
-- and buying N series is buying N of that pack.
--
-- That choice matters for safety: pack lines are ALREADY validated
-- server-side by migration 028 (the pack must exist, belong to this
-- wholesaler, not be archived, and the submitted quantities must equal the
-- composition x pack_qty), and that validation is already covered by 11
-- negative-tested assertions in checks/check_pack_moq.sh. Reusing it adds no
-- new way to get inventory or minimums wrong.
--
-- DELIBERATELY NOT DONE HERE
-- --------------------------
--   * 'ratio' is NOT enforced. Ratio needs a per-size ratio table (v1:
--     ratioOf(p,size), index.html:1604) and that data did not come across in
--     migration 002. Enforcing it without the ratios would be inventing the
--     wholesaler's ratios. 21 variants stay flagged red in
--     check_data_invariants.sql until the ratio data exists.
--   * 'prepack' is NOT enforced. v1 sold prepacks as whole packs of ONE
--     colour sized by a PACK_UNIT constant which also did not migrate, and
--     there are zero pack definitions for those products. Enforcing it would
--     make 32 live variants unbuyable. Flagged, not guessed.
--   * The buyer UI still renders the open-stock grid for a series product.
--     Once this migration is applied, a loose line for a series product is
--     REJECTED server-side, so the grid should be replaced by a series
--     selector. Safe to ship in this order only because v2 currently has zero
--     orders and zero buyer accounts — nobody's purchase can break. That UI
--     work is the immediate follow-up.

-- ---------------------------------------------------------------------------
-- 1. Make the selling model a first-class, constrained column.
--    It was previously only a free-text key inside a jsonb blob, which is why
--    nothing could enforce it and nothing failed when it was ignored.
-- ---------------------------------------------------------------------------
alter table wholesale_v2.v2_products
  add column if not exists selling_model text not null default 'open';

alter table wholesale_v2.v2_products
  drop constraint if exists v2_products_selling_model_known;
alter table wholesale_v2.v2_products
  add constraint v2_products_selling_model_known
  check (selling_model in ('open', 'prepack', 'series', 'ratio'));

-- Backfill from the data that was already there. Verified beforehand that no
-- product has variants disagreeing about sellMode (0 rows), so taking any
-- variant's value per product is well defined rather than arbitrary.
update wholesale_v2.v2_products p
   set selling_model = sub.mode
  from (
    select v.product_id, min(v.extra_attrs->>'sellMode') as mode
      from wholesale_v2.v2_product_variants v
     where v.extra_attrs->>'sellMode' is not null
     group by v.product_id
  ) sub
 where sub.product_id = p.id
   and sub.mode in ('open','prepack','series','ratio')
   and p.selling_model is distinct from sub.mode;

-- ---------------------------------------------------------------------------
-- 2. Allow a pack to record that it was generated from a selling model rather
--    than hand-built, so it is never mistaken for a wholesaler's own pack.
-- ---------------------------------------------------------------------------
alter table wholesale_v2.v2_pack_definitions
  drop constraint if exists v2_pack_definitions_source_check;
alter table wholesale_v2.v2_pack_definitions
  add constraint v2_pack_definitions_source_check
  check (source in ('manual', 'suggested', 'series'));

-- ---------------------------------------------------------------------------
-- 3. Generate one series pack per series product: every live variant, one unit
--    each. Idempotent -- re-running adds nothing.
-- ---------------------------------------------------------------------------
insert into wholesale_v2.v2_pack_definitions (product_id, wid, name, color, source)
select p.id, p.wid, p.name || ' — Full series', null, 'series'
  from wholesale_v2.v2_products p
 where p.selling_model = 'series'
   and not p.archived
   and not exists (
     select 1 from wholesale_v2.v2_pack_definitions d
      where d.product_id = p.id and d.source = 'series' and not d.archived);

insert into wholesale_v2.v2_pack_components (pack_id, variant_id, qty_per_pack)
select d.id, v.id, 1
  from wholesale_v2.v2_pack_definitions d
  join wholesale_v2.v2_product_variants v
    on v.product_id = d.product_id and not v.archived
 where d.source = 'series' and not d.archived
   and not exists (
     select 1 from wholesale_v2.v2_pack_components c
      where c.pack_id = d.id and c.variant_id = v.id);

-- ---------------------------------------------------------------------------
-- 4. Enforce it at checkout.
--
--    A series product may ONLY be bought as complete series. Migration 028
--    already proved that any line carrying a pack_line_id belongs to a real,
--    live, correctly-composed pack of this wholesaler's, so all that is left
--    is to require it.
--
--    This is the whole point of the migration: without this block the pack
--    merely becomes AVAILABLE alongside loose buying, and the wholesaler's
--    rule is still not applied.
-- ---------------------------------------------------------------------------
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
end;
$$;

comment on function wholesale_v2.v2_enforce_selling_model(uuid, boolean, text) is
  'Migration 029. Rejects loose lines for a product whose selling_model is ''series''. '
  'Only ''series'' is enforced: ''ratio'' and ''prepack'' lack the data v1 used '
  '(per-size ratios, PACK_UNIT) and enforcing them would be guessing.';

-- ---------------------------------------------------------------------------
-- 5. Wire the enforcement into checkout.
--
--    Creating v2_enforce_selling_model above enforces NOTHING on its own -- it
--    has to be CALLED. This block is added to v2_submit_order, immediately
--    after migration 028's pack validation and before the MOQ checks:
--
--      for v_product in
--        select tol.product_id,
--               bool_and(tol.pack_line_id is not null) as all_lines_are_pack_lines
--          from tmp_order_lines tol
--         group by tol.product_id
--      loop
--        perform v2_enforce_selling_model(
--          v_product.product_id,
--          v_product.all_lines_are_pack_lines,
--          (select name from v2_products where id = v_product.product_id));
--      end loop;
--
--    The full replacement function was applied as migration
--    `v2_series_selling_model_enforcement`, rebased on the LIVE definition read
--    from pg_proc rather than from any migration file -- per the lesson from
--    028, where rebuilding from an older file would have deleted migration
--    024's p_account_id authority check.
--
--    VERIFIED LIVE (in a rolled-back transaction, 0 rows written):
--      series product bought loose  -> refused with the series message
--      partial series               -> refused by 028's composition check
--      complete series / open loose -> passed all validation, reached the
--                                      reservation step (no reservation in a
--                                      synthetic order, so it stops there)
--    Locally, with reservations stubbed: complete series accepted, 3x series
--    accepted, open product accepted, and check_pack_moq.sh still 11/11.
-- ---------------------------------------------------------------------------
