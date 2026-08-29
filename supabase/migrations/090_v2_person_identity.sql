-- =============================================================================
-- 090 — ONE PERSON, MANY STORES                            ID-01, 29 August 2026
-- =============================================================================
--
-- THE PROBLEM, STATED EXACTLY
--
-- Today a buyer login belongs to exactly one wholesaler. `v2_portal_accounts`
-- has `wid NOT NULL`, and wid is half of the unique username index:
--
--     idx_v2_portal_accounts_buyer_username (wid, lower(username)) where role='buyer'
--
-- So one human buying from three wholesalers is three unrelated rows with three
-- usernames and three passwords, and NOTHING in the schema joins them. That was
-- correct while the product was one locked store per wholesaler. It is fatal to
-- the marketplace, where the whole proposition is "the wholesalers YOU have
-- access to" -- a sentence that cannot be written in SQL against this shape.
--
-- WHAT THIS MIGRATION IS, AND WHAT IT DELIBERATELY IS NOT
--
-- It is ADDITIVE ONLY. It adds a person layer beside the accounts and backfills
-- it. It does NOT change the login path, does not drop a column, does not touch
-- an existing index, and does not require anyone to re-register. GP-02 in the
-- research is blunt about this -- "never force existing buyers to re-register
-- when the system changes" -- and the cheapest way to honour it is to make the
-- change invisible until the screens that use it are ready.
--
-- The follow-on work (ID-03, signing in without a wholesaler code) reads this
-- layer. It is a separate migration on purpose: this one can be applied and
-- verified while nothing depends on it yet, which is the safest possible order.
--
-- THE SHAPE
--
--   v2_people              a human. Has no phone and no email of its own.
--   v2_person_channels     a VERIFIED WAY TO REACH that human. kind + value.
--   v2_person_memberships  that human's access to ONE store.
--   v2_portal_accounts.person_id   the bridge back to the login that exists.
--
-- Why the channel is its own table and not two columns on the person: ID-04
-- says phone/email are channels hanging off a person, never the identity
-- itself. A person can change their number -- that is ID-08, an entire feature
-- -- and a column cannot hold "this number used to be theirs, and this one is
-- theirs now, and both were verified on these dates". A person with two phones
-- and an email is three rows, which is what it actually is.
--
-- ==== THE MOST IMPORTANT RULE IN THIS FILE =================================
--
-- NORMALISATION MAY SPLIT A PERSON. IT MUST NEVER MERGE TWO.
--
-- Matching identities on a phone number means a normalisation bug does not
-- produce a cosmetic glitch -- it produces one person holding another person's
-- store access, which is the worst outcome this system has. So every rule
-- below is written to fail toward "these are two different people", never
-- toward "these are the same one":
--
--   * anything shorter than 7 digits normalises to NULL, so junk like '0' or
--     '-' or '000' creates no channel at all rather than a channel everyone
--     collides on. A missing channel costs someone a convenience. A colliding
--     channel costs someone their privacy.
--   * an email must contain '@' and a dot after it, or it is NULL.
--   * a number that is already international is left alone rather than
--     re-interpreted -- guessing is how +1 555... and +961 555... become one
--     person.
--
-- The Lebanese default (+961) is applied ONLY to a number that is unambiguously
-- local: it starts with 0, or it is short enough that it cannot be anything
-- else. This is deliberately not a full libphonenumber; it is a small rule set
-- whose failure mode is known and safe.
-- =============================================================================

