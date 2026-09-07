-- 124 — a signed-out stranger stops being able to write stock
--
-- HADI, 7 Sep 2026, on being shown this:
--   "I did not understand that, so I don't know what to do, how to fix it.
--    Do as you see it."
--
-- THE HOLE, IN PLAIN WORDS
-- Three functions add or remove stock. All three are SECURITY DEFINER, which
-- means they run with the database owner's power regardless of who calls them,
-- and all three were granted to `anon` -- the role every visitor to the site
-- holds before they log in, using the key that ships inside the JavaScript
-- bundle. None of them checks who is calling. So anybody who opened the site,
-- signed out, holding a variant id and a location id, could add ten thousand
-- pieces to a stranger's warehouse, or take them away:
--
--   v2_receive_stock    adds stock
--   v2_decrement_stock  removes stock
--   v2_assemble_kit     does both (it calls the two above), so it is the same
--                       hole a second time and would have survived fixing only
--                       the obvious two
--
-- The ids are not secret. A public share link hands out variant ids by design.
--
-- WHY IT WAS LEFT OPEN UNTIL NOW. Migration 121's header records the reason:
-- revoking a grant the live app may depend on is not a change to make while
-- nobody is awake to notice a warehouse screen going blank. So it was written
-- down and left. This is the daylight version of that fix.
--
-- WHAT WAS CHECKED BEFORE REVOKING, 7 Sep 2026
--   In the app: every caller is a wholesaler-only screen running on a real
--   Supabase Auth session, so it holds `authenticated`, not `anon` --
--     js/data/inventory-admin.js (x3), js/data/csv-import.js,
--     js/data/products-admin.js, js/views/mobile-ops.js  -> receive/decrement
--     js/views/wholesaler.js via js/data/kits.js          -> assemble_kit
--   In the database: the only internal callers are v2_receive_product and
--   v2_transfer_stock, both SECURITY DEFINER and neither granted to anon. A
--   call made INSIDE a definer function runs as the definer, so revoking the
--   caller's own grant cannot break them. v2_submit_order does not call either
--   one -- it settles reservations instead -- so checkout is untouched.
--
-- WHAT DELIBERATELY KEEPS ITS anon GRANT, and why this is not an oversight:
--   v2_reserve_stock, v2_confirm_reservation, v2_release_reservation
--   These are the signed-out BUYER's cart. A buyer on a public share link has
--   no Supabase Auth session at all -- the portal-account model authenticates
--   through v2_portal_accounts on the anon key -- so taking anon off these
--   would break every public catalogue on the platform. They are also the
--   right shape for anon: a reservation is temporary, it expires, and it
--   cannot change what the warehouse holds, only what is spoken for.
--
-- The rule this migration establishes, said once: **anon may SPEAK FOR stock
-- and may never CHANGE it.** The assertion at the bottom is that sentence in
-- SQL, and it is what stops the next function of this shape being granted to
-- anon by habit.

revoke execute on function wholesale_v2.v2_receive_stock(uuid, uuid, integer, text, uuid, uuid, text) from anon, public;
revoke execute on function wholesale_v2.v2_decrement_stock(uuid, uuid, integer, text, text, uuid, uuid, text) from anon, public;
revoke execute on function wholesale_v2.v2_assemble_kit(uuid, uuid, integer, uuid, text) from anon, public;

-- PUBLIC is revoked alongside anon on purpose. A grant to PUBLIC is a grant to
-- every role there will ever be, including ones nobody has created yet, and it
-- is how the anon grant got there in the first place: `grant execute ... to
-- public` in an early migration, not a decision anyone made about anon.
-- Re-granting `authenticated` explicitly, because revoking from PUBLIC takes
-- the implicit grant away from it too.
grant execute on function wholesale_v2.v2_receive_stock(uuid, uuid, integer, text, uuid, uuid, text) to authenticated;
grant execute on function wholesale_v2.v2_decrement_stock(uuid, uuid, integer, text, text, uuid, uuid, text) to authenticated;
grant execute on function wholesale_v2.v2_assemble_kit(uuid, uuid, integer, uuid, text) to authenticated;

comment on function wholesale_v2.v2_receive_stock(uuid, uuid, integer, text, uuid, uuid, text) is
  'Adds stock. authenticated only since 124: it is SECURITY DEFINER and checks '
  'no tenant, so a signed-out caller could fill a stranger''s warehouse.';
comment on function wholesale_v2.v2_decrement_stock(uuid, uuid, integer, text, text, uuid, uuid, text) is
  'Removes stock. authenticated only since 124, for the same reason as v2_receive_stock.';
comment on function wholesale_v2.v2_assemble_kit(uuid, uuid, integer, uuid, text) is
  'Builds a kit by consuming components and receiving the finished item. '
  'authenticated only since 124: it calls both stock writers, so leaving it '
  'open would have re-opened the hole through a third door.';

------------------------------------------------------------------- THE RULE
-- Stated by BEHAVIOUR, not by name. A future v2_writeoff_stock or
-- v2_correct_count would be caught by this; a list of three names would not.
-- The allow-list is the reservation path and nothing else, and each name in it
-- has to be typed here on purpose, which is the point.
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2'
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and (p.prosrc ~* '(insert into|update)[[:space:]]+(wholesale_v2\.)?v2_inventory_(balances|movements)'
       or p.prosrc ~ 'v2_receive_stock'
       or p.prosrc ~ 'v2_decrement_stock')
     and p.proname not in ('v2_reserve_stock','v2_confirm_reservation','v2_release_reservation');

  if v_bad is not null then
    raise exception '124: still anon-callable and able to change stock: %. anon may speak for stock and never change it.', v_bad;
  end if;
  raise notice '124 ok: no stock-changing function is anon-callable; the reservation path (reserve/confirm/release) is unchanged';
end $$;

-- And the other half of the same sentence: the reservation path is still open,
-- asserted rather than assumed, because a later "tidy up the grants" pass that
-- takes anon off these would silently break every public catalogue and the
-- assertion above would happily stay green.
do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wholesale_v2'
     and p.proname in ('v2_reserve_stock','v2_confirm_reservation','v2_release_reservation')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_n <> 3 then
    raise exception '124: the signed-out buyer''s cart needs all 3 reservation functions anon-callable, % are', v_n;
  end if;
  raise notice '124 ok: the signed-out buyer can still reserve, confirm and release';
end $$;
