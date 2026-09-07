-- 127 — LINK-01. A link is a row, and an impossible link cannot be stored
--
-- HADI, on the model this table exists to hold:
--   "When they create a share link, they're gonna put in that person's phone
--    number. They're gonna put in their name, but basically we're just gonna
--    look for their phone number to make sure that this is the same person,
--    and they're gonna set a discount for that link. And this is a one time
--    use link. ... give them the function, the ability to decide. Is this a one
--    time link for one person, or this is like an unlimited use link, or is
--    this link but the approval is needed? Or if it's auto approval with, like,
--    a certain number of link users?"
--
-- Four kinds, one table. docs/LINK-PLAN.md carries the full design; this file
-- carries only what a DATABASE can guarantee, which is deliberately more than
-- the plan's table sketch and deliberately less than the whole feature. The
-- redemption rules -- the lock, the cap, the phone match -- are migration 128
-- (LINK-06/03/04). Nothing here decides who gets in.
--
-- WHY THE CONSTRAINTS ARE THE POINT OF THIS MIGRATION.
-- Migration 121 wrote the lesson down: a disabled button is a UI state, not a
-- rule. Every impossible link named below is impossible to STORE, not merely
-- hard to create through the form that lands in LINK-02:
--
--   a capped link with no cap ................ refused
--   a cap on a link that is not capped ....... refused
--   a "one time link for one person" with no
--     usable phone number ..................... refused
--   a discount on a link anyone may forward .. refused   (decision D-5)
--   a rate outside the shelf's own range ..... refused   (matches 123)
--   more uses than the link allows ........... refused
--   a link that lands on ANOTHER STORE'S shelf  refused   (see the composite FK)
--   a token that did not come from the house
--     recipe .................................. refused
--   an expiry outside 1-180 days ............. refused   (decision D-6)
--   "revoked" with nobody who revoked it ..... refused
--
-- THE COMPOSITE FOREIGN KEY IS NOT DECORATION, AND IT COSTS ONE INDEX.
-- `catalog_id` names the shelf a redeemer lands on. A plain FK to
-- v2_catalogs(id) permits a link owned by store A that opens store B's shelf --
-- a cross-tenant leak that no RLS policy on THIS table would catch, because the
-- row is A's and A is allowed to read it. Adding `unique (id, wid)` to
-- v2_catalogs lets the FK carry the wid, so the pair must agree in the
-- database. That is the same argument migration 125 made about partitions: the
-- guarantee belongs where it cannot be forgotten.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * No RPC. Creating and redeeming links are 128 and later, and shipping an
--     anon-callable function one migration before the rules that govern it is
--     how a door gets left open for a night.
--   * No route. `#/j/<token>` lands with the screen that answers it (LINK-05),
--     because a registered route with no view is the "Page not found" defect
--     already recorded against `#/login`, and adding a second one to fix the
--     first is not progress.
--   * No retirement of v2_buyer_invites. That is LINK-12 and needs Hadi's word.

------------------------------------------------------- the shelf's other key
-- Additive and index-only: no column changes, no data moves. `id` remains the
-- primary key and every existing reference to it is untouched.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'wholesale_v2' and r.relname = 'v2_catalogs'
      and c.conname = 'v2_catalogs_id_wid_uq')
  then
    alter table wholesale_v2.v2_catalogs
      add constraint v2_catalogs_id_wid_uq unique (id, wid);
  end if;
end $$;

comment on constraint v2_catalogs_id_wid_uq on wholesale_v2.v2_catalogs is
  'Exists so other tables can reference a shelf AND its store together. '
  'Without it a share link owned by store A could name store B''s shelf and no '
  'policy on the links table would notice, because the link row is A''s.';

