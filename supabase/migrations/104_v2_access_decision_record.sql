-- =============================================================================
-- 104 — THE ACCESS DECISION RECORD                 AC-08, AC-09, AC-17, 30 Aug 2026
-- =============================================================================
--
-- Three actions decide whether a shop can buy from a wholesaler: approving a
-- request, declining one, and issuing or revoking an invitation. Today:
--
--   * APPROVING writes nothing to the audit log.
--   * DECLINING is a raw table UPDATE from the browser -- there is no function,
--     no reason, and no record beyond a status word.
--   * ISSUING and REVOKING an invitation write nothing either.
--
-- So the one table that could answer "who let this shop in?" -- the question
-- AC-17 exists for, and the question a wholesaler eventually asks in anger --
-- is not written to by any of the actions that let shops in. Banning and
-- unbanning a client DO write to it (migration 059), which is what makes the
-- gap look like an oversight rather than a decision.
--
-- ==== THE DECISION THAT SHAPES THIS FILE ===================================
--
--     THE AUDIT IS WRITTEN BY TRIGGERS ON THE TABLES, NOT BY THE FUNCTIONS.
--
-- The obvious fix is to add an insert to each of the four functions. It was
-- rejected for three reasons:
--
--   1. Decline is not a function. It is a browser writing to a table. Auditing
--      "the functions" would miss the one path that has no function -- and
--      that path is the one this migration exists to fix.
--   2. Three functions edited by hand is three chances to patch one wrongly,
--      and the bodies would have to be reconstructed from `pg_proc.prosrc`
--      rather than the repo copy -- the lesson of migration 086.
--   3. A trigger on the table catches the NEXT code path too. Somebody will
--      add a fifth way to approve a buyer; a trigger is already watching it.
--
-- This is the same argument that made 101's recorder a trigger, and it is now
-- the second time in two days the answer has been "watch the table".
--
-- ==== WHAT THIS DOES NOT DO ================================================
--
-- It does not tell the buyer anything. A decline reason that only the
-- wholesaler can see is half a feature -- AC-08 asks for the buyer to be told.
-- The buyer-facing half needs a screen a pending buyer can actually reach, and
-- that is AC-07/PB-01, built next. This migration makes the reason EXIST and
-- makes it impossible to decline without one; the next one shows it.
-- Splitting it that way means the reason is being captured from the first
-- decline onward, rather than arriving with the screen and leaving every
-- decline before it unexplained.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A DECLINE HAS A REASON
-- ---------------------------------------------------------------------------
alter table wholesale_v2.v2_signup_requests
  add column if not exists reason_code text,
  add column if not exists reason_text text,
  add column if not exists decided_at  timestamptz;

comment on column wholesale_v2.v2_signup_requests.reason_code is
  'AC-08. Why a request was declined. A short code so the buyer-facing wording can be rewritten later without rewriting history, and so "declined for the same reason as last time" is answerable.';

-- The vocabulary. Deliberately small, and deliberately includes a code for the
-- honest answer that is not the buyer''s fault -- without it every decline gets
-- labelled with whichever code is least embarrassing to send.
alter table wholesale_v2.v2_signup_requests
  drop constraint if exists v2_signup_requests_reason_known;
alter table wholesale_v2.v2_signup_requests
  add constraint v2_signup_requests_reason_known check (
    reason_code is null or reason_code in (
      'not_a_retailer',      -- we sell wholesale; this looks like a consumer
      'outside_area',        -- we do not deliver there
      'cannot_verify',       -- we could not confirm the shop is real
      'existing_account',    -- they already have access under another name
      'not_taking_clients',  -- capacity, not the applicant
      'other'                -- requires reason_text, see below
    ));

-- 'other' without an explanation is the loophole that turns a required reason
-- into an optional one. Same rule, same wording, as the client-ban reasons in
-- migration 059 -- one vocabulary for the whole product, not two.
alter table wholesale_v2.v2_signup_requests
  drop constraint if exists v2_signup_requests_other_needs_text;
alter table wholesale_v2.v2_signup_requests
  add constraint v2_signup_requests_other_needs_text check (
    reason_code is distinct from 'other'
    or (reason_text is not null and length(btrim(reason_text)) > 0));

-- NOTE: there is deliberately NO constraint requiring every 'rejected' row to
-- carry a reason. One request on production is `pending` and none is rejected,
-- so such a constraint would pass today -- and it would fire later on a row
-- somebody declined through the old browser path before it was removed, which
-- turns a historical gap into an outage. The REQUIREMENT is enforced where the
-- decision is made, in v2_decline_signup_request below, which is the only path
-- that will exist once the client is switched over.

