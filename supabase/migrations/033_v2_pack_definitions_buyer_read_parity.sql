-- Migration 033 — v2_pack_definitions buyer read parity
-- Applied live 15 Aug 2026 (Supabase project olaipgdckbgjediddloj).
--
-- WHY THIS EXISTS
-- The first real buyer walkthrough of v2 found that EVERY pack-based product
-- (series / prepack / ratio) showed "no bundles set up yet" and could not be
-- ordered, even though the pack definition and its 16 components existed and
-- were correct in the data.
--
-- ROOT CAUSE
-- Buyers authenticate through the v2_buyer_login RPC (a custom session), NOT
-- through Supabase Auth, so for a buyer auth.uid() is NULL and v2_my_wid()
-- returns NULL. v2_products/v2_product_variants grant read to that case with
-- an explicit "(auth.uid() IS NULL)" clause. v2_pack_definitions was written
-- WITHOUT it, so for a buyer the policy evaluated to false for every row.
-- Pack components were already world-readable, so the catalogue saw components
-- with no parent pack and concluded "no bundles set up." Invisible to static
-- verification because it only appears for the buyer role, never exercised by
-- a human until this walkthrough.
--
-- THE FIX
-- Give v2_pack_definitions the SAME read visibility v2_products already has:
-- split the single ALL policy into read + scoped-write policies mirroring
-- v2_products. Reads add the anon clause; writes stay owner/wholesaler-scoped
-- (verified: anon still cannot INSERT).

alter table wholesale_v2.v2_pack_definitions enable row level security;

drop policy if exists v2_pack_definitions_scoped on wholesale_v2.v2_pack_definitions;

create policy v2_pack_definitions_read
  on wholesale_v2.v2_pack_definitions
  for select
  using ( (auth.uid() is null) or wholesale_v2.v2_is_owner() or (wid = wholesale_v2.v2_my_wid()) );

create policy v2_pack_definitions_write_scoped
  on wholesale_v2.v2_pack_definitions
  for insert
  with check ( wholesale_v2.v2_is_owner() or (wid = wholesale_v2.v2_my_wid()) );

create policy v2_pack_definitions_update_scoped
  on wholesale_v2.v2_pack_definitions
  for update
  using ( wholesale_v2.v2_is_owner() or (wid = wholesale_v2.v2_my_wid()) )
  with check ( wholesale_v2.v2_is_owner() or (wid = wholesale_v2.v2_my_wid()) );

create policy v2_pack_definitions_delete_scoped
  on wholesale_v2.v2_pack_definitions
  for delete
  using ( wholesale_v2.v2_is_owner() or (wid = wholesale_v2.v2_my_wid()) );
