-- Batch 14 -- part 3/3: wiring the new real auth into the two places
-- that most needed it -- order data and buyer onboarding -- plus closing
-- a reservation-visibility gap flagged (in a code comment) since Batch 1.

-- ---------------------------------------------------------------------
-- v2_stock_reservations: migration 001's own comment said "real
-- per-buyer reservation scoping needs actual auth (Batch 14)". Real
-- auth now exists for the wholesaler side (buyers still don't get
-- direct table access at all, by design -- reservations are an
-- internal inventory-holding mechanism, never read directly by the
-- buyer UI). Give the owning wholesaler/owner read visibility; writes
-- stay exclusively through v2_reserve_stock/v2_release_reservation/
-- v2_confirm_reservation (SECURITY DEFINER since Batch 1) -- deny-all
-- for direct writes is intentional, not something this migration opens.
-- ---------------------------------------------------------------------
create policy v2_stock_reservations_admin_read on v2_stock_reservations for select
  using (v2_is_owner() or exists (
    select 1 from v2_product_variants v join v2_products p on p.id = v.product_id
    where v.id = variant_id and p.wid = v2_my_wid()
  ));

-- ---------------------------------------------------------------------
-- v2_get_buyer_orders -- replaces the direct anon `.select()` on
-- v2_orders/v2_order_items that js/data/orders.js used to make (scoped
-- only by a client-supplied wid+buyer_label string, readable by any
-- anon caller who could guess or already knew one -- the exact gap
-- migration 023's header calls out). Now requires a real, active
-- v2_portal_accounts id and returns only that account's own orders.
-- ---------------------------------------------------------------------
create or replace function v2_get_buyer_orders(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_account v2_portal_accounts%rowtype;
  v_result jsonb;
begin
  select * into v_account from v2_portal_accounts
  where id = p_account_id and role = 'buyer' and active = true;

  if v_account.id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(o_row order by o_row.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      o.id, o.status, o.subtotal, o.notes, o.created_at, o.location_id,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'variantId', oi.variant_id,
          'productId', pv.product_id,
          'qty', oi.qty,
          'unitPrice', oi.unit_price,
          'lineTotal', oi.line_total,
          'sku', pv.sku,
          'productName', p.name,
          'color', pv.extra_attrs->>'color',
          'size', pv.extra_attrs->>'size',
          'packId', oi.pack_id,
          'packLineId', oi.pack_line_id,
          'packQty', oi.pack_qty
        )), '[]'::jsonb)
        from v2_order_items oi
        join v2_product_variants pv on pv.id = oi.variant_id
        join v2_products p on p.id = pv.product_id
        where oi.order_id = o.id
      ) as items
    from v2_orders o
    where o.wid = v_account.wid
      and (
        (v_account.client_id is not null and o.client_id = v_account.client_id)
        or (v_account.client_id is null and o.buyer_label = v_account.actor_label)
      )
  ) o_row;

  return v_result;
end;
$$;
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
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_get_buyer_orders'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Buyer order history, scoped to a real v2_portal_accounts id (validated inside, not trusted from the caller beyond "this uuid exists and is an active buyer account"). Returns the same shape js/data/orders.js already builds client-side from two separate queries, so the JS-side mapping code barely changes.');
  end loop;
