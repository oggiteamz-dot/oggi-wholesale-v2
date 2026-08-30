-- =============================================================================
-- 106 — APPLYING AGAIN AFTER A DECLINE                        AC-10, 30 Aug 2026
-- =============================================================================
--
-- AC-10 reads like a new feature. It is not. It is a rule for something the
-- product already does, twice over, badly and silently.
--
-- ==== WHAT ACTUALLY HAPPENS TODAY, MEASURED ================================
--
-- `v2_directory_request_access` (migration 091) refuses two cases: the buyer is
-- already a member, and the buyer already has a PENDING request. A buyer whose
-- request was DECLINED falls straight through both and inserts a new pending
-- row. So re-applying already works — instantly, unlimited times, with nothing
-- linking the new request to the one that was turned down.
--
-- That is not "AC-10 is missing". That is AC-10 built the wrong way round:
--
--   * the wholesaler reviews the same shop for the third time and cannot see
--     they declined it twice, or why, because nothing joins the rows;
--   * the buyer is never told they may apply again, so the honest ones do not,
--     and only the ones who keep clicking get through;
--   * and there is no cooldown of any kind. The only limiter is 091's rate
--     limit, which is 30 requests per hour PER WHOLESALER across ALL buyers —
--     a shared budget one determined applicant can spend on their own.
--
-- ==== THE FINDING: THERE ARE TWO DOORS, NOT ONE ============================
--
-- The first draft of this migration asserted that `v2_directory_request_access`
-- is the only anon-callable function that inserts into `v2_signup_requests`.
-- That assertion failed against production, which is what it was for.
--
--     `v2_submit_signup_request` (migration 024) is also granted to anon, also
--     inserts a pending request, and is live behind "Don't have an account?
--     Request access" on the sign-in screen (js/views/login.js:306).
--
-- It takes a typed wholesaler code and a typed shop name from somebody with no
-- OGGI account at all. So a buyer sitting inside a cooldown can sign out, open
-- the sign-in screen, type their own shop name, and land a fresh request in the
-- same queue — unlinked, with no history, in front of the same wholesaler.
--
-- Every rule below would have been one sign-out away from meaningless.
--
-- ==== THE DECISION THAT SHAPES THIS FILE ===================================
--
--     THE RULE GOES WHERE THE DOORS MEET, AND EVERY DOOR IS MADE TO WALK
--     THROUGH IT.
--
-- Not a new `v2_reapply_for_access(...)`. A second function for the second kind
-- of request would have left BOTH existing buttons calling the old paths with
-- no cooldown. A limit that only applies to the door marked "limit" is not a
-- limit.
--
-- So both existing functions are edited IN PLACE, keep their names and their
-- signatures, and both now ask ONE shared function whether this applicant may
-- ask this wholesaler anything at all.
--
-- This is the 30 August lesson from the half-built PB-01 — the sentence that
-- lived in two places and was fixed in one — applied at design time instead of
-- being found by a gate afterwards: when the promise is a constraint, assert it
-- over the whole artefact, and put it where every path meets.
--
-- ==== THE HONEST LIMIT OF THE ANONYMOUS DOOR ===============================
--
-- The directory door knows WHO is asking: an OGGI account resolves to a person,
-- and a person is a handle a cooldown can hold on to. The sign-in-screen door
-- knows nothing but a typed shop name. It cannot be made as strong, and this
-- file does not pretend it is.
--
-- What it does instead: match on the NAME, normalised. Somebody who re-applies
-- as "Noor Boutique" after being declined as "noor  boutique." is matched, and
-- the cooldown applies. Somebody who types a different name is not, and gets a
-- fresh request.
--
-- That is a real gap and it is deliberate, because of what AC-10 is actually
-- for. The point is not to keep a determined applicant out — nothing available
-- here could, short of identity checks this product does not do. The point is
-- that A WHOLESALER MUST NEVER REVIEW THE SAME SHOP BLIND. Name matching
-- delivers that for every applicant who is not actively evading it, and raises
-- the cost of evasion from zero to "notice, and type something else".
--
-- ==== WHY THE COOLDOWN DEPENDS ON THE REASON ===============================
--
-- One cooldown for every decline would be wrong in both directions, and the
-- reason vocabulary from migration 104 already says so out loud:
--
--   * `cannot_verify` is the buyer's to FIX. Telling a shop "we could not
--     confirm your details" and then making them wait sixty days before they
--     may send the details is punishing them for the thing we asked for. Its
--     cooldown is ZERO and its note is REQUIRED — come back straight away,
--     with something new.
--   * `not_taking_clients` is explicitly not about the applicant. A long
--     cooldown there tells a real shop it did something wrong. Thirty days,
--     no note needed, and more attempts allowed than any other reason.
--   * `existing_account` is the one where applying again is the WRONG ACTION.
--     They already have access under another name; a fourth request does not
--     recover it. Re-application is refused and the buyer is told what would.
--   * `not_a_retailer` and `outside_area` are judgements about facts that
--     change slowly. Long cooldowns, and `not_a_retailer` requires a note
--     because the only thing that can change our mind is new information.
--
-- The numbers live in a TABLE and not in the function bodies, for the reason
-- migration 101 was built at all: a number that decides behaviour, typed into
-- a function, is a number nobody can read and nothing records changing.
--
-- ==== AND WHAT HAPPENS WHEN A ROW IS NOT THERE =============================
--
-- FOUND BY A RED PROOF THAT PRODUCED ZERO FAILURES — the third time in two days
-- that has been the informative outcome (checks/GATE-EVIDENCE.md).
--
-- Deleting the `__unknown__` row was expected to turn a gate red. It changed
-- nothing, and the reason was worse than the gate being blind. With no policy
-- row the whole record is NULL, and every guard below is a comparison against
-- NULL:
--
--     not v_pol.reappliable          -> NULL -> the branch does not fire
--     v_used >= v_pol.max_attempts   -> NULL -> the branch does not fire
--     now() < v_next                 -> NULL -> the branch does not fire
--
-- ...so the function fell through all three and returned `ok`. A MISSING POLICY
-- ROW SILENTLY PERMITTED EVERYTHING. Delete the `existing_account` row and the
-- one applicant this file refuses outright would have been let straight in, and
-- nothing anywhere would have said a word.
--
-- The fallback below is written out in full rather than left to NULL
-- arithmetic. It is deliberately permissive-but-bounded: thirty days, a note,
-- three attempts. Locking every declined shop out of the product because a
-- config row went missing is the worse of the two failures — but so is the
-- silent version, so a reader can now see the answer instead of deriving it
-- from three-valued logic.
--
-- ==== WHAT THIS DOES NOT DO ================================================
--
-- It does not notify anybody. There is still no transactional email in this
-- build (migration 024 says so), and nothing here pretends otherwise. A buyer
-- learns their cooldown has expired by opening the app, which is the same way
-- they learn everything else.
--
-- ==== A DIVERGENCE FOUND ON THE WAY ========================================
--
-- Production's `v2_submit_signup_request` body is 798 bytes; migration 024's
-- copy is longer, because the repo copy carries an in-body comment about the
-- rate limit that production does not have. Behaviour identical, comments only
-- — the same class as migration 086 and the same class as migration 101 last
-- night. The rebuilt body below is taken from PRODUCTION and the comment has
-- moved out here, which is where this schema now keeps its reasoning.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A REQUEST KNOWS WHICH REQUEST IT REPLACES
-- ---------------------------------------------------------------------------
-- `supersedes` and not a `previous_id` on the OLD row: the chain is written by
-- the row being inserted, which is the only row in the transaction, so a
-- re-application can never half-link.
alter table wholesale_v2.v2_signup_requests
  add column if not exists supersedes uuid,
  add column if not exists attempt    integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'v2_signup_requests_supersedes_fk') then
    alter table wholesale_v2.v2_signup_requests
      add constraint v2_signup_requests_supersedes_fk
      foreign key (supersedes) references wholesale_v2.v2_signup_requests(id)
      on delete set null;
  end if;
