-- OGGI Wholesale v2 — Batch 1: migrate real v1 production data into the v2 schema
-- 11 Aug 2026
--
-- SOURCE-OF-TRUTH FINDING (important, document this in the deploy record):
-- The live v1 app does NOT read/write the `products`/`clients`/`orders` SQL
-- tables as its primary store. It reads/writes ONE row,
-- `wholesale_state` where id='main', as a single JSON document (see
-- index.html: `sb.from('wholesale_state').upsert({id:'main', doc:collectData()})`,
-- and the comment "business data lives in one row (wholesale_state/main) so
-- it's shared across..."). The `products`/`wholesalers`/`clients`/`orders`
-- SQL tables contain leftover/parallel test data (e.g. wid 'WS-001' — zero
-- references anywhere in the live v1 source, confirmed by grep) that the
-- live app never reads. This migration therefore sources from
-- `wholesale_state.doc`, not from the `products` table, since that JSON
-- document is what's actually live.
--
-- COLOUR PALETTE: confirmed from v1 source (index.html line ~460, `var
-- COLOURS = [...]`) — legacy products reference colours by palette index
-- (0-3); this exact palette is reproduced below so migrated colour names/
-- hex values match what buyers have always seen, not guesses.
--
-- STOCK GRANULARITY: v1 source confirms (index.html line ~572, code
-- comment: "p.stock[i] === the i-th colour... there is no size [tracking]")
-- that v1 has only ever tracked stock per-colour, never per-size. This is
-- the exact regression class Research 1 / the new variant-grain ledger
-- schema exists to fix. Because there is no real per-size number to
-- migrate, each colour's total stock is evenly split across that product's
-- sizes (remainder to the first size), written through the real
-- `v2_receive_stock` RPC (so it's a logged, auditable 'receive' movement,
-- not a silent balance write) with a note explaining the approximation.
-- This is demo/test-scale data (small wholesalers, placeholder shop names)
-- — real per-size counts should be entered via a cycle count once Batch 9
-- ships; this migration does not claim false precision.
--
-- SCOPE: Batch 1 only covers products/variants/inventory (its own schema).
-- Clients, orders, catalogs and requests are migrated by their owning
-- batches (2, 3, 5) once those tables exist — not invented ad hoc here.

alter table v2_products add column if not exists source_ref text;
create index if not exists idx_v2_products_source_ref on v2_products(wid, source_ref);

do $mig$
declare
  v_colours jsonb := '[
    {"name":"Midnight Blue","hex":"#24467a"},
    {"name":"Crimson Red","hex":"#b23046"},
    {"name":"Sand","hex":"#c9b18a"},
    {"name":"Forest","hex":"#2f6b4f"}
  ]'::jsonb;
  v_default_sizes text[] := array['36','38','40','42'];

  v_row       record;
  v_product   jsonb;
  v_pid       uuid;
  v_loc_id    uuid;
  v_color_opt uuid;
  v_size_opt  uuid;
  v_variant   uuid;

  v_colour_names text[];
  v_colour_hexes text[];
  v_sizes        text[];
  v_stock        int[];

  v_color_val_ids uuid[];
  v_size_val_ids  uuid[];

  i int; j int;
  v_total int; v_n int; v_per int; v_rem int; v_qty int;
  v_sku text; v_ref text; v_source_id text;
  v_val_id uuid;
  v_migrated_products int := 0;
  v_migrated_variants int := 0;
