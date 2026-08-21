-- =====================================================================
-- 059 — Client status + per-wholesaler bans
--
-- Hadi, 20 Aug 2026: "the wholesaler, whenever he has a client and he
-- wants them out, he can simply just say banned. Like click a button,
-- okay, this person is banned. And it's visual that this person cannot
-- access anything that has to do with this wholesaler."
--
-- WHY THIS IS A TABLE AND NOT A BOOLEAN
-- ------------------------------------------------------------------
-- v2_clients.active already existed and was used by deactivateClient()
-- as a soft delete. Reusing it for "banned" would conflate four
-- genuinely different states -- active / awaiting approval / banned /
-- quietly archived -- behind one boolean, which is the documented bug
-- class here: you can no longer answer "was this person thrown out, or
-- did we just stop dealing with them", and you cannot answer "why" at
-- all. So status becomes a real enum and `active` is kept in sync
-- underneath it, so every existing query that filters .eq("active",true)
-- keeps working untouched.
--
-- WHY THE BAN IS PER-RELATIONSHIP, NEVER GLOBAL
-- ------------------------------------------------------------------
-- Hadi's wording is exact: banned from "anything that has to do with
-- THIS wholesaler". A buyer thrown out by SQUARE must still be able to
-- trade with every other wholesaler on OGGI. So the ban is a row keyed
-- on (wid, client_id). There is deliberately NO global ban flag.
--
-- WHAT ACTUALLY ENFORCES IT (this is the part that matters)
-- ------------------------------------------------------------------
-- Buyers on v2 do NOT use Supabase Auth. They are rows in
-- v2_portal_accounts with a bcrypt password_hash, and every buyer action
-- goes through a SECURITY DEFINER function that re-reads that row
-- server-side (v2_buyer_login, v2_get_buyer_orders, v2_submit_order).
-- There is no self-verifying JWT sitting in the browser that stays valid
-- after we revoke it -- which is the trap this would have hit on
-- Supabase Auth, where a ban blocks the next sign-in but leaves an
-- already-issued token working until it expires.
--
-- So the ban is enforced in three places, all server-side:
--   1. v2_buyer_login          -- cannot get in
--   2. v2_get_buyer_orders     -- cannot read history mid-session
--   3. v2_submit_order         -- cannot place an order mid-session
-- plus v2_portal_accounts.active is flipped off, which those three
-- already check independently. Belt and braces on purpose.
--
-- HONEST LIMIT, STATED NOT HIDDEN
-- ------------------------------------------------------------------
-- Raw product reads (js/data/catalog.js) still go straight to
-- v2_products / v2_product_variants over PostgREST as `anon`, which
-- carry an `auth.uid() is null` read policy predating all of this work
-- (see docs/OUTSTANDING.md §6). So a banned buyer who opens developer
-- tools could still read product rows directly. Everything they can
-- DO -- log in, see history, order -- is closed here. Closing the raw
-- read requires revoking anon on those tables and routing every buyer
-- read through SECURITY DEFINER, which touches the whole buyer app and
-- is its own batch. It is not smuggled in here and it is not pretended
-- away.
-- =====================================================================

set search_path = wholesale_v2, public;

-- ---------------------------------------------------------------------
-- 1. Client status
-- ---------------------------------------------------------------------
-- Four states, because there are four real situations:
--   active   -- normal, trading
--   pending  -- asked to join, wholesaler has not decided yet
--   banned   -- thrown out, must not come back
--   archived -- we stopped dealing with them; no judgement, reversible
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'v2_client_status' and n.nspname = 'wholesale_v2') then
    create type wholesale_v2.v2_client_status as enum ('active','pending','banned','archived');
  end if;
end $$;

alter table wholesale_v2.v2_clients
  add column if not exists status wholesale_v2.v2_client_status not null default 'active';

-- Backfill from the boolean that has been carrying this meaning until
-- now. active=false has only ever meant deactivateClient(), i.e. "we
-- stopped dealing with them" -- never a ban, because bans did not exist.
-- So it maps to 'archived', not 'banned'. Nobody is retroactively
-- accused of anything by this migration.
update wholesale_v2.v2_clients
   set status = case when active then 'active'::wholesale_v2.v2_client_status
                     else 'archived'::wholesale_v2.v2_client_status end
 where status = 'active' and active = false;