end $$;

alter table wholesale_v2.v2_signup_requests
  drop constraint if exists v2_signup_requests_attempt_sane;
alter table wholesale_v2.v2_signup_requests
  add constraint v2_signup_requests_attempt_sane check (
    attempt >= 1 and (supersedes is null or supersedes <> id));

comment on column wholesale_v2.v2_signup_requests.supersedes is
  'AC-10. The request this one replaces. A wholesaler reviewing a re-application follows this to what they decided last time and why, instead of reviewing the same shop blind for the third time.';
comment on column wholesale_v2.v2_signup_requests.attempt is
  'AC-10. 1 for a first application. Denormalised from the chain ON PURPOSE so the queue can say "3rd application" without walking a recursive join for every card, and so the per-reason attempt cap is one comparison.';

create index if not exists idx_v2_signup_requests_person_wid
  on wholesale_v2.v2_signup_requests(person_id, wid, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. ONE DEFINITION OF "THE SAME SHOP NAME"
-- ---------------------------------------------------------------------------
-- Lower-cased, punctuation dropped, whitespace collapsed. Written once because
-- two copies of a normaliser is two answers to "is this the same shop", and the
-- one that matters is whichever the query happened to use. It is IMMUTABLE so
-- the index below can be built on it.
--
-- It is deliberately not clever. No stemming, no removing "Ltd" or "Boutique",
-- no fuzzy distance. A normaliser that guesses is a normaliser that one day
-- decides two different shops are the same one, and tells a wholesaler they
-- already declined somebody they have never seen.
create or replace function wholesale_v2.v2_shop_key(p_name text)
returns text
language sql immutable
as $fn$
  select nullif(regexp_replace(
           regexp_replace(lower(btrim(coalesce(p_name,''))), '[^a-z0-9 ]+', '', 'g'),
           '\s+', ' ', 'g'), '');
$fn$;

comment on function wholesale_v2.v2_shop_key(text) is
  'AC-10. The one definition of "the same shop name", for matching an anonymous re-application from the sign-in screen to the request it follows. Deliberately dumb: no stemming and no fuzzy distance, because a normaliser that guesses eventually tells a wholesaler they declined somebody they have never seen.';

create index if not exists idx_v2_signup_requests_wid_shopkey
  on wholesale_v2.v2_signup_requests(wid, wholesale_v2.v2_shop_key(buyer_name), created_at desc);

-- ---------------------------------------------------------------------------
-- 3. THE POLICY, AS DATA
-- ---------------------------------------------------------------------------
-- Keyed by migration 104's reason vocabulary, plus ONE extra key.
--
-- `__unknown__` is not padding. Every request declined before migration 104
-- shipped has `reason_code = null`, because the old path was a browser writing
-- a status word and there was nowhere to put a reason. Without a row for that
-- case the policy lookup returns nothing, and "no policy row" would read as
-- "not re-appliable" — which would silently and permanently lock out every
-- buyer declined before Saturday. It resolves to the most forgiving reading of
-- a decline nobody wrote down.
create table if not exists wholesale_v2.v2_access_reapply_policy (
  reason_code   text primary key,
  reappliable   boolean not null default true,
  cooldown_days integer not null default 30 check (cooldown_days between 0 and 3650),
  requires_note boolean not null default false,
  max_attempts  integer not null default 3 check (max_attempts between 1 and 20),
  buyer_advice  text,
  updated_at    timestamptz not null default now()
);

comment on table wholesale_v2.v2_access_reapply_policy is
  'AC-10. How long after a decline a shop may ask again, whether they must say something new, and how many times. Keyed by migration 104''s reason codes plus __unknown__ for declines made before reasons existed. A table and not constants in a function body, for migration 101''s reason: a number that decides behaviour and lives inside a function is a number nobody can read and nothing records changing.';

insert into wholesale_v2.v2_access_reapply_policy
  (reason_code, reappliable, cooldown_days, requires_note, max_attempts, buyer_advice)
values
  ('cannot_verify',      true,   0, true,  4,
   'Send them what they were missing — where the shop is, a registration number, anything that shows it is a real business.'),
  ('not_taking_clients', true,  30, false, 5,
   'This was about their capacity, not about you. It is worth asking again later.'),
  ('other',              true,  30, true,  3,
   'Say what has changed since last time.'),
  ('not_a_retailer',     true,  60, true,  3,
   'They sell to shops. If you are a shop, say so plainly — what you sell, and where.'),
  ('outside_area',       true,  90, false, 3,
   'They do not deliver to you yet. Asking again only helps once that changes.'),
  ('existing_account',   false, 3650, false, 1,
   'Your shop already has an account with them under another name or number. A new request will not find it — contact the store and ask them to reconnect the one you have.'),
  ('__unknown__',        true,  30, true,  3,
   'Say a little about your shop — this was decided before the app recorded reasons.')
on conflict (reason_code) do nothing;

alter table wholesale_v2.v2_access_reapply_policy enable row level security;

-- No policy is created, deliberately, and no role is granted the table. It is
-- read ONLY from inside the security-definer functions below. A buyer must
-- never be able to read the whole table: "we decline people for X and let them
-- back after N days" is an operating rule, and a shop that can read it can pick
-- the answer that comes back soonest.
revoke all on wholesale_v2.v2_access_reapply_policy from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. THE ONE PLACE THE ANSWER IS DECIDED
-- ---------------------------------------------------------------------------
-- Takes an identity, and is therefore granted to NOBODY. Every caller below is
-- a security-definer function that has already established who is asking — the
-- rule migration 105 set when it refused to let v2_my_access_requests take a
-- person_id. A helper that takes an identity is safe exactly as long as nothing
-- outside can call it, so nothing outside can.
--
-- The person WINS over the name when both are given. A signed-in buyer's
-- history is theirs whatever they have since renamed the shop to, and the name
-- is only ever the fallback for the door that has nothing else.
--
-- `state` is a word and not a boolean because there are six different reasons
-- the answer can be no, and the applicant is owed a different sentence for each.
--
-- ORDERING IS `created_at desc, attempt desc, id desc` AND NOT `created_at desc`
-- ALONE. In production two requests from the same shop are always in different
-- transactions and so always have different `now()` values, so the tiebreak
-- looks like decoration. It is not: checks/check_access_reapply.sql fabricates
-- a whole history inside ONE transaction, where every `created_at` is
-- identical, and a gate that has to work around an ambiguity in the thing it
-- is testing is a gate reporting on a coincidence. `attempt` is the field that
-- actually orders a chain, so it breaks the tie.
create or replace function wholesale_v2.v2_access_reapply_standing(
  p_person uuid, p_wid text, p_name text default null)
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
  v_by     text;
  v_used   integer;
  v_next   timestamptz;
begin
  v_key := wholesale_v2.v2_shop_key(p_name);

  if coalesce(p_wid,'') = '' or (p_person is null and v_key is null) then
    return query select 'unknown'::text, null::uuid, 1, false, null::timestamptz,
                        false, null::text, null::text, 0, 0, null::text, 'nothing'::text;
    return;
  end if;

  v_by := case when p_person is not null then 'person' else 'name' end;

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
     and case when p_person is not null then r.person_id = p_person
              else wholesale_v2.v2_shop_key(r.buyer_name) = v_key end;

  select * into v_latest
    from wholesale_v2.v2_signup_requests r
   where r.wid = p_wid
     and case when p_person is not null then r.person_id = p_person
              else wholesale_v2.v2_shop_key(r.buyer_name) = v_key end
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

comment on function wholesale_v2.v2_access_reapply_standing(uuid, text, text) is
  'AC-10. The single authority on whether an applicant may ask a wholesaler for access — first time or fifth, signed in or not. Granted to no role: it takes an identity, so only the definer functions that have already established who is asking may call it.';

revoke all on function wholesale_v2.v2_access_reapply_standing(uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. DOOR ONE — THE DIRECTORY, EDITED IN PLACE
-- ---------------------------------------------------------------------------
-- Same name, same three arguments, same (ok, msg) shape as migration 091, so
-- js/data/directory.js keeps working unchanged for a first application. What
-- changed is that its two hand-written refusals are gone and it asks the shared
-- function instead — and the answers now include the four it could not give.
--
-- THE `unknown` STATE FALLS THROUGH TO THE INSERT, ON PURPOSE. It is reached
-- only when the account has no person row, which is GP-02's case and three real
-- accounts on production today. Those callers behaved exactly this way before
-- this migration — 091 guarded each of its checks with `v_person is not null`
-- and inserted anyway — and a migration about re-application is not the place
-- to start refusing them. It is written here so the fall-through reads as a
-- decision rather than an oversight.
--
-- THE NOTE MUST BE NEW. `p_note` identical to the note on the request that was
-- declined is not a re-application, it is the same application sent twice, and
-- accepting it would put a wholesaler back in front of a card with nothing on
-- it they have not already turned down. Compared case-insensitively and with
-- whitespace collapsed, because "the same thing again" is a claim about words,
-- not about spacing.
create or replace function wholesale_v2.v2_directory_request_access(
  p_account_id text, p_wid text, p_note text default null)
returns table (ok boolean, msg text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_acc    uuid;
  v_person uuid;
  v_label  text;
  v_shop   text;
  v_st     record;
  v_note   text;
  v_name   text;
begin
  begin
    v_acc := p_account_id::uuid;
  exception when others then
    return query select false, 'Please sign in again.'; return;
  end;

  if not wholesale_v2.v2_account_can_act(v_acc) then
    return query select false, 'Please sign in again.'; return;
  end if;

  if p_wid is null or not exists (
       select 1 from public.wholesalers w where w.wid = p_wid and w.active) then
    return query select false, 'That wholesaler is not available.'; return;
  end if;

  select a.person_id, a.actor_label, c.shop_name
    into v_person, v_label, v_shop
    from wholesale_v2.v2_portal_accounts a
    left join wholesale_v2.v2_clients c on c.id = a.client_id
   where a.id = v_acc;

  v_name := coalesce(nullif(btrim(v_shop), ''), nullif(btrim(v_label), ''), 'A shop on OGGI');

  select * into v_st
    from wholesale_v2.v2_access_reapply_standing(v_person, p_wid, v_name);

  if v_st.state = 'member' then
    return query select false, 'You already have access to this wholesaler.'; return;
  end if;

  if v_st.state = 'pending' then
    return query select false, 'You have already asked this wholesaler. They have your request.'; return;
  end if;

  if v_st.state = 'approved' then
    return query select false, 'This wholesaler approved you already. If you cannot get in, ask them to check your login rather than sending another request.'; return;
  end if;

  if v_st.state = 'blocked' then
    return query select false, coalesce(v_st.advice,
      'Applying again will not help here — contact the store directly.'); return;
  end if;

  if v_st.state = 'exhausted' then
    return query select false,
      'You have asked this wholesaler ' || v_st.attempts_used ||
      ' times and they have said no. Another request will not be read differently — talk to them directly instead.'; return;
  end if;

  if v_st.state = 'wait' then
    return query select false,
      'You can ask this wholesaler again on ' ||
      to_char(v_st.next_at, 'FMDD Mon YYYY') || '. ' ||
      coalesce(v_st.advice, 'Nothing is lost — they can still see your earlier request.'); return;
  end if;

  v_note := nullif(btrim(coalesce(p_note,'')), '');

  if v_st.needs_note and (v_note is null or length(v_note) < 10) then
    return query select false,
      'Write a line or two about your shop before you ask again. ' ||
      coalesce(v_st.advice, 'The same request sent twice gets the same answer.'); return;
  end if;

  if v_st.needs_note and v_note is not null and v_st.last_note is not null
     and lower(regexp_replace(v_note, '\s+', ' ', 'g'))
       = lower(regexp_replace(v_st.last_note, '\s+', ' ', 'g')) then
    return query select false,
      'That is word for word what you sent last time, and it was turned down. Tell them something they did not have.'; return;
  end if;

  if not wholesale_v2.v2_rate_limit_check('signup_request|' || p_wid, 30, 3600) then
    return query select false, 'Too many requests for this wholesaler right now -- please try again later.'; return;
  end if;

  insert into wholesale_v2.v2_signup_requests
    (wid, buyer_name, location, volume, sells, status, person_id, supersedes, attempt)
  values (p_wid, v_name, null, null, v_note, 'pending', v_person,
          v_st.latest_id, greatest(1, coalesce(v_st.next_attempt, 1)));

  if coalesce(v_st.next_attempt, 1) > 1 then
    return query select true, 'Sent again, with your earlier request attached so they can see the whole story.';
  else
    return query select true, 'Sent. The wholesaler will see your request.';
  end if;
end;
$fn$;

comment on function wholesale_v2.v2_directory_request_access(text, text, text) is
  'DR-04 + AC-10. The directory door into v2_signup_requests, first application and re-application alike. Every rule about who may ask, how often, and whether they must say something new lives behind v2_access_reapply_standing, which the sign-in-screen door calls too — because a limit that only applies to one of two doors is one sign-out away from being bypassed.';

revoke all on function wholesale_v2.v2_directory_request_access(text, text, text) from public;
grant execute on function wholesale_v2.v2_directory_request_access(text, text, text) to anon;
grant execute on function wholesale_v2.v2_directory_request_access(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. DOOR TWO — THE SIGN-IN SCREEN, EDITED IN PLACE
-- ---------------------------------------------------------------------------
-- Rebuilt from PRODUCTION's body (see the divergence note in the header), with
-- the standing check added and nothing else changed: same name, same five
-- arguments, same (ok, msg) shape, same `v2_wholesalers` active check, same
-- rate limit, same `search_path`. js/lib/dev-auth.js is untouched by this.
--
-- There is no person here and there never can be, so the match is on the shop
-- name and the refusals say a little less than the directory's. What matters is
-- that a matched re-application now arrives LINKED: the wholesaler sees the
-- previous application whichever door it came through.
--
-- `p_sells` doubles as the note, because it is the only free text this form
-- collects and it is already where the directory door puts its note.
create or replace function wholesale_v2.v2_submit_signup_request(
  p_wid text, p_buyer_name text, p_location text, p_volume text, p_sells text)
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
begin
  if p_wid is null or not exists (select 1 from v2_wholesalers where wid = p_wid and active = true) then
    return query select false, 'Unknown or inactive wholesaler';
    return;
  end if;
  if p_buyer_name is null or trim(p_buyer_name) = '' then
    return query select false, 'A shop/buyer name is required';
    return;
  end if;

  v_name := trim(p_buyer_name);
  v_note := nullif(btrim(coalesce(p_sells,'')), '');

  select * into v_st
    from wholesale_v2.v2_access_reapply_standing(null, p_wid, v_name);

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
    (wid, buyer_name, location, volume, sells, status, supersedes, attempt)
  values (p_wid, v_name, p_location, p_volume, p_sells, 'pending',
          v_st.latest_id, greatest(1, coalesce(v_st.next_attempt, 1)));

  return query select true, '';
end;
$fn$;

comment on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text) is
  'Batch 4, + AC-10 (106). The sign-in-screen door into v2_signup_requests, for an applicant with no OGGI account. It now walks through the SAME v2_access_reapply_standing as the directory door, matched on the normalised shop name because a typed name is the only handle this path has. Weaker than the person-keyed match on purpose and stated as such: the point is that no wholesaler reviews the same shop blind, not that a determined applicant cannot type a different name.';

revoke all on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text) from public;
grant execute on function wholesale_v2.v2_submit_signup_request(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. WHAT THE BUYER SEES — extended, and only on the row that owns the answer
-- ---------------------------------------------------------------------------
-- DROP and recreate, not `create or replace`: Postgres will not change a
-- function's output columns in place. Same drop-and-recreate migration 105 did
-- to v2_directory_list, for the same reason, and the grants are re-issued below
-- because dropping a function drops its privileges with it.
--
-- ==== THE SUBTLETY WORTH THE PARAGRAPH =====================================
--
-- Re-apply standing belongs to a WHOLESALER, not to a request. A buyer with a
-- declined first attempt and a pending second one has two rows for one
-- wholesaler, and exactly one of them may carry an "Ask again" button. Putting
-- the standing on every row would render two buttons for one relationship, and
-- the one on the old row would be wrong.
--
-- So the standing is computed only for the NEWEST row per wid, and every older
-- row is flagged `superseded` so the screen can fold it away as history rather
-- than showing it as a live state. Deciding that here rather than in the browser
-- means the browser cannot get it wrong on a screen it renders before anything
-- else has loaded.
drop function if exists wholesale_v2.v2_my_access_requests(text);

create function wholesale_v2.v2_my_access_requests(p_account_id text)
returns table (
  request_id      uuid,
  wid             text,
  wholesaler_name text,
  brand           text,
  status          text,
  requested_at    timestamptz,
  decided_at      timestamptz,
  reason_code     text,
  reason_text     text,
  sla_hours       integer,
  hours_waiting   integer,
  overdue         boolean,
  attempt         integer,
  superseded      boolean,
  reapply_state   text,
  can_reapply     boolean,
  reapply_at      timestamptz,
  reapply_note_required boolean,
  reapply_advice  text)
language plpgsql stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_acc uuid; v_person uuid;
begin
  begin v_acc := p_account_id::uuid; exception when others then return; end;
  if not wholesale_v2.v2_account_can_act(v_acc) then return; end if;

  select a.person_id into v_person
    from wholesale_v2.v2_portal_accounts a where a.id = v_acc;
  if v_person is null then return; end if;

  return query
  with mine as (
    select r.*,
           row_number() over (partition by r.wid order by r.created_at desc, r.attempt desc, r.id desc) as rn
      from wholesale_v2.v2_signup_requests r
     where r.person_id = v_person)
  select m.id, m.wid,
         coalesce(nullif(btrim(w.name),''), w.brand, m.wid),
         w.brand,
         m.status,
         m.created_at,
         m.decided_at,
         m.reason_code,
         m.reason_text,
         w.access_sla_hours,
         greatest(0, floor(extract(epoch from (now() - m.created_at)) / 3600)::integer),
         (m.status = 'pending'
          and now() > m.created_at + make_interval(hours => w.access_sla_hours)),
         m.attempt,
         (m.rn > 1),
         s.state,
         coalesce(s.can_reapply, false),
         case when s.state = 'wait' then s.next_at end,
         coalesce(s.needs_note, false),
         s.advice
    from mine m
    join wholesale_v2.v2_wholesalers w on w.wid = m.wid
    left join lateral wholesale_v2.v2_access_reapply_standing(v_person, m.wid, m.buyer_name) s
      on m.rn = 1
   order by m.created_at desc, m.attempt desc;
end $fn$;

comment on function wholesale_v2.v2_my_access_requests(text) is
  'AC-07/AC-10/AC-11/PB-01. Every access request this person has made, where each stands, and — on the newest row per wholesaler only — whether they may ask again and when. Scope is the caller''s own person, resolved inside the function: there is nothing here for a caller to name, because a function taking a person_id would let anyone read anyone else''s rejections.';

revoke all on function wholesale_v2.v2_my_access_requests(text) from public;
grant execute on function wholesale_v2.v2_my_access_requests(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. WHAT THE WHOLESALER SEES — the previous application, attached
-- ---------------------------------------------------------------------------
-- The queue is a raw `supabase.from('v2_signup_requests').select('*')` in both
-- js/data/wholesaler-admin.js and js/data/owner.js. A raw select cannot carry
-- the previous attempt, and adding a second round-trip per card to fetch it
-- would mean the history loads AFTER the buttons — so the fast path to a
-- decision stays the uninformed one.
--
-- One function serves both screens because both were asking the same question
-- with different authorisation, which is how the owner console ended up
-- selecting with NO wid filter at all and trusting RLS alone. The scope is
-- derived here: owner sees every pending request, a wholesaler sees theirs,
-- anyone else sees none.
--
-- `prior_count` counts by person when there is one and by shop name when there
-- is not, matching exactly what the standing function counted when it let the
-- request through. Two different definitions of "how many times has this shop
-- asked" is how a queue ends up disagreeing with the rule that filled it.
create or replace function wholesale_v2.v2_pending_access_requests()
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
         r.created_at, r.attempt,
         (select count(*)::integer from wholesale_v2.v2_signup_requests o
           where o.wid = r.wid and o.id <> r.id
             and case when r.person_id is not null then o.person_id = r.person_id
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
  'AC-10/AC-01. The pending access-request queue with the previous application attached, for the wholesaler''s own screen and the owner console alike. Scope is derived from the session inside the function -- owner sees all, a wholesaler sees only their own wid, anybody else sees nothing -- rather than from a filter the browser supplies and can drop.';

revoke all on function wholesale_v2.v2_pending_access_requests() from public, anon;
grant execute on function wholesale_v2.v2_pending_access_requests() to authenticated;

-- =============================================================================
-- SELF-ASSERTING — structure and authorisation only. The behavioural proof is
-- checks/check_access_reapply.sql, which fabricates a decline inside a
-- transaction it rolls back.
--
-- Every assertion below holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; v_ok boolean; v_msg text; v_state text; v_key text;
begin
  -- 1. Every reason migration 104 permits has a policy row, and the policy
  --    table has no row for a reason that does not exist. A vocabulary that
  --    drifts is how a new decline reason silently becomes "not re-appliable".
  select count(*) into n
    from (select unnest(array['not_a_retailer','outside_area','cannot_verify',
                              'existing_account','not_taking_clients','other']) as c) v
   where not exists (select 1 from wholesale_v2.v2_access_reapply_policy p
                      where p.reason_code = v.c);
  if n <> 0 then raise exception 'ASSERT 1 FAILED: % decline reason(s) have no re-apply policy', n; end if;

  select count(*) into n from wholesale_v2.v2_access_reapply_policy p
   where p.reason_code not in ('not_a_retailer','outside_area','cannot_verify',
                               'existing_account','not_taking_clients','other','__unknown__');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: % policy row(s) name a reason the database does not permit', n; end if;

  -- 3. The pre-104 declines are not locked out.
  if not exists (select 1 from wholesale_v2.v2_access_reapply_policy
                  where reason_code = '__unknown__' and reappliable) then
    raise exception 'ASSERT 3 FAILED: a decline with no recorded reason cannot re-apply -- every pre-104 decline is permanent';
  end if;

  -- 4. cannot_verify is the one the buyer can FIX: no wait, but say something.
  if not exists (select 1 from wholesale_v2.v2_access_reapply_policy
                  where reason_code='cannot_verify' and cooldown_days = 0 and requires_note) then
    raise exception 'ASSERT 4 FAILED: cannot_verify must be re-appliable immediately AND require a note';
  end if;

  -- 5. NOBODY can call the standing helper directly. It takes an identity.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and routine_name='v2_access_reapply_standing'
     and grantee in ('anon','authenticated','public');
  if n <> 0 then raise exception 'ASSERT 5 FAILED: % role(s) can call v2_access_reapply_standing, which takes an identity', n; end if;

  -- 6. ...and nobody holds a table grant on the policy either.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_access_reapply_policy'
     and grantee in ('anon','authenticated','public');
  if n <> 0 then raise exception 'ASSERT 6 FAILED: % role(s) can read the re-apply policy table', n; end if;

  -- 7. THE PROMISE IS A PROPERTY OF EVERY DOOR, ASSERTED OVER ALL OF THEM.
  --    (checks/GATE-EVIDENCE.md §7b, 30 Aug.) The first draft of this migration
  --    asserted there is exactly ONE anon-callable function that inserts an
  --    access request. That was false -- v2_submit_signup_request is a second
  --    one -- which is the whole reason section 6 exists. Counting the doors
  --    was the wrong question. The right one is that EVERY door walks through
  --    the check, and it stays right when a third door is added.
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.prosrc ~* 'insert\s+into\s+(wholesale_v2\.)?v2_signup_requests'
     and p.prosrc !~* 'v2_access_reapply_standing'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception 'ASSERT 7 FAILED: % anon-callable function(s) insert an access request WITHOUT asking v2_access_reapply_standing -- the cooldown is one sign-out from being bypassed', n; end if;

  -- 8. Both doors still answer, and both still refuse the obvious nonsense.
  select d.ok into v_ok
    from wholesale_v2.v2_directory_request_access('not-a-uuid', 'anything', null) d;
  if v_ok then raise exception 'ASSERT 8 FAILED: a directory request with no valid session reported success'; end if;

  select d.ok into v_ok
    from wholesale_v2.v2_submit_signup_request('__nope__', 'A Shop', null, null, null) d;
  if v_ok then raise exception 'ASSERT 8 FAILED: a signup request naming an unknown wholesaler reported success'; end if;

  select d.ok, d.msg into v_ok, v_msg
    from wholesale_v2.v2_submit_signup_request('__nope__', '   ', null, null, null) d;
  if v_ok then raise exception 'ASSERT 8 FAILED: a signup request with a blank shop name reported success'; end if;

  -- 9. The standing function is TOTAL: it answers for an applicant it has never
  --    seen rather than returning no row. A caller doing `select * into` on an
  --    empty result gets NULLs, and `if v_st.state = 'member'` on a NULL is
  --    NULL, which falls through every branch -- so an unknown applicant would
  --    reach the insert with no attempt number. Proven, not reasoned about.
  select s.state into v_state from wholesale_v2.v2_access_reapply_standing(
    '00000000-0000-0000-0000-000000000000'::uuid, '__nope__', null) s;
  if v_state is null then raise exception 'ASSERT 9 FAILED: the standing function returned no row for an unknown person -- every branch in both doors would fall through'; end if;
  if v_state <> 'first_time' then raise exception 'ASSERT 9 FAILED: expected first_time for an unknown person, got %', v_state; end if;

  select s.state into v_state from wholesale_v2.v2_access_reapply_standing(
    null, '__nope__', 'A Shop That Has Never Asked') s;
  if v_state is distinct from 'first_time' then raise exception 'ASSERT 9 FAILED: an unseen shop name did not answer first_time, it answered %', v_state; end if;

  select s.state into v_state from wholesale_v2.v2_access_reapply_standing(null, null, null) s;
  if v_state is distinct from 'unknown' then raise exception 'ASSERT 9 FAILED: no identity at all did not answer "unknown", it answered %', v_state; end if;

  -- 10. The chain cannot point at itself, and an attempt cannot be zero.
  if not exists (select 1 from pg_constraint where conname='v2_signup_requests_attempt_sane') then
    raise exception 'ASSERT 10 FAILED: the attempt/supersedes constraint is not installed';
  end if;

  -- 11. The queue is owner-or-wholesaler only, and never anon.
  if has_function_privilege('anon','wholesale_v2.v2_pending_access_requests()','execute') then
    raise exception 'ASSERT 11 FAILED: anon can read the pending access-request queue';
  end if;

  -- 12. Run as postgres there is no jwt: not owner, no wid, so the queue must
  --     return nothing at all rather than everything.
  select count(*) into n from wholesale_v2.v2_pending_access_requests();
  if n <> 0 then raise exception 'ASSERT 12 FAILED: a caller who is neither owner nor wholesaler got % pending request(s)', n; end if;

  -- 13. The shop key does what the matching depends on, and does not do more.
  if wholesale_v2.v2_shop_key('  NOOR  Boutique.  ') is distinct from
     wholesale_v2.v2_shop_key('noor boutique') then
    raise exception 'ASSERT 13 FAILED: the shop key does not match two spellings of the same name';
  end if;
  if wholesale_v2.v2_shop_key('Noor Boutique') = wholesale_v2.v2_shop_key('Noor Boutiques') then
    raise exception 'ASSERT 13 FAILED: the shop key matched two DIFFERENT names -- it is guessing';
  end if;
  select wholesale_v2.v2_shop_key('   ') into v_key;
  if v_key is not null then raise exception 'ASSERT 13 FAILED: a blank name produced a key, so every blank name is the same shop'; end if;

  raise notice '106 OK: both doors walk through one check, a per-reason cooldown, and the previous application attached whichever door it came through.';
end $$;
