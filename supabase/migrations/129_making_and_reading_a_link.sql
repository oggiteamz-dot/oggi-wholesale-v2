-- 129 — LINK-02 + LINK-11 + LINK-05 (the server half). Making a link,
--       listing links, and what a stranger is told when they open one.
--
-- Migration 127 gave a link a shape and 128 gave it a redemption. Nothing
-- could CREATE one: the only way a share link existed was an INSERT typed by
-- hand. This file closes that, and gives the stranger's screen something to
-- ask before it draws itself.
--
-- Four functions, and the split between them is the security boundary:
--
--   v2_create_share_link   wholesaler only   makes one
--   v2_revoke_share_link   wholesaler only   withdraws one, never deletes
--   v2_my_share_links      wholesaler only   the list (LINK-11)
--   v2_share_link_peek     ANYONE            what the holder of a token is told
--
-- The first three re-check the tenant INSIDE the function, the way every
-- definer function in this schema has since migration 080. The fourth is
-- anon-callable by necessity and is written to give away as little as it can
-- while still being useful.
--
-- ---------------------------------------------------------------------------
-- WHAT PEEK DELIBERATELY DOES NOT RETURN, and this is the sharpest decision
-- in the file
-- ---------------------------------------------------------------------------
-- It does NOT return `invitee_name`, and the plan's screen sketch would have
-- allowed it ("<Wholesaler> invited you"). A one_time link is sent to one
-- person by WhatsApp, and WhatsApp messages get forwarded. A screen that opens
-- with "Hi Rita" tells whoever the link was forwarded to that a shop called
-- Rita deals with this wholesaler -- a fact the wholesaler shared with exactly
-- one person, published to anyone the message reaches.
--
-- It does not return `invitee_phone` either, for the same reason and worse.
--
-- What it DOES return is the wholesaler's name -- unavoidable, because
-- "somebody invited you, we won't say who" is not a screen anybody would
-- complete -- and a hint about what will happen, so the screen can be honest
-- before the form is filled in rather than after:
--
--   immediate           finishing this form gets you into the store
--   phone_must_match    you'll get in if you sign up with the number they sent
--                       this to; otherwise they'll be asked to approve you
--   needs_approval      you'll join OGGI and they'll be asked to approve you
--
-- A DEAD LINK RETURNS 'unavailable' AND NOTHING ELSE. Not found, revoked and
-- expired are one answer with no store name in it -- migration 056's rule,
-- and the same answer v2_redeem_share_link gives, because two functions that
-- disagree about which tokens are real is an oracle assembled from two halves.
--
-- ---------------------------------------------------------------------------
-- DECISION D-2, IMPLEMENTED AS THE PLAN SAID IT WOULD BE
-- ---------------------------------------------------------------------------
-- "What happens when a wholesaler sends a SECOND link, with a different
-- discount, to a phone that is already their client. Assumption until Hadi
-- says otherwise: REFUSE AT CREATION TIME, with 'Rita is already your customer
-- -- change her discount on her client record.'"
--
-- Refused here, naming the shop. Silently overwriting a negotiated rate from a
-- link somebody forgot they sent is the kind of thing nobody finds for months.
-- The refusal is at CREATION, where the wholesaler is looking at the screen and
-- can act on it, rather than at redemption where the buyer would be the one
-- reading it and could do nothing about it.
--
-- ⓘ This is an ASSUMPTION, not an instruction. If Hadi wants a second link to
-- update the rate, the change is one branch here and one gate row.

