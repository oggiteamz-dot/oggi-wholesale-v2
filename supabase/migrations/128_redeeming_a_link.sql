-- 128 — LINK-06 + LINK-03 + LINK-04 + LINK-07 + LINK-08. Redeeming a link.
--
-- HADI, on what the four kinds must do:
--   "Is this a one time link for one person, or this is like an unlimited use
--    link, or is this link but the approval is needed? Or if it's auto approval
--    with, like, a certain number of link users? Like, let's say they set it at
--    five and six people click on the link, only the first five that complete
--    the sign in actually get the auto access. If the sixth person logs in,
--    they just log into the marketplace itself, and they send a request for
--    access for that wholesaler instead. But either way, they get access and
--    they are logged in. THEY ARE SIGNED UP TO THE MARKETPLACE ITSELF."
--
-- THE RULE THAT NEVER BENDS, and every branch below is arranged around it:
--
--   NOBODY WHO OPENS A REAL LINK IS EVER TURNED AWAY FROM OGGI.
--
-- Whatever the kind, whatever the cap, whether the phone matched or not, the
-- person finishes with a marketplace account they can log into. The only thing
-- that varies is whether they walk into THAT WHOLESALER'S STORE today or wait
-- for an approval.
--
-- WHY FIVE PLAN ITEMS ARE ONE MIGRATION, AND THE PLAN SAYS FOUR.
-- docs/LINK-PLAN.md's build order puts LINK-06/03/04 in one step and
-- LINK-07/08 in the next. They are one transaction: the `approval` kind that
-- LINK-03 introduces has nowhere to land without LINK-08's overflow, and
-- shipping it separately would mean a link type that takes a person's details
-- and gives them nothing. The lock, the cap, the match and the overflow are one
-- decision made under one row lock. Splitting them would be a schedule, not a
-- design.
--
-- ---------------------------------------------------------------------------
-- THE ORDER OF OPERATIONS, and it is not arbitrary
-- ---------------------------------------------------------------------------
-- 1. Rate limit, then LOCK the link row. The cap and the one-time flag are both
--    decided under that lock or two people clicking at once both get in.
-- 2. Validate EVERYTHING that can be validated, before writing a single row.
--    A `return query` inside PL/pgSQL does not roll anything back -- the
--    caller's transaction commits whatever was written before it. So a refusal
--    after a write is an orphan.
-- 3. Decide the outcome from the kind, the count and the phone.
-- 4. Write, in this order: person -> channel -> credential -> session, then
--    either the store access or the access request.
-- 5. Increment uses_count LAST, and only when access was actually GRANTED.
--
-- ---------------------------------------------------------------------------
-- FIVE DECISIONS THIS FILE MAKES THAT THE PLAN LEFT OPEN, EACH SAID OUT LOUD
-- ---------------------------------------------------------------------------
--
-- (a) A SHOP-NAME CLASH DOES NOT TURN ANYBODY AWAY. v2_clients carries
--     `unique (wid, shop_name)` since 006. v2_redeem_buyer_invite refuses in
--     that case -- correct for an invite, wrong here, because refusing is
--     exactly the wall the rule above forbids. So a clash falls to the REQUEST
--     path instead: the redeemer still becomes an OGGI buyer with a session,
--     and the wholesaler gets a request naming the clash. The wholesaler is the
--     only person who can actually resolve "is this the same shop or a
--     different one with the same name", so the decision lands where the
--     knowledge is.
--
-- (b) A USERNAME CLASH IS REFUSED, and that is not a contradiction of (a). A
--     taken username is a fixable input error on a form the redeemer is still
--     looking at -- they choose another and continue. A shop-name clash is a
--     fact about the wholesaler's existing records that no amount of retyping
--     resolves. One is a field to correct; the other is a question for a human.
--
-- (c) AN EXPIRED LINK ANSWERS EXACTLY LIKE A REVOKED ONE AND A MADE-UP ONE.
--     Migration 056's rule. It costs the useful hint "this expired, ask for a
--     new one", and that is a real cost paid on purpose: an answer that
--     distinguishes them turns this function into an oracle for whether any
--     24-hex string was ever a real link. The message names no store and tells
--     the holder to go back to whoever sent it, which is where they were going
--     to have to go anyway.
--
-- (d) uses_count COUNTS GRANTS, NOT ARRIVALS. Hadi: "only the first five that
--     COMPLETE THE SIGN IN actually get the auto access." A sixth person who
--     completes and falls to a request has not used a slot -- so the wholesaler
--     can still revoke and re-issue five real ones. It also keeps
--     `v2_share_links_uses_within_cap` true, which a count of arrivals would
--     violate on a one_time link the moment a second person finished. The cost:
--     the link list cannot say "8 came, 5 got in" from this column alone. It
--     can, from `v2_signup_requests.share_link_id`, which is why that column is
--     added here.
--
-- (e) THE LINK'S CATALOGUE IS A LANDING PAGE, NOT A PERMISSION, so redemption
--     does not write it anywhere. Migration 120 removed the tier gate on Hadi's
--     word -- "Tier two, gate. Drop it. Completely remove it." -- and the rule
--     that replaced it is A MEMBER OF A STORE SEES THAT STORE. A share link
--     that quietly re-scoped a buyer to one shelf would put the gate back under
--     a different name. `catalog_id` decides what the STRANGER'S SCREEN shows
--     before they join (LINK-05); after they join they see the store.
--
-- ---------------------------------------------------------------------------
-- WHAT THE RATE LIMIT DOES AND DOES NOT DO -- stated because the plan's line
-- ("so a link cannot be brute-forced") claims more than a per-token key can.
-- Keyed on the token, it stops one KNOWN link being hammered. It does NOT stop
-- somebody guessing tokens, because every guess is a different key. What stops
-- that is 96 bits of entropy from the database. This function has no IP
-- address to key on -- PostgREST does not pass one to SQL -- and inventing a
-- worse key would be worse than saying so.

