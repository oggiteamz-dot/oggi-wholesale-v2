-- =============================================================================
-- CHECK: an impossible share link cannot be stored — LINK-01, migration 127
-- =============================================================================
-- WHY THIS FILE EXISTS WHEN MIGRATION 127 ALREADY PROVES MOST OF IT.
-- 127's DO block runs ONCE, on the day it is applied, against the database it
-- is applied to. This file runs against ANY database, for ever -- including
-- production, and including a database where somebody has since dropped a
-- constraint "temporarily". That difference is the whole argument for the
-- checks/ directory, and it is why the assertions are duplicated on purpose
-- rather than trusted to the migration.
--
-- It also proves four things a migration's own DO block structurally cannot:
--   * that row security is ON and there is NO policy (the fail-closed posture)
--   * that no browser role holds a grant on the table
--   * that the token DEFAULT is the house recipe, not merely that one token
--     happened to look right
--   * that the generated phone key is GENERATED, not a column somebody fills in
--
-- WHAT IT DOES NOT CLAIM. Nothing here decides who gets into a store. The
-- redemption rules -- the row lock, the cap, the phone match -- are migration
-- 128, and check_a_link_is_a_row.sql going green says only that a link which
-- breaks the model cannot be written down.
--
-- Writes nothing: everything happens inside a transaction that is rolled back.

begin;

-- The fixture. Two stores, because the sharpest assertion in this file is
-- about one store's link naming another store's shelf.
insert into public.wholesalers (wid, name, active) values
  ('zzl01', 'Link Gate Co',   true),
  ('zzl02', 'Link Gate Other',true)
on conflict (wid) do nothing;

insert into wholesale_v2.v2_wholesalers (wid, name) values
  ('zzl01', 'Link Gate Co'),
  ('zzl02', 'Link Gate Other')
on conflict (wid) do nothing;

create temporary table zzl_results (ord int, label text, expected text, got text) on commit drop;

do $check$
declare
  v_cat   uuid;
  v_other uuid;
  v_tok   text;
  v_id    uuid;
  n       int;
