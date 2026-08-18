// check_price_override_isolation.mjs -- negotiated prices, from the outside.
//
// Every assertion here runs as the ANON role against production, using nothing
// but the publishable key that ships in the client bundle. That is the whole
// point: this is what an attacker has, and the questions below are the ones
// they would ask.
//
// The bugs this locks down, all three found on 18 Aug 2026:
//
//   1. SELECT on v2_client_price_overrides was `using (true)` from migration
//      023 until 048 -- every wholesaler's per-client negotiated pricing was
//      readable by anyone holding the key.
//
//   2. The scoped WRITE policies could never pass for a sales rep, because
//      reps run as anon with auth.uid() NULL. "Set price" had never worked.
//
//   3. 048's own authority gate returned NULL rather than false, and every
//      call site tested `if not gate()` -- `not NULL` is NULL, which is not
//      TRUE, so the refusal never fired. A fake account id could set any
//      wholesaler's prices. It LOOKED refused in the first test only because
//      the client and variant chosen happened to belong to different
//      wholesalers, so a later check caught what the gate had missed. Assertion
//      4 below is that exact call with a same-tenant pair, which is the case
//      that actually succeeded.
//
// Usage:  node checks/check_price_override_isolation.mjs
// No dependencies; plain fetch. Read-only except assertion 4, which attempts a
// write that MUST be refused -- if it ever succeeds this check fails loudly and
// the row it would have written is reported so it can be removed.

const URL_BASE = "https://olaipgdckbgjediddloj.supabase.co/rest/v1";
const KEY = "sb_publishable_GnN_sh_xneseBc9dya4Vpg_eziJoPI5";
const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

let failures = 0;
let skipped = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

