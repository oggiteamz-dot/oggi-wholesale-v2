// =============================================================================
// OGGI Wholesale v2 — IMAGE UPLOAD
// =============================================================================
//
// WHAT THIS CLOSES
// ----------------
// Regression #10: v2 had NO image upload path at all. `grep` for
// `storage.from(` / `.upload(` across js/ returned zero matches -- v2 accepted
// pasted image URLs only, by its own admission (wholesaler.js:388-396), while
// v1 uploaded up to 50 photos per product to a bucket. A product editor with
// no way to add a photo is not worth shipping, so this comes first.
//
// WHERE THINGS GO
//     bucket: v2-product-img          (migration 040)
//     path:   <wid>/<productId>/<uuid>.<ext>
//
// The wid is the FIRST path segment because the storage policy is literally
// "the first folder must be your own wid". A wholesaler physically cannot
// write outside their own folder -- proven against the live database before
// this file was written: as SQUARE, writing `sq/…` evaluates true and writing
// `mg/…` evaluates false.
//
// Note there is no wid PARAMETER in the write path below. The database derives
// it from auth.uid() via v2_my_wid(). If it were passed in, a tampered client
// could aim at another tenant's folder; the policy would still refuse, but the
// app would be asking a question it has no business asking.
//
// WHY THE DOWNSCALE IS NOT OPTIONAL
// ---------------------------------
// A photo straight off a phone is 3-12 MB and 4000px wide. It gets rendered in
// a 240px card. Uploading it whole costs the wholesaler minutes on a 43.9 Mbps
// median Lebanese mobile connection, and costs every buyer who later loads the
// catalogue the same on the way down.
//
// The OGGI logo made the same point at a smaller scale earlier today: 2000x2000
// and 68KB, rendered at 58x30. Trimmed and resized it became 12KB -- an 83%
// saving on one image nobody had thought about.
//
// So: downscale in the browser BEFORE upload, and encode to WebP where the
// browser supports it. Typical result is 3-8 MB becoming 60-150 KB.
//
// The 5 MB cap and the MIME allow-list are ALSO enforced server-side on the
// bucket. Client-side limits are a courtesy, not a control -- the publishable
// key is in the bundle by design, so anyone can call the storage API directly.
// =============================================================================

import { supabase, sbCall } from "../lib/supabase-client.js";

const BUCKET = "v2-product-img";

/** Longest edge, in pixels, after downscale. 1600 stays sharp on a retina
 *  product page and on a zoomed detail view, without carrying a 4000px
 *  original nobody will ever see at full size. */
const MAX_EDGE = 1600;
const QUALITY = 0.82;          // visually lossless for product photography
const HARD_MAX_BYTES = 5 * 1024 * 1024;   // mirrors the bucket's server-side cap

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];

/** WebP is ~30% smaller than JPEG at the same quality and is supported
 *  everywhere that matters now, but the check is done rather than assumed --
 *  an older Android WebView will quietly hand back a PNG otherwise. */
function bestOutputType() {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    if (c.toDataURL("image/webp").startsWith("data:image/webp")) return "image/webp";
  } catch { /* fall through */ }
  return "image/jpeg";
}

/**
 * Downscales and re-encodes an image file in the browser.
 *
 * Uses createImageBitmap with imageOrientation:"from-image" so EXIF rotation is
 * honoured. Without it, photos taken in portrait on a phone upload sideways --
 * one of those bugs that looks like the app is broken and is really a metadata
 * flag nobody read.
 *
 * @param {File} file
 * @returns {Promise<{blob:Blob, type:string, width:number, height:number}>}
 */
export async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width: w0, height: h0 } = bitmap;

  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // Better resampling on the large reductions this does most of the time.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const type = bestOutputType();
  const blob = await new Promise((res) => canvas.toBlob(res, type, QUALITY));
  if (!blob) throw new Error("The browser could not process this image.");
  return { blob, type, width: w, height: h };
}