end $cmt$;
revoke all on function v2_get_buyer_orders(uuid) from public;
grant execute on function v2_get_buyer_orders(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- v2_submit_order: add an optional p_account_id. When provided (every
-- call from the now-real buyer-login flow will provide it), the
-- account's own wid/client_id/actor_label are used and any mismatching
-- p_wid/p_buyer_label/p_client_id the caller also sent are IGNORED --
-- closing the "anyone can submit an order claiming to be any
-- buyer_label" gap. p_account_id is optional and defaults to null so
-- this stays backward compatible during rollout (older cached frontend
-- code, or the transitional period before every buyer has re-logged-in
-- through the new credentialed flow, still works exactly as before).
-- ---------------------------------------------------------------------
create or replace function v2_submit_order(
  p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb,
  p_client_id uuid default null, p_account_id uuid default null
)
returns v2_orders
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order v2_orders;
  v_line record;
  v_product record;
  v_wholesaler record;
  v_subtotal numeric(12,2) := 0;
  v_line_total numeric(12,2);
  v_unit_price numeric(12,2);
  v_is_reorder boolean;
  v_effective_moq int;
  v_total_qty int := 0;
  v_line_count int;
  v_account v2_portal_accounts%rowtype;
begin
  if p_account_id is not null then
    select * into v_account from v2_portal_accounts
    where id = p_account_id and role = 'buyer' and active = true;
    if v_account.id is null then
      raise exception 'invalid or inactive buyer session -- please log in again';
    end if;
    -- Authoritative values come from the account row, not the caller's
    -- own claims, from this point on.
    p_wid := v_account.wid;
    p_client_id := v_account.client_id;
    p_buyer_label := v_account.actor_label;
  end if;

  if jsonb_array_length(p_lines) = 0 then
    raise exception 'cannot submit an empty order';
  end if;

  create temporary table tmp_order_lines on commit drop as
  select
    (l->>'variant_id')::uuid as variant_id,
    (l->>'qty')::integer as qty,
    (l->>'reservation_id')::bigint as reservation_id,
    (l->>'pack_id')::uuid as pack_id,
    (l->>'pack_line_id')::uuid as pack_line_id,
    nullif(l->>'pack_qty', '')::integer as pack_qty,
    pv.product_id as product_id,
    pv.moq_qty as variant_moq_qty,
    pv.sku as sku
  from jsonb_array_elements(p_lines) l
  join v2_product_variants pv on pv.id = (l->>'variant_id')::uuid;

  select jsonb_array_length(p_lines) into v_line_count;
  if (select count(*) from tmp_order_lines) <> v_line_count then
    raise exception 'one or more order lines reference an unknown product variant';
  end if;

  for v_line in select * from tmp_order_lines where qty < variant_moq_qty and pack_line_id is null loop
    raise exception 'SKU % requires a minimum of % units per order (you have %)', v_line.sku, v_line.variant_moq_qty, v_line.qty;
  end loop;

  for v_product in
    select product_id, sum(qty) as agg_qty
    from tmp_order_lines
    group by product_id
  loop
    if p_client_id is not null then
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.client_id = p_client_id and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    else
      select exists (
        select 1 from v2_orders o
        join v2_order_items oi on oi.order_id = o.id
        join v2_product_variants pv on pv.id = oi.variant_id
        where o.wid = p_wid and o.buyer_label = p_buyer_label and pv.product_id = v_product.product_id
      ) into v_is_reorder;
    end if;

    select case when v_is_reorder then coalesce(moq_reorder_qty, moq_qty) else moq_qty end
    into v_effective_moq
    from v2_products where id = v_product.product_id;

    if v_product.agg_qty < v_effective_moq then
      raise exception 'Product requires a minimum of % units total across colours/sizes (% order, you have %)',
        v_effective_moq, case when v_is_reorder then 'reorder' else 'first' end, v_product.agg_qty;
    end if;
  end loop;

  select order_min_qty, order_min_value into v_wholesaler from v2_wholesalers where wid = p_wid;
  select sum(qty) into v_total_qty from tmp_order_lines;
  if v_wholesaler.order_min_qty is not null and v_total_qty < v_wholesaler.order_min_qty then
    raise exception 'This wholesaler requires a minimum order of % units total (you have %)', v_wholesaler.order_min_qty, v_total_qty;
  end if;

  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal)
  values (p_wid, p_buyer_label, p_client_id, p_location_id, 'new', 0)
  returning * into v_order;

  for v_line in
    select tol.*, agg.agg_qty
    from tmp_order_lines tol
    join (select product_id, sum(qty) as agg_qty from tmp_order_lines group by product_id) agg
      on agg.product_id = tol.product_id
  loop
    perform v2_confirm_reservation(v_line.reservation_id, v_order.id, null);

    v_unit_price := v2_effective_unit_price(v_line.product_id, v_line.variant_id, p_client_id, v_line.agg_qty);
    v_line_total := v_line.qty * v_unit_price;
    v_subtotal := v_subtotal + v_line_total;

    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total, pack_id, pack_line_id, pack_qty)
    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total, v_line.pack_id, v_line.pack_line_id, v_line.pack_qty);
  end loop;

  if v_wholesaler.order_min_value is not null and v_subtotal < v_wholesaler.order_min_value then
    raise exception 'This wholesaler requires a minimum order value of % (this order totals %)', v_wholesaler.order_min_value, v_subtotal;
  end if;

  update v2_orders set subtotal = v_subtotal, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;
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
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_submit_order'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Batch 4 original, extended in Batch 14 with an optional p_account_id: when a real buyer session is present, its wid/client_id/actor_label override anything the caller separately claims, closing the identity-spoofing gap the original (still-supported, for backward compatibility) p_wid/p_buyer_label/p_client_id-only call shape had.');
  end loop;
end $cmt$;

