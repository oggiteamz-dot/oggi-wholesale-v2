-- =============================================================================
-- CHECK: making, listing and peeking at a share link — LINK-02/11/05, mig. 129
-- =============================================================================
-- The sharpest row in this file is 12, and it is the reason the file exists in
-- this shape rather than as a list of happy paths:
--
--   ⭐ WHAT THE STRANGER'S SCREEN PROMISES AND WHAT REDEMPTION ACTUALLY DOES
--      MUST AGREE, FOR EVERY KIND.
--
-- v2_share_link_peek computes a hint from the link's kind and count;
-- v2_redeem_share_link computes an outcome from the same two things, in a
-- different function, with the branches written out twice. Two copies of one
-- rule is how a screen ends up promising "you're straight in" to somebody the
-- server is about to file an approval request for. This gate calls BOTH and
-- requires them to match.
--
-- The second sharpest is 6: the peek must never name the person the link was
-- sent to. A one-person link travels by WhatsApp and WhatsApp gets forwarded,
-- so a screen opening with "Hi Rita" publishes to whoever it reaches a fact
-- the wholesaler told exactly one person. Asserted by BEHAVIOUR -- the fixture
-- uses a name and a number nothing else could produce, and requires them to
-- appear nowhere in anything peek returns.
--
-- Writes nothing: one transaction, rolled back.

begin;

insert into public.wholesalers (wid, name, active) values
  ('zzm01', 'Maker Gate Co', true),
  ('zzm02', 'Maker Gate Other', true)
on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values
  ('zzm01', 'Maker Gate Co'),
  ('zzm02', 'Maker Gate Other')
on conflict (wid) do nothing;

create temporary table zzm_results (ord int, label text, expected text, got text) on commit drop;

do $check$
declare
  uA uuid := '11111111-cccc-4ccc-8ccc-111111111111';
  uB uuid := '22222222-cccc-4ccc-8ccc-222222222222';
  v_cat_b uuid;
  v_link  uuid;
  v_tok_one text; v_tok_unl text; v_tok_app text; v_tok_cap text;
  v_tok_rev text; v_tok_exp text;
  r record; p record; d record;
  n int;
  SECRET_NAME  constant text := 'Zzqx Secret Shopfront';
  SECRET_PHONE constant text := '03 818 191';
