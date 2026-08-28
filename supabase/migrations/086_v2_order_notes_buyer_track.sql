-- ============================================================================
-- 086 — the buyer's note: per item, and per order
--
-- WHAT WAS WRONG
--   `v2_orders.notes` has existed since migration 004 and NOTHING HAS EVER
--   WRITTEN TO IT. v2_submit_order does not accept a note argument and its
--   `insert into v2_orders (...)` does not list the column. js/data/cart.js
--   destructures `notes` from its options and no caller passes it.
--   js/data/orders.js maps `notes: o.notes` out of a value that is always null,
--   and v2_get_buyer_orders faithfully selects and returns that null.
--
--   Three layers, each half-present, none joined up. This is the same shape as
--   v2_clients.discount_pct, which was dead from migration 006 until 058 while
--   a client set to 10% paid full price on screen AND on the invoice for two
--   months. A column that exists and is never written is more dangerous than a
--   column that does not exist, because every future reader assumes it works.
--
--   And `v2_order_items` has no note column at all, and never has had one. Its
--   four original columns are variant, qty, unit_price, line_total.
--
-- WHAT THIS DOES
--   1. Adopts `v2_orders.notes` as the BUYER's order-level note and says so in
--      a column comment, so it is never again ambiguous whose note it is.
--   2. Adds `v2_order_items.buyer_note` — the per-item note, unlimited length.
--   3. Teaches v2_submit_order to accept and persist both.
--
-- WHY `notes` IS ADOPTED AND NOT DROPPED OR RENAMED
--   Dropping it looks tidier and is wrong: v2_get_buyer_orders selects it, so
--   dropping the column breaks every buyer's order history. Renaming has the
--   same problem for the same reason. Adopting it kills the trap by wiring the
--   column up — it stops being dead by being used — at the cost of one comment
--   explaining the name. The wholesaler's own track lands in migration 087 as
--   `fulfil_note`, deliberately a DIFFERENT column: research finding R-N1 is
--   that one shared field serving two audiences is a leak, not a tidy-up. A
--   real merchant's internal picker note reached a customer-facing shipping
--   label for exactly that reason.
--
-- HOW THIS MIGRATION IS WRITTEN
--   It does NOT paste a copy of v2_submit_order. It reads the CURRENTLY
--   INSTALLED body out of pg_proc, edits it at three anchors, and re-creates
--   from that — the form migration 077 established.
--
--   That is not stylistic. On 15 Aug 2026 a fix for this same function was
--   drafted from migration 012's copy, which has FIVE parameters. The live one
--   has SEVEN. Applying it would have deleted migration 024's p_account_id
--   protection and reopened the "order as any buyer" hole — a fix that looks
--   applied and is not. Confirmed again while writing this migration: grepping
--   the repo for `create or replace function v2_submit_order` returns 004, 010,
--   012 and 024, and the newest of those has SIX parameters. The installed
--   function has SEVEN — p_catalog_id was added by a migration that patched the
--   body rather than re-declaring it, so it is invisible to grep. Anchoring on
--   any file in this repo would have silently dropped catalogue scoping.
--
--   Every step asserts. A missing anchor, a no-op replacement, or a signature
--   that is not what this migration expects raises rather than reporting success.
-- ============================================================================

-- Migration 026 moved every v2 object into the wholesale_v2 schema, and the
-- replay harness runs with search_path = public, extensions. Migration 079
-- sets this explicitly for the same reason; without it every unqualified
-- name below resolves to nothing and the migration stops.
set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------- the columns
alter table v2_order_items add column if not exists buyer_note text;

comment on column v2_order_items.buyer_note is
  'The BUYER''s note about this specific line, written at order time. Free text, '
  'no length limit. Migration 086. This is the customer''s request ("send this one '
  'in the darker blue"). The wholesaler''s own instruction to their warehouse is a '
  'SEPARATE column, fulfil_note — never merge the two: they have different authors '
  'and different audiences, and a single shared field is how an internal picking '
  'note ends up printed on something the customer reads.';

comment on column v2_orders.notes is
  'The BUYER''s note about the order as a whole. ADOPTED by migration 086 — this '
  'column existed from migration 004 and was never written by any code path until '
  'then; v2_get_buyer_orders has been faithfully returning null for it since. Not '
  'renamed to buyer_note only because v2_get_buyer_orders selects it by name and '
  'renaming would break every buyer''s order history. The wholesaler''s track is '
  'v2_orders.fulfil_note (migration 087).';

