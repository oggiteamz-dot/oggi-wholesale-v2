-- =============================================================================
-- 058 — THE BILLBOARD CAN BE A GIF OR A VIDEO
-- =============================================================================
-- 19 Aug 2026. Hadi, mid-build: "they might choose to put in a video or a GIF
-- for the billboard."
--
-- That is not a small addition, for two reasons neither of which is obvious:
--
-- 1. THE EXISTING UPLOAD PATH WOULD HAVE SILENTLY KILLED A GIF.
--    uploadProductImage() runs every file through downscaleImage(), which draws
--    it onto a canvas -- and a canvas has exactly one frame. An animated GIF
--    would have arrived as a still of its first frame, with the upload
--    reporting success. See js/data/uploads.js uploadCatalogBillboard(), which
--    downscales stills and uploads GIFs and video untouched.
--
-- 2. THE EXISTING BUCKET WOULD HAVE REFUSED BOTH.
--    v2-product-img is 5 MB and allows four still image types. Widening it to
--    accept video/mp4 at 25 MB would mean any PRODUCT PHOTO could become a
--    25 MB video by accident -- a change to a path used on every product in the
--    app, to serve one feature on one screen. So the billboard gets its own
--    bucket, and the limits stay meaningful in both places.
--
-- media type is STORED rather than guessed from the file extension. A URL is
-- not a reliable statement about what a file contains, and picking the wrong
-- element (<img> for a video, <video> for a GIF) renders nothing at all.
-- =============================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_catalogs
  add column if not exists billboard_media_type text not null default 'image';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_catalogs_billboard_media_known') then
    alter table wholesale_v2.v2_catalogs
      add constraint v2_catalogs_billboard_media_known
      check (billboard_media_type in ('image', 'video'));
  end if;
end $$;

comment on column wholesale_v2.v2_catalogs.billboard_media_type is
  'image (including an animated GIF, which is still an <img>) or video (<video> autoplay muted loop). Stored rather than guessed from the file extension: a URL is not a reliable statement about what a file contains, and picking the wrong element renders nothing at all.';

grant select (billboard_media_type) on wholesale_v2.v2_catalogs to authenticated;
grant insert (billboard_media_type) on wholesale_v2.v2_catalogs to authenticated;
grant update (billboard_media_type) on wholesale_v2.v2_catalogs to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'v2-catalog-billboard', 'v2-catalog-billboard', true,
  26214400,   -- 25 MB. A short looping clip fits; a feature film does not.
  array['image/jpeg','image/png','image/webp','image/avif','image/gif','video/mp4','video/webm']
)
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = excluded.public;

-- Same shape as v2-product-img's policies (migration 040): the first path
-- segment is the wid, and v2_my_wid() derives it from auth.uid(), so there is
-- no wid parameter for a client to tamper with.
drop policy if exists v2_billboard_read on storage.objects;
create policy v2_billboard_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'v2-catalog-billboard');

drop policy if exists v2_billboard_insert on storage.objects;
create policy v2_billboard_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'v2-catalog-billboard'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  );

drop policy if exists v2_billboard_update on storage.objects;
create policy v2_billboard_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'v2-catalog-billboard'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  )
  with check (
    bucket_id = 'v2-catalog-billboard'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  );

-- Replacing a billboard leaves the old file behind, and a 25 MB orphan is
-- worth more than a 200 KB one. Only their own.
drop policy if exists v2_billboard_delete on storage.objects;
create policy v2_billboard_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'v2-catalog-billboard'
    and ((storage.foldername(name))[1] = wholesale_v2.v2_my_wid() or wholesale_v2.v2_is_owner())
  );

-- v2_catalog_by_token gains the whole billboard, media type included. Defined
-- once here rather than twice across 057 and 058.
--
-- Note what the login_required branch returns: NOTHING about the billboard. A
-- poster is advertising, and advertising handed to someone who has not logged
-- in is exactly the leak that withholding the catalog's name exists to prevent.
drop function if exists wholesale_v2.v2_catalog_by_token(text, uuid);

create function wholesale_v2.v2_catalog_by_token(
  p_token text,
  p_account_id uuid default null
)
returns table (
  status text, id uuid, name text, description text, wid text,
  is_public boolean, access_tier smallint, wholesaler_name text,
  billboard_enabled boolean, billboard_image_url text, billboard_media_type text,
  billboard_product_id uuid, billboard_cta text, highlight_label text
)
language plpgsql
stable
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_cat  wholesale_v2.v2_catalogs%rowtype;
  v_acct wholesale_v2.v2_portal_accounts%rowtype;
  v_tier smallint;
  v_wname text;
begin
  select * into v_cat from wholesale_v2.v2_catalogs c
   where c.share_token = p_token and c.active;

  if v_cat.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, null::text,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  select w.name into v_wname from wholesale_v2.v2_wholesalers w where w.wid = v_cat.wid;

  if v_cat.is_public then
    return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                        v_cat.is_public, v_cat.access_tier, v_wname,
                        v_cat.billboard_enabled, v_cat.billboard_image_url, v_cat.billboard_media_type,
                        v_cat.billboard_product_id, v_cat.billboard_cta, v_cat.highlight_label;
    return;
  end if;

  if p_account_id is null then
    return query select 'login_required'::text, null::uuid, null::text, null::text, v_cat.wid,
                        false, v_cat.access_tier, v_wname,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  select * into v_acct from wholesale_v2.v2_portal_accounts a
   where a.id = p_account_id and a.role in ('buyer','sales') and a.active;

  -- Wrong wholesaler and wrong tier give the SAME answer. Telling someone
  -- which of the two it was would let them map out whose catalog this is.
  if v_acct.id is null or v_acct.wid is distinct from v_cat.wid then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, v_wname,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  select c.access_tier into v_tier from wholesale_v2.v2_clients c where c.id = v_acct.client_id;
  v_tier := coalesce(v_tier, 1);

  if v_tier < v_cat.access_tier then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::text,
                        null::boolean, null::smallint, v_wname,
                        false, null::text, null::text, null::uuid, null::text, null::text;
    return;
  end if;

  return query select 'ok'::text, v_cat.id, v_cat.name, v_cat.description, v_cat.wid,
                      v_cat.is_public, v_cat.access_tier, v_wname,
                      v_cat.billboard_enabled, v_cat.billboard_image_url, v_cat.billboard_media_type,
                      v_cat.billboard_product_id, v_cat.billboard_cta, v_cat.highlight_label;
end;
$fn$;

revoke all on function wholesale_v2.v2_catalog_by_token(text, uuid) from public;
grant execute on function wholesale_v2.v2_catalog_by_token(text, uuid) to anon, authenticated;
