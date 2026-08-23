-- OGGI Wholesale v2 — Migration 079: a selling model that needs a pack must get one
-- 23 Aug 2026
--
-- WHAT WAS WRONG
-- --------------
-- v2_enforce_selling_model (029/030, current definition in 063) refuses any
-- LOOSE order for a product whose selling_model is 'ratio', 'prepack' or
-- 'series':
--
--   '"%" is sold in ratio packs -- the size mix is set by the wholesaler.
--    Choose a colour and a number of packs rather than individual sizes.'
--
-- That is correct, and it is only half a rule. If the product has no pack, the
-- buyer cannot choose one either. The product is refused BOTH ways: it is
-- silently unsellable, and nothing anywhere says so.
--
-- Found on production, 23 Aug 2026, on Hadi's own wholesaler:
--
--   guyhj   ratio     28 variants   0 packs
--   htfd    prepack   18 variants   0 packs
--
-- Both had been unorderable since the moment their selling model was set.
--
-- WHY SERIES IS DIFFERENT, AND WHY IT IS FIXED HERE RATHER THAN IN THE UI
-- ----------------------------------------------------------------------
-- Ratio and prepack need a human: somebody has to decide the size curve, or
-- what goes in the carton. Batch 8D puts that decision in the product form.
--
-- A SERIES has nothing to decide. Migration 029 defines it exactly: "a series
-- is exactly a pack whose components are every live variant of the product at
-- one unit each." There is no curve, no choice, no composition. A button
-- asking a human to build it would be a button with one possible answer.
--
-- 029 generated those packs with a ONE-TIME INSERT. Not a trigger. It ran on
-- 15 August against the products that were series that day, and every series
-- product created since has had none -- unsellable on creation, with no
-- builder that could have fixed it because there is nothing to build.
--
-- So: a trigger, which is what 029 should have been.

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------------
-- 1. Keep a series pack in step with its product, automatically.
-- ---------------------------------------------------------------------------
create or replace function wholesale_v2.v2_sync_series_pack(p_product_id uuid)
returns void
language plpgsql volatile security definer set search_path = wholesale_v2
as $$
declare
  v_pack uuid;
  v_wid  text;
  v_name text;
begin
  select wid, name into v_wid, v_name
    from wholesale_v2.v2_products
   where id = p_product_id and selling_model = 'series' and not archived;

  -- Not a series (any more). Archive a generated pack if one is left behind,
  -- but never touch a pack a human built -- source tells them apart, which is
  -- exactly why 029 added the column.
  if v_wid is null then
    update wholesale_v2.v2_pack_definitions
       set archived = true
     where product_id = p_product_id and source = 'series' and not archived;
    return;
  end if;

  select id into v_pack
    from wholesale_v2.v2_pack_definitions
   where product_id = p_product_id and source = 'series' and not archived
   limit 1;

  if v_pack is null then
    insert into wholesale_v2.v2_pack_definitions (product_id, wid, name, color, source)
    values (p_product_id, v_wid, v_name || ' — Full series', null, 'series')
    returning id into v_pack;
  end if;

  -- Every live variant, one unit each -- 029's definition, kept true as
  -- variants are added or archived rather than frozen at creation time.
  insert into wholesale_v2.v2_pack_components (pack_id, variant_id, qty_per_pack)
  select v_pack, v.id, 1
    from wholesale_v2.v2_product_variants v
   where v.product_id = p_product_id and not v.archived
     and not exists (select 1 from wholesale_v2.v2_pack_components c
                      where c.pack_id = v_pack and c.variant_id = v.id);

  delete from wholesale_v2.v2_pack_components c
   using wholesale_v2.v2_product_variants v
   where c.pack_id = v_pack and v.id = c.variant_id and v.archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Fire it whenever the thing it depends on changes.
-- ---------------------------------------------------------------------------
create or replace function wholesale_v2.v2_series_pack_trg()
returns trigger
language plpgsql security definer set search_path = wholesale_v2
as $$
begin
  if tg_table_name = 'v2_products' then
    perform wholesale_v2.v2_sync_series_pack(new.id);
  else
    perform wholesale_v2.v2_sync_series_pack(coalesce(new.product_id, old.product_id));
  end if;
  return null;
end;
$$;

drop trigger if exists v2_series_pack_on_product  on wholesale_v2.v2_products;
create trigger v2_series_pack_on_product
  after insert or update of selling_model, name, archived on wholesale_v2.v2_products
  for each row execute function wholesale_v2.v2_series_pack_trg();

drop trigger if exists v2_series_pack_on_variant on wholesale_v2.v2_product_variants;
create trigger v2_series_pack_on_variant
  after insert or update of archived or delete on wholesale_v2.v2_product_variants
  for each row execute function wholesale_v2.v2_series_pack_trg();

-- ---------------------------------------------------------------------------
-- 3. Catch up every series product that 029's one-off insert has missed since.
-- ---------------------------------------------------------------------------
do $catchup$
declare r record; n int := 0;
begin
  for r in select id from wholesale_v2.v2_products
            where selling_model = 'series' and not archived
  loop
    perform wholesale_v2.v2_sync_series_pack(r.id);
    n := n + 1;
  end loop;
  raise notice 'series packs synced for % product(s)', n;
end
$catchup$;

-- ---------------------------------------------------------------------------
-- 4. A read a screen can ask: is this product actually sellable?
-- ---------------------------------------------------------------------------
-- The form needs to say "nobody can order this yet" the moment a model is
-- chosen. That judgement belongs next to the rule it mirrors, not re-derived
-- in JavaScript where it would drift from v2_enforce_selling_model.
create or replace function wholesale_v2.v2_products_needing_setup(p_wid text default null)
returns table (
  product_id    uuid,
  name          text,
  selling_model text,
  variant_count int,
  pack_count    int
)
language sql stable security definer set search_path = wholesale_v2
as $$
  select p.id, p.name, p.selling_model,
         (select count(*)::int from wholesale_v2.v2_product_variants v
           where v.product_id = p.id and not v.archived),
         (select count(*)::int from wholesale_v2.v2_pack_definitions d
           where d.product_id = p.id and not d.archived)
    from wholesale_v2.v2_products p
   where p.wid = coalesce(p_wid, wholesale_v2.v2_my_wid())
     and not p.archived
     -- 'series' is deliberately absent: the trigger above guarantees it has a
     -- pack, so listing it would be reporting a problem that cannot exist.
     and p.selling_model in ('ratio', 'prepack')
     and not exists (select 1 from wholesale_v2.v2_pack_definitions d
                      where d.product_id = p.id and not d.archived)
   order by p.name;
$$;

revoke all on function wholesale_v2.v2_products_needing_setup(text) from public;
grant execute on function wholesale_v2.v2_products_needing_setup(text) to authenticated;

do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_products_needing_setup'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure,
      'Products whose selling model refuses a loose order but which have no pack to order instead -- silently unsellable. Series is excluded because v2_sync_series_pack guarantees it has one.');
  end loop;
end
$cmt$;
