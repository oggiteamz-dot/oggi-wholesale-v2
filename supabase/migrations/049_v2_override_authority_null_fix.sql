-- OGGI Wholesale v2 — 048's authority gate returned NULL, and NULL is not false
--
-- This migration exists because 048, written and applied minutes earlier, shipped
-- a hole wider than the one it closed. Recording it as its own migration rather
-- than quietly amending 048 -- the sequence of what was believed, what was
-- tested, and what was actually true is the useful part.
--
-- v2_override_actor_can_act returned NULL for an unauthenticated caller:
--   v2_my_wid() is NULL for anon
--   NULL = p_wid                  -> NULL
--   false or NULL or false        -> NULL
--   (p_wid is not null) and NULL  -> NULL
-- and every call site was written as
--   if not wholesale_v2.v2_override_actor_can_act(...) then <refuse> end if;
-- where `not NULL` is NULL, which is not TRUE, so the refusal branch was never
-- entered and control fell straight through into the work it was guarding.
--
-- The first probe appeared to prove the gate held: it came back "That product
-- and that client belong to different wholesalers." That refusal came from a
-- LATER check, and only because the client and variant picked for the test
-- happened to belong to two different wholesalers. The gate was already open;
-- something downstream was holding the door by accident. Choosing a
-- same-tenant pair -- the ordinary case, not the adversarial one -- returned
-- ok:true and wrote the row. Any holder of the publishable key could set any
-- wholesaler's negotiated prices with a made-up account id.
--
-- Two fixes, deliberately redundant, because either alone would have prevented
-- this and the pair is what prevents its next form:
--   1. the function coalesces to false, making it TOTAL -- every input now
--      yields a real boolean instead of "unknown";
--   2. every call site asks `is not true` rather than `not`, so a NULL from
--      any predicate added later refuses instead of falling through.
-- `<>` on the tenant comparison also becomes `is distinct from`, the same class
-- of trap one line further down.
--
-- The lesson generalises past this table: a security predicate in SQL must be
-- total. Three-valued logic means "unknown" reads as "not false" at an if-not,
-- so any gate that can return NULL is a gate that can be walked through, and it
-- will look like it is working right up until the inputs stop being unusual.
--
-- The full bodies live here rather than as ALTERs so the file can be read on
-- its own; 048's versions are superseded in place by create-or-replace.

set search_path = wholesale_v2, public;

create or replace function wholesale_v2.v2_override_actor_can_act(p_account_id uuid, p_wid text)
returns boolean
language sql
security definer
set search_path = wholesale_v2, public
stable
as $$
  select coalesce(
    p_wid is not null
    and (
      coalesce(wholesale_v2.v2_is_owner(), false)
      or coalesce(wholesale_v2.v2_my_wid() = p_wid, false)
      or exists (
        select 1 from wholesale_v2.v2_portal_accounts a
        where a.id = p_account_id and a.role = 'sales' and a.active and a.wid = p_wid
      )
    ),
  false);
$$;
comment on function wholesale_v2.v2_override_actor_can_act(uuid, text) is
  'The single authority rule for negotiated prices. TOTAL by construction: coalesced to false so it never returns NULL, because a NULL here reads as "not false" at an if-not call site and silently skips the refusal -- which is exactly what it did on 18 Aug 2026 before this fix. p_account_id is only consulted for the sales path and is VALIDATED against v2_portal_accounts (exists, role, active, belongs to this very wid) rather than believed, since the caller supplying it runs as anon and can claim anything.';
revoke all on function wholesale_v2.v2_override_actor_can_act(uuid, text) from public;
grant execute on function wholesale_v2.v2_override_actor_can_act(uuid, text) to anon, authenticated;

create or replace function wholesale_v2.v2_client_overrides_list(p_account_id uuid, p_client_id uuid)
returns table (
  id uuid, variant_id uuid, override_price numeric, note text,
  base_price numeric, sku text, product_name text, color text, size text
)
language plpgsql
security definer
set search_path = wholesale_v2, public
stable
as $$
declare v_wid text;
begin
  select c.wid into v_wid from wholesale_v2.v2_clients c where c.id = p_client_id;
  if v_wid is null or wholesale_v2.v2_override_actor_can_act(p_account_id, v_wid) is not true then
    return;
  end if;

  return query
    select o.id, o.variant_id, o.override_price, o.note,
           v.price, v.sku, p.name,
           v.extra_attrs->>'color', v.extra_attrs->>'size'
    from wholesale_v2.v2_client_price_overrides o
    join wholesale_v2.v2_product_variants v on v.id = o.variant_id
    join wholesale_v2.v2_products p on p.id = v.product_id
    where o.client_id = p_client_id and p.wid = v_wid
    order by o.created_at desc;
