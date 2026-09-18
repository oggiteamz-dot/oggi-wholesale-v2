// =============================================================================
// OGGI Wholesale v2 — CHUNKED `in.(...)` QUERIES            18 Sep 2026
// =============================================================================
//
// THE BUG THIS EXISTS TO KILL
// ---------------------------
// PostgREST expresses `where x in (…)` as a QUERY STRING: `?x=in.(a,b,c,…)`.
// A UUID plus its comma is 37 characters, so a list of ids goes into the URL at
// 37 bytes each. Meridian Denim Co. has 875 variants. That is a 32,000-character
// URL, and the gateway answers 400 Bad Request with no explanation in the body.
//
// Measured on 18 Sep 2026, signed in as a real wholesaler: ELEVEN screens were
// blank or half-blank because of this one shape —
//   /wholesaler/inventory, /inventory/products, /inventory/pricing,
//   /movements, /locations, /products, /import, /integrations, /settings,
//   /links, and the dashboard.
// The whole inventory module, in other words.
//
// ⚠️ THE PART THAT MATTERS MOST: IT SCALES THE WRONG WAY.
// The app was built and tested against the `test` tenant, which has 119
// variants — about 4,400 characters, under the limit, fine. Every gate passed.
// The failure begins somewhere around 150 products and gets worse with every
// product a wholesaler adds, so the customers who hit it first are the biggest
// ones, and the symptom they see is "the inventory screen is empty" rather than
// anything that looks like an error.
//
// HOW IT IS FIXED
// ---------------
// Split the id list into batches, run the batches, concatenate the rows. The
// batch size is deliberately conservative: 80 UUIDs is ~2,960 characters of
// filter, which leaves room for the select list, embedded resources and any
// other filters on the same request.
//
// Callers get back the same `{ data, error }` shape as sbCall, so a call site
// changes from
//     sbCall(supabase.from(T).select(S).in("variant_id", ids))
// to
//     selectIn(T, S, "variant_id", ids)
// and nothing else about it moves.
//
// GUARDED BY checks/check_no_unbounded_in.mjs, which fails the build on any new
// `.in(` carrying a list that is not provably short. A comment cannot stop this
// coming back; a gate can.
// =============================================================================

import { supabase, sbCall } from "./supabase-client.js";

/** 80 UUIDs ≈ 2,960 characters of `in.(…)`. Chosen with headroom rather than
 *  at the edge of the limit: the limit belongs to a gateway we do not control
 *  and have no way to detect from here. */
export const IN_CHUNK = 80;

export function chunk(list, size = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * `select ... where <column> in (<ids>)`, in batches, merged.
 *
 * @param {string} table
 * @param {string} select       PostgREST select string, embeds included
 * @param {string} column
 * @param {Array<string|number>} ids
 * @param {(q:any)=>any} [refine]  extra filters applied to EVERY batch
 * @returns {Promise<{data: Array, error: any}>}
 */
export async function selectIn(table, select, column, ids, refine) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  // An empty `in.()` is a syntax error at the gateway, and semantically the
  // answer is "no rows" — so answer it here rather than making a round trip
  // that 400s. Several call sites used to guard this by hand; now none need to.
  if (clean.length === 0) return { data: [], error: null };

  // IN PARALLEL, not in sequence. 875 variants is eleven batches; run one after
  // another at ~200ms each and the inventory screen takes well over two seconds
  // to draw its first row. The first version of this helper did exactly that,
  // and the screens it was written to FIX still measured as blank -- the data
  // was on its way and nobody was going to wait for it. Eleven concurrent reads
  // of the same table is nothing to Postgres; eleven serial round trips to
  // Frankfurt is the entire budget for the screen.
  const results = await Promise.all(
    chunk(clean).map((batch) => {
      let q = supabase.from(table).select(select).in(column, batch);
      if (refine) q = refine(q);
      return sbCall(q);
    })
  );
  // Fail loudly on the first bad batch rather than returning a partial set that
  // looks like real data. A short inventory list is worse than an error: it
  // gets acted on.
  const failed = results.find((r) => r.error);
  if (failed) return { data: null, error: failed.error };
  return { data: results.flatMap((r) => r.data || []), error: null };
}