-- ---------------------------------------------------------------------
-- Buyer signup requests: v2_submit_signup_request (anon, rate-limited,
-- forces status server-side) + v2_approve_signup_request (owner/
-- wholesaler only, provisions the real v2_clients + v2_portal_accounts
-- rows and returns a one-time generated password).
-- ---------------------------------------------------------------------
create or replace function v2_submit_signup_request(
  p_wid text, p_buyer_name text, p_location text, p_volume text, p_sells text
)
returns table(ok boolean, msg text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rl_ok boolean;
begin
  if p_wid is null or not exists (select 1 from v2_wholesalers where wid = p_wid and active = true) then
    return query select false, 'Unknown or inactive wholesaler';
    return;
  end if;
  if p_buyer_name is null or trim(p_buyer_name) = '' then
    return query select false, 'A shop/buyer name is required';
    return;
  end if;

  -- Rate-limited by wid, not by caller identity (anon callers have none
  -- worth keying on) -- bounds how many pending requests one wholesaler
  -- can be flooded with per hour, independent of source IP rotation.
  v_rl_ok := v2_rate_limit_check('signup_request|' || p_wid, 30, 3600);
  if not v_rl_ok then
    return query select false, 'Too many requests for this wholesaler right now -- please try again later';
    return;
  end if;

  insert into v2_signup_requests (wid, buyer_name, location, volume, sells, status)
  values (p_wid, trim(p_buyer_name), p_location, p_volume, p_sells, 'pending');

  return query select true, '';
end;
$$;
revoke all on function v2_submit_signup_request(text, text, text, text, text) from public;
grant execute on function v2_submit_signup_request(text, text, text, text, text) to anon, authenticated;

create or replace function v2_approve_signup_request(p_id uuid, p_username text default null)
returns table(ok boolean, msg text, username text, temp_password text, client_id uuid, account_id uuid)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_req v2_signup_requests%rowtype;
  v_client_id uuid;
  v_account_id uuid;
  v_username text;
  v_password text;
begin
  select * into v_req from v2_signup_requests where id = p_id for update;
  if v_req.id is null then
    return query select false, 'Signup request not found', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  if not (v2_is_owner() or v2_my_wid() = v_req.wid) then
    return query select false, 'Not authorized', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  if v_req.status = 'approved' then
    return query select false, 'Already approved', null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  insert into v2_clients (wid, shop_name, note, active)
  values (v_req.wid, v_req.buyer_name, trim(both ' ' from concat_ws(' -- ', v_req.location, v_req.volume, v_req.sells)), true)
  returning id into v_client_id;

  v_username := coalesce(nullif(lower(trim(p_username)), ''), lower(regexp_replace(v_req.buyer_name, '[^a-z0-9]+', '', 'gi')) || floor(random() * 900 + 100)::text);
  -- A random 12-character password, generated server-side -- never
  -- chosen by (or visible to) anyone but the approver, exactly once, in
  -- this function's own response. Relayed to the buyer out-of-band
  -- (this build has no transactional email yet, same honest gap as
  -- Batch 12's invite/OAuth flows -- documented, not hidden).
  v_password := encode(gen_random_bytes(9), 'base64');
  v_password := replace(replace(replace(v_password, '/', '2'), '+', '9'), '=', '');

  insert into v2_portal_accounts (wid, role, username, password_hash, client_id, actor_label)
  values (v_req.wid, 'buyer', v_username, crypt(v_password, gen_salt('bf')), v_client_id, v_req.buyer_name)
  returning id into v_account_id;

  update v2_signup_requests set status = 'approved', reviewed_by = coalesce(v2_my_wid(), 'owner'), reviewed_at = now()
  where id = p_id;

  return query select true, '', v_username, v_password, v_client_id, v_account_id;
end;
$$;
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
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_approve_signup_request'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Approving a signup request now actually provisions a real login (v2_clients CRM row + v2_portal_accounts buyer credential), not just a status flip. The generated password is returned exactly once in this call''s response -- there is nowhere it is stored in the clear, and no way to retrieve it again after this response is read (matches v2_create_invite''s one-time-code pattern).');
  end loop;
end $cmt$;
-- See 022_v2_auth_schema.sql's matching comment: `from public` alone
-- doesn't revoke Supabase's default anon grant, only `from public` does
-- (found live during Batch 14's final security sweep, fixed in
-- 025_v2_fix_batch14_grant_hygiene.sql, corrected here to match).
revoke all on function v2_approve_signup_request(uuid, text) from public, anon;
grant execute on function v2_approve_signup_request(uuid, text) to authenticated;