end;
$$;
revoke all on function wholesale_v2.v2_client_overrides_list(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_client_overrides_list(uuid, uuid) to anon, authenticated;

create or replace function wholesale_v2.v2_set_client_override(
  p_account_id uuid, p_client_id uuid, p_variant_id uuid,
  p_price numeric, p_note text, p_created_by text
)
returns table (ok boolean, error text, id uuid)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare v_client_wid text; v_variant_wid text; v_id uuid;
begin
  select c.wid into v_client_wid from wholesale_v2.v2_clients c where c.id = p_client_id;
  if v_client_wid is null then
    return query select false, 'That client no longer exists.', null::uuid; return;
  end if;

  if wholesale_v2.v2_override_actor_can_act(p_account_id, v_client_wid) is not true then
    return query select false, 'You are not allowed to price for that client.', null::uuid; return;
  end if;

  select p.wid into v_variant_wid
  from wholesale_v2.v2_product_variants v join wholesale_v2.v2_products p on p.id = v.product_id
  where v.id = p_variant_id;
  if v_variant_wid is null then
    return query select false, 'That product variant no longer exists.', null::uuid; return;
  end if;

  if v_variant_wid is distinct from v_client_wid then
    return query select false, 'That product and that client belong to different wholesalers.', null::uuid; return;
  end if;

  if p_price is null or p_price < 0 then
    return query select false, 'Enter a price of zero or more.', null::uuid; return;
  end if;

  insert into wholesale_v2.v2_client_price_overrides
    (client_id, variant_id, override_price, note, created_by)
  values (p_client_id, p_variant_id, round(p_price, 2), nullif(trim(coalesce(p_note,'')), ''), p_created_by)
  on conflict (client_id, variant_id) do update
    set override_price = excluded.override_price,
        note           = excluded.note,
        created_by     = excluded.created_by
  returning wholesale_v2.v2_client_price_overrides.id into v_id;

  return query select true, null::text, v_id;
end;
$$;
revoke all on function wholesale_v2.v2_set_client_override(uuid, uuid, uuid, numeric, text, text) from public;
grant execute on function wholesale_v2.v2_set_client_override(uuid, uuid, uuid, numeric, text, text) to anon, authenticated;

create or replace function wholesale_v2.v2_remove_client_override(p_account_id uuid, p_id uuid)
returns table (ok boolean, error text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare v_wid text;
begin
  select c.wid into v_wid
  from wholesale_v2.v2_client_price_overrides o
  join wholesale_v2.v2_clients c on c.id = o.client_id
  where o.id = p_id;

  -- Already gone is the outcome the caller wanted, not a failure to report.
  if v_wid is null then
    return query select true, null::text; return;
  end if;

  if wholesale_v2.v2_override_actor_can_act(p_account_id, v_wid) is not true then
    return query select false, 'You are not allowed to change that price.'; return;
  end if;

  delete from wholesale_v2.v2_client_price_overrides where id = p_id;
  return query select true, null::text;
end;
$$;
revoke all on function wholesale_v2.v2_remove_client_override(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_remove_client_override(uuid, uuid) to anon, authenticated;

-- The gate must be TOTAL. This is the assertion that would have caught the bug
-- at apply time rather than at probe time.
do $$
begin
  if wholesale_v2.v2_override_actor_can_act(null, null) is null
     or wholesale_v2.v2_override_actor_can_act(null, 'nope') is null
     or wholesale_v2.v2_override_actor_can_act('00000000-0000-0000-0000-000000000000', 'nope') is null then
    raise exception 'v2_override_actor_can_act can still return NULL.';
  end if;

  if wholesale_v2.v2_override_actor_can_act('00000000-0000-0000-0000-000000000000', 'nope') then
    raise exception 'A non-existent account was granted authority.';
  end if;
end $$;