------------------------------------------------------------------- the table
create table if not exists wholesale_v2.v2_share_links (
  id                uuid primary key default gen_random_uuid(),

  wid               text not null
                    references wholesale_v2.v2_wholesalers(wid) on delete cascade,

  -- Which shelf they land on. NULL = the whole store, which is the common case
  -- and the one that stays correct when a catalogue is later archived.
  catalog_id        uuid,

  kind              text not null default 'one_time',
  max_uses          integer,
  uses_count        integer not null default 0,

  -- The person, as the WHOLESALER knows them. Both are what the wholesaler
  -- typed, never what a redeemer typed: that asymmetry is the whole reason a
  -- typed phone is safe here at all (LINK-PLAN, "why the phone is safe here").
  invitee_name      text,
  invitee_phone     text,
  invitee_phone_key text generated always as
                      (wholesale_v2.v2_normalise_channel('phone', invitee_phone)) stored,

  -- THE CUSTOMER'S OWN RATE, not a shelf rate. Written once onto
  -- v2_clients.discount_pct at redemption and never read for pricing again.
  -- Migration 122's rule survives: see LINK-09 and the gate that proves it.
  discount_pct      numeric(6,2),

  token             text not null default encode(extensions.gen_random_bytes(12), 'hex'),

  -- 30 days, matching the invite this replaces. Decision D-6.
  expires_at        timestamptz not null default (now() + interval '30 days'),

  revoked_at        timestamptz,
  revoked_by        uuid,
  note              text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- The shelf and the store must agree. See the header.
  constraint v2_share_links_catalog_same_store
    foreign key (catalog_id, wid)
    references wholesale_v2.v2_catalogs (id, wid) on delete set null,

  constraint v2_share_links_kind
    check (kind in ('one_time', 'unlimited', 'approval', 'capped')),

  -- A cap belongs to exactly one kind. Both directions are checked: a `capped`
  -- link with no number is a link nothing can decide about, and a number on an
  -- `unlimited` link is a rule somebody will later believe is being enforced.
  constraint v2_share_links_cap_matches_kind
    check ( (kind = 'capped' and max_uses is not null and max_uses >= 1)
         or (kind <> 'capped' and max_uses is null) ),

  -- "This is a one time use link" for a named person. Without a number that
  -- NORMALISES there is nobody to match, so the phone gate silently becomes no
  -- gate at all -- which is worse than not offering the kind. Checking the KEY
  -- rather than the raw text is what makes '123' refused instead of stored.
  constraint v2_share_links_one_time_needs_a_person
    check ( kind <> 'one_time'
         or wholesale_v2.v2_normalise_channel('phone', invitee_phone) is not null ),

  -- Decision D-5. A rate is something agreed with one named person; a discount
  -- on a link that anyone may forward is a price list in the wild.
  constraint v2_share_links_discount_only_on_one_time
    check (discount_pct is null or kind = 'one_time'),

  -- The same bound migration 123 gave the store dial and the customer rate,
  -- for the same reason: this number becomes v2_clients.discount_pct, and a
  -- range that differs from the column it feeds is the hole the fix creates.
  constraint v2_share_links_discount_range
    check (discount_pct is null or (discount_pct >= -100 and discount_pct <= 100)),

  constraint v2_share_links_uses_not_negative
    check (uses_count >= 0),

  -- A link may not be stored having been used more times than it allows. This
  -- does not REPLACE the lock migration 128 takes -- two concurrent redeemers
  -- are stopped by `for update`, not by a check -- but it means a bug that
  -- bypasses the RPC cannot leave a 6-of-5 row sitting in the table.
  constraint v2_share_links_uses_within_cap
    check ( (kind = 'one_time' and uses_count <= 1)
         or (kind = 'capped'   and uses_count <= max_uses)
         or  kind in ('unlimited', 'approval') ),

  -- 24 lowercase hex = the 12 random bytes the house recipe produces, the same
  -- shape as v2_catalogs.share_token, v2_orders.order_token and
  -- v2_buyer_invites.token. A token of any other shape did not come from the
  -- database, and the one entropy source in this codebase that is not the
  -- database is `rotateCatalogLink` in the browser (js/data/catalogs.js:243).
  constraint v2_share_links_token_shape
    check (token ~ '^[0-9a-f]{24}$'),

  -- Decision D-6: settable, clamped 1-180 days. An expiry in the past at
  -- creation time is a link that never worked, and 180 days is the point past
  -- which "I sent you a link" stops being a thing either party remembers.
  constraint v2_share_links_expiry_window
    check ( expires_at >  created_at
        and expires_at <= created_at + interval '180 days' ),

  -- A revocation is an event with an actor. 104 established that a decision
  -- without a decider is a record nobody can act on.
  constraint v2_share_links_revocation_has_an_actor
    check ((revoked_at is null) = (revoked_by is null))
);

create unique index if not exists v2_share_links_token_uq
  on wholesale_v2.v2_share_links (token);

