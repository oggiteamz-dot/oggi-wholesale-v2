-- 121 — CNT-00: one delivery, one transaction, and the count check on the SERVER
--
-- WHAT THIS IS FOR
-- Receiving a style in 4 colours and 4 sizes means sixteen calls to
-- v2_receive_stock. Sixteen round trips from a browser is not atomic: close
-- the laptop at box nine and the warehouse holds nine boxes of a delivery that
-- nothing anywhere records as half-done. js/data/size-ratios.js already states
-- this rule for v2_apply_ratio -- "not a loop in this file... that would be
-- several round-trips that can half-fail" -- and receiving is the same shape
-- with worse consequences, because stock is what every other number is
-- derived from.
--
-- THE COUNT CHECK BELONGS HERE, NOT ONLY ON THE SCREEN
-- CNT-03 says save is BLOCKED while the breakdown does not equal what the
-- vendor billed. A disabled button is a UI state; it is not a rule. The screen
-- enforces it so the person is never surprised, and this function enforces it
-- so the rule survives a second screen, a phone with stale JavaScript, a
-- script, or a future import path that nobody has written yet.
--
-- The two numbers are never compared by hand and never typed twice. The caller
-- sends the breakdown and the billed figure; the server adds the breakdown up
-- itself and refuses if they disagree. There is no override argument, on
-- purpose: CNT-10 (a short delivery accepted with a typed reason, written to
-- the audit log) is a separate feature and a separate decision for Hadi, and
-- an override parameter added "for later" is an override somebody uses today.
--
-- THE TENANT BOUNDARY, WHICH v2_receive_stock DOES NOT HAVE
-- ⚠ v2_receive_stock is SECURITY DEFINER, granted to `anon`, and checks
-- nothing: it takes a variant id and a location id from the caller and adds
-- stock. That is a real hole and it is NOT fixed here -- revoking a grant the
-- live app may depend on is not a change to make unattended. It is recorded in
-- checks/GATE-EVIDENCE.md for Hadi. What this migration does is refuse to
-- REPEAT it: every variant must belong to the same wholesaler as the location,
-- and that wholesaler must be the caller's own (or the caller an OGGI owner).
--
-- APPLIED AND VERIFIED: see checks/check_receive_count.sql, which brings its
-- own fixture and is proven red four ways.

-- DROP before CREATE, deliberately. `create or replace` cannot change a
-- function's OUT columns -- "cannot change return type of existing function" --
-- so a replay onto a database that already holds an older shape of this
-- function would fail at exactly the point nobody is watching. The drop names
-- the full signature, so it cannot take a different overload with it.
drop function if exists wholesale_v2.v2_receive_product(uuid, jsonb, integer, text);

create function wholesale_v2.v2_receive_product(
  p_location_id   uuid,
  p_lines         jsonb,     -- [{"variant_id": "...", "qty": 12}, ...]
  p_billed_pieces integer,
  p_note          text default null
) returns table(variant_id uuid, qty integer, on_hand integer)
language plpgsql
security definer
set search_path to 'wholesale_v2', 'public'
as $function$
declare
  v_wid       text;
  v_total     integer;
  v_lines     integer;
  v_bad       integer;
  v_note      text;
