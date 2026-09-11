-- =============================================================================
-- 133 — A DESK SIGNS IN                                Block 7, 11 September 2026
-- =============================================================================
--
-- 132 built a tier that can do nothing. This gives it a door, and -- more
-- importantly -- THE ONE GATE every future desk function must pass through.
--
-- ==== ⭐ v2_staff_wid() IS THE WHOLE AUTHORISATION MODEL OF THIS TIER ========
--
-- A desk session runs as PostgREST `anon`. anon holds no grant on
-- v2_staff_accounts (132), so a desk cannot read its own row, cannot see a
-- password hash, and cannot learn that another store exists. Everything it may
-- do arrives as a SECURITY DEFINER function that takes its id.
--
-- An id passed by a browser is a CLAIM, not a credential. The salesperson tier
-- learned this the expensive way and wrote it down (048:132, and
-- js/views/salesperson.js:176-183): "a rep runs as anon and could otherwise
-- claim to be anyone".
--
-- So every desk function begins the same way:
--
--     v_wid := wholesale_v2.v2_staff_wid(p_staff_id, 'warehouse');
--     if v_wid is null then return; end if;      -- zero rows, never an error
--
-- ONE function, checked in ONE place. The alternative -- each RPC re-writing
-- `where id = p_staff_id and desk = ... and active` -- is six copies of a
-- security check, and the sixth will be the one that forgets `active`.
-- checks/check_the_third_tier.sql asserts that EVERY function reachable by a
-- desk calls it, so a new one that forgets goes red rather than open.
--
-- ==== WHY IT RETURNS NULL AND NOT AN ERROR ==================================
--
-- A raised exception distinguishes "wrong desk" from "no such account" from
-- "suspended". That is three facts a stranger with a guessed uuid should not be
-- handed. 088 made the same choice for share links -- "a dead link and a fake
-- link answer identically" -- and this is the same rule one tier down.
--
-- ==== THE THROTTLE IS THE EXISTING ONE ======================================
--
-- v2_login_throttle (022:126) already locks a key after 10 fails in 15 minutes
-- and is deny-all to every browser role. Reusing it means one throttle to
-- reason about rather than two that drift. The key is namespaced 'staff|wid|user'
-- so a warehouse login cannot lock out a salesperson with the same name.
-- =============================================================================

set search_path = wholesale_v2, public;

-- ============================================================ THE ONE GATE ===
create or replace function wholesale_v2.v2_staff_wid(p_staff_id uuid, p_desk text)
returns text
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select s.wid
    from wholesale_v2.v2_staff_accounts s
    join wholesale_v2.v2_wholesalers w on w.wid = s.wid
   where s.id = p_staff_id
     and s.desk = p_desk
     and s.active
     and coalesce(w.active, true)
   limit 1;
$fn$;

comment on function wholesale_v2.v2_staff_wid(uuid, text) is
  'THE authorisation gate for the store-staff tier (132). Returns the wid this '
  'staff id may act for AT THAT DESK, or NULL. Null -- never an exception -- so '
  'that "wrong desk", "no such account" and "suspended" are indistinguishable '
  'to a caller holding a guessed uuid. Every desk function must call it; '
  'checks/check_the_third_tier.sql asserts that every one does.';

-- Callable by anon: a desk IS anon, and this function tells a caller nothing it
-- did not already supply unless the caller is genuinely that account.
revoke all on function wholesale_v2.v2_staff_wid(uuid, text) from public;
grant execute on function wholesale_v2.v2_staff_wid(uuid, text) to anon, authenticated;

-- =================================================================== THE DOOR
create or replace function wholesale_v2.v2_staff_login(
  p_wid text, p_username text, p_password text)
