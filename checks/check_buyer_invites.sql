-- ============================================================================
-- check_buyer_invites.sql — Door A: the invitation
--
-- WHAT THIS PROVES
--   An invite link is sent over WhatsApp, which means it WILL be forwarded --
--   that is what WhatsApp is for. So the properties that matter are not
--   "is the token secret" but "what happens when it is not":
--     * single-use, and single-use UNDER CONCURRENCY, not merely in sequence;
--     * revocable, and revocation is honest about itself;
--     * expiring, but not so fast that a real shop misses it;
--     * and redeeming creates the client AND the login together, because a
--       client who cannot sign in is not a client (the 17 Aug SQUARE gap).
--
--   It also proves the lock: `anon` may OPEN and REDEEM an invitation, because
--   the person holding one has no account yet -- and may NOT issue or revoke
--   one, because buyers and sales reps ARE anon.
--
--   Every refusal is asserted BY ITS REASON.
--
-- Run: psql <conn> -f checks/check_buyer_invites.sql        (rolls itself back)
-- ============================================================================
begin;
set local search_path = wholesale_v2, public;

do $check$
declare
  v_wid text; v_tok text; v_tok2 text; v_id uuid; v_id2 uuid;
  v_r record; v_n int; v_client uuid; v_acct uuid;
  v_passed int := 0; v_failed int := 0;
