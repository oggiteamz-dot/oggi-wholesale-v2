// OGGI Wholesale v2 — Supabase client (singleton)
//
// Project: oggi-wholesale (olaipgdckbgjediddloj), eu-central-1.
// This is the SAME project as v1, but v2 now lives in its own dedicated
// Postgres schema (`wholesale_v2`) rather than sharing `public` with v1's
// tables — real structural isolation, not just the `v2_` naming
// convention (which is still kept on every object name for defense in
// depth / clarity, on top of the schema boundary). v2 code must NEVER
// read or write any v1 table, and now cannot even reach one by accident
// through an unqualified `public.` PostgREST call, since this client is
// pinned to `wholesale_v2` only.
//
// IMPORTANT — MANUAL DASHBOARD STEP REQUIRED (not SQL-settable): Supabase
// only serves schemas that are explicitly added to the project's
// "Exposed schemas" list (Project Settings -> API -> Data API). Until
// `wholesale_v2` is added there, every call through this client will fail
// with a schema-not-exposed error from PostgREST. See
// docs/BATCH-14-SCHEMA-MIGRATION-RECORD.md for the exact steps.
//
// Uses the new Supabase publishable key (not the legacy anon JWT) — safe to
// ship in client code, same trust level as the old anon key.
//
// VENDORED, NOT CDN-IMPORTED: the Supabase JS client is loaded from
// js/lib/vendor/supabase-js.umd.js (a plain <script> in index.html, before
// this module) rather than a runtime `import ... from "https://esm.sh/..."`.
// Found during Batch 2 testing: this sandbox's browser could not reach
// esm.sh at all (curl could, the browser couldn't — a real network-policy
// gap between tool surfaces, not a fluke), which meant the ENTIRE app
// failed to boot silently, including screens that don't even touch
// Supabase (like the login screen), because one failed top-level import
// anywhere in the module graph aborts the whole graph. A CDN being
// unreachable is also a real, if rare, production risk, not just a test
// artifact. Vendoring removes the external dependency entirely -- the app
// now has zero runtime network dependency on a third-party CDN to boot.
const createClient = window.supabase.createClient;

const SUPABASE_URL = "https://olaipgdckbgjediddloj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GnN_sh_xneseBc9dya4Vpg_eziJoPI5";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  db: {
    schema: "wholesale_v2", // v2's dedicated schema — see header comment above
  },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "oggi-v2-auth", // distinct key from any v1 storage, no collision
  },
});

/** Small helper: wraps a Supabase call, normalizes errors, never throws —
 * callers get { data, error } consistently, matching the pattern the rest
 * of the v2 data layer will use. */
export async function sbCall(promise) {
  try {
    const { data, error } = await promise;
    if (error) {
      console.error("[supabase]", error);
      return { data: null, error };
    }
    return { data, error: null };
  } catch (err) {
    console.error("[supabase] unexpected", err);
    return { data: null, error: err };
  }
}