--------------------------------------------- ⭐ A DEFECT THIS MIGRATION FOUND
-- v2_rate_limit_check IS NOT SAFE UNDER CONCURRENCY, AND IT NEVER WAS.
--
-- Its first branch is:
--
--   select * into v_row from v2_rate_limit_hits where key = p_key for update;
--   if v_row.key is null then
--     insert into v2_rate_limit_hits(key, hits, window_start) values (p_key, 1, now());
--     return true;
--
-- `for update` locks a row that EXISTS. On a key nobody has used yet there is
-- no row to lock, so every concurrent caller takes that branch and every one of
-- them tries to INSERT the same primary key. One wins; the rest get
--
--   ERROR: duplicate key value violates unique constraint "v2_rate_limit_hits_pkey"
--
-- raised straight out of the RPC at whoever was unlucky.
--
-- HOW IT WAS FOUND. Not by reading it. checks/check_link_cap_under_concurrency.sh
-- races eight sign-ups down one link, and the link token is the rate-limit key,
-- so all eight hit a brand-new key at the same instant. Three joined, four were
-- asked to wait, and ONE got a Postgres error. The cap was right; the limiter
-- was not. A single-connection gate could never have seen it -- which is the
-- whole reason that file opens real connections.
--
-- THE BLAST RADIUS IS NOT THIS FEATURE. Measured on production, which carries
-- this exact body (md5 30e9a0381c38ab395132936ede8cf0f3, identical to the
-- replay) and 2 keys on file. Three live callers, and all three are anonymous
-- public forms -- precisely where two strangers arrive at once on a key neither
-- has used:
--
--   v2_submit_signup_request      the "request access" form on the login screen
--   v2_directory_request_access   asking a store in the directory for access
--   v2_redeem_invite              redeeming a buyer invitation
--
-- The window is small -- the FIRST hit of any given key -- but "the first two
-- people ever to use this form at the same second" is not an exotic case for a
-- form that is meant to be shared.
--
-- THE FIX IS ONE STATEMENT INSTEAD OF THREE, and the semantics are preserved
-- exactly rather than approximately:
--
--   new key ......................... hits 1, allowed        (was: allowed)
--   window expired .................. hits reset to 1, allowed (was: allowed)
--   under the limit ................. hits + 1, allowed      (was: allowed)
--   at the limit .................... denied                 (was: denied)
--
-- `least(hits + 1, p_max + 1)` is what keeps the last line true without letting
-- the counter climb for ever while somebody hammers a locked-out key: it parks
-- at p_max + 1, which is above the limit and stays there until the window rolls.
create or replace function wholesale_v2.v2_rate_limit_check(
  p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_hits integer;
begin
  insert into wholesale_v2.v2_rate_limit_hits (key, hits, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set hits = case
                 when wholesale_v2.v2_rate_limit_hits.window_start
                        < now() - make_interval(secs => p_window_seconds)
                 then 1
                 else least(wholesale_v2.v2_rate_limit_hits.hits + 1, p_max + 1)
               end,
        window_start = case
                 when wholesale_v2.v2_rate_limit_hits.window_start
                        < now() - make_interval(secs => p_window_seconds)
                 then now()
                 else wholesale_v2.v2_rate_limit_hits.window_start
               end
  returning hits into v_hits;

  -- <= rather than <, because v_hits now INCLUDES this call. The old code
  -- compared the count BEFORE incrementing, so p_max calls were allowed; this
  -- allows p_max calls too. Getting that boundary wrong by one would either
  -- lock people out a call early or let one extra through, and neither would
  -- show up in any test that does not count exactly.
  return v_hits <= p_max;
end;
$fn$;

comment on function wholesale_v2.v2_rate_limit_check(text, integer, integer) is
  'Allows p_max calls per key per window. Rewritten by 128 as a single atomic '
  'upsert: the previous version did select-for-update then a bare INSERT, so '
  'two callers racing a key that did not exist yet BOTH inserted and one got a '
  'raw duplicate-key error out of a public form. Found by '
  'check_link_cap_under_concurrency.sh, which is the only gate in this repo '
  'that opens more than one connection.';

-------------------------------------------------- LINK-08: where a request came from
alter table wholesale_v2.v2_signup_requests
  add column if not exists share_link_id uuid
  references wholesale_v2.v2_share_links(id) on delete set null;

comment on column wholesale_v2.v2_signup_requests.share_link_id is
  'LINK-08. Which share link this request arrived through, so the wholesaler '
  'reviewing it reads "came through the link you sent to Rita, 03 456 789" '
  'instead of a name and a shrug. ON DELETE SET NULL: deleting a link must '
  'never delete the request somebody is waiting on.';

create index if not exists idx_v2_signup_requests_share_link
  on wholesale_v2.v2_signup_requests (share_link_id, created_at desc)
  where share_link_id is not null;

------------------------------------------------------------------ redemption
create or replace function wholesale_v2.v2_redeem_share_link(
  p_token     text,
  p_phone     text,
  p_name      text,
  p_shop_name text,
  p_username  text,
  p_password  text,
  p_answers   jsonb default null   -- LINK-10. Accepted and IGNORED until then.
)
returns table (
  ok              boolean,
  msg             text,
  outcome         text,        -- 'joined' | 'requested' | 'already' | null
  wid             text,
  wholesaler_name text,
  client_id       uuid,
  account_id      uuid,
  session_id      uuid,
  session_token   text,
  person_id       uuid,
  expires_at      timestamptz
)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_link    wholesale_v2.v2_share_links%rowtype;
  v_wname   text;
  v_phone   text;   -- normalised key of what the REDEEMER typed
  v_shop    text;
  v_user    text;
  v_person  uuid;
  v_client  uuid;
  v_account uuid;
  v_grant   boolean;
  v_why     text;   -- why access was not granted, in the wholesaler's words
  v_secret  text;
  v_sid     uuid;
  v_exp     timestamptz;
  v_msg     text;
  v_outcome text;
  v_existing uuid;  -- an existing membership for this person and store
  SESSION_LEN constant interval := interval '30 days';
  -- p_answers is deliberately unread. Keeping it in the signature now is the
  -- lesson of migration 113: adding a defaulted argument LATER creates a second
  -- overload, PostgREST refuses both with PGRST203, and the feed breaks until
  -- somebody drops one. The same choice migration 122 made with p_catalog_id.
begin
  ------------------------------------------------------------------ the door
  if not wholesale_v2.v2_rate_limit_check('link|' || coalesce(p_token, ''), 20, 600) then
    return query select false, 'Too many attempts. Try again in a few minutes.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- FOR UPDATE, and this is the line the cap depends on. Two people finishing
  -- the fifth and sixth sign-ups at the same instant are serialised here or
  -- they both read uses_count = 4 and both get in.
  select * into v_link from wholesale_v2.v2_share_links l
   where l.token = p_token for update;

  -- ONE message for three states. See note (c) in the header.
  if v_link.id is null
     or v_link.revoked_at is not null
     or v_link.expires_at < now() then
    return query select false,
      'This link is no longer active. Ask whoever sent it to you for a new one.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_link.wid;

  --------------------------------------------------------- everything checked
  -- ...before anything is written. See the header, step 2.
  v_phone := wholesale_v2.v2_normalise_channel('phone', p_phone);
  if v_phone is null then
    return query select false, 'Please give a phone number we can reach you on.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_shop := nullif(btrim(coalesce(p_shop_name, '')), '');
  if v_shop is null then
    return query select false, 'Please give your shop name.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_user := lower(btrim(coalesce(p_username, '')));
  if length(v_user) < 3 then
    return query select false, 'Choose a username of at least 3 characters.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;
  if coalesce(length(p_password), 0) < 6 then
    return query select false, 'Choose a password of at least 6 characters.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- Note (b): a taken username is a field to correct, so it refuses and they
  -- retry. Checked before any write, so retrying is clean.
  if exists (select 1 from wholesale_v2.v2_portal_accounts a
              where a.wid = v_link.wid and lower(a.username) = v_user and a.role = 'buyer') then
    return query select false, 'That username is taken for this store. Try another.',
      null::text, null::text, null::text, null::uuid, null::uuid,
      null::uuid, null::text, null::uuid, null::timestamptz;
    return;
  end if;

  ------------------------------------------------------------- LINK-03/04/07
  -- THE FOUR KINDS, decided here and nowhere else. Not on the screen: migration
  -- 121's lesson is that a disabled button is a UI state, not a rule.
  v_grant := true;
  v_why   := null;

  if v_link.kind = 'approval' then
    v_grant := false;
    v_why   := 'this link asks the wholesaler to approve each shop';

  elsif v_link.kind = 'one_time' then
    if v_link.uses_count >= 1 then
      v_grant := false;
      v_why   := 'this link had already been used';
    elsif v_phone is distinct from v_link.invitee_phone_key then
      -- LINK-04. The wholesaler wrote a number down first; the redeemer must
      -- produce the same one. A mismatch is NOT a refusal -- it might be the
      -- right person on a second SIM, and it might be the wrong person holding
      -- a forwarded link. Both numbers go to the wholesaler, who can tell.
      v_grant := false;
      v_why   := format('this link was sent to %s and they signed up with %s',
                        coalesce(v_link.invitee_phone, '(no number)'), btrim(p_phone));
    end if;

  elsif v_link.kind = 'capped' then
    if v_link.uses_count >= v_link.max_uses then
      v_grant := false;
      v_why   := format('this link was set to let %s shop(s) in automatically and that is used up',
                        v_link.max_uses);
    end if;
  end if;
  -- 'unlimited' falls through with v_grant = true, which is what it means.

  ------------------------------------------------------------------- LINK-00
  -- The person, before anything store-shaped. If identity cannot be
  -- established the whole redemption fails rather than leaving another orphan
  -- account behind -- which is the defect migration 126 exists to close.
  v_person := wholesale_v2.v2_ensure_person(p_phone, coalesce(nullif(btrim(p_name),''), v_shop), null);
  perform wholesale_v2.v2_ensure_person_credential(v_person, p_password);

  -- ALREADY A MEMBER. A forwarded unlimited link redeemed twice by the same
  -- human must not mint a second client, a second login and a second row in
  -- the wholesaler's list. They are simply signed in and told so.
  select m.client_id into v_existing
    from wholesale_v2.v2_person_memberships m
   where m.person_id = v_person and m.wid = v_link.wid and m.role = 'buyer' and m.active;

  ------------------------------------------------------------ note (a): clash
  -- Only consulted when access would otherwise be granted. A clash pushes to
  -- the request path rather than to a wall.
  if v_grant and v_existing is null
     and exists (select 1 from wholesale_v2.v2_clients c
                  where c.wid = v_link.wid and c.shop_name = v_shop) then
    v_grant := false;
    v_why   := format('a shop called %L is already on their books -- they need to say whether that is you', v_shop);
  end if;

  ----------------------------------------------------------------- the session
  -- Minted for EVERY successful redemption, granted or not. This is the half of
  -- Hadi's sentence that had never been built: "either way, they get access and
  -- they are logged in." The recipe is migration 096's, byte for byte: a 32-byte
  -- secret returned once, only its SHA-256 stored, so a database dump is not a
  -- set of live sessions.
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp    := now() + SESSION_LEN;
  insert into wholesale_v2.v2_buyer_sessions (person_id, token_hash, expires_at)
  values (v_person, encode(extensions.digest(v_secret, 'sha256'), 'hex'), v_exp)
  returning id into v_sid;

  ------------------------------------------------------------------ already in
  if v_existing is not null then
    select a.id into v_account from wholesale_v2.v2_portal_accounts a
     where a.person_id = v_person and a.wid = v_link.wid and a.role = 'buyer' and a.active
     limit 1;
    return query select true,
      format('You already shop with %s — you are signed in.', coalesce(v_wname, 'this store')),
      'already'::text, v_link.wid, v_wname, v_existing, v_account,
      v_sid, v_secret, v_person, v_exp;
    return;
  end if;

  ------------------------------------------------------------------- LINK-08
  if not v_grant then
    -- The overflow lands somewhere real: an access request in the wholesaler's
    -- EXISTING queue, carrying the person (so approval takes the good branch of
    -- v2_approve_signup_request -- the one that writes a membership, which
    -- migration 107 exists to guarantee), the phone they typed, and the link.
    insert into wholesale_v2.v2_signup_requests
      (wid, buyer_name, location, volume, sells, status, phone, person_id, share_link_id)
    values (v_link.wid, v_shop, null, null, null, 'pending', btrim(p_phone), v_person, v_link.id);

    return query select true,
      format('You are signed up to OGGI and signed in. %s has been asked to give you access to their store — %s.',
             coalesce(v_wname, 'The store'), v_why),
      'requested'::text, v_link.wid, v_wname, null::uuid, null::uuid,
      v_sid, v_secret, v_person, v_exp;
    return;
  end if;

  ------------------------------------------------------------------- LINK-06
  -- The client, the login and the membership, in ONE transaction. A client who
  -- cannot sign in is not a client (060's header, and the 17 Aug SQUARE
  -- incident).
  --
  -- discount_pct comes off the link and is written ONCE. After this line the
  -- link's copy is never read for pricing again, which is what keeps migration
  -- 122 true: the door a buyer came through does not decide what they pay,
  -- because after redemption there is one rate on the customer's own record and
  -- every door reads that. Only one_time links may carry a rate at all (D-5,
  -- enforced by v2_share_links_discount_only_on_one_time).
  insert into wholesale_v2.v2_clients (wid, shop_name, phone, owner_name, discount_pct)
  values (v_link.wid, v_shop, btrim(p_phone), nullif(btrim(p_name), ''),
          coalesce(v_link.discount_pct, 0))
  returning id into v_client;

  insert into wholesale_v2.v2_portal_accounts
    (wid, client_id, role, username, password_hash, actor_label, active, person_id)
  values (v_link.wid, v_client, 'buyer', v_user,
          extensions.crypt(p_password, extensions.gen_salt('bf')), v_shop, true, v_person)
  returning id into v_account;

  -- UPDATE-then-INSERT rather than `on conflict (person_id, wid, role)`, for
  -- the reason migration 126 wrote down: this function RETURNS a column called
  -- `wid`, so inside it `wid` is a PL/pgSQL variable and an ON CONFLICT
  -- inference clause -- which cannot be table-qualified -- is ambiguous.
  -- Postgres refuses to create the function at all. Same trap as 121's
  -- variant_id, one clause over. The two statements are atomic here because the
  -- link row was taken FOR UPDATE at the top.
  update wholesale_v2.v2_person_memberships m
     set active = true, client_id = v_client, account_id = v_account, revoked_at = null
   where m.person_id = v_person and m.wid = v_link.wid and m.role = 'buyer';
  if not found then
    insert into wholesale_v2.v2_person_memberships (person_id, wid, client_id, account_id, role, active)
    values (v_person, v_link.wid, v_client, v_account, 'buyer', true);
  end if;

  -- LAST, and only on a grant. Note (d) in the header.
  update wholesale_v2.v2_share_links set uses_count = uses_count + 1 where id = v_link.id;

  return query select true,
    format('You are in. %s is in your stores, and you are signed up to OGGI.',
           coalesce(v_wname, 'The store')),
    'joined'::text, v_link.wid, v_wname, v_client, v_account,
    v_sid, v_secret, v_person, v_exp;
end;
$fn$;

comment on function wholesale_v2.v2_redeem_share_link(text, text, text, text, text, text, jsonb) is
  'LINK-06/03/04/07/08. Redeems a share link in one transaction under a row '
  'lock. Every successful call ends with a marketplace account and a session -- '
  '"either way, they get access and they are logged in" -- and only the store '
  'access varies: joined, requested, or already. p_answers is accepted and '
  'ignored until LINK-10 ships the questionnaire.';

-- anon BY NECESSITY: the redeemer has no account yet, which is the entire
-- point of a link. So it gets the full migration-124 treatment -- it may create
-- exactly the rows named above and nothing else, and PUBLIC is named in the
-- revoke as well as the roles, because 124's first sabotage failed to go red
-- when anon inherited a privilege through PUBLIC rather than holding it.
revoke all on function wholesale_v2.v2_redeem_share_link(text, text, text, text, text, text, jsonb) from public;
grant execute on function wholesale_v2.v2_redeem_share_link(text, text, text, text, text, text, jsonb) to anon, authenticated;

-------------------------------------------------------------------- THE PROOF
-- Assertions about the CHANGE, never about the data this happens to find --
-- the rule 116 was corrected for and 119 broke the next day. The fixture is
-- built, exercised and removed.
do $$
declare
  wA text := '__m128_probe__';
  v_tok1 text; v_tok2 text; v_tok3 text; v_tok4 text;
  r record;
  n int;
  i int;
  fails text[] := '{}';
begin
  -- Exactly one overload. 113's lesson, asserted rather than trusted.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link';
  if n <> 1 then
    raise exception '128: % overloads of v2_redeem_share_link -- PostgREST refuses them all with PGRST203', n;
  end if;

  insert into public.wholesalers (wid, name, active) values (wA, 'Probe 128', true);
  insert into wholesale_v2.v2_wholesalers (wid, name) values (wA, 'Probe 128');

  insert into wholesale_v2.v2_share_links (wid, kind, invitee_name, invitee_phone, discount_pct)
  values (wA, 'one_time', 'Rita', '03 111 222', 15.00) returning token into v_tok1;
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'unlimited') returning token into v_tok2;
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'approval')  returning token into v_tok3;
  insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values (wA, 'capped', 1) returning token into v_tok4;

  -- 1. the matching phone walks in, and carries the link's rate
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok1, '03 111 222', 'Rita', 'Rita Boutique', 'ritap128', 'hunter2secret');
  if not r.ok or r.outcome <> 'joined' then
    fails := fails || format('a matching one_time redemption returned ok=%s outcome=%L', r.ok, r.outcome);
  end if;
  if (select c.discount_pct from wholesale_v2.v2_clients c where c.id = r.client_id) <> 15.00 then
    fails := fails || 'the link''s rate did not reach the customer record'::text;
  end if;
  if r.session_token is null or r.person_id is null then
    fails := fails || 'a joined redeemer was not signed in to OGGI'::text;
  end if;

  -- 2. the same link again: used up, so a request rather than a wall
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok1, '03 999 888', 'Someone', 'Second Shop', 'secondp128', 'hunter2secret');
  if not r.ok or r.outcome <> 'requested' then
    fails := fails || format('a used one_time link returned ok=%s outcome=%L instead of a request', r.ok, r.outcome);
  end if;
  if r.session_token is null then
    fails := fails || 'the overflow redeemer was turned away from OGGI'::text;
  end if;

  -- 3. a WRONG phone on a fresh one_time link is a request, not a refusal
  insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone)
  values (wA, 'one_time', '03 111 333') returning token into v_tok1;
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok1, '03 777 666', 'Not Rita', 'Third Shop', 'thirdp128', 'hunter2secret');
  if r.outcome <> 'requested' then
    fails := fails || format('a phone mismatch returned outcome=%L', r.outcome);
  end if;

  -- 4. the cap counts GRANTS: one in, the next asks
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok4, '03 222 111', 'A', 'Capped One', 'capap128', 'hunter2secret');
  if r.outcome <> 'joined' then fails := fails || 'the first through a capped link was not let in'::text; end if;
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok4, '03 222 333', 'B', 'Capped Two', 'capbp128', 'hunter2secret');
  if r.outcome <> 'requested' then fails := fails || 'the second through a 1-cap link was let in'::text; end if;
  if (select l.uses_count from wholesale_v2.v2_share_links l where l.token = v_tok4) <> 1 then
    fails := fails || 'uses_count counted an arrival rather than a grant'::text;
  end if;

  -- 5. an approval link never grants, and always signs them up
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok3, '03 333 111', 'C', 'Approval Shop', 'apprp128', 'hunter2secret');
  if r.outcome <> 'requested' or r.session_token is null then
    fails := fails || format('an approval link returned outcome=%L session=%s', r.outcome, (r.session_token is not null));
  end if;

  -- 6. the same human through an unlimited link twice is ONE client
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok2, '03 444 111', 'D', 'Unlimited Shop', 'unlp128', 'hunter2secret');
  if r.outcome <> 'joined' then fails := fails || 'an unlimited link did not let the first person in'::text; end if;
  select * into r from wholesale_v2.v2_redeem_share_link(v_tok2, '00961 3 444111', 'D', 'Unlimited Shop Again', 'unl2p128', 'hunter2secret');
  if r.outcome <> 'already' then
    fails := fails || format('the same human redeeming twice returned outcome=%L instead of already', r.outcome);
  end if;
  select count(*) into n from wholesale_v2.v2_clients c where c.wid = wA and c.shop_name like 'Unlimited%';
  if n <> 1 then
    fails := fails || format('redeeming twice made % client rows for one human', n);
  end if;

  -- 7. a made-up token says nothing
  select * into r from wholesale_v2.v2_redeem_share_link('deadbeefdeadbeefdeadbeef', '03 555 111', 'E', 'Nowhere', 'nowp128', 'hunter2secret');
  if r.ok or r.msg not like 'This link is no longer active%' then
    fails := fails || format('a made-up token answered ok=%s msg=%L', r.ok, r.msg);
  end if;

  -- 8. the rate limiter still counts correctly after being made atomic. The
  --    boundary is the thing worth asserting: p_max calls allowed, the next
  --    denied. A rewrite that shifted it by one would pass any test that only
  --    checked "eventually says no".
  n := 0;
  for i in 1..5 loop
    if wholesale_v2.v2_rate_limit_check('__m128_probe_key__', 3, 600) then n := n + 1; end if;
  end loop;
  if n <> 3 then
    fails := fails || format('the rate limiter allowed %s of 5 calls where the limit is 3', n);
  end if;
  -- ...and its body no longer contains the bare insert that raced.
  if (select p.prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'wholesale_v2' and p.proname = 'v2_rate_limit_check')
     not like '%on conflict (key) do update%' then
    fails := fails || 'v2_rate_limit_check is still the racing version'::text;
  end if;
  delete from wholesale_v2.v2_rate_limit_hits where key = '__m128_probe_key__';

  if array_length(fails, 1) > 0 then
    raise exception '128 DID NOT LAND: %', array_to_string(fails, ' | ');
  end if;

  raise notice '128 ok: four kinds, the cap, the phone match, the overflow and an atomic rate limiter';

  delete from wholesale_v2.v2_signup_requests where wid = wA;
  delete from wholesale_v2.v2_wholesalers where wid = wA;
  delete from public.wholesalers where wid = wA;
  delete from wholesale_v2.v2_people p
   where exists (select 1 from wholesale_v2.v2_person_channels ch
                  where ch.person_id = p.id
                    and ch.normalised in ('9613111222','9613999888','9613777666','9613222111',
                                          '9613222333','9613333111','9613444111','9613555111'));
end $$;