-- The wholesaler's link list (LINK-11), newest first.
create index if not exists v2_share_links_by_wid
  on wholesale_v2.v2_share_links (wid, created_at desc);

-- "Is this phone already one of my customers?" -- decision D-2's refusal, and
-- the lookup LINK-04's match runs. Partial, because most links carry no phone.
create index if not exists v2_share_links_by_phone_key
  on wholesale_v2.v2_share_links (wid, invitee_phone_key)
  where invitee_phone_key is not null;

comment on table wholesale_v2.v2_share_links is
  'LINK-01. One row per link a wholesaler sends. Four kinds -- one_time, '
  'unlimited, approval, capped -- and every rule about which combinations are '
  'possible is a CHECK on this table rather than a disabled button, because '
  'migration 121 already paid for the other arrangement. Redemption is '
  'migration 128; nothing in this file decides who gets in.';

comment on column wholesale_v2.v2_share_links.invitee_phone_key is
  'GENERATED, and generated on purpose: migration 108 argued this case and '
  'v2_person_channels.normalised is the counter-example where every caller has '
  'to remember to normalise. A key a caller can forget is a match that '
  'silently stops matching.';

comment on column wholesale_v2.v2_share_links.discount_pct is
  'The CUSTOMER''S own rate, set at the moment they are invited -- not a shelf '
  'rate. At redemption it is written once onto v2_clients.discount_pct and '
  'never read for pricing again, so migration 122 stands: after redemption '
  'there is exactly one price for this buyer through every door.';

comment on column wholesale_v2.v2_share_links.uses_count is
  'Completions, not clicks. Hadi: "only the first five that complete the sign '
  'in actually get the auto access." Incremented at the END of a successful '
  'redemption, under the row lock migration 128 takes.';

------------------------------------------------------------------ the locks
alter table wholesale_v2.v2_share_links enable row level security;

-- NO POLICY, ON PURPOSE, and that means nobody reads this table directly.
-- Same posture as v2_ranking_config_history (101) and v2_person_credentials
-- (096): RLS on with no policy denies every non-owner role outright, which
-- fails closed no matter what the grants say. That matters more here than
-- usual -- production's `authenticated` role holds table privileges that no
-- migration in this repo grants (the grant drift, GATE-EVIDENCE.md), so a fix
-- that depended on a grant staying revoked would be undone by whatever grants
-- them. RLS is not.
--
-- The revoke is still written, because defence that costs one line is worth
-- having twice, and PUBLIC is named as well as the roles -- that is the
-- correction migration 124 had to make after a sabotage failed to go red
-- because anon inherited a privilege through PUBLIC rather than holding it.
revoke all on wholesale_v2.v2_share_links from public, anon, authenticated;

-- Wholesalers and buyers will both reach links through SECURITY DEFINER
-- functions that take the token and answer narrowly (128 onward). A token is a
-- capability; a table grant is not.

--------------------------------------------------------------- keeping time
create or replace function wholesale_v2.v2_share_links_touch()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_v2_share_links_touch on wholesale_v2.v2_share_links;
create trigger trg_v2_share_links_touch
  before update on wholesale_v2.v2_share_links
  for each row execute function wholesale_v2.v2_share_links_touch();

-------------------------------------------------------------------- THE PROOF
-- A migration may assert things about the CHANGE it makes and never about the
-- DATA it happens to find -- the rule 116 was corrected for and 119 broke the
-- next day. So this block builds its own fixture, proves each refusal, and
-- rolls the fixture back. It is safe on an empty database and on production.
do $$
declare
  v_wid text := '__m127_probe__';
  v_cat uuid;
  v_other_wid text := '__m127_other__';
  v_other_cat uuid;
  v_id  uuid;
  v_tok text;
  n     int;
  fails text[] := '{}';