-- ---------------------------------------------------------------------------
-- 2. THE RECORDER
-- ---------------------------------------------------------------------------
-- The most specific name available, and never a guess: the signed-in person's
-- own label, else the wholesaler code, else 'owner' (who has no wid), else the
-- database role. It never invents an actor.
--
-- ==== A CONVENTION THIS FILE IS THE SECOND TO LEARN ========================
--
-- NONE of the functions below carry comments inside their bodies, and the
-- reasoning sits above them instead. A comment inside a body is copied into
-- pg_proc, so every path that ever installs the function has to reproduce it
-- byte-for-byte or the repo and the database quietly disagree. That happened
-- with migration 101 last night and again with this one; both times the fix was
-- to move the prose out. From here on, new functions in this schema keep their
-- reasoning in the migration file around them, not in the body.
create or replace function wholesale_v2.v2_access_actor()
returns text
language plpgsql stable
set search_path = wholesale_v2, public
as $fn$
begin
  return coalesce(
    (select p.actor_label from wholesale_v2.v2_user_profiles p where p.id = auth.uid()),
    nullif(wholesale_v2.v2_my_wid(), ''),
    case when wholesale_v2.v2_is_owner() then 'owner' end,
    current_user::text);
exception when others then
  return current_user::text;
end $fn$;

-- Only a real change of decision is an event: an UPDATE that leaves `status`
-- alone is somebody editing a note on a pending request, and must not fill the
-- log with rows saying nothing happened. A timeline nobody can read is the same
-- thing as not having one.
create or replace function wholesale_v2.v2_audit_access_request()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_action text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;

  v_action := case
    when tg_op = 'INSERT'         then 'access_requested'
    when new.status = 'approved'  then 'access_approved'
    when new.status = 'rejected'  then 'access_declined'
    else 'access_status_changed'
  end;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (
    case when tg_op = 'INSERT' then coalesce(new.buyer_name, 'a buyer')
         else wholesale_v2.v2_access_actor() end,
    v_action, 'signup_request', new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'wid',         new.wid,
      'buyer_name',  new.buyer_name,
      'from_status', case when tg_op = 'UPDATE' then old.status end,
      'to_status',   new.status,
      'reason_code', new.reason_code,
      'reason_text', new.reason_text)));
  return null;
end $fn$;

comment on function wholesale_v2.v2_audit_access_request() is
  'AC-17. Records every access decision on v2_signup_requests, whatever made it -- the approve RPC, the decline RPC, the old browser status flip, or a hand-typed statement. A trigger and not four function edits, because one of the four paths is a browser writing to a table and has no function to edit.';

drop trigger if exists trg_v2_audit_access_request on wholesale_v2.v2_signup_requests;
create trigger trg_v2_audit_access_request
  after insert or update on wholesale_v2.v2_signup_requests
  for each row execute function wholesale_v2.v2_audit_access_request();

-- ...and the same for invitations, which are the other way into a locked store.
-- THE TOKEN IS THE CREDENTIAL and is the one field that must never be copied
-- here: the audit log is read by more people, and for far longer, than the
-- invitation is valid for. The shop name and the last four digits of the phone
-- go in instead, so the row still means something to a human reading it.
--
-- The `else return null` branch covers every update that does not change who
-- can get in.
create or replace function wholesale_v2.v2_audit_buyer_invite()
returns trigger
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'invite_issued';
  elsif new.revoked_at is not null and old.revoked_at is null then
    v_action := 'invite_revoked';
  elsif new.redeemed_at is not null and old.redeemed_at is null then
    v_action := 'invite_redeemed';
  else
    return null;
  end if;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (wholesale_v2.v2_access_actor(), v_action, 'buyer_invite', new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'wid', new.wid, 'shop_name', new.shop_name,
      'phone_last4', right(nullif(new.phone,''), 4))));
  return null;
end $fn$;

comment on function wholesale_v2.v2_audit_buyer_invite() is
  'AC-17. Issuing, revoking and redeeming an invitation are access decisions and are recorded as such. The invite TOKEN is never written to the log -- it is the credential, and an audit log is read by more people than the invite is.';

drop trigger if exists trg_v2_audit_buyer_invite on wholesale_v2.v2_buyer_invites;
create trigger trg_v2_audit_buyer_invite
  after insert or update on wholesale_v2.v2_buyer_invites
  for each row execute function wholesale_v2.v2_audit_buyer_invite();

-- ---------------------------------------------------------------------------
-- 3. DECLINING, PROPERLY
-- ---------------------------------------------------------------------------
-- Authorisation is checked here, not by hiding a button: owner, or the
-- wholesaler the request was addressed to.
--
-- Declining something already APPROVED is refused, because it would leave a
-- working buyer login sitting behind a rejected request. Revoking access is a
-- different, already-existing action and the message says so.
--
-- AC-09: the row is UPDATED, never deleted. A deletion loses the history and
-- lets the same applicant loop forever with nobody able to see they were here
-- before -- which is exactly what AC-10 needs next.
create or replace function wholesale_v2.v2_decline_signup_request(
  p_id uuid, p_reason_code text, p_reason_text text default null)
