-- OGGI Wholesale v2 — Batch 16: negotiated prices stop leaking, and the
-- salesperson's screen starts working
--
-- Three separate problems on one table, all found by reading migration 023's
-- own confession and then testing what it left behind.
--
-- 1) READS WERE OPEN TO EVERYONE. 023 wrote:
--        create policy v2_client_price_overrides_read ... using (true)
--    and attached an honest comment saying so and why it was deferred. That
--    deferral is now ~a hundred migrations old. The table holds per-client
--    NEGOTIATED PRICING -- what each individual shop pays -- so `using (true)`
--    means any holder of the publishable key reads every wholesaler's private
--    price list for every one of their clients. Verified against production
--    before writing this: the anon role got a 200 and a row array back, not a
--    refusal. It returned [] only because the table is empty today. This
--    migration lands before it ever holds a row.
--
-- 2) THE WRITES WERE ALREADY BROKEN FOR THE ONLY ROLE THAT USES THEM. The
--    salesperson screen (js/views/salesperson.js) sets and removes these
--    overrides. Sales reps authenticate through v2_portal_accounts, so they
--    run as anon with auth.uid() NULL -- which makes v2_my_wid() NULL and
--    v2_is_owner() false, so 023's scoped INSERT/UPDATE/DELETE policies can
--    never pass for them. Tested rather than assumed: the insert comes back
--    42501 "new row violates row-level security policy". That screen has
--    never worked. Nobody noticed because no sales accounts exist yet.
--
--    So tightening reads alone would have left the table locked in both
--    directions. The two problems share one root cause -- anon cannot be
--    scoped by ANY row policy -- and therefore share one fix.
--
-- 3) THE WRITE POLICIES CHECK THE VARIANT AND NEVER THE CLIENT. 023 scopes
--    writes by variant -> product.wid and says nothing about client_id, so a
--    wholesaler could attach one of THEIR variants to ANOTHER tenant's client.
--    The row would then be visible to that other tenant under the scoped read
--    added below, pointing at a product they do not own. An override is a pair
--    and only means anything when both halves belong to the same wholesaler;
--    that is now enforced on every path, policy and function alike.
--
-- The shape of the fix follows the house pattern already set by
-- v2_get_buyer_orders (Batch 14) rather than inventing a new one: a SECURITY
-- DEFINER function that INDEPENDENTLY VALIDATES a real, active
-- v2_portal_accounts id instead of trusting the caller's claim about who they
-- are. That is materially stronger than the exact-id functions used for
-- v2_wholesalers and v2_locations (042, 047), where knowing a uuid is the
-- whole credential -- appropriate there for a shop's public name, not for a
-- price list. The buyer function below goes further still and takes NO client
-- parameter at all: it reads the client off the account row, so a buyer cannot
-- even ask the question "what does some other shop pay?".

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Reads: scoped for authenticated, closed entirely for anon
-- ---------------------------------------------------------------------
drop policy if exists v2_client_price_overrides_read on v2_client_price_overrides;

-- Scoped by the CLIENT's wid. A row whose client belongs to me is mine to
-- read; combined with the write rules below (which additionally demand the
-- variant be mine too) the two halves can never disagree.
create policy v2_client_price_overrides_read_scoped on v2_client_price_overrides
  for select using (
    v2_is_owner()
    or exists (select 1 from v2_clients c where c.id = client_id and c.wid = v2_my_wid())
  );
comment on policy v2_client_price_overrides_read_scoped on v2_client_price_overrides is
  'Replaces 023''s using(true). Applies to the authenticated role only -- owners and wholesalers. The anon role has no table access at all (revoked below) because auth.uid() is NULL for portal logins and no row policy can distinguish one anon caller from another; anon reads go through v2_buyer_price_overrides / v2_sales_client_overrides instead.';

-- ---------------------------------------------------------------------
-- 2. Writes: both halves of the pair must belong to the same wholesaler
-- ---------------------------------------------------------------------
-- The variant condition is 023's, unchanged. The client condition is new and
-- is the actual fix: without it the pair can straddle two tenants.
drop policy if exists v2_client_price_overrides_write_scoped  on v2_client_price_overrides;
drop policy if exists v2_client_price_overrides_update_scoped on v2_client_price_overrides;
drop policy if exists v2_client_price_overrides_delete_scoped on v2_client_price_overrides;

create policy v2_client_price_overrides_insert_scoped on v2_client_price_overrides
  for insert with check (
    v2_is_owner() or (
      exists (select 1 from v2_clients c where c.id = client_id and c.wid = v2_my_wid())
      and exists (
        select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
        where v.id = variant_id and p.wid = v2_my_wid()
      )
    )
  );

create policy v2_client_price_overrides_update_scoped on v2_client_price_overrides
  for update using (
    v2_is_owner() or exists (select 1 from v2_clients c where c.id = client_id and c.wid = v2_my_wid())
  ) with check (
    v2_is_owner() or (
      exists (select 1 from v2_clients c where c.id = client_id and c.wid = v2_my_wid())
      and exists (
        select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
        where v.id = variant_id and p.wid = v2_my_wid()
      )
    )
  );

create policy v2_client_price_overrides_delete_scoped on v2_client_price_overrides
  for delete using (
    v2_is_owner() or exists (select 1 from v2_clients c where c.id = client_id and c.wid = v2_my_wid())
  );

-- anon can never be scoped, so it gets nothing. This is the same conclusion
-- 042 reached for v2_wholesalers and 047 for v2_locations.
revoke all on wholesale_v2.v2_client_price_overrides from anon;

