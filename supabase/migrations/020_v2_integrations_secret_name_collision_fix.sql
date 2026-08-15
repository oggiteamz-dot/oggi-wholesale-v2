-- Fix #2, found immediately while re-verifying fix #1: the vault secret's
-- `name` column has a unique index, and v2_set_integration_secret built a
-- deterministic name ('v2_integration/<wid>/<type>/<secret_name>'). The
-- earlier bug (jsonb_set silently no-op'ing) meant a real vault secret got
-- created successfully on the first attempt, but the config reference to
-- it was lost -- an orphaned-but-real vault row with that exact name.
-- Retrying then hit vault.create_secret's unique-name constraint, because
-- the code never checks "does a secret with this name already exist" --
-- it only checks its OWN config reference. Fix: stop relying on a
-- human-readable deterministic vault name at all -- append a random
-- suffix so every create_secret call is guaranteed unique regardless of
-- prior partial failures, and the config->'secret_refs' pointer is always
-- the single source of truth for which vault row is "the" secret for a
-- given wid/integration_type/secret_name.

create or replace function v2_set_integration_secret(p_wid text, p_integration_type text, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_id uuid;
  v_vault_name text := 'v2_integration/' || p_wid || '/' || p_integration_type || '/' || p_secret_name || '/' || gen_random_uuid()::text;
begin
  insert into v2_integration_settings (wid, integration_type)
    values (p_wid, p_integration_type)
    on conflict (wid, integration_type) do nothing;

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
