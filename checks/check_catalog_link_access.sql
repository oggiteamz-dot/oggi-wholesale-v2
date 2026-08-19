-- =============================================================================
-- CHECK: who can open a catalog link
-- =============================================================================
-- Hadi set the rules out directly:
--
--   "Imagine me sending this link to a complete stranger by accident. They
--    don't have a username or password. They automatically can't see it."
--   "Let's say a tier four got one of those links, and this is a tier two. They
--    don't get access to it either. Only the right tier and above."
--   "The wholesaler should have the ability to toggle on or off the publicness
--    of this catalog... anyone can go in, anyone can see it, anyone can make an
--    order, and the second they click order they just have to put in their name
--    and phone number."
--
-- Every one of those is a row below. Runs inside a rolled-back transaction, so
-- it is safe against production.
--
-- The two rows at the bottom are about what a link LEAKS. A private link must
-- not name the catalog to someone who has not logged in -- otherwise a
-- forwarded link tells a stranger what the wholesaler is selling and to whom.
-- It does name the WHOLESALER, because a person being asked to log in has to
-- know whose login they need.
--
--   psql "$DATABASE_URL" -f checks/check_catalog_link_access.sql
-- Every row must read PASS.
-- =============================================================================
begin;

insert into public.wholesalers (wid, name) values ('zzlink','Link Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzlink','Link Co') on conflict (wid) do nothing;
insert into public.wholesalers (wid, name) values ('zzother','Other Co') on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values ('zzother','Other Co') on conflict (wid) do nothing;

insert into wholesale_v2.v2_clients (id, wid, shop_name, access_tier)
values ('00000000-0000-4000-8000-0000000c2002','zzlink','Tier 2 Shop', 2);

insert into wholesale_v2.v2_portal_accounts (id, wid, role, username, password_hash, client_id, actor_label, active)
values ('00000000-0000-4000-8000-0000000b2002','zzlink','buyer','zzl2','x','00000000-0000-4000-8000-0000000c2002','T2',true),
       ('00000000-0000-4000-8000-0000000b2099','zzother','buyer','zzoth','x',null,'OTHER',true);

insert into wholesale_v2.v2_catalogs (id, wid, name, access_tier, active, is_public, share_token)
values ('00000000-0000-4000-8000-0000000a2001','zzlink','ZZ Private T2',  2, true,  false, 'tok_private_t2'),
       ('00000000-0000-4000-8000-0000000a2002','zzlink','ZZ Private T4',  4, true,  false, 'tok_private_t4'),
       ('00000000-0000-4000-8000-0000000a2003','zzlink','ZZ Public',      1, true,  true,  'tok_public'),
       ('00000000-0000-4000-8000-0000000a2004','zzlink','ZZ Switched off',1, false, false, 'tok_off');

select label, expected, got, case when got = expected then 'PASS' else 'FAIL' end as verdict from (
  select 'a stranger with no account gets asked to log in, not let in' as label,
         'login_required' as expected,
         (select status from wholesale_v2.v2_catalog_by_token('tok_private_t2', null)) as got
  union all select 'the right tier, logged in, gets in', 'ok',
         (select status from wholesale_v2.v2_catalog_by_token('tok_private_t2','00000000-0000-4000-8000-0000000b2002'))
  union all select 'a tier 2 opening a TIER 4 link is refused', 'denied',
         (select status from wholesale_v2.v2_catalog_by_token('tok_private_t4','00000000-0000-4000-8000-0000000b2002'))
  union all select 'an account from ANOTHER wholesaler is refused', 'denied',
         (select status from wholesale_v2.v2_catalog_by_token('tok_private_t2','00000000-0000-4000-8000-0000000b2099'))
  union all select 'a PUBLIC link works with no account at all', 'ok',
         (select status from wholesale_v2.v2_catalog_by_token('tok_public', null))
  union all select 'a switched-off catalog is dead even for the right login', 'not_found',
         (select status from wholesale_v2.v2_catalog_by_token('tok_off','00000000-0000-4000-8000-0000000b2002'))
  union all select 'a made-up token looks exactly like a dead one', 'not_found',
         (select status from wholesale_v2.v2_catalog_by_token('tok_nonsense', null))
  union all select 'the products call refuses too, not just the resolve call', '0',
         (select count(*)::text from wholesale_v2.v2_catalog_products_by_token('tok_private_t4','00000000-0000-4000-8000-0000000b2002'))
  union all select 'a private catalog is NOT named before login', '(null)',
         (select coalesce(name,'(null)') from wholesale_v2.v2_catalog_by_token('tok_private_t2', null))
  union all select 'but the wholesaler IS, so they know whose login to use', 'Link Co',
         (select wholesaler_name from wholesale_v2.v2_catalog_by_token('tok_private_t2', null))
) r;

rollback;
