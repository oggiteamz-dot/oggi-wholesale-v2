-- =============================================================================
-- CHECK: redeeming a share link — LINK-06/03/04/07/08/09, migration 128
-- =============================================================================
-- THE ONE SENTENCE EVERY ASSERTION IN THIS FILE SERVES:
--
--   NOBODY WHO OPENS A REAL LINK IS EVER TURNED AWAY FROM OGGI.
--
-- Hadi: "either way, they get access and they are logged in. They are signed up
-- to the marketplace itself." So the interesting rows are not the happy path --
-- they are the four ways a redemption can FAIL to grant store access, each of
-- which must still end with a person, a credential and a live session.
--
-- WHY THE SESSION IS PROVEN BY USING IT, NOT BY LOOKING AT IT.
-- `session_token is not null` passes on a token that resolves to nothing. Every
-- session row below is spent: handed to v2_session_person, and for a joined
-- redeemer to v2_session_stores as well, which is the call the app makes to
-- draw the store switcher. A session that does not open the store switcher is
-- not the feature Hadi described.
--
-- Writes nothing: one transaction, rolled back at the end.

begin;

insert into public.wholesalers (wid, name, active) values
  ('zzr01', 'Redeem Gate Co', true) on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values
  ('zzr01', 'Redeem Gate Co') on conflict (wid) do nothing;

create temporary table zzr_results (ord int, label text, expected text, got text) on commit drop;

do $check$
declare
  wA      text := 'zzr01';
  v_t_one text; v_t_unl text; v_t_app text; v_t_cap text; v_t_rev text; v_t_exp text;
  v_link  uuid;
  r       record;
  r2      record;
  n       int;
  v_prod  uuid; v_var uuid; v_cat_def uuid; v_cat_other uuid;
  v_p1    numeric; v_p2 numeric;
  v_msg_missing text; v_msg_revoked text; v_msg_expired text;