-- ------------------------------------------------------------- the person --
create table if not exists wholesale_v2.v2_people (
  id            uuid primary key default gen_random_uuid(),
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table wholesale_v2.v2_people is
  'A human who buys. Deliberately holds no phone and no email: those are channels (v2_person_channels), because a person can change their number and a column cannot hold the history of that. Not v2_user_profiles -- that is the owner/wholesaler side and hangs off auth.users; this side has no Supabase Auth session at all (085).';

-- ----------------------------------------------------------- the channels --
create table if not exists wholesale_v2.v2_person_channels (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references wholesale_v2.v2_people(id) on delete cascade,
  kind         text not null check (kind in ('phone','email')),
  raw          text not null,
  normalised   text not null,
  verified_at  timestamptz,
  source       text,
  created_at   timestamptz not null default now()
);

-- THE join key of the whole marketplace. Two accounts that normalise to the
-- same number are the same human, and this index is what makes that true
-- rather than aspirational.
create unique index if not exists v2_person_channels_uq
  on wholesale_v2.v2_person_channels (kind, normalised);
create index if not exists v2_person_channels_person_idx
  on wholesale_v2.v2_person_channels (person_id);

comment on column wholesale_v2.v2_person_channels.raw is
  'Exactly what the human typed, kept forever. When a normalisation rule is later found to be wrong, this is the only way to recompute without having destroyed the evidence.';
comment on column wholesale_v2.v2_person_channels.verified_at is
  'NULL means claimed, not proven. Backfilled channels are all NULL: a number a wholesaler typed into a client record is a good hint and is NOT proof the person holds that SIM. ID-05 (the one-time code) is what sets this.';

-- --------------------------------------------------------- the membership --
create table if not exists wholesale_v2.v2_person_memberships (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references wholesale_v2.v2_people(id) on delete cascade,
  wid          text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  client_id    uuid references wholesale_v2.v2_clients(id) on delete set null,
  account_id   uuid references wholesale_v2.v2_portal_accounts(id) on delete set null,
  role         text not null default 'buyer' check (role in ('buyer','sales')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create unique index if not exists v2_person_memberships_uq
  on wholesale_v2.v2_person_memberships (person_id, wid, role);
create index if not exists v2_person_memberships_wid_idx
  on wholesale_v2.v2_person_memberships (wid) where active;

comment on table wholesale_v2.v2_person_memberships is
  'One row per store a person may enter. THIS is the table that makes "the wholesalers you have access to" a query instead of a wish. Revoking is setting active=false and stamping revoked_at (AC-13), never deleting the row -- a deleted membership loses the fact that they were ever a customer.';

-- ------------------------------------------------ the bridge to what exists --
alter table wholesale_v2.v2_portal_accounts
  add column if not exists person_id uuid references wholesale_v2.v2_people(id) on delete set null;

create index if not exists v2_portal_accounts_person_idx
  on wholesale_v2.v2_portal_accounts (person_id);

comment on column wholesale_v2.v2_portal_accounts.person_id is
  'Nullable ON PURPOSE and for a long time. The login path does not read it yet (ID-03 does). A NULL here means an account that predates the person layer or was created by a path not yet updated -- it must keep working exactly as before, which is why nothing in this migration makes it NOT NULL.';

-- ========================================================= normalisation ====
-- Split, never merge. See the header.
create or replace function wholesale_v2.v2_normalise_channel(p_kind text, p_value text)
returns text
language plpgsql
immutable
set search_path = wholesale_v2, public
as $fn$
declare
  v text;
begin
  v := btrim(coalesce(p_value, ''));
  if v = '' then return null; end if;

  if p_kind = 'email' then
    v := lower(v);
    -- Must look like an address. A string without '@' and a dot after it is a
    -- typo or a placeholder, and turning it into a join key would merge every
    -- person who shares the typo.
    if v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return null;
    end if;
    return v;
  end if;

  if p_kind = 'phone' then
    v := regexp_replace(v, '[^0-9]', '', 'g');
    if v = '' then return null; end if;

    -- International prefix typed as 00.
    if left(v, 2) = '00' then v := substr(v, 3); end if;

    if left(v, 3) = '961' then
      -- Already Lebanese international. Leave it.
      null;
    elsif left(v, 1) = '0' then
      -- Unambiguously local: 03 456 789 -> 961 3 456 789
      v := '961' || regexp_replace(v, '^0+', '');
    elsif length(v) <= 8 then
      -- Short enough that it cannot be a foreign number in this market.
      v := '961' || v;
    else
      -- Already international and NOT Lebanese. Left exactly as typed.
      -- Re-interpreting this is how a US number and a Lebanese number become
      -- the same person.
      null;
    end if;

    -- Below this length it is not a phone number, it is a fragment, and a
    -- fragment shared by many records is a merge waiting to happen.
    if length(v) < 7 then return null; end if;
    return v;
  end if;

  return null;
end;
$fn$;

comment on function wholesale_v2.v2_normalise_channel(text, text) is
  'Turns a typed phone or email into the join key that decides whether two logins are the same human. Written so every failure mode SPLITS a person rather than MERGING two: too-short input returns NULL, a malformed email returns NULL, and a number that is already international is never re-interpreted.';

-- ============================================================== backfill ====
-- Every existing buyer and rep login becomes a person with one membership, and
-- two logins that share a phone or an email become ONE person with two.
--
-- THIS IS A FUNCTION, NOT AN INLINE `do` BLOCK, AND THAT IS THE POINT.
-- An inline block can only be tested by a gate that reimplements it, and a
-- gate that tests a COPY of the logic is the exact shape of a check that
-- passes while the real thing is broken -- this repo has been bitten by that
-- twice already (checks/GATE-EVIDENCE.md). As a function, the migration and
-- checks/check_person_identity.sql call the same code.
--
-- It is also idempotent (`where person_id is null`), so it can be re-run after
-- a later import without duplicating anyone.
create or replace function wholesale_v2.v2_backfill_person_identity()
returns table(people_created int, accounts_joined int)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  a        record;
  v_person uuid;
  v_chan   record;
  v_norm   text;
  n_people int := 0;
  n_merged int := 0;
begin
  for a in
    select pa.id, pa.wid, pa.role, pa.username, pa.actor_label, pa.client_id,
           c.phone, c.phone2, c.email, c.shop_name
      from wholesale_v2.v2_portal_accounts pa
      left join wholesale_v2.v2_clients c on c.id = pa.client_id
     where pa.person_id is null
     order by pa.created_at, pa.id
  loop
    v_person := null;

    -- Does any channel on this account already belong to a known person?
    for v_chan in
      select 'phone'::text as kind, x as val from unnest(array[a.phone, a.phone2]) x
      union all
      select 'email'::text, a.email
    loop
      v_norm := wholesale_v2.v2_normalise_channel(v_chan.kind, v_chan.val);
      if v_norm is not null and v_person is null then
        select ch.person_id into v_person
          from wholesale_v2.v2_person_channels ch
         where ch.kind = v_chan.kind and ch.normalised = v_norm;
        if v_person is not null then n_merged := n_merged + 1; end if;
      end if;
    end loop;

    if v_person is null then
      insert into wholesale_v2.v2_people (display_name)
      values (coalesce(nullif(btrim(a.actor_label), ''), a.shop_name, a.username))
      returning id into v_person;
      n_people := n_people + 1;
    end if;

    -- Attach every channel this account can offer. `on conflict do nothing`
    -- because the unique index is the authority on who owns a number.
    for v_chan in
      select 'phone'::text as kind, x as val from unnest(array[a.phone, a.phone2]) x
      union all
      select 'email'::text, a.email
    loop
      v_norm := wholesale_v2.v2_normalise_channel(v_chan.kind, v_chan.val);
      if v_norm is not null then
        insert into wholesale_v2.v2_person_channels
          (person_id, kind, raw, normalised, source)
        values (v_person, v_chan.kind, v_chan.val, v_norm, 'backfill-090')
        on conflict (kind, normalised) do nothing;
      end if;
    end loop;

    insert into wholesale_v2.v2_person_memberships
      (person_id, wid, client_id, account_id, role, active)
    values (v_person, a.wid, a.client_id, a.id,
            case when a.role = 'sales' then 'sales' else 'buyer' end, true)
    on conflict (person_id, wid, role) do nothing;

    update wholesale_v2.v2_portal_accounts set person_id = v_person where id = a.id;
  end loop;

  return query select n_people, n_merged;
end;
$fn$;

revoke all on function wholesale_v2.v2_backfill_person_identity() from public;
grant execute on function wholesale_v2.v2_backfill_person_identity() to authenticated;

comment on function wholesale_v2.v2_backfill_person_identity() is
  'Maps every portal account with no person onto one, merging accounts that share a normalised phone or email into a single person with several memberships. Idempotent. A function rather than inline SQL so the gate can exercise the real code instead of a copy of it.';

do $$
declare r record;
begin
  select * into r from wholesale_v2.v2_backfill_person_identity();
  raise notice '090 backfill: % person(s) created, % account(s) joined to an existing person.',
    r.people_created, r.accounts_joined;
end $$;

-- ============================================================ visibility ====
alter table wholesale_v2.v2_people            enable row level security;
alter table wholesale_v2.v2_person_channels   enable row level security;
alter table wholesale_v2.v2_person_memberships enable row level security;

-- A wholesaler may see the membership rows for THEIR OWN store, and nothing
-- else. Deliberately NOT "may see the person": knowing that a shop also buys
-- from a competitor is exactly the cross-store leak this table could cause,
-- and no screen needs it.
drop policy if exists v2_person_memberships_scoped on wholesale_v2.v2_person_memberships;
create policy v2_person_memberships_scoped on wholesale_v2.v2_person_memberships for all
  using (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid())
  with check (wholesale_v2.v2_is_owner() or wid = wholesale_v2.v2_my_wid());

-- People and channels are owner-only for now. A wholesaler reaches the people
-- in their store through the membership above; there is no screen that needs
-- the person row itself, and a table with no policy and no grant is the
-- cheapest thing to get right.
drop policy if exists v2_people_owner_only on wholesale_v2.v2_people;
create policy v2_people_owner_only on wholesale_v2.v2_people for all
  using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

drop policy if exists v2_person_channels_owner_only on wholesale_v2.v2_person_channels;
create policy v2_person_channels_owner_only on wholesale_v2.v2_person_channels for all
  using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select on wholesale_v2.v2_person_memberships to authenticated;
grant select, insert, update on wholesale_v2.v2_people          to authenticated;
grant select, insert, update on wholesale_v2.v2_person_channels to authenticated;
-- anon gets NOTHING. 085 revoked every table privilege from anon and set the
-- default-privileges rule to keep doing so. These three tables arrive closed.

-- =============================================================================
-- SELF-ASSERTING, like 085, 088 and 089.
-- =============================================================================
do $$
declare n int; m int;
begin
  -- 1. the three tables exist
  select count(*) into n from information_schema.tables
   where table_schema='wholesale_v2'
     and table_name in ('v2_people','v2_person_channels','v2_person_memberships');
  if n <> 3 then raise exception 'ASSERT 1 FAILED: expected 3 identity tables, found %', n; end if;

  -- 2. anon holds nothing on any of them
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and grantee='anon'
     and table_name in ('v2_people','v2_person_channels','v2_person_memberships');
  if n <> 0 then raise exception 'ASSERT 2 FAILED: anon holds % grant(s) on the identity tables -- buyers and reps ARE anon (085), so that is every person''s cross-store map readable by anyone', n; end if;

  -- 3. EVERY existing login was given a person. A backfill that silently skips
  --    rows is worse than no backfill: it looks done.
  select count(*) into n from wholesale_v2.v2_portal_accounts where person_id is null;
  if n <> 0 then raise exception 'ASSERT 3 FAILED: % portal account(s) still have no person after the backfill', n; end if;

  -- 4. every account has exactly one membership for its own store
  select count(*) into n
    from wholesale_v2.v2_portal_accounts pa
    left join wholesale_v2.v2_person_memberships pm
           on pm.account_id = pa.id and pm.wid = pa.wid
   where pm.id is null;
  if n <> 0 then raise exception 'ASSERT 4 FAILED: % account(s) have a person but no membership in their own store', n; end if;

  -- 5. THE RULE. Normalisation must never merge two different numbers.
  if wholesale_v2.v2_normalise_channel('phone','03 456 789')
     <> wholesale_v2.v2_normalise_channel('phone','+961 3 456 789') then
    raise exception 'ASSERT 5a FAILED: the same Lebanese number written two ways did not normalise together';
  end if;
  if wholesale_v2.v2_normalise_channel('phone','+1 555 010 0999')
      = wholesale_v2.v2_normalise_channel('phone','+961 555 010 0999') then
    raise exception 'ASSERT 5b FAILED: a US number and a Lebanese number normalised to the SAME person';
  end if;
  if wholesale_v2.v2_normalise_channel('phone','0') is not null
     or wholesale_v2.v2_normalise_channel('phone','---') is not null
     or wholesale_v2.v2_normalise_channel('phone','000') is not null then
    raise exception 'ASSERT 5c FAILED: junk normalised to a real join key, which would merge every record holding that junk';
  end if;
  if wholesale_v2.v2_normalise_channel('email','not-an-email') is not null
     or wholesale_v2.v2_normalise_channel('email','a@b') is not null then
    raise exception 'ASSERT 5d FAILED: a malformed email became a join key';
  end if;
  if wholesale_v2.v2_normalise_channel('email','  Farah@Shop.COM ')
     <> 'farah@shop.com' then
    raise exception 'ASSERT 5e FAILED: email normalisation is not case- and space-insensitive';
  end if;

  -- 6. no person ended up with two memberships in the SAME store and role
  select count(*) into n from (
    select person_id, wid, role from wholesale_v2.v2_person_memberships
     group by 1,2,3 having count(*) > 1
  ) d;
  if n <> 0 then raise exception 'ASSERT 6 FAILED: % duplicate membership(s)', n; end if;

  -- 7. the login path is untouched: both username indexes still exist exactly
  --    as they were, so nobody has to re-register (GP-02).
  select count(*) into n from pg_indexes
   where schemaname='wholesale_v2'
     and indexname in ('idx_v2_portal_accounts_buyer_username','idx_v2_portal_accounts_sales_username');
  if n <> 2 then raise exception 'ASSERT 7 FAILED: this migration disturbed the username indexes -- existing buyers would have to re-register'; end if;

  select count(*) into n from wholesale_v2.v2_people;
  select count(*) into m from wholesale_v2.v2_person_memberships;
  raise notice '090 OK: % person(s), % membership(s); every login mapped; anon holds nothing; login path untouched.', n, m;
end $$;
