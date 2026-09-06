-- Companion fixture for check_store_pricing_dial.sql (MOD-05, migration 117).
--
-- Adds only the pricing columns the dial needs. checks/fixture.sql stays
-- untouched so no existing gate changes behaviour. Load AFTER
-- fixture_public_flag.sql (which creates v2_catalogs).
--
-- It does NOT create v2_wholesalers.discount_pct / discount_mode. Those are
-- what migration 117 is for; creating them here would test the fixture.
set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_clients
  add column if not exists discount_pct numeric default 0;

alter table wholesale_v2.v2_catalogs
  add column if not exists is_default boolean not null default false,
  add column if not exists discount_pct numeric default 0,
  add column if not exists discount_mode text default 'combine';

-- the catalogue-era function the store dial must agree with, byte-for-byte
-- as it runs on production (pg_get_functiondef, 6 Sep 2026)
create or replace function wholesale_v2.v2_catalog_discount_pct(p_catalog_id uuid, p_client_id uuid)
returns numeric language plpgsql stable security definer
set search_path to 'wholesale_v2','public'
as $function$
declare
  v_cat_pct numeric; v_mode text; v_cust_pct numeric;
begin
  if p_catalog_id is not null then
    select discount_pct, discount_mode into v_cat_pct, v_mode
    from wholesale_v2.v2_catalogs where id = p_catalog_id;
  end if;
  if p_client_id is not null then
    select discount_pct into v_cust_pct
    from wholesale_v2.v2_clients where id = p_client_id;
  end if;
  v_cat_pct := coalesce(v_cat_pct, 0);
  v_cust_pct := coalesce(v_cust_pct, 0);
  v_mode := coalesce(v_mode, 'combine');
  if v_mode = 'catalog_only' then return v_cat_pct;
  elsif v_mode = 'customer_only' then
    return case when v_cust_pct = 0 then v_cat_pct else v_cust_pct end;
  else return v_cat_pct + v_cust_pct; end if;
end;
$function$;