begin
  select id into v_cat_def from wholesale_v2.v2_catalogs where wid = wA and is_default;
  insert into wholesale_v2.v2_catalogs (wid, name, is_default, active, discount_pct)
  values (wA, 'Occasion', false, true, 40) returning id into v_cat_other;

  insert into wholesale_v2.v2_products (wid, name) values (wA, 'Gate Shirt')
  returning id into v_prod;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price)
  values (v_prod, 'ZZR-1-NAVY-M', 100.00) returning id into v_var;

  insert into wholesale_v2.v2_share_links (wid, kind, invitee_name, invitee_phone, discount_pct)
  values (wA, 'one_time', 'Rita', '03 111 222', 15.00) returning token into v_t_one;
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'unlimited') returning token into v_t_unl;
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'approval')  returning token into v_t_app;
  insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values (wA, 'capped', 1) returning token into v_t_cap;

  --------------------------------------------------------------- 1-5. joined
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_one, '03 111 222', 'Rita', 'Rita Boutique', 'ritazzr', 'hunter2secret');

  insert into zzr_results values
    (1, 'the invited number walks straight into the store', 'joined', coalesce(r.outcome, 'REFUSED: ' || coalesce(r.msg,'')));

  insert into zzr_results values
    (2, '⭐ and the session it hands back really is a session', 'the right person',
        case when wholesale_v2.v2_session_person(r.session_id, r.session_token) = r.person_id
             then 'the right person' else 'IT RESOLVES TO NOBODY' end);

  select count(*) into n from wholesale_v2.v2_session_stores(r.session_id, r.session_token) s where s.wid = wA;
  insert into zzr_results values
    (3, '...and that session opens the store switcher onto this store', '1', n::text);

  insert into zzr_results values
    (4, 'the rate the wholesaler put on the link is on the CUSTOMER now', '15.00',
        coalesce((select c.discount_pct::text from wholesale_v2.v2_clients c where c.id = r.client_id), 'NO CLIENT'));

  -- ⭐ 122 SURVIVES LINK-09. The whole worry about a link carrying a discount
  -- is that it becomes a second pricing dimension. It does not: the rate is
  -- copied onto the customer once and the link is never read for pricing again.
  -- Proven the way check_one_price_per_buyer.sql proves it -- price the same
  -- variant through two DIFFERENT shelves, one of them carrying 40% -- so if a
  -- shelf ever starts pricing again, this row moves.
  v_p1 := wholesale_v2.v2_effective_unit_price(v_prod, v_var, r.client_id, 1, v_cat_def);
  v_p2 := wholesale_v2.v2_effective_unit_price(v_prod, v_var, r.client_id, 1, v_cat_other);
  insert into zzr_results values
    (5, '⭐ one price for this buyer through every door, and it is the link''s rate', '85.00 = 85.00',
        v_p1::text || ' = ' || v_p2::text);

  ------------------------------------------------------- 6-8. the used link
  select * into r2 from wholesale_v2.v2_redeem_share_link(
    v_t_one, '03 999 888', 'Someone Else', 'Second Shop', 'secondzzr', 'hunter2secret');

  insert into zzr_results values
    (6, 'a link already used is a REQUEST, never a wall', 'requested',
        coalesce(r2.outcome, 'REFUSED: ' || coalesce(r2.msg,'')));

  insert into zzr_results values
    (7, '⭐ ...and that person is signed in to OGGI all the same', 'signed in',
        case when wholesale_v2.v2_session_person(r2.session_id, r2.session_token) = r2.person_id
             then 'signed in' else 'TURNED AWAY' end);

  -- The request must carry BOTH the person and the link, or approving it takes
  -- the anonymous branch and the wholesaler cannot see where it came from.
  select count(*) into n from wholesale_v2.v2_signup_requests sr
   where sr.wid = wA and sr.person_id = r2.person_id
     and sr.share_link_id = (select l.id from wholesale_v2.v2_share_links l where l.token = v_t_one);
  insert into zzr_results values
    (8, 'the request names the person AND the link it came through', '1', n::text);

  ------------------------------------------------------ 9-10. the phone match
  insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone)
  values (wA, 'one_time', '03 111 333') returning token into v_t_one;
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_one, '03 777 666', 'Not Rita', 'Third Shop', 'thirdzzr', 'hunter2secret');

  insert into zzr_results values
    (9, 'a number that is not the one the wholesaler wrote down asks instead', 'requested',
        coalesce(r.outcome, 'REFUSED: ' || coalesce(r.msg,'')));

  -- LINK-04: the wholesaler must be able to see it might be the right person on
  -- a second SIM. That is only possible if BOTH numbers are in the message.
  insert into zzr_results values
    (10, '...and the wholesaler is told BOTH numbers', 'both',
         case when r.msg like '%03 111 333%' and r.msg like '%03 777 666%' then 'both'
              else 'ONLY ONE OR NEITHER' end);

  ------------------------------------------------------------- 11-13. the cap
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_cap, '03 222 111', 'A', 'Capped One', 'capazzr', 'hunter2secret');
  insert into zzr_results values
    (11, 'the first through a capped link is let in', 'joined', coalesce(r.outcome, 'REFUSED'));

  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_cap, '03 222 333', 'B', 'Capped Two', 'capbzzr', 'hunter2secret');
  insert into zzr_results values
    (12, 'the one after the cap asks instead — Hadi''s sixth person', 'requested', coalesce(r.outcome, 'REFUSED'));

  -- LINK-07: "only the first five that COMPLETE THE SIGN IN actually get the
  -- auto access." A slot is spent by a GRANT, not by an arrival -- so the
  -- wholesaler who set five still has five real ones to give.
  insert into zzr_results values
    (13, 'the count spends a slot on a grant, not on an arrival', '1',
         coalesce((select l.uses_count::text from wholesale_v2.v2_share_links l where l.token = v_t_cap), 'NO LINK'));

  ------------------------------------------------------------- 14. approval
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_app, '03 333 111', 'C', 'Approval Shop', 'apprzzr', 'hunter2secret');
  insert into zzr_results values
    (14, 'an approval link never grants, and always signs them up', 'requested + signed in',
         case when r.outcome = 'requested'
                   and wholesale_v2.v2_session_person(r.session_id, r.session_token) = r.person_id
              then 'requested + signed in' else coalesce(r.outcome, 'REFUSED') || ' / no session' end);

  ------------------------------------------------- 15-16. one human, one client
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_unl, '03 444 111', 'D', 'Unlimited Shop', 'unlzzr', 'hunter2secret');
  select * into r2 from wholesale_v2.v2_redeem_share_link(
    v_t_unl, '00961 3 444111', 'D', 'Unlimited Shop Again', 'unl2zzr', 'hunter2secret');

  insert into zzr_results values
    (15, 'the same human down a forwarded link twice is not a second customer', 'already',
         coalesce(r2.outcome, 'REFUSED: ' || coalesce(r2.msg,'')));

  select count(*) into n from wholesale_v2.v2_clients c where c.wid = wA and c.shop_name like 'Unlimited%';
  insert into zzr_results values
    (16, '...and the wholesaler''s client list has ONE row for them', '1', n::text);

  ------------------------------------------ 17. ⭐ THREE DEAD LINKS, ONE ANSWER
  -- Migration 056's rule. A used-up link is allowed to name the store, because
  -- the token was really sent to somebody. A link that never existed, one that
  -- was withdrawn and one that has expired must be indistinguishable, or this
  -- function is an oracle for whether any 24-hex string was ever real.
  insert into wholesale_v2.v2_share_links (wid, kind, revoked_at, revoked_by)
  values (wA, 'unlimited', now(), '00000000-0000-4000-8000-000000000001')
  returning token into v_t_rev;
  -- ⓘ THE EXPIRED LINK HAS TO BE AGED, NOT FABRICATED, and that is migration
  -- 127 doing its job: `v2_share_links_expiry_window` requires
  -- `expires_at > created_at`, so an expiry cannot simply be shoved into the
  -- past. The fixture moves BOTH timestamps back, which is what really happens
  -- to a link somebody sent last month.
  insert into wholesale_v2.v2_share_links (wid, kind, expires_at)
  values (wA, 'unlimited', now() + interval '1 hour') returning token, id into v_t_exp, v_link;
  update wholesale_v2.v2_share_links
     set created_at = now() - interval '40 days', expires_at = now() - interval '10 days'
   where id = v_link;

  select msg into v_msg_missing from wholesale_v2.v2_redeem_share_link(
    'deadbeefdeadbeefdeadbeef', '03 555 111', 'E', 'Nowhere', 'nowzzr', 'hunter2secret');
  select msg into v_msg_revoked from wholesale_v2.v2_redeem_share_link(
    v_t_rev, '03 555 222', 'F', 'Nowhere Two', 'now2zzr', 'hunter2secret');
  select msg into v_msg_expired from wholesale_v2.v2_redeem_share_link(
    v_t_exp, '03 555 333', 'G', 'Nowhere Three', 'now3zzr', 'hunter2secret');

  insert into zzr_results values
    (17, 'never-existed, withdrawn and expired answer identically', '1 distinct answer',
         (select count(distinct m)::text || ' distinct answer'
            from (values (v_msg_missing), (v_msg_revoked), (v_msg_expired)) v(m)));

  insert into zzr_results values
    (18, '...and that answer names no store', 'names nothing',
         case when coalesce(v_msg_missing,'') ilike '%Redeem Gate Co%' then 'IT NAMES THE STORE'
              else 'names nothing' end);

  ------------------------------------------------- 19-20. the shop-name clash
  -- The clash is a fact about the wholesaler's records, not a field the
  -- redeemer can retype. So it goes to the wholesaler as a request rather than
  -- becoming the wall the rule at the top of this file forbids.
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_unl, '03 666 111', 'H', 'Rita Boutique', 'clashzzr', 'hunter2secret');
  insert into zzr_results values
    (19, 'a shop name already on their books asks rather than refusing', 'requested',
         coalesce(r.outcome, 'REFUSED: ' || coalesce(r.msg,'')));
  insert into zzr_results values
    (20, '...and that person is still signed up to OGGI', 'signed in',
         case when r.ok and wholesale_v2.v2_session_person(r.session_id, r.session_token) = r.person_id
              then 'signed in' else 'TURNED AWAY' end);

  --------------------------------------------- 21-22. the username clash
  -- The other half of the pair, and it is refused ON PURPOSE: a taken username
  -- is a field the redeemer is still looking at. What must NOT happen is a
  -- half-written redemption -- a person, a credential or a session created for
  -- somebody who was then told no.
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_unl, '03 888 111', 'I', 'Ninth Shop', 'ritazzr', 'hunter2secret');
  insert into zzr_results values
    (21, 'a taken username is refused, because retyping fixes it', 'refused',
         case when r.ok then 'IT WAS ACCEPTED' else 'refused' end);

  select count(*) into n from wholesale_v2.v2_person_channels ch
   where ch.kind = 'phone' and ch.normalised = '9613888111';
  insert into zzr_results values
    (22, '⭐ ...and nothing at all was written for them', '0', n::text);

  ------------------------------------------------ 23. the password really works
  -- The credential is proven by signing in with it through the app's own front
  -- door, not by finding a row in v2_person_credentials.
  select * into r from wholesale_v2.v2_marketplace_login('03 111 222', 'hunter2secret');
  insert into zzr_results values
    (23, '⭐ the password they chose signs them in to OGGI', 'true', coalesce(r.ok::text, 'null'));
end
$check$;

select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzr_results

  -- 24. anon MAY redeem -- by necessity, because the redeemer has no account.
  union all select 24, 'a signed-out stranger may redeem a link', 'yes',
    (select case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'yes' else 'NO, THE FEATURE IS DEAD' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link')

  -- 25. ...and exactly one overload of it exists. Migration 113: a defaulted
  --     argument created a second overload, PostgREST refused BOTH with
  --     PGRST203, and the live feed broke until 114 dropped the old one.
  union all select 25, 'exactly one overload, so PostgREST can call it', '1',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link')

  -- 26. the links table itself is still not readable by a browser. Redemption
  --     is SECURITY DEFINER and takes a token; granting the table would let
  --     anyone list every link every wholesaler has ever sent.
  union all select 26, 'redemption did not open the links table to a browser', 'none',
    (select coalesce(string_agg(distinct g.grantee || ':' || g.privilege_type, ', '), 'none')
       from information_schema.role_table_grants g
      where g.table_schema = 'wholesale_v2' and g.table_name = 'v2_share_links'
        and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
) r
order by ord, label;

rollback;