returns table(ok boolean, staff_id uuid, wid text, desk text,
              wholesaler_name text, actor_label text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_key text := 'staff|' || lower(coalesce(p_wid,'')) || '|' || lower(coalesce(p_username,''));
  v_row wholesale_v2.v2_login_throttle%rowtype;
  v_hit boolean := false;
  MAX_FAILS  constant integer  := 10;
  WINDOW_LEN constant interval := interval '15 minutes';
  LOCK_LEN   constant interval := interval '15 minutes';
begin
  select * into v_row from wholesale_v2.v2_login_throttle where key = v_key for update;

  if v_row.key is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    -- Locked out. Answers exactly as a wrong password does: a caller learns
    -- whether they are throttled by being slow, not by being told.
    return query select false, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  if v_row.key is not null and v_row.window_start < now() - WINDOW_LEN then
    update wholesale_v2.v2_login_throttle
       set fails = 0, window_start = now(), locked_until = null
     where key = v_key;
  end if;

  select true into v_hit
    from wholesale_v2.v2_staff_accounts s
    join wholesale_v2.v2_wholesalers w on w.wid = s.wid
   where s.wid = p_wid
     and lower(s.username) = lower(coalesce(p_username,''))
     and s.active
     and coalesce(w.active, true)
     and s.password_hash = extensions.crypt(coalesce(p_password,''), s.password_hash)
   limit 1;

  if coalesce(v_hit, false) then
    delete from wholesale_v2.v2_login_throttle where key = v_key;
    return query
      select true, s.id, s.wid, s.desk, w.name, s.actor_label
        from wholesale_v2.v2_staff_accounts s
        join wholesale_v2.v2_wholesalers w on w.wid = s.wid
       where s.wid = p_wid
         and lower(s.username) = lower(coalesce(p_username,''))
         and s.active
         and coalesce(w.active, true)
         and s.password_hash = extensions.crypt(coalesce(p_password,''), s.password_hash);
    return;
  end if;

  insert into wholesale_v2.v2_login_throttle (key, fails, window_start)
  values (v_key, 1, now())
  on conflict (key) do update
     set fails = wholesale_v2.v2_login_throttle.fails + 1,
         locked_until = case when wholesale_v2.v2_login_throttle.fails + 1 >= MAX_FAILS
                             then now() + LOCK_LEN else null end;

  return query select false, null::uuid, null::text, null::text, null::text, null::text;
end;
$fn$;

comment on function wholesale_v2.v2_staff_login(text,text,text) is
  'The store-staff door (132/133). Throttled through the existing '
  'v2_login_throttle under a namespaced key so a warehouse login cannot lock out '
  'a salesperson of the same name. Returns ok=false identically for a wrong '
  'password, an unknown user, a suspended account, a closed store and a '
  'throttled key.';

revoke all on function wholesale_v2.v2_staff_login(text,text,text) from public;
grant execute on function wholesale_v2.v2_staff_login(text,text,text) to anon, authenticated;

-- ============================================ RESUMING A SESSION AFTER RELOAD
-- The browser keeps the staff id in localStorage, exactly as the salesperson
-- tier keeps its account id. On every reload the app must ask the SERVER whether
-- that id is still good -- a suspended picker must stop working at the next
-- page load, not at the end of some cached session.
create or replace function wholesale_v2.v2_staff_session(p_staff_id uuid)
returns table(ok boolean, staff_id uuid, wid text, desk text,
              wholesaler_name text, actor_label text)
language sql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select true, s.id, s.wid, s.desk, w.name, s.actor_label
    from wholesale_v2.v2_staff_accounts s
    join wholesale_v2.v2_wholesalers w on w.wid = s.wid
   where s.id = p_staff_id
     and s.active
     and coalesce(w.active, true)
   limit 1;
$fn$;

comment on function wholesale_v2.v2_staff_session(uuid) is
  'Re-validates a remembered staff id on every page load. Returns zero rows for '
  'a suspended account or a closed store, so revoking a desk takes effect at the '
  'next reload rather than whenever a cached session happens to expire.';

revoke all on function wholesale_v2.v2_staff_session(uuid) from public;
grant execute on function wholesale_v2.v2_staff_session(uuid) to anon, authenticated;

-- ==================================================== HIRING, AND ONLY HIRING
-- The wholesaler who employs them, or the platform owner. Mirrors
-- v2_create_portal_account (022:469) including its asymmetry: the CALLER's
-- authority is checked, and the DESK is restricted, so a wholesaler can never
-- mint something above their own head.
create or replace function wholesale_v2.v2_create_staff_account(
  p_wid text, p_desk text, p_username text, p_password text, p_actor_label text default null)
returns table(ok boolean, msg text, staff_id uuid)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public, extensions
as $fn$
declare
  v_id uuid;
  v_user text := lower(trim(coalesce(p_username,'')));
begin
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = p_wid) then
    return query select false, 'Not authorized', null::uuid; return;
  end if;
  if p_desk not in ('warehouse','finance') then
    return query select false, 'A desk is either warehouse or finance', null::uuid; return;
  end if;
  if v_user = '' then
    return query select false, 'A username is required', null::uuid; return;
  end if;
  -- Eight, matching what the Team screen already asks of a portal account, not
  -- the six the server settled for in 022:491. A staff login opens a warehouse
  -- tablet that sits on a bench all day.
  if length(coalesce(p_password,'')) < 8 then
    return query select false, 'Use at least 8 characters', null::uuid; return;
  end if;
  if exists (select 1 from wholesale_v2.v2_staff_accounts
              where wid = p_wid and lower(username) = v_user) then
    return query select false, 'Somebody at this store already uses that name', null::uuid; return;
  end if;

  insert into wholesale_v2.v2_staff_accounts (wid, desk, username, password_hash, actor_label, created_by)
  values (p_wid, p_desk, v_user,
          extensions.crypt(p_password, extensions.gen_salt('bf')),
          nullif(trim(coalesce(p_actor_label,'')),''), auth.uid())
  returning id into v_id;

  return query select true, 'Created', v_id;
end;
$fn$;

-- ⛔ authenticated ONLY. A desk may not hire a desk: anon must never reach this.
revoke all on function wholesale_v2.v2_create_staff_account(text,text,text,text,text) from public, anon;
grant execute on function wholesale_v2.v2_create_staff_account(text,text,text,text,text) to authenticated;

