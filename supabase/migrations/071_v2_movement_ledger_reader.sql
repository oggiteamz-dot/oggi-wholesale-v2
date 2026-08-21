-- =====================================================================
-- 071 — The stock movement ledger, readable
--
-- v2_inventory_movements has been written correctly by every stock RPC
-- since migration 001 and displayed NOWHERE. 236 rows of real audit
-- trail that no wholesaler could see. This is the read path.
--
-- WHY AN RPC RATHER THAN A CLIENT-SIDE JOIN
-- ---------------------------------------------------------------------
-- The ledger is only useful once a row says what it means: not
-- "variant a3f2... -7" but "Crimson Red / M, Main warehouse, sold, -7,
-- by Zahed". That is four joins. Done in the browser it is four round
-- trips and an N+1 per page; done here it is one query against indexes
-- that already exist.
--
-- It also keeps the filtering server-side. A ledger that fetches
-- everything and filters in JS works fine at 236 rows and dies at
-- 236,000 -- and this table only ever grows, because it is append-only.
-- Paging from the start is not premature: it is the one design decision
-- that cannot be retrofitted cheaply once a wholesaler has real history.
--
-- SCOPE
-- ---------------------------------------------------------------------
-- Derives the caller's wid; only an owner may name someone else's.
-- Migration 069 scoped the table's RLS too, so this is the second lock
-- rather than the only one.
--
-- ON "WHO"
-- ---------------------------------------------------------------------
-- actor_label is resolved from v2_user_profiles where it is known, and
-- returned NULL where it is not. 227 of the 236 existing rows have no
-- actor because until migration 070 only transfers recorded one. The UI
-- says "not recorded" for those. It does not guess, and it does not hide
-- the column -- a wholesaler who sees "not recorded" on old rows and a
-- real name on new ones learns something true about their own history.
-- =====================================================================

drop function if exists wholesale_v2.v2_movement_ledger(uuid,uuid,uuid,text[],timestamptz,int,int,text);

create function wholesale_v2.v2_movement_ledger(
  p_product_id  uuid        default null,
  p_variant_id  uuid        default null,
  p_location_id uuid        default null,
  p_types       text[]      default null,
  p_since       timestamptz default null,
  p_limit       int         default 100,
  p_offset      int         default 0,
  p_wid         text        default null
)
returns table (
  id            bigint,
  created_at    timestamptz,
  movement_type text,
  qty_delta     int,
  product_id    uuid,
  product_name  text,
  variant_id    uuid,
  sku           text,
  color         text,
  size          text,
  location_id   uuid,
  location_name text,
  actor_id      uuid,
  actor_label   text,
  reference_type text,
  reference_id  uuid,
  note          text,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
  v_limit int;
begin
  v_wid := case
             when wholesale_v2.v2_is_owner() and p_wid is not null then p_wid
             else wholesale_v2.v2_my_wid()
           end;
  if v_wid is null then
    return;
  end if;

  -- Hard cap. A caller asking for a million rows is a bug or an attack,
  -- and either way the answer is the same.
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  return query
  with scoped as (
    select m.id, m.created_at, m.movement_type, m.qty_delta,
           p.id as product_id, p.name as product_name,
           v.id as variant_id, v.sku,
           nullif(v.extra_attrs->>'color','') as color,
           nullif(v.extra_attrs->>'size','')  as size,
           m.location_id, l.name as location_name,
           m.actor_id, up.actor_label,
           m.reference_type, m.reference_id, m.note
      from v2_inventory_movements m
      join v2_product_variants v on v.id = m.variant_id
      join v2_products p         on p.id = v.product_id
      left join v2_locations l   on l.id = m.location_id
      left join v2_user_profiles up on up.id = m.actor_id
     where p.wid = v_wid
       and (p_product_id  is null or p.id = p_product_id)
       and (p_variant_id  is null or v.id = p_variant_id)
       and (p_location_id is null or m.location_id = p_location_id)
       and (p_types       is null or m.movement_type = any(p_types))
       and (p_since       is null or m.created_at >= p_since)
  )
  select s.*, count(*) over () as total_count
    from scoped s
   -- id breaks ties so paging is stable when several movements share a
   -- timestamp, which a multi-line receipt always does. Without it, page 2
   -- can repeat or skip a row that page 1 already showed.
   order by s.created_at desc, s.id desc
   limit v_limit offset greatest(coalesce(p_offset,0), 0);
end;
$fn$;

revoke execute on function wholesale_v2.v2_movement_ledger(uuid,uuid,uuid,text[],timestamptz,int,int,text) from public;
revoke execute on function wholesale_v2.v2_movement_ledger(uuid,uuid,uuid,text[],timestamptz,int,int,text) from anon;
grant  execute on function wholesale_v2.v2_movement_ledger(uuid,uuid,uuid,text[],timestamptz,int,int,text) to authenticated;

-- Batch 7 (21 Aug 2026): argument list added. Without it this statement only
-- works while the name is unique, and a replay that ever produces a second
-- overload would stop here -- on a comment. The signature is spelled out
-- rather than resolved at run time because this migration defines the
-- function immediately above, so there is exactly one right answer.
comment on function wholesale_v2.v2_movement_ledger(uuid,uuid,uuid,text[],timestamptz,int,int,text) is
  'Migration 071. Batch 2 read path for the stock movement ledger. Scoped to '
  'the caller''s own wid (owners may name another), filterable by product, '
  'variant, location, type and date, paginated with a hard 500-row cap, and '
  'ordered by (created_at desc, id desc) so paging stays stable when a '
  'multi-line receipt shares one timestamp. Returns total_count via a window '
  'function so the UI can say "50 of 236" without a second query.';
