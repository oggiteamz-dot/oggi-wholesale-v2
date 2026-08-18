-- =============================================================================
-- 040 — V2 PRODUCT IMAGE STORAGE  (regression #10)
-- =============================================================================
--
-- WHAT WAS MISSING
-- ----------------
-- v2 has no image upload path at all. Regression ledger #10: `grep` for
-- `storage.from(` / `.upload(` across js/ returns ZERO matches. v2 accepts
-- pasted image URLs only, by its own admission (wholesaler.js:388-396), while
-- v1 uploaded up to 50 photos per product to a bucket.
--
-- This is the storage half of fixing that. It is deliberately the FIRST thing
-- built in the wholesaler lane, because a product editor with no way to add a
-- photo is not worth shipping.
--
-- WHY A NEW BUCKET INSTEAD OF REUSING product-img
-- -----------------------------------------------
-- `product-img` already exists from v1 and holds 2 objects under
-- `products/<wid>/…`. Its policies were inspected before writing a single line
-- of upload code, and they are:
--
--     product-img authenticated insert   WITH CHECK (bucket_id = 'product-img')
--     product-img authenticated update   USING/CHECK (bucket_id = 'product-img')
--
-- There is NO PATH SCOPING. Any authenticated user -- meaning any wholesaler --
-- can write or overwrite ANY object in that bucket, including another
-- wholesaler's product photos. That has never been exploited for the simple
-- reason that v2 never uploads anything, but the moment an upload path exists
-- it becomes a live cross-tenant write.
--
-- Fixing it in place would mean dropping v1's policies, and v1 is running in
-- production at oggi-wholesale.oggi-teamz.workers.dev. Changing the storage
-- rules underneath a live app to enable a v2 feature is the kind of trade this
-- build does not make.
--
-- So v2 gets its own bucket, correct from the first byte. This is the same
-- decision already taken for the database: v2 lives in the `wholesale_v2`
-- schema rather than sharing `public` with v1 -- real structural isolation
-- instead of a shared surface and a naming convention.
--
-- ⚠️ v1's two problems are RECORDED, NOT FIXED, and are out of scope here:
--    1. product-img insert/update are unscoped, as above.
--    2. `order-voice anon insert` lets ANONYMOUS callers write to that bucket
--       with no scoping whatsoever -- anyone on the internet can upload
--       unlimited files to it. That is an abuse/cost vector, not a data leak,
--       but it is real.
--
-- THE PATH CONVENTION, AND WHY THE WID IS FIRST
-- ---------------------------------------------
--     <wid>/<product_id>/<uuid>.<ext>
--
-- v1 used `products/<wid>/…`, which puts the tenant in the SECOND segment.
-- Scoping on segment two works but reads badly and invites an off-by-one the
-- day someone adds a folder. Here the tenant is segment one, so the policy is
-- literally "the first folder must be your own wid" -- hard to get wrong, and
-- obvious to anyone reading it later.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The bucket.
-- public = true is correct and deliberate: these are product photos shown to
-- buyers, served straight from the CDN with no signed-URL round trip on a
-- 43.9 Mbps connection. It does mean anyone holding a URL can view that image,
-- which is the same posture as every e-commerce image host. Nothing private
-- may ever be put in this bucket.
--
-- The size limit and MIME allow-list are enforced SERVER-SIDE on purpose. The
-- client will also downscale before uploading, but a client-side limit is a
-- courtesy, not a control -- anyone can call the storage API directly with the
-- publishable key.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'v2-product-img', 'v2-product-img', true,
  5242880,  -- 5 MB. Generous after client-side downscale; a hard stop on a
            -- 40 MB phone photo being pushed straight through.
  array['image/jpeg','image/png','image/webp','image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Policies. Dropped first so this migration is re-runnable.
-- -----------------------------------------------------------------------------
drop policy if exists v2_product_img_read   on storage.objects;
drop policy if exists v2_product_img_insert on storage.objects;
drop policy if exists v2_product_img_update on storage.objects;
drop policy if exists v2_product_img_delete on storage.objects;

-- READ: the bucket is public, so the CDN serves these regardless. The policy
-- exists for the authenticated API path and so the intent is written down
-- rather than implied by a bucket flag someone might later toggle.
create policy v2_product_img_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'v2-product-img');

-- WRITE: your own folder only.
--
-- (storage.foldername(name))[1] is the first path segment. The wholesaler's own
-- wid comes from v2_my_wid(), which derives it from auth.uid() -- so it cannot
-- be spoofed by the client; there is no wid parameter to tamper with.
--
-- The owner is allowed to write anywhere in this bucket, because onboarding a
-- wholesaler and fixing a bad image on their behalf are both real jobs.
create policy v2_product_img_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'v2-product-img'
    and (
      (storage.foldername(name))[1] = wholesale_v2.v2_my_wid()
      or wholesale_v2.v2_is_owner()
    )
  );

create policy v2_product_img_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'v2-product-img'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  )
  with check (
    bucket_id = 'v2-product-img'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  );

-- DELETE matters more than it looks. product-img has NO delete policy at all,
-- so nothing in it can ever be removed and it grows forever. A wholesaler who
-- uploads the wrong photo must be able to take it down -- and only their own.
create policy v2_product_img_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'v2-product-img'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  );
