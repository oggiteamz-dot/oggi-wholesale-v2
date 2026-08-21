-- ============================================================================
-- 077 — v2_submit_order can be called twice in one transaction
--
-- WHAT WAS WRONG
--   v2_submit_order builds its working set as
--       create temporary table tmp_order_lines on commit drop as ...
--   "on commit drop" means the table lives until the TRANSACTION ends, not
--   until the function returns. So the second call inside one transaction
--   dies with:
--       ERROR: 42P07: relation "tmp_order_lines" already exists
--
-- WHY IT HAS NEVER BEEN SEEN
--   Every call from the app arrives over PostgREST as its own transaction, so
--   a buyer placing one order never hits it. What it DID break is everything
--   else: any batch import, any future wrapper that places two orders
--   atomically, any trigger -- and, the reason this was finally found,
--   ANY TEST. A gate that submits two orders and rolls back cannot exist
--   while this is true, which is precisely why the order path -- the most
--   consequential function in the system -- has never had an end-to-end one.
--   The MOQ bypass fixed in migration 028 survived for the same reason.
--
--   Found 21 Aug 2026 by checks/check_line_pricing.sql, on its second submit.
--
-- THE FIX
--   One statement, immediately before the create: drop the leftover if it is
--   there. Qualified as pg_temp.* deliberately -- an unqualified
--   "drop table if exists tmp_order_lines" resolves through search_path and
--   would, on a database that happened to own a permanent table by that name,
--   drop the wrong thing. pg_temp can only ever mean this session's own temp
--   schema. (v2_enforce_selling_model already reaches for the table the same
--   way, via to_regclass('pg_temp.tmp_order_lines'), so this is the file's
--   own established spelling, not a new convention.)
--
-- HOW THIS MIGRATION IS WRITTEN, AND WHY IT LOOKS UNUSUAL
--   It does NOT paste a copy of the function. It reads the CURRENTLY INSTALLED
--   body out of pg_proc, inserts the one line, and re-creates from that.
--
--   This is deliberate and it is the safer form. On 15 Aug 2026 a fix for this
--   same function was drafted from migration 012's copy, which has FIVE
--   parameters; the live one has seven. Applying it would have deleted
--   migration 024's p_account_id protection and reopened the "order as any
--   buyer" hole -- a fix that looks applied and is not. Rebuilding from the
--   live definition makes that class of mistake structurally impossible: this
--   migration cannot revert a change it does not know about, because it never
--   holds an opinion about the rest of the body.
--
--   It asserts that the anchor string was found and that the result differs
--   from the original, so a silent no-op fails loudly instead of reporting
--   success.
-- ============================================================================

do $mig$
declare
  v_src      text;
  v_new      text;
  v_anchor   text := '  create temporary table tmp_order_lines on commit drop as';
  v_insert   text := '  -- Migration 077: this table is "on commit drop", so a second call inside'  || E'\n' ||
                     '  -- one transaction would find it still standing. Clearing it first is what'  || E'\n' ||
                     '  -- makes the order path callable twice -- and therefore testable at all.'    || E'\n' ||
                     '  drop table if exists pg_temp.tmp_order_lines;'                               || E'\n';
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2'
     and p.proname = 'v2_submit_order'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, p_client_id uuid, p_account_id uuid, p_catalog_id uuid';

  if v_src is null then
    raise exception '077: no 7-argument v2_submit_order found. Do not guess -- inspect pg_proc and rebase this migration on whatever is actually installed.';
  end if;

  -- Already patched? Then this migration is a no-op and says so, rather than
  -- inserting a second copy of the same line on a re-run.
  if position('pg_temp.tmp_order_lines;' in v_src) > 0 then
    raise notice '077: v2_submit_order already clears its temp table; nothing to do.';
    return;
  end if;

  if position(v_anchor in v_src) = 0 then
    raise exception '077: the "create temporary table tmp_order_lines" anchor is not in the installed body. The function has been rewritten -- re-derive this patch against the current text.';
  end if;

  v_new := replace(v_src, v_anchor, v_insert || v_anchor);

  if v_new = v_src then
    raise exception '077: replacement produced an identical body -- refusing to report success for a no-op.';
  end if;

  execute format(
    'create or replace function wholesale_v2.v2_submit_order('
    || 'p_wid text, p_buyer_label text, p_location_id uuid, p_lines jsonb, '
    || 'p_client_id uuid default null, p_account_id uuid default null, p_catalog_id uuid default null) '
    || 'returns wholesale_v2.v2_orders language plpgsql security definer set search_path = wholesale_v2 as %L',
    v_new);

  raise notice '077: v2_submit_order patched (% -> % chars).', length(v_src), length(v_new);
end;
$mig$;
