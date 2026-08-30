-- =============================================================================
-- 108 — A REQUEST NOBODY CAN ANSWER IS NOT A REQUEST     AC-01/AC-10, 30 Aug 2026
-- =============================================================================
--
-- Found working out why AC-12 (auto-approve rules) could not be built.
--
-- ==== WHAT IS WRONG, MEASURED =============================================
--
-- The public "Don't have an account? Request access" form on the sign-in screen
-- collects exactly five things: the wholesaler code, a shop name, a location, a
-- typical volume, and what they sell.
--
--     IT COLLECTS NO PHONE NUMBER AND NO EMAIL ADDRESS.
--
-- So a wholesaler receives a request from "Noor Boutique, Tripoli", presses
-- Approve, and `v2_approve_signup_request` mints a one-time password which the
-- screen correctly tells them to relay by hand -- to somebody they have no way
-- of contacting. There is no transactional email in this build and there is no
-- phone number on the row. **Every request through that door is unanswerable**,
-- and it has been since Batch 4.
--
-- Nobody noticed for the same reason nobody noticed 107: production has zero
-- approved requests. The path has never run.
--
-- ==== WHY THIS IS ALSO THE FIX FOR SOMETHING SHIPPED EIGHT HOURS AGO =======
--
-- Migration 106 gave the anonymous door a cooldown, and could only match a
-- re-application to its predecessor on the NORMALISED SHOP NAME, because a
-- typed name was the only handle that door had. That limitation is written into
-- 106's header and asserted, deliberately, as a known gap.
--
-- A phone number is a far better handle, and it is one the applicant has a
-- reason to give correctly: it is how they get their password. So the same
-- change that makes a request answerable also narrows the gap 106 had to leave
-- open -- from "type a different name" to "type a different name AND a
-- different number".
--
-- It is still not proof. Nothing verifies that the number belongs to them (see
-- ID-05: there is no OTP anywhere in this build, and `v2_person_channels` has
-- `verified_at` null on every row that exists). It is a better handle, not an
-- identity, and this file does not claim otherwise.
--
-- ==== THE DECISION THAT SHAPES THIS FILE ==================================
--
--     THE NORMALISED KEY IS A GENERATED COLUMN, NOT SOMETHING A FUNCTION
--     REMEMBERS TO COMPUTE.
--
-- `v2_normalise_channel` is IMMUTABLE, which means Postgres can hold the
-- normalised form as a STORED GENERATED column. It is then impossible for the
-- key and the raw value to disagree: not through a second insert path, not
-- through a hand-typed UPDATE in the SQL editor, not through a future function
-- that forgets. Migration 101 was built because eight numbers had only ever
-- been changed by hand-typed SQL; this is the version of that lesson that the
-- database can enforce by itself.
--
-- ==== WHAT THIS DOES NOT DO ===============================================
--
-- It does NOT make an approved anonymous applicant into an OGGI buyer. Their
-- account still has no `person_id`, and `v2_set_marketplace_password` refuses to
-- upgrade an account without one -- so they still cannot reach the directory,
-- switch stores, or search across stores. Fixing that means deciding whether a
-- typed, unverified phone number is enough to create a person with, and that is
-- Hadi's decision and the same question as ID-05. It is written into
-- docs/OUTSTANDING.md rather than guessed at here.
--
-- ==== AND A NOTE ON WHEN THIS REACHES PRODUCTION ==========================
--
-- Every migration this weekend went to production BEFORE its code, because
-- every one of them was backward compatible. THIS ONE IS NOT: it makes the
-- phone required, and the currently-deployed sign-in screen has no field to
-- type one into. Applying it early would break that form for as long as the
-- pull request sat unmerged. So it is applied AFTER the code, and the reversal
-- is stated here rather than discovered later.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. SOMEWHERE TO PUT THE NUMBER
-- ---------------------------------------------------------------------------
-- `phone` is what they typed, kept verbatim, because a wholesaler reading the
-- queue should see the number the way its owner writes it. `phone_key` is the
-- normalised form, and it is GENERATED -- see the header for why that matters
-- more than it looks.
alter table wholesale_v2.v2_signup_requests
  add column if not exists phone text;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='wholesale_v2' and table_name='v2_signup_requests'
                    and column_name='phone_key') then
    alter table wholesale_v2.v2_signup_requests
      add column phone_key text
      generated always as (wholesale_v2.v2_normalise_channel('phone', phone)) stored;
  end if;