begin
  -- v2_wholesalers.wid still references the v1 `public.wholesalers` row, so the
  -- fixture has to build both halves. Every gate in checks/ does the same.
  insert into public.wholesalers (wid, name, active) values
    (v_wid, 'Probe 127', true), (v_other_wid, 'Probe 127 Other', true);
  insert into wholesale_v2.v2_wholesalers (wid, name) values
    (v_wid, 'Probe 127'), (v_other_wid, 'Probe 127 Other');

  -- Creating a wholesaler auto-creates its default catalogue (the trap
  -- check_one_price_per_buyer.sql hit on 7 Sep), so adopt it rather than
  -- inserting a second default.
  select id into v_cat       from wholesale_v2.v2_catalogs where wid = v_wid       and is_default;
  select id into v_other_cat from wholesale_v2.v2_catalogs where wid = v_other_wid and is_default;

  -- 1. THE HAPPY PATH, first, so a failure below is a failure of the RULE and
  --    not of the fixture.
  insert into wholesale_v2.v2_share_links (wid, kind, invitee_name, invitee_phone, discount_pct)
  values (v_wid, 'one_time', 'Rita', '03 456 789', 12.50)
  returning id, token into v_id, v_tok;

  if v_tok !~ '^[0-9a-f]{24}$' then
    fails := fails || format('the default token is %L, not 24 hex from the house recipe', v_tok);
  end if;

  select count(*) into n from wholesale_v2.v2_share_links
   where id = v_id and invitee_phone_key = '9613456789';
  if n <> 1 then
    fails := fails || 'the generated phone key did not normalise 03 456 789 to 9613456789'::text;
  end if;

  -- 2. Each impossible link, named. `assert` is not used: it can be compiled
  --    out, and a proof that can be switched off is not a proof.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind) values (v_wid, 'capped');
    fails := fails || 'a capped link with no cap was stored'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values (v_wid, 'unlimited', 5);
    fails := fails || 'a cap was stored on an unlimited link'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone) values (v_wid, 'one_time', '123');
    fails := fails || 'a one_time link was stored with a phone that does not normalise'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, discount_pct) values (v_wid, 'unlimited', 10);
    fails := fails || 'a discount was stored on a forwardable link (D-5)'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone, discount_pct)
    values (v_wid, 'one_time', '03 456 780', 500);
    fails := fails || 'a 500% rate was stored, outside 123''s range'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, max_uses, uses_count)
    values (v_wid, 'capped', 5, 6);
    fails := fails || 'a 6-of-5 link was stored'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, token) values (v_wid, 'unlimited', 'not-a-token');
    fails := fails || 'a token that did not come from the house recipe was stored'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, expires_at)
    values (v_wid, 'unlimited', now() + interval '365 days');
    fails := fails || 'an expiry a year out was stored, outside D-6''s 1-180 days'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, expires_at)
    values (v_wid, 'unlimited', now() - interval '1 day');
    fails := fails || 'a link that had already expired when it was made was stored'::text;
  exception when check_violation then null; end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, revoked_at)
    values (v_wid, 'unlimited', now());
    fails := fails || 'a revocation with no revoker was stored'::text;
  exception when check_violation then null; end;

  -- 3. ⭐ THE CROSS-TENANT ONE. This is the assertion the composite key exists
  --    for, and the only one here that is about somebody ELSE'S data.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, catalog_id)
    values (v_wid, 'unlimited', v_other_cat);
    fails := fails || 'a link owned by one store was stored pointing at ANOTHER STORE''S shelf'::text;
  exception when foreign_key_violation then null; end;

  -- ...and the same store's own shelf is still perfectly storable, which is
  -- what stops the fix above from being "reject everything".
  insert into wholesale_v2.v2_share_links (wid, kind, catalog_id)
  values (v_wid, 'unlimited', v_cat);

  -- 4. Two links cannot share a token.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, token) values (v_wid, 'unlimited', v_tok);
    fails := fails || 'two links were stored with the same token'::text;
  exception when unique_violation then null; end;

  if array_length(fails, 1) > 0 then
    raise exception '127 DID NOT LAND: %', array_to_string(fails, ' | ');
  end if;

  raise notice '127 ok: the table stores a real link and refuses all 12 impossible ones';

  -- The fixture leaves nothing behind. ON DELETE CASCADE from the v1 row takes
  -- the v2 store, its catalogues and its links with it.
  delete from wholesale_v2.v2_wholesalers where wid in (v_wid, v_other_wid);
  delete from public.wholesalers          where wid in (v_wid, v_other_wid);

  select count(*) into n from wholesale_v2.v2_share_links where wid in (v_wid, v_other_wid);
  if n <> 0 then
    raise exception '127: the probe left % link row(s) behind', n;
  end if;
end $$;