/**
 * Uploads one product image.
 *
 * @param {object} o
 * @param {File}   o.file
 * @param {string} o.wid        the wholesaler's own wid (path only -- the
 *                              database still checks it against auth.uid())
 * @param {string} o.productId
 * @param {function} [o.onProgress] called with a short human status string
 * @returns {Promise<{ok:boolean, url?:string, path?:string, bytes?:number,
 *                    savedPct?:number, error?:string}>}
 */
export async function uploadProductImage({ file, wid, productId, onProgress = () => {} }) {
  if (!file) return { ok: false, error: "No file was chosen." };
  if (!wid) return { ok: false, error: "No wholesaler — sign out and back in." };
  if (!productId) return { ok: false, error: "Save the product before adding photos." };

  // Checked before any work: a clear refusal beats a failed upload two minutes
  // in on a slow connection.
  if (!ACCEPTED.includes(file.type)) {
    return { ok: false, error: `That is a ${file.type || "unknown"} file. Use a JPEG, PNG, WebP or AVIF image.` };
  }

  let out;
  try {
    onProgress("Preparing the image…");
    out = await downscaleImage(file);
  } catch (e) {
    // A corrupt or unsupported image should say so, not fail as a network error.
    return { ok: false, error: `That image could not be read (${e.message || "unknown reason"}).` };
  }

  if (out.blob.size > HARD_MAX_BYTES) {
    return { ok: false, error: "Even after resizing, that image is over 5 MB. Try a smaller one." };
  }

  const ext = out.type === "image/webp" ? "webp" : "jpg";
  // crypto.randomUUID avoids two wholesalers uploading "IMG_1234.jpg" and one
  // silently replacing the other. A timestamp is not enough: two uploads in the
  // same millisecond are perfectly possible from a multi-select.
  const path = `${wid}/${productId}/${crypto.randomUUID()}.${ext}`;

  onProgress("Uploading…");
  const { error } = await sbCall(
    supabase.storage.from(BUCKET).upload(path, out.blob, {
      contentType: out.type,
      // Never overwrite: every upload is a new object. Overwriting by path is
      // how one product's photo ends up on another.
      upsert: false,
      cacheControl: "31536000",  // immutable — the filename is a fresh uuid
    })
  );

  if (error) {
    const msg = String(error.message || "");
    // The most likely real failure is the tenant policy refusing the folder.
    // Say what that means instead of surfacing "new row violates row-level
    // security policy", which tells a wholesaler nothing.
    if (/row-level security|violates|not authorized|Unauthorized/i.test(msg)) {
      return { ok: false, error: "You do not have permission to upload for this wholesaler." };
    }
    if (/exceeded the maximum|too large|Payload/i.test(msg)) {
      return { ok: false, error: "That image is too large for the server (5 MB limit)." };
    }
    return { ok: false, error: msg || "The upload failed. Check your connection and try again." };
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const savedPct = file.size > 0
    ? Math.max(0, Math.round((1 - out.blob.size / file.size) * 100))
    : 0;

  return {
    ok: true,
    url: data?.publicUrl || "",
    path,
    bytes: out.blob.size,
    width: out.width,
    height: out.height,
    savedPct,
  };
}

/**
 * Removes an uploaded image.
 *
 * Takes the storage PATH, not the public URL. A URL can be rewritten by a CDN
 * or carry a query string, and deriving a path from one is guesswork; the path
 * is what the database policy is written against.
 */
export async function deleteProductImage(path) {
  if (!path) return { ok: false, error: "No image path was given." };
  const { error } = await sbCall(supabase.storage.from(BUCKET).remove([path]));
  if (error) {
    return { ok: false, error: /row-level security|not authorized/i.test(String(error.message))
      ? "You can only delete your own images."
      : (error.message || "Could not delete that image.") };
  }
  return { ok: true };
}

/** Turns a public URL back into a storage path, for images stored before the
 *  path was recorded alongside the URL. Best-effort and clearly labelled as
 *  such -- new code should keep the path. */
export function pathFromPublicUrl(url) {
  const m = String(url || "").match(new RegExp(`/${BUCKET}/(.+)$`));
  return m ? decodeURIComponent(m[1].split("?")[0]) : null;
}

// ---------------------------------------------------------------------
// The catalog billboard (Batch 22)
// ---------------------------------------------------------------------
// Hadi: "they might choose to put in a video or a GIF for the billboard."
//
// Which is why this is NOT uploadProductImage with a different folder. That
// function runs every file through downscaleImage(), which draws it onto a
// canvas -- and a canvas has exactly one frame. An animated GIF would arrive
// as a still of its first frame, silently, with the upload reporting success.
// A video would not survive at all.
//
// So: photographs are downscaled as before, because a 12 MP phone photo has no
// business being a billboard at full size. GIFs and videos are uploaded
// UNTOUCHED, because the whole point of them is the part a canvas throws away.
// The trade is stated rather than hidden -- an untouched 20 MB clip is 20 MB
// on someone's phone data, and the size limit below is what keeps that honest.

const BILLBOARD_BUCKET = "v2-catalog-billboard";
const BILLBOARD_MAX_BYTES = 25 * 1024 * 1024;   // mirrors the bucket's server-side cap
const BILLBOARD_STILL = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const BILLBOARD_ASIS  = ["image/gif", "video/mp4", "video/webm"];

/**
 * Uploads a billboard poster, animation or clip.
 *
 * @returns {{ok:true, url:string, path:string, mediaType:"image"|"video", bytes:number}}
 *        | {ok:false, error:string}
 */
export async function uploadCatalogBillboard({ file, wid, catalogId, onProgress = () => {} }) {
  if (!file) return { ok: false, error: "No file was chosen." };
  if (!wid) return { ok: false, error: "No wholesaler — sign out and back in." };
  if (!catalogId) return { ok: false, error: "Save the catalog before adding a billboard." };

  const type = file.type || "";
  const isStill = BILLBOARD_STILL.includes(type);
  const isAsIs = BILLBOARD_ASIS.includes(type);

  if (!isStill && !isAsIs) {
    return {
      ok: false,
      error: `That is a ${type || "unknown"} file. Use a JPEG, PNG, WebP, GIF, MP4 or WebM.`,
    };
  }

  let blob = file;
  let contentType = type;

  if (isStill) {
    try {
      onProgress("Preparing the image…");
      const out = await downscaleImage(file);
      blob = out.blob;
      contentType = out.type;
    } catch (e) {
      return { ok: false, error: `That image could not be read (${e.message || "unknown reason"}).` };
    }
  } else {
    onProgress(type.startsWith("video/") ? "Uploading the video…" : "Uploading…");
  }

  if (blob.size > BILLBOARD_MAX_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `That file is ${mb} MB and the limit is 25 MB. A shorter clip, or a smaller export, will work.`,
    };
  }

  const ext = contentType.split("/")[1]?.replace("quicktime", "mp4") || "bin";
  const path = `${wid}/billboard-${catalogId}/${crypto.randomUUID()}.${ext}`;

  onProgress("Uploading…");
  const { error } = await sbCall(
    supabase.storage.from(BILLBOARD_BUCKET).upload(path, blob, {
      contentType,
      upsert: false,
      cacheControl: "31536000",
    })
  );

  if (error) {
    const msg = String(error.message || "");
    if (/row-level security|violates|not authorized|Unauthorized/i.test(msg)) {
      return { ok: false, error: "You do not have permission to upload for this wholesaler." };
    }
    if (/mime|not supported|invalid_mime/i.test(msg)) {
      return { ok: false, error: `The server refused a ${contentType} file. Use a JPEG, PNG, WebP, GIF, MP4 or WebM.` };
    }
    if (/exceeded the maximum|too large|Payload/i.test(msg)) {
      return { ok: false, error: "That file is too large for the server (25 MB limit)." };
    }
    return { ok: false, error: msg || "The upload failed. Check your connection and try again." };
  }

  const { data } = supabase.storage.from(BILLBOARD_BUCKET).getPublicUrl(path);
  return {
    ok: true,
    url: data?.publicUrl || "",
    path,
    mediaType: contentType.startsWith("video/") ? "video" : "image",
    bytes: blob.size,
  };
}
