-- =============================================================================
-- 047 — MULTIPLE LOCATIONS, AND MOVING STOCK BETWEEN THEM
-- =============================================================================
-- 18 Aug 2026. Hadi: "add multiple locations to wholesalers".
--
-- WHAT ALREADY EXISTED, AND WHAT DID NOT
-- --------------------------------------
-- Checked before writing a line of this:
--
--   * v2_inventory_balances is keyed on (variant_id, location_id). Stock has
--     been per-location in the DATA since migration 001.
--   * v2_inventory_movements.movement_type already permits 'transfer_out' and
--     'transfer_in'.
--   * v2_locations exists, with wid / name / is_default / archived.
--
-- So none of this is a schema redesign. What was missing is everything above
-- the data: NO interface anywhere creates a location, and no function moves
-- stock between two. The regression ledger's item #17 put it exactly right --
-- "the only transfer tokens in the entire repo are the enum values on one
-- line. No function, RPC or UI. An enum value is not a feature."
--
-- WHY THE WRITES ARE FUNCTIONS AND NOT TABLE GRANTS
-- -------------------------------------------------
-- Every rule below is one that has to hold no matter which screen is calling:
-- a wholesaler must always have at least one active location (migration 043
-- exists because one did not), exactly one default, and stock must never be
-- moved out of a location that does not have it available. Enforcing that in
-- the browser means enforcing it once per screen and hoping. These are
-- SECURITY DEFINER, so the check on the first line of each IS the access
-- control -- not decoration.
--
-- A NOTE ON WHAT "ENOUGH STOCK" MEANS FOR A TRANSFER
-- --------------------------------------------------
-- v2_decrement_stock guards on `qty_on_hand >= p_qty`. That is right for a
-- sale, which consumes a reservation that was already made. It is WRONG for a
-- transfer: reserved units are promised to a buyer whose cart is open, and
-- moving them to another warehouse would leave that promise pointing at an
-- empty shelf. So the transfer checks AVAILABLE -- on hand minus reserved --
-- and says so in its error rather than moving what it should not.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Exactly one default per wholesaler, enforced by the database
-- ---------------------------------------------------------------------
-- Migration 043 repaired the wholesalers that had no default and promoted the
-- oldest where one was ambiguous, but it never stopped a SECOND default being
-- created. "At most one" is a fact about the data and belongs here, not in
-- whichever screen happens to set the flag.
create unique index if not exists v2_locations_one_default
  on wholesale_v2.v2_locations (wid) where is_default and not archived;

create index if not exists v2_locations_by_wid_active
  on wholesale_v2.v2_locations (wid, archived, name);

-- ---------------------------------------------------------------------
-- 2. Lock the table down, the way 042 did for v2_wholesalers
-- ---------------------------------------------------------------------
-- The read policy was `using (true)` and both browser roles held table-wide
-- INSERT/UPDATE/DELETE. A location name is not as sensitive as a phone number,
-- but the roster of a wholesaler's warehouses is still their business and
-- nobody else's -- and the write grants let any signed-in wholesaler edit
-- another's, which the policies happened to catch and the grants should never
-- have offered.
revoke all on wholesale_v2.v2_locations from anon;
revoke all on wholesale_v2.v2_locations from authenticated;

grant select (id, wid, name, is_default, archived, created_at)
  on wholesale_v2.v2_locations to authenticated;
-- No INSERT/UPDATE/DELETE for anyone: every write goes through the functions
-- below, so the "at least one active" and "exactly one default" rules cannot
-- be sidestepped by writing the table directly.

drop policy if exists v2_locations_read on wholesale_v2.v2_locations;
create policy v2_locations_read_scoped on wholesale_v2.v2_locations
  for select
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

-- The write policies from 023 are now unreachable (no write grants remain) but
-- are left in place: if a future migration ever re-grants a write, they are the
-- second line of defence rather than nothing.

-- ---------------------------------------------------------------------
-- 3. The one door anon needs
-- ---------------------------------------------------------------------
-- js/views/buyer.js reads exactly one thing: its own wholesaler's default
-- location id and name, for pickup/delivery wording. Exact id in, one row out,
-- two columns -- the same shape as v2_public_wholesaler(p_wid) in 042.
create or replace function wholesale_v2.v2_public_default_location(p_wid text)
returns table (id uuid, name text)
language sql
security definer
set search_path = wholesale_v2, public
stable
as $$
  select l.id, l.name
  from wholesale_v2.v2_locations l
  where l.wid = p_wid and l.is_default and not l.archived
  limit 1;
