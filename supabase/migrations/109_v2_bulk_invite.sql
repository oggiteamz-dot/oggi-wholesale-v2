-- =============================================================================
-- 109 — INVITING A LIST OF SHOPS                                 AC-05, 30 Aug 2026
-- =============================================================================
--
-- ==== WHAT THE CENSUS FOUND FIRST, AND IT WAS NOT WHAT THE REGISTRY SAID ====
--
-- The feature matrix records AC-06 ("invited, not yet accepted" as a state) as
-- ⚠️ *"state exists, no resend button"*. **That is wrong.** A waiting invitation
-- in js/views/wholesaler.js already carries WhatsApp, Copy link and Withdraw,
-- and for an invitation "resend" IS the WhatsApp button -- the link never
-- changed, so there is nothing to re-issue. AC-06 is done and this migration
-- does not touch it; the manifest is corrected instead.
--
-- Checking before building is the whole reason docs/OUTSTANDING.md carries a
-- date at the top: its §1 said the inventory revamp had not started while seven
-- batches of it were shipping.
--
-- ==== WHAT IS ACTUALLY MISSING ============================================
--
-- 1. **Bulk.** `v2_issue_buyer_invite` issues exactly one. A wholesaler
--    onboarding forty existing customers does it forty times, and there is no
--    export, so they then reconstruct forty links by hand to paste into forty
--    WhatsApp threads.
--
-- 2. **The phone is never collected.** The function takes `p_phone`, the table
--    has the column, and the screen's form has one field: shop name. So
--    `phone` is null on every invitation ever issued. That matters more since
--    migration 108: a phone is the handle an anonymous re-application is
--    matched on, and an invitation is the one place a wholesaler is certainly
--    typing a number they already know.
--
-- ==== THE DECISION THAT SHAPES THIS FILE ==================================
--
--     BULK IS A LOOP OVER THE FUNCTION THAT ALREADY ISSUES ONE.
--
-- Not a second INSERT. `v2_issue_buyer_invite` clamps the expiry, stamps
-- `created_by` from the JWT, re-checks `v2_my_wid()` inside itself, and fires
-- migration 104's audit trigger. A bulk path with its own insert would
-- reproduce four behaviours and drift on all of them -- and the audit is the one
-- that would be missed silently, because nothing looks wrong when a log is
-- merely emptier than it should be.
--
-- ==== AND WHAT A REPEATED ROW MEANS =======================================
--
-- A list pasted twice, or a shop that is on it and was already invited last
-- week, must not mint a second live token. Two live invitations for one shop
-- is two credentials for one relationship: revoking the one you can see leaves
-- the other working, which is the worst possible shape for a thing whose entire
-- job is to let somebody in.
--
-- So a row whose phone already has a LIVE invitation returns that invitation --
-- same token, same link, marked `existing`. That is also exactly what "resend"
-- means, so the two features are one code path rather than two that must agree.
--
-- Matched on the NORMALISED phone (108's rule, one definition of "the same
-- number" in this schema), and only when there is a phone: two rows with no
-- number are two different shops, not one, and guessing otherwise would silently
-- drop a shop off a wholesaler's onboarding list.
-- =============================================================================

create or replace function wholesale_v2.v2_issue_buyer_invites_bulk(
  p_rows jsonb, p_days integer default 30)
returns table (
  row_index   integer,
  ok          boolean,
  outcome     text,
  shop_name   text,
  phone       text,
  invite_id   uuid,
  token       text,
  expires_at  timestamptz,
  msg         text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid   text;
  v_n     integer;
  v_i     integer := 0;
  v_row   jsonb;
  v_shop  text;
  v_phone text;
  v_note  text;
  v_key   text;
  v_live  wholesale_v2.v2_buyer_invites%rowtype;
  v_res   record;
  MAX_ROWS constant integer := 200;
begin
  v_wid := wholesale_v2.v2_my_wid();
  if v_wid is null then
    return query select 0, false, 'refused'::text, null::text, null::text,
                        null::uuid, null::text, null::timestamptz,
                        'Only a wholesaler can invite a shop.'::text;
    return;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return query select 0, false, 'refused'::text, null::text, null::text,
                        null::uuid, null::text, null::timestamptz,
                        'Nothing to invite.'::text;
    return;
  end if;

  v_n := jsonb_array_length(p_rows);
  if v_n = 0 then
    return query select 0, false, 'refused'::text, null::text, null::text,
                        null::uuid, null::text, null::timestamptz,
                        'Nothing to invite.'::text;
    return;
  end if;

  if v_n > MAX_ROWS then
    return query select 0, false, 'refused'::text, null::text, null::text,
                        null::uuid, null::text, null::timestamptz,
                        ('That is ' || v_n || ' shops in one go. Do at most ' || MAX_ROWS
                         || ' at a time, so a mistake in the list is a small one.')::text;
    return;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_shop  := nullif(btrim(coalesce(v_row ->> 'shop_name', '')), '');
    v_phone := nullif(btrim(coalesce(v_row ->> 'phone', '')), '');
    v_note  := nullif(btrim(coalesce(v_row ->> 'note', '')), '');
    v_key   := wholesale_v2.v2_normalise_channel('phone', v_phone);

    if v_shop is null and v_key is null then
      return query select v_i, false, 'skipped'::text, v_shop, v_phone,
                          null::uuid, null::text, null::timestamptz,
                          'Neither a shop name nor a usable phone number.'::text;
      continue;
    end if;

    if v_phone is not null and v_key is null then
      return query select v_i, false, 'skipped'::text, v_shop, v_phone,
                          null::uuid, null::text, null::timestamptz,
                          'That is not a phone number.'::text;
      continue;
    end if;

    v_live := null;
    if v_key is not null then
      select * into v_live
        from wholesale_v2.v2_buyer_invites b
       where b.wid = v_wid
         and wholesale_v2.v2_normalise_channel('phone', b.phone) = v_key
         and b.redeemed_at is null
         and b.revoked_at is null
         and b.expires_at > now()
       order by b.created_at desc
       limit 1;
    end if;

    if v_live.id is not null then
      return query select v_i, true, 'existing'::text,
                          coalesce(v_live.shop_name, v_shop), v_live.phone,
                          v_live.id, v_live.token, v_live.expires_at,
                          'Already invited and still waiting — same link, not a second one.'::text;
      continue;
    end if;

    select * into v_res
      from wholesale_v2.v2_issue_buyer_invite(v_shop, v_phone, v_note, p_days);

    if coalesce(v_res.ok, false) then
      return query select v_i, true, 'invited'::text, v_shop, v_phone,
                          v_res.invite_id, v_res.token, v_res.expires_at, null::text;
    else
      return query select v_i, false, 'failed'::text, v_shop, v_phone,
                          null::uuid, null::text, null::timestamptz,
                          coalesce(v_res.msg, 'Could not create this invitation.');
    end if;
  end loop;
end $fn$;

comment on function wholesale_v2.v2_issue_buyer_invites_bulk(jsonb, integer) is
  'AC-05. Invites a list of shops in one go, by LOOPING OVER v2_issue_buyer_invite rather than inserting itself -- that function clamps the expiry, stamps created_by, re-checks v2_my_wid() and fires migration 104''s audit trigger, and a second insert path would drift on all four. A row whose phone already has a LIVE invitation gets that invitation back rather than a second token, which is also what "resend" means, so the two are one code path. Returns one row per input row, in order, so nothing is silently dropped from a wholesaler''s onboarding list.';

revoke all on function wholesale_v2.v2_issue_buyer_invites_bulk(jsonb, integer) from public, anon;
grant execute on function wholesale_v2.v2_issue_buyer_invites_bulk(jsonb, integer) to authenticated;

-- =============================================================================
-- SELF-ASSERTING. Every assertion holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; r record; v_src text;
begin
  -- 1. BULK DOES NOT INSERT. It calls the function that already issues one, so
  --    the expiry clamp, created_by, the wid re-check and the audit trigger
  --    cannot drift between one invitation and forty.
  select prosrc into v_src from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_issue_buyer_invites_bulk';
  if v_src ~* 'insert\s+into\s+(wholesale_v2\.)?v2_buyer_invites' then
    raise exception 'ASSERT 1 FAILED: the bulk path inserts invitations itself instead of calling v2_issue_buyer_invite -- four behaviours are now duplicated';
  end if;
  if v_src !~* 'v2_issue_buyer_invite\(' then
    raise exception 'ASSERT 2 FAILED: the bulk path does not call v2_issue_buyer_invite at all';
  end if;

  -- 3. It refuses a caller who is not a wholesaler. Run as postgres there is no
  --    jwt, so v2_my_wid() is null: this is the check refusing.
  select * into r from wholesale_v2.v2_issue_buyer_invites_bulk('[{"shop_name":"X"}]'::jsonb, 30);
  if coalesce(r.ok, true) then raise exception 'ASSERT 3 FAILED: a caller with no wholesaler identity issued invitations'; end if;

  -- 4. Nothing anonymous can issue invitations in bulk. An invite token is a
  --    way into a locked store and a bulk endpoint is a way to mint many.
  if has_function_privilege('anon','wholesale_v2.v2_issue_buyer_invites_bulk(jsonb,integer)','execute') then
    raise exception 'ASSERT 4 FAILED: anon can issue invitations in bulk';
  end if;

  -- 5. THE BATCH IS CAPPED, and the cap is in the function rather than in the
  --    screen. A list of ten thousand pasted by accident is a wholesaler''s
  --    mistake; ten thousand live tokens is the product''s.
  if v_src !~* 'MAX_ROWS' then
    raise exception 'ASSERT 5 FAILED: there is no cap on how many invitations one call can mint';
  end if;

  -- 6. Malformed input answers rather than raising. This is called from a
  --    screen with a paste box in it.
  select * into r from wholesale_v2.v2_issue_buyer_invites_bulk(null, 30);
  if r.row_index is null then raise exception 'ASSERT 6 FAILED: a null list returned no row at all, so the screen has nothing to show'; end if;
  select * into r from wholesale_v2.v2_issue_buyer_invites_bulk('"not an array"'::jsonb, 30);
  if coalesce(r.ok, true) then raise exception 'ASSERT 6 FAILED: a non-array was accepted'; end if;
  select * into r from wholesale_v2.v2_issue_buyer_invites_bulk('[]'::jsonb, 30);
  if coalesce(r.ok, true) then raise exception 'ASSERT 6 FAILED: an empty list reported success'; end if;

  -- 7. The dedupe is keyed on the SAME normaliser the rest of the schema uses.
  --    A second definition of "the same number" is how a queue ends up
  --    disagreeing with the rule that filled it (108 wrote that down).
  if v_src !~* 'v2_normalise_channel' then
    raise exception 'ASSERT 7 FAILED: the duplicate check does not use v2_normalise_channel, so it has its own idea of what the same number is';
  end if;

  raise notice '109 OK: bulk is a loop over the single-invite function, capped, deduped on the shared normaliser, and refused to anyone without a wid.';
end $$;