end $$;

comment on column wholesale_v2.v2_signup_requests.phone is
  'AC-01. How the wholesaler reaches this shop. Until migration 108 the public request form collected no contact detail at all, so approving one produced a password with nobody to send it to. Stored exactly as typed: a wholesaler should see the number the way its owner writes it.';
comment on column wholesale_v2.v2_signup_requests.phone_key is
  'AC-10. The normalised form, GENERATED so it cannot disagree with the raw value through any insert path, any hand-typed UPDATE, or any function that forgets. Used to match an anonymous re-application to the request it follows -- a better handle than the shop name migration 106 had to settle for, and still not proof of anything: nothing in this build verifies a phone number (ID-05).';

create index if not exists idx_v2_signup_requests_wid_phonekey
  on wholesale_v2.v2_signup_requests(wid, phone_key, created_at desc)
  where phone_key is not null;

-- ---------------------------------------------------------------------------
-- 2. THE MATCHER LEARNS ABOUT PHONES
-- ---------------------------------------------------------------------------
-- Dropped and recreated rather than replaced: it gains a fourth argument, and
-- leaving the three-argument version in place would make every existing
-- internal call ambiguous. The callers are NOT edited -- their three-argument
-- calls resolve to this function's default -- which is the point of adding the
-- parameter at the end with a default rather than reshuffling the signature.
--
-- PRECEDENCE, AND WHY IT IS THIS ORDER:
--
--   person > phone > name
--
-- A signed-in buyer's history is theirs whatever they have since renamed the
-- shop to, or which number they typed. Below that, a phone number is a handle
-- the applicant has a REASON to give correctly -- it is how they get their
-- password -- whereas a shop name is free text with no consequence attached.
-- The name stays as the last resort, because a request made before this
-- migration has no phone at all and must still match its successors.
drop function if exists wholesale_v2.v2_access_reapply_standing(uuid, text, text);

create function wholesale_v2.v2_access_reapply_standing(
  p_person uuid, p_wid text, p_name text default null, p_phone text default null)
returns table (
  state         text,
  latest_id     uuid,
  next_attempt  integer,
  can_reapply   boolean,
  next_at       timestamptz,
  needs_note    boolean,
  last_note     text,
  last_reason   text,
  attempts_used integer,
  max_attempts  integer,
  advice        text,
  matched_on    text)
language plpgsql stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_latest wholesale_v2.v2_signup_requests%rowtype;
  v_pol    wholesale_v2.v2_access_reapply_policy%rowtype;
  v_key    text;
  v_ph     text;
  v_by     text;
  v_used   integer;
  v_next   timestamptz;
