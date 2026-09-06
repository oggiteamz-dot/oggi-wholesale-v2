-- 117 — MOD-05: the pricing dial moves onto the STORE
--
-- WHY, AND WHY IT COMES BEFORE MOD-04
-- v2_effective_unit_price takes a p_catalog_id. The catalogue is therefore
-- part of the PRICE, not just a shelf. Measured on production: 23 products
-- sit in two or more catalogues and ALL 23 have conflicting discount
-- percentages. So "show the buyer the whole store instead of one catalogue"
-- cannot be built first -- the moment the catalogue boundary goes, those 23
-- products have two prices and no rule to choose between them.
--
-- Hadi's decision (D5, 5 Sep): one dial per store. This migration is that
-- dial. MOD-04 becomes safe only after it.
--
-- DELIBERATELY INERT. Nothing calls v2_store_discount_pct yet;
-- v2_catalog_discount_pct is untouched and still the only thing pricing an
-- order. No price changes today. The switch-over is its own migration with
-- its own gate.
--
-- WHY THE BACKFILL IS SAFE
-- Every wholesaler's DEFAULT catalogue carries 0.00% / 'combine'. Every
-- non-zero dial on production (5%, 6%, 8%, 10%, -5%) lives on a SECONDARY
-- catalogue. Seeding the store from the default catalogue therefore starts
-- every store at exactly the rate its buyers already get.
--
-- Past orders cannot move: v2_order_items.unit_price is stored, not derived.
--
-- APPLIED AND VERIFIED LIVE 6 Sep 2026: 767 (wholesaler x client) pairs
-- checked, 0 repriced, and 520 of those pairs carry a NON-ZERO discount --
-- so the parity result is not the artefact of an all-zero corpus.

alter table wholesale_v2.v2_wholesalers
  add column if not exists discount_pct  numeric not null default 0,
  add column if not exists discount_mode text    not null default 'combine';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_wholesalers_discount_mode_ck') then
    alter table wholesale_v2.v2_wholesalers
      add constraint v2_wholesalers_discount_mode_ck
      check (discount_mode in ('combine','catalog_only','customer_only'));
  end if;
end $$;

comment on column wholesale_v2.v2_wholesalers.discount_pct is
  'MOD-05. The store-wide pricing dial. Positive = a discount off list, '
  'NEGATIVE = sell above list. Replaces v2_catalogs.discount_pct. The '
  'per-customer discount on v2_clients still stacks on top per discount_mode.';

-- Seed each store from its own default catalogue.
update wholesale_v2.v2_wholesalers w
   set discount_pct  = coalesce(c.discount_pct, 0),
       discount_mode = coalesce(c.discount_mode, 'combine')
  from wholesale_v2.v2_catalogs c
 where c.wid = w.wid
   and c.is_default;

-- The store-level twin of v2_catalog_discount_pct.
-- The body below is that function's body with ONE substitution: the pct/mode
-- are read from the store instead of a catalogue. The customer_only fallback
-- (a customer on 0% falls back to the store rate) is preserved exactly --
-- changing it here would silently reprice every such client.
--
-- A NEW NAME, not a defaulted argument on the old one. Migration 113 added a
-- defaulted p_sort to v2_marketplace_feed, which created a SECOND overload
-- rather than replacing it, and PostgREST refused every existing call with
-- PGRST203 until 114 dropped the old signature. The live feed broke instantly.
create or replace function wholesale_v2.v2_store_discount_pct(
  p_wid text, p_client_id uuid
) returns numeric
language plpgsql stable security definer
set search_path to 'wholesale_v2','public'
as $function$
declare
  v_store_pct numeric;
  v_mode      text;
  v_cust_pct  numeric;
begin
  if p_wid is not null then
    select discount_pct, discount_mode into v_store_pct, v_mode
    from wholesale_v2.v2_wholesalers where wid = p_wid;
  end if;

  if p_client_id is not null then
    select discount_pct into v_cust_pct
    from wholesale_v2.v2_clients where id = p_client_id;
  end if;

  v_store_pct := coalesce(v_store_pct, 0);
  v_cust_pct  := coalesce(v_cust_pct, 0);
  v_mode      := coalesce(v_mode, 'combine');

  if v_mode = 'catalog_only' then
    return v_store_pct;
  elsif v_mode = 'customer_only' then
    return case when v_cust_pct = 0 then v_store_pct else v_cust_pct end;
  else
    return v_store_pct + v_cust_pct;
  end if;
end;
$function$;

comment on function wholesale_v2.v2_store_discount_pct(text, uuid) is
  'MOD-05. Store-level twin of v2_catalog_discount_pct. Inert until MOD-04 '
  'switches the buyer reads over.';

-- THE PROOF. For every wholesaler x every client, the store dial must return
-- exactly what that wholesaler's DEFAULT catalogue returns today. If a single
-- pair disagrees, the switch-over would move a price -- so refuse to commit.
do $$
declare
  v_bad int;
  v_pairs int;
begin
  select count(*), count(*) filter (
           where wholesale_v2.v2_store_discount_pct(w.wid, cl.id)
              is distinct from
                 wholesale_v2.v2_catalog_discount_pct(dc.id, cl.id))
    into v_pairs, v_bad
    from wholesale_v2.v2_wholesalers w
    join wholesale_v2.v2_catalogs dc on dc.wid = w.wid and dc.is_default
    cross join wholesale_v2.v2_clients cl;

  if v_bad > 0 then
    raise exception
      'MOD-05: % of % (wholesaler, client) pairs would be repriced. Refusing.',
      v_bad, v_pairs;
  end if;

  raise notice 'MOD-05 ok: % pairs, 0 repriced', v_pairs;
end $$;
