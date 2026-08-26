-- ============================================================================
-- 085 — Batch S / S7: THE REVOKE.  anon loses every table in the schema.
--
-- S1–S5 moved every read the buyer app makes onto a SECURITY DEFINER function
-- that checks the share token or the validated portal account first. This
-- migration is the other half: it takes away the door those functions were
-- built to replace. Until it runs, the gated functions are a politeness — the
-- tables are still there for anyone who opens dev tools.
--
-- ---------------------------------------------------------------------------
-- THE ROOT CAUSE, WHICH IS NOT WHAT S0 LOOKED LIKE
-- ---------------------------------------------------------------------------
-- check_anon_scope.sh reported seven leaking tables, which reads like seven
-- forgotten GRANT statements. It is not. Grep the whole migration folder and
-- you will not find a single `grant select on v2_products to anon`. The repo
-- never granted them. This did, once, in 2026:
--
--   026_v2_move_to_dedicated_schema.sql:173
--     alter default privileges in schema wholesale_v2
--       grant select, insert, update, delete on tables to anon, authenticated;
--
-- That is a standing rule, not a grant. Every table created in this schema
-- since then has arrived readable AND writable by a signed-out stranger, on
-- its first day, before anyone wrote a policy for it. v2_products,
-- v2_product_variants, v2_pack_definitions, v2_pack_components,
-- v2_inventory_balances and the two inventory views were never opened by
-- anybody -- they were born open.
--
-- Which is why this migration does two separate things, and why doing only
-- the first would be worse than useless:
--
--   1. revoke what is open today   (the loop -- fixes the seven)
--   2. revoke the rule that opens it  (the default privileges -- fixes the
--                                      eighth table, the one nobody has
--                                      written yet)
--
-- Without (2), the next migration that says `create table` re-opens the leak
-- silently, this file's own gate goes green, and nobody finds out until the
-- next audit. A parameter you can change is a parameter someone will change;
-- a rule that opens tables is a rule that will open the next table.
--
-- ---------------------------------------------------------------------------
-- WHY `authenticated` IS LEFT ENTIRELY ALONE
-- ---------------------------------------------------------------------------
-- Wholesalers and owners sign in through Supabase Auth (dev-auth.js ->
-- supabase.auth.signInWithPassword), so they are the `authenticated` role and
-- auth.uid() is a real value for them. Their RLS policies work, scoping them
-- to their own wid, and every admin screen -- products, inventory, pricing,
-- picking, locations -- reads these tables directly. Revoking `authenticated`
-- would break the entire wholesaler app in exchange for nothing: the policies
-- already do that job. Buyers and sales reps are the ones who log in through
-- v2_buyer_login / v2_sales_login, get no Supabase session, and therefore run
-- as `anon` with auth.uid() null -- which is the whole reason those same
-- policies evaluate false for them and the tables have to be closed by grant
-- instead of by policy.
--
-- ---------------------------------------------------------------------------
-- WHY WRITES GO TOO, NOT JUST SELECT
-- ---------------------------------------------------------------------------
-- anon also holds INSERT, UPDATE and DELETE on these tables. RLS blocks them
-- today, so nothing is exploitable this minute. But they came from the same
-- standing rule as the reads, and the failure mode is identical: a table
-- shipped one migration before its policy is a table a stranger can write.
-- Every write the buyer and sales apps actually perform goes through a
-- SECURITY DEFINER function (v2_submit_order, v2_reserve_stock,
-- v2_release_reservation -- all prosecdef = true, verified), which executes as
-- the function owner and does not consult anon's grants at all. So there is
-- nothing to break.
--
-- ---------------------------------------------------------------------------
-- WHAT anon STILL HAS AFTERWARDS, AND WHY THAT IS ENOUGH
-- ---------------------------------------------------------------------------
--   usage on schema wholesale_v2   -- PostgREST cannot resolve an RPC without
--                                     it. Re-asserted below rather than
--                                     assumed.
--   execute on the gated functions -- v2_catalog_read, v2_buyer_catalog_read,
--                                     v2_catalog_packs, v2_buyer_*, the login
--                                     RPCs, the order path. Each one checks a
--                                     share token or a validated portal
--                                     account before it returns a row.
--
-- Every buyer-path read was traced before this was written. All eight modules
-- the buyer view imports (catalog, catalogs, prepacks, orders, pricing, cart,
-- line-pricing, catalog-filter) now reach the database only through .rpc().
-- The single remaining direct table read in the buyer view's dependency tree,
-- pricing.js -> resolveClientId(), has had both of its call sites removed.
--
-- ---------------------------------------------------------------------------
-- THE ONE FUNCTION THAT LOSES EXECUTE
-- ---------------------------------------------------------------------------
-- v2_catalog_discount_pct(uuid, uuid) took a catalogue id and a client id from
-- the caller and answered with a real discount percentage, to anyone, signed
-- out. It is also an existence oracle: a real id answers 0.00, an invented one
-- answers 0. Its two gated replacements -- v2_buyer_discount_pct(account,
-- catalog) and v2_token_discount_pct(token, account), both added in 083 --
-- resolve the ids in the database from a credential the caller had to prove,
-- then delegate to this same function, so the arithmetic stays in one place
-- and only the door moves. `authenticated` keeps EXECUTE: the wholesaler's own
-- pricing screens call it, and they are allowed to know their own discounts.
--
-- PAIR THIS WITH: checks/check_anon_scope.sh (S9, must go GREEN) and the buyer
-- path proof (S8). This migration can only prove the door is shut. It cannot
-- tell a shut door from a shut shop, and the two must always be read together.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Everything that is open today.
--
-- A DO loop rather than a list of table names, for three reasons: production
-- carries grants the repo never wrote (see above), so a list drawn from the
-- migrations would miss exactly the tables that leak; relkind covers views and
-- matviews, and two of the seven leaks are views; and a plain table-level
-- `revoke select` also clears COLUMN-level grants (verified on 16.13), which
-- matters because v2_product_variants has no table-level SELECT at all -- 032
-- revoked it and granted fourteen columns back instead, so a naive revoke
-- would have looked like it worked and changed nothing.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as obj
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2'
       and c.relkind in ('r','p','v','m','f')
  loop
    execute format('revoke all privileges on %s from anon', r.obj);
  end loop;