begin
  v_key := wholesale_v2.v2_shop_key(p_name);
  v_ph  := wholesale_v2.v2_normalise_channel('phone', p_phone);

  if coalesce(p_wid,'') = '' or (p_person is null and v_ph is null and v_key is null) then
    return query select 'unknown'::text, null::uuid, 1, false, null::timestamptz,
                        false, null::text, null::text, 0, 0, null::text, 'nothing'::text;
    return;
  end if;

  v_by := case when p_person is not null then 'person'
               when v_ph is not null     then 'phone'
               else 'name' end;

  if p_person is not null and exists (
       select 1 from wholesale_v2.v2_person_memberships m
        where m.person_id = p_person and m.wid = p_wid and m.active) then
    return query select 'member'::text, null::uuid, 0, false, null::timestamptz,
                        false, null::text, null::text, 0, 0, null::text, v_by;
    return;
  end if;

  select count(*) into v_used
    from wholesale_v2.v2_signup_requests r
   where r.wid = p_wid
     and case v_by
           when 'person' then r.person_id = p_person
           when 'phone'  then r.phone_key = v_ph
           else wholesale_v2.v2_shop_key(r.buyer_name) = v_key
         end;

  select * into v_latest
    from wholesale_v2.v2_signup_requests r
   where r.wid = p_wid
     and case v_by
           when 'person' then r.person_id = p_person
           when 'phone'  then r.phone_key = v_ph
           else wholesale_v2.v2_shop_key(r.buyer_name) = v_key
         end
   order by r.created_at desc, r.attempt desc, r.id desc limit 1;

  if v_latest.id is null then
    return query select 'first_time'::text, null::uuid, 1, true, null::timestamptz,
                        false, null::text, null::text, 0, 0, null::text, v_by;
    return;
  end if;

  if v_latest.status = 'pending' then
    return query select 'pending'::text, v_latest.id, v_latest.attempt, false,
                        null::timestamptz, false, v_latest.sells, null::text,
                        v_used, 0, null::text, v_by;
    return;
  end if;

  if v_latest.status = 'approved' then
    return query select 'approved'::text, v_latest.id, v_latest.attempt, false,
                        null::timestamptz, false, v_latest.sells, null::text,
                        v_used, 0, null::text, v_by;
    return;
  end if;

  select * into v_pol from wholesale_v2.v2_access_reapply_policy
   where reason_code = coalesce(nullif(v_latest.reason_code,''), '__unknown__');
  if v_pol.reason_code is null then
    select * into v_pol from wholesale_v2.v2_access_reapply_policy
     where reason_code = '__unknown__';
  end if;
  if v_pol.reason_code is null then
    v_pol.reason_code   := '__missing__';
    v_pol.reappliable   := true;
    v_pol.cooldown_days := 30;
    v_pol.requires_note := true;
    v_pol.max_attempts  := 3;
    v_pol.buyer_advice  := 'Say a little about your shop.';
  end if;

  v_next := coalesce(v_latest.decided_at, v_latest.reviewed_at, v_latest.created_at)
            + make_interval(days => v_pol.cooldown_days);

  if not v_pol.reappliable then
    return query select 'blocked'::text, v_latest.id, v_latest.attempt, false,
                        null::timestamptz, false, v_latest.sells,
                        v_latest.reason_code, v_used, v_pol.max_attempts,
                        v_pol.buyer_advice, v_by;
    return;
  end if;

  if v_used >= v_pol.max_attempts then
    return query select 'exhausted'::text, v_latest.id, v_latest.attempt, false,
                        null::timestamptz, false, v_latest.sells,
                        v_latest.reason_code, v_used, v_pol.max_attempts,
                        v_pol.buyer_advice, v_by;
    return;
  end if;

  if now() < v_next then
    return query select 'wait'::text, v_latest.id, v_latest.attempt + 1, false,
                        v_next, v_pol.requires_note, v_latest.sells,
                        v_latest.reason_code, v_used, v_pol.max_attempts,
                        v_pol.buyer_advice, v_by;
    return;
  end if;

  return query select 'ok'::text, v_latest.id, v_latest.attempt + 1, true,
                      v_next, v_pol.requires_note, v_latest.sells,
                      v_latest.reason_code, v_used, v_pol.max_attempts,
                      v_pol.buyer_advice, v_by;
end $fn$;

comment on function wholesale_v2.v2_access_reapply_standing(uuid, text, text, text) is
  'AC-10, + the phone from 108. The single authority on whether an applicant may ask a wholesaler for access. Matches on person, else phone, else shop name -- in that order, because a signed-in buyer''s history is theirs whatever they renamed the shop to, and a phone number is a handle the applicant has a reason to give correctly since it is how they get their password. Granted to no role: it takes an identity.';

