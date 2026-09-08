-- =============================================================================
-- CHECK: what a share link may never do — LINK-13, migrations 126–129
-- =============================================================================
-- The other twelve gates in this block each prove that one piece WORKS. This
-- one proves the block has no way to be USED. It is written across all four
-- migrations rather than against any one of them, because every property below
-- is a property of the seam between two of them, and a seam is exactly what a
-- per-migration gate cannot see.
--
-- THE FIVE THINGS A LINK MAY NEVER DO
--
--   1. ⭐ TELL A STRANGER WHETHER A TOKEN WAS EVER REAL. A used-up one-person
--      link, a withdrawn link, an expired link and twenty-four hex digits
--      somebody invented must produce the SAME answer, from BOTH functions
--      that answer about tokens. Migration 056 established the rule; here it is
--      asserted across the peek AND the redemption at once, because two
--      functions that disagree about which tokens are real make an oracle out
--      of two halves -- and neither one's own gate can see the other.
--
--   2. ⭐ CARRY A PRICE AFTER REDEMPTION. Migration 122's whole subject: the
--      door a buyer came through must not decide what they pay. A link's
--      discount is written ONCE onto the customer's own record, and after that
--      the store screen and the link screen quote the same number. Asserted by
--      pricing the SAME buyer through both doors and requiring equality.
--
--   3. ⭐ REACH ANOTHER STORE. Not through the catalogue argument (127's
--      composite key), not through the membership it writes, and not through
--      what the wholesaler's own list returns. Two tenants exist in this
--      fixture for the whole run and every count is taken per tenant.
--
--   4. SURVIVE ITS OWN WITHDRAWAL, ITS OWN EXPIRY, OR ITS OWN CAP. Each of
--      those is a separate branch in 128 and each is proved to end in refusal
--      rather than in a grant.
--
--   5. ⭐ BE A WAY TO WRITE ANYTHING IT WAS NOT BUILT TO WRITE. `anon` can
--      call the redemption by necessity -- the redeemer has no account yet --
--      so this asserts the FULL 124 treatment: the exact set of anon-callable
--      functions this block added, the tables it may reach, and a row census
--      of every other table in the schema taken before and after a redemption.
--      A future edit that made redemption touch stock, or orders, or another
--      tenant's clients, turns this red without anybody remembering to add it.
--
-- Writes nothing: one transaction, rolled back at the end.

begin;

insert into public.wholesalers (wid, name, active) values
  ('zzs01', 'Never Co A', true), ('zzs02', 'Never Co B', true)
  on conflict (wid) do nothing;
insert into wholesale_v2.v2_wholesalers (wid, name) values
  ('zzs01', 'Never Co A'), ('zzs02', 'Never Co B')
  on conflict (wid) do nothing;

create temporary table zzs_results (ord int, label text, expected text, got text) on commit drop;
create temporary table zzs_census (phase text, tbl text, n bigint) on commit drop;

do $check$
declare
  wA text := 'zzs01';
  wB text := 'zzs02';
  v_t_used text; v_t_revoked text; v_t_expired text; v_t_live text; v_t_capped text;
  v_t_priced text;
  v_fake text := repeat('a', 24);
  v_id uuid;
  r record; r2 record;
  n int;
  v_prod uuid; v_var uuid; v_cat_a uuid; v_cat_b uuid;
  v_price_store numeric; v_price_link numeric;
  v_acct uuid; v_client uuid; v_person uuid;
  v_answers text[];
  v_tbl text;
  -- Separate from v_tbl on purpose. The first draft read the peek's answer back
  -- INTO the loop variable it was iterating; it happens to work, because the
  -- argument is evaluated before the assignment, but a reader has to prove that
  -- to themselves before they can trust the assertion.
  v_one text;