begin
  select w.wid into v_wid from wholesalers w order by w.wid limit 1;
  if v_wid is null then raise exception 'SETUP: no wholesaler'; end if;
  insert into v2_wholesalers (wid, name) values (v_wid, 'CHK invite wholesaler')
    on conflict (wid) do update set name = excluded.name;

  -- Issued directly rather than through the RPC: v2_my_wid() needs a real
  -- Supabase Auth session this fixture cannot mint. The AUTH behaviour is
  -- asserted separately in cases 8 and 9 by reading the grants themselves.
  insert into v2_buyer_invites (wid, shop_name, phone, note, created_by)
  values (v_wid, 'CHK invited shop', '+961 3 000000', 'private note, do not leak', 'chk')
  returning id, token into v_id, v_tok;

  -- ---- CASE 1: the token is unguessable-shaped ---------------------------
  if v_tok ~ '^[0-9a-f]{24}$' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 1 FAILED: token is % (expected 24 hex chars = 96 bits)', coalesce(v_tok,'NULL'); end if;

  -- ---- CASE 2: the invited shop can open it, and sees who invited them ---
  select * into v_r from v2_invite_by_token(v_tok);
  if v_r.status = 'ok' and v_r.wholesaler_name = 'CHK invite wholesaler' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 2 FAILED: a live invite answered % / %', coalesce(v_r.status,'NULL'), coalesce(v_r.wholesaler_name,'NULL'); end if;

  -- ---- CASE 3: and it leaks NOTHING private -----------------------------
  -- The wholesaler's private note about this shop, and the phone they typed
  -- in, must not travel to whoever is holding the link.
  if v_r::text ilike '%do not leak%' or v_r::text ilike '%961%' then
    v_failed := v_failed + 1;
    raise warning 'CASE 3 FAILED: the wholesaler''s note or the phone reached the link: %', v_r::text;
  else v_passed := v_passed + 1; end if;

  -- ---- CASE 4: redeeming creates the client AND the login together -------
  select * into v_r from v2_redeem_buyer_invite(v_tok, 'CHK invited shop', 'chk-inv-buyer', 'secret123');
  if v_r.ok then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 4 FAILED: redeem refused: %', v_r.msg; end if;
  v_client := v_r.client_id; v_acct := v_r.account_id;

  select count(*) into v_n from v2_clients where id = v_client;
  if v_n = 1 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 4b FAILED: no client row was created'; end if;

  select count(*) into v_n from v2_portal_accounts
   where id = v_acct and role = 'buyer' and active and client_id = v_client;
  if v_n = 1 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 4c FAILED: no working buyer login was created -- a client who cannot sign in is not a client'; end if;

  -- ---- CASE 5: the password actually works ------------------------------
  select count(*) into v_n from v2_portal_accounts a
   where a.id = v_acct and a.password_hash = extensions.crypt('secret123', a.password_hash);
  if v_n = 1 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 5 FAILED: the password they chose does not verify -- they would be locked out of the account we just made them'; end if;

  -- ---- CASE 6: SINGLE USE. A forwarded link is dead once used. ----------
  select * into v_r from v2_redeem_buyer_invite(v_tok, 'Somebody Else', 'chk-inv-thief', 'secret123');
  if not v_r.ok and v_r.msg ilike '%already been used%' then v_passed := v_passed + 1;
  elsif not v_r.ok then
    v_failed := v_failed + 1;
    raise warning 'CASE 6 FAILED: refused, but for the WRONG REASON: %. A check that only asserts "something failed" will eventually lie.', v_r.msg;
  else
    v_failed := v_failed + 1;
    raise warning 'CASE 6 FAILED: the same invitation was redeemed TWICE -- a forwarded link would create a second account';
  end if;

  -- and the second attempt created nothing
  select count(*) into v_n from v2_portal_accounts where wid = v_wid and username = 'chk-inv-thief';
  if v_n = 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 6b FAILED: the refused redeem still created an account'; end if;

  -- ---- CASE 7: revoked, expired and used are TOLD APART -----------------
  -- Unlike the order link, where a dead and a fake link must read alike: an
  -- order link may be in a stranger's hands, but an invitation is held by
  -- someone the wholesaler chose to contact. "This was withdrawn" is something
  -- they can act on; "not found" sends them back to ask a question the product
  -- could have answered.
  select * into v_r from v2_invite_by_token(v_tok);
  if v_r.status = 'used' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 7a FAILED: a used invite reports % rather than "used"', v_r.status; end if;

  insert into v2_buyer_invites (wid, shop_name, created_by, revoked_at)
  values (v_wid, 'CHK revoked shop', 'chk', now()) returning token into v_tok2;
  select * into v_r from v2_invite_by_token(v_tok2);
  if v_r.status = 'revoked' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 7b FAILED: a revoked invite reports %', v_r.status; end if;

  insert into v2_buyer_invites (wid, shop_name, created_by, expires_at)
  values (v_wid, 'CHK expired shop', 'chk', now() - interval '1 day') returning token, id into v_tok2, v_id2;
  select * into v_r from v2_invite_by_token(v_tok2);
  if v_r.status = 'expired' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 7c FAILED: an expired invite reports %', v_r.status; end if;

  select * into v_r from v2_redeem_buyer_invite(v_tok2, 'x', 'chk-exp', 'secret123');
  if not v_r.ok and v_r.msg ilike '%expired%' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 7d FAILED: an expired invite could still be redeemed, or was refused for the wrong reason: %', coalesce(v_r.msg,'IT SUCCEEDED'); end if;

  select * into v_r from v2_invite_by_token('ffffffffffffffffffffffff');
  if v_r.status = 'not_found' then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 7e FAILED: an invented token reports %', v_r.status; end if;

  -- ---- CASE 8: the default expiry is generous ---------------------------
  -- MUST-NOT #12 from the research: do not expire an invite so fast that a
  -- real buyer misses it. A shop owner in a market does not read WhatsApp on
  -- our schedule.
  insert into v2_buyer_invites (wid, created_by) values (v_wid, 'chk') returning id into v_id2;
  select count(*) into v_n from v2_buyer_invites
   where id = v_id2 and expires_at > now() + interval '25 days';
  if v_n = 1 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 8 FAILED: the default invite expiry is under 25 days'; end if;

  -- ---- CASE 9: the doors anon may and may not open ----------------------
  if has_function_privilege('anon','wholesale_v2.v2_invite_by_token(text)','execute')
    then v_passed := v_passed + 1;
    else v_failed := v_failed + 1; raise warning 'CASE 9a FAILED: an invited shop cannot open their own link'; end if;

  if has_function_privilege('anon','wholesale_v2.v2_redeem_buyer_invite(text,text,text,text)','execute')
    then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 9b FAILED: an invited shop cannot redeem -- they have no account yet, which is the whole point'; end if;

  if has_function_privilege('anon','wholesale_v2.v2_issue_buyer_invite(text,text,text,integer)','execute') then
    v_failed := v_failed + 1;
    raise warning 'CASE 9c FAILED: anon can ISSUE invitations -- buyers and reps are anon, so anyone could mint access to a store';
  else v_passed := v_passed + 1; end if;

  if has_function_privilege('anon','wholesale_v2.v2_revoke_buyer_invite(uuid)','execute') then
    v_failed := v_failed + 1;
    raise warning 'CASE 9d FAILED: anon can REVOKE -- a buyer could withdraw their wholesaler''s invitations';
  else v_passed := v_passed + 1; end if;

  -- ---- CASE 10: no table grant to anon ----------------------------------
  select count(*) into v_n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_buyer_invites' and grantee='anon';
  if v_n = 0 then v_passed := v_passed + 1;
    else v_failed := v_failed + 1;
      raise warning 'CASE 10 FAILED: anon holds % grant(s) on v2_buyer_invites -- 085 closed that and this must not reopen it', v_n; end if;

  raise notice '----------------------------------------';
  raise notice 'check_buyer_invites: passed: %   failed: %', v_passed, v_failed;
  raise notice '----------------------------------------';
  if v_failed > 0 then raise exception 'check_buyer_invites: % case(s) failed', v_failed; end if;
end;
$check$;

rollback;