revoke all on function wholesale_v2.v2_access_reapply_standing(uuid, text, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE SIGN-IN SCREEN DOOR ASKS FOR A NUMBER, AND MEANS IT
-- ---------------------------------------------------------------------------
-- Dropped and recreated for the same reason: a sixth argument with a default,
-- and the five-argument version left in place would make the existing client's
-- call ambiguous. PostgREST resolves by argument NAME, so a client that does
-- not send `p_phone` still reaches this function -- and is then refused, in
-- words, with the reason.
--
-- THE NUMBER IS VALIDATED, NOT JUST COLLECTED. `v2_normalise_channel` returns
-- null for anything under seven digits, so "call me" and "12" are refused here
-- rather than stored as a contact detail that is not one. A field that accepts
-- anything is a field that teaches people to type anything.
drop function if exists wholesale_v2.v2_submit_signup_request(text, text, text, text, text);

create function wholesale_v2.v2_submit_signup_request(
  p_wid text, p_buyer_name text, p_location text, p_volume text, p_sells text,
  p_phone text default null)
returns table (ok boolean, msg text)
language plpgsql
security definer
set search_path = wholesale_v2
as $fn$
declare
  v_rl_ok boolean;
  v_st    record;
  v_name  text;
  v_note  text;
  v_ph    text;
begin
  if p_wid is null or not exists (select 1 from v2_wholesalers where wid = p_wid and active = true) then
    return query select false, 'Unknown or inactive wholesaler';
    return;
  end if;
  if p_buyer_name is null or trim(p_buyer_name) = '' then
    return query select false, 'A shop/buyer name is required';
    return;
  end if;

  v_ph := wholesale_v2.v2_normalise_channel('phone', p_phone);
  if v_ph is null then
    return query select false,
      'A phone number is required. It is the only way they can send you your login — nothing is emailed.';
    return;
  end if;

  v_name := trim(p_buyer_name);
  v_note := nullif(btrim(coalesce(p_sells,'')), '');

  select * into v_st
    from wholesale_v2.v2_access_reapply_standing(null, p_wid, v_name, p_phone);

  if v_st.state = 'pending' then
    return query select false, 'You have already asked this wholesaler. They have your request.'; return;
  end if;

  if v_st.state = 'approved' then
    return query select false, 'This shop was approved already. Sign in, or ask the wholesaler to check your login.'; return;
  end if;

  if v_st.state = 'blocked' then
    return query select false, coalesce(v_st.advice,
      'Applying again will not help here — contact the store directly.'); return;
  end if;

  if v_st.state = 'exhausted' then
    return query select false,
      'This shop has asked ' || v_st.attempts_used ||
      ' times and been turned down. Another request will not be read differently — talk to them directly instead.'; return;
  end if;

  if v_st.state = 'wait' then
    return query select false,
      'This shop can ask again on ' || to_char(v_st.next_at, 'FMDD Mon YYYY') || '. ' ||
      coalesce(v_st.advice, 'Nothing is lost — the wholesaler can still see the earlier request.'); return;
  end if;

  if v_st.needs_note and (v_note is null or length(v_note) < 10) then
    return query select false,
      'Say a line or two about what you sell before asking again. ' ||
      coalesce(v_st.advice, 'The same request sent twice gets the same answer.'); return;
  end if;

  if v_st.needs_note and v_note is not null and v_st.last_note is not null
     and lower(regexp_replace(v_note, '\s+', ' ', 'g'))
       = lower(regexp_replace(v_st.last_note, '\s+', ' ', 'g')) then
    return query select false,
      'That is word for word what was sent last time, and it was turned down. Tell them something they did not have.'; return;
  end if;

  v_rl_ok := v2_rate_limit_check('signup_request|' || p_wid, 30, 3600);
  if not v_rl_ok then
    return query select false, 'Too many requests for this wholesaler right now -- please try again later';
    return;
  end if;

  insert into v2_signup_requests
    (wid, buyer_name, location, volume, sells, status, supersedes, attempt, phone)
  values (p_wid, v_name, p_location, p_volume, p_sells, 'pending',
          v_st.latest_id, greatest(1, coalesce(v_st.next_attempt, 1)), btrim(p_phone));

  return query select true, '';
end;
$fn$;

comment on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text, text) is
  'Batch 4, + AC-10 (106), + the phone (108). The sign-in-screen door into v2_signup_requests. A phone number is now REQUIRED and validated through v2_normalise_channel, because until 108 this form collected no contact detail at all -- so approving one of its requests minted a password with nobody to send it to. Re-applications through this door now match on the number rather than on a typed shop name.';

