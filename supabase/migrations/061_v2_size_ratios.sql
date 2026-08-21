-- =====================================================================
-- 061 — A ratio you write ONCE and use everywhere
--
-- Hadi, 20 Aug 2026: "There is no way to program the ratios. There is no
-- way to program the pre-pack. There's nothing... Give them full freedom
-- to decide what type of ratios, pre-packs, series, and so on, in
-- whatever way they want."
--
-- WHAT WAS ACTUALLY WRONG (measured, not assumed)
-- ---------------------------------------------------------------------
-- Three separate failures, only one of which was visible:
--
-- 1. v2_products.ratio_curve has existed since migration 030 and NOTHING
--    READS IT. js/data/catalog.js:153 maps it onto an object and no line
--    of code ever touches that object again. It is the same silent-dead-
--    column failure as v2_clients.discount_pct, which sat dead from
--    migration 006 until 19 Aug -- a client set to 10% paid full price on
--    screen AND on the invoice for two months.
--
-- 2. There is no way to EDIT a curve. Not a hidden way, not an awkward
--    way -- none. The value shipped as a constant lifted out of v1
--    (RATIO_CURVE = {36:2, 38:3, 40:5, 42:2}) and has never been editable
--    by anyone.
--
-- 3. Live proof that this bites: product "guyhj" (wid 'test') is declared
--    selling_model = 'ratio' with ratio_curve = NULL and SEVEN sizes.
--    The wholesaler said "sell this by ratio" and the system has no ratio
--    to sell it by.
--
-- WHY A SEPARATE TABLE AND NOT A BIGGER ratio_curve COLUMN
-- ---------------------------------------------------------------------
-- Because the thing that is missing is REUSE. A curve on a product is
-- re-typed for every product; that is the actual complaint ("64 rows, one
-- pack at a time"). Every mature system in this space models the ratio as
-- a standalone named object and then ATTACHES it:
--   * NuORDER "Size Packs" -- created standalone, then a separate
--     "associating packs to products" step.
--   * Brandboom -- "add the same prepack to multiple products at one time".
--   * Style Arcade -- named, reusable "Size Curves".
-- Not one of them stores the curve only on the product. Neither will we.
--
-- ratio_curve is NOT dropped here. It stays, still written by 030, so
-- nothing that reads it (however little) changes behaviour today. It
-- becomes a cache of "the ratio currently applied to this product", and
-- v2_apply_ratio keeps it in sync. Dropping a live column in the same
-- migration that introduces its replacement is how you get an outage.
-- =====================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Size sequences -- an ordered list of sizes, named and reused
-- ---------------------------------------------------------------------
-- A ratio like 1-2-2-1 is meaningless without knowing it means
-- [S,M,L,XL]. Ratio shorthand is read left to right against a declared
-- order, and the numbers are NEVER portable between two different size
-- orders. So the order is data, not a convention in someone's head.
create table if not exists wholesale_v2.v2_size_sequences (
  id         uuid primary key default gen_random_uuid(),
  wid        text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  name       text not null,
  sizes      text[] not null,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (wid, name),
  constraint v2_size_sequences_not_empty check (array_length(sizes, 1) >= 1)
);
create index if not exists idx_v2_size_sequences_wid on wholesale_v2.v2_size_sequences(wid) where not archived;

comment on table wholesale_v2.v2_size_sequences is
  'Named, ordered size lists (S-XL, 36-46, Kids 2-12). Exists so a ratio vector has something to align to -- 1-2-2-1 is meaningless without knowing the order it maps onto.';

-- ---------------------------------------------------------------------
-- 2. The ratio itself -- SELF-CONTAINED on purpose
-- ---------------------------------------------------------------------
-- sizes[] is copied onto the ratio rather than only referenced from the
-- sequence. That looks like duplication and is deliberate: if a ratio
-- merely pointed at a sequence, then editing that sequence later would
-- silently change the meaning of every ratio built on it, and therefore
-- every pack already generated from those ratios. A wholesaler adding
-- size 48 to a sequence must not silently alter what "Boutique 12" means
-- on fourteen products. sequence_id is kept for provenance only.
create table if not exists wholesale_v2.v2_size_ratios (
  id          uuid primary key default gen_random_uuid(),
  wid         text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  name        text not null,
  sequence_id uuid references wholesale_v2.v2_size_sequences(id) on delete set null,
  sizes       text[] not null,
  weights     integer[] not null,
  note        text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (wid, name),
  -- The two arrays ARE the ratio. If they ever disagree in length the
  -- ratio is unreadable, so the database refuses rather than letting a
  -- half-curve exist and be discovered later by a wrong order.
  constraint v2_size_ratios_aligned check (array_length(sizes, 1) = array_length(weights, 1)),
  constraint v2_size_ratios_not_empty check (array_length(sizes, 1) >= 1)
);
create index if not exists idx_v2_size_ratios_wid on wholesale_v2.v2_size_ratios(wid) where not archived;

comment on table wholesale_v2.v2_size_ratios is
  'Reusable named size curves, e.g. "Boutique 12" = [2,3,3,3,1] over [S,M,L,XL,XXL]. Authored once, applied to many products -- the reuse is the whole point, and is what OGGI lacked. sizes[] is copied here rather than only referenced so that editing a sequence can never retroactively change what an existing ratio means.';

-- A weight of 0 is legal and meaningful: "this size is in the run but
-- this pack carries none of it". A NEGATIVE weight is not, and neither is
-- a curve that sums to zero (a pack containing nothing).
--
-- The zero-sum rule is a TRIGGER, not a CHECK, because Postgres forbids a
-- subquery inside a CHECK constraint and summing an array needs unnest().
-- Writing it as a check would have failed at migration time; writing it
-- only in the RPC would have left a direct INSERT able to create an empty
-- curve. So it lives here, where nothing can go round it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_size_ratios_weights_nonneg') then
    alter table wholesale_v2.v2_size_ratios
      add constraint v2_size_ratios_weights_nonneg check (0 <= all(weights));
  end if;
end $$;

create or replace function wholesale_v2.v2_size_ratio_guard()
returns trigger
language plpgsql
as $$
declare v_sum integer;
begin
  if array_position(new.weights, null) is not null then
    raise exception 'A ratio cannot have an empty weight. Use 0 to mean "none of this size".';
  end if;
  select coalesce(sum(w), 0) into v_sum from unnest(new.weights) w;
  if v_sum < 1 then
    raise exception 'A ratio must add up to at least one piece; this one adds up to %.', v_sum;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_v2_size_ratio_guard on wholesale_v2.v2_size_ratios;
create trigger trg_v2_size_ratio_guard
  before insert or update on wholesale_v2.v2_size_ratios
  for each row execute function wholesale_v2.v2_size_ratio_guard();

alter table wholesale_v2.v2_size_sequences enable row level security;
alter table wholesale_v2.v2_size_ratios    enable row level security;

drop policy if exists v2_size_sequences_scoped on wholesale_v2.v2_size_sequences;
create policy v2_size_sequences_scoped on wholesale_v2.v2_size_sequences for all
  using (exists (select 1 from wholesale_v2.v2_user_profiles p where p.id = auth.uid()
                  and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_size_sequences.wid))))
  with check (exists (select 1 from wholesale_v2.v2_user_profiles p where p.id = auth.uid()
                  and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_size_sequences.wid))));