begin
  insert into auth.users (id, email) values
    (uA, 'gate-maker-a@example.invalid'), (uB, 'gate-maker-b@example.invalid')
  on conflict (id) do nothing;
  insert into wholesale_v2.v2_user_profiles (id, wid, role) values
    (uA, 'zzm01', 'wholesaler'), (uB, 'zzm02', 'wholesaler')
  on conflict (id) do update set wid = excluded.wid;
  select id into v_cat_b from wholesale_v2.v2_catalogs where wid = 'zzm02' and is_default;

  ------------------------------------------------------------ as wholesaler A
  perform set_config('request.jwt.claims',
    json_build_object('sub', uA::text, 'role', 'authenticated')::text, true);

  select * into r from wholesale_v2.v2_create_share_link(
    'one_time', SECRET_NAME, SECRET_PHONE, 12.50);
  v_tok_one := r.token;
  insert into zzm_results values
    (1, 'a wholesaler can make a one-person link with a rate on it', 'made',
        case when r.ok and r.token ~ '^[0-9a-f]{24}$' then 'made'
             else 'REFUSED: ' || coalesce(r.msg, '') end);

  select * into r from wholesale_v2.v2_create_share_link('unlimited');
  v_tok_unl := r.token;
  select * into r from wholesale_v2.v2_create_share_link('approval');
  v_tok_app := r.token;
  select * into r from wholesale_v2.v2_create_share_link('capped', null, null, null, 1);
  v_tok_cap := r.token;

  ------------------------------------------------------- 2-5. the refusals
  select * into r from wholesale_v2.v2_create_share_link('one_time', 'X', '123');
  insert into zzm_results values
    (2, 'a one-person link with no usable number is refused IN WORDS', 'a sentence',
        case when r.ok then 'IT WAS ACCEPTED'
             when r.msg like '%phone number%' then 'a sentence'
             else 'an unhelpful refusal: ' || coalesce(r.msg,'') end);

  select * into r from wholesale_v2.v2_create_share_link('unlimited', null, null, 10);
  insert into zzm_results values
    (3, 'a discount on a link anyone can forward is refused (D-5)', 'refused',
        case when r.ok then 'IT WAS ACCEPTED' else 'refused' end);

  select * into r from wholesale_v2.v2_create_share_link('capped');
  insert into zzm_results values
    (4, 'a "set number" link with no number is refused', 'refused',
        case when r.ok then 'IT WAS ACCEPTED' else 'refused' end);

  -- ⭐ The composite key from 127 makes this impossible to STORE; 129 turns it
  -- into a sentence. Both are asserted, here and in check_a_link_is_a_row.sql,
  -- because a sentence without the constraint is a rule one caller obeys.
  select * into r from wholesale_v2.v2_create_share_link('unlimited', null, null, null, null, v_cat_b);
  insert into zzm_results values
    (5, '⭐ a link onto ANOTHER STORE''S shelf is refused in words', 'not one of yours',
        case when r.ok then 'IT WAS ACCEPTED'
             when r.msg like '%not one of yours%' then 'not one of yours'
             else coalesce(r.msg, 'null') end);

  ------------------------------------------------- 6-7. the peek says nothing
  select * into p from wholesale_v2.v2_share_link_peek(v_tok_one);
  insert into zzm_results values
    (6, '⭐ the peek NEVER names the person the link was sent to', 'names nobody',
        case when coalesce(p.msg,'') || coalesce(p.wholesaler_name,'') || coalesce(p.kind,'')
                  || coalesce(p.hint,'') || coalesce(p.wid,'')
                  like '%' || SECRET_NAME || '%'
             then 'IT NAMED THEM'
             when coalesce(p.msg,'') like '%818%' then 'IT PUBLISHED THEIR NUMBER'
             else 'names nobody' end);

  insert into zzm_results values
    (7, '...but it does name the store, or nobody would finish the form', 'Maker Gate Co',
        coalesce(p.wholesaler_name, 'NAMED NOBODY'));

  ----------------------------------------- 8-11. three dead links, one answer
  select * into r from wholesale_v2.v2_create_share_link('unlimited');
  v_tok_rev := r.token;
  select id into v_link from wholesale_v2.v2_share_links where token = v_tok_rev;
  select * into r from wholesale_v2.v2_revoke_share_link(v_link);
  insert into zzm_results values
    (8, 'a wholesaler can withdraw their own link', 'withdrawn',
        case when r.ok then 'withdrawn' else 'REFUSED: ' || coalesce(r.msg,'') end);

  -- Never deleted. 104's pattern: the requests that came through it still
  -- point at it, and a link that was sent and withdrawn is a thing that
  -- happened.
  select count(*) into n from wholesale_v2.v2_share_links where token = v_tok_rev;
  insert into zzm_results values
    (9, 'withdrawing keeps the row — it is a stamp, never a delete', '1', n::text);

  select * into r from wholesale_v2.v2_create_share_link('unlimited');
  v_tok_exp := r.token;
  -- Aged, not fabricated: 127's expiry_window forbids an expiry before
  -- creation, so a link that has run out has to have run out honestly.
  update wholesale_v2.v2_share_links
     set created_at = now() - interval '40 days', expires_at = now() - interval '10 days'
   where token = v_tok_exp;

  insert into zzm_results values
    (10, 'never-existed, withdrawn and expired peek identically', '1 distinct answer',
         (select count(distinct m)::text || ' distinct answer' from (
            select (select msg from wholesale_v2.v2_share_link_peek('deadbeefdeadbeefdeadbeef')) as m
            union all
            select (select msg from wholesale_v2.v2_share_link_peek(v_tok_rev))
            union all
            select (select msg from wholesale_v2.v2_share_link_peek(v_tok_exp))
          ) q));

  insert into zzm_results values
    (11, '...and none of those three names a store', 'names nothing',
         (select case when count(*) filter (where w is not null) > 0
                      then 'A DEAD LINK NAMED ITS STORE' else 'names nothing' end from (
            select (select wholesaler_name from wholesale_v2.v2_share_link_peek('deadbeefdeadbeefdeadbeef')) as w
            union all
            select (select wholesaler_name from wholesale_v2.v2_share_link_peek(v_tok_rev))
            union all
            select (select wholesaler_name from wholesale_v2.v2_share_link_peek(v_tok_exp))
          ) q));

  ------------------------ 12. ⭐ THE SCREEN'S PROMISE AND THE SERVER'S ANSWER
  -- Four kinds, both functions, one comparison. peek's hint is computed in one
  -- function and redemption's outcome in another, from the same two facts,
  -- with the branches written out twice. This row is what stops them drifting.
  perform set_config('request.jwt.claims', '', true);
  n := 0;

  select * into p from wholesale_v2.v2_share_link_peek(v_tok_unl);
  select * into d from wholesale_v2.v2_redeem_share_link(v_tok_unl, '03 700 101', 'U', 'Unl Shop', 'unlzzm', 'hunter2secret');
  if not ((p.hint = 'immediate' and d.outcome = 'joined')) then n := n + 1; end if;

  select * into p from wholesale_v2.v2_share_link_peek(v_tok_app);
  select * into d from wholesale_v2.v2_redeem_share_link(v_tok_app, '03 700 202', 'A', 'App Shop', 'appzzm', 'hunter2secret');
  if not ((p.hint = 'needs_approval' and d.outcome = 'requested')) then n := n + 1; end if;

  -- capped, under the cap: peek says immediate, redemption joins
  select * into p from wholesale_v2.v2_share_link_peek(v_tok_cap);
  select * into d from wholesale_v2.v2_redeem_share_link(v_tok_cap, '03 700 303', 'C', 'Cap Shop', 'capzzm', 'hunter2secret');
  if not ((p.hint = 'immediate' and d.outcome = 'joined')) then n := n + 1; end if;

  -- capped, now full: peek must have CHANGED its mind, and so must redemption
  select * into p from wholesale_v2.v2_share_link_peek(v_tok_cap);
  select * into d from wholesale_v2.v2_redeem_share_link(v_tok_cap, '03 700 404', 'D', 'Cap Shop Two', 'cap2zzm', 'hunter2secret');
  if not ((p.hint = 'needs_approval' and d.outcome = 'requested')) then n := n + 1; end if;

  -- one_time with the RIGHT number: peek warns the phone matters, and it does
  select * into p from wholesale_v2.v2_share_link_peek(v_tok_one);
  select * into d from wholesale_v2.v2_redeem_share_link(v_tok_one, SECRET_PHONE, 'R', 'Rita Shop', 'ritazzm', 'hunter2secret');
  if not ((p.hint = 'phone_must_match' and d.outcome = 'joined')) then n := n + 1; end if;

  insert into zzm_results values
    (12, '⭐ every kind: what the screen promises is what redemption does', '0 disagreements',
         n::text || ' disagreements');

  --------------------------------------------------- 13-15. the list, and D-2
  perform set_config('request.jwt.claims',
    json_build_object('sub', uA::text, 'role', 'authenticated')::text, true);

  select count(*) into n from wholesale_v2.v2_my_share_links() l where l.state = 'revoked';
  insert into zzm_results values
    (13, 'the withdrawn link is still in the list, marked withdrawn', '1', n::text);

  -- uses_count counts grants; the people sent to the approval queue are
  -- counted separately, or a link forty people opened reads "0 of 5 used".
  select coalesce(sum(l.requests_count), 0) into n from wholesale_v2.v2_my_share_links() l;
  insert into zzm_results values
    (14, 'the list counts the people who came through and were sent to approve', '2', n::text);

  -- D-2. Rita is now a customer of zzm01 on SECRET_PHONE, because she redeemed
  -- above. A SECOND link to that number must be refused, naming the shop.
  select * into r from wholesale_v2.v2_create_share_link('one_time', 'Rita again', SECRET_PHONE, 30);
  insert into zzm_results values
    (15, 'a second link to a number that is already their customer is refused (D-2)', 'names the shop',
         case when r.ok then 'IT WAS ACCEPTED'
              when r.msg like '%Rita Shop%' then 'names the shop'
              else 'refused without saying who: ' || coalesce(r.msg,'') end);

  ------------------------------------------------- 16-17. the tenant boundary
  perform set_config('request.jwt.claims',
    json_build_object('sub', uB::text, 'role', 'authenticated')::text, true);

  select count(*) into n from wholesale_v2.v2_my_share_links();
  insert into zzm_results values
    (16, '⭐ another wholesaler sees none of these links', '0', n::text);

  select * into r from wholesale_v2.v2_revoke_share_link(v_link);
  insert into zzm_results values
    (17, '...and cannot withdraw one of them', 'not one of yours',
         case when r.ok then 'THEY WITHDREW SOMEBODY ELSE''S LINK'
              when r.msg like '%not one of yours%' then 'not one of yours'
              else coalesce(r.msg, 'null') end);

  perform set_config('request.jwt.claims', '', true);