comment on column wholesale_v2.v2_clients.status is
  'active / pending / banned / archived. Source of truth. The older `active` boolean is kept in sync by trigger so every pre-existing .eq("active",true) query keeps working -- see 059.';

-- Keep `active` in sync so nothing that already reads it breaks.
-- Direction matters: status is authoritative. But a legacy caller that
-- only knows how to set active=false must still get a sensible status,
-- so that direction is handled too.
create or replace function wholesale_v2.v2_sync_client_active()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.active := (new.status = 'active');
    return new;
  end if;

  if new.status is distinct from old.status then
    -- status changed: it wins
    new.active := (new.status = 'active');
  elsif new.active is distinct from old.active then
    -- only the legacy boolean changed: infer a status from it, but never
    -- invent a ban -- a legacy deactivate means 'archived'.
    new.status := case when new.active then 'active'::wholesale_v2.v2_client_status
                       else 'archived'::wholesale_v2.v2_client_status end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v2_sync_client_active on wholesale_v2.v2_clients;
create trigger trg_v2_sync_client_active
  before insert or update on wholesale_v2.v2_clients
  for each row execute function wholesale_v2.v2_sync_client_active();

-- ---------------------------------------------------------------------
-- 2. The ban record
-- ---------------------------------------------------------------------
-- One row per ban episode. A ban inserts. An unban stamps reversed_at on
-- that row -- it never deletes it. Banning the same person again inserts
-- a NEW row, so "this client has been thrown out three times" stays a
-- question the data can answer two years from now.
create table if not exists wholesale_v2.v2_client_bans (
  id           uuid primary key default gen_random_uuid(),
  wid          text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  client_id    uuid not null references wholesale_v2.v2_clients(id) on delete cascade,
  reason_code  text not null,
  reason_text  text,
  banned_at    timestamptz not null default now(),
  banned_by    text not null,
  reversed_at  timestamptz,
  reversed_by  text,
  reversal_note text,
  constraint v2_client_bans_reason_code_known check (reason_code in (
    'non_payment',        -- did not pay
    'bad_conduct',        -- Hadi, 20 Aug: "bad business conduct... not a
                          -- person I want to do business with anymore"
    'abusive',            -- abusive to staff
    'price_leakage',      -- passing our prices to competitors
    'duplicate',          -- same person, second account
    'not_a_business',     -- not a real shop
    'other'               -- must carry reason_text
  )),
  -- 'other' with no explanation is exactly the "banned for no reason"
  -- failure this whole feature exists to avoid. Forbid it in the schema
  -- rather than trusting the form.
  constraint v2_client_bans_other_needs_text check (
    reason_code <> 'other' or (reason_text is not null and length(btrim(reason_text)) > 0)
  ),
  constraint v2_client_bans_reversal_complete check (
    (reversed_at is null and reversed_by is null)
    or (reversed_at is not null and reversed_by is not null)
  )
);

-- At most ONE live ban per (wid, client_id). Makes "are they banned" a
-- single indexed lookup and makes double-banning impossible.
create unique index if not exists idx_v2_client_bans_live
  on wholesale_v2.v2_client_bans (wid, client_id) where reversed_at is null;
create index if not exists idx_v2_client_bans_client
  on wholesale_v2.v2_client_bans (client_id, banned_at desc);

comment on table wholesale_v2.v2_client_bans is
  'Per-wholesaler bans. One row per ban episode; an unban stamps reversed_at and NEVER deletes, so the history of who was thrown out, by whom, when and why survives. Deliberately not a boolean on v2_clients -- see 059 header.';

alter table wholesale_v2.v2_client_bans enable row level security;

