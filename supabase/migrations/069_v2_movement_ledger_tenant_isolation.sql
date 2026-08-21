-- =====================================================================
-- 069 — The stock movement ledger was readable by anyone
--
-- FOUND while starting Batch 2, whose whole job is to put this table on
-- screen. Surfacing a table is the moment its read policy matters most,
-- so the first thing Batch 2 did was look at the policy.
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------
--   policy v2_inventory_movements_read ... using (true)
--
-- RLS was ENABLED, which is what makes this the dangerous kind of wrong:
-- every dashboard and every audit that asks "is RLS on?" answered yes.
-- The policy underneath it permitted everything. A gate that is switched
-- on and lets everyone through.
--
-- PROVEN ON PRODUCTION, 21 Aug 2026, from a browser holding nothing but
-- the publishable key that ships inside the client JavaScript:
--
--   236 movement rows       readable anonymously
--   137 product variants    resolvable anonymously
--   attributable to ALL SIX wholesalers: demo, mg, omni, sq, test,
--                                        w1785168930020
--
-- And from SQL, as the authenticated wholesaler "test":
--   sees 236 rows, owns 3.
--
-- What leaked is not incidental. The movement ledger is the most
-- commercially sensitive table in the system: exactly what each
-- wholesaler received, when, in what quantity, what sold, what was
-- written off, and the free-text note explaining why. A competitor with
-- the public key could read a rival's entire restocking cadence and
-- sales volume. In a market this small, that is the business.
--
-- THE FIX, AT TWO LEVELS
-- ---------------------------------------------------------------------
-- 1. GRANT level: anon loses SELECT outright. No buyer path reads this
--    table -- verified, the only two readers are
--    js/data/landed-cost.js and js/data/inventory-intelligence.js, both
--    wholesaler screens. Column and table privileges are checked BEFORE
--    row policies, so this holds even if a policy is loosened again
--    later. Migration 031 wrote the principle down: "defence that does
--    not depend on the next person getting RLS right."
--
-- 2. POLICY level: a movement is visible to the wholesaler who owns the
--    variant it moved, and to an owner. Nobody else.
--
-- WHY THE GATE ALSO ASSERTS THE POSITIVE
-- ---------------------------------------------------------------------
-- checks/check_movement_ledger.sql asserts BOTH directions: that a
-- stranger sees zero rows, AND that the owning wholesaler still sees
-- their own. A policy of `using (false)` would pass any leak test ever
-- written while silently destroying the ledger Batch 2 exists to
-- display. Same trap as v2_live_holds in 064, where adding
-- security_invoker would have reported zero holds to a buyer and let
-- them oversell -- a "safer" setting that breaks correctness.
--
-- PERFORMANCE
-- ---------------------------------------------------------------------
-- The EXISTS resolves variant -> product -> wid. idx_v2_movements_variant_loc
-- already indexes variant_id, and v2_product_variants/v2_products are
-- keyed by id, so this is an index lookup per row rather than a scan.
-- =====================================================================

-- 1. Anon has no business here at all.
revoke select on wholesale_v2.v2_inventory_movements from anon;

-- 2. Scope the row policy to the owning wholesaler.
drop policy if exists v2_inventory_movements_read on wholesale_v2.v2_inventory_movements;
create policy v2_inventory_movements_read on wholesale_v2.v2_inventory_movements
  for select using (
    wholesale_v2.v2_is_owner()
    or exists (
      select 1
        from wholesale_v2.v2_product_variants v
        join wholesale_v2.v2_products p on p.id = v.product_id
       where v.id = v2_inventory_movements.variant_id
         and p.wid = wholesale_v2.v2_my_wid()
    )
  );

comment on table wholesale_v2.v2_inventory_movements is
  'Append-only stock ledger. Migration 069 scoped its read policy to the '
  'owning wholesaler after finding it shipped as using(true) -- 236 rows '
  'across all six wholesalers were readable anonymously with the publishable '
  'key. anon has no SELECT grant on this table; no buyer path reads it.';
