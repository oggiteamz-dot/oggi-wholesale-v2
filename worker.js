// OGGI Wholesale v2 — Cloudflare Worker (static assets + security headers)
//
// REBUILT per Hadi's explicit instruction: "Don't do pages. Do workers.
// Pages don't work." This replaces the earlier Batch 14 design, which
// was a reverse-proxy Worker sitting in front of an undetermined
// external static host (ORIGIN was a placeholder, never a real host).
// v2 was never actually deployed anywhere yet, so there is no
// migration risk here -- this is the first real hosting mechanism v2
// gets, and it serves the static app directly via Cloudflare's
// "Workers with static assets" feature (the `[assets]` binding in
// wrangler.toml, ASSETS below), not a proxy to somewhere else.
//
// wrangler.toml sets `run_worker_first = true`, which guarantees this
// fetch handler runs on every request -- including ones that match a
// static file -- so the security headers below are always applied, not
// only on cache-miss/dynamic requests.
//
// Cloudflare's asset server also natively honors a `_headers` file
// placed in the assets directory (same format Pages used), and one is
// still shipped alongside index.html for that reason. This Worker's
// explicit `.set(...)` calls below are the authoritative source (using
// `.set` rather than `.append` means there is no header-duplication
// risk even though both mechanisms carry the same policy) -- the
// `_headers` file is kept as a second, native layer of defense in case
// a future change ever bypasses this fetch handler (e.g. `run_worker_first`
// being flipped back to false). Keep both files in sync if the policy
// changes -- see docs/BATCH-14-SCHEMA-MIGRATION-RECORD.md.

// THREE files carry this policy and all three must agree: this constant,
// ../_headers, and the <meta http-equiv> tag in ../index.html. This one
// is the only one that actually reaches the browser on a normal request
// -- `run_worker_first = true` means the fetch handler below runs on
// every request and `.set()`s this value over whatever `_headers`
// produced. That asymmetry has already cost a day: blob: was added to
// index.html and _headers on 18 Aug and NOT here, so the meta tag
// allowed blob: while the response header still forbade it. A page under
// two policies gets the INTERSECTION of them, so the stricter one --
// this one -- silently won and every photo preview stayed blocked while
// the file that was edited looked correct. checks/check_shipped_csp.mjs
// now asserts against the deployed response, not against these files.
const CSP = [
  "default-src 'self'",
  // No inline <script> tags anywhere in this build (both scripts in
  // index.html are external src= files) and no CDN scripts, so a
  // strict self-only script-src is achievable with zero rewrites.
  "script-src 'self'",
  // This codebase uses inline style="..." attributes extensively across
  // every dynamically-rendered view (hundreds of call sites) -- rewriting
  // all of that to CSS classes to drop 'unsafe-inline' here is a real,
  // large refactor that is out of scope. Documented trade-off, not an
  // oversight: style-src cannot leak data or execute arbitrary JS the
  // way script-src can, so this is a much smaller concession than an
  // 'unsafe-inline' script-src would be.
  "style-src 'self' 'unsafe-inline'",
  // Wholesalers can set arbitrary product photo URLs (Batch 13's
  // image_url/images columns) -- these can point at any host they use
  // for image hosting, so img-src must allow any https host rather than
  // an allowlist of one CDN. data: covers any inline data-URI images.
  // blob: is required by the product builder, which previews a photo
  // before it is uploaded via URL.createObjectURL(file) and then samples
  // that <img> on a canvas for the eyedropper. Without it the preview
  // never loads, naturalWidth reports 0, and the eyedropper returns
  // black. It is a narrow addition: blob: URLs are minted by this page,
  // are same-origin by construction, cannot be forged by a third party,
  // and are revoked when the form resets -- it widens nothing that can
  // be fetched from the network.
  "img-src 'self' https: data: blob:",
  "font-src 'self'",
  // The only network calls this app's frontend makes are to its own
  // Supabase project (REST/RPC/Auth/Storage/Edge Functions all share one
  // host) -- wss:// is included defensively for Supabase's realtime
  // client, which the vendored SDK includes even though no view in this
  // build currently opens a realtime channel.
  "connect-src 'self' https://olaipgdckbgjediddloj.supabase.co wss://olaipgdckbgjediddloj.supabase.co",
  // Never allow this app to be framed by another site (clickjacking).
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export default {
  async fetch(request, env) {
    // Serve the actual static file (index.html, /css/*, /js/*, etc.)
    // straight from this Worker's bound assets -- no external origin,
    // no proxy hop. env.ASSETS is the binding configured in
    // wrangler.toml's [assets] block.
    const response = await env.ASSETS.fetch(request);

    // Response objects returned by ASSETS.fetch() have immutable
    // headers -- clone into a new Response to modify them.
    const withHeaders = new Response(response.body, response);
    withHeaders.headers.set("Content-Security-Policy", CSP);
    withHeaders.headers.set("X-Content-Type-Options", "nosniff");
    withHeaders.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    withHeaders.headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    return withHeaders;
  },
};