-- Only the owner, or the wholesaler this ban belongs to, may see or
-- write bans. Buyers never read this table -- they are told they are
-- banned by v2_buyer_login's return value, not by reading rows.
drop policy if exists v2_client_bans_scoped on wholesale_v2.v2_client_bans;
create policy v2_client_bans_scoped on wholesale_v2.v2_client_bans for all
  using (
    exists (select 1 from wholesale_v2.v2_user_profiles p
             where p.id = auth.uid()
               and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_client_bans.wid)))
  )
  with check (
    exists (select 1 from wholesale_v2.v2_user_profiles p
             where p.id = auth.uid()
               and (p.role = 'owner' or (p.role = 'wholesaler' and p.wid = v2_client_bans.wid)))
  );

-- ---------------------------------------------------------------------
-- 3. Is this client banned by this wholesaler?
-- ---------------------------------------------------------------------
create or replace function wholesale_v2.v2_is_client_banned(p_wid text, p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = wholesale_v2, public
as $$
  select exists (
    select 1 from wholesale_v2.v2_client_bans
     where wid = p_wid and client_id = p_client_id and reversed_at is null
  );
$$;
revoke all on function wholesale_v2.v2_is_client_banned(text, uuid) from public;
grant execute on function wholesale_v2.v2_is_client_banned(text, uuid) to anon, authenticated;

-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_is_client_banned'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'True if this wholesaler currently bans this client. Per-relationship by design: the same client may be banned by one wholesaler and welcome at another.');
  end loop;
end $cmt$;

-- ---------------------------------------------------------------------
-- 4. Ban / unban
-- ---------------------------------------------------------------------
-- Banning does two things in ONE transaction: writes the record, and
-- switches off every portal login this client owns under this
-- wholesaler. The second is what makes the ban bite immediately --
-- v2_buyer_login, v2_get_buyer_orders and v2_submit_order all re-read
-- v2_portal_accounts.active on every call, so an already-signed-in
-- banned buyer stops being able to do anything on their very next
-- action, not whenever some token happens to expire.
create or replace function wholesale_v2.v2_ban_client(
  p_client_id uuid, p_reason_code text, p_reason_text text default null
)
returns table(ok boolean, msg text, ban_id uuid)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_client wholesale_v2.v2_clients%rowtype;
  v_actor  text;
  v_ban_id uuid;
begin
  select * into v_client from wholesale_v2.v2_clients where id = p_client_id;
  if v_client.id is null then
    return query select false, 'No such client.', null::uuid; return;
  end if;

  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_client.wid) then
    return query select false, 'Not your client.', null::uuid; return;
  end if;

  if p_reason_code = 'other' and (p_reason_text is null or length(btrim(p_reason_text)) = 0) then
    return query select false, 'A reason is required when the code is "other".', null::uuid; return;
  end if;

  if wholesale_v2.v2_is_client_banned(v_client.wid, p_client_id) then
    return query select false, 'This client is already banned.', null::uuid; return;
  end if;

  v_actor := coalesce(wholesale_v2.v2_my_wid(), 'owner');

  insert into wholesale_v2.v2_client_bans (wid, client_id, reason_code, reason_text, banned_by)
  values (v_client.wid, p_client_id, p_reason_code, nullif(btrim(coalesce(p_reason_text,'')), ''), v_actor)
  returning id into v_ban_id;

  update wholesale_v2.v2_clients set status = 'banned', updated_at = now() where id = p_client_id;

  -- Kill the logins. This is the enforcement, not the badge.
  update wholesale_v2.v2_portal_accounts
     set active = false, updated_at = now()
   where client_id = p_client_id and wid = v_client.wid;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (v_actor, 'client_banned', 'client', p_client_id::text,
          jsonb_build_object('reason_code', p_reason_code, 'reason_text', p_reason_text, 'wid', v_client.wid));

  return query select true, 'Client banned.', v_ban_id;
end;
$$;
revoke all on function wholesale_v2.v2_ban_client(uuid, text, text) from public, anon;
grant execute on function wholesale_v2.v2_ban_client(uuid, text, text) to authenticated;