------------------------------------------------------------------- creating
create or replace function wholesale_v2.v2_create_share_link(
  p_kind          text default 'one_time',
  p_invitee_name  text default null,
  p_invitee_phone text default null,
  p_discount_pct  numeric default null,
  p_max_uses      integer default null,
  p_catalog_id    uuid default null,
  p_days          integer default 30,
  p_note          text default null
)
returns table (ok boolean, msg text, link_id uuid, token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_wid   text;
  v_key   text;
  v_row   wholesale_v2.v2_share_links%rowtype;
  v_clash text;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then
    return query select false, 'Only a wholesaler can make a share link.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if p_kind is null or p_kind not in ('one_time','unlimited','approval','capped') then
    return query select false, 'Choose a link type: one person, unlimited, approval needed, or a set number.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- EVERY REFUSAL BELOW IS ALSO A CHECK CONSTRAINT ON THE TABLE (127), and
  -- that duplication is deliberate. The constraint is what makes the rule
  -- true; these sentences are what make it USABLE. Without them the wholesaler
  -- gets Postgres error text; without the constraint, a second caller written
  -- next year gets no rule at all.
  v_key := wholesale_v2.v2_normalise_channel('phone', p_invitee_phone);

  if p_kind = 'one_time' and v_key is null then
    return query select false,
      'A one-person link needs their phone number — that number is what proves it is them.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if p_kind = 'capped' and (p_max_uses is null or p_max_uses < 1) then
    return query select false, 'How many shops should this link let in automatically?',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if p_kind <> 'capped' and p_max_uses is not null then
    return query select false,
      'Only a "set number" link takes a number. Choose that type, or leave the number blank.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Decision D-5, in a sentence rather than as a constraint violation.
  if p_discount_pct is not null and p_kind <> 'one_time' then
    return query select false,
      'A discount can only go on a one-person link. Anyone can forward the other kinds, and a rate you agreed with one shop would go with it.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if p_discount_pct is not null and (p_discount_pct < -100 or p_discount_pct > 100) then
    return query select false, 'A discount has to be between -100 and 100.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- The shelf must be theirs. The composite foreign key from 127 already makes
  -- this impossible to store; saying it here turns "foreign key violation" into
  -- a sentence, and the gate asserts BOTH.
  if p_catalog_id is not null
     and not exists (select 1 from wholesale_v2.v2_catalogs c
                      where c.id = p_catalog_id and c.wid = v_wid) then
    return query select false, 'That catalogue is not one of yours.',
      null::uuid, null::text, null::timestamptz;
    return;
  end if;

  ----------------------------------------------------------------- D-2
  if v_key is not null then
    select c.shop_name into v_clash
      from wholesale_v2.v2_clients c
     where c.wid = v_wid
       and wholesale_v2.v2_normalise_channel('phone', c.phone) = v_key
     limit 1;
    if v_clash is not null then
      return query select false,
        format('%s is already your customer on that number. Change their discount on their client record instead — a second link would give them a second account.', v_clash),
        null::uuid, null::text, null::timestamptz;
      return;
    end if;
  end if;

  -- Decision D-6. Clamped rather than trusted, exactly as 089 clamps its own:
  -- a caller-supplied 36500 is a link that never dies, which is the same as no
  -- expiry at all.
  if p_days is null or p_days < 1 then p_days := 30; end if;
  if p_days > 180 then p_days := 180; end if;

  insert into wholesale_v2.v2_share_links
    (wid, kind, catalog_id, max_uses, invitee_name, invitee_phone, discount_pct,
     note, created_by, expires_at)
  values
    (v_wid, p_kind, p_catalog_id, p_max_uses,
     nullif(btrim(p_invitee_name), ''), nullif(btrim(p_invitee_phone), ''),
     p_discount_pct, nullif(btrim(p_note), ''), auth.uid(),
     now() + make_interval(days => p_days))
  returning * into v_row;

  return query select true, 'ok'::text, v_row.id, v_row.token, v_row.expires_at;
end;
$fn$;

comment on function wholesale_v2.v2_create_share_link(text, text, text, numeric, integer, uuid, integer, text) is
  'LINK-02. Makes one share link for the calling wholesaler. Every refusal here '
  'has a matching CHECK on v2_share_links (127): the constraint makes the rule '
  'true, this makes it readable. Decision D-2 is enforced here -- a second link '
  'to a phone that is already their customer is refused, naming the shop.';

revoke all on function wholesale_v2.v2_create_share_link(text, text, text, numeric, integer, uuid, integer, text) from public, anon;
grant execute on function wholesale_v2.v2_create_share_link(text, text, text, numeric, integer, uuid, integer, text) to authenticated;

------------------------------------------------------------------ revoking
create or replace function wholesale_v2.v2_revoke_share_link(p_id uuid)
returns table (ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
  v_row wholesale_v2.v2_share_links%rowtype;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then
    return query select false, 'Only a wholesaler can withdraw a link.'; return;
  end if;

  select * into v_row from wholesale_v2.v2_share_links l
   where l.id = p_id and l.wid = v_wid for update;

  -- "Not yours" and "does not exist" are one answer. Otherwise a wholesaler
  -- could walk uuids to find out which ones belong to somebody.
  if v_row.id is null then
    return query select false, 'That link is not one of yours.'; return;
  end if;
  if v_row.revoked_at is not null then
    return query select true, 'That link was already withdrawn.'; return;
  end if;

  -- REVOKED, NEVER DELETED. The audit pattern migration 104 established, for
  -- the same reason: a link that was sent and withdrawn is a thing that
  -- happened, and the requests that came through it still point at it.
  update wholesale_v2.v2_share_links
     set revoked_at = now(), revoked_by = auth.uid()
   where id = p_id;

  return query select true, 'Withdrawn. Anyone opening it now is told it is no longer active.';
end;
$fn$;

comment on function wholesale_v2.v2_revoke_share_link(uuid) is
  'LINK-11. Withdraws a link by stamping revoked_at -- never a delete, because '
  'the access requests that arrived through it still name it, and a link that '
  'was sent and withdrawn is a thing that happened.';

revoke all on function wholesale_v2.v2_revoke_share_link(uuid) from public, anon;
grant execute on function wholesale_v2.v2_revoke_share_link(uuid) to authenticated;

-------------------------------------------------------------------- the list
create or replace function wholesale_v2.v2_my_share_links()
returns table (
  id             uuid,
  token          text,
  kind           text,
  state          text,
  invitee_name   text,
  invitee_phone  text,
  discount_pct   numeric,
  max_uses       integer,
  uses_count     integer,
  requests_count bigint,
  catalog_name   text,
  note           text,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid text;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then return; end if;   -- no rows, not an error

  return query
  select l.id, l.token, l.kind,
         -- ONE state per link, computed once here rather than four times in
         -- the browser. The order matters: a revoked link that has also
         -- expired reads 'revoked', because that is the thing the wholesaler
         -- did and the thing they will look for.
         case
           when l.revoked_at is not null then 'revoked'
           when l.expires_at < now()     then 'expired'
           when l.kind = 'one_time' and l.uses_count >= 1 then 'used'
           when l.kind = 'capped'   and l.uses_count >= l.max_uses then 'full'
           else 'active'
         end as state,
         l.invitee_name, l.invitee_phone, l.discount_pct, l.max_uses, l.uses_count,
         -- The other half of note (d) in migration 128: uses_count counts
         -- GRANTS, so the people who came through and were sent to the
         -- approval queue are counted here instead. Without this column the
         -- list would say "0 of 5 used" for a link forty people had opened.
         (select count(*) from wholesale_v2.v2_signup_requests sr
           where sr.share_link_id = l.id) as requests_count,
         c.name as catalog_name,
         l.note, l.expires_at, l.revoked_at, l.created_at
    from wholesale_v2.v2_share_links l
    left join wholesale_v2.v2_catalogs c on c.id = l.catalog_id
   where l.wid = v_wid
   order by l.created_at desc;
end;
$fn$;

comment on function wholesale_v2.v2_my_share_links() is
  'LINK-11. Every link this wholesaler has made, newest first, with one '
  'computed state and the count of people who came through and were sent to '
  'the approval queue -- which uses_count deliberately does not include.';

revoke all on function wholesale_v2.v2_my_share_links() from public, anon;
grant execute on function wholesale_v2.v2_my_share_links() to authenticated;

--------------------------------------------------------------- the stranger
create or replace function wholesale_v2.v2_share_link_peek(p_token text)
returns table (
  status          text,   -- 'ok' | 'unavailable'
  wid             text,
  wholesaler_name text,
  kind            text,
  hint            text,   -- 'immediate' | 'phone_must_match' | 'needs_approval'
  msg             text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_link wholesale_v2.v2_share_links%rowtype;
  v_name text;
  v_hint text;
begin
  select * into v_link from wholesale_v2.v2_share_links l where l.token = p_token;

  -- Not found, withdrawn and expired are ONE answer, with no store in it. The
  -- same answer v2_redeem_share_link gives, on purpose: two functions that
  -- disagree about which tokens are real make an oracle out of two halves.
  if v_link.id is null
     or v_link.revoked_at is not null
     or v_link.expires_at < now() then
    return query select 'unavailable'::text, null::text, null::text, null::text, null::text,
      'This link is no longer active. Ask whoever sent it to you for a new one.';
    return;
  end if;

  select w.name into v_name from wholesale_v2.v2_wholesalers w where w.wid = v_link.wid;

  -- The hint is what the screen needs to be honest BEFORE the form is filled
  -- in. It is derived from the same branches v2_redeem_share_link uses, and
  -- the gate asserts the two agree -- a screen that promises immediate access
  -- and a redemption that files an approval request is worse than a screen
  -- that promised nothing.
  if v_link.kind = 'approval' then
    v_hint := 'needs_approval';
  elsif v_link.kind = 'one_time' then
    v_hint := case when v_link.uses_count >= 1 then 'needs_approval' else 'phone_must_match' end;
  elsif v_link.kind = 'capped' then
    v_hint := case when v_link.uses_count >= v_link.max_uses then 'needs_approval' else 'immediate' end;
  else
    v_hint := 'immediate';
  end if;

  return query select 'ok'::text, v_link.wid, v_name, v_link.kind, v_hint,
    case v_hint
      when 'immediate' then
        format('%s invited you. Finish signing up and their store is yours to shop.', coalesce(v_name, 'A wholesaler'))
      when 'phone_must_match' then
        format('%s sent this to one number. Sign up with that number and you are straight in; with any other, they will be asked to approve you.', coalesce(v_name, 'A wholesaler'))
      else
        format('You will join OGGI now, and %s will be asked to give you access to their store.', coalesce(v_name, 'the wholesaler'))
    end;
end;
$fn$;

comment on function wholesale_v2.v2_share_link_peek(text) is
  'LINK-05. What the holder of a token is told before they fill anything in. '
  'Deliberately does NOT return invitee_name or invitee_phone: a one-person '
  'link is sent by WhatsApp and WhatsApp messages get forwarded, so a screen '
  'that opens with "Hi Rita" publishes to whoever it reaches a fact the '
  'wholesaler told exactly one person. Dead links answer "unavailable" and '
  'name no store, the same answer redemption gives.';

revoke all on function wholesale_v2.v2_share_link_peek(text) from public;
grant execute on function wholesale_v2.v2_share_link_peek(text) to anon, authenticated;

-------------------------------------------------------------------- THE PROOF
do $$
declare
  n int;
  fails text[] := '{}';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_create_share_link','v2_revoke_share_link',
                       'v2_my_share_links','v2_share_link_peek');
  if n <> 4 then
    raise exception '129: expected 4 functions, found % -- an overload would make PostgREST refuse them (113)', n;
  end if;

  -- ⛔ THE PEEK MUST NEVER RETURN WHO THE LINK WAS FOR. Source-level, because
  -- it is a rule about what the function may SAY, and the day somebody adds
  -- the column back for a friendlier screen this is what stops it.
  if (select p.prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'wholesale_v2' and p.proname = 'v2_share_link_peek')
     ~* 'invitee_name|invitee_phone' then
    raise exception '129: v2_share_link_peek reads the invitee -- a forwarded link would publish their name';
  end if;

  -- The three wholesaler-only functions must be closed to anon.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'wholesale_v2'
     and p.proname in ('v2_create_share_link','v2_revoke_share_link','v2_my_share_links')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if n <> 0 then
    raise exception '129: % wholesaler function(s) are callable by a signed-out stranger', n;
  end if;

  -- ...and the peek must be OPEN to anon, or the feature is dead.
  if not (select has_function_privilege('anon', p.oid, 'EXECUTE')
            from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'wholesale_v2' and p.proname = 'v2_share_link_peek') then
    raise exception '129: a signed-out stranger cannot peek at a link, which is the only kind of person who holds one';
  end if;

  -- ⓘ THE BEHAVIOURAL HALF OF THIS PROBE WAS WRITTEN HERE AND THEN MOVED OUT,
  -- and the reason is worth a paragraph. Exercising v2_create_share_link needs
  -- a wholesaler identity, and v2_user_profiles.id references auth.users -- so
  -- the probe had to INSERT A ROW INTO SUPABASE'S OWN AUTH TABLE. That is fine
  -- on a scratch replay and is not something a migration should do to
  -- production, where auth.users is the real user table with real triggers on
  -- it. A migration that writes to auth to test itself is a migration nobody
  -- should feel comfortable applying.
  --
  -- checks/check_making_and_reading_a_link.sql does all of it and more --
  -- creating, refusing, listing, withdrawing, the tenant boundary, D-2, and
  -- the agreement between the screen's promise and redemption's answer -- and
  -- it does it inside a transaction that is rolled back. This block keeps only
  -- what a migration is actually for: assertions about the CHANGE it makes.
  -- The rule 116 was corrected for, applied to itself.

  if array_length(fails, 1) > 0 then
    raise exception '129 DID NOT LAND: %', array_to_string(fails, ' | ');
  end if;
  raise notice '129 ok: four functions, one overload each, the peek cannot name anybody, and the grants are right';
end $$;