begin
  ---------------------------------------------------------------- the fixture
  select id into v_cat_a from wholesale_v2.v2_catalogs where wid = wA and is_default;
  select id into v_cat_b from wholesale_v2.v2_catalogs where wid = wB and is_default;

  insert into wholesale_v2.v2_products (wid, name) values (wA, 'Never Shirt')
    returning id into v_prod;
  insert into wholesale_v2.v2_product_variants (product_id, sku, price)
    values (v_prod, 'ZZS-1-NAVY-M', 200.00) returning id into v_var;

  -- A live one-person link carrying a rate. This is the one that proves (2).
  insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone, discount_pct)
    values (wA, 'one_time', '03 900 001', 25.00) returning token into v_t_priced;

  insert into wholesale_v2.v2_share_links (wid, kind, invitee_phone)
    values (wA, 'one_time', '03 900 002') returning token into v_t_used;
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'unlimited')
    returning token into v_t_live;
  insert into wholesale_v2.v2_share_links (wid, kind, max_uses) values (wA, 'capped', 1)
    returning token into v_t_capped;

  -- ⚠ revoked_by is NOT optional: 127's v2_share_links_revocation_has_an_actor
  -- says (revoked_at is null) = (revoked_by is null), because 104 established
  -- that a decision without a decider is a record nobody can act on. The first
  -- draft of this fixture set only revoked_at and the whole gate aborted on the
  -- constraint -- which is the constraint doing its job on the gate itself.
  insert into wholesale_v2.v2_share_links (wid, kind, revoked_at, revoked_by)
    values (wA, 'unlimited', now(), gen_random_uuid()) returning token into v_t_revoked;

  -- ⚠ An expired link cannot simply be inserted with a past expires_at: 127's
  -- v2_share_links_expiry_window requires expires_at > created_at. BOTH
  -- timestamps have to be aged, which is why this is an UPDATE and not a
  -- second INSERT. The same trap cost a round on check_a_link_is_a_row.sql.
  insert into wholesale_v2.v2_share_links (wid, kind) values (wA, 'unlimited')
    returning id, token into v_id, v_t_expired;
  update wholesale_v2.v2_share_links
     set created_at = now() - interval '60 days', expires_at = now() - interval '30 days'
   where id = v_id;

  -- Spend the one-person link and the capped link, so both are "used up but
  -- perfectly real" for assertion 1.
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_used, '03 900 002', 'Used', 'Used Shop', 'zzsused', 'hunter2secret');
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_capped, '03 900 003', 'Cap', 'Cap Shop', 'zzscap', 'hunter2secret');

  -- ================================================== 1. NO TOKEN ORACLE ====
  -- Three tokens that differ in every way that matters to the database, and one
  -- of them never existed. If any pair answers differently, somebody guessing
  -- tokens learns something about the wholesaler's history.
  --
  -- ⚠️ A USED ONE-PERSON LINK IS DELIBERATELY NOT IN THIS SET, and the first
  -- draft of this gate had it there and went red. That was the gate being
  -- wrong, not the code: a used link is ALIVE. LINK-05's whole promise is that
  -- there is no state of that screen where somebody holding a real link is
  -- shown a wall -- Hadi, "either way, they get access and they are logged in"
  -- -- so a used one-person link still names the store and still renders the
  -- form, and only the sentence above it changes. The no-oracle rule is about
  -- tokens that are DEAD or INVENTED, which is what a guesser holds. Lumping
  -- the two together would have made this gate demand the removal of the
  -- feature the block was built for. Assertion 5 asserts the difference is
  -- deliberate, so neither half can be quietly dropped.
  v_answers := array[]::text[];
  foreach v_tbl in array array[v_t_revoked, v_t_expired, v_fake] loop
    select p.status || '|' || coalesce(p.wid, '-') || '|' || coalesce(p.wholesaler_name, '-')
        || '|' || coalesce(p.kind, '-') || '|' || coalesce(p.hint, '-') || '|' || p.msg
      into v_one
      from wholesale_v2.v2_share_link_peek(v_tbl) p;
    v_answers := v_answers || v_one;
  end loop;

  insert into zzs_results values (1,
    '⭐ the peek says the same thing about a withdrawn, an expired and an invented token',
    '1 distinct answer', cardinality(array(select distinct unnest(v_answers)))::text || ' distinct answer');

  -- ...and 'the same thing' must not be a leak in itself: no store name in it.
  insert into zzs_results values (2,
    'and that one answer names no store', 'names nobody',
    case when v_answers[1] like '%Never Co%' then 'IT NAMES THE STORE' else 'names nobody' end);

  -- The REDEMPTION half of the same rule. A gate that only checked the peek
  -- would miss an oracle built from the two functions disagreeing.
  v_answers := array[]::text[];
  -- The alias is `rr`, not `r2`: `r2` is a declared record in this block, and
  -- PL/pgSQL resolves the NAME before the alias, so `select r2.msg` read the
  -- unassigned variable and raised "record r2 is not assigned yet" rather than
  -- reading the function's column. The same shadowing trap as 126's `wid`.
  foreach v_tbl in array array[v_t_revoked, v_t_expired, v_fake] loop
    select rr.msg into v_one from wholesale_v2.v2_redeem_share_link(
      v_tbl, '03 900 09' || length(v_tbl)::text, 'X', 'X Shop',
      'zzsx' || substr(md5(v_tbl), 1, 6), 'hunter2secret') rr;
    v_answers := v_answers || v_one;
  end loop;
  insert into zzs_results values (3,
    '⭐ and so does the redemption, for the same three',
    '1 distinct answer', cardinality(array(select distinct unnest(v_answers)))::text || ' distinct answer');

  -- ⭐ AND THE TWO FUNCTIONS AGREE WITH EACH OTHER. This is the assertion
  -- neither migration's own gate can make.
  select p.msg into v_one from wholesale_v2.v2_share_link_peek(v_fake) p;
  insert into zzs_results values (4,
    '⭐ the peek and the redemption give a stranger the SAME sentence', 'identical',
    case when v_one = v_answers[1] then 'identical' else 'DIFFERENT: "' || v_one || '" vs "' || v_answers[1] || '"' end);

  -- ⭐ THE OTHER HALF, so the rule above cannot be satisfied by killing the
  -- feature. A used one-person link is alive: it names the store and it still
  -- offers the form. If a future change made a used link answer like a dead
  -- one, assertion 1 would stay green and LINK-05 would be gone.
  select p.status, p.wholesaler_name, p.hint into r
    from wholesale_v2.v2_share_link_peek(v_t_used) p;
  insert into zzs_results values (6,
    '⭐ ...but a USED one-person link is alive, names the store and still offers the form',
    'ok/Never Co A/needs_approval',
    coalesce(r.status, '-') || '/' || coalesce(r.wholesaler_name, '-') || '/' || coalesce(r.hint, '-'));

  -- =========================================== 2. NO PRICE AFTER THE DOOR ====
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_priced, '03 900 001', 'Priced', 'Priced Shop', 'zzspriced', 'hunter2secret');
  insert into zzs_results values (6, 'the priced link granted access', 'joined', coalesce(r.outcome, '(refused: ' || coalesce(r.msg,'') || ')'));

  v_client := r.client_id;
  v_acct   := r.account_id;

  -- The rate landed on the CUSTOMER, once. That is what makes 122 true.
  select discount_pct into v_price_store from wholesale_v2.v2_clients where id = v_client;
  insert into zzs_results values (7,
    '⭐ the link''s rate was written onto the customer, not kept on the link', '25.00',
    coalesce(v_price_store::text, '(null)'));

  -- ⭐ THE TWO DOORS. Same buyer, same variant, priced through the shelf the
  -- link named and through a different shelf entirely. 122 made p_catalog_id
  -- ignored; this proves it stayed ignored across the whole block.
  v_price_store := wholesale_v2.v2_effective_unit_price(v_prod, v_var, v_client, 1, v_cat_a);
  v_price_link  := wholesale_v2.v2_effective_unit_price(v_prod, v_var, v_client, 1, v_cat_b);
  insert into zzs_results values (8,
    '⭐ the same buyer is quoted the same price through either door', 'same',
    case when v_price_store is not distinct from v_price_link
         then 'same' else v_price_store::text || ' vs ' || v_price_link::text end);

  -- ⭐ A SHARE-LINK TOKEN IS NOT A CATALOGUE TOKEN, and must not become one.
  --
  -- ⚠️ The first draft of this assertion compared v2_token_discount_pct against
  -- the buyer's own rate and demanded they match. That was the gate misreading
  -- the system: v2_token_discount_pct resolves CATALOGUE tokens (#/c/<token>),
  -- a share link is #/j/<token>, and no screen ever passes one to the other. It
  -- returned 0 and the gate called that a defect.
  --
  -- The property that IS worth asserting is the security one, and it is the
  -- stronger statement anyway: a share-link token handed to the catalogue
  -- pricing path must buy nothing. If it ever resolved, the link's 25% would be
  -- readable by anyone holding the token, without redeeming it and without an
  -- account -- which is exactly the 'a door decides the price' shape that
  -- migration 122 exists to prevent.
  insert into zzs_results values (9,
    '⭐ a share-link token buys no discount on the catalogue pricing path', '0',
    wholesale_v2.v2_token_discount_pct(v_t_priced, v_acct)::text);

  -- =============================================== 3. NO REACH ACROSS ========
  -- (a) the catalogue argument. 127's composite FK makes it impossible to
  --     store; 129 turns the violation into a sentence. BOTH are asserted,
  --     because a future rewrite of 129 that dropped the check would still be
  --     caught by the constraint, and vice versa.
  select * into r from wholesale_v2.v2_create_share_link(
    'unlimited', null, null, null, null, v_cat_b, 30, null);
  insert into zzs_results values (10,
    'a link cannot be pointed at another store''s catalogue', 'refused',
    case when r.ok then 'MADE IT ANYWAY' else 'refused' end);

  begin
    insert into wholesale_v2.v2_share_links (wid, kind, catalog_id) values (wA, 'unlimited', v_cat_b);
    insert into zzs_results values (11,
      'and the table refuses it too, with no function in the way', 'refused', 'STORED IT');
  exception when foreign_key_violation then
    insert into zzs_results values (11,
      'and the table refuses it too, with no function in the way', 'refused', 'refused');
  end;

  -- (b) the membership. Redeeming A's link must leave B with nothing.
  select count(*) into n from wholesale_v2.v2_person_memberships where wid = wB;
  insert into zzs_results values (12,
    '⭐ redeeming A''s links gave nobody a membership in B', '0', n::text);
  select count(*) into n from wholesale_v2.v2_clients where wid = wB;
  insert into zzs_results values (13, 'and no client in B', '0', n::text);
  select count(*) into n from wholesale_v2.v2_portal_accounts where wid = wB;
  insert into zzs_results values (14, 'and no login in B', '0', n::text);
  select count(*) into n from wholesale_v2.v2_signup_requests where wid = wB;
  insert into zzs_results values (15, 'and no access request in B', '0', n::text);

  -- ==================== 4. WITHDRAWAL, EXPIRY AND THE CAP ALL END IN NO ======
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_revoked, '03 900 010', 'R', 'R Shop', 'zzsrev', 'hunter2secret');
  insert into zzs_results values (16, 'a withdrawn link cannot be redeemed', 'refused',
    case when r.ok then 'LET THEM IN' else 'refused' end);

  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_expired, '03 900 011', 'E', 'E Shop', 'zzsexp', 'hunter2secret');
  insert into zzs_results values (17, 'an expired link cannot be redeemed', 'refused',
    case when r.ok then 'LET THEM IN' else 'refused' end);

  -- The cap. The capped link's one place is gone; the next person is not turned
  -- away, they are filed. That distinction IS the feature -- Hadi: "either way,
  -- they get access and they are logged in."
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_capped, '03 900 012', 'Over', 'Over Shop', 'zzsover', 'hunter2secret');
  insert into zzs_results values (18, 'the shop after the cap is still signed up', 'yes',
    case when r.ok then 'yes' else 'TURNED AWAY: ' || coalesce(r.msg, '') end);
  insert into zzs_results values (19, '⭐ ...but not into the store', 'requested', coalesce(r.outcome, '(none)'));
  select uses_count into n from wholesale_v2.v2_share_links where token = v_t_capped;
  insert into zzs_results values (20, 'and the cap did not move', '1', n::text);

  -- A used one-person link, redeemed by a DIFFERENT number, is the same story.
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_t_used, '03 900 013', 'Other', 'Other Shop', 'zzsother', 'hunter2secret');
  insert into zzs_results values (21, 'a stranger on a used one-person link is signed up', 'yes',
    case when r.ok then 'yes' else 'TURNED AWAY' end);
  insert into zzs_results values (22, '⭐ ...and filed rather than let in', 'requested', coalesce(r.outcome, '(none)'));