create or replace function wholesale_v2.v2_unban_client(
  p_client_id uuid, p_note text default null
)
returns table(ok boolean, msg text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $$
declare
  v_client wholesale_v2.v2_clients%rowtype;
  v_actor  text;
begin
  select * into v_client from wholesale_v2.v2_clients where id = p_client_id;
  if v_client.id is null then
    return query select false, 'No such client.'; return;
  end if;

  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_client.wid) then
    return query select false, 'Not your client.'; return;
  end if;

  if not wholesale_v2.v2_is_client_banned(v_client.wid, p_client_id) then
    return query select false, 'This client is not banned.'; return;
  end if;

  v_actor := coalesce(wholesale_v2.v2_my_wid(), 'owner');

  -- Stamp the reversal. The row stays. The history stays.
  update wholesale_v2.v2_client_bans
     set reversed_at = now(), reversed_by = v_actor,
         reversal_note = nullif(btrim(coalesce(p_note,'')), '')
   where wid = v_client.wid and client_id = p_client_id and reversed_at is null;

  update wholesale_v2.v2_clients set status = 'active', updated_at = now() where id = p_client_id;

  update wholesale_v2.v2_portal_accounts
     set active = true, updated_at = now()
   where client_id = p_client_id and wid = v_client.wid;

  insert into wholesale_v2.v2_audit_log (actor_label, action, target_type, target_id, details)
  values (v_actor, 'client_unbanned', 'client', p_client_id::text,
          jsonb_build_object('note', p_note, 'wid', v_client.wid));

  return query select true, 'Client unbanned.';