drop policy if exists v2_size_ratios_scoped on wholesale_v2.v2_size_ratios;
create policy v2_size_ratios_scoped on wholesale_v2.v2_size_ratios for all
  using (exists (select 1 from wholesale_v2.v2_user_profiles p where p.id = auth.uid()
                  and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_size_ratios.wid))))
  with check (exists (select 1 from wholesale_v2.v2_user_profiles p where p.id = auth.uid()
                  and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_size_ratios.wid))));

-- ---------------------------------------------------------------------
-- 3. The base unit is PER PRODUCT
-- ---------------------------------------------------------------------
-- Hadi, 20 Aug 2026, correcting me directly: "no it is not, they decide
-- the base unit per product."
--
-- I had asked whether "the dozen" was the base unit for this market. It
-- is not, and there is no market-wide base unit to discover: two products
-- from the SAME wholesaler may legitimately disagree -- one sold by the
-- dozen, one by the half-dozen, one by the single piece. So base_unit
-- lives on the product and is never inherited from the wholesaler, from
-- the country, or from a system default. Anywhere the UI says "sold in
-- units of N", N is read from here and nowhere else.
alter table wholesale_v2.v2_products
  add column if not exists base_unit integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_products_base_unit_sane') then
    alter table wholesale_v2.v2_products
      add constraint v2_products_base_unit_sane check (base_unit is null or base_unit >= 1);
  end if;
end $$;

comment on column wholesale_v2.v2_products.base_unit is
  'How many pieces one orderable unit of THIS product is. Set per product by the wholesaler (Hadi, 20 Aug: "they decide the base unit per product") -- never a wholesaler-wide or market-wide default. NULL = sold by the single piece.';

