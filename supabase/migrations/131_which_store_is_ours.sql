-- 131 — one question a buyer's browser is allowed to ask: which store is OGGI's own
--
-- OWN-02/05, 8 Sep 2026. Migration 130 added is_first_party. This is how a
-- buyer-facing screen learns the answer, so the label can be drawn on the card.
--
-- ==== WHY A ONE-COLUMN RPC AND NOT A COLUMN ON THE FEED ====================
--
-- The obvious design is to append `is_first_party` to what v2_marketplace_feed,
-- v2_marketplace_search and v2_search_products already return, per row. That is
-- the more robust shape -- a surface cannot forget to join something that is
-- handed to it -- and it is the right end state.
--
-- It is NOT what this migration does, and the reason is specific rather than
-- squeamish: **a return-table change cannot be done with CREATE OR REPLACE.**
-- Postgres requires DROP then CREATE, which means dropping three functions that
-- serve every buyer-facing screen on the platform, in order to add a column
-- used only for drawing a badge. Migrations 113 and 114 are this repo's record
-- of what a careless change to a live PostgREST signature costs: a second
-- overload, PGRST203 on both, and the feed dead until one was dropped.
--
-- So the flag rides along the next time one of those three is opened for a
-- reason that already needs it, and until then the browser asks ONE cheap
-- question and answers it for every row itself.
--
-- ⚠️ THE COST OF THAT CHOICE, NAMED RATHER THAN GLOSSED: a surface that forgets
-- to compare wid against this answer renders no label, and a first-party
-- product then looks like anybody else's. checks/check_oggi_label.mjs is what
-- makes that a failing build rather than an omission nobody notices -- it
-- asserts the pairing, every mapper AND every renderer, not the two facts
-- separately. That is the same shape as the /c/:token bug: a route registered
-- but not made public was unreachable for three weeks because two halves were
-- each checked alone.
--
-- ==== WHY THE BROWSER CANNOT SIMPLY READ THE TABLE =========================
--
-- Migration 042 revoked every browser role's access to v2_wholesalers, and
-- check_anon_scope.sh exists to keep it revoked. Restoring a SELECT grant to
-- answer one question would reopen a door Batch S closed on purpose. A
-- SECURITY DEFINER function that returns exactly one text value reopens nothing.

create or replace function wholesale_v2.v2_first_party_wid()
returns text
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  -- At most one row can ever satisfy this: 130's partial unique index makes a
  -- second first-party store impossible to store. So this is a scalar by
  -- construction rather than by LIMIT 1 papering over an ambiguity.
  select w.wid from wholesale_v2.v2_wholesalers w where w.is_first_party;
$fn$;

comment on function wholesale_v2.v2_first_party_wid() is
  'OWN-02/05. The wid of the ONE store OGGI sells from, or null. The only thing '
  'a browser may learn about first-party ownership, and it is deliberately not '
  'a row on v2_wholesalers: 042 revoked browser access to that table and Batch S '
  'exists to keep it revoked. Returns a wid, never a name, a count or a list.';

revoke all on function wholesale_v2.v2_first_party_wid() from public;
grant execute on function wholesale_v2.v2_first_party_wid() to anon, authenticated;

do $$
declare n int; v text;
begin
  -- Exactly one overload. 113's lesson, asserted rather than trusted: a
  -- defaulted argument added later would create a second, and PostgREST would
  -- refuse BOTH with PGRST203 rather than picking one.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_first_party_wid';
  if n <> 1 then
    raise exception '131: expected 1 overload of v2_first_party_wid, found % -- PostgREST would refuse them all', n;
  end if;

  -- It answers on a database where nothing is marked, and the answer is null
  -- rather than an error. A screen loading before OGGI sells anything must not
  -- see a failure where it expects "nobody".
  select wholesale_v2.v2_first_party_wid() into v;
  if v is not null then
    raise exception '131: v2_first_party_wid() returned %, but nothing should be marked yet', v;
  end if;

  -- ⭐ AND A SIGNED-OUT STRANGER MAY ASK. The label has to render for anyone who
  -- can see a product at all, including on the public catalogue-link path where
  -- there is no account -- so anon must hold execute. This is asserted rather
  -- than assumed because a later blanket revoke would silently un-label every
  -- first-party product on exactly the surfaces strangers use.
  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'wholesale_v2' and p.proname = 'v2_first_party_wid'
       and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '131: anon cannot call v2_first_party_wid -- first-party products would go unlabelled for signed-out buyers';
  end if;

  raise notice '131 ok: one overload, answers null while nothing is marked, and a stranger may ask';
end $$;
