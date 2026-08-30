-- =============================================================================
-- check_bulk_invite.sql — AC-05
-- =============================================================================
-- THE QUESTION: "a wholesaler pastes in forty existing customers. Does each one
-- get exactly one working link, and does the fortieth behave like the first?"
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f checks/check_bulk_invite.sql <db>
-- Rolls itself back. A pass raises ROLLBACK_WITH_REPORT. ⚠️ A runner reading
-- only the exit code will call a PASS a failure (GATE-EVIDENCE.md §7.1).
--
-- THE THREE THAT MATTER MOST:
--
--   * ASSERTION 4 — A REPEATED SHOP GETS THE SAME TOKEN BACK, NOT A SECOND ONE.
--     Two live invitations for one shop is two credentials for one
--     relationship: withdrawing the one you can see leaves the other working.
--     That is the worst possible shape for a thing whose whole job is to let
--     somebody in.
--
--   * ASSERTION 6 — EVERY INPUT ROW COMES BACK, IN ORDER, INCLUDING THE ONES
--     THAT FAILED. A bulk operation that silently drops rows is a wholesaler
--     believing they invited forty shops when they invited thirty-eight.
--
--   * ASSERTION 8 — THE AUDIT FIRES FORTY TIMES, NOT ONCE. Migration 104 made
--     issuing an invitation an access decision. It stays one in bulk, and the
--     only way that stays true is that bulk calls the single-invite function
--     rather than inserting for itself.
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local search_path = wholesale_v2, public;

do $$
declare
  rep text := ''; fails int := 0; n int;
  w      text := '__gate_bulk__';
  prof   uuid := '77777777-aaaa-4aaa-8aaa-777777777777';
  r record; v_tok text; v_tok2 text; v_id uuid;