revoke all on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text, text) from public;
grant execute on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. AND THE WHOLESALER CAN SEE IT
-- ---------------------------------------------------------------------------
-- A number recorded and not shown is the same as no number. Dropped and
-- recreated for the extra output column, and re-granted, because dropping a
-- function drops its privileges with it -- the lesson migration 105 wrote down
-- when it dropped v2_directory_list.
drop function if exists wholesale_v2.v2_pending_access_requests();

create function wholesale_v2.v2_pending_access_requests()
returns table (
  id            uuid,
  wid           text,
  buyer_name    text,
  location      text,
  volume        text,
  sells         text,
  status        text,
  created_at    timestamptz,
  attempt       integer,
  phone         text,
  prior_count   integer,
  prior_id      uuid,
  prior_reason_code text,
  prior_reason_text text,
  prior_decided_at  timestamptz,
  prior_note    text,
  prior_by      text)
language plpgsql stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_owner boolean; v_wid text;
begin
  v_owner := wholesale_v2.v2_is_owner();
  v_wid   := nullif(wholesale_v2.v2_my_wid(), '');
  if not v_owner and v_wid is null then return; end if;

  return query
  select r.id, r.wid, r.buyer_name, r.location, r.volume, r.sells, r.status,
         r.created_at, r.attempt, r.phone,
         (select count(*)::integer from wholesale_v2.v2_signup_requests o
           where o.wid = r.wid and o.id <> r.id
             and case when r.person_id is not null then o.person_id = r.person_id
                      when r.phone_key is not null then o.phone_key = r.phone_key
                      else wholesale_v2.v2_shop_key(o.buyer_name)
                           = wholesale_v2.v2_shop_key(r.buyer_name) end),
         p.id, p.reason_code, p.reason_text, p.decided_at, p.sells, p.reviewed_by
    from wholesale_v2.v2_signup_requests r
    left join wholesale_v2.v2_signup_requests p on p.id = r.supersedes
   where r.status = 'pending'
     and (v_owner or r.wid = v_wid)
   order by r.created_at desc, r.attempt desc;
end $fn$;

comment on function wholesale_v2.v2_pending_access_requests() is
  'AC-10/AC-01, + the phone (108). The pending queue with the previous application attached AND a number the wholesaler can actually reach them on. prior_count counts by person, else by phone, else by shop name -- the SAME precedence the standing function used to let the request through, because two definitions of "how many times has this shop asked" is how a queue ends up disagreeing with the rule that filled it.';

revoke all on function wholesale_v2.v2_pending_access_requests() from public, anon;
grant execute on function wholesale_v2.v2_pending_access_requests() to authenticated;

