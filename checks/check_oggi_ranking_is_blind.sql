-- =============================================================================
-- CHECK: the ranking cannot see who owns a store — OWN-03, migration 130
-- =============================================================================
-- THE ONE SENTENCE THIS FILE EXISTS FOR:
--
--   ⭐ MARKING A STORE AS OGGI'S OWN MUST NOT MOVE A SINGLE PRODUCT.
--
-- Since 8 Sep 2026 OGGI sells on this platform, and its products sit in the
-- ORDINARY RESULTS rather than in a shelf of their own. That arrangement is
-- only defensible if the ordering is genuinely blind to who owns a store, and
-- "we would never do that" is not a property anyone can check.
--
-- So it is checked the way check_promoted_slot.sql checks the promoted slot,
-- and this is deliberately the same assertion turned around:
--
--     093:  turning every promotion OFF must not change the organic ordering
--     here: turning first-party ON must not change it either
--
-- Capture the order. Flip the flag. Capture again. Compare. If somebody later
-- "optimises" the feed by folding store ownership into the rank -- which is the
-- natural thing to do and completely invisible from outside -- this goes red.
--
-- ==== WHY ALL THREE SURFACES, AND NOT JUST THE FEED ==========================
--
-- There are three functions that put products in an order:
--
--     v2_search_products      the in-store search
--     v2_marketplace_search   the marketplace search
--     v2_marketplace_feed     the marketplace browse feed
--
-- A gate that covered only one would leave the other two as a side door, and a
-- side door left open is the exact shape of the /c/:token bug that made a
-- registered route unreachable for three weeks. The flag is new; the surfaces
-- are not; the assertion has to meet all of them on the day the flag lands.
--
-- ==== TWO FAILURES, NOT ONE =================================================
--
-- Boosting is the obvious one. FILTERING is the quiet one: a change that made
-- first-party products rank identically but appear more often -- or made
-- everyone else's disappear -- would pass an order-only check. So the SET is
-- compared as well as the ORDER, on every surface.
--
-- Writes nothing: one transaction, rolled back at the end.

begin;
set local search_path = wholesale_v2, public;

create temporary table zzb_results (ord int, label text, expected text, got text) on commit drop;

do $check$
declare
  wA text := 'zzb_indie';    -- an ordinary wholesaler
  wB text := 'zzb_house';    -- the one that becomes OGGI's own
  cliA uuid; accA uuid; person uuid; cliB uuid; accB uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;
  before_search text; after_search text;
  before_mkt    text; after_mkt    text;
  before_feed   text; after_feed   text;
  before_set    text; after_set    text;
  n int;