end
$check$;

select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzm_results

  -- 18. ⛔ THE THREE WHOLESALER FUNCTIONS ARE NOT A STRANGER'S TO CALL. A
  --     signed-out caller who could list links would have every token every
  --     wholesaler has ever sent.
  union all select 18, 'no signed-out stranger can make, withdraw or list links', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname in ('v2_create_share_link','v2_revoke_share_link','v2_my_share_links')
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 19. ...and the peek IS a stranger's to call, because a stranger is the
  --     only kind of person who holds a link.
  union all select 19, 'a signed-out stranger CAN peek at a link', 'yes',
    (select case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'yes'
                 else 'NO — THE FEATURE IS DEAD' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_share_link_peek')

  -- 20. the peek's SOURCE never mentions the invitee. Row 6 proves the
  --     behaviour on one fixture; this proves the rule, and is what turns red
  --     the day somebody adds the column back for a friendlier greeting.
  union all select 20, 'and its source never reads the invitee at all', 'never',
    (select case when p.prosrc ~* 'invitee_name|invitee_phone' then 'IT READS THE INVITEE' else 'never' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_share_link_peek')

  -- 21. exactly one overload of each (migration 113, PGRST203)
  union all select 21, 'one overload of each, so PostgREST can call them', '4',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname in ('v2_create_share_link','v2_revoke_share_link',
                          'v2_my_share_links','v2_share_link_peek'))
) r
order by ord, label;

rollback;