-- ---------------------------------------------------------------------
-- 3. One authority rule, asked by every function below
-- ---------------------------------------------------------------------
-- Three kinds of actor can legitimately manage a wholesaler's negotiated
-- prices: the platform owner, the wholesaler themselves (authenticated), and
-- one of their sales reps (a portal account, running as anon). Writing that
-- rule once means the three cannot drift apart, which is exactly how the
-- variant-but-not-client hole above came to exist.
create or replace function wholesale_v2.v2_override_actor_can_act(p_account_id uuid, p_wid text)
returns boolean
language sql
security definer
set search_path = wholesale_v2, public
stable
as $$
  select
    p_wid is not null
    and (
      wholesale_v2.v2_is_owner()
      or wholesale_v2.v2_my_wid() = p_wid
      or exists (
        select 1 from wholesale_v2.v2_portal_accounts a
        where a.id = p_account_id and a.role = 'sales' and a.active and a.wid = p_wid
      )
    );
$$;
comment on function wholesale_v2.v2_override_actor_can_act(uuid, text) is
  'The single authority rule for negotiated prices. p_account_id is only consulted for the sales path and is VALIDATED against v2_portal_accounts (exists, role, active, and belongs to this very wid) rather than believed -- the caller supplying it runs as anon and can claim anything. An authenticated owner/wholesaler is authorised by their JWT and ignores p_account_id entirely.';
revoke all on function wholesale_v2.v2_override_actor_can_act(uuid, text) from public;
grant execute on function wholesale_v2.v2_override_actor_can_act(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. The buyer's own prices -- no client parameter, on purpose
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_buyer_price_overrides(p_account_id uuid)
returns table (variant_id uuid, override_price numeric)
language plpgsql
security definer
set search_path = wholesale_v2, public
stable
as $$
declare v_account wholesale_v2.v2_portal_accounts%rowtype;
begin
  select * into v_account from wholesale_v2.v2_portal_accounts
  where id = p_account_id and role = 'buyer' and active;

  -- No account, or an account not tied to a CRM client, means no negotiated
  -- prices apply. Returning empty rather than raising matches
  -- v2_get_buyer_orders: a buyer browsing a wholesaler they have no
  -- credentials with is a normal state, not an error, and the correct answer
  -- for them is "you have no overrides" -- which is also the safe default.
  if v_account.id is null or v_account.client_id is null then
    return;
  end if;

  return query
    select o.variant_id, o.override_price
    from wholesale_v2.v2_client_price_overrides o
    join wholesale_v2.v2_clients c on c.id = o.client_id
    join wholesale_v2.v2_product_variants v on v.id = o.variant_id
    join wholesale_v2.v2_products p on p.id = v.product_id
    where o.client_id = v_account.client_id
      -- Belt and braces: even for the buyer's own client, only surface rows
      -- whose product actually belongs to the same wholesaler. A pre-existing
      -- straddling row (possible before this migration) must not be priced
      -- into anyone's cart.
      and c.wid = v_account.wid
      and p.wid = v_account.wid;
end;
$$;
comment on function wholesale_v2.v2_buyer_price_overrides(uuid) is
  'The ONLY read path into v2_client_price_overrides for a buyer. Takes no client_id: the client is read off the validated account row, so the strongest thing a buyer can ask is "what do I pay", never "what does that shop pay". Replaces a direct .eq("client_id", ...) select that any holder of the publishable key could have re-pointed at any client.';
revoke all on function wholesale_v2.v2_buyer_price_overrides(uuid) from public;
grant execute on function wholesale_v2.v2_buyer_price_overrides(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. The management surface: list / set / remove
-- ---------------------------------------------------------------------
-- A rep serves many clients, so this one does take a client id -- constrained
-- to the wid the actor is authorised for, which is the point of the check.
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
  if v_wid is null or not wholesale_v2.v2_override_actor_can_act(p_account_id, v_wid) then
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

  if not wholesale_v2.v2_override_actor_can_act(p_account_id, v_client_wid) then
    return query select false, 'You are not allowed to price for that client.', null::uuid; return;
  end if;

  select p.wid into v_variant_wid
  from wholesale_v2.v2_product_variants v join wholesale_v2.v2_products p on p.id = v.product_id
  where v.id = p_variant_id;
  if v_variant_wid is null then
    return query select false, 'That product variant no longer exists.', null::uuid; return;
  end if;

  -- THE cross-tenant guard. Both halves of the pair, or neither.
  if v_variant_wid <> v_client_wid then
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
comment on function wholesale_v2.v2_set_client_override(uuid, uuid, uuid, numeric, text, text) is
  'Restores the salesperson screen, which has been refused by RLS since 023 because reps run as anon. The tenant of the CLIENT is resolved first and everything else is checked against it -- including the variant, so an override can never straddle two wholesalers.';
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

  if not wholesale_v2.v2_override_actor_can_act(p_account_id, v_wid) then
    return query select false, 'You are not allowed to change that price.'; return;
  end if;

  delete from wholesale_v2.v2_client_price_overrides where id = p_id;
  return query select true, null::text;
end;
$$;
revoke all on function wholesale_v2.v2_remove_client_override(uuid, uuid) from public;
grant execute on function wholesale_v2.v2_remove_client_override(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Refuse to land quietly if the shape is not what this migration assumed
-- ---------------------------------------------------------------------
do $$
declare v_open int; v_anon int;
begin
  select count(*) into v_open from pg_policies
  where schemaname = 'wholesale_v2' and tablename = 'v2_client_price_overrides' and qual = 'true';
  if v_open > 0 then
    raise exception 'A using(true) policy still exists on v2_client_price_overrides (% found).', v_open;
  end if;

  select count(*) into v_anon from information_schema.role_table_grants
  where table_schema = 'wholesale_v2' and table_name = 'v2_client_price_overrides' and grantee = 'anon';
  if v_anon > 0 then
    raise exception 'anon still holds % grant(s) on v2_client_price_overrides.', v_anon;
  end if;
end $$;
