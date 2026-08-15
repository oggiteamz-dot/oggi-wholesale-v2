-- Fix: jsonb_set's create_missing flag only applies to the LAST path
-- element -- it does NOT create missing intermediate objects. Since
-- v2_integration_settings.config defaulted to '{}'::jsonb (no 'secret_refs'
-- key), the very first call to v2_set_integration_secret for any
-- wholesaler/integration pair silently no-op'd on the config update (no
-- error thrown, no row change) because jsonb_set(...'{secret_refs,X}'...)
-- had no existing 'secret_refs' object to descend into. Caught via a real
-- anon RPC round-trip during Batch 12 verification: v2_has_integration_secret
-- returned null instead of true right after a successful-looking
-- v2_set_integration_secret call.

alter table v2_integration_settings alter column config set default '{"secret_refs":{}}'::jsonb;

update v2_integration_settings
  set config = config || '{"secret_refs":{}}'::jsonb
  where not (config ? 'secret_refs');

create or replace function v2_set_integration_secret(p_wid text, p_integration_type text, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_id uuid;
  v_vault_name text := 'v2_integration/' || p_wid || '/' || p_integration_type || '/' || p_secret_name;
begin
  insert into v2_integration_settings (wid, integration_type)
    values (p_wid, p_integration_type)
    on conflict (wid, integration_type) do nothing;

  -- Defense in depth: guarantee 'secret_refs' exists as an object before
  -- ever attempting the nested jsonb_set below, regardless of whether this
  -- row predates the default-value fix above.
  update v2_integration_settings
    set config = config || '{"secret_refs":{}}'::jsonb
    where wid = p_wid and integration_type = p_integration_type and not (config ? 'secret_refs');

  select (config->'secret_refs'->>p_secret_name)::uuid into v_existing_id
    from v2_integration_settings where wid = p_wid and integration_type = p_integration_type;

  if v_existing_id is not null then
    perform vault.update_secret(v_existing_id, p_secret_value);
  else
    v_existing_id := vault.create_secret(p_secret_value, v_vault_name, 'OGGI v2 integration secret');
    update v2_integration_settings
      set config = jsonb_set(config, array['secret_refs', p_secret_name], to_jsonb(v_existing_id::text), true),
          updated_at = now()
      where wid = p_wid and integration_type = p_integration_type;
  end if;
end;
$$;
revoke all on function v2_set_integration_secret(text, text, text, text) from public;
grant execute on function v2_set_integration_secret(text, text, text, text) to anon, authenticated, service_role;
