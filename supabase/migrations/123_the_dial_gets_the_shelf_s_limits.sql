-- 123 — the store dial gets the same limits the shelf always had
--
-- HADI, 7 Sep 2026, asked what the limit should be:
--   "I guess... yes. I don't know what the dial is and what... what's the
--    right limit for it."
--
-- WHAT THE DIAL IS, in one sentence: it is the one discount a whole store
-- gives, and since migration 122 it is the ONLY discount a store gives --
-- the shelf a buyer arrived through no longer contributes anything.
--
-- WHAT THE RIGHT LIMIT IS: the one the shelf already had. The dial is not a
-- new kind of number, it is the replacement for v2_catalogs.discount_pct, and
-- that column has been constrained to -100..100 since v2_catalogs_discount_range
-- was written. Giving the replacement a DIFFERENT range would mean a rate that
-- was refused on a shelf yesterday is accepted on the dial today -- the fix
-- creating the hole. So: the same numbers, and the same constraint shape, so
-- the two read identically to anyone comparing them later.
--
--   100  = free. The floor in v2_effective_unit_price already refuses to go
--          below 0.00, so 100 is where the arithmetic stops meaning anything
--          new, not an arbitrary cap.
--  -100  = double list price. A negative rate is a MARKUP, which the platform
--          has always allowed (checks/check_buyer_pricing.sql documents a live
--          -5.00 shelf), and -100 is the mirror of 100 rather than a judgement
--          about how large a markup is reasonable.
--
-- WHY THIS IS URGENT NOW AND WAS NOT BEFORE
-- Migration 117 added v2_wholesalers.discount_pct and constrained only
-- discount_mode; the PERCENTAGE was left unbounded. That cost nothing while
-- nothing read it. Migration 122 made it the number that prices every order in
-- the store, so a fat-fingered 500 is now one keypress from every invoice with
-- no check between it and the customer. checks/check_discount_stacking.sql
-- assertion 17 has been asserting that hole as today's truth since MOD-06 and
-- says in its own comment to invert when this lands. It is inverted in the
-- same commit as this file.
--
-- v2_clients.discount_pct IS FIXED IN THE SAME BREATH, and for the same
-- reason: it is the other half of the sum. Bounding one and not the other
-- leaves the total just as reachable, and it too has never been checked.
--
-- MEASURED ON PRODUCTION BEFORE APPLYING, 7 Sep 2026:
--   v2_wholesalers  13 rows, 0 null, min 0.00, max  0.00, 0 out of range
--   v2_clients      59 rows, 0 null, min 0.00, max 15.00, 0 out of range
-- So no row is rewritten and nothing is refused that is in use today. The
-- constraints validate immediately rather than NOT VALID, because a NOT VALID
-- constraint is a constraint that has not actually been checked.

alter table wholesale_v2.v2_wholesalers
  add constraint v2_wholesalers_discount_range
  check (discount_pct >= -100 and discount_pct <= 100);

alter table wholesale_v2.v2_clients
  add constraint v2_clients_discount_range
  check (discount_pct >= -100 and discount_pct <= 100);

comment on constraint v2_wholesalers_discount_range on wholesale_v2.v2_wholesalers is
  'The store dial, -100..100, deliberately identical to v2_catalogs_discount_range: '
  'since 122 the dial is what the shelf used to be, so it takes the shelf''s limits.';

comment on constraint v2_clients_discount_range on wholesale_v2.v2_clients is
  'A customer''s own rate, -100..100. The other half of the sum the dial belongs to.';

-- ⚠ WHAT THIS DOES **NOT** BOUND, said plainly rather than left to be
-- discovered. In 'combine' mode the rate is store + customer, so 100 + 100 is
-- reachable as 200, and -100 + -100 as -200 (triple list price). Two things
-- make that survivable and neither is this constraint:
--   * v2_effective_unit_price clamps the PRICE with greatest(..., 0), so an
--     over-100 total bills 0.00 rather than a negative number, and
--   * the shelf model had exactly this property for its whole life and it has
--     never been reported.
-- Bounding the SUM would need a trigger on two tables and would refuse edits
-- in an order-dependent way -- set the customer first and the store edit is
-- refused, set the store first and the customer edit is. That is a worse
-- screen than an over-generous total, so it is recorded here as a known,
-- chosen limit rather than fixed. check_discount_stacking assertion 17c
-- asserts the sum IS reachable, so the day somebody decides otherwise the
-- gate tells them this paragraph exists.

do $$
declare v_n int;
begin
  select count(*) into v_n from pg_constraint
   where conname in ('v2_wholesalers_discount_range','v2_clients_discount_range')
     and convalidated;
  if v_n <> 2 then
    raise exception '123: expected 2 validated discount-range constraints, found %', v_n;
  end if;
  raise notice '123 ok: the dial and the customer rate are both bounded to -100..100, both validated';
end $$;