-- ------------------------------------------------------------- the function
do $mig$
declare
  v_src text;
  v_new text;
  v_n   int;

  -- Anchor 1: the temp table's select list. A per-line note rides inside the
  -- existing p_lines jsonb, so no new argument is needed for it and old callers
  -- that send no 'note' key get NULL, not an error.
  a1 text := '    nullif(l->>''pack_qty'', '''')::integer as pack_qty,';
  r1 text := '    nullif(l->>''pack_qty'', '''')::integer as pack_qty,' || E'\n' ||
             '    -- Migration 086: the buyer''s per-line note. Rides inside p_lines so' || E'\n' ||
             '    -- the signature does not change for it. btrim+nullif so that a line' || E'\n' ||
             '    -- carrying "" or "   " stores NULL rather than a note that renders as' || E'\n' ||
             '    -- an empty box on the warehouse sheet.' || E'\n' ||
             '    nullif(btrim(l->>''note''), '''') as buyer_note,';

  -- Anchor 2: the order insert.
  a2 text := '  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal, catalog_id)' || E'\n' ||
             '  values (p_wid, p_buyer_label, p_client_id, p_location_id, ''new'', 0, p_catalog_id)';
  r2 text := '  -- Migration 086: notes = the BUYER''s order-level note (see the column comment).' || E'\n' ||
             '  insert into v2_orders (wid, buyer_label, client_id, location_id, status, subtotal, catalog_id, notes)' || E'\n' ||
             '  values (p_wid, p_buyer_label, p_client_id, p_location_id, ''new'', 0, p_catalog_id, nullif(btrim(p_notes), ''''))';

  -- Anchor 3: the line insert.
  a3 text := '    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total, pack_id, pack_line_id, pack_qty)' || E'\n' ||
             '    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total, v_line.pack_id, v_line.pack_line_id, v_line.pack_qty);';
  r3 text := '    insert into v2_order_items (order_id, variant_id, qty, unit_price, line_total, pack_id, pack_line_id, pack_qty, buyer_note)' || E'\n' ||
             '    values (v_order.id, v_line.variant_id, v_line.qty, v_unit_price, v_line_total, v_line.pack_id, v_line.pack_line_id, v_line.pack_qty, v_line.buyer_note);';
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2'
     and p.proname = 'v2_submit_order'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, p_client_id uuid, p_account_id uuid, p_catalog_id uuid';

  if v_src is null then
    raise exception '086: no 7-argument v2_submit_order found. Do NOT guess and do NOT paste a copy from this repo -- the newest file here declares six parameters and the installed function has seven. Inspect pg_proc and rebase this migration on whatever is actually installed.';
  end if;

  -- Idempotent: a re-run must not insert a second copy of each edit.
  if position('v_line.buyer_note' in v_src) > 0 then
    raise notice '086: v2_submit_order already carries the buyer note; nothing to do.';
    return;
  end if;

  if position(a1 in v_src) = 0 then
    raise exception '086: anchor 1 (the pack_qty line of the tmp_order_lines select list) is not in the installed body. The function has been rewritten -- re-derive this patch against the current text.';
  end if;
  if position(a2 in v_src) = 0 then
    raise exception '086: anchor 2 (insert into v2_orders) is not in the installed body, or its column list differs from what this migration expects. Re-derive.';
  end if;
  if position(a3 in v_src) = 0 then
    raise exception '086: anchor 3 (insert into v2_order_items) is not in the installed body, or its column list differs. Re-derive.';
  end if;

  v_new := replace(replace(replace(v_src, a1, r1), a2, r2), a3, r3);

  if v_new = v_src then
    raise exception '086: replacement produced an identical body -- refusing to report success for a no-op.';
  end if;

  execute format(
    'create or replace function wholesale_v2.v2_submit_order('
    || 'p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, '
    || 'p_client_id uuid default null, p_account_id uuid default null, '
    || 'p_catalog_id uuid default null, p_notes text default null) '
    || 'returns wholesale_v2.v2_orders language plpgsql security definer set search_path = wholesale_v2 as %L',
    v_new);

  -- The 8-argument function is an OVERLOAD, not a replacement: Postgres now
  -- holds both. PostgREST calls by NAMED arguments, and a 7-named-argument call
  -- matches both candidates, which is an ambiguity error at the moment a buyer
  -- checks out. So the old one must go, in this same transaction.
  execute 'drop function wholesale_v2.v2_submit_order(text,text,uuid,jsonb,uuid,uuid,uuid)';

  -- Mirror the grants the dropped function held (verified: anon + authenticated).
  execute 'grant execute on function wholesale_v2.v2_submit_order(text,text,uuid,jsonb,uuid,uuid,uuid,text) to anon, authenticated';

  raise notice '086: v2_submit_order patched and re-signed (% -> % chars).', length(v_src), length(v_new);
end;
$mig$;

-- --------------------------------------------------------------- self-assert
do $verify$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='wholesale_v2' and p.proname='v2_submit_order';
  if v_n <> 1 then
    raise exception '086 ASSERT 1 FAILED: expected exactly one v2_submit_order, found %. An overload left standing is an ambiguity error at checkout.', v_n;
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='wholesale_v2' and p.proname='v2_submit_order'
                    and pg_get_function_identity_arguments(p.oid) like '%p_notes text%') then
    raise exception '086 ASSERT 2 FAILED: the surviving v2_submit_order does not take p_notes.';
  end if;

  -- The whole point of the live-body form: the seventh parameter must survive.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='wholesale_v2' and p.proname='v2_submit_order'
                    and pg_get_function_identity_arguments(p.oid) like '%p_account_id uuid%'
                    and pg_get_function_identity_arguments(p.oid) like '%p_catalog_id uuid%') then
    raise exception '086 ASSERT 3 FAILED: p_account_id or p_catalog_id was lost. This is the exact 15 Aug regression this migration was written to make impossible.';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema='wholesale_v2' and table_name='v2_order_items' and column_name='buyer_note') then
    raise exception '086 ASSERT 4 FAILED: v2_order_items.buyer_note is missing.';
  end if;

  if not has_function_privilege('anon','wholesale_v2.v2_submit_order(text,text,uuid,jsonb,uuid,uuid,uuid,text)','execute') then
    raise exception '086 ASSERT 5 FAILED: anon cannot execute the new v2_submit_order. Buyers and reps run as anon (they hold no Supabase Auth session) -- without this, checkout is dead for everyone.';
  end if;

  raise notice '086: all 5 assertions passed.';
end;
$verify$;