end $$;

-- Sequences too. anon never needs one: every insert it can cause happens
-- inside a definer function, which burns the sequence as the function owner.
do $$
declare r record;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as obj
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2' and c.relkind = 'S'
  loop
    execute format('revoke all privileges on sequence %s from anon', r.obj);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The rule that opens the next one. This is the half that matters in six
--    months. Note it is scoped `for role postgres` implicitly -- default
--    privileges belong to the creating role, and pg_default_acl on this
--    project shows postgres as the grantor for both entries.
-- ---------------------------------------------------------------------------
alter default privileges in schema wholesale_v2
  revoke select, insert, update, delete on tables from anon;

alter default privileges in schema wholesale_v2
  revoke usage, select on sequences from anon;

-- ---------------------------------------------------------------------------
-- 3. What anon keeps.
-- ---------------------------------------------------------------------------
grant usage on schema wholesale_v2 to anon;

-- ---------------------------------------------------------------------------
-- 4. The ungated discount oracle.
-- ---------------------------------------------------------------------------
revoke execute on function wholesale_v2.v2_catalog_discount_pct(uuid, uuid) from anon;

-- ---------------------------------------------------------------------------
-- 5. Prove it, in the same transaction that did it.
--
-- A migration that reports success because no statement raised has proved
-- nothing -- REVOKE on a privilege you never held is a silent no-op, and that
-- is the exact shape of a fix that did not land. These blocks re-read the
-- catalog and raise if anything survived.
-- ---------------------------------------------------------------------------
do $$
declare
  leftover text;
begin
  -- Two catalogs, not one. A table-level grant lands in pg_class.relacl; a
  -- COLUMN-level grant lands in pg_attribute.attacl and is INVISIBLE to
  -- relacl. That is not a hypothetical: 032 revoked table SELECT on
  -- v2_product_variants and granted fourteen columns back instead, so a check
  -- that reads only relacl would have called this schema clean while every
  -- price, sku and barcode was still readable by a stranger. It was written
  -- that way first, and only a deliberate `grant select (price) ... to anon`
  -- against a passing database exposed it.
  select string_agg(x.label, ', ' order by x.label) into leftover from (
    select format('%s(%s)', c.relname, c.relacl::text) as label
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2'
       and c.relkind in ('r','p','v','m','f','S')
       and c.relacl::text like '%anon=%'
    union all
    select format('%s.%s [column] (%s)', c.relname, a.attname, a.attacl::text)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'wholesale_v2'
       and a.attnum > 0 and not a.attisdropped
       and a.attacl::text like '%anon=%'
  ) x;

  if leftover is not null then
    raise exception 'S7 DID NOT LAND: anon still holds privileges on %', leftover;
  end if;
end $$;

-- PUBLIC is anon's back door: a grant to PUBLIC is a grant to every role,
-- including anon, and it does not show up as `anon=` in relacl. This project
-- has none today. If production has one, this migration must NOT report
-- success -- but it must not revoke it blind either, because `authenticated`
-- may be leaning on the same grant and the wholesaler app would go dark.
-- Raise, and let a human decide.
do $$
declare
  leftover text;
begin
  select string_agg(c.relname || ' ' || c.relacl::text, ', ' order by c.relname)
    into leftover
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'wholesale_v2'
     and c.relkind in ('r','p','v','m','f','S')
     and c.relacl::text ~ '(^\{|,)=[a-zA-Z]+/';

  if leftover is not null then
    raise exception 'S7 INCOMPLETE: these objects are granted to PUBLIC, which reaches anon: %', leftover;
  end if;
end $$;

do $$
declare
  leftover text;
begin
  select string_agg(d.defaclobjtype::text || ':' || d.defaclacl::text, ', ')
    into leftover
    from pg_default_acl d
   where d.defaclnamespace = 'wholesale_v2'::regnamespace
     and d.defaclacl::text like '%anon=%';

  if leftover is not null then
    raise exception 'S7 DID NOT LAND: the default privileges still open new objects to anon: %', leftover;
  end if;
end $$;

do $$
begin
  if has_function_privilege('anon', 'wholesale_v2.v2_catalog_discount_pct(uuid, uuid)', 'execute') then
    raise exception 'S7 DID NOT LAND: anon can still execute the ungated v2_catalog_discount_pct';
  end if;

  -- and the other direction: the gated replacements must still be reachable,
  -- or S7 has shut the shop rather than the door.
  if not has_function_privilege('anon', 'wholesale_v2.v2_buyer_discount_pct(uuid, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_token_discount_pct(text, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_catalog_read(text, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_buyer_catalog_read(uuid, uuid)', 'execute')
     or not has_function_privilege('anon', 'wholesale_v2.v2_buyer_list_prices(uuid, uuid[])', 'execute')
  then
    raise exception 'S7 OVERSHOT: a gated buyer function is no longer executable by anon';
  end if;
end $$;

comment on schema wholesale_v2 is
  'Batch S/S7 (085): anon holds USAGE and EXECUTE on gated functions only -- no table, view or sequence privileges, and no default privileges that would grant them to a new object. Buyers and sales reps run as anon because their login RPCs create no Supabase session, so RLS cannot scope them; the grant is the only lock they have. Do not re-add anon table grants.';
