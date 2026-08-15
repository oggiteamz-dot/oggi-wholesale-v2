# checks/ — behaviour gates for OGGI Wholesale v2

These are not unit tests of function names. They submit real orders to a real
Postgres and assert **what the server does**. A future rewrite that renames
everything but keeps the behaviour passes. A rewrite that keeps every name but
drops a rule fails.

That distinction is the whole point. Both feature losses in this project's
history were invisible to name-matching: the 2.0 rewrite dropped the size axis,
and the July sweep missed it because it grepped function names while the loss
lived in the **record shape**.

## The rule every check here must obey

**A check is not finished until it has been proven to go red.**

Write it, watch it pass, then deliberately break the thing it guards and watch
it fail, then restore and watch it pass again. A check that has only ever been
green is not evidence — it may be passing for a reason you did not intend.

That is not theoretical. While building `check_pack_moq.sh`, the suite reported
**7 green while the database function was crashing on every single call** with
`function min(uuid) does not exist`. Every "rejection" it counted was a crash,
not a rule being enforced. The fix was to assert the *reason* for each
rejection, not merely that an error occurred. Any check that only asserts
"something failed" can and eventually will lie to you.

## Running the checks

Requires a local Postgres. Nothing here touches the live database.

```bash
# 1. start a scratch Postgres (any local instance works)
initdb -D /tmp/pgdata -U postgres --auth=trust
pg_ctl -D /tmp/pgdata -o "-k /tmp/pgrun -p 5433" start

# 2. build the scratch database
createdb -h /tmp/pgrun -p 5433 -U postgres wtest
psql -h /tmp/pgrun -p 5433 -U postgres -d wtest -f checks/fixture.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d wtest -f checks/seed.sql

# 3. load the function under test
psql -h /tmp/pgrun -p 5433 -U postgres -d wtest \
     -f supabase/migrations/028_v2_pack_line_validation.sql

# 4. run
./checks/check_pack_moq.sh -h /tmp/pgrun -p 5433 -U postgres
```

Exit code 0 means every assertion held. Non-zero means something regressed.

## What `check_pack_moq.sh` guards

Minimum order quantity — the rule that makes this a wholesale system rather
than a shop. It asserts that a client cannot switch it off.

**The defect it was written for:** migration 012 skips the per-SKU minimum for
any order line carrying a `pack_line_id`, and never checks that the pack is
real. A modified browser could attach an invented UUID and buy 1 unit of a SKU
with a 12-unit minimum. Demonstrated, not theorised — an order for 1 unit
landed in the database against a 12-unit minimum.

Eight rejection cases and three acceptance cases. The acceptance cases matter
as much: the legitimate rule — a genuine pack **may** contain fewer units of one
size than that SKU's own minimum, because the pack is the sellable unit — must
keep working. A check that only ever says no would "pass" by breaking the
feature.

## `fixture.sql` and `seed.sql`

`fixture.sql` is a minimal reproduction of only the tables `v2_submit_order`
touches, with column definitions copied from migrations 001, 004, 009 and 011.
Reservation and pricing helpers are stubbed — they are not under test, and
pulling in the full inventory ledger would add noise without adding coverage.

`seed.sql` creates one wholesaler with a 12-unit per-SKU minimum and one real
pack (1×S, 2×M, 2×L), plus a second wholesaler with its own pack so the
cross-tenant case is genuine rather than simulated.

**Honest limitation:** this is a faithful reproduction, not the production
schema. It proves the logic of the fix. It does not prove the fix behaves
identically against the live database with RLS, real reservations and real
pricing in play. Run the same cases once against a Supabase branch before
calling this closed.

## Checks still to build

From the Aug 15 modularity assessment, in priority order:

1. **Order-line shape** — assert `v2_order_items` still carries `pack_id`,
   `pack_line_id`, `pack_qty` and a variant key. This is the check that would
   have caught both historical losses.
2. **Selling models** — one per model; assert the enforcing column exists *and*
   an order using it round-trips. Two of four models do not exist yet, so two
   of these start red and stay red until built. That is correct: a red check
   for a missing feature is a to-do list that cannot be forgotten.
3. **Stock invariant** — `p.stock[i] === Σ p.loc[loc][i]`.
4. **No bare interpolation into `innerHTML`** — currently failing at three
   `pageHeader` call sites.
