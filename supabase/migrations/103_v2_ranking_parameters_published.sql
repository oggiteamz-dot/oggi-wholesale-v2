-- =============================================================================
-- 103 — THE PUBLISHED RANKING PARAMETERS                       SR-05, 30 Aug 2026
-- =============================================================================
--
-- SR-05 is "publish the main ranking parameters, and any own-product
-- preference, in the terms". 102 made the numbers auditable. This makes the
-- numbers READABLE BY THE PEOPLE THEY AFFECT.
--
-- ==== WHY THIS IS A FUNCTION AND NOT A PARAGRAPH ===========================
--
-- The obvious way to publish a ranking policy is to write the numbers into a
-- document. That document is wrong the first time somebody changes a number,
-- and NOTHING WILL SAY SO -- which turns a page written to build trust into a
-- misrepresentation, the single exposure the 28 August research identified as
-- actually reaching a company this size.
--
-- So the page holds the PROSE and the database holds the NUMBERS, and the page
-- reads them live. A published policy that cannot go stale is worth more than
-- a more detailed one that can.
--
-- ==== WHAT IS DELIBERATELY NOT PUBLISHED ===================================
--
-- The `note` column. Those notes are written for us, and they contain things a
-- wholesaler has no business reading -- popular_min_buyers' own note explains
-- that 3 "is a starting guess for a market with 3 buyers in it", which
-- publishes our buyer count to every supplier on the platform.
--
-- The public explanation of each parameter lives in js/views/ranking-policy.js
-- instead, where it is reviewable in a diff and written for the audience.
-- The Commission's own guidance on this kind of disclosure is that "an excess
-- of information can mean that, in effect, no meaningful information is
-- provided" -- so the split is not laziness, it is the point.
-- =============================================================================

-- Every key, and only the value. Adding a column to the return type publishes
-- it to every wholesaler on the platform, so the columns are written out rather
-- than selected with *, and assertion 2 below reads the function's declared
-- OUTPUT COLUMNS rather than grepping its source.
--
-- (The first draft of that assertion grepped for the word "note" and fired on
-- this very comment block, which is the whole argument for asserting on shape
-- instead of on text -- the same mistake that once reported a feature as
-- present because the match was inside a git hook sample.)
create or replace function wholesale_v2.v2_ranking_parameters_published()
returns table (key text, int_value integer, text_value text)
language sql stable
security definer
set search_path = wholesale_v2, public
as $fn$
  select c.key, c.int_value, c.text_value
    from wholesale_v2.v2_ranking_config c
   order by c.key;
$fn$;

comment on function wholesale_v2.v2_ranking_parameters_published() is
  'SR-05. The ranking numbers as they stand right now, for the published ranking policy to read. Deliberately excludes the internal note column, which explains our reasoning to us and in one case would publish our buyer count. Readable by any signed-in account -- these are the numbers we have chosen to publish, and hiding them from the people they affect would defeat the purpose.';

revoke all on function wholesale_v2.v2_ranking_parameters_published() from public;
-- Wholesalers and buyers both. A ranking policy that only the owner can read is
-- not a published ranking policy.
grant execute on function wholesale_v2.v2_ranking_parameters_published() to authenticated;
grant execute on function wholesale_v2.v2_ranking_parameters_published() to anon;

-- =============================================================================
-- SELF-ASSERTING. Holds on an EMPTY database as well as a full one.
-- =============================================================================
do $$
declare n int; src text;
begin
  -- 1. It returns the same number of rows as there are parameters -- stated as a
  --    relationship so it is true of eight and true of none.
  select count(*) into n from wholesale_v2.v2_ranking_parameters_published();
  if n <> (select count(*) from wholesale_v2.v2_ranking_config) then
    raise exception 'ASSERT 1 FAILED: the published parameters do not match the parameters (% published)', n;
  end if;

  -- 2. IT DOES NOT PUBLISH THE NOTES. Asserted against the function's DECLARED
  --    OUTPUT COLUMNS, not its source text: a grep for the word "note" matches
  --    a comment explaining that the note is excluded, which is exactly the
  --    class of false positive that has already cost this project a day.
  select pg_get_function_result(p.oid) into src
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='wholesale_v2' and p.proname='v2_ranking_parameters_published';
  if src ~* '\mnote\M' then
    raise exception 'ASSERT 2 FAILED: the published parameters RETURN the internal note -- one of those notes states our buyer count. Signature: %', src;
  end if;
  if src !~* '\mkey\M' or src !~* 'int_value' or src !~* 'text_value' then
    raise exception 'ASSERT 2 FAILED: the published parameters no longer return key/int_value/text_value. Signature: %', src;
  end if;
  -- Three columns, exactly. A fourth is a disclosure decision and must be a
  -- deliberate edit to this assertion, not a quiet addition upstream.
  if (length(src) - length(replace(src, ',', ''))) <> 2 then
    raise exception 'ASSERT 2 FAILED: the published parameters return something other than exactly three columns. Signature: %', src;
  end if;

  -- 3. It is genuinely readable by a signed-in account. A policy only the owner
  --    can read is not published, and this is the assertion that would catch it
  --    being quietly gated later.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema='wholesale_v2' and grantee='authenticated'
     and routine_name='v2_ranking_parameters_published';
  if n = 0 then
    raise exception 'ASSERT 3 FAILED: signed-in accounts cannot read the published ranking parameters';
  end if;

  -- 4. And it still holds NO table key. The function is the door; the table
  --    stays shut, so a later change to what is published is a change to one
  --    function and not a permission nobody remembers granting.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='wholesale_v2' and table_name='v2_ranking_config'
     and grantee in ('anon','authenticated','PUBLIC');
  if n <> 0 then
    raise exception 'ASSERT 4 FAILED: the browser roles hold % direct grant(s) on the ranking config', n;
  end if;

  raise notice '103 OK: the ranking numbers are readable by the people they affect, without the notes that were written for us.';
end $$;