$$;
comment on function wholesale_v2.v2_public_default_location(text) is
  'The ONLY read path into v2_locations for the anon role. Buyers and sales reps authenticate through v2_portal_accounts so auth.uid() is NULL for them and no row policy can scope their read -- exactly as with v2_wholesalers in migration 042.';
revoke all on function wholesale_v2.v2_public_default_location(text) from public;
grant execute on function wholesale_v2.v2_public_default_location(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Managing locations
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_create_location(p_wid text, p_name text)
returns table (ok boolean, error text, id uuid)
language plpgsql security definer set search_path = wholesale_v2, public
as $$
declare v_name text; v_id uuid; v_first boolean;
begin
  perform wholesale_v2.v2_require_owner_or_own(p_wid);   -- THE access control

  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then
    return query select false, 'Give the location a name.', null::uuid; return;
  end if;
  if exists (select 1 from wholesale_v2.v2_locations l
             where l.wid = p_wid and not l.archived and lower(l.name) = lower(v_name)) then
    return query select false, format('You already have a location called "%s".', v_name), null::uuid; return;
  end if;

  -- The first location a wholesaler has must be the default, or they end up
  -- with locations and nothing to receive into -- the state migration 043 had
  -- to repair.
  v_first := not exists (select 1 from wholesale_v2.v2_locations l
                         where l.wid = p_wid and not l.archived);

  insert into wholesale_v2.v2_locations (wid, name, is_default, archived)
  values (p_wid, v_name, v_first, false)
  returning wholesale_v2.v2_locations.id into v_id;

  return query select true, ''::text, v_id;
end; $$;

create or replace function wholesale_v2.v2_rename_location(p_location_id uuid, p_name text)
returns table (ok boolean, error text)
language plpgsql security definer set search_path = wholesale_v2, public
as $$
declare v_wid text; v_name text;
begin
  select l.wid into v_wid from wholesale_v2.v2_locations l where l.id = p_location_id;
  if v_wid is null then return query select false, 'That location does not exist.'; return; end if;
  perform wholesale_v2.v2_require_owner_or_own(v_wid);

  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then return query select false, 'A location needs a name.'; return; end if;
  if exists (select 1 from wholesale_v2.v2_locations l
             where l.wid = v_wid and l.id <> p_location_id and not l.archived
               and lower(l.name) = lower(v_name)) then
    return query select false, format('You already have a location called "%s".', v_name); return;
  end if;

  update wholesale_v2.v2_locations set name = v_name where id = p_location_id;
  return query select true, ''::text;
end; $$;

create or replace function wholesale_v2.v2_set_default_location(p_location_id uuid)
returns table (ok boolean, error text)
language plpgsql security definer set search_path = wholesale_v2, public
as $$
declare v_wid text; v_archived boolean;
begin
  select l.wid, l.archived into v_wid, v_archived
    from wholesale_v2.v2_locations l where l.id = p_location_id;
  if v_wid is null then return query select false, 'That location does not exist.'; return; end if;
  perform wholesale_v2.v2_require_owner_or_own(v_wid);
  if v_archived then
    return query select false, 'That location is archived. Restore it before making it the default.'; return;
  end if;

  -- Clear first, then set. The partial unique index would reject the other
  -- order, and doing it in one statement per side keeps both inside this
  -- function's transaction so there is never a moment with zero defaults.
  update wholesale_v2.v2_locations set is_default = false
    where wid = v_wid and is_default and id <> p_location_id;
  update wholesale_v2.v2_locations set is_default = true where id = p_location_id;
  return query select true, ''::text;
end; $$;

create or replace function wholesale_v2.v2_archive_location(p_location_id uuid)
returns table (ok boolean, error text)
language plpgsql security definer set search_path = wholesale_v2, public
as $$
declare v_wid text; v_default boolean; v_active int; v_units bigint;
begin
  select l.wid, l.is_default into v_wid, v_default
    from wholesale_v2.v2_locations l where l.id = p_location_id and not l.archived;
  if v_wid is null then return query select false, 'That location does not exist, or is already archived.'; return; end if;
  perform wholesale_v2.v2_require_owner_or_own(v_wid);

  select count(*) into v_active from wholesale_v2.v2_locations l
    where l.wid = v_wid and not l.archived;
  if v_active <= 1 then
    -- Migration 043 exists because a wholesaler with no location cannot
    -- receive a single unit of stock. Do not recreate that state.
    return query select false, 'This is your only location. Create another one before archiving this.'; return;
  end if;

  -- REFUSES rather than moving the stock somewhere on the wholesaler's behalf.
  -- v1's deleteLocation merged into the default and that step was a confirmed
  -- corruption risk in its own deploy record. Where the stock should go is a
  -- decision with money attached; the software should not make it quietly.
  select coalesce(sum(b.qty_on_hand), 0) into v_units
    from wholesale_v2.v2_inventory_balances b where b.location_id = p_location_id;
  if v_units > 0 then
    return query select false, format(
      'There are still %s unit(s) here. Transfer them to another location first — nothing will be moved for you.', v_units);
    return;
  end if;

  update wholesale_v2.v2_locations set archived = true, is_default = false where id = p_location_id;

  -- Archiving the default leaves the wholesaler without one, which is the
  -- exact fault 043 repaired. Promote the oldest survivor immediately.
  if v_default then
    update wholesale_v2.v2_locations set is_default = true
      where id = (select l.id from wholesale_v2.v2_locations l
                  where l.wid = v_wid and not l.archived
                  order by l.created_at asc limit 1);
  end if;

  return query select true, ''::text;
end; $$;

-- ---------------------------------------------------------------------
-- 5. Moving stock
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_transfer_stock(
  p_variant_id uuid, p_from_location uuid, p_to_location uuid,
  p_qty integer, p_note text default null
)
returns table (ok boolean, error text, from_on_hand integer, to_on_hand integer)
language plpgsql security definer set search_path = wholesale_v2, public
as $$
declare
  v_wid text; v_from_wid text; v_to_wid text;
  v_on_hand int; v_reserved int; v_avail int;
  v_from_row wholesale_v2.v2_inventory_balances;
  v_to_row   wholesale_v2.v2_inventory_balances;
begin
  if p_qty is null or p_qty <= 0 then
    return query select false, 'Enter how many units to move.', null::int, null::int; return;
  end if;
  if p_from_location = p_to_location then
    return query select false, 'Pick two different locations.', null::int, null::int; return;
  end if;

  -- Which wholesaler owns the variant, via its product.
  select p.wid into v_wid
    from wholesale_v2.v2_product_variants v
    join wholesale_v2.v2_products p on p.id = v.product_id
   where v.id = p_variant_id;
  if v_wid is null then
    -- Covers both "no such id" and "not yours", truthfully, and deliberately
    -- does NOT tell them apart: distinguishing the two turns this function
    -- into an oracle for probing which variant ids exist in other tenants.
    return query select false, 'That product variant does not exist, or belongs to a different wholesaler.', null::int, null::int; return;
  end if;

  perform wholesale_v2.v2_require_owner_or_own(v_wid);   -- THE access control

  select l.wid into v_from_wid from wholesale_v2.v2_locations l where l.id = p_from_location and not l.archived;
  select l.wid into v_to_wid   from wholesale_v2.v2_locations l where l.id = p_to_location   and not l.archived;
  if v_from_wid is null or v_to_wid is null then
    return query select false, 'One of those locations does not exist, or is archived.', null::int, null::int; return;
  end if;
  -- Both ends must belong to the same wholesaler as the stock. Without this,
  -- a wholesaler could move their own units into somebody else's warehouse.
  if v_from_wid is distinct from v_wid or v_to_wid is distinct from v_wid then
    return query select false, 'Those locations belong to a different wholesaler.', null::int, null::int; return;
  end if;

  -- Lock the source row for the rest of the transaction so two transfers of
  -- the same variant cannot each see enough stock and both succeed.
  select b.qty_on_hand, b.qty_reserved into v_on_hand, v_reserved
    from wholesale_v2.v2_inventory_balances b
   where b.variant_id = p_variant_id and b.location_id = p_from_location
   for update;

  if v_on_hand is null then
    return query select false, 'There is no stock of that variant at the source location.', null::int, null::int; return;
  end if;

  -- AVAILABLE, not on-hand. Reserved units belong to an open cart; moving them
  -- would leave that reservation pointing at an empty shelf. See the header.
  v_avail := v_on_hand - coalesce(v_reserved, 0);
  if v_avail < p_qty then
    return query select false, format(
      'Only %s available to move (%s on hand, %s reserved for open carts).',
      v_avail, v_on_hand, coalesce(v_reserved, 0)), null::int, null::int;
    return;
  end if;

  v_from_row := wholesale_v2.v2_decrement_stock(
    p_variant_id, p_from_location, p_qty, 'transfer_out', 'transfer', null, auth.uid(),
    coalesce(p_note, 'Transfer out'));
  if v_from_row is null then
    -- Should be unreachable given the check above; if it ever fires, something
    -- changed underneath the lock and the whole transaction must roll back
    -- rather than book a half transfer.
    raise exception 'Transfer failed while removing stock from the source location';
  end if;

  -- The destination leg is written HERE rather than delegated to
  -- v2_receive_stock, which hardcodes movement_type = 'receive'. Calling it
  -- logged a warehouse move as a supplier receipt: the ledger balanced
  -- (-12 / +12) but told the wrong story, and every report built on it --
  -- receipts, velocity, GMROI, days-of-cover -- would count internal movement
  -- as new stock arriving. 'transfer_in' is in the movement_type CHECK
  -- precisely for this.
  --
  -- This is still the RPC layer writing the balance, which is where balance
  -- writes belong. The standing rule from 001 is that the BROWSER never writes
  -- v2_inventory_balances directly, and it still does not.
  insert into wholesale_v2.v2_inventory_balances (variant_id, location_id, qty_on_hand, qty_reserved, updated_at)
  values (p_variant_id, p_to_location, p_qty, 0, now())
  on conflict (variant_id, location_id)
    do update set qty_on_hand = v2_inventory_balances.qty_on_hand + excluded.qty_on_hand,
                  updated_at = now()
  returning * into v_to_row;

  insert into wholesale_v2.v2_inventory_movements
    (variant_id, location_id, movement_type, qty_delta, reference_type, reference_id, actor_id, note)
  values (p_variant_id, p_to_location, 'transfer_in', p_qty, 'transfer', null, auth.uid(),
          coalesce(p_note, 'Transfer in'));

  return query select true, ''::text, v_from_row.qty_on_hand, v_to_row.qty_on_hand;
end; $$;

comment on function wholesale_v2.v2_transfer_stock(uuid, uuid, uuid, integer, text) is
  'Moves stock between two of ONE wholesaler''s locations, in a single transaction, writing transfer_out and transfer_in so the ledger explains the move. Checks AVAILABLE (on hand minus reserved), not on hand: reserved units are promised to an open cart.';

-- ---------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------
revoke all on function wholesale_v2.v2_create_location(text, text)          from public, anon;
revoke all on function wholesale_v2.v2_rename_location(uuid, text)          from public, anon;
revoke all on function wholesale_v2.v2_set_default_location(uuid)           from public, anon;
revoke all on function wholesale_v2.v2_archive_location(uuid)               from public, anon;
revoke all on function wholesale_v2.v2_transfer_stock(uuid,uuid,uuid,integer,text) from public, anon;

grant execute on function wholesale_v2.v2_create_location(text, text)       to authenticated;
grant execute on function wholesale_v2.v2_rename_location(uuid, text)       to authenticated;
grant execute on function wholesale_v2.v2_set_default_location(uuid)        to authenticated;
grant execute on function wholesale_v2.v2_archive_location(uuid)            to authenticated;
grant execute on function wholesale_v2.v2_transfer_stock(uuid,uuid,uuid,integer,text) to authenticated;


-- ---------------------------------------------------------------------
-- 7. Amending the shared guard's message (introduced in 044)
-- ---------------------------------------------------------------------
-- v2_require_owner_or_own was written for the analytics functions and raised
-- "You can only read your own figures". Every function above reuses it, so a
-- wholesaler trying to CREATE A LOCATION for someone else was refused with a
-- sentence about reading figures.
--
-- The refusal was right and the sentence was wrong, which is its own kind of
-- bug: a refusal that names the wrong action reads as a broken app rather than
-- as "you tried to do something you should not". Found by running the
-- cross-tenant tests and reading the messages instead of only the pass/fail.
create or replace function wholesale_v2.v2_require_owner_or_own(p_wid text)
returns void
language plpgsql
security definer
set search_path = wholesale_v2, public
as $guard$
begin
  if wholesale_v2.v2_is_owner() then
    return;
  end if;
  -- v2_my_wid() reads v2_user_profiles by auth.uid(). Derived from the token,
  -- never from anything the caller sends. The NULL check is NOT redundant:
  -- buyers/sales run as anon with auth.uid() NULL, so v2_my_wid() is NULL,
  -- `NULL = p_wid` is NULL, `not NULL` is NULL, and an IF on NULL takes the
  -- else branch -- which would have let them straight through.
  if wholesale_v2.v2_my_wid() is null or wholesale_v2.v2_my_wid() is distinct from p_wid then
    raise exception 'That belongs to a different wholesaler. You can only see and change your own.'
      using errcode = '42501';
  end if;
end;
$guard$;

comment on function wholesale_v2.v2_require_owner_or_own(text) is
  'Raises unless the caller is the platform owner, or is the wholesaler whose wid was passed. Called first in the analytics functions (039/044) and in every location/transfer function (047) -- all SECURITY DEFINER, so this check IS their access control. The message is deliberately generic: it guards reads AND writes, and a refusal that names the wrong action reads as a broken app.';
