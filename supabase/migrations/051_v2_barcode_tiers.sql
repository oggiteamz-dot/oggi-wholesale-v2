-- OGGI Wholesale v2 — Batch 18: three barcode tiers
--
-- Hadi: "I don't know what kind of barcode system the wholesaler is going to
-- have. They might have one barcode for the entire product line, they might
-- have one for each colour, and they might have one for each size in each
-- colour."
--
-- That is three real schemes, not three preferences, and a wholesaler does not
-- get to pick one -- their existing label stock decides it for them. Batch 16
-- built only the finest tier (per size, per colour). This adds the other two.
--
--   product : one code for the whole style, any colour, any size
--   colour  : one code per colourway, covering every size in it
--   variant : one code per size within a colour   (already existed)
--
-- The colour tier is a TABLE and not a jsonb column on the product, which is
-- the decision worth explaining. A colour is not a row anywhere in this schema
-- -- it lives inside v2_product_variants.extra_attrs -- so the obvious move is
-- a {colour: barcode} map on the product. But a jsonb map cannot carry a
-- unique index on its values, and uniqueness is the entire point: a scanned
-- code has to resolve to exactly one thing or the warehouse puts stock on the
-- wrong SKU. A table gets `unique (barcode)` for free.
--
-- v2_resolve_barcode answers all three tiers with one rule: MOST SPECIFIC
-- WINS, and ambiguity is returned rather than guessed. A variant code returns
-- one row; a colour or product code returns every variant underneath it and
-- the screen asks which one. Picking the first row would be a silent wrong
-- answer, and a scanner that is confidently wrong is worse than one that asks.

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_products add column if not exists barcode text;

create unique index if not exists v2_products_barcode_uq
  on wholesale_v2.v2_products (barcode) where barcode is not null;

comment on column wholesale_v2.v2_products.barcode is
  'The whole-product barcode: one code for the entire style, whatever colour or size. Some wholesalers barcode at this level only. Nullable and globally unique when set, matching v2_product_variants.barcode from migration 016.';

create table if not exists wholesale_v2.v2_product_colour_barcodes (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references wholesale_v2.v2_products(id) on delete cascade,
  color      text not null,
  barcode    text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists v2_colour_barcode_per_colour_uq
  on wholesale_v2.v2_product_colour_barcodes (product_id, lower(color));
create unique index if not exists v2_colour_barcode_code_uq
  on wholesale_v2.v2_product_colour_barcodes (barcode);
create index if not exists idx_v2_colour_barcodes_product
  on wholesale_v2.v2_product_colour_barcodes (product_id);

comment on table wholesale_v2.v2_product_colour_barcodes is
  'The middle barcode tier: one code per colourway, covering every size in it. A separate table rather than a column because a colour is not a row anywhere -- it lives inside v2_product_variants.extra_attrs -- and a jsonb map on the product could not carry a unique index, which is what makes a scanned code resolve to exactly one thing.';

alter table wholesale_v2.v2_product_colour_barcodes enable row level security;

create policy v2_colour_barcodes_read_scoped on wholesale_v2.v2_product_colour_barcodes
  for select using (
    v2_is_owner() or exists (
      select 1 from wholesale_v2.v2_products p where p.id = product_id and p.wid = v2_my_wid()
    )
  );
create policy v2_colour_barcodes_insert_scoped on wholesale_v2.v2_product_colour_barcodes
  for insert with check (
    v2_is_owner() or exists (
      select 1 from wholesale_v2.v2_products p where p.id = product_id and p.wid = v2_my_wid()
    )
  );
create policy v2_colour_barcodes_update_scoped on wholesale_v2.v2_product_colour_barcodes
  for update using (
    v2_is_owner() or exists (
      select 1 from wholesale_v2.v2_products p where p.id = product_id and p.wid = v2_my_wid()
    )
  ) with check (
    v2_is_owner() or exists (
      select 1 from wholesale_v2.v2_products p where p.id = product_id and p.wid = v2_my_wid()
    )
  );
create policy v2_colour_barcodes_delete_scoped on wholesale_v2.v2_product_colour_barcodes
  for delete using (
    v2_is_owner() or exists (
      select 1 from wholesale_v2.v2_products p where p.id = product_id and p.wid = v2_my_wid()
    )
  );

-- Buyers browse the catalogue and have no business reading a wholesaler's
-- internal barcode scheme; the warehouse screens that DO scan run as an
-- authenticated wholesaler.
revoke all on wholesale_v2.v2_product_colour_barcodes from anon;
grant select, insert, update, delete on wholesale_v2.v2_product_colour_barcodes to authenticated;

create or replace function wholesale_v2.v2_resolve_barcode(p_wid text, p_code text)
returns table (
  tier text, variant_id uuid, product_id uuid, product_name text,
  sku text, color text, size text
)
language plpgsql
security definer
set search_path = wholesale_v2, public
stable
as $$
declare v_code text;
begin
  v_code := trim(coalesce(p_code, ''));
  if v_code = '' then return; end if;

  -- Reuses Batch 16's authority rule rather than writing a second one. It is
  -- total by construction (coalesced to false), which is what stops the NULL
  -- fall-through that migration 049 had to fix.
  if wholesale_v2.v2_override_actor_can_act(null, p_wid) is not true then
    return;
  end if;

  -- 1. exact variant, by barcode then by SKU
  return query
    select 'variant'::text, v.id, p.id, p.name, v.sku,
           v.extra_attrs->>'color', v.extra_attrs->>'size'
    from wholesale_v2.v2_product_variants v
    join wholesale_v2.v2_products p on p.id = v.product_id
    where p.wid = p_wid and (v.barcode = v_code or v.sku = v_code);
  if found then return; end if;

  -- 2. a colourway
  return query
    select 'colour'::text, v.id, p.id, p.name, v.sku,
           v.extra_attrs->>'color', v.extra_attrs->>'size'
    from wholesale_v2.v2_product_colour_barcodes cb
    join wholesale_v2.v2_products p on p.id = cb.product_id
    join wholesale_v2.v2_product_variants v
      on v.product_id = p.id
     and lower(coalesce(v.extra_attrs->>'color','')) = lower(cb.color)
    where p.wid = p_wid and cb.barcode = v_code;
  if found then return; end if;

  -- 3. a whole product
  return query
    select 'product'::text, v.id, p.id, p.name, v.sku,
           v.extra_attrs->>'color', v.extra_attrs->>'size'
    from wholesale_v2.v2_products p
    join wholesale_v2.v2_product_variants v on v.product_id = p.id
    where p.wid = p_wid and p.barcode = v_code;
end;
$$;
revoke all on function wholesale_v2.v2_resolve_barcode(text, text) from public;
grant execute on function wholesale_v2.v2_resolve_barcode(text, text) to authenticated;

do $$
declare v_anon int;
begin
  select count(*) into v_anon from information_schema.role_table_grants
  where table_schema='wholesale_v2' and table_name='v2_product_colour_barcodes' and grantee='anon';
  if v_anon > 0 then
    raise exception 'anon holds % grant(s) on v2_product_colour_barcodes.', v_anon;
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema='wholesale_v2' and table_name='v2_products' and column_name='barcode') then
    raise exception 'v2_products.barcode was not created.';
  end if;
end $$;