begin
  rep := rep || E'\n 0  ok   SENTINEL — this gate ran. If this line is absent the run is void.';

  insert into public.wholesalers (wid, name, active) values (w,'Bulk Co',true);
  insert into wholesale_v2.v2_wholesalers (wid, name) values (w,'Bulk Co');
  insert into auth.users (id, email) values (prof,'gate-bulk@example.invalid');
  insert into wholesale_v2.v2_user_profiles (id, role, wid, actor_label)
    values (prof, 'wholesaler', w, 'Bulk Co');

  -- ---------------------------------------------------------------- 1 -------
  -- Before a session exists, nothing may be minted. An invite token is a way
  -- into a locked store; a bulk endpoint is a way to mint many.
  select * into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Nobody"}]'::jsonb, 30);
  if not coalesce(r.ok,false) then rep := rep || E'\n 1  ok   a caller with no wholesaler identity mints nothing';
  else fails := fails+1; rep := rep || E'\n 1  FAIL invitations were issued with no wholesaler identity'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', prof::text, 'role','authenticated')::text, true);

  -- ---------------------------------------------------------------- 2 -------
  select count(*) into n from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Maison Rita","phone":"03 111 222"},
      {"shop_name":"Noor Boutique","phone":"71 333 444"},
      {"shop_name":"Cedar Kids","phone":"76 555 666"}]'::jsonb, 30) q
   where q.ok and q.outcome = 'invited';
  if n = 3 then rep := rep || E'\n 2  ok   three shops in one call, three invitations';
  else fails := fails+1; rep := rep || format(E'\n 2  FAIL %s of 3 rows were invited', n); end if;

  -- ---------------------------------------------------------------- 3 -------
  -- Each one is a REAL, distinct, working token — not three copies of one.
  select count(distinct b.token) into n from wholesale_v2.v2_buyer_invites b where b.wid = w;
  if n = 3 then rep := rep || E'\n 3  ok   ...and three DISTINCT tokens, each its own link';
  else fails := fails+1; rep := rep || format(E'\n 3  FAIL %s distinct tokens for 3 invitations', n); end if;

  select b.token into v_tok from wholesale_v2.v2_buyer_invites b
   where b.wid = w and b.shop_name = 'Maison Rita';
  select count(*) into n from wholesale_v2.v2_invite_by_token(v_tok) i where i.status = 'ok';
  if n = 1 then rep := rep || E'\n 3b ok   ...and a token from the bulk call actually opens, through the function the invited shop uses';
  else fails := fails+1; rep := rep || E'\n 3b FAIL a bulk-issued token does not resolve for the shop it was sent to'; end if;

  -- ---------------------------------------------------------------- 4 -------
  -- ⭐ THE SAME LIST PASTED TWICE. Same token back, and NO second live
  -- invitation, because withdrawing the one you can see must not leave another
  -- working.
  select q.outcome, q.token into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Maison Rita","phone":"03 111 222"}]'::jsonb, 30) q;
  select b.token into v_tok2 from wholesale_v2.v2_buyer_invites b
   where b.wid = w and b.shop_name = 'Maison Rita' order by b.created_at desc limit 1;
  select count(*) into n from wholesale_v2.v2_buyer_invites b where b.wid = w;
  if r.outcome = 'existing' and r.token = v_tok and n = 3 then
    rep := rep || E'\n 4  ok   ⭐ the same shop pasted again gets the SAME link back, and no second token exists';
  else fails := fails+1; rep := rep || format(E'\n 4  FAIL outcome=%L same_token=%s invites_now=%s (expected existing/true/3)', r.outcome, (r.token = v_tok), n); end if;

  -- ---------------------------------------------------------------- 4b ------
  -- ...and the match is on the NUMBER, not the name. The wholesaler retypes
  -- the shop's name differently; it is still the same shop.
  select q.outcome into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"maison rita boutique","phone":"+961 3 111 222"}]'::jsonb, 30) q;
  select count(*) into n from wholesale_v2.v2_buyer_invites b where b.wid = w;
  if r.outcome = 'existing' and n = 3 then
    rep := rep || E'\n 4b ok   ...matched on the normalised NUMBER, so a differently-typed name is still the same shop';
  else fails := fails+1; rep := rep || format(E'\n 4b FAIL outcome=%L invites=%s', r.outcome, n); end if;

  -- ---------------------------------------------------------------- 5 -------
  -- A withdrawn or expired invitation is NOT a live one, so the shop can be
  -- invited again. Otherwise withdrawing somebody would lock them out forever.
  update wholesale_v2.v2_buyer_invites set revoked_at = now()
   where wid = w and shop_name = 'Noor Boutique';
  select q.outcome into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Noor Boutique","phone":"71 333 444"}]'::jsonb, 30) q;
  if r.outcome = 'invited' then
    rep := rep || E'\n 5  ok   a withdrawn invitation does not block a fresh one — withdrawing is not a ban';
  else fails := fails+1; rep := rep || format(E'\n 5  FAIL a withdrawn shop got %L instead of a new invitation', r.outcome); end if;

  -- ---------------------------------------------------------------- 6 -------
  -- ⭐ EVERY ROW COMES BACK, IN ORDER, INCLUDING THE BAD ONES. A bulk call that
  -- silently drops rows is a wholesaler believing they invited more shops than
  -- they did.
  select count(*) into n from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Good One","phone":"03 777 888"},
      {"shop_name":"","phone":""},
      {"shop_name":"Bad Number","phone":"12"},
      {"shop_name":"Also Good","phone":"03 999 000"}]'::jsonb, 30);
  if n = 4 then rep := rep || E'\n 6  ok   ⭐ four rows in, four rows out — the failures are reported, not dropped';
  else fails := fails+1; rep := rep || format(E'\n 6  FAIL %s rows returned for 4 input rows', n); end if;

  select count(*) into n from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"A","phone":"03 121 212"},{"shop_name":"B","phone":"03 131 313"}]'::jsonb, 30) q
   where q.row_index in (1,2);
  if n = 2 then rep := rep || E'\n 6b ok   ...and each carries its position, so the screen can point at the line that failed';
  else fails := fails+1; rep := rep || E'\n 6b FAIL the returned rows do not carry their input position'; end if;

  -- ---------------------------------------------------------------- 7 -------
  -- A row with neither a name nor a usable number is a blank line in a paste,
  -- not a shop. Skipped WITH A REASON, never invented into an invitation.
  select count(*) into n from wholesale_v2.v2_buyer_invites b where b.wid = w and b.shop_name is null and b.phone is null;
  if n = 0 then rep := rep || E'\n 7  ok   a blank line in the paste did not become an invitation to nobody';
  else fails := fails+1; rep := rep || format(E'\n 7  FAIL %s invitation(s) with neither a name nor a number', n); end if;

  -- ---------------------------------------------------------------- 8 -------
  -- ⭐ THE AUDIT FIRES PER INVITATION. Migration 104 made issuing one an access
  -- decision; bulk must not be a way to issue many without a record. This is
  -- the assertion that proves bulk really does go through the single-invite
  -- function rather than reproducing it.
  select count(*) into n from wholesale_v2.v2_audit_log a
   where a.action = 'invite_issued' and a.details ->> 'wid' = w;
  -- EIGHT, counted from the fixture rather than guessed: 3 in the first batch,
  -- 1 when the withdrawn shop is re-invited, 2 good rows out of the mixed four,
  -- and 2 from the position check. The first draft of this line said 7, and the
  -- gate was right to go red about it -- an assertion whose number comes from
  -- memory rather than from the fixture is an assertion about memory.
  if n = 8 then rep := rep || E'\n 8  ok   ⭐ every bulk-issued invitation is in the audit log — 8 issued, 8 recorded';
  else fails := fails+1; rep := rep || format(E'\n 8  FAIL %s audit entries for 8 issued invitations', n); end if;

  -- ---------------------------------------------------------------- 8b ------
  -- ...and the token is STILL not in the log. 104's rule, which a new caller
  -- must not be able to route around.
  select count(*) into n from wholesale_v2.v2_audit_log a
   where a.action = 'invite_issued' and a.details::text like '%' || v_tok || '%';
  if n = 0 then rep := rep || E'\n 8b ok   ...and no token reached the audit log, which is read by more people than the invite is valid for';
  else fails := fails+1; rep := rep || E'\n 8b FAIL an invite token was written into the audit log'; end if;

  -- ---------------------------------------------------------------- 9 -------
  -- The batch is capped in the FUNCTION. A list of ten thousand pasted by
  -- accident is a wholesaler's mistake; ten thousand live tokens is ours.
  select q.ok, q.msg into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    (select jsonb_agg(jsonb_build_object('shop_name','S'||g)) from generate_series(1,201) g), 30) q;
  if not r.ok and r.msg ~* 'at most 200' then
    rep := rep || E'\n 9  ok   201 rows is refused, and the refusal says how many are allowed';
  else fails := fails+1; rep := rep || format(E'\n 9  FAIL a 201-row batch returned ok=%s msg=%L', r.ok, r.msg); end if;

  select count(*) into n from wholesale_v2.v2_buyer_invites b where b.wid = w;
  if n = 8 then rep := rep || E'\n 9b ok   ...and the refused batch minted nothing at all';
  else fails := fails+1; rep := rep || format(E'\n 9b FAIL the over-large batch left %s invitations (expected 8)', n); end if;

  -- --------------------------------------------------------------- 10 -------
  -- Bulk cannot reach another wholesaler's shops. Scope is derived inside the
  -- function from the session, never supplied.
  select count(*) into n from wholesale_v2.v2_buyer_invites b where b.wid <> w;
  if n = 0 then rep := rep || E'\n10  ok   nothing was written outside the caller''s own wholesaler';
  else fails := fails+1; rep := rep || format(E'\n10  FAIL %s invitation(s) landed on another wholesaler', n); end if;

  -- --------------------------------------------------------------- 11 -------
  -- ⭐ BULK REALLY DOES DELEGATE, PROVEN BY A BEHAVIOUR ONLY THE DELEGATE HAS.
  --
  -- v2_issue_buyer_invite CLAMPS the expiry to 180 days -- "a caller-supplied
  -- 36500 would be an invite that never dies, which is the same as no expiry at
  -- all", in its own words. A bulk path that inserted for itself would honour
  -- 9999 and nothing else here would notice: the audit trigger is on the TABLE,
  -- so it fires either way, and every other assertion in this file would still
  -- pass.
  --
  -- This is the assertion that makes "bulk is a loop over the single-invite
  -- function" a checkable claim rather than a comment in a migration header.
  select q.expires_at into r from wholesale_v2.v2_issue_buyer_invites_bulk(
    '[{"shop_name":"Forever Shop","phone":"03 424 242"}]'::jsonb, 9999) q;
  if r.expires_at is not null and r.expires_at < now() + interval '181 days' then
    rep := rep || E'\n11  ok   ⭐ a 9999-day request came back clamped — bulk goes through v2_issue_buyer_invite, it does not insert for itself';
  else fails := fails+1; rep := rep || format(E'\n11  FAIL a bulk invitation expires %s — the clamp inside v2_issue_buyer_invite was bypassed', r.expires_at); end if;

  -- ...and the same delegation is what stamps who issued it.
  select count(*) into n from wholesale_v2.v2_buyer_invites b
   where b.wid = w and coalesce(b.created_by,'') = '';
  if n = 0 then rep := rep || E'\n11b ok   ...and every bulk-issued invitation records who issued it';
  else fails := fails+1; rep := rep || format(E'\n11b FAIL %s invitation(s) have no created_by', n); end if;

  perform set_config('request.jwt.claims', '{}', true);

  if fails > 0 then
    raise exception E'check_bulk_invite: % FAILURE(S)%', fails, rep;
  end if;
  raise exception E'ROLLBACK_WITH_REPORT%\n\n --- check_bulk_invite: ALL ASSERTIONS HELD (0 rows written) ---', rep;
end $$;

rollback;