end;
$$;
revoke all on function wholesale_v2.v2_unban_client(uuid, text) from public, anon;
grant execute on function wholesale_v2.v2_unban_client(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The banned buyer must be TOLD, not silently refused
-- ---------------------------------------------------------------------
-- Hadi, 20 Aug: the screen should say "<company name> has banned you
-- from all of their catalogs."
--
-- Until now a banned buyer would have been indistinguishable from
-- someone typing the wrong password, which is the single most-complained
-- -about behaviour in every platform reviewed for this feature ("You'll
-- get declined... Tell stores what criteria they didn't meet").
--
-- The signature gains two columns, so the old function is dropped first.
-- CRITICAL: the ban is revealed ONLY when the password is CORRECT. A
-- wrong password still returns the same blank failure as before, so this
-- cannot be used to discover whether a username exists.
drop function if exists wholesale_v2.v2_buyer_login(text, text, text);
create or replace function wholesale_v2.v2_buyer_login(p_wid text, p_user text, p_pass text)
returns table(
  ok boolean, account_id uuid, client_id uuid, wid text,
  wholesaler_name text, shop_name text, discount_pct numeric, actor_label text,
  status text, banned_by_name text
)
language plpgsql
security definer
set search_path = wholesale_v2, public, extensions
as $$
declare
  v_key text := 'buyer|' || lower(coalesce(p_wid,'')) || '|' || lower(coalesce(p_user,''));
  v_row wholesale_v2.v2_login_throttle%rowtype;
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
  v_wname text;
  MAX_FAILS constant integer := 10;
  WINDOW_LEN constant interval := interval '15 minutes';
  LOCK_LEN constant interval := interval '15 minutes';
begin
  select * into v_row from wholesale_v2.v2_login_throttle where key = v_key for update;

  if v_row.key is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return query select false, null::uuid, null::uuid, null::text, null::text, null::text,
                        null::numeric, null::text, 'bad'::text, null::text;
    return;
  end if;

  if v_row.key is not null and v_row.window_start < now() - WINDOW_LEN then
    update wholesale_v2.v2_login_throttle set fails = 0, window_start = now(), locked_until = null where key = v_key;
    v_row.fails := 0;
  end if;

  -- Match on the PASSWORD only, deliberately ignoring a.active here, so
  -- that a banned person who types their real password can be told why.
  select a.* into v_acct
  from wholesale_v2.v2_portal_accounts a
  join wholesale_v2.v2_wholesalers w on w.wid = a.wid
  where a.wid = p_wid and lower(a.username) = lower(p_user) and a.role = 'buyer'
    and w.active = true
    and a.password_hash = crypt(p_pass, a.password_hash)
  limit 1;

  if v_acct.id is null then
    -- Wrong password (or no such user). Identical blank answer as before.
    insert into wholesale_v2.v2_login_throttle(key, fails, window_start) values (v_key, 1, now())
    on conflict (key) do update
      set fails = wholesale_v2.v2_login_throttle.fails + 1,
          locked_until = case when wholesale_v2.v2_login_throttle.fails + 1 >= MAX_FAILS
                              then now() + LOCK_LEN else null end;
    return query select false, null::uuid, null::uuid, null::text, null::text, null::text,
                        null::numeric, null::text, 'bad'::text, null::text;
    return;
  end if;

  -- Password was right. Clear the throttle either way -- they proved who
  -- they are; a ban is not a brute-force attempt.
  delete from wholesale_v2.v2_login_throttle where key = v_key;

  if v_acct.client_id is not null
     and wholesale_v2.v2_is_client_banned(v_acct.wid, v_acct.client_id) then
    select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_acct.wid;
    return query select false, null::uuid, null::uuid, null::text, null::text, null::text,
                        null::numeric, null::text, 'banned'::text, v_wname;
    return;
  end if;

  if not v_acct.active then
    -- Switched off but not banned. Stays generic on purpose.
    return query select false, null::uuid, null::uuid, null::text, null::text, null::text,
                        null::numeric, null::text, 'bad'::text, null::text;
    return;
  end if;

  return query
  select true, a.id, a.client_id, a.wid, w.name, c.shop_name, c.discount_pct, a.actor_label,
         'ok'::text, null::text
  from wholesale_v2.v2_portal_accounts a
  join wholesale_v2.v2_wholesalers w on w.wid = a.wid
  left join wholesale_v2.v2_clients c on c.id = a.client_id
  where a.id = v_acct.id;
end;
$$;
revoke all on function wholesale_v2.v2_buyer_login(text, text, text) from public;
grant execute on function wholesale_v2.v2_buyer_login(text, text, text) to anon, authenticated;

-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_buyer_login'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'Buyer login. Gained status(ok|banned|bad) + banned_by_name in migration 059 so a banned buyer is TOLD, by name, instead of being shown the same blank refusal as a wrong password. The ban is only ever revealed on a CORRECT password, so this leaks no information about which usernames exist.');
  end loop;
end $cmt$;

-- ---------------------------------------------------------------------
-- 6. Ban bites mid-session, not just at the door
-- ---------------------------------------------------------------------
-- v2_get_buyer_orders and v2_submit_order both re-read
-- v2_portal_accounts with `active = true`, which v2_ban_client switches
-- off -- so they are ALREADY closed by the ban as written above.
--
-- That is not good enough to rely on. It means the ban holds because of
-- a side effect in a different function, and the day someone "fixes"
-- v2_ban_client to stop touching portal accounts, both of those silently
-- reopen with no test failing. So the rule gets its own name below, and
-- migration 060 wires it into both functions explicitly, belt AND
-- braces.
create or replace function wholesale_v2.v2_account_can_act(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = wholesale_v2, public
as $$
  select exists (
    select 1
      from wholesale_v2.v2_portal_accounts a
     where a.id = p_account_id
       and a.active = true
       and (a.client_id is null
            or not wholesale_v2.v2_is_client_banned(a.wid, a.client_id))
  );
$$;
revoke all on function wholesale_v2.v2_account_can_act(uuid) from public;
grant execute on function wholesale_v2.v2_account_can_act(uuid) to anon, authenticated;

-- Batch 7 (21 Aug 2026): the argument list was missing here.
-- "comment on function NAME is ..." only works while NAME is unique. During a
-- REPLAY of this repo from empty, v2_submit_order transiently has two
-- overloads (migration 025 exists precisely to drop a stale one), so an
-- unqualified comment raises "function name is not unique" and the whole
-- replay stops -- on a cosmetic statement. Resolving the oid at run time
-- applies the comment to whatever is actually installed and can never be
-- ambiguous. Behaviour is unchanged: a comment is a description, nothing
-- reads it.
do $cmt$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'wholesale_v2' and p.proname = 'v2_account_can_act'
  loop
    execute format('comment on function %s is %L', r.oid::regprocedure, 'One place that answers "may this portal account still do anything?". Checked by v2_get_buyer_orders and v2_submit_order so a buyer banned mid-session is stopped on their very next action.');
  end loop;
end $cmt$;