end
$check$;

-- ================================= 5. THE ROW CENSUS, TAKEN FOR REAL ========
-- Every table in the schema, counted before a redemption and after it. The
-- point is the tables NOT named: a redemption that started writing stock, or
-- orders, or another tenant's anything, shows up here as a table that moved
-- and that nobody expected to move.
insert into zzs_census
select 'before', c.relname, (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from wholesale_v2.%I', c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'wholesale_v2' and c.relkind = 'r';

do $census$
declare
  v_tok text; r record;
begin
  insert into wholesale_v2.v2_share_links (wid, kind) values ('zzs01', 'unlimited')
    returning token into v_tok;
  select * into r from wholesale_v2.v2_redeem_share_link(
    v_tok, '03 900 020', 'Census', 'Census Shop', 'zzscensus', 'hunter2secret');
end
$census$;

insert into zzs_census
select 'after', c.relname, (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from wholesale_v2.%I', c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'wholesale_v2' and c.relkind = 'r';

select label, expected, coalesce(got, '(no answer)') as got,
       case when got = expected then 'PASS' else 'FAIL' end as verdict
from (
  select ord, label, expected, got from zzs_results

  -- 22. ⭐ THE CENSUS. The seven tables a redemption is allowed to touch, named
  --     exactly. v2_share_links moves because uses_count is bumped and because
  --     this block inserted the link itself; the rest are LINK-06's rows plus
  --     the person, the credential and the session from 126. Anything else
  --     moving is a redemption doing something nobody designed.
  -- ⚠️ NINE, not the seven the first draft guessed. The three it missed are the
  -- three worth naming: v2_people and v2_person_channels are migration 126's
  -- whole subject (a person on every way in, and the phone that identifies
  -- them), and v2_rate_limit_hits moves because the redemption is rate limited
  -- -- assertion 29. A census written from memory is a census that certifies
  -- whatever the code happens to do; this one was written from memory, went
  -- red, and the red was right.
  union all select 23,
    '⭐ a redemption touched only the tables it was built to touch', 'exactly the nine',
    (select case when moved = 'v2_buyer_sessions, v2_clients, v2_people, v2_person_channels, v2_person_credentials, v2_person_memberships, v2_portal_accounts, v2_rate_limit_hits, v2_share_links'
                 then 'exactly the nine' else 'ALSO: ' || moved end
       from (select string_agg(b.tbl, ', ' order by b.tbl) as moved
               from zzs_census b join zzs_census a on a.tbl = b.tbl and a.phase = 'after'
              where b.phase = 'before' and a.n <> b.n) x)

  -- 23. The redemption is anon-callable BY NECESSITY. Asserting it stays that
  --     way matters as much as the revokes below: a well-meaning lockdown that
  --     revoked it would kill the entire feature silently, and the browser's
  --     error would say nothing about why.
  union all select 24, 'a signed-out stranger may still redeem and peek', 'both',
    (select case count(*) when 2 then 'both' else count(*)::text || ' of 2' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname in ('v2_redeem_share_link', 'v2_share_link_peek')
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 24. ⭐ ...and MAY NOT do anything else this block added. Named as a set
  --     rather than one at a time, so a fifth wholesaler-only function added
  --     next year and granted to anon by accident turns this red without
  --     anybody editing this file.
  union all select 25, '⭐ and may call none of the wholesaler''s own link functions', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname in ('v2_create_share_link', 'v2_revoke_share_link', 'v2_my_share_links')
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 25. The table itself. RLS ON with NO policy fails closed regardless of what
  --     the grants say -- migration 124's lesson, and the reason 127 chose it
  --     over revokes: production carries grant drift that no migration wrote.
  union all select 26, 'the links table is closed to every browser role', 'closed',
    (select case when relrowsecurity
                  and not exists (select 1 from pg_policy pol where pol.polrelid = c.oid)
                 then 'closed' else 'OPEN' end
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wholesale_v2' and c.relname = 'v2_share_links')

  -- 26. ...and no grant sneaked in beside it. Both halves, because either one
  --     alone is a rule with a hole: the grant check misses RLS being turned
  --     off, and the RLS check misses a future policy being added.
  union all select 27, 'and holds no table grant for anon, authenticated or PUBLIC', 'none',
    (select coalesce(string_agg(distinct g.grantee || ':' || g.privilege_type, ', '), 'none')
       from information_schema.role_table_grants g
      where g.table_schema = 'wholesale_v2' and g.table_name = 'v2_share_links'
        and g.grantee in ('anon', 'authenticated', 'PUBLIC'))

  -- 27. Rate limiting, keyed per token, so a link cannot be brute-forced into
  --     telling anybody whether a phone number is already a customer.
  union all select 28, 'redemption is rate limited', 'yes',
    (select case when p.prosrc like '%v2_rate_limit_check%' then 'yes' else 'NO' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link')

  -- 28. ...on the TOKEN. Keyed on anything shared between callers -- an IP, a
  --     constant -- and one busy link locks out every other link on the
  --     platform. Keyed on the phone, and the attacker changes the phone.
  union all select 29, 'and keyed on the token itself', 'yes',
    -- ⚠️ Asserted as "p_token appears inside the key expression", NOT as a
    -- literal prefix. The first draft demanded 'share:' || p_token; 128 writes
    -- 'link|' || coalesce(p_token, ''). The gate was asserting a string I had
    -- invented rather than the property that matters, and would have gone red
    -- on a rename that changed nothing.
    (select case when p.prosrc ~ 'v2_rate_limit_check\([^;]{0,120}p_token' then 'yes'
                 else 'NO -- keyed on something else' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_redeem_share_link')

  -- 29. ⭐ Nothing this block added is callable by a signed-out stranger except
  --     the two named in 23. Written over the whole schema by NAME PREFIX, so
  --     the next share-link function is covered the day it is written.
  union all select 30, '⭐ no other share-link function is open to a stranger', 'none',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2'
        and p.proname like '%share_link%'
        and p.proname not in ('v2_redeem_share_link', 'v2_share_link_peek')
        -- ⚠️ Trigger functions are excluded BY RETURN TYPE, not by name.
        -- v2_share_links_touch (127) returns `trigger` and Postgres grants
        -- EXECUTE on it to PUBLIC by default, so it matched and went red. It
        -- is not reachable: calling one directly raises "trigger functions can
        -- only be called as triggers". Excluding it by NAME would have let a
        -- real function called v2_share_links_touch_v2 through; excluding it by
        -- return type cannot, because a callable function cannot return trigger.
        and p.prorettype <> 'pg_catalog.trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 30. The peek cannot name the invitee. Asserted on the SHIPPED BODY rather
  --     than on a returned row, because a row proves it for one link and this
  --     proves it for every link there will ever be.
  union all select 31, '⭐ the peek cannot name the invitee, whatever the link', 'cannot',
    (select case when p.prosrc ~* 'invitee' then 'READS THE INVITEE' else 'cannot' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'wholesale_v2' and p.proname = 'v2_share_link_peek')
  -- 32. ⭐ THE CAP IS A CONSTRAINT, NOT ONLY A BRANCH -- and this assertion
  --     exists because a sabotage taught it.
  --
  --     Mis-spelling `elsif v_link.kind = 'capped'` in the redemption makes a
  --     capped link behave like an unlimited one. That does NOT reach
  --     assertions 19-21: the UPDATE that bumps uses_count past max_uses
  --     violates 127's v2_share_links_uses_within_cap first, and the whole
  --     gate aborts. Which is the system being right -- the table refuses to
  --     hold a link that let more shops in than it was set to -- and the gate
  --     being incomplete, because it was proving the branch and not the floor
  --     the branch stands on.
  --
  --     (A run that aborts is RED, not silent. The throwaway harness used to
  --     drive these sabotages counted only FAIL rows and called the aborted
  --     run green; checks/run_sql_gates.sh, which has known better since
  --     7 Sep, classified the same database correctly.)
  union all select 32, '⭐ and the cap is a constraint on the table, not only a branch in a function', 'present',
    (select case when count(*) = 1 then 'present' else 'GONE' end
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'wholesale_v2' and t.relname = 'v2_share_links'
        and c.conname = 'v2_share_links_uses_within_cap')
) r
order by ord, label;

rollback;
