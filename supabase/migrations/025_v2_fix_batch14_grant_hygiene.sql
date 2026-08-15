-- Batch 14 follow-up fix -- grant hygiene bug found during the final
-- get_advisors security sweep.
--
-- Four functions in migrations 022/024 were meant to be authenticated-
-- only (v2_create_invite, v2_redeem_invite, v2_create_portal_account,
-- v2_approve_signup_request -- all owner/wholesaler-authorization-gated
-- by their own internal auth.uid() checks) but each migration only did
-- `revoke all ... from public` before granting to `authenticated`. That
-- is NOT enough on this project: Supabase's default privileges grant
-- EXECUTE on every newly created public-schema function directly to the
-- `anon` role (not to the PUBLIC pseudo-role), so `revoke ... from
-- public` never touches that grant -- confirmed live via pg_proc.proacl,
-- which showed anon=X on all four despite the "to authenticated" grant
-- clause. Migration 018 (Batch 12) got this right for
-- v2_get_integration_secret by explicitly also revoking from
-- `anon, authenticated` before granting service_role -- this migration
-- brings 022/024's four functions in line with that same correct
-- pattern. The migration 022/024 source files have ALSO been updated
-- (revoke ... from public, anon) so a fresh `supabase db reset`
-- produces the same, correct result without needing this follow-up file
-- -- this file exists because 022/024 were already applied live before
-- the bug was found, and migrations are not re-run once applied.
--
-- Exploitability assessment (verified live, not assumed): NOT actually
-- exploitable in practice. v2_redeem_invite has an explicit
-- `if auth.uid() is null then return false...` guard as its very first
-- statement, before touching any invite state. The other three all
-- gate on `v2_is_owner() OR v2_my_wid() = <target wid>`, and both of
-- those helper functions correctly return false/null for a caller with
-- no real auth.uid() (a truly anonymous request), so every code path an
-- anon caller could reach already returned a clean rejection -- verified
-- live via `set local role = 'anon'` before and after this fix. This is
-- a real hygiene/defense-in-depth fix (principle of least privilege --
-- the database's own grant system should enforce this, not solely the
-- function body), not a fix for an active data-leak or unauthorized-
-- write vulnerability.

revoke all on function v2_create_invite(text, text, text, integer) from anon;
revoke all on function v2_redeem_invite(text, text) from anon;
revoke all on function v2_create_portal_account(text, text, text, text, uuid, text) from anon;
revoke all on function v2_approve_signup_request(uuid, text) from anon;

grant execute on function v2_create_invite(text, text, text, integer) to authenticated;
grant execute on function v2_redeem_invite(text, text) to authenticated;
grant execute on function v2_create_portal_account(text, text, text, text, uuid, text) to authenticated;
grant execute on function v2_approve_signup_request(uuid, text) to authenticated;