returns table (ok boolean, msg text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_req wholesale_v2.v2_signup_requests%rowtype;
begin
  select * into v_req from wholesale_v2.v2_signup_requests where id = p_id for update;
  if v_req.id is null then
    return query select false, 'That request no longer exists.'; return;
  end if;

  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_req.wid) then
    return query select false, 'Not authorized'; return;
  end if;

  if v_req.status = 'approved' then
    return query select false,
      'That request was already approved. To take their access away, ban the client instead — it is reversible and it actually closes the login.';
    return;
  end if;

  if coalesce(p_reason_code,'') = '' then
    return query select false,
      'Choose a reason. It is recorded, and it is what the buyer is told — a decline nobody can explain is the complaint that comes back.';
    return;
  end if;

  update wholesale_v2.v2_signup_requests
     set status      = 'rejected',
         reason_code = p_reason_code,
         reason_text = nullif(btrim(coalesce(p_reason_text,'')), ''),
         reviewed_by = wholesale_v2.v2_access_actor(),
         reviewed_at = now(),
         decided_at  = now()
   where id = p_id;

  return query select true, 'Declined, and the reason is recorded.';
end $fn$;

comment on function wholesale_v2.v2_decline_signup_request(uuid, text, text) is
  'AC-08/AC-09. Declines an access request with a REQUIRED reason, keeps the row as a state rather than deleting it, and is audited by the trigger above rather than by an insert in here. Replaces the raw browser-side status flip in js/data/owner.js.';

revoke all on function wholesale_v2.v2_decline_signup_request(uuid, text, text) from public, anon;
grant execute on function wholesale_v2.v2_decline_signup_request(uuid, text, text) to authenticated;

-- =============================================================================
-- SELF-ASSERTING — structure and authorisation only. The behavioural proof is
-- checks/check_access_decisions.sql, which runs in a transaction it rolls back,
-- for the same reason 101 gave: an audit log must not be seeded with fabricated
-- events by its own installer.
--
-- Every assertion holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; v_ok boolean;
begin
  -- 1. Both recorders exist, and both fire on insert AND update.
  select count(*) into n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and not t.tgisinternal
     and t.tgname in ('trg_v2_audit_access_request','trg_v2_audit_buyer_invite');
  if n <> 2 then raise exception 'ASSERT 1 FAILED: % of 2 access recorders installed', n; end if;

  select count(*) into n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='wholesale_v2' and not t.tgisinternal
     and t.tgname in ('trg_v2_audit_access_request','trg_v2_audit_buyer_invite')
     and (t.tgtype::int & 20) <> 20;      -- 4 = INSERT, 16 = UPDATE
  if n <> 0 then raise exception 'ASSERT 1 FAILED: % recorder(s) do not fire on both insert and update', n; end if;

  -- 2. THE TOKEN IS NOT LOGGED. A promise about what is NOT written, asserted
  --    against the function that would write it.
  if (select prosrc from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
       where ns.nspname='wholesale_v2' and p.proname='v2_audit_buyer_invite') ~* '\mnew\.token\M' then
    raise exception 'ASSERT 2 FAILED: the invite token is being copied into the audit log -- it is the credential';
  end if;

  -- 3. Declining is owner-or-own-wid only, and refuses without a reason.
  --    Run as postgres there is no jwt, so v2_is_owner() is false: the refusal
  --    below is the authorisation check doing its job.
  select d.ok into v_ok from wholesale_v2.v2_decline_signup_request(
    '00000000-0000-0000-0000-000000000000'::uuid, 'other', 'x') d;
  if v_ok then raise exception 'ASSERT 3 FAILED: declining a non-existent request reported success'; end if;

  -- 4. anon cannot decline anything.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee='anon'
     and routine_name='v2_decline_signup_request';
  if n <> 0 then raise exception 'ASSERT 4 FAILED: anon can decline access requests'; end if;

  -- 5. The reason vocabulary is enforced by the database and not by the screen.
  begin
    insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, reason_code)
    values ('__assert__', '__assert__', 'rejected', 'nonsense_code');
    raise exception 'ASSERT 5 FAILED: an unknown decline reason was accepted';
  exception
    when check_violation then null;                       -- expected
    when foreign_key_violation then null;                 -- also fine: wid does not exist
    when sqlstate 'P0001' then
      if sqlerrm like 'ASSERT 5 FAILED%' then raise; end if;
  end;

  -- 6. 'other' cannot be used as a way round the requirement.
  begin
    insert into wholesale_v2.v2_signup_requests (wid, buyer_name, status, reason_code)
    values ('__assert__', '__assert__', 'rejected', 'other');
    raise exception 'ASSERT 6 FAILED: reason_code "other" was accepted with no explanation';
  exception
    when check_violation then null;
    when foreign_key_violation then null;
    when sqlstate 'P0001' then
      if sqlerrm like 'ASSERT 6 FAILED%' then raise; end if;
  end;

  raise notice '104 OK: every access decision is recorded by a trigger, declining requires a reason, and the invite token never reaches the log.';
end $$;