-- ---------------------------------------------------------------------
-- 4. Where did this pack come from?
-- ---------------------------------------------------------------------
-- Without provenance, a pack generated from "Boutique 12" is
-- indistinguishable from one typed by hand, so re-applying an edited
-- ratio would either duplicate packs or clobber handmade ones. Both are
-- worse than the problem.
alter table wholesale_v2.v2_pack_definitions
  add column if not exists ratio_id   uuid references wholesale_v2.v2_size_ratios(id) on delete set null,
  add column if not exists multiplier integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_pack_definitions_multiplier_sane') then
    alter table wholesale_v2.v2_pack_definitions
      add constraint v2_pack_definitions_multiplier_sane check (multiplier >= 1);
  end if;
end $$;

comment on column wholesale_v2.v2_pack_definitions.ratio_id is
  'The reusable ratio this pack was generated from, or NULL if it was built by hand. Re-applying a ratio only ever touches packs it generated -- a handmade pack is never clobbered.';
comment on column wholesale_v2.v2_pack_definitions.multiplier is
  'How many times the ratio repeats in one pack. Ratio [2,3,3,3,1] at multiplier 2 is a 24-piece pack, not a second ratio.';

-- ---------------------------------------------------------------------
-- 5. Apply a ratio to a product, across many colours, in ONE call
-- ---------------------------------------------------------------------
-- This is the feature. Everything above is the shape it needs.
--
-- Returns a REPORT, not just ok/failed, because the interesting failure
-- is partial: a ratio naming sizes S-XXL applied to a product that only
-- has S-XL must not silently drop XXL and leave the wholesaler believing
-- they sold a five-size run. Unmatched sizes come back by name.
create or replace function wholesale_v2.v2_apply_ratio(
  p_ratio_id   uuid,
  p_product_id uuid,
  p_colors     text[] default null,   -- null => every colour on the product
  p_multiplier integer default 1,
  p_name       text default null      -- null => the ratio's own name
)
returns table(
  ok boolean, msg text,
  packs_created integer, packs_replaced integer,
  pieces_per_pack integer,
  colors_done text[], sizes_unmatched text[]
)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_ratio   wholesale_v2.v2_size_ratios%rowtype;
  v_product wholesale_v2.v2_products%rowtype;
  v_wid     text;
  v_colors  text[];
  v_unmatched text[];
  v_created int := 0;
  v_replaced int := 0;
  v_pieces  int;
  v_color   text;
  v_pack_id uuid;
  v_comp    int;