begin
  ---------------------------------------------------------------- the fixture
  -- ⚠️ THE STORE NAMES ARE CHOSEN, NOT DECORATIVE, AND THE FIRST DRAFT GOT THEM
  -- WRONG. They were 'Indie Textiles' and 'House Brand' -- and 'House Brand'
  -- sorts BEFORE 'Indie Textiles', so in v2_marketplace_search (which orders by
  -- band, then wholesaler_name) the house store was ALREADY top of the list. A
  -- sabotage that boosted first-party moved nothing, because there was nowhere
  -- up to go, and the gate reported green on a rigged ranking.
  --
  -- The house store must sort LAST on every key any of the three surfaces
  -- orders by -- wholesaler_name AND product_name -- so that a boost has the
  -- furthest possible distance to travel and cannot hide inside a tie.
  insert into public.wholesalers (wid, name, active) values
    (wA, 'Aaa Indie Textiles', true), (wB, 'Zzz House Brand', true);
  insert into wholesale_v2.v2_wholesalers (wid, name) values
    (wA, 'Aaa Indie Textiles'), (wB, 'Zzz House Brand');

  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wA, 'Blind Gate Shop', '03 777 111') returning id into cliA;
  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active)
    values (wA, cliA, 'buyer', 'zzblindbuyer', 'x', 'Blind Gate', true)
    returning id into accA;
  perform wholesale_v2.v2_backfill_person_identity();
  select person_id into person from wholesale_v2.v2_portal_accounts where id = accA;

  -- The same human also belongs to the house store, so both stores are in
  -- scope for one query. Without this the two stores are never ordered against
  -- each other and the assertion would be vacuous -- which is the way this gate
  -- could most easily have looked green while proving nothing.
  insert into wholesale_v2.v2_clients (wid, shop_name, phone)
    values (wB, 'Blind Gate Shop', '03 777 111') returning id into cliB;
  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active)
    values (wB, cliB, 'buyer', 'zzblindbuyer2', 'x', 'Blind Gate', true)
    returning id into accB;
  insert into wholesale_v2.v2_person_memberships (person_id, wid, client_id, account_id, role, active)
    values (person, wB, cliB, accB, 'buyer', true);

  -- ⭐ THE HOUSE STORE'S PRODUCTS ARE DELIBERATELY LAST ALPHABETICALLY.
  -- If ownership leaks into the rank it will leak in the tempting direction --
  -- upward -- and these are the rows with the furthest to travel. A fixture
  -- where the house brand already sorted first could not tell the difference
  -- between a fair ranking and a rigged one.
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wA,'Zeta Blind Alpha',  'Blindtest',false,true) returning id into p1;
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wA,'Zeta Blind Bravo',  'Blindtest',false,true) returning id into p2;
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wA,'Zeta Blind Charlie','Blindtest',false,true) returning id into p3;
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wB,'Zeta Blind Xray',   'Blindtest',false,true) returning id into p4;
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wB,'Zeta Blind Yankee', 'Blindtest',false,true) returning id into p5;
  insert into wholesale_v2.v2_products (wid,name,category,archived,is_public) values
    (wB,'Zeta Blind Zulu',   'Blindtest',false,true) returning id into p6;

  ------------------------------------------------------- BEFORE, all surfaces
  select string_agg(product_name, '|' order by ord) into before_search from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_search_products(accA, 'Zeta Blind', 50, 0)
     where slot = 'organic') q;

  select string_agg(product_name, '|' order by ord) into before_mkt from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_marketplace_search(accA, 'Zeta Blind', 50, 0)) q;

  select string_agg(product_name, '|' order by ord) into before_feed from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_marketplace_feed(accA, 50, 0, 'Blindtest', 'woven')) q;

  -- The SET, sorted, so a change in membership is caught even if the surviving
  -- rows keep their relative order.
  select string_agg(product_name, '|' order by product_name) into before_set from (
    select distinct product_name from wholesale_v2.v2_search_products(accA,'Zeta Blind',50,0)) q;

  ------------------------------------------------------------- ⭐ FLIP THE FLAG
  update wholesale_v2.v2_wholesalers set is_first_party = true where wid = wB;

  select count(*) into n from wholesale_v2.v2_wholesalers where is_first_party and wid = wB;
  insert into zzb_results values (1, 'the house store really is marked (otherwise everything below is vacuous)', '1', n::text);

  -------------------------------------------------------- AFTER, all surfaces
  select string_agg(product_name, '|' order by ord) into after_search from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_search_products(accA, 'Zeta Blind', 50, 0)
     where slot = 'organic') q;

  select string_agg(product_name, '|' order by ord) into after_mkt from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_marketplace_search(accA, 'Zeta Blind', 50, 0)) q;

  select string_agg(product_name, '|' order by ord) into after_feed from (
    select product_name, row_number() over () as ord
      from wholesale_v2.v2_marketplace_feed(accA, 50, 0, 'Blindtest', 'woven')) q;

  select string_agg(product_name, '|' order by product_name) into after_set from (
    select distinct product_name from wholesale_v2.v2_search_products(accA,'Zeta Blind',50,0)) q;

  -------------------------------------------------------------- the verdicts
  insert into zzb_results values (2,
    '⭐ in-store search: marking a store OGGI''s own moved nothing',
    coalesce(before_search,'(none)'), coalesce(after_search,'(none)'));

  insert into zzb_results values (3,
    '⭐ marketplace search: marking a store OGGI''s own moved nothing',
    coalesce(before_mkt,'(none)'), coalesce(after_mkt,'(none)'));

  insert into zzb_results values (4,
    '⭐ marketplace feed: marking a store OGGI''s own moved nothing',
    coalesce(before_feed,'(none)'), coalesce(after_feed,'(none)'));

  insert into zzb_results values (5,
    'and the SET is unchanged too — nothing appeared, nothing vanished',
    coalesce(before_set,'(none)'), coalesce(after_set,'(none)'));

  -- A fixture that returned nothing would pass every comparison above by
  -- comparing two empty strings. Said out loud rather than hoped for.
  insert into zzb_results values (6,
    'the fixture actually returned products, so the comparisons above compared something',
    'yes',
    case when coalesce(before_search,'') like '%Zeta Blind%' then 'yes' else 'NO — THIS GATE PROVED NOTHING' end);

  -- And both stores are represented, so the two were genuinely ranked against
  -- each other rather than the house store being absent from the corpus.
  insert into zzb_results values (7,
    'and both the indie store and the house store are in them',
    'both',
    case when coalesce(before_search,'') like '%Alpha%' and coalesce(before_search,'') like '%Zulu%'
         then 'both' else 'ONLY ONE — the stores were never ranked against each other' end);

  -- ⭐ AND THE HOUSE STORE STARTS AT THE BOTTOM ON EVERY SURFACE.
  --
  -- Without this the whole gate can pass on a rigged ranking: if the house
  -- store already sorts first, boosting it moves nothing and every comparison
  -- above comes back identical. That is exactly what happened to the first
  -- draft of this file on v2_marketplace_search, and it was found by a sabotage
  -- rather than by reading it.
  -- ⚠️ AND THE ASSERTION IS SURFACE-SHAPED, BECAUSE THE THREE SURFACES ARE NOT
  -- THE SAME SHAPE. The first version demanded "house store last" on all three
  -- and went red on the feed -- correctly, and not because the feed is wrong:
  -- the feed WEAVES, `partition by s.wid order by s.product_id`, so each store
  -- appears in rotation and by construction no store is ever last. That is the
  -- feature ("each store in rotation, so the page reads as a marketplace and no
  -- shop owns it"), not a defect, and an assertion that demanded otherwise
  -- would have been a gate insisting the product be worse.
  --
  -- What has to be true is the same underneath: a first-party boost must have
  -- somewhere to show up. On the two ranked surfaces that means the house store
  -- starts last. On the woven feed it means the feed does not ALREADY lead with
  -- the house store -- because if it did, jumping it to the front would be
  -- invisible.
  insert into zzb_results values (8,
    '⭐ a first-party boost would have somewhere to show up on all three',
    'last|last|not leading',
    (case when split_part(before_search,'|',6) like '%Zulu%' then 'last' else 'NOT LAST in search' end) || '|' ||
    (case when split_part(before_mkt,   '|',6) like '%Zulu%' then 'last' else 'NOT LAST in marketplace search' end) || '|' ||
    (case when split_part(before_feed,  '|',1) like '%Zeta Blind A%'
            or split_part(before_feed, '|',1) like '%Zeta Blind B%'
            or split_part(before_feed, '|',1) like '%Zeta Blind C%'
          then 'not leading' else 'THE FEED ALREADY LEADS WITH THE HOUSE STORE — a boost would be invisible' end));
end
$check$;

select label, expected, coalesce(got,'(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzb_results

  -- 8. The flag is not readable by a browser role. It is an ownership fact
  --    about the platform, and a signed-out stranger enumerating which store
  --    is OGGI's own is not something this gate should have to think about
  --    later. v2_wholesalers is directory data and IS readable, so this asserts
  --    the narrower thing that matters: no browser role may WRITE it.
  union all select 9, 'no browser role can write the first-party flag', 'none',
    (select coalesce(string_agg(distinct g.grantee||':'||g.privilege_type, ', '), 'none')
       from information_schema.role_table_grants g
      where g.table_schema = 'wholesale_v2' and g.table_name = 'v2_wholesalers'
        and g.grantee in ('anon','authenticated','PUBLIC')
        and g.privilege_type in ('INSERT','UPDATE','DELETE'))

  -- 9. At most one store, asserted against the index rather than the data, so
  --    it holds on an empty database too.
  union all select 10, 'only one store can ever be OGGI''s own', 'present',
    (select case when count(*) = 1 then 'present' else 'GONE' end
       from pg_indexes where schemaname='wholesale_v2' and indexname='v2_wholesalers_one_first_party')

  -- 10. ⭐ The ranking functions do not mention the flag AT ALL. The
  --     behavioural assertions above are the real proof -- they survive a
  --     rewrite, which a source check does not -- but this catches the case
  --     where somebody adds a reference that happens not to change the order
  --     for THIS fixture. Belt and braces, and named as such.
  union all select 11, '⭐ and no ordering function so much as mentions it', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname in ('v2_search_products','v2_marketplace_search','v2_marketplace_feed')
        and p.prosrc ilike '%is_first_party%')
) r
order by ord, label;

rollback;
