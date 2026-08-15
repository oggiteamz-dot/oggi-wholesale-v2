-- Back-filled 15 Aug 2026 from the live database (project olaipgdckbgjediddloj).
-- Applied live 2026-08-15 (schema_migrations version 20260815153741,
-- name "v2_tenant_isolation_cost_column_grants"); never previously saved as a
-- repo file. Exported verbatim so the repo can rebuild the database from scratch.

-- Migration 032: actually close the cost leak.
--
-- Migration 031 revoked SELECT on the `cost` COLUMN, and it made no
-- difference: verified immediately afterwards, the anon role still read a cost
-- of 13.00. The reason is a Postgres rule worth writing down, because it is
-- exactly the kind of thing that makes a security fix look applied when it is
-- not: a TABLE-level GRANT SELECT already permits every column, and a
-- column-level REVOKE does not carve an exception out of it. Column privileges
-- only take effect when there is no table-level privilege to fall back on.
--
-- So: drop the table-level grant for anon and grant back an explicit list of
-- safe columns. Anything omitted here is unreadable by the public, and any
-- column added to this table in future is unreadable by default -- which is
-- the correct direction for a mistake to fail in.
--
-- `authenticated` keeps table-level SELECT, because migration 031 scoped the
-- row policy for logged-in users to their own wholesaler. A wholesaler cannot
-- read another wholesaler's rows at all, so their costs are unreachable that
-- way, and the existing admin tooling (inventory, reorder, landed cost,
-- barcode receiving) keeps working without a rewrite.

revoke select on wholesale_v2.v2_product_variants from anon;

-- Safe for a buyer browsing a catalogue. Note what is NOT here: cost,
-- reorder_point, reorder_qty and lead_time_days are the wholesaler's internal
-- operating numbers and no buyer needs any of them.
grant select (
  id, product_id, sku, price, compare_at_price, retail_price,
  extra_attrs, moq_qty, barcode, image_url, images,
  archived, created_at, updated_at
) on wholesale_v2.v2_product_variants to anon;