-- =============================================================================
-- SELF-ASSERTING. Every assertion holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; v_ok boolean; v_msg text; v_state text; v_by text;
begin
  -- 1. THE KEY IS GENERATED, NOT COMPUTED BY SOMETHING THAT MIGHT FORGET.
  select count(*) into n from information_schema.columns
   where table_schema='wholesale_v2' and table_name='v2_signup_requests'
     and column_name='phone_key' and is_generated = 'ALWAYS';
  if n <> 1 then raise exception 'ASSERT 1 FAILED: phone_key is not a generated column, so a second insert path can disagree with it'; end if;

  -- 2. The anonymous door REFUSES without a usable number. Both halves: nothing
  --    at all, and something that is not a phone number.
  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_submit_signup_request('__nope__','A Shop',null,null,null,null) d;
  if v_ok then raise exception 'ASSERT 2 FAILED: a request with no phone number was accepted'; end if;

  -- 3. ...and the number is VALIDATED, not merely present. Checked against the
  --    normaliser rather than against a length, so there is one definition of
  --    "is this a phone number" in the schema and not two.
  if wholesale_v2.v2_normalise_channel('phone', '12') is not null then
    raise exception 'ASSERT 3 FAILED: the normaliser accepts a two-digit fragment as a phone number';
  end if;
  if wholesale_v2.v2_normalise_channel('phone', '03 456 789') is distinct from '9613456789' then
    raise exception 'ASSERT 3 FAILED: the normaliser no longer resolves a local Lebanese number the way the rest of the schema does';
  end if;

  -- 4. PRECEDENCE. A phone outranks a name, and a person outranks both. Proven
  --    through the function rather than read off the source, because the order
  --    of three CASE branches is exactly the kind of thing that reads correctly
  --    and evaluates wrongly.
  select s.matched_on into v_by from wholesale_v2.v2_access_reapply_standing(
    null, '__nope__', 'A Shop', '03 456 789') s;
  if v_by is distinct from 'phone' then raise exception 'ASSERT 4 FAILED: with a name AND a number it matched on %, not the number', v_by; end if;

  select s.matched_on into v_by from wholesale_v2.v2_access_reapply_standing(
    null, '__nope__', 'A Shop', null) s;
  if v_by is distinct from 'name' then raise exception 'ASSERT 4 FAILED: with only a name it matched on %', v_by; end if;

  select s.matched_on into v_by from wholesale_v2.v2_access_reapply_standing(
    '00000000-0000-0000-0000-000000000000'::uuid, '__nope__', 'A Shop', '03 456 789') s;
  if v_by is distinct from 'person' then raise exception 'ASSERT 4 FAILED: with a person, a name AND a number it matched on %', v_by; end if;

  -- 5. An unusable number does not silently become a match key. '12' normalises
  --    to null, so it must fall back to the name rather than matching every
  --    other applicant who also typed nonsense.
  select s.matched_on into v_by from wholesale_v2.v2_access_reapply_standing(
    null, '__nope__', 'A Shop', '12') s;
  if v_by is distinct from 'name' then raise exception 'ASSERT 5 FAILED: an unusable number was used as a match key (matched_on=%)', v_by; end if;

  -- 6. The standing function is still TOTAL and still granted to nobody.
  select s.state into v_state from wholesale_v2.v2_access_reapply_standing(null, null, null, null) s;
  if v_state is distinct from 'unknown' then raise exception 'ASSERT 6 FAILED: no identity at all answered %, not unknown', v_state; end if;

  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and routine_name='v2_access_reapply_standing'
     and grantee in ('anon','authenticated','public');
  if n <> 0 then raise exception 'ASSERT 6 FAILED: % role(s) can call the standing helper, which takes an identity', n; end if;

  -- 7. 106's rule survives a signature change: EVERY anon-callable function that
  --    inserts an access request still walks through the one check. Both doors
  --    were rewritten in this file and this is what says neither lost it.
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.prosrc ~* 'insert\s+into\s+(wholesale_v2\.)?v2_signup_requests'
     and p.prosrc !~* 'v2_access_reapply_standing'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception 'ASSERT 7 FAILED: % anon-callable function(s) insert an access request without asking v2_access_reapply_standing', n; end if;

  -- 8. EXACTLY ONE of each rewritten function exists. A dropped-and-recreated
  --    function that did not drop leaves two overloads, and PostgREST then picks
  --    one by argument names -- silently, and not necessarily the new one.
  for v_msg in select unnest(array['v2_access_reapply_standing','v2_submit_signup_request','v2_pending_access_requests']) loop
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='wholesale_v2' and p.proname = v_msg;
    if n <> 1 then raise exception 'ASSERT 8 FAILED: % has % overloads, so a caller can reach the old one', v_msg, n; end if;
  end loop;

  -- 9. The grants came back after the drops. A dropped function loses its
  --    privileges, and a queue nobody may execute is a blank screen.
  if not has_function_privilege('authenticated','wholesale_v2.v2_pending_access_requests()','execute')
    then raise exception 'ASSERT 9 FAILED: no wholesaler can read the pending queue -- the grant did not come back after the drop'; end if;
  if not has_function_privilege('anon','wholesale_v2.v2_submit_signup_request(text,text,text,text,text,text)','execute')
    then raise exception 'ASSERT 9 FAILED: anon cannot reach the request form -- the grant did not come back after the drop'; end if;
  if has_function_privilege('anon','wholesale_v2.v2_pending_access_requests()','execute')
    then raise exception 'ASSERT 9 FAILED: the drop-and-recreate handed the pending queue to anon'; end if;

  raise notice '108 OK: a request carries a number the wholesaler can answer on, the key is generated, and person beats phone beats name.';
end $$;