begin
  -- Gap-fill: 'omni' is a real wholesaler in v1's live JSON doc but has no
  -- row in the `wholesalers` SQL table (that table is incomplete, not
  -- authoritative — see note above). Additive only; no existing row touched.
  insert into wholesalers (wid, brand, name, currency, active)
  values ('omni', 'Omni Access', 'Omni Access', '$', true)
  on conflict (wid) do nothing;

  for v_row in
    select kv.key as wid, elem as product
    from wholesale_state ws,
         jsonb_each(ws.doc->'products') kv,
         jsonb_array_elements(kv.value) elem
    where ws.id = 'main'
  loop
    v_product := v_row.product;
    v_source_id := v_product->>'id';

    -- idempotent re-run guard: skip a product already migrated from this
    -- exact v1 source id under this wholesaler
    if exists (select 1 from v2_products where wid = v_row.wid and source_ref = v_source_id) then
      continue;
    end if;

    -- default location per wholesaler (create once, reuse)
    select id into v_loc_id from v2_locations where wid = v_row.wid and is_default limit 1;
    if v_loc_id is null then
      insert into v2_locations (wid, name, is_default)
      values (v_row.wid, 'Main Warehouse', true)
      returning id into v_loc_id;
    end if;

    -- resolve colours: custom p.cols[{name,hex}] takes priority over the
    -- legacy palette-index p.colours[int], exactly matching v1's own
    -- pcv(p) resolution order (index.html line ~5261).
    v_colour_names := array[]::text[];
    v_colour_hexes := array[]::text[];
    if jsonb_typeof(v_product->'cols') = 'array' and jsonb_array_length(v_product->'cols') > 0 then
      for i in 0 .. jsonb_array_length(v_product->'cols') - 1 loop
        v_colour_names := v_colour_names || coalesce(v_product->'cols'->i->>'name', 'Colour');
        v_colour_hexes := v_colour_hexes || coalesce(v_product->'cols'->i->>'hex', '#888888');
      end loop;
    elsif jsonb_typeof(v_product->'colours') = 'array' then
      for i in 0 .. jsonb_array_length(v_product->'colours') - 1 loop
        j := (v_product->'colours'->>i)::int;
        v_colour_names := v_colour_names || coalesce(v_colours->j->>'name', 'Colour');
        v_colour_hexes := v_colour_hexes || coalesce(v_colours->j->>'hex', '#888888');
      end loop;
    end if;

    -- resolve sizes: explicit p.sizes[] if present, else v1's default run
    if jsonb_typeof(v_product->'sizes') = 'array' and jsonb_array_length(v_product->'sizes') > 0 then
      select array_agg(s.value order by s.ordinality) into v_sizes
      from jsonb_array_elements_text(v_product->'sizes') with ordinality as s;
    else
      v_sizes := v_default_sizes;
    end if;

    -- resolve per-colour stock (parallel to v_colour_names, per v1's own
    -- invariant — confirmed above, not per-size)
    v_stock := array[]::int[];
    if jsonb_typeof(v_product->'stock') = 'array' then
      for i in 0 .. jsonb_array_length(v_product->'stock') - 1 loop
        v_stock := v_stock || coalesce((v_product->'stock'->>i)::int, 0);
      end loop;
    end if;

    v_ref := nullif(trim(both from coalesce(v_product->>'ref', '')), '—');
    v_sku := coalesce(v_ref, v_source_id, 'SKU');

    insert into v2_products (wid, name, description, archived, source_ref)
    values (
      v_row.wid,
      coalesce(v_product->>'name', 'Untitled product'),
      nullif(v_product->>'material', ''),
      false,
      v_source_id
    )
    returning id into v_pid;

    insert into v2_product_options (product_id, name, position) values (v_pid, 'Color', 0) returning id into v_color_opt;
    insert into v2_product_options (product_id, name, position) values (v_pid, 'Size', 1) returning id into v_size_opt;

    v_color_val_ids := array[]::uuid[];
    for i in 1 .. array_length(v_colour_names, 1) loop
      insert into v2_product_option_values (option_id, value, position)
      values (v_color_opt, v_colour_names[i], i - 1)
      returning id into v_val_id;
      v_color_val_ids := v_color_val_ids || v_val_id;
    end loop;

    v_size_val_ids := array[]::uuid[];
    for i in 1 .. array_length(v_sizes, 1) loop
      insert into v2_product_option_values (option_id, value, position)
      values (v_size_opt, v_sizes[i], i - 1)
      returning id into v_val_id;
      v_size_val_ids := v_size_val_ids || v_val_id;
    end loop;

    -- variant grid: every colour x every size, seeded with an even split of
    -- that colour's known total stock across its sizes (see header note)
    v_n := array_length(v_sizes, 1);
    for i in 1 .. array_length(v_colour_names, 1) loop
      v_total := coalesce(v_stock[i], 0);
      v_per := v_total / v_n;
      v_rem := v_total % v_n;

      for j in 1 .. v_n loop
        v_qty := v_per + (case when j <= v_rem then 1 else 0 end);

        insert into v2_product_variants (product_id, sku, price, cost, compare_at_price, extra_attrs)
        values (
          v_pid,
          v_sku || '-' || regexp_replace(v_colour_names[i], '\s+', '', 'g') || '-' || v_sizes[j],
          nullif(v_product->>'price', '')::numeric,
          nullif(v_product->>'cost', '')::numeric,
          nullif(v_product->>'was', '')::numeric,
          jsonb_build_object('color', v_colour_names[i], 'colorHex', v_colour_hexes[i], 'size', v_sizes[j], 'sellMode', v_product->>'mode')
        )
        returning id into v_variant;

        insert into v2_product_variant_option_values (variant_id, option_value_id)
        values (v_variant, v_color_val_ids[i]), (v_variant, v_size_val_ids[j]);

        if v_qty > 0 then
          perform v2_receive_stock(
            v_variant, v_loc_id, v_qty,
            'migration', null, null,
            'v1->v2 migration: ' || v_colour_names[i] || ' total (' || v_total ||
            ') evenly split across ' || v_n || ' sizes -- v1 tracked stock per-colour only, not per-size'
          );
        end if;

        v_migrated_variants := v_migrated_variants + 1;
      end loop;
    end loop;

    v_migrated_products := v_migrated_products + 1;
  end loop;

  raise notice 'v1->v2 migration: % products, % variants migrated', v_migrated_products, v_migrated_variants;
end;
$mig$;