begin
  select * into v_ratio from wholesale_v2.v2_size_ratios where id = p_ratio_id;
  if v_ratio.id is null then
    return query select false, 'No such ratio.', 0, 0, 0, null::text[], null::text[]; return;
  end if;
  select * into v_product from wholesale_v2.v2_products where id = p_product_id;
  if v_product.id is null then
    return query select false, 'No such product.', 0, 0, 0, null::text[], null::text[]; return;
  end if;

  v_wid := wholesale_v2.v2_my_wid();
  if not (wholesale_v2.v2_is_owner() or (v_wid = v_product.wid and v_wid = v_ratio.wid)) then
    return query select false, 'Not your product.', 0, 0, 0, null::text[], null::text[]; return;
  end if;

  if coalesce(p_multiplier, 1) < 1 then
    return query select false, 'Multiplier must be at least 1.', 0, 0, 0, null::text[], null::text[]; return;
  end if;

  -- Which colours? Default is every colour this product actually has, so
  -- "apply to all" is one click and not a colour-by-colour chore.
  if p_colors is null or array_length(p_colors, 1) is null then
    select array_agg(distinct v.extra_attrs->>'color')
      into v_colors
      from wholesale_v2.v2_product_variants v
     where v.product_id = p_product_id and v.extra_attrs->>'color' is not null;
  else
    v_colors := p_colors;
  end if;

  if v_colors is null or array_length(v_colors, 1) is null then
    return query select false, 'This product has no colours to apply a ratio to.', 0, 0, 0, null::text[], null::text[]; return;
  end if;

  -- Sizes in the ratio that this product does not have. Reported, never
  -- swallowed -- see the header note on partial failure.
  select array_agg(s) into v_unmatched
    from unnest(v_ratio.sizes) s
   where not exists (
     select 1 from wholesale_v2.v2_product_variants v
      where v.product_id = p_product_id and v.extra_attrs->>'size' = s
   );

  v_pieces := (select coalesce(sum(w), 0) from unnest(v_ratio.weights) w) * p_multiplier;

  foreach v_color in array v_colors loop
    -- Replace only what THIS ratio generated for THIS colour. A pack the
    -- wholesaler built by hand has ratio_id null and is left alone.
    update wholesale_v2.v2_pack_definitions
       set archived = true, updated_at = now()
     where product_id = p_product_id
       and ratio_id = p_ratio_id
       and color is not distinct from v_color
       and not archived;
    if found then v_replaced := v_replaced + 1; end if;

    insert into wholesale_v2.v2_pack_definitions
      (product_id, wid, name, color, source, ratio_id, multiplier)
    values
      (p_product_id, v_product.wid,
       coalesce(nullif(btrim(coalesce(p_name,'')),''), v_ratio.name), v_color,
       'manual', p_ratio_id, p_multiplier)
    returning id into v_pack_id;

    -- One component per (size, colour) that actually exists, at
    -- weight x multiplier. A zero weight writes no row at all -- a
    -- component of 0 would fail v2_pack_components' own qty >= 1 check
    -- and, more importantly, "this pack contains none of size XL" is
    -- said better by absence than by a zero.
    insert into wholesale_v2.v2_pack_components (pack_id, variant_id, qty_per_pack)
    select v_pack_id, v.id, w.weight * p_multiplier
      from unnest(v_ratio.sizes, v_ratio.weights) as w(size, weight)
      join wholesale_v2.v2_product_variants v
        on v.product_id = p_product_id
       and v.extra_attrs->>'size'  = w.size
       and v.extra_attrs->>'color' = v_color
     where w.weight > 0;

    get diagnostics v_comp = row_count;
    if v_comp = 0 then
      -- No variant matched at all for this colour: a pack with no
      -- contents is worse than no pack, because the buyer can add it.
      delete from wholesale_v2.v2_pack_definitions where id = v_pack_id;
    else
      v_created := v_created + 1;
    end if;
  end loop;

  -- Keep the legacy column honest rather than leaving two versions of
  -- the truth. 030 still writes it; now it reflects the applied ratio.
  update wholesale_v2.v2_products
     set ratio_curve = (
           select jsonb_object_agg(w.size, w.weight * p_multiplier)
             from unnest(v_ratio.sizes, v_ratio.weights) as w(size, weight)
            where w.weight > 0
         ),
         updated_at = now()
   where id = p_product_id;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (coalesce(v_wid,'owner'), 'ratio_applied', 'product', p_product_id::text,
          jsonb_build_object('ratio', v_ratio.name, 'multiplier', p_multiplier,
                             'colors', v_colors, 'pieces_per_pack', v_pieces,
                             'sizes_unmatched', v_unmatched));

  return query select true,
    case when v_unmatched is null then 'Ratio applied.'
         else 'Ratio applied, but this product has no ' || array_to_string(v_unmatched, ', ') || '.' end,
    v_created, v_replaced, v_pieces, v_colors, v_unmatched;
end;
$$;
revoke all on function wholesale_v2.v2_apply_ratio(uuid, uuid, text[], integer, text) from public, anon;
grant execute on function wholesale_v2.v2_apply_ratio(uuid, uuid, text[], integer, text) to authenticated;

-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_apply_ratio'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Turns one reusable ratio into real packs across many colours of a product in a single call -- the thing that replaces re-typing a curve per colour per product. Only ever replaces packs it generated itself (ratio_id match); handmade packs are never touched. Reports unmatched sizes instead of silently dropping them.');
  end loop;
end $cmt$;

-- ---------------------------------------------------------------------
-- 6. Which products is this ratio on?
-- ---------------------------------------------------------------------
-- Asked before editing or archiving a ratio. Without it, changing a curve
-- is a blind action across an unknown number of products.
create or replace function wholesale_v2.v2_ratio_usage(p_ratio_id uuid)
returns table(product_id uuid, product_name text, colors integer, pieces_per_pack integer)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $$
  select p.id, p.name,
         count(distinct d.color)::int,
         coalesce(max(x.total), 0)::int
    from wholesale_v2.v2_pack_definitions d
    join wholesale_v2.v2_products p on p.id = d.product_id
    left join lateral (
      select sum(c.qty_per_pack) as total
        from wholesale_v2.v2_pack_components c where c.pack_id = d.id
    ) x on true
   where d.ratio_id = p_ratio_id and not d.archived
     and (wholesale_v2.v2_is_owner() or p.wid = wholesale_v2.v2_my_wid())
   group by p.id, p.name
   order by p.name;
$$;
revoke all on function wholesale_v2.v2_ratio_usage(uuid) from public, anon;
grant execute on function wholesale_v2.v2_ratio_usage(uuid) to authenticated;

-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_ratio_usage'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Which products currently carry packs generated from this ratio. Shown before editing or archiving one, so changing a curve is never a blind action.');
  end loop;
end $cmt$;