begin
  select id into v_cat   from wholesale_v2.v2_catalogs where wid = 'zzl01' and is_default;
  select id into v_other from wholesale_v2.v2_catalogs where wid = 'zzl02' and is_default;

  ---------------------------------------------------------------- 1. it works
  -- First, and deliberately first: a gate made entirely of refusals passes on a
  -- table that refuses everything, including the links the product needs.
  insert into wholesale_v2.v2_share_links (wid, kind, invitee_name, invitee_phone, discount_pct)
  values ('zzl01', 'one_time', 'Rita Boutique', '03 456 789', 12.50)
  returning id, token into v_id, v_tok;

  insert into zzl_results values
    (1, 'a real one_time link with a name, a phone and a rate is storable', 'stored',
        case when v_id is null then 'REFUSED' else 'stored' end);

  ------------------------------------------------------- 2. the token's shape
  -- Asserted on a token the DATABASE chose, so this is a statement about the
  -- column default rather than about a string this file typed.
  insert into zzl_results values
    (2, 'the token comes from the house recipe: 24 lowercase hex', 'yes',
        case when v_tok ~ '^[0-9a-f]{24}$' then 'yes' else coalesce(v_tok, 'NULL') end);

  insert into zzl_results values
    (3, 'and the DEFAULT is gen_random_bytes(12), not a browser or a caller', 'house recipe',
        (select case when pg_get_expr(d.adbin, d.adrelid) like '%gen_random_bytes(12)%'
                     then 'house recipe' else coalesce(pg_get_expr(d.adbin, d.adrelid), 'NO DEFAULT') end
           from pg_attrdef d
           join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
           join pg_class c on c.oid = d.adrelid
           join pg_namespace ns on ns.oid = c.relnamespace
          where ns.nspname = 'wholesale_v2' and c.relname = 'v2_share_links' and a.attname = 'token'));

  ------------------------------------------------- 4. the phone key is derived
  select count(*) into n from wholesale_v2.v2_share_links
   where id = v_id and invitee_phone_key = '9613456789';
  insert into zzl_results values
    (4, '03 456 789 normalises to a key without anybody remembering to', '1', n::text);

  insert into zzl_results values
    (5, 'and the key is GENERATED, so no caller can forget it', 'generated',
        (select case when a.attgenerated = 's' then 'generated' else 'A CALLER MUST FILL IT IN' end
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace ns on ns.oid = c.relnamespace
          where ns.nspname = 'wholesale_v2' and c.relname = 'v2_share_links'
            and a.attname = 'invitee_phone_key'));

  ------------------------------------------------------- 6-14. the refusals
  -- Every one of these is a link somebody could plausibly try to create through
  -- a form, an import, or a hand-written SQL statement one afternoon.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind) values ('zzl01', 'capped');
    insert into zzl_results values (6, 'a capped link with no cap', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (6, 'a capped link with no cap', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values ('zzl01', 'unlimited', 5);
    insert into zzl_results values (7, 'a cap on a link that is not capped', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (7, 'a cap on a link that is not capped', 'refused', 'refused'); end;

  -- '123' is seven characters of nothing. v2_normalise_channel returns NULL
  -- under 7 DIGITS, so this is also the assertion that the constraint checks
  -- the KEY and not the raw text -- a check on `invitee_phone is not null`
  -- would store this happily and the phone gate would then match nobody.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone) values ('zzl01', 'one_time', '123');
    insert into zzl_results values (8, 'a "one time link for one person" with no usable number', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (8, 'a "one time link for one person" with no usable number', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, discount_pct) values ('zzl01', 'unlimited', 10);
    insert into zzl_results values (9, 'a discount on a link anyone may forward (D-5)', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (9, 'a discount on a link anyone may forward (D-5)', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone, discount_pct)
    values ('zzl01', 'one_time', '03 456 780', 500);
    insert into zzl_results values (10, 'a 500% rate, outside the range 123 gave the dial', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (10, 'a 500% rate, outside the range 123 gave the dial', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, max_uses, uses_count)
    values ('zzl01', 'capped', 5, 6);
    insert into zzl_results values (11, 'a 6-of-5 link', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (11, 'a 6-of-5 link', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, token) values ('zzl01', 'unlimited', 'not-a-token');
    insert into zzl_results values (12, 'a token that did not come from the database', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (12, 'a token that did not come from the database', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, expires_at)
    values ('zzl01', 'unlimited', now() + interval '365 days');
    insert into zzl_results values (13, 'an expiry a year out (D-6 clamps at 180 days)', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (13, 'an expiry a year out (D-6 clamps at 180 days)', 'refused', 'refused'); end;

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, revoked_at) values ('zzl01', 'unlimited', now());
    insert into zzl_results values (14, 'a revocation with nobody who revoked it', 'refused', 'STORED');
  exception when check_violation then
    insert into zzl_results values (14, 'a revocation with nobody who revoked it', 'refused', 'refused'); end;

  ------------------------------------------- 15-16. ⭐ THE CROSS-TENANT ONE
  -- The assertion the composite foreign key exists for. A link owned by zzl01
  -- naming zzl02's shelf is a cross-tenant leak that NO row-security policy on
  -- this table would catch, because the row genuinely belongs to zzl01.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, catalog_id) values ('zzl01', 'unlimited', v_other);
    insert into zzl_results values (15, '⭐ a link pointing at ANOTHER STORE''S shelf', 'refused', 'STORED');
  exception when foreign_key_violation then
    insert into zzl_results values (15, '⭐ a link pointing at ANOTHER STORE''S shelf', 'refused', 'refused'); end;

  -- ...and the store's OWN shelf still works. Without this row, "reject every
  -- catalogue" would pass assertion 15 and break the feature.
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, catalog_id) values ('zzl01', 'unlimited', v_cat);
    insert into zzl_results values (16, 'and the store''s own shelf is still storable', 'stored', 'stored');
  exception when others then
    insert into zzl_results values (16, 'and the store''s own shelf is still storable', 'stored', 'REFUSED'); end;

  ---------------------------------------------------------- 17. one token, one link
  begin
    insert into wholesale_v2.v2_share_links (wid, kind, token) values ('zzl01', 'unlimited', v_tok);
    insert into zzl_results values (17, 'two links with the same token', 'refused', 'STORED');
  exception when unique_violation then
    insert into zzl_results values (17, 'two links with the same token', 'refused', 'refused'); end;

  ------------------------------------------------------ 18. the clock is kept
  -- ⚠️ THE OBVIOUS VERSION OF THIS ASSERTION CANNOT WORK AND IT IS WORTH SAYING
  -- WHY, because the obvious version was written first and failed on a correct
  -- trigger. `update ... ; require updated_at > created_at` is false inside a
  -- transaction: now() is the TRANSACTION's clock, not the statement's, so
  -- every timestamp this file writes is the same instant. The gate would have
  -- been "fixed" by switching the trigger to clock_timestamp() -- changing
  -- production behaviour to suit a test, which is backwards.
  --
  -- What is provable, and is the property that actually matters: a caller
  -- CANNOT set updated_at themselves. The trigger overwrites whatever they
  -- send. Written as a wrong value going in and the transaction's own clock
  -- coming back.
  update wholesale_v2.v2_share_links
     set note = 'touched', updated_at = timestamptz '2000-01-01 00:00:00+00'
   where id = v_id;
  select count(*) into n from wholesale_v2.v2_share_links
   where id = v_id and updated_at = now();
  insert into zzl_results values
    (18, 'a caller cannot backdate updated_at: the trigger overwrites it', '1', n::text);
end
$check$;

-- A NOTE ON THE VERDICT EXPRESSION, WRITTEN BECAUSE I GOT IT WRONG FIRST.
-- While red-proving assertion 3 I believed a NULL `got` would produce an EMPTY
-- verdict cell -- neither PASS nor FAIL -- and therefore a gate that reads
-- GREEN with an assertion unanswered. I changed this expression AND added a
-- rule to run_sql_gates.sh to catch it. Both were unnecessary and both are
-- reverted, because the premise is false:
--
--   case when NULL then 'PASS' else 'FAIL' end  ->  'FAIL'
--
-- A CASE whose condition is NULL is not true, so the ELSE branch fires. A
-- structural assertion whose subquery finds nothing therefore reads FAIL
-- already, which is exactly what it should read. Measured, not assumed:
--
--   label                            | expected | got | verdict
--   a rule whose answer went missing | present  |     | FAIL
--
-- Left here rather than deleted because "there is no hole in the verdict
-- expression" is worth an hour of somebody's time, and because a runner rule
-- added to guard a hazard that does not exist is a grep that can only ever
-- cry wolf. `got` is still COALESCED for the reader -- an empty cell next to
-- the word FAIL tells you nothing about what was actually found.
select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzl_results

  -- 19. ⛔ FAIL-CLOSED, AND THIS IS THE ROW THAT SURVIVES THE GRANT DRIFT.
  --     Row security ON with NO policy denies every non-owner role outright,
  --     whatever privileges they hold. Production's `authenticated` carries
  --     table privileges that no migration in this repo grants
  --     (GATE-EVIDENCE.md, "the grant drift"), so a lock that depended on a
  --     grant staying revoked would be undone by whatever granted those.
  union all select 19, 'row security is ON and NO policy opens the table', 'rls on, 0 policies',
    (select case when not c.relrowsecurity then 'RLS IS OFF'
                 else 'rls on, ' || (select count(*) from pg_policies
                                      where schemaname = 'wholesale_v2'
                                        and tablename = 'v2_share_links') || ' policies' end
       from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'wholesale_v2' and c.relname = 'v2_share_links')

  -- 20. and the revoke, which is the second lock rather than the only one.
  --     PUBLIC is named as well as the two roles: migration 124 was corrected
  --     for exactly this, after a sabotage failed to go red because `anon`
  --     inherited a privilege through PUBLIC rather than holding it directly.
  union all select 20, 'no browser role holds a privilege on the links table', 'none',
    (select coalesce(string_agg(distinct g.grantee || ':' || g.privilege_type, ', '), 'none')
       from information_schema.role_table_grants g
      where g.table_schema = 'wholesale_v2' and g.table_name = 'v2_share_links'
        and g.grantee in ('anon', 'authenticated', 'PUBLIC'))

  -- 21. the composite key itself, by name. Assertion 15 proves the BEHAVIOUR;
  --     this proves the mechanism is the one documented, so a future reader
  --     who drops it sees two rows go red instead of wondering why one did.
  union all select 21, 'the shelf and the store are tied together by a foreign key', 'present',
    (select case when count(*) = 1 then 'present' else 'MISSING' end
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid
       join pg_namespace ns on ns.oid = r.relnamespace
      where ns.nspname = 'wholesale_v2' and r.relname = 'v2_share_links'
        and c.conname = 'v2_share_links_catalog_same_store')
) r
order by ord, label;

rollback;