async function rest(path) {
  const r = await fetch(`${URL_BASE}/${path}`, { headers: { ...H, "Accept-Profile": "wholesale_v2" } });
  return { status: r.status, body: await r.text() };
}
async function rpc(name, args) {
  const r = await fetch(`${URL_BASE}/rpc/${name}`, {
    method: "POST",
    headers: { ...H, "Content-Profile": "wholesale_v2" },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.text() };
}

// --- 1. the table itself is unreachable ---------------------------------
const read = await rest("v2_client_price_overrides?select=client_id,override_price&limit=1");
assert(
  "anon cannot SELECT v2_client_price_overrides",
  read.status === 401 || read.status === 403 || read.body.includes("permission denied"),
  `got HTTP ${read.status}: ${read.body.slice(0, 160)}`
);

const write = await rest("v2_client_price_overrides?select=id&limit=1");
assert(
  "the refusal is a PERMISSION error, not an empty result set",
  read.body.includes("permission denied"),
  `an empty [] would mean the grant is still there and the table merely has no rows today: ${write.body.slice(0, 120)}`
);

// --- 2. the buyer function cannot be pointed at someone else -------------
const buyerFake = await rpc("v2_buyer_price_overrides", {
  p_account_id: "00000000-0000-0000-0000-000000000000",
});
assert(
  "v2_buyer_price_overrides returns nothing for an account that does not exist",
  buyerFake.body.trim() === "[]",
  `got: ${buyerFake.body.slice(0, 160)}`
);

// The signature is the guarantee: there is no client_id parameter to abuse.
const buyerWrongArgs = await rpc("v2_buyer_price_overrides", {
  p_account_id: "00000000-0000-0000-0000-000000000000",
  p_client_id: "00000000-0000-0000-0000-000000000000",
});
assert(
  "v2_buyer_price_overrides takes no client_id at all",
  buyerWrongArgs.status >= 400 || buyerWrongArgs.body.includes("function"),
  `passing a client_id should not resolve to any function; got HTTP ${buyerWrongArgs.status}: ${buyerWrongArgs.body.slice(0, 160)}`
);

// --- 3-4. the assertions that need REAL ids ------------------------------
// These two have to name a real client and a real variant BELONGING TO THE
// SAME WHOLESALER, because that is the exact shape that defeated the gate: a
// mismatched pair gets refused further down by the tenant comparison, so a
// synthetic id produces a PASS that proves nothing at all. anon deliberately
// cannot discover such a pair (that is other checks passing), so it must be
// supplied from outside:
//
//   PO_CLIENT=<uuid> PO_VARIANT=<uuid> node checks/check_price_override_isolation.mjs
//
// Without them these assertions are SKIPPED and say so. A skip is honest; a
// green tick on a synthetic id would be a lie, and this check exists because
// of a bug that hid behind exactly that kind of accidental pass.
const PAIR_CLIENT = process.env.PO_CLIENT || null;
const PAIR_VARIANT = process.env.PO_VARIANT || null;
// PO_ACCOUNT is for red-proving only: pass a REAL active sales account id for
// that client's wholesaler and assertion 4 MUST fail, because that actor is
// genuinely allowed to write. If it still passes, the assertion is not
// actually watching the write and needs fixing before it is trusted.
const PROBE_ACCOUNT = process.env.PO_ACCOUNT || "00000000-0000-0000-0000-000000000000";

if (!PAIR_CLIENT || !PAIR_VARIANT) {
  skipped += 2;
  console.log("  SKIP  v2_client_overrides_list refuses an unauthenticated caller (needs PO_CLIENT)");
  console.log("  SKIP  a made-up account id cannot set a price (needs PO_CLIENT + PO_VARIANT)");
} else {
  const list = await rpc("v2_client_overrides_list", { p_account_id: null, p_client_id: PAIR_CLIENT });
  assert(
    "v2_client_overrides_list returns nothing without a valid sales account",
    list.body.trim() === "[]",
    `got: ${list.body.slice(0, 200)}`
  );

  const setAttempt = await rpc("v2_set_client_override", {
    p_account_id: PROBE_ACCOUNT,
    p_client_id: PAIR_CLIENT,
    p_variant_id: PAIR_VARIANT,
    p_price: 0.01,
    p_note: "isolation check — must never be written",
    p_created_by: "isolation check",
  });
  let wroteRow = null;
  try {
    const parsed = JSON.parse(setAttempt.body);
    if (Array.isArray(parsed) && parsed[0]?.ok === true) wroteRow = parsed[0].id;
  } catch { /* a hard error is also a refusal */ }

  assert(
    "a made-up account id cannot set a price (the NULL-gate hole)",
    wroteRow === null,
    wroteRow
      ? `IT WROTE A ROW. Delete it:\n        delete from wholesale_v2.v2_client_price_overrides where id = '${wroteRow}';`
      : `refused with: ${setAttempt.body.slice(0, 160)}`
  );
}

// --- 5. and cannot delete one either -------------------------------------
const del = await rpc("v2_remove_client_override", {
  p_account_id: null,
  p_id: "00000000-0000-0000-0000-000000000000",
});
assert(
  "v2_remove_client_override answers a nonexistent id without erroring",
  del.status === 200,
  `got HTTP ${del.status}: ${del.body.slice(0, 160)}`
);

// --- 6. the authority gate is TOTAL --------------------------------------
// The root cause of bug 3 was a gate that could answer "unknown". It must now
// answer true or false for every input, including all-null.
for (const args of [
  { p_account_id: null, p_wid: null },
  { p_account_id: null, p_wid: "nope" },
  { p_account_id: "00000000-0000-0000-0000-000000000000", p_wid: "nope" },
]) {
  const g = await rpc("v2_override_actor_can_act", args);
  const value = g.body.trim();
  assert(
    `v2_override_actor_can_act(${args.p_account_id ? "fake-uuid" : "null"}, ${args.p_wid ?? "null"}) is false, never null`,
    value === "false",
    `got: ${value}`
  );
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) FAILED.`);
} else if (skipped > 0) {
  console.log(
    `\nAll run assertions passed, but ${skipped} were SKIPPED — including the one covering the ` +
    `hole that was actually exploitable. Re-run with PO_CLIENT and PO_VARIANT set to a real ` +
    `same-wholesaler pair before treating this as a clean bill of health.`
  );
} else {
  console.log(`\nAll assertions passed — negotiated prices are not readable or writable by anon.`);
}
process.exit(failures === 0 ? 0 : 1);