begin
  ------------------------------------------------------------------ the door
  if p_location_id is null then
    raise exception 'receive: no warehouse was named';
  end if;

  select l.wid into v_wid
    from wholesale_v2.v2_locations l
   where l.id = p_location_id and not l.archived;

  if v_wid is null then
    raise exception 'receive: that warehouse does not exist';
  end if;

  -- THE TENANT BOUNDARY. Deliberately the first thing after resolving the
  -- warehouse, and deliberately its own statement rather than folded into a
  -- later join: a boundary hidden inside a where-clause is a boundary someone
  -- optimises away.
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() is not distinct from v_wid) then
    raise exception 'receive: that warehouse is not yours';
  end if;

  --------------------------------------------------------------- the shape
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'receive: no lines were sent';
  end if;

  -- Column names deliberately NOT variant_id / qty: those are the names of
  -- this function's OUT parameters, and PL/pgSQL resolves a bare identifier to
  -- the variable, not the column. Postgres calls that "column reference is
  -- ambiguous" and it is an error, not a silent wrong answer -- but only
  -- because the shapes happened to clash. Prefixed names remove the question.
  -- Migration 077's lesson, applied here: an "on commit drop" temp table is
  -- still standing on a SECOND call inside one transaction, which is what
  -- makes a function untestable. Created once and emptied thereafter --
  -- `create ... if not exists` would do the same job while printing a NOTICE
  -- on every call after the first, and a function that shouts on the happy
  -- path teaches people to stop reading its output.
  if to_regclass('pg_temp.tmp_receive_lines') is null then
    create temporary table tmp_receive_lines
      (line_variant uuid, line_qty integer) on commit drop;
  else
    delete from tmp_receive_lines;
  end if;

  insert into tmp_receive_lines (line_variant, line_qty)
  select (l->>'variant_id')::uuid, (l->>'qty')::integer
    from jsonb_array_elements(p_lines) l;

  select count(*) into v_lines from tmp_receive_lines;
  if v_lines <> jsonb_array_length(p_lines) then
    raise exception 'receive: a line was malformed';
  end if;

  if exists (select 1 from tmp_receive_lines t where t.line_variant is null or t.line_qty is null or t.line_qty <= 0) then
    raise exception 'receive: every line needs a variant and a whole quantity of 1 or more';
  end if;

  -- One row per variant. Two lines for the same SKU would pass the total check
  -- while meaning something nobody can read back off the grid.
  if exists (select 1 from tmp_receive_lines t group by t.line_variant having count(*) > 1) then
    raise exception 'receive: the same size appears twice';
  end if;

  ------------------------------------------------------- every line is yours
  select count(*) into v_bad
    from tmp_receive_lines t
    left join wholesale_v2.v2_product_variants pv on pv.id = t.line_variant
    left join wholesale_v2.v2_products p on p.id = pv.product_id
   where p.wid is distinct from v_wid;

  if v_bad > 0 then
    raise exception 'receive: % line(s) name a product that is not in this warehouse''s store', v_bad;
  end if;

  ------------------------------------------------------------ THE COUNT CHECK
  -- CNT-03. Blocked, not warned. The message names BOTH numbers and the
  -- difference, because "counts do not match" sends somebody back to a grid of
  -- sixteen boxes with no idea which way to look.
  if p_billed_pieces is null or p_billed_pieces <= 0 then
    raise exception 'receive: say how many pieces the invoice was for';
  end if;

  select coalesce(sum(t.line_qty), 0) into v_total from tmp_receive_lines t;

  if v_total <> p_billed_pieces then
    raise exception 'receive: the breakdown comes to % pieces and the invoice says % — % %',
      v_total, p_billed_pieces,
      abs(v_total - p_billed_pieces),
      case when v_total > p_billed_pieces then 'too many' else 'still to enter' end;
  end if;

  --------------------------------------------------------------- the receipt
  v_note := coalesce(nullif(btrim(p_note), ''),
                     format('Whole-product receipt, %s pieces against an invoice of %s',
                            v_total, p_billed_pieces));

  -- One statement per line, one transaction for all of them. reference_type
  -- names the SCREEN, so the movement ledger can tell a counted delivery from
  -- a one-off correction without guessing from the note.
  -- LATERAL, not `(v2_receive_stock(...)).qty_on_hand` in the select list.
  -- Postgres evaluates a composite-returning call once PER REFERENCED FIELD
  -- when it is written that way, so the day somebody adds a second column to
  -- this result the function would be called twice per line and every delivery
  -- would be received twice. The bug would show up as stock that is exactly
  -- double, days later, with nothing in the ledger looking wrong -- seventeen
  -- movements, seventeen correct notes. A join calls it once, by construction.
  return query
  select t.line_variant, t.line_qty, r.qty_on_hand
    from tmp_receive_lines t
    cross join lateral wholesale_v2.v2_receive_stock(
      t.line_variant, p_location_id, t.line_qty,
      'product_receive', null, null, v_note) r
   order by t.line_variant;
end;
$function$;

comment on function wholesale_v2.v2_receive_product(uuid, jsonb, integer, text) is
  'CNT-00. One delivery, one transaction. Refuses unless the breakdown sums to '
  'the billed piece count, and unless every variant belongs to the warehouse''s '
  'own store. No override argument: CNT-10 is a separate decision.';

-- authenticated only. v2_receive_stock is granted to anon and that is a hole
-- this function does not copy: nobody signed out has any business adding
-- stock, and there is no signed-out screen that receives.
revoke all on function wholesale_v2.v2_receive_product(uuid, jsonb, integer, text) from public;
grant execute on function wholesale_v2.v2_receive_product(uuid, jsonb, integer, text) to authenticated;

-- EXACTLY ONE OVERLOAD. Migration 113 added a defaulted argument to
-- v2_marketplace_feed, which created a SECOND overload rather than replacing
-- the first; PostgREST then refused both with PGRST203 and the live feed broke
-- until 114 dropped the old signature. This asserts the shape rather than
-- trusting it.
do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2' and p.proname = 'v2_receive_product';
  if v_n <> 1 then
    raise exception '121: % overloads of v2_receive_product — PostgREST will refuse all of them', v_n;
  end if;
  raise notice '121 ok: v2_receive_product created, exactly one signature';
end $$;