create or replace function wholesale_v2.v2_set_staff_active(p_staff_id uuid, p_active boolean)
returns table(ok boolean, msg text)
language plpgsql
volatile
security definer
set search_path = wholesale_v2, public
as $fn$
declare v_wid text;
begin
  select wid into v_wid from wholesale_v2.v2_staff_accounts where id = p_staff_id;
  if v_wid is null then return query select false, 'No such account'; return; end if;
  if not (wholesale_v2.v2_is_owner() or wholesale_v2.v2_my_wid() = v_wid) then
    return query select false, 'Not authorized'; return;
  end if;
  update wholesale_v2.v2_staff_accounts
     set active = p_active, updated_at = now()
   where id = p_staff_id;
  return query select true, case when p_active then 'Reinstated' else 'Suspended' end;
end;
$fn$;

revoke all on function wholesale_v2.v2_set_staff_active(uuid,boolean) from public, anon;
grant execute on function wholesale_v2.v2_set_staff_active(uuid,boolean) to authenticated;

-- =============================================================================
-- SELF-TEST — probes of this migration's own making, rolled back.
-- =============================================================================
do $$
declare
  n integer;
  v_id uuid;
  v_wid text;
begin
  -- 1. anon may open the door and resume a session, and may NOT hire.
  select count(*) into n from information_schema.role_routine_grants
   where routine_schema='wholesale_v2' and grantee='anon'
     and routine_name in ('v2_staff_login','v2_staff_session','v2_staff_wid');
  if n < 3 then
    raise exception 'ASSERT 1 FAILED: a desk cannot sign in -- anon holds % of the 3 needed grants', n;
  end if;

  select count(*) into n from information_schema.role_routine_grants
   where routine_schema='wholesale_v2' and grantee in ('anon','public')
     and routine_name in ('v2_create_staff_account','v2_set_staff_active');
  if n <> 0 then
    raise exception 'ASSERT 2 FAILED: anon can hire or suspend staff (% grant(s)) -- a desk could promote itself', n;
  end if;

  -- 2..6 behaviour, on probes, rolled back
  begin
    insert into public.wholesalers (wid, name, active) values ('zz133a','zz133 probe',false);
    insert into wholesale_v2.v2_wholesalers (wid, name) values ('zz133a','zz133 probe');
    insert into wholesale_v2.v2_staff_accounts (wid, desk, username, password_hash, active)
    values ('zz133a','warehouse','picker', extensions.crypt('correct-horse', extensions.gen_salt('bf')), true)
    returning id into v_id;

    -- the gate answers for the right desk
    if wholesale_v2.v2_staff_wid(v_id, 'warehouse') is distinct from 'zz133a' then
      raise exception 'ASSERT 3 FAILED: the gate did not recognise a live warehouse account';
    end if;

    -- ⭐ and refuses the OTHER desk, which is the point of naming the desk in it
    if wholesale_v2.v2_staff_wid(v_id, 'finance') is not null then
      raise exception 'ASSERT 4 FAILED: a WAREHOUSE account passed the FINANCE gate -- the two column walls would be one wall';
    end if;

    -- suspending takes effect immediately in the gate
    update wholesale_v2.v2_staff_accounts set active = false where id = v_id;
    if wholesale_v2.v2_staff_wid(v_id, 'warehouse') is not null then
      raise exception 'ASSERT 5 FAILED: a SUSPENDED account still passes the gate';
    end if;
    update wholesale_v2.v2_staff_accounts set active = true where id = v_id;

    -- closing the STORE takes effect too, without touching the account
    update wholesale_v2.v2_wholesalers set active = false where wid = 'zz133a';
    if wholesale_v2.v2_staff_wid(v_id, 'warehouse') is not null then
      raise exception 'ASSERT 6 FAILED: a desk at a CLOSED store still passes the gate';
    end if;
    update wholesale_v2.v2_wholesalers set active = true where wid = 'zz133a';

    -- the door: right password in, wrong password out
    select count(*) into n from wholesale_v2.v2_staff_login('zz133a','picker','correct-horse') where ok;
    if n <> 1 then raise exception 'ASSERT 7 FAILED: the correct password did not open the door'; end if;
    select count(*) into n from wholesale_v2.v2_staff_login('zz133a','picker','wrong') where ok;
    if n <> 0 then raise exception 'ASSERT 8 FAILED: a wrong password opened the door'; end if;
    -- and the same username at a store that is not theirs
    select count(*) into n from wholesale_v2.v2_staff_login('zz999','picker','correct-horse') where ok;
    if n <> 0 then raise exception 'ASSERT 9 FAILED: a login worked against the wrong store'; end if;

    raise exception 'zz133 rollback';
  exception
    when others then
      if sqlerrm like 'ASSERT%' then raise; end if;
      if sqlerrm not like 'zz133 rollback%' then
        raise exception '133 SELF-TEST FAILED unexpectedly: %', sqlerrm;
      end if;
  end;

  if exists (select 1 from wholesale_v2.v2_staff_accounts)
     or exists (select 1 from public.wholesalers where wid like 'zz133%') then
    raise exception '133: the probes left rows behind';
  end if;

  raise notice '133 OK: a desk can sign in, cannot hire, cannot cross to the other desk, and stops at suspension.';
end $$;
